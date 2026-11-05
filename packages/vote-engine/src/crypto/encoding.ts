// src/crypto/encoding.ts — shared wire-format helpers for the crypto module.
//
// Phase 62 Plan 04 (D-03/D-04/D-18/D-25). Module-private-to-crypto helpers:
// exported for SIBLING crypto modules (`envelope.ts`, `block-cipher.ts`)
// only, and deliberately NEVER re-exported by `src/crypto/index.ts` — see
// that barrel's header for why.
//
// Purity rules, copied from `src/bootstrap/sealed-payload.ts` (do not
// import that module; the idiom is copied, not shared, because this module
// lives under a different purity boundary):
//   - no `node:` import, no `../` import, no `console`, no `TextDecoder`;
//   - no reference to Node's byte-buffer type, even in a comment — write
//     "Node's byte-buffer type" the way `sealed-payload.ts` does;
//   - allowed imports are only `@noble/curves/secp256k1.js`,
//     `@noble/hashes/hkdf.js`, `@noble/hashes/sha2.js`,
//     `@noble/hashes/utils.js`, `@noble/ciphers/aes.js`,
//     `@noble/ciphers/utils.js`, and relative `./*.js` within `src/crypto/`.
//
// `doc/encryption-formats.md` section 1 is the normative conventions
// reference every helper below implements: 66-char lowercase compressed-hex
// public keys, raw 32-byte secret keys (never a string), unpadded base64url
// for nonces/tags/ciphertexts, and the length-prefixed AAD encoding whose
// first field is always the domain label.

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'

/** Unpadded base64url, the only encoding this module reads or writes. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/

/** Encode bytes as unpadded base64url. */
export function bytesToBase64url (bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode unpadded base64url. Never throws, never coerces — anything outside
 * the URL alphabet (or anything not a string at all) becomes a structural
 * `null` rather than whatever `atob` happens to do with it.
 */
export function base64urlToBytes (value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return null
  let b64 = value.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) b64 += '='
  let binary: string
  try {
    binary = atob(b64)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Decode lowercase hex to exactly `expectedBytes` bytes. Never throws, and
 * never accepts uppercase — the `<interfaces>` convention is lowercase hex
 * only, so accepting uppercase here would make `isCompressedPublicKeyHex`
 * inconsistent with the wire format it validates.
 */
export function hexToBytesStrict (value: unknown, expectedBytes: number): Uint8Array | null {
  if (typeof value !== 'string') return null
  if (value.length !== expectedBytes * 2) return null
  if (!/^[0-9a-f]*$/.test(value)) return null
  const bytes = new Uint8Array(expectedBytes)
  for (let i = 0; i < expectedBytes; i++) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Length-prefixed encoding for multi-field AAD (`doc/encryption-formats.md`
 * section 1): for each field in order, a 4-byte big-endian uint32 byte
 * length then the field's UTF-8 bytes. The first field is always the domain
 * label, which is what makes a content AAD structurally unable to collide
 * with a wrap AAD even if a label were a prefix of another field's bytes.
 */
export function encodeLengthPrefixed (fields: readonly string[]): Uint8Array {
  const encodedFields = fields.map((field) => utf8ToBytes(field))
  let total = 0
  for (const bytes of encodedFields) total += 4 + bytes.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const bytes of encodedFields) {
    out[offset] = (bytes.length >>> 24) & 0xff
    out[offset + 1] = (bytes.length >>> 16) & 0xff
    out[offset + 2] = (bytes.length >>> 8) & 0xff
    out[offset + 3] = bytes.length & 0xff
    offset += 4
    out.set(bytes, offset)
    offset += bytes.length
  }
  return out
}

/** `^0[23][0-9a-f]{64}$` combined with an actual on-curve / subgroup check. */
const COMPRESSED_PUBLIC_KEY_HEX_PATTERN = /^0[23][0-9a-f]{64}$/

/**
 * True iff `value` is a 66-character lowercase compressed secp256k1 public
 * key hex AND decodes to a valid point on the curve. The regex alone cannot
 * catch an off-curve point with a syntactically valid prefix/length.
 */
export function isCompressedPublicKeyHex (value: unknown): boolean {
  if (typeof value !== 'string' || !COMPRESSED_PUBLIC_KEY_HEX_PATTERN.test(value)) return false
  const bytes = hexToBytesStrict(value, 33)
  if (bytes === null) return false
  return secp256k1.utils.isValidPublicKey(bytes, true)
}

/**
 * ECDH input keying material: the 32-byte x-coordinate of the shared point
 * (SEC 1 v2.0 section 3.3.1). `getSharedSecret(sk, pub, true)` returns 33
 * compressed bytes; byte 0 is the point's y-parity prefix, so bytes 1..32
 * are the x-coordinate this function returns. This deliberately differs
 * from a raw 33-byte shared-secret convention — it matches OpenSSL's
 * `computeSecret` and the standard.
 */
export function ecdhX (secretKey: Uint8Array, publicKeyBytes: Uint8Array): Uint8Array {
  return secp256k1.getSharedSecret(secretKey, publicKeyBytes, true).slice(1)
}
