// The daemon launcher of `vt run`: spawns one role daemon per device (or one process per --colocate
// group), with the profile's env (FORCE_COLOR=0, DEBUG_COLORS=0, DEBUG_HIDE_DATE=0, no NODE_OPTIONS,
// DEBUG only from --debug), waits for every label's ctl.port, registers each ctl token as a run secret,
// routes daemon output into the profile's file layout (authority stderr -> ev/debug.log, everything else
// -> ev/<label>.log; never the orchestrator's stdout), logs every call to ev/commands.log without its
// args, and stops everything in a bounded way (stop verb, SIGTERM, SIGKILL). It never deletes a peer dir.

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { callCtl } from '../ctl/ctl-client.js'
import { readCtlPort } from '../ctl/ctl-files.js'
import { CTL_PORT_FILE, CTL_TOKEN_FILE, VERB_NAME_RE, type Role } from '../ctl/protocol.js'
import type { StepWindow } from './results.js'
import type { SecretRegistry } from './secret-scan.js'

/** The built vt bin, from dist/run/ (and src/run/, where it names the not-yet-built file). */
export const VT_BIN = fileURLToPath(new URL('../bin/vt.js', import.meta.url))

/** The opt-in instruments preload, resolved next to this module from src/run/ and dist/run/ alike. */
export const INSTRUMENTS_PRELOAD = fileURLToPath(new URL('./instruments/daemon-preload.js', import.meta.url))

/** dist always holds the .js; under ts-node the source .ts is its loadable twin. */
export function loadableInstrumentsPreload (): string {
  return existsSync(INSTRUMENTS_PRELOAD) ? INSTRUMENTS_PRELOAD : INSTRUMENTS_PRELOAD.replace(/\.js$/, '.ts')
}

export type DaemonBootCode = 'daemon-boot' | 'daemon-timeout'

export class DaemonBootError extends Error {
  readonly code: DaemonBootCode
  readonly label: string

  constructor (code: DaemonBootCode, label: string) {
    super(`daemon ${label}: ${code}`)
    this.name = 'DaemonBootError'
    this.code = code
    this.label = label
  }
}

/**
 * A restart that did not stop cleanly or did not boot again. RUN_TOKENS (67-21) has no room for a new
 * token, so the code handed to the leg runner stays `daemon-boot`; `detail` keeps the specific reason.
 */
export class DaemonRestartError extends DaemonBootError {
  readonly detail: 'daemon-restart' = 'daemon-restart'

  constructor (label: string, reason: string) {
    super('daemon-boot', label)
    this.name = 'DaemonRestartError'
    this.message = `daemon ${label}: daemon-restart ${reason}`
  }
}

export type PeerKind = 'authority' | 'voter'

export interface DaemonSpec {
  /** The primary label: its dir is the process's --state. */
  label: string
  role: Role
  kind: PeerKind
  /** Every label this process serves (more than one when colocated). */
  labels: string[]
}

/** The voter STAGE names prof/netstats.mjs knows, in order. */
export const VOTER_STAGES = Object.freeze([
  'started',
  'joined',
  'intake-ready',
  'registration-staged',
  'association-staged',
  'challenge-received',
  'challenge-answered',
  'associated',
  'eligible',
  'vote-built',
  'voting-open',
  'ready-to-send',
  'pooling',
  'committed',
  'results-wait',
  'results-read'
] as const)

export interface DaemonCallOk {
  ok: true
  result: Record<string, unknown>
  ms: number
}

export interface DaemonCallErr {
  ok: false
  error: { name: string, code?: string, message: string }
  /** True when no daemon answered (status 0). */
  unreachable: boolean
  ms: number
}

export type DaemonCallResult = DaemonCallOk | DaemonCallErr

export interface DaemonHandle {
  readonly label: string
  readonly role: Role
  readonly kind: PeerKind
  /** The label's own dir: `<state>/<party>/<label>`, holding ctl.port and ctl.token. */
  readonly dir: string
  readonly pid: number
  call (verb: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<DaemonCallResult>
  /** Voters only: writes `STAGE <name>` into ev/<label>.log. */
  stage (name: string): void
}

export interface DaemonLauncherOptions {
  stateDir: string
  party: string
  relayEnvPath: string
  evDir: string
  registry: SecretRegistry
  mask: (s: string) => string
  debug?: string
  importFile?: string
  cpuProf: boolean
  instruments: boolean
  bootTimeoutMs?: number
  /** The argv after the node flags; defaults to the vt bin's `<role> start ...` form. */
  daemonArgv?: (spec: DaemonSpec, peerDir: string) => string[]
  extraEnv?: Record<string, string>
  cwd?: string
  nowMs?: () => number
  onStep?: (w: StepWindow) => void
}

export interface DaemonLauncher {
  start (spec: DaemonSpec): Promise<DaemonHandle>
  handle (label: string): DaemonHandle | undefined
  /** Stops the label's process group cleanly and spawns the same argv on the same peer dirs. */
  restart (label: string): Promise<DaemonHandle>
  stopAll (): Promise<{ stopped: number, killed: number }>
  startedCount (): number
}

const DEFAULT_BOOT_TIMEOUT_MS = 300000
const DEFAULT_CALL_TIMEOUT_MS = 600000
const STOP_VERB_TIMEOUT_MS = 10000
const STOP_WAIT_MS = 15000
const TERM_WAIT_MS = 10000
const KILL_WAIT_MS = 2000
const POLL_MS = 100

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Proc {
  spec: DaemonSpec
  child: ChildProcess
  dirs: Map<string, string>
  exited: boolean
  closed: Promise<void>
  logFd: number
}

/** Writes each whole line with one writeSync, so lines from parallel daemons never interleave mid-line. */
function pipeLines (stream: NodeJS.ReadableStream, fd: () => number): void {
  let buf = ''
  const put = (line: string): void => {
    try {
      writeSync(fd(), line)
    } catch {
      // the log was closed by stopAll: a straggler line after teardown is dropped, never thrown
    }
  }
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buf += chunk
    let i = buf.indexOf('\n')
    while (i >= 0) {
      put(buf.slice(0, i + 1))
      buf = buf.slice(i + 1)
      i = buf.indexOf('\n')
    }
  })
  stream.on('end', () => {
    if (buf.length > 0) put(buf + '\n')
    buf = ''
  })
}

/** The role header of a label's own ctl server; an unknown label is a boot refusal, not a bad-arg. */
export function roleForLabel (label: string): Role {
  if (label === 'officer') return 'officer'
  if (/^kh-[a-z0-9]+$/.test(label)) return 'keyholder'
  if (/^v[0-9]+$/.test(label)) return 'voter'
  throw new DaemonBootError('daemon-boot', label)
}

/** 67-21 name, kept for the callers that already import it. */
export function roleOfLabel (label: string): Role {
  return roleForLabel(label)
}

export function kindOfLabel (label: string): PeerKind {
  return roleForLabel(label) === 'voter' ? 'voter' : 'authority'
}

/** The ONLY formatter of ev/commands.log lines: args are never a parameter, and no token reaches it. */
export function formatCommandLine (line: { iso: string, label: string, verb: string, ok: boolean, ms: number }): string {
  const verb = VERB_NAME_RE.test(line.verb) ? line.verb : '-'
  return `${line.iso} ${line.label} ${verb} ok=${line.ok} ms=${line.ms}`
}

export function defaultDaemonArgv (opts: Pick<DaemonLauncherOptions, 'relayEnvPath' | 'party' | 'instruments'>): (spec: DaemonSpec, peerDir: string) => string[] {
  return (spec, peerDir) => [
    VT_BIN,
    spec.role,
    'start',
    '--state',
    peerDir,
    '--relay',
    opts.relayEnvPath,
    '--party',
    opts.party,
    ...(spec.role === 'officer' ? ['--accept-token-attestations'] : []),
    ...(spec.labels.length > 1 ? ['--colocate', spec.labels.join(',')] : []),
    ...(opts.instruments ? ['--instruments'] : [])
  ]
}

export function createDaemonLauncher (opts: DaemonLauncherOptions): DaemonLauncher {
  const nowMs = opts.nowMs ?? Date.now
  const bootTimeoutMs = opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS
  const daemonArgv = opts.daemonArgv ?? defaultDaemonArgv(opts)
  const procs: Proc[] = []
  const handles = new Map<string, DaemonHandle>()
  const openFds: number[] = []
  let debugFd: number | undefined
  let commandsFd: number | undefined

  const openAppend = (path: string): number => {
    const fd = openSync(path, 'a', 0o600)
    openFds.push(fd)
    return fd
  }
  const debugLog = (): number => (debugFd ??= openAppend(join(opts.evDir, 'debug.log')))
  const commandsLog = (): number => (commandsFd ??= openAppend(join(opts.evDir, 'commands.log')))

  const childEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.NODE_OPTIONS
    delete env.DEBUG
    env.FORCE_COLOR = '0'
    env.DEBUG_COLORS = '0'
    env.DEBUG_HIDE_DATE = '0'
    if (opts.debug !== undefined) env.DEBUG = opts.debug
    for (const [k, v] of Object.entries(opts.extraEnv ?? {})) env[k] = v
    return env
  }

  const makeHandle = (proc: Proc, label: string, dir: string): DaemonHandle => {
    const role = roleForLabel(label)
    const kind = label === proc.spec.label ? proc.spec.kind : kindOfLabel(label)
    return {
      label,
      role,
      kind,
      dir,
      pid: proc.child.pid ?? -1,
      async call (verb, args = {}, o = {}) {
        const started = performance.now()
        const reply = await callCtl({ dir, role, verb, args, timeoutMs: o.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS })
        const ms = Math.round(performance.now() - started)
        const ok = reply.status === 200 && reply.body.ok === true
        writeSync(commandsLog(), formatCommandLine({ iso: new Date(nowMs()).toISOString(), label, verb, ok, ms }) + '\n')
        if (ok) return { ok: true, result: reply.body.result ?? {}, ms }
        const err = reply.body.error ?? { name: 'BadResponse' }
        const view: DaemonCallErr['error'] = { name: err.name, message: opts.mask(err.message ?? '') }
        if (err.code !== undefined) view.code = err.code
        return { ok: false, error: view, unreachable: reply.status === 0, ms }
      },
      stage (name) {
        if (kind !== 'voter') throw new TypeError('launcher: stage-voter-only')
        if (!(VOTER_STAGES as readonly string[]).includes(name)) throw new TypeError('launcher: bad-stage')
        writeSync(proc.logFd, `STAGE ${name}\n`)
      }
    }
  }

  function nodeFlagsFor (primaryDir: string): string[] {
    const flags: string[] = []
    if (opts.importFile !== undefined) flags.push('--import', opts.importFile)
    if (opts.instruments) flags.push('--import', loadableInstrumentsPreload())
    if (opts.cpuProf) flags.push('--cpu-prof', '--cpu-prof-dir', join(primaryDir, 'cpu-prof'))
    return flags
  }

  function spawnProc (spec: DaemonSpec, dirs: Map<string, string>, primaryDir: string, existing?: Proc): Proc {
    const argv = daemonArgv(spec, primaryDir)
    // A custom argv may omit it; the officer must carry the test-posture flag exactly once.
    if (spec.role === 'officer' && !argv.includes('--accept-token-attestations')) argv.push('--accept-token-attestations')
    const logFd = openAppend(join(opts.evDir, `${spec.label}.log`))
    const env = childEnv()
    if (opts.instruments) {
      const instrDir = join(primaryDir, 'instruments')
      mkdirSync(instrDir, { recursive: true, mode: 0o700 })
      env.VT_INSTR_DIR = instrDir
      env.VT_INSTR_ROLE = spec.role
    }
    const child = spawn(process.execPath, [...nodeFlagsFor(primaryDir), ...argv], {
      cwd: opts.cwd ?? process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const proc: Proc = existing ?? { spec, child, dirs, exited: false, closed: Promise.resolve(), logFd: -1 }
    proc.child = child
    proc.exited = false
    proc.logFd = logFd
    proc.closed = new Promise<void>((resolve) => {
      child.once('close', () => resolve())
      child.once('error', () => resolve())
    })
    child.once('exit', () => {
      proc.exited = true
    })
    child.once('error', () => {
      proc.exited = true
    })
    if (child.stdout !== null) pipeLines(child.stdout, () => proc.logFd)
    if (child.stderr !== null) pipeLines(child.stderr, () => (spec.kind === 'authority' ? debugLog() : proc.logFd))
    if (!procs.includes(proc)) procs.push(proc)
    return proc
  }

  async function finishBoot (proc: Proc, startMs: number, stepName: string): Promise<DaemonHandle> {
    const spec = proc.spec
    try {
      const deadline = performance.now() + bootTimeoutMs
      for (;;) {
        if ([...proc.dirs.values()].every((d) => readCtlPort(d).ok)) break
        if (proc.exited) throw new DaemonBootError('daemon-boot', spec.label)
        if (performance.now() > deadline) {
          proc.child.kill('SIGKILL')
          throw new DaemonBootError('daemon-timeout', spec.label)
        }
        await sleep(POLL_MS)
      }
      for (const [, dir] of proc.dirs) opts.registry.registerFile(join(dir, CTL_TOKEN_FILE), { windows: true })
      let primary: DaemonHandle | undefined
      for (const [label, dir] of proc.dirs) {
        const h = makeHandle(proc, label, dir)
        handles.set(label, h)
        if (label === spec.label) primary = h
      }
      return primary as DaemonHandle
    } finally {
      opts.onStep?.({ name: stepName, startMs, endMs: nowMs() })
    }
  }

  async function start (spec: DaemonSpec): Promise<DaemonHandle> {
    for (const label of spec.labels) if (handles.has(label)) throw new TypeError('launcher: label-started')
    if (!spec.labels.includes(spec.label)) throw new TypeError('launcher: primary-not-listed')
    const startMs = nowMs()
    const partyDir = join(opts.stateDir, opts.party)
    mkdirSync(partyDir, { recursive: true, mode: 0o700 })
    const dirs = new Map<string, string>()
    for (const label of spec.labels) {
      const dir = join(partyDir, label)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      dirs.set(label, dir)
    }
    const primaryDir = dirs.get(spec.label) as string
    return finishBoot(spawnProc(spec, dirs, primaryDir), startMs, `start-${spec.label}`)
  }

  const waitExit = async (proc: Proc, ms: number): Promise<boolean> => {
    const deadline = performance.now() + ms
    while (!proc.exited && performance.now() < deadline) await sleep(POLL_MS)
    return proc.exited
  }

  const stopOne = async (proc: Proc): Promise<{ killed: boolean }> => {
    if (proc.exited) return { killed: false }
    const h = handles.get(proc.spec.label)
    if (h !== undefined) await h.call('stop', {}, { timeoutMs: STOP_VERB_TIMEOUT_MS })
    if (await waitExit(proc, STOP_WAIT_MS)) return { killed: false }
    try {
      proc.child.kill('SIGTERM')
    } catch {
      // already gone
    }
    if (await waitExit(proc, TERM_WAIT_MS)) return { killed: true }
    try {
      proc.child.kill('SIGKILL')
    } catch {
      // already gone
    }
    await waitExit(proc, KILL_WAIT_MS)
    return { killed: true }
  }

  async function restart (label: string): Promise<DaemonHandle> {
    const proc = procs.find((p) => p.spec.labels.includes(label))
    if (proc === undefined) throw new DaemonBootError('daemon-boot', label)
    const startMs = nowMs()
    const primary = proc.spec.label
    const h = handles.get(primary)
    if (h !== undefined) await h.call('stop', {}, { timeoutMs: STOP_VERB_TIMEOUT_MS })
    let killed = false
    if (!(await waitExit(proc, STOP_WAIT_MS))) {
      try {
        proc.child.kill('SIGTERM')
      } catch {
        // already gone
      }
      if (!(await waitExit(proc, TERM_WAIT_MS))) {
        try {
          proc.child.kill('SIGKILL')
        } catch {
          // already gone
        }
        await waitExit(proc, KILL_WAIT_MS)
      }
      killed = true
    }
    if (killed || proc.child.exitCode !== 0) throw new DaemonRestartError(label, 'stop-not-clean')
    const oldFd = proc.logFd
    const fdIndex = openFds.indexOf(oldFd)
    if (fdIndex >= 0) openFds.splice(fdIndex, 1)
    try {
      closeSync(oldFd)
    } catch {
      // closed already
    }
    for (const l of proc.spec.labels) {
      handles.delete(l)
      const dir = proc.dirs.get(l)
      if (dir !== undefined) rmSync(join(dir, CTL_PORT_FILE), { force: true })
    }
    const primaryDir = proc.dirs.get(primary) as string
    return finishBoot(spawnProc(proc.spec, proc.dirs, primaryDir, proc), startMs, `restart-${label}`)
  }

  async function stopAll (): Promise<{ stopped: number, killed: number }> {
    let stopped = 0
    let killed = 0
    const tally = (r: { killed: boolean }): void => {
      stopped++
      if (r.killed) killed++
    }
    const voters = procs.filter((p) => p.spec.kind === 'voter')
    const authorities = procs.filter((p) => p.spec.kind === 'authority').reverse()
    for (const r of await Promise.all(voters.map(stopOne))) tally(r)
    for (const p of authorities) tally(await stopOne(p))
    await Promise.all(procs.map((p) => (p.exited ? p.closed : Promise.resolve())))
    for (const fd of openFds.splice(0)) {
      try {
        closeSync(fd)
      } catch {
        // closed already
      }
    }
    debugFd = undefined
    commandsFd = undefined
    return { stopped, killed }
  }

  return {
    start,
    handle: (label) => handles.get(label),
    restart,
    stopAll,
    startedCount: () => procs.length
  }
}
