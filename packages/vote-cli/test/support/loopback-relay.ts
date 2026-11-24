// The loopback relay fixture for the automated (host) test tier. It starts the UNMODIFIED
// packages/p2p-probe-host/relay-only.mjs on an ephemeral 127.0.0.1 port, in a fresh 0700 temp dir
// outside the repo, and writes a 0600 relay.env for the daemons under test.
//
// Secrecy: a loopback relay address and its full peer id are secrets under the rig's relayIsPrivate
// rule. The child's stdout and stderr go to a 0600 relay.log inside the fixture dir and never to the
// test process's streams; errors carry a token only; peerId8 is the only peer-id form exposed.

import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, closeSync, mkdtempSync, openSync, writeSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeRelayEnv } from '../../src/relay/relay-env.js'

export const PROBE_HOST_DIR = fileURLToPath(new URL('../../../p2p-probe-host/', import.meta.url))
export const RELAY_ONLY = join(PROBE_HOST_DIR, 'relay-only.mjs')

/** Ports the shared host's Metro servers use; a relay must never sit on one. */
const RESERVED_PORTS: ReadonlySet<number> = new Set([8081, 8091, 8097])
const MULTIADDR_SHAPE = /^\/ip4\/127\.0\.0\.1\/tcp\/(\d+)\/ws\/p2p\/([1-9A-HJ-NP-Za-km-z]+)$/

export interface LoopbackRelay {
  dir: string
  relayEnvPath: string
  multiaddr: string
  port: number
  peerId8: string
  logPath: string
  stop(): Promise<{ exitCode: number | null; stopped: boolean }>
}

export class LoopbackRelayError extends Error {
  readonly token: string

  constructor (token: string) {
    super(`loopback relay failed: ${token}`)
    this.name = 'LoopbackRelayError'
    this.token = token
  }
}

/** The env the relay (and a probe client) runs with: no inherited node flags, no debug namespaces, no colour. */
export function relayChildEnv (): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.DEBUG
  env.FORCE_COLOR = '0'
  env.DEBUG_COLORS = '0'
  return env
}

function freePort (): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => { resolve(port) })
    })
  })
}

async function pickPort (): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const port = await freePort()
    if (port >= 1024 && !RESERVED_PORTS.has(port)) return port
  }
  throw new LoopbackRelayError('no-port')
}

interface Attempt {
  outcome: 'ready' | 'eaddrinuse'
  child: ChildProcess
  multiaddr: string
  seenStopped: () => boolean
  exited: Promise<number | null>
}

/** Start one relay process on `port`; resolve when it is ready or when the port was taken. */
function startOnce (dir: string, port: number, logPath: string, readyTimeoutMs: number): Promise<Attempt> {
  return new Promise((resolve, reject) => {
    const logFd = openSync(logPath, 'a', 0o600)
    const child = spawn(
      process.execPath,
      [
        RELAY_ONLY,
        '--key-file', join(dir, 'relay-key.pb'),
        '--port', String(port),
        '--lan-ip', '127.0.0.1',
        '--bootstrap-out', join(dir, 'bootstrap.json'),
        '--status-ms', '60000'
      ],
      { cwd: PROBE_HOST_DIR, env: relayChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const sink = (chunk: Buffer): void => {
      // Appends only; nothing from the child reaches the test process's own stdout or stderr.
      try { writeSync(logFd, chunk) } catch { /* the log is best effort */ }
    }
    child.stderr?.on('data', sink)

    let multiaddr = ''
    let stopped = false
    let settled = false
    let buffered = ''
    let exitCode: number | null = null
    let resolveExit: (code: number | null) => void = () => {}
    const exited = new Promise<number | null>((r) => { resolveExit = r })

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL')
        reject(new LoopbackRelayError('ready-timeout'))
      })
    }, readyTimeoutMs)

    const onLine = (line: string): void => {
      if (line.startsWith('RELAY_MULTIADDR=')) {
        multiaddr = line.slice('RELAY_MULTIADDR='.length)
      } else if (line === 'RELAY_READY') {
        settle(() => { resolve({ outcome: 'ready', child, multiaddr, seenStopped: () => stopped, exited }) })
      } else if (line === 'RELAY_STOPPED') {
        stopped = true
      } else if (line.startsWith('RELAY_REFUSED ') || line.startsWith('RELAY_FATAL ')) {
        const token = line.split(' ')[1] ?? 'unknown'
        if (line === 'RELAY_FATAL eaddrinuse') {
          settle(() => { resolve({ outcome: 'eaddrinuse', child, multiaddr, seenStopped: () => stopped, exited }) })
        } else {
          settle(() => { reject(new LoopbackRelayError(token)) })
        }
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      sink(chunk)
      buffered += chunk.toString('utf8')
      let nl = buffered.indexOf('\n')
      while (nl !== -1) {
        onLine(buffered.slice(0, nl))
        buffered = buffered.slice(nl + 1)
        nl = buffered.indexOf('\n')
      }
    })
    child.once('error', () => {
      settle(() => { reject(new LoopbackRelayError('spawn-failed')) })
    })
    child.once('exit', (code) => {
      exitCode = code
      try { closeSync(logFd) } catch { /* already closed */ }
      resolveExit(exitCode)
      settle(() => { reject(new LoopbackRelayError('exit-before-ready')) })
    })
  })
}

export async function startLoopbackRelay (opts: { readyTimeoutMs?: number; attempts?: number } = {}): Promise<LoopbackRelay> {
  const readyTimeoutMs = opts.readyTimeoutMs ?? 60000
  const attempts = opts.attempts ?? 3
  const dir = mkdtempSync(join(tmpdir(), 'vt-relay-'))
  chmodSync(dir, 0o700)
  const logPath = join(dir, 'relay.log')

  let attempt: Attempt | undefined
  let port = 0
  for (let i = 0; i < attempts; i++) {
    port = await pickPort()
    const a = await startOnce(dir, port, logPath, readyTimeoutMs)
    if (a.outcome === 'ready') {
      attempt = a
      break
    }
    await a.exited
  }
  if (attempt === undefined) throw new LoopbackRelayError('eaddrinuse')

  const m = MULTIADDR_SHAPE.exec(attempt.multiaddr)
  if (m === null || Number(m[1]) !== port || m[2] === undefined) {
    attempt.child.kill('SIGKILL')
    await attempt.exited
    throw new LoopbackRelayError('multiaddr-shape')
  }
  const relayEnvPath = join(dir, 'relay.env')
  writeRelayEnv(relayEnvPath, attempt.multiaddr)
  const { child, exited, seenStopped } = attempt

  let stopping: Promise<{ exitCode: number | null; stopped: boolean }> | undefined
  const stop = (): Promise<{ exitCode: number | null; stopped: boolean }> => {
    if (stopping !== undefined) return stopping
    stopping = (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => { r(false) }, 15000))
      ])
      if (!graceful) {
        child.kill('SIGKILL')
        await exited
      }
      return { exitCode: child.exitCode, stopped: seenStopped() }
    })()
    return stopping
  }

  return {
    dir,
    relayEnvPath,
    multiaddr: attempt.multiaddr,
    port,
    peerId8: m[2].slice(-8),
    logPath,
    stop
  }
}
