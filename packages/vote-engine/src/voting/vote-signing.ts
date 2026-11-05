// vote-signing.ts — phase 63 plan 02: lifted verbatim from spike 097.
//
// Role:
//   - D-26: the voter entry's `deviceKey` is `p256KeyToCompressedHex(currentKey)`, the 66-char
//     compressed hex that `verifySigP256` and SQL `SignatureValidP256` can decode.
//   - D-07: `checkVotingKey` runs before any signature and refuses `device-key-rotated` and
//     `unreadable-key`.
//
// Why it exists (measured in spike 097):
//   - Android's `provisionDeviceKey()` resolves `publicKeyBase64`, an X.509 SubjectPublicKeyInfo DER
//     in base64. `verifySigP256` decodes the key as HEX, so it can never verify against that form.
//   - Android's `produceAttestation` deletes and regenerates the key under the alias (D-13), so the
//     key that signs later can differ from the one the Association recorded.
//
// Purity: no node-builtin import, no byte-buffer global, no console, no text-decoder. Base64 goes
// through the global `atob`, which Hermes and Node 22 both provide.

import { p256 } from '@noble/curves/nist.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'

// The fixed 26-byte DER prefix of a P-256 SPKI with an UNCOMPRESSED point:
// SEQUENCE(89) { SEQUENCE(19) { OID ecPublicKey, OID prime256v1 }, BIT STRING(66) 00 04|X|Y }
const P256_SPKI_PREFIX_HEX = '3059301306072a8648ce3d020106082a8648ce3d030107034200'

function base64ToBytes (s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Any P-256 public key form this codebase stores -> 33-byte compressed SEC1 hex (66 chars), the
 * form `verifySigP256` and `UserKey.PubKey` use. Accepts: compressed hex (iOS, UserKey),
 * uncompressed hex (65 bytes), SPKI DER base64 (Android `publicKeyBase64`). Throws on anything
 * else, and on a point that is not on the curve.
 */
export function p256KeyToCompressedHex (key: string): string {
  let point: Uint8Array
  if (/^(02|03)[0-9a-fA-F]{64}$/.test(key) || /^04[0-9a-fA-F]{128}$/.test(key)) {
    point = hexToBytes(key.toLowerCase())
  } else {
    let der: Uint8Array
    try { der = base64ToBytes(key) } catch { throw new Error('p256KeyToCompressedHex: not hex and not base64') }
    if (der.length !== 91 || bytesToHex(der.subarray(0, 26)) !== P256_SPKI_PREFIX_HEX) {
      throw new Error('p256KeyToCompressedHex: not a P-256 SubjectPublicKeyInfo with an uncompressed point')
    }
    point = der.subarray(26)
  }
  return p256.Point.fromBytes(point).toHex(true) // fromBytes validates the point is on the curve
}

export type VotingKeyCheck =
  | { ok: true, compressedKey: string }
  | { ok: false, reason: 'device-key-rotated' | 'unreadable-key' }

/**
 * The key currently under the device alias must be the key the Association names, compared in ONE
 * canonical form. Never compare raw strings: Android hands back SPKI base64, other paths hand back
 * compressed hex, and a raw compare would read "rotated" for the same key.
 */
export function checkVotingKey (currentDeviceKey: string, associationDeviceKey: string): VotingKeyCheck {
  let current: string, recorded: string
  try {
    current = p256KeyToCompressedHex(currentDeviceKey)
    recorded = p256KeyToCompressedHex(associationDeviceKey)
  } catch {
    return { ok: false, reason: 'unreadable-key' }
  }
  return current === recorded ? { ok: true, compressedKey: recorded } : { ok: false, reason: 'device-key-rotated' }
}
