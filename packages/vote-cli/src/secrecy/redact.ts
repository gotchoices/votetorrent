// Secret registry and redaction, ported from the lean rig (main driver secret/redact and the host-voter
// variant). There is NO module-level registry: colocated peers in one process each hold their own
// SecretRegistry, so one peer's secrets can never leak through another peer's redactor.
//
// redact order: whole secrets -> <secret>; 16-char windows of a windowed secret (overlapping windows merge
// into ONE <secret>); 64-hex runs -> <hex64>; peer ids -> <peer:XXXXXXXX> (last 8); private LAN IPv4 ->
// <lan>; registered paths -> their labels (longest first); the home dir -> <home>.

import { homedir } from 'node:os'

export const PEER_RE = /12D3Koo[1-9A-HJ-NP-Za-km-z]{30,}/g
export const LAN_RE = /\b(?:10\.\d+|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+\b/g

const HEX64_RE = /[0-9a-fA-F]{64}/g
const WINDOW = 16

export interface RedactOptions {
  /** [absolutePath, label] pairs, e.g. [runDir, '<runs>']. The longest path is replaced first. */
  paths?: ReadonlyArray<readonly [string, string]>
  /** The home dir to replace with <home>; defaults to os.homedir(). */
  home?: string
}

/** The last 8 characters of an id (the rig's tail8 without the ellipsis). */
export function last8(id: string): string {
  return id.slice(-8)
}

export class SecretRegistry {
  // value -> windowed
  readonly #secrets = new Map<string, boolean>()
  readonly #windows = new Set<string>()

  /**
   * Registers a secret value and returns it unchanged. Non-strings register nothing; strings shorter than
   * 8 characters register nothing. With { windows: true } and length >= 16, every 16-char window is also
   * registered so a partial copy of the value is masked too.
   */
  add(value: unknown, opts?: { windows?: boolean }): string {
    if (typeof value !== 'string') return String(value)
    if (value.length < 8) return value
    const windowed = opts?.windows === true || this.#secrets.get(value) === true
    this.#secrets.set(value, windowed)
    if (opts?.windows === true && value.length >= WINDOW) {
      for (let i = 0; i + WINDOW <= value.length; i++) this.#windows.add(value.slice(i, i + WINDOW))
    }
    return value
  }

  get size(): number {
    return this.#secrets.size
  }

  entries(): IterableIterator<[string, boolean]> {
    return this.#secrets.entries()
  }

  hasWindow(s: string): boolean {
    return this.#windows.has(s)
  }

  get windowCount(): number {
    return this.#windows.size
  }

  /** A redactor bound to this registry. */
  redactor(opts?: RedactOptions): (text: string) => string {
    return (text) => redact(text, this, opts)
  }
}

function maskWindows(out: string, registry: SecretRegistry): string {
  if (registry.windowCount === 0 || out.length < WINDOW) return out
  const mask = new Uint8Array(out.length)
  let any = false
  for (let i = 0; i + WINDOW <= out.length; i++) {
    if (registry.hasWindow(out.slice(i, i + WINDOW))) {
      any = true
      mask.fill(1, i, i + WINDOW)
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

export function redact(text: unknown, registry?: SecretRegistry, opts?: RedactOptions): string {
  let out = String(text)
  if (registry !== undefined) {
    for (const [k] of registry.entries()) if (out.includes(k)) out = out.split(k).join('<secret>')
    out = maskWindows(out, registry)
  }
  out = out.replace(HEX64_RE, '<hex64>')
  out = out.replace(PEER_RE, (m) => `<peer:${last8(m)}>`)
  out = out.replace(LAN_RE, '<lan>')
  const paths = [...(opts?.paths ?? [])]
    .filter(([p]) => p.length > 1)
    .sort((a, b) => b[0].length - a[0].length)
  for (const [p, label] of paths) out = out.split(p).join(label)
  const home = opts?.home ?? homedir()
  if (home.length > 1) out = out.split(home).join('<home>')
  return out
}
