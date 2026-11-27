// pool-codec.ts — base64url for pool messages. Pool code does not deep-import
// crypto/encoding.ts (that module is for the crypto siblings only); this is the same RFC 4648 §5
// alphabet, unpadded, Hermes-safe (no Buffer, no atob/btoa).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]))

export function toBase64url (bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!
  }
  return out
}

/** Strict: null for a non-string, a padded value, a foreign character or an impossible length. */
export function fromBase64url (text: unknown): Uint8Array | null {
  if (typeof text !== 'string' || text.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let bits = 0
  let value = 0
  let o = 0
  for (const ch of text) {
    const v = INDEX.get(ch)
    if (v === undefined) return null
    value = (value << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (value >> bits) & 0xff
    }
  }
  // Leftover bits must be zero, so every byte string has exactly one encoding.
  if ((value & ((1 << bits) - 1)) !== 0) return null
  return out.subarray(0, o)
}
