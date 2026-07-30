/**
 * app-identity.ts — the injected "which app is this?" pin (CR-04 / WR-03).
 *
 * Both halves of the device attestation (the Play Integrity token and the
 * Android Keystore key attestation) prove properties of "some genuine Play app
 * on a genuine device answering this challenge" — but NOT that the app is
 * *ours* unless the package name and signing-certificate digest are pinned. A
 * relay/confused-deputy app that mints an integrity token carrying the bound
 * nonce would otherwise pass. `ExpectedAppIdentity` is the injected allowlist
 * both verifiers enforce, closing the D-06/D-09 anti-relay gap.
 *
 * Digests are normalized to lowercase-hex of the raw 32-byte SHA-256 so the
 * two halves — which carry the SAME underlying digest in DIFFERENT encodings
 * (Play Integrity: URL-safe/standard base64 string; key attestation:
 * `attestationApplicationId` raw OCTET STRING bytes) — compare consistently.
 */

// `Buffer` is NOT a Hermes global (see ../../utils.ts) — import it from the `buffer`
// module, which metro.config.js aliases and both apps declare as a dependency.
import { Buffer } from 'buffer'

export interface ExpectedAppIdentity {
  /** The app package name both attestation halves must be pinned to (e.g. 'org.votetorrent.authority'). */
  packageName: string
  /**
   * Allowed signing-certificate SHA-256 digests, as lowercase-hex of the raw
   * 32-byte digest. A token/attestation passes if ANY of its carried digests
   * matches one of these (an app may be signed by more than one key over time).
   */
  certificateSha256Digests: readonly string[]
}

/** Lowercase-hex of a raw digest byte array (the key attestation half's shape). */
export function certDigestBytesToHex (bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex').toLowerCase()
}

/**
 * Lowercase-hex of a base64/base64url-encoded digest string (the Play Integrity
 * half's shape). Accepts either alphabet, padded or not.
 */
export function certDigestBase64ToHex (value: string): string {
  const standard = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(standard, 'base64').toString('hex').toLowerCase()
}
