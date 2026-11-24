// runElection: the `vt run election` orchestrator core. Order: refuse a stale build, refuse an over-budget
// topology (both before any disk or process side effect), create <state>/{ev,secrets} and ev/driver.log,
// build the run's secret registry, masker, line writer and leg runner, run the legs with lazily started,
// per-party isolated daemons, mark p1/p2 once each, and in every case stop the daemons, scan the evidence
// for registered secrets, write results.json once and end with SUMMARY as the last line (exit 0/1).

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT, type ExitCode } from '../cli/exit-codes.js'
import type { CliIo } from '../cli/run-cli.js'
import { StaleBuildError, assertFreshBuild } from '../engine.js'
import { DaemonBootError, createDaemonLauncher, kindOfLabel, roleOfLabel, type DaemonHandle, type DaemonLauncherOptions, type DaemonSpec } from './daemon-launcher.js'
import { ELECTION_LEGS, type ElectionLeg, type RunContext, type RunPeer } from './election-legs.js'
import { LegFail, SOFT_TOKENS, createLegRunner } from './legs.js'
import { peerLabels, type RunOptions } from './options.js'
import { createRunOutput } from './output.js'
import { assertPeerBudget, defaultMaxPeers } from './peer-budget.js'
import { RESULTS_TOOL, buildResults, exitCodeFor, summaryLine, writeResults } from './results.js'
import { SecretRegistry, createLineMasker, registerRelay } from './secret-scan.js'

export interface RunDeps {
  io: CliIo
  legs?: readonly ElectionLeg[]
  assertFresh?: () => unknown
  launcherFactory?: typeof createDaemonLauncher
  launcherOverrides?: Partial<DaemonLauncherOptions>
  nowMs?: () => number
  perfNow?: () => number
  totalmem?: number
  handleSignals?: boolean
}

const SECRET_NAME_RE = /^[a-z0-9][a-z0-9.-]*$/
const CRASH_MESSAGE_CHARS = 200

function errorName (e: unknown): string {
  const n = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined
  const clean = typeof n === 'string' ? n.replace(/[^A-Za-z0-9_.-]/g, '') : ''
  return clean.length > 0 ? clean : 'Error'
}

function errorMessage (e: unknown): string {
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message
  try {
    return String(e)
  } catch {
    return 'unprintable'
  }
}

export async function runElection (opts: RunOptions, deps: RunDeps): Promise<ExitCode> {
  const { io } = deps
  const legs = deps.legs ?? ELECTION_LEGS
  const nowMs = deps.nowMs ?? Date.now
  const voidLine = (reason: string, extra: Record<string, unknown> = {}): void => {
    io.out('RESULT ' + JSON.stringify({ tool: RESULTS_TOOL, verdict: 'VOID', reason, ...extra }) + '\n')
  }

  // 1. a stale dist makes every result vacuous: refuse first
  try {
    (deps.assertFresh ?? assertFreshBuild)()
  } catch (e) {
    io.err('vt run: refused stale-build\n')
    voidLine('stale-build', { code: e instanceof StaleBuildError ? e.code : 'error' })
    return EXIT.USAGE
  }

  // 2. the peer budget, before any mkdir or spawn
  const labels = peerLabels(opts)
  const requested = labels.length
  const max = opts.maxPeers ?? defaultMaxPeers(deps.totalmem)
  try {
    assertPeerBudget(requested, max)
  } catch {
    io.err(`vt run: refused max-peers requested=${requested} max=${max}\n`)
    voidLine('max-peers', { requested, max })
    return EXIT.USAGE
  }

  // 3. the state layout: evidence is never overwritten
  const stateDir = opts.stateDir
  const evDir = join(stateDir, 'ev')
  const secretsDir = join(stateDir, 'secrets')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  try {
    mkdirSync(evDir, { mode: 0o700 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      io.err('vt run: refused state-used\n')
      voidLine('state-used')
      return EXIT.USAGE
    }
    throw e
  }
  mkdirSync(secretsDir, { mode: 0o700 })
  const driverFd = openSync(join(evDir, 'driver.log'), 'wx', 0o600)

  // 4. secrets, masker, line writer, leg runner
  const registry = new SecretRegistry()
  registerRelay(registry, opts.relayEnvPath, opts.relayMultiaddr)
  const mask = createLineMasker({ registry, stateDir })
  const out = createRunOutput({
    write: (line) => {
      io.out(line + '\n')
      writeSync(driverFd, line + '\n')
    },
    mask,
    nowMs,
    ...(deps.perfNow !== undefined ? { perfNow: deps.perfNow } : {}),
    ...(opts.marksFile !== undefined ? { marksFile: opts.marksFile } : {})
  })
  let resolveAbort!: (reason: string) => void
  const abort = new Promise<string>((resolve) => {
    resolveAbort = resolve
  })
  const runner = createLegRunner({ evDir, flagsDir: secretsDir, out, mask, nowMs, ...(deps.perfNow !== undefined ? { perfNow: deps.perfNow } : {}), abort })
  const launcherOptions: DaemonLauncherOptions = {
    stateDir,
    party: opts.party,
    relayEnvPath: opts.relayEnvPath,
    evDir,
    registry,
    mask,
    cpuProf: opts.cpuProf,
    instruments: opts.instruments,
    nowMs,
    onStep: (w) => {
      runner.steps.push(w)
    },
    ...(opts.debug !== undefined ? { debug: opts.debug } : {}),
    ...(opts.importFile !== undefined ? { importFile: opts.importFile } : {}),
    ...(deps.launcherOverrides ?? {})
  }
  const launcher = (deps.launcherFactory ?? createDaemonLauncher)(launcherOptions)
  const startedAt = new Date(nowMs()).toISOString()
  out.key('VT-START', `at=${startedAt} party=${opts.party} peers=${requested} maxPeers=${max}`)
  out.runMark('p1-start')

  // 5. watchdog and signals
  const alarm = setTimeout(() => resolveAbort('alarm'), opts.alarmS * 1000)
  alarm.unref()
  const onSignal = (): void => resolveAbort('interrupted')
  if (deps.handleSignals === true) {
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  }

  // 6. the run context
  const groupOf = (label: string): string[] => (opts.colocate?.includes(label) === true ? [...opts.colocate] : [label])
  const starts = new Map<string, Promise<void>>()
  const startGroup = (group: string[]): Promise<void> => {
    const primary = group[0] as string
    let p = starts.get(primary)
    if (p === undefined) {
      const spec: DaemonSpec = { label: primary, role: roleOfLabel(primary), kind: kindOfLabel(primary), labels: group }
      p = launcher.start(spec).then(() => undefined)
      p.catch(() => undefined)
      starts.set(primary, p)
    }
    return p
  }
  const peers = new Map<string, RunPeer>()
  const peer = (label: string): RunPeer => {
    if (!labels.includes(label)) throw new TypeError('run: unknown-peer')
    let p = peers.get(label)
    if (p !== undefined) return p
    const ready = async (): Promise<void> => {
      try {
        await startGroup(groupOf(label))
      } catch (e) {
        if (e instanceof DaemonBootError) throw new LegFail('FAIL', e.code)
        throw e
      }
    }
    const handleOf = (): DaemonHandle => {
      const h = launcher.handle(label)
      if (h === undefined) throw new TypeError('run: peer-not-started')
      return h
    }
    p = {
      label,
      ready,
      async call (verb, args, o) {
        await ready()
        return handleOf().call(verb, args, o)
      },
      stage (name) {
        handleOf().stage(name)
      }
    }
    peers.set(label, p)
    return p
  }
  const ctx: RunContext = {
    opts,
    out,
    peer,
    startPeers: async (ls) => {
      await Promise.all(ls.map((l) => peer(l).ready()))
    },
    secretPath (name) {
      if (!SECRET_NAME_RE.test(name)) throw new TypeError('run: secret-name')
      return join(secretsDir, name)
    },
    registerSecretFile (path, o) {
      registry.registerFile(path, o)
    }
  }

  // 7. the legs
  let driverToken: string | undefined
  try {
    for (const leg of legs) {
      if (leg.part === 'p2' && !out.hasMark('p2-start')) {
        if (!out.hasMark('p1-end')) out.runMark('p1-end')
        out.runMark('p2-start')
      }
      const body = leg.body
      const st = await runner.runLeg(leg.name, async (L) => {
        if (body === undefined) {
          L.need('leg-unwired', 'W0', `${leg.name} has a registered body`, false)
          return
        }
        await body(L, ctx)
      })
      if (st.status !== 'PASS' && !(st.status === 'FAIL' && SOFT_TOKENS.has(st.token))) break
    }
  } catch (e) {
    driverToken = 'crash'
    try {
      out.say('FATAL', `${errorName(e)} ${errorMessage(e).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, CRASH_MESSAGE_CHARS)}`)
    } catch {
      // the summary below still names the crash
    }
  }

  // 8. teardown: marks, daemons, scan, results, RESULT, SUMMARY (always the last line)
  if (!out.hasMark('p1-end')) out.runMark('p1-end')
  if (out.hasMark('p2-start') && !out.hasMark('p2-end')) out.runMark('p2-end')
  clearTimeout(alarm)
  if (deps.handleSignals === true) {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
  try {
    await launcher.stopAll()
  } catch {
    driverToken ??= 'crash'
  }
  const partyDir = join(stateDir, opts.party)
  const scan = registry.scanTree([evDir, partyDir], {
    exclude: [secretsDir],
    include: (p) => p.startsWith(evDir + '/') || p.endsWith('.log')
  })
  let summary = summaryLine({ statuses: runner.statuses, planLength: legs.length, scan, ...(driverToken !== undefined ? { driverToken } : {}) })
  try {
    writeResults(
      join(evDir, 'results.json'),
      buildResults({
        summary,
        legs: runner.statuses,
        durations: runner.durations,
        steps: runner.steps,
        secretScan: scan,
        keys: out.keys(),
        startedAt,
        endedAt: new Date(nowMs()).toISOString()
      })
    )
  } catch {
    summary = summaryLine({ statuses: runner.statuses, planLength: legs.length, scan, driverToken: 'results-write' })
  }
  out.result({ tool: RESULTS_TOOL, summary, legs: runner.statuses.length, secretScan: scan })
  out.summary(summary)
  closeSync(driverFd)
  return exitCodeFor(summary)
}
