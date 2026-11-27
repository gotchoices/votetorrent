// Daemon fixture for the host-tier specs: starts the BUILT vt bin as a role daemon (the 67-21 launcher
// env: no NODE_OPTIONS, no DEBUG, FORCE_COLOR=0, DEBUG_COLORS=0, DEBUG_HIDE_DATE=0), captures its
// stdout and stderr into 0600 files that never reach mocha's output, resolves on the first of ctl.port,
// a BOOT-FAILED line, the process exit or the bound, and stops it the launcher's way (stop verb, then
// SIGTERM, then SIGKILL). `vt(args)` runs the bin once. `bootInProcessPeer` is the in-process context
// builder later specs asked for: it runs the daemon's own `bootPeer` in the test process, so the
// resulting VerbContext is exactly the daemon's, with no ctl server.
//
// Nothing here prints: a token is returned to the caller for its registry and never logged.

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCtlToken } from '../../src/ctl/ctl-files.js'
import { CTL_PORT_FILE, type Role } from '../../src/ctl/protocol.js'
import type { BootedPeer } from '../../src/daemon/boot-peer.js'
import { SecretRegistry } from '../../src/secrecy/redact.js'
import { readRelayEnv } from '../../src/relay/relay-env.js'
import { relayPeerIdOf } from '../../src/node/relay-readiness.js'
import { relayIsPrivate } from '../../src/run/secret-scan.js'

export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const VT_DIST_BIN = join(PACKAGE_ROOT, 'dist', 'bin', 'vt.js')

const POLL_MS = 100
const STOP_WAIT_MS = 30000
const TERM_WAIT_MS = 10000
const VT_KILL_MS = 120000
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The 67-21 launcher's child env. */
export function daemonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.DEBUG
  env.FORCE_COLOR = '0'
  env.DEBUG_COLORS = '0'
  env.DEBUG_HIDE_DATE = '0'
  return env
}

export interface VtResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Runs the dist bin once with the daemon env and a 120 s kill timer. */
export function vt(args: readonly string[]): Promise<VtResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VT_DIST_BIN, ...args], { env: daemonEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => { stdout += d })
    child.stderr?.on('data', (d: string) => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), VT_KILL_MS)
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr })
    })
  })
}

/** The peer's current ctl token (for a secret registry). Throws on a missing or refused token file. */
export function readTokenOnce(peerDir: string): string {
  const read = readCtlToken(peerDir)
  if (!read.ok) throw new Error(`ctl token unreadable: ${read.code}`)
  return read.token
}

export interface StartDaemonOptions {
  role: Role
  peerDir: string
  relayEnvPath: string
  party: string
  /** Additional start args, e.g. `--accept-token-attestations` or `--colocate officer,kh-a`. */
  extra?: readonly string[]
  logDir: string
  bootBoundMs?: number
}

export interface DaemonProc {
  proc: ChildProcess
  pid: number
  peerDir: string
  stdoutPath: string
  stderrPath: string
  /** True when ctl.port appeared before any failure, exit or the bound. */
  ready: boolean
  /** The token of a `VT-DAEMON-BOOT-FAILED` line seen before the bound. */
  bootFailedToken?: string
  exited(): boolean
  exitCode(): number | null
  /** Resolves the exit code once the process is gone, or null at the bound. */
  waitExit(ms: number): Promise<number | null>
  /** The daemon's whole stdout so far (what the 0600 log holds). */
  stdoutText(): string
  /** stop verb (30 s), then SIGTERM (10 s), then SIGKILL. */
  stop(): Promise<void>
}

const BOOT_FAILED_RE = /^VT-DAEMON-BOOT-FAILED .*token=([a-z0-9-]+)/m

export async function startDaemon(opts: StartDaemonOptions): Promise<DaemonProc> {
  const { role, peerDir, relayEnvPath, party, logDir } = opts
  const extra = opts.extra ?? []
  const bootBoundMs = opts.bootBoundMs ?? 300000
  mkdirSync(logDir, { recursive: true, mode: 0o700 })
  const stamp = `${basename(dirname(peerDir))}-${basename(peerDir)}-${Date.now()}`
  const stdoutPath = join(logDir, `${stamp}.out.log`)
  const stderrPath = join(logDir, `${stamp}.err.log`)
  const outFd = openSync(stdoutPath, 'a', 0o600)
  const errFd = openSync(stderrPath, 'a', 0o600)
  const child = spawn(
    'nice',
    ['-n', '10', process.execPath, VT_DIST_BIN, role, 'start', '--state', peerDir, '--relay', relayEnvPath, '--party', party, ...extra],
    { env: daemonEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stdout = ''
  let exited = false
  let exitCode: number | null = null
  const sink = (fd: number) => (chunk: Buffer): void => {
    try {
      writeSync(fd, chunk)
    } catch {
      // the log is best effort
    }
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    sink(outFd)(chunk)
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', sink(errFd))
  const closed = new Promise<number | null>((resolve) => {
    child.once('close', (code) => {
      exited = true
      exitCode = code
      try { closeSync(outFd) } catch { /* closed */ }
      try { closeSync(errFd) } catch { /* closed */ }
      resolve(code)
    })
    child.once('error', () => {
      exited = true
      try { closeSync(outFd) } catch { /* closed */ }
      try { closeSync(errFd) } catch { /* closed */ }
      resolve(null)
    })
  })
  const waitExit = async (ms: number): Promise<number | null> => {
    const deadline = Date.now() + ms
    while (!exited && Date.now() < deadline) await sleep(POLL_MS)
    return exited ? exitCode : null
  }

  let ready = false
  let bootFailedToken: string | undefined
  const deadline = Date.now() + bootBoundMs
  for (;;) {
    if (existsSync(join(peerDir, CTL_PORT_FILE))) {
      ready = true
      break
    }
    const m = BOOT_FAILED_RE.exec(stdout)
    if (m?.[1] !== undefined) {
      bootFailedToken = m[1]
      break
    }
    if (exited) break
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      break
    }
    await sleep(POLL_MS)
  }

  const stop = async (): Promise<void> => {
    if (exited) return
    await vt([role, 'stop', '--peer', peerDir])
    if ((await waitExit(STOP_WAIT_MS)) !== null || exited) return
    child.kill('SIGTERM')
    if ((await waitExit(TERM_WAIT_MS)) !== null || exited) return
    child.kill('SIGKILL')
    await closed
  }

  const handle: DaemonProc = {
    proc: child,
    pid: child.pid ?? -1,
    peerDir,
    stdoutPath,
    stderrPath,
    ready,
    exited: () => exited,
    exitCode: () => exitCode,
    waitExit,
    stdoutText: () => stdout,
    stop
  }
  if (bootFailedToken !== undefined) handle.bootFailedToken = bootFailedToken
  return handle
}

export interface BootInProcessPeerOptions {
  role: Role
  label: string
  party: string
  /** The run root: the peer dir is `<runRoot>/<party>/<label>`. */
  runRoot: string
  relayEnvPath: string
  acceptTokenAttestations?: boolean
}

/**
 * The in-process builder: the daemon's own `bootPeer` with a fresh SecretRegistry and redactor, the
 * default 90 s relay bound and 300 s boot bound, at `<runRoot>/<party>/<label>`. Builds the same
 * VerbContext the daemon builds, without a ctl server. The daemon module graph (cadre-core, libp2p,
 * vote-engine) is imported lazily, so a gated spec file costs nothing when the gate is off.
 */
export async function bootInProcessPeer(opts: BootInProcessPeerOptions): Promise<BootedPeer> {
  const { bootPeer } = await import('../../src/daemon/boot-peer.js')
  const { multiaddr } = readRelayEnv(opts.relayEnvPath)
  const peerId = relayPeerIdOf(multiaddr)
  const secrets = new SecretRegistry()
  const isPrivate = relayIsPrivate(multiaddr)
  if (isPrivate) {
    secrets.add(multiaddr)
    secrets.add(peerId)
  }
  return bootPeer({
    role: opts.role,
    label: opts.label,
    partyId: opts.party,
    peerDir: join(opts.runRoot, opts.party, opts.label),
    relay: { multiaddr, peerId, private: isPrivate },
    secrets,
    redactor: secrets.redactor({ paths: [[opts.runRoot, '<runs>']] }),
    acceptTokenAttestations: opts.acceptTokenAttestations ?? false,
    instruments: false,
    relayReadyMs: 90000,
    bootTimeoutMs: 300000
  })
}
