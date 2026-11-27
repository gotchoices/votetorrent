/**
 * cbor.ts — minimal CBOR encoder/decoder covering EXACTLY the subset App Attest uses.
 *
 * Deliberately dependency-free. `packages/vote-engine` ships NO CBOR library, and adding one is a
 * real cost on this project: any new dep must survive Metro/Hermes bundling (see the @peculiar
 * bundling wall, spike-findings P44). This file measures how much CBOR is actually needed, so the
 * real build can decide between "vendor ~120 lines" and "take a dependency".
 *
 * Supported major types: 0 (uint), 1 (negint), 2 (byte string), 3 (text string), 4 (array),
 * 5 (map). Definite lengths only — App Attest emits no indefinite-length items.
 */

export type CborValue = number | string | Uint8Array | CborValue[] | Map<CborValue, CborValue>

// ---------------- decode ----------------
class Reader {
  offset = 0
  constructor (readonly buf: Uint8Array) {}
  u8 (): number {
    if (this.offset >= this.buf.length) throw new Error('CBOR: truncated')
    return this.buf[this.offset++]!
  }
  bytes (n: number): Uint8Array {
    if (this.offset + n > this.buf.length) throw new Error('CBOR: truncated byte run')
    const out = this.buf.subarray(this.offset, this.offset + n)
    this.offset += n
    return out
  }
  uint (ai: number): number {
    if (ai < 24) return ai
    if (ai === 24) return this.u8()
    if (ai === 25) return (this.u8() << 8) | this.u8()
    if (ai === 26) return ((this.u8() << 24) >>> 0) + (this.u8() << 16) + (this.u8() << 8) + this.u8()
    if (ai === 27) {
      // 64-bit: App Attest never exceeds 2^53 here; reject anything that would lose precision.
      let v = 0
      for (let i = 0; i < 8; i++) v = v * 256 + this.u8()
      if (!Number.isSafeInteger(v)) throw new Error('CBOR: 64-bit value exceeds safe integer range')
      return v
    }
    throw new Error(`CBOR: unsupported additional info ${ai}`)
  }
}

/**
 * Resource bounds on attacker-controlled input (T-51-09, phase 51 retroactive-STRIDE audit).
 *
 * This decoder parses bytes an untrusted device submits, so both limits below are security controls,
 * not tidiness. The vector is NESTING, not length: `0x81` ("array of 1") is a single byte, so an
 * N-byte payload of them recurses N deep and exhausts the stack. A declared-but-absent length is
 * already self-limiting — the Reader throws `truncated` as soon as it runs past the end — so it is
 * depth, plus a ceiling on how much we agree to look at, that need stating.
 *
 * Both are far above anything real: App Attest nests ~4 deep, and a genuine attestation object
 * measured 5,873 bytes on an iPhone 13.
 */
export const CBOR_MAX_NESTING_DEPTH = 32
export const CBOR_MAX_INPUT_BYTES = 1 << 20 // 1 MiB

function decodeItem (r: Reader, depth: number): CborValue {
  // Checked on ENTRY to each nested item, so the limit is reached before the next stack frame is
  // pushed rather than after — the throw must not itself be the thing that overflows.
  if (depth > CBOR_MAX_NESTING_DEPTH) {
    throw new Error(`CBOR: nesting deeper than ${CBOR_MAX_NESTING_DEPTH}`)
  }
  const ib = r.u8()
  const major = ib >> 5
  const ai = ib & 0x1f
  switch (major) {
    case 0: return r.uint(ai)
    case 1: return -1 - r.uint(ai)
    case 2: return r.bytes(r.uint(ai))
    case 3: return new TextDecoder().decode(r.bytes(r.uint(ai)))
    case 4: {
      const n = r.uint(ai)
      const arr: CborValue[] = []
      for (let i = 0; i < n; i++) arr.push(decodeItem(r, depth + 1))
      return arr
    }
    case 5: {
      const n = r.uint(ai)
      const m = new Map<CborValue, CborValue>()
      for (let i = 0; i < n; i++) { const k = decodeItem(r, depth + 1); m.set(k, decodeItem(r, depth + 1)) }
      return m
    }
    default: throw new Error(`CBOR: unsupported major type ${major}`)
  }
}

export function cborDecode (buf: Uint8Array): CborValue {
  if (buf.length > CBOR_MAX_INPUT_BYTES) {
    throw new Error(`CBOR: input of ${buf.length} bytes exceeds the ${CBOR_MAX_INPUT_BYTES}-byte limit`)
  }
  const r = new Reader(buf)
  const v = decodeItem(r, 0)
  if (r.offset !== buf.length) throw new Error(`CBOR: ${buf.length - r.offset} trailing bytes`)
  return v
}

// ---------------- encode ----------------
function head (major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n]
  if (n < 0x100) return [(major << 5) | 24, n]
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff]
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

export function cborEncode (v: CborValue): Uint8Array {
  const out: number[] = []
  const enc = (x: CborValue): void => {
    if (typeof x === 'number') {
      if (x >= 0) out.push(...head(0, x))
      else out.push(...head(1, -1 - x))
    } else if (x instanceof Uint8Array) {
      out.push(...head(2, x.length), ...x)
    } else if (typeof x === 'string') {
      const b = new TextEncoder().encode(x)
      out.push(...head(3, b.length), ...b)
    } else if (Array.isArray(x)) {
      out.push(...head(4, x.length)); for (const i of x) enc(i)
    } else if (x instanceof Map) {
      out.push(...head(5, x.size)); for (const [k, val] of x) { enc(k); enc(val) }
    } else throw new Error('CBOR: unsupported value')
  }
  enc(v)
  return new Uint8Array(out)
}
