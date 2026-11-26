// The opt-in `--instruments` preload, loaded into a daemon by node --import BEFORE the daemon's main
// module. Its first statement applies 67-23's env hygiene: the `debug` package reads DEBUG when it is
// first imported, so the redacted namespaces must be excluded before ANY engine module loads. Engine
// packages are therefore resolved and dynamic-imported below, never statically imported here.
//
// The preload only observes: it wraps ClusterClient.send (size probe), CadreNode.start (node capture),
// and console.warn/info (digest-mismatch count), answers local req-<seq>.json control-leaf reads from
// the captured nodes, and writes 0600 size-probe.json. It opens no socket, adds no listener other than
// the two timers and the two exit hooks, and never changes an argument or a reply.

import { applyDaemonEnv } from '../../daemon/daemon-env.js'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readControlLeaf, type ControlLeafResult } from './control-leaf.js'

applyDaemonEnv()

/**
 * Anchored at this package's package.json: the daemon's node builder imports cadre-core from
 * packages/vote-cli/node_modules, and each workspace holds its own copy, so any other anchor wraps a
 * class the running node never uses.
 */
export const DAEMON_PACKAGE_URL = new URL('../../../package.json', import.meta.url)

/** ESM-only packages have an `import`-only exports map, so CJS require.resolve cannot name them. */
export function daemonModuleUrl (requireFromDaemon: NodeRequire, spec: string): string {
  let dir = dirname(requireFromDaemon.resolve('./package.json'))
  for (;;) {
    const manifest = join(dir, 'node_modules', ...spec.split('/'), 'package.json')
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
        exports?: Record<string, { import?: string } | string>
        main?: string
      }
      const root = pkg.exports?.['.'] ?? pkg.exports?.default
      const rel = typeof root === 'string' ? root : (root?.import ?? pkg.main ?? 'index.js')
      return pathToFileURL(join(dirname(manifest), rel)).href
    } catch {
      // try the next node_modules up the tree
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error('preload: module-not-found')
    dir = parent
  }
}

export interface SizeProbeState {
  installed: boolean
  calls: number
  maxBytes: number
  oversized: number
}

export const PROBE_CAP_BYTES = 1048576

const encoder = new TextEncoder()
const probe: SizeProbeState = { installed: false, calls: 0, maxBytes: 0, oversized: 0 }

/** Exactly two counting assignments inside a try that can never throw into the product call. */
export function installSizeProbe (proto: { send: (message: unknown, options?: unknown) => unknown }, state: SizeProbeState = probe): () => void {
  const original = proto.send
  proto.send = function (this: unknown, message: unknown, options?: unknown) {
    try {
      const bytes = encoder.encode(JSON.stringify(message)).byteLength
      state.calls++
      if (bytes > state.maxBytes) state.maxBytes = bytes
      if (bytes > PROBE_CAP_BYTES) state.oversized++
    } catch {
      // a probe failure must never change product behaviour
    }
    return original.call(this, message, options)
  }
  state.installed = true
  return () => {
    proto.send = original
  }
}

/** After the original resolves, the node is available for local control-leaf reads. */
export function trackCadreStarts (proto: { start: (...args: unknown[]) => Promise<unknown> }, nodes: Set<unknown>): void {
  const original = proto.start
  proto.start = async function (this: unknown, ...args: unknown[]) {
    const value = await original.apply(this, args)
    nodes.add(this)
    return value
  }
}

const DIGEST_MISMATCH_RE = /digest[\s-]?mismatch/i
const digestMismatch = { count: 0 }

/** Counts digest-mismatch lines and always calls the original. */
export function wrapConsoleDigestCount (): void {
  for (const key of ['warn', 'info'] as const) {
    const original = console[key].bind(console)
    console[key] = (...args: unknown[]): void => {
      try {
        for (const arg of args) {
          if (typeof arg === 'string' && DIGEST_MISMATCH_RE.test(arg)) {
            digestMismatch.count++
            break
          }
        }
      } catch {
        // counting must never change logging
      }
      original(...args)
    }
  }
}

export interface ControlLeafReply {
  seq: number
  peerId8: string
  read: ControlLeafResult
  digestMismatch: number
}

/** Revs and 8-character action prefixes only: no block id, peer id or full action id can reach a reply. */
export function reduceControlLeaf (read: ControlLeafResult): ControlLeafResult {
  if (typeof read === 'object' && 'unreadable' in read) {
    return { unreadable: String(read.unreadable).replace(/[^a-z0-9-]/g, '').slice(0, 32) }
  }
  return { leafRev: read.leafRev, leafAction8: read.leafAction8, tailRev: read.tailRev, tailAction8: read.tailAction8 }
}

export function makeControlLeafReply (seq: number, peerId8: string, read: ControlLeafResult, mismatch: number): ControlLeafReply {
  return { seq, peerId8, read: reduceControlLeaf(read), digestMismatch: mismatch }
}

function writePrivate (path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch {
    rmSync(tmp, { force: true })
  }
}

async function pumpRequests (dir: string, nodes: Set<unknown>): Promise<void> {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const m = /^req-(\d+)\.json$/.exec(name)
    if (m === null) continue
    const seq = Number(m[1])
    let request: { peerId8?: unknown }
    try {
      request = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { peerId8?: unknown }
    } catch {
      continue
    }
    const peerId8 = typeof request.peerId8 === 'string' && /^[A-Za-z0-9_-]{8}$/.test(request.peerId8) ? request.peerId8 : ''
    let node: unknown
    for (const candidate of peerId8.length === 0 ? [] : nodes) {
      const id = (candidate as { peerId?: { toString(): string } } | null)?.peerId
      if (id !== undefined && typeof id.toString === 'function' && id.toString().endsWith(peerId8)) {
        node = candidate
        break
      }
    }
    const read: ControlLeafResult = node === undefined ? { unreadable: 'peer-missing' } : await readControlLeaf(node)
    writePrivate(join(dir, `res-${seq}.json`), JSON.stringify(makeControlLeafReply(seq, peerId8, read, digestMismatch.count)) + '\n')
    rmSync(join(dir, name), { force: true })
  }
}

async function boot (): Promise<void> {
  const dir = process.env.VT_INSTR_DIR
  if (dir === undefined || dir.length === 0) return
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let cluster: any
  let cadre: any
  try {
    const requireFromDaemon = createRequire(fileURLToPath(DAEMON_PACKAGE_URL))
    const p2p = await import(daemonModuleUrl(requireFromDaemon, '@optimystic/db-p2p'))
    const core = await import(daemonModuleUrl(requireFromDaemon, '@serfab/cadre-core'))
    cluster = p2p.ClusterClient
    cadre = core.CadreNode
  } catch {
    return
  }
  const nodes = new Set<unknown>()
  if (typeof cluster?.prototype?.send === 'function') installSizeProbe(cluster.prototype)
  if (typeof cadre?.prototype?.start === 'function') trackCadreStarts(cadre.prototype, nodes)
  wrapConsoleDigestCount()
  const writeProbe = (): void => {
    writePrivate(join(dir, 'size-probe.json'), JSON.stringify({
      installed: probe.installed,
      calls: probe.calls,
      maxBytes: probe.maxBytes,
      oversized: probe.oversized,
      at: new Date().toISOString()
    }) + '\n')
  }
  const requestTimer = setInterval(() => {
    void pumpRequests(dir, nodes)
  }, 1000)
  requestTimer.unref()
  const probeTimer = setInterval(writeProbe, 30000)
  probeTimer.unref()
  process.once('beforeExit', writeProbe)
  process.once('SIGTERM', writeProbe)
  // the daemon ends through process.exit, which emits neither of the two above
  process.once('exit', writeProbe)
  writeProbe()
}

await boot()
