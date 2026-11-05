/**
 * association-request-digest.ts — pure, SQL-free recomputation of the two digest tuples a
 * requester's device signs during the D-02/D-18 association ceremony.
 *
 * WHY THIS EXISTS (CR-03, 51-REVIEW). `RestAssociationTransport` asks the remote endpoint for
 * the digest and then signs it with the device's HARDWARE key. Its handshake echo checks
 * (`submittedAt` on leg 1, `requestId`/`nonce` on leg 2) only prove the endpoint echoed values
 * out of the very request body it was just handed — they say nothing whatsoever about the
 * digest beside them. Without a LOCAL recomputation, a hostile or MITM'd endpoint chooses all
 * 32 bytes the Secure Enclave / StrongBox signs, and the resulting signature can be replayed
 * against any row whose digest tuple the attacker can precompute. These functions are what the
 * binding compares the handshake's answer against before it signs anything.
 *
 * PARITY, NOT A FORK. This is NOT an independent reimplementation of `Digest()`. It calls the
 * SAME `digestFields` primitive the SQL `Digest()` UDF is built from, with the SAME
 * `{ algorithm: 'sha256', encoding: 'base64url' }` configuration
 * `database/initialize.ts:154` registers the crypto plugin with — the established precedent is
 * `verifiers/digest-binding.ts`, whose header states the rule ("Do NOT hand-roll
 * `sha256(nonce + deviceKey)` string concatenation here"). `association-request-digest.spec.ts`
 * asserts byte-for-byte equality with a live `select Digest(...)` for both tuples, including
 * the NULL positions, so a plugin-side encoding change cannot silently desynchronise them.
 *
 * FIELD ORDERS ARE LOAD-BEARING — they mirror, field for field:
 *   leg 1  `AssociationEngine.submitAssociationRequest`
 *          (`select Digest(:id, :rowAuthorityId, :registrantId, :deviceKey, :electionId, :submittedAt)`)
 *          = `AssociationRequest.SignatureValid`, `votetorrent.qsql` (51-01's landed tuple)
 *   leg 2  `AssociationEngine.validateStagedAttestationAnswer`
 *          (`select Digest(:requestId, :nonce, :attestationJson, :deviceHash)`)
 *          — engine-side only; no schema CHECK stands behind leg 2 (T-51-08-06).
 * `scripts/device-proof/association-rest-bridge.mjs` serves exactly these two tuples through
 * the real SQL `Digest()` oracle, so the D-17 hardware ceremony keeps working unchanged.
 *
 * NULL, NOT EMPTY STRING. `electionId` and `deviceHash` are optional. The engine and the bridge
 * both bind `?? null`, and the canonical field encoding is injective over NULL vs `''` — so a
 * missing value MUST be passed through as `null`/`undefined` (both encode to the NULL tag),
 * never coerced to `''`.
 */
import type { AssociationAttestationAnswer, AssociationRequestInit } from '@votetorrent/vote-core'
import { digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'

const hasher = resolveHasher('sha256')
const encode = resolveOutputEncoder('base64url')

/**
 * Leg 1: `Digest(Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, SubmittedAt)`.
 *
 * `requesterKey` — not `init.deviceKey` — occupies the `DeviceKey` position, because that is
 * what the engine binds (`const deviceKey = requesterKey`). The engine additionally guards that
 * the two agree; callers of this function should make the same check so a caller who bound them
 * independently gets an attributable error rather than a digest mismatch.
 */
export function computeAssociationRequestDigest (init: AssociationRequestInit, requesterKey: string): string {
  return digestFields(
    [init.id, init.authorityId, init.registrantId, requesterKey, init.electionId ?? null, init.submittedAt],
    hasher,
    encode
  ) as string
}

/**
 * Leg 2: `Digest(RequestId, Nonce, AttestationJson, DeviceHash)` where
 * `AttestationJson = JSON.stringify(answer.attestation)`.
 *
 * The `JSON.stringify` call is part of the tuple, not an implementation detail: object key
 * ORDER is a digest input, so every party reproducing this digest must serialize the SAME
 * object with the SAME call — which is exactly what `validateStagedAttestationAnswer`'s doc
 * comment requires of "any party (including 51-06's transport bindings)".
 */
export function computeAssociationAttestationDigest (answer: AssociationAttestationAnswer): string {
  return digestFields(
    [answer.requestId, answer.nonce, JSON.stringify(answer.attestation), answer.deviceHash ?? null],
    hasher,
    encode
  ) as string
}
