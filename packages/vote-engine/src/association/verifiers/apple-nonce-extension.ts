/**
 * apple-nonce-extension.ts — the credCert nonce extension Apple's App Attest attestation carries
 * (Phase 51, ATTESTATION-CONTRACT-IOS.md §2).
 *
 * This is the ONE place the extension's OID and DER shape are defined. The production verifier
 * decodes with `decodeAppleNonceExtension`; the synthetic test CA encodes with
 * `encodeAppleNonceExtension` by importing from here. A fixture carrying its own copy could drift
 * into agreeing with itself while disagreeing with production — the failure mode would be a test
 * suite that passes against a verifier that rejects every real attestation.
 *
 * Structure (Apple's step 4):
 *
 *     SEQUENCE {
 *       [1] {
 *         OCTET STRING nonce   -- SHA256(authenticatorData || clientDataHash)
 *       }
 *     }
 *
 * Hand-rolled rather than pulled from an ASN.1 schema package because the structure is fixed and
 * tiny, and because writing it out makes the one thing a verifier must not get wrong — that the
 * nonce sits inside a context-tag-1 wrapper, not at the top of the SEQUENCE — explicit.
 */

/** Apple's App Attest nonce extension. The credCert carries the nonce here and NOWHERE else. */
export const APPLE_NONCE_OID = '1.2.840.113635.100.8.2'

/** DER-encode `SEQUENCE { [1] { OCTET STRING nonce } }`. */
export function encodeAppleNonceExtension (nonce: Uint8Array): Uint8Array {
  if (nonce.length > 127) {
    // Short-form DER lengths only; an App Attest nonce is always a 32-byte SHA-256 digest, so a
    // longer value means the caller built something else entirely.
    throw new Error(`nonce extension: nonce is ${nonce.length} bytes, expected <= 127`)
  }
  const octet = [0x04, nonce.length, ...nonce]
  const ctx1 = [0xa1, octet.length, ...octet]
  const seq = [0x30, ctx1.length, ...ctx1]
  return new Uint8Array(seq)
}

/**
 * Decode the above, returning the nonce octets.
 *
 * Throws with a specific reason rather than returning a sentinel — every caller in this package
 * wraps it and converts the message into a structured `{ ok: false, reason }`, matching the
 * shipped verifiers' "never let a parse exception escape" discipline.
 */
export function decodeAppleNonceExtension (der: Uint8Array): Uint8Array {
  if (der.length < 6) throw new Error(`nonce extension: too short (${der.length} bytes)`)
  if (der[0] !== 0x30) throw new Error('nonce extension: outer element is not a SEQUENCE')
  if (der[2] !== 0xa1) throw new Error('nonce extension: expected context tag [1] inside the SEQUENCE')
  if (der[4] !== 0x04) throw new Error('nonce extension: expected an OCTET STRING inside [1]')
  const len = der[5]!
  if (6 + len > der.length) throw new Error('nonce extension: OCTET STRING runs past the buffer')
  return der.subarray(6, 6 + len)
}
