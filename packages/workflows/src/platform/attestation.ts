/**
 * attestation.ts: the device-side attestation PRODUCER seam (the D-11 two-step shape), moved here
 * from `apps/VoteTorrentVoter/src/engines/attestation-producer.ts`, which now re-exports it.
 *
 * The producer exposes public keys and signatures only. No member returns private key bytes: the
 * device key stays on the implementing side (hardware keystore, Secure Enclave, or the CLI's signer).
 *
 * `SignDeviceKeyDigestOptions` is copied verbatim from the native producer; the Voter parity test pins
 * the equality.
 */

import type { AttestationChallenge, DeviceAttestation, Signature } from '@votetorrent/vote-core'
import type { SecretWrapPrompt } from './secret-wrap.js'

/** Optional arguments to `signDeviceKeyDigest`. */
export interface SignDeviceKeyDigestOptions {
  /** Biometric prompt copy. Used whole or rejected; never merged with the defaults. */
  prompt?: SecretWrapPrompt
  /**
   * Abandons the sign before it reaches the signing backend. Checked right before the sign and after
   * every await the method makes, so an abort that lands while a lookup is pending never raises a
   * prompt. An already-aborted signal rejects with an `AbortError` whose `code` is `ABORTED`, and
   * nothing is signed.
   */
  signal?: AbortSignal
}

/**
 * A device-side attestation producer (D-11 two-step seam):
 *   (1) `provisionDeviceKey()` returns the hardware-backed P-256 public key BEFORE the challenge
 *       is issued;
 *   (2) `produce(challenge)` answers an already-issued challenge bound to that key.
 *
 * Three contracts:
 *   - `provisionDeviceKey` is for CREATION flows only. On Android it mints a NEW key on every call,
 *     so a lookup must never use it.
 *   - `getCurrentDeviceKey` is a READ-ONLY lookup of the current device key: it never generates,
 *     rotates or prompts. Every lookup (association queries, registration status, continuity) uses
 *     it. It rejects with code `DEVICE_KEY_ABSENT` or `DEVICE_KEY_INVALIDATED`.
 *   - `signDeviceKeyDigest` signs an arbitrary digest under the SAME key `provisionDeviceKey()`
 *     returned, for the voter's self-signed association-request submissions (D-02/D-18), and never
 *     for anything an officer ceremony verifies. It is declared OPTIONAL so a fixture that only
 *     provisions and produces stays valid, but a caller treats its absence as "cannot self-sign",
 *     never as a silent skip.
 */
export interface AttestationProducer {
  provisionDeviceKey(): Promise<{ publicKey: string }>
  getCurrentDeviceKey(): Promise<{ publicKey: string }>
  produce(challenge: AttestationChallenge): Promise<DeviceAttestation>
  signDeviceKeyDigest?(digest: Uint8Array, options?: SignDeviceKeyDigestOptions): Promise<Signature>
}

/**
 * An `AttestationProducer` whose `signDeviceKeyDigest` is statically present. Vote signing has no
 * "cannot sign" branch, so the vote-signing resolver returns this type.
 */
export type VoteSigningProducer = AttestationProducer & {
  signDeviceKeyDigest(digest: Uint8Array, options?: SignDeviceKeyDigestOptions): Promise<Signature>
}
