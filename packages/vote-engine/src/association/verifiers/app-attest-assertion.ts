/**
 * app-attest-assertion.ts — the cross-sign half of the iOS contract, ATTESTATION-CONTRACT-IOS.md
 * §3/§4 (Phase 51).
 *
 * `app-attest.ts` verifies the ATTESTATION half. This verifies the two things that actually bind the
 * voting key to that attestation:
 *   §3 the App Attest ASSERTION by K_att over ASSERTION_DIGEST  — "this attested app nominates K_vote"
 *   §4 a proof-of-possession signature by K_vote                — "and we hold K_vote's private key"
 *
 * Same discipline as the shipped verifiers: PINNED/expected values are INJECTED, every failure is a
 * structured `{ ok, reason }`, nothing throws for adversarial input, and no network is touched.
 *
 * CRITICAL: ASSERTION_DIGEST and POP_DIGEST are RECOMPUTED here from the challenge and the
 * submitted vote key. They are NEVER read from the submission — a verifier that trusts a submitted
 * digest verifies nothing at all.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { p256 } from '@noble/curves/nist.js'
import { digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'
import { cborDecode } from '@votetorrent/vote-core'
import { recomputeChallengeDigest } from './digest-binding.js'

const hasher = resolveHasher('sha256')
const encode = resolveOutputEncoder('base64url')

/** §3.1 domain-separated assertion digest. Field order and tags are contract-locked. */
export function computeAssertionDigest (boundDigest: string, voteKeyCompressedHex: string): string {
  return digestFields(['votetorrent/ios-assertion/v1', boundDigest, voteKeyCompressedHex], hasher, encode) as string
}

/** §4 domain-separated proof-of-possession digest. */
export function computePopDigest (boundDigest: string): string {
  return digestFields(['votetorrent/ios-pop/v1', boundDigest], hasher, encode) as string
}

const sha256 = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return new Uint8Array(h.digest())
}
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

// NOTE: no `Buffer` here — see the same note in `verifiers/app-attest.ts` (CR-01). `Buffer` is
// not a Hermes global and is not imported by this module; `timingSafeEqual` takes any
// ArrayBufferView on Node and indexes `a[i]` in the RN shim, so `Uint8Array` works on both.
function bytesEqual (a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function hexToBytes (hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export interface CrossSignVerification { ok: boolean; reason?: string; counter?: number }

export interface CrossSignExpectations {
  /** `<teamId>.<bundleId>` */
  appId: string
  /** The challenge this ceremony answers. */
  challengeNonce: string
  /** `challenge.deviceKey` — K_vote, compressed SEC1 hex. */
  deviceKey: string
  /** K_att's public key, raw uncompressed X9.62 (0x04‖X‖Y), taken from the credCert in §2. */
  appAttestPublicKeyRaw: Uint8Array
  /** Highest counter previously stored for this appAttestKeyId, or undefined at association time. */
  previousCounter?: number
}

/**
 * Verify the §3 assertion and the §4 possession signature.
 *
 * @param assertionCbor  CBOR `{ signature, authenticatorData }` from `generateAssertion`.
 * @param popSignatureHex 64-byte compact low-S `r‖s` hex from `signWithDeviceKey`.
 */
export function verifyCrossSign (
  assertionCbor: Uint8Array,
  popSignatureHex: string,
  expect: CrossSignExpectations
): CrossSignVerification {
  try {
    // ---- recompute both digests; never trust submitted ones ----
    const boundDigest = recomputeChallengeDigest(expect.challengeNonce, expect.deviceKey)
    const assertionDigest = computeAssertionDigest(boundDigest, expect.deviceKey)
    const popDigest = computePopDigest(boundDigest)

    // ---- §8.7 decode ----
    const decoded = cborDecode(assertionCbor)
    if (!(decoded instanceof Map)) return { ok: false, reason: 'assertion is not a CBOR map' }
    const signature = decoded.get('signature')
    const authenticatorData = decoded.get('authenticatorData')
    if (!(signature instanceof Uint8Array)) return { ok: false, reason: 'assertion.signature is not a byte string' }
    if (!(authenticatorData instanceof Uint8Array)) return { ok: false, reason: 'assertion.authenticatorData is not a byte string' }
    if (authenticatorData.length < 37) return { ok: false, reason: `assertion authenticatorData too short (${authenticatorData.length} bytes)` }

    // ---- §8.8 rpIdHash ----
    const rpIdHash = authenticatorData.subarray(0, 32)
    if (!bytesEqual(rpIdHash, sha256(utf8(expect.appId)))) {
      return { ok: false, reason: 'assertion rpIdHash does not equal SHA256(appId) — assertion is for a different app' }
    }

    // ---- §8.10 counter, strictly increasing ----
    const counter = (authenticatorData[33]! << 24 >>> 0) + (authenticatorData[34]! << 16) +
      (authenticatorData[35]! << 8) + authenticatorData[36]!
    const floor = expect.previousCounter ?? 0
    if (counter <= floor) {
      return { ok: false, reason: `assertion counter ${counter} is not greater than the last seen counter ${floor} — replay` }
    }

    // ---- §8.9 assertion signature ----
    //
    // nonce = SHA256(authenticatorData || clientDataHash), and the signature is a standard
    // ECDSA-SHA256 signature OVER THAT NONCE — i.e. the signed digest is SHA256(nonce), a SECOND
    // hash. Hence `prehash: true` here, passing the nonce as the message.
    //
    // This cost a real bug. The first implementation passed the nonce with `prehash: false`,
    // treating it as the final digest, and every synthetic test passed — because the test fixture
    // *generated* signatures the same wrong way. A self-consistent fixture cannot catch a
    // misunderstanding it shares with the code. It was caught only when a REAL assertion from a
    // real iPhone (spike 085, run 2) failed to verify, and a four-way construction trial
    // (`diag-assertion.ts`) settled which message Apple actually signs. Do not "simplify" this back.
    const clientDataHash = sha256(utf8(assertionDigest))
    const assertionNonce = sha256(authenticatorData, clientDataHash)
    // Apple returns the assertion signature in DER. K_att's key is P-256.
    let assertionOk: boolean
    try {
      assertionOk = p256.verify(signature, assertionNonce, expect.appAttestPublicKeyRaw, {
        prehash: true, format: 'der', lowS: false
      })
    } catch {
      assertionOk = false
    }
    if (!assertionOk) {
      return { ok: false, reason: 'assertion signature does not verify over SHA256(authenticatorData || SHA256(utf8(ASSERTION_DIGEST))) under the attested App Attest key — K_vote is not bound to this attestation' }
    }

    // ---- §8.11 proof of possession of K_vote ----
    let popOk: boolean
    try {
      popOk = p256.verify(hexToBytes(popSignatureHex), sha256(utf8(popDigest)), hexToBytes(expect.deviceKey), {
        prehash: false, format: 'compact', lowS: true
      })
    } catch {
      popOk = false
    }
    if (!popOk) {
      return { ok: false, reason: 'proof-of-possession signature does not verify against challenge.deviceKey — the device does not hold K_vote' }
    }

    return { ok: true, counter }
  } catch (e) {
    return { ok: false, reason: `cross-sign verification failed: ${(e as Error).message}` }
  }
}
