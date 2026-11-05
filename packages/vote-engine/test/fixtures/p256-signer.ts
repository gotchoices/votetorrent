// P-256 test signer fixture (49-01, Wave 0 scaffolding for D-02/D-03/D-04).
//
// This is the exact byte-level contract Kotlin's on-device signing path
// (SHA256withECDSA + DER->compact/low-S normalization, see
// `49-RESEARCH.md` Pattern 2/Pattern 3) must reproduce for a P-256 signature
// to verify against `@optimystic/quereus-plugin-crypto`'s `p256.verify()`
// the same way this fixture's signatures do:
//
//   1. `p256 = ecdsa(p256_Point, sha256)` — the SAME noble factory shape as
//      the already-proven `secp256k1` path (`nist.js`/`secp256k1.js`), so
//      `p256.sign()`/`p256.verify()` apply noble v2's default sig options
//      with NO options object passed: `{ prehash: true, lowS: true, format:
//      'compact' }`. `prehash: true` means the signed domain is
//      `sha256(rawDigestBytes)`, NOT `rawDigestBytes` directly — mirroring
//      the SAME double-hash convention `device-signer.ts`'s
//      `secp256k1.sign(digest, privBytes)` already relies on today (WR-10).
//   2. Public keys are the **33-byte compressed** SEC1 point (hex-encoded,
//      66 chars) — the same shape every `UserKey.PubKey` in this schema
//      stores. `p256.getPublicKey(privBytes)` returns this shape by
//      default (no `false` "uncompressed" flag passed).
//   3. Signatures are the **64-byte compact** `r||s` form (hex-encoded, 128
//      chars) — NOT DER. `p256.sign()` returns this shape by default
//      (`format: 'compact'`).
//
// A drift in ANY of these three defaults would silently invalidate the
// on-device claim this phase's later plans (49-02+) build on top of: this
// fixture is the reference implementation those plans' Kotlin work is
// measured against, so it is proven correct here (Task 1's active
// self-test, `signature-curve.spec.ts`) before anything downstream relies
// on it — see the threat register's T-49-DER entry.

import { p256 } from '@noble/curves/nist.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { digestToBytes } from '../../src/utils.js'

/**
 * Generate a fresh P-256 test keypair.
 *
 * `pubHex` is the 33-byte compressed SEC1 point, hex-encoded (66 chars) —
 * matching the `UserKey.PubKey` column shape exactly (see D-03's own
 * "compressed P-256 and secp256k1 public keys are both 33 bytes" reasoning,
 * and the fixture's header comment above).
 */
export function makeP256TestKey (): { privBytes: Uint8Array; pubHex: string } {
  const privBytes = p256.utils.randomSecretKey()
  const pubHex = bytesToHex(p256.getPublicKey(privBytes))
  return { privBytes, pubHex }
}

/**
 * Sign a base64url-encoded `Digest()` output with a P-256 private key,
 * producing a 64-byte compact, low-S signature (hex-encoded, 128 chars).
 *
 * Decodes `digestBase64url` to raw bytes via the engine's own
 * `digestToBytes` (the same decoder every other signing call site in this
 * repo uses — WR-01 single source of truth), then calls `p256.sign()` with
 * NO options object so noble v2's defaults apply (`prehash: true`,
 * `lowS: true`, `format: 'compact'`). See the file header for why these
 * defaults ARE the byte contract Kotlin's `SHA256withECDSA` +
 * `derToCompactLowS` must reproduce (RESEARCH Pattern 2/3) — a drift here
 * silently invalidates the on-device claim.
 */
export function signDigestP256 (digestBase64url: string, privBytes: Uint8Array): string {
  const rawDigestBytes = digestToBytes(digestBase64url)
  const sig = p256.sign(rawDigestBytes, privBytes)
  return bytesToHex(sig)
}
