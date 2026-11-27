// The run-scoped secret registry of `vt run`: codes, shares, ctl tokens and a private relay address are
// registered by VALUE or by FILE PATH, masked out of every orchestrator line, and hunted down at the end
// of the run in every evidence file (whole values and 16-char windows, counted per file and secret the
// way the lean rig's scanSecrets does). There is no module-global registry: two runs in one process
// never share secrets. Nothing here returns a secret.

import { lstatSync, openSync, readdirSync, readFileSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from '../secrecy/redact.js'
import { scrubWall } from './output.js'

export const SECRET_MIN_LENGTH = 8
export const SECRET_WINDOW = 16
const SCAN_CHUNK_BYTES = 8 * 1024 * 1024

export interface SecretScan {
  /** (file, secret) pairs holding the whole value; -1 when a read failed. */
  whole: number
  /** (file, secret) pairs holding a 16-char window but not the whole value. */
  windows: number
  /** Regular files read. */
  files: number
}

export interface ScanTreeOptions {
  /** Absolute path prefixes never entered. */
  exclude: string[]
  /** When given, only files it accepts are read and counted. */
  include?: (path: string) => boolean
}

export class SecretRegistry {
  // value -> windowed
  readonly #values = new Map<string, boolean>()
  readonly #windows = new Set<string>()
  #longest = 0

  /** The rig's secret(): non-strings and values under 8 chars register nothing; windows need length >= 16. */
  register (value: string, opts?: { windows?: boolean }): void {
    if (typeof value !== 'string' || value.length < SECRET_MIN_LENGTH) return
    const windowed = opts?.windows === true || this.#values.get(value) === true
    this.#values.set(value, windowed)
    this.#longest = Math.max(this.#longest, Buffer.byteLength(value, 'utf8'))
    if (opts?.windows === true && value.length >= SECRET_WINDOW) {
      for (let i = 0; i + SECRET_WINDOW <= value.length; i++) this.#windows.add(value.slice(i, i + SECRET_WINDOW))
    }
  }

  /** Registers a file's trimmed content. The content is never returned or logged: secrets travel by path. */
  registerFile (path: string, opts?: { windows?: boolean }): void {
    this.register(readFileSync(path, 'utf8').trim(), opts)
  }

  get size (): number {
    return this.#values.size
  }

  /** Whole values become `<secret>`; a span covered by 16-char windows becomes one `<secret>`. */
  mask (text: string): string {
    let out = text
    for (const [k] of this.#values) if (out.includes(k)) out = out.split(k).join('<secret>')
    if (this.#windows.size === 0 || out.length < SECRET_WINDOW) return out
    const mask = new Uint8Array(out.length)
    let any = false
    for (let i = 0; i + SECRET_WINDOW <= out.length; i++) {
      if (this.#windows.has(out.slice(i, i + SECRET_WINDOW))) {
        any = true
        mask.fill(1, i, i + SECRET_WINDOW)
      }
    }
    if (!any) return out
    let r = ''
    let inMask = false
    for (let i = 0; i < out.length; i++) {
      if (mask[i] === 1) {
        if (!inMask) r += '<secret>'
        inMask = true
      } else {
        inMask = false
        r += out[i]
      }
    }
    return r
  }

  /** Walks the roots, reading each regular file in 8 MiB chunks (overlapping by the longest value - 1). */
  scanTree (roots: string[], opts: ScanTreeOptions): SecretScan {
    const scan: SecretScan = { whole: 0, windows: 0, files: 0 }
    const entries = [...this.#values.entries()]
    const excluded = (p: string): boolean => opts.exclude.some((e) => p === e || p.startsWith(e.endsWith('/') ? e : e + '/'))
    const overlap = Math.max(0, this.#longest - 1)
    const scanFile = (p: string): void => {
      scan.files++
      const foundWhole = new Set<string>()
      const foundWindow = new Set<string>()
      const fd = openSync(p, 'r')
      try {
        let carry = Buffer.alloc(0)
        const chunk = Buffer.alloc(SCAN_CHUNK_BYTES)
        for (;;) {
          const n = readSync(fd, chunk, 0, SCAN_CHUNK_BYTES, null)
          if (n === 0) break
          const text = Buffer.concat([carry, chunk.subarray(0, n)]).toString('utf8')
          for (const [s, windowed] of entries) {
            if (foundWhole.has(s)) continue
            if (text.includes(s)) {
              foundWhole.add(s)
              continue
            }
            if (!windowed || foundWindow.has(s) || s.length < SECRET_WINDOW) continue
            for (let i = 0; i + SECRET_WINDOW <= s.length; i++) {
              if (text.includes(s.slice(i, i + SECRET_WINDOW))) {
                foundWindow.add(s)
                break
              }
            }
          }
          const tail = Buffer.concat([carry, chunk.subarray(0, n)])
          carry = overlap > 0 ? Buffer.from(tail.subarray(Math.max(0, tail.length - overlap))) : Buffer.alloc(0)
          if (n < SCAN_CHUNK_BYTES) break
        }
      } finally {
        closeSync(fd)
      }
      for (const s of foundWhole) foundWindow.delete(s)
      scan.whole += foundWhole.size
      scan.windows += foundWindow.size
    }
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (excluded(p)) continue
        const st = lstatSync(p)
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) {
          walk(p)
          continue
        }
        if (!st.isFile()) continue
        if (opts.include !== undefined && !opts.include(p)) continue
        scanFile(p)
      }
    }
    try {
      for (const root of roots) {
        if (excluded(root)) continue
        let st
        try {
          st = lstatSync(root)
        } catch {
          continue
        }
        if (st.isDirectory()) walk(root)
      }
    } catch {
      scan.whole = -1
    }
    return scan
  }
}

/**
 * A relay address is private (and therefore a secret) when it names this machine's own network: loopback,
 * 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc/fd ULA, fe80 link-local, localhost or a .local name,
 * or any address holding LAN_IP. A public relay is shipped in the apps' bootstrap and is never a secret.
 */
export function relayIsPrivate (addr: string, lanIp?: string): boolean {
  if (lanIp !== undefined && lanIp.length > 0 && addr.includes(lanIp)) return true
  return /\/ip4\/(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)/.test(addr) ||
    /\/ip6\/(?:::1(?:\/|$)|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(addr) ||
    /\/dns[46]?\/(?:localhost|[^/]*\.local)(?:\/|$)/i.test(addr)
}

function envLine (text: string, name: string): string | undefined {
  for (const line of text.split('\n')) {
    if (line.startsWith(name + '=')) {
      const v = line.slice(name.length + 1).trim()
      return v.length > 0 ? v : undefined
    }
  }
  return undefined
}

/**
 * Registers what the relay.env reveals: LAN_IP always; the multiaddr, its /p2p/<id> peer id and PEER_ID
 * only when the relay is private. Returns the privacy verdict alone.
 */
export function registerRelay (registry: SecretRegistry, relayEnvPath: string, multiaddr: string): { private: boolean } {
  let text = ''
  try {
    text = readFileSync(relayEnvPath, 'utf8')
  } catch {
    text = ''
  }
  const lanIp = envLine(text, 'LAN_IP')
  const peerId = envLine(text, 'PEER_ID')
  if (lanIp !== undefined) registry.register(lanIp)
  const isPrivate = relayIsPrivate(multiaddr, lanIp)
  if (isPrivate) {
    registry.register(multiaddr)
    const m = /\/p2p\/([^/]+)/.exec(multiaddr)
    if (m?.[1] !== undefined) registry.register(m[1])
    if (peerId !== undefined) registry.register(peerId)
  }
  return { private: isPrivate }
}

export interface LineMaskerOptions {
  registry: SecretRegistry
  /** The run's absolute --state dir, replaced by `<run>`. */
  stateDir: string
}

/** registry.mask, then scrubWall, then the 67-12 redact (hex64, peer ids, LAN ips, the state dir as `<run>`, the home dir). */
export function createLineMasker (opts: LineMaskerOptions): (text: string) => string {
  const paths: ReadonlyArray<readonly [string, string]> = opts.stateDir.length > 1 ? [[opts.stateDir, '<run>']] : []
  return (text) => redact(scrubWall(opts.registry.mask(text)), undefined, { paths })
}
