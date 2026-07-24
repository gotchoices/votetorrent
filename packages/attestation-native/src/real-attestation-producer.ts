/**
 * real-attestation-producer.ts — JS orchestration for the D-11 two-step attestation producer
 * (Phase 45-05). This is the JS half of the device-side attestation producer; all platform-API
 * calls (StrongBox/TEE/BiometricPrompt/Play Integrity) live in the 45-01/45-02 Kotlin
 * TurboModule (`./specs/NativeAttestation`) — this module owns the crypto-decision +
 * orchestration layer that must emit exactly the bytes Phase 43's shipped
 * `PlayIntegrityVerifier` consumes (`packages/vote-engine/ATTESTATION-CONTRACT.md`).
 *
 * IMPORTANT (testability): this file's TOP-LEVEL evaluation is kept pure — it does NOT import
 * the native TurboModule spec's default export at module scope, because
 * `TurboModuleRegistry.getEnforcing(...)` throws in any environment where the native module
 * isn't registered (Node/jest). The native module is accessed LAZILY (added in a follow-on
 * change alongside `createRealAttestationProducer`) so that merely importing this module — and
 * running `computeBoundDigest` + the D-16b probe below — works under Node/jest without the
 * native module present.
 */

import { digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'

// Resolved ONCE at module scope — must match packages/vote-engine/ATTESTATION-CONTRACT.md §1 and
// database/initialize.ts's registered SQL Digest() config exactly, or the producer's digest
// silently diverges from the SQL/verifier path (SIGN-05, D-06).
const hasher = resolveHasher('sha256')
const encode = resolveOutputEncoder('base64url')

/**
 * Compute the canonical injective digest binding a challenge nonce to a device's voting public
 * key: `Digest(nonce, deviceKey)`, sha256/base64url. Field ORDER is `[nonce, deviceKey]`, never
 * reversed; never hand-roll `sha256(nonce + deviceKey)` (the encoding is length-prefixed and
 * type-tagged, not concatenation) — mirrors
 * `packages/vote-engine/src/association/verifiers/digest-binding.ts`'s `recomputeChallengeDigest`
 * byte-for-byte.
 */
export function computeBoundDigest(nonce: string, deviceKey: string): string {
	return digestFields([nonce, deviceKey], hasher, encode) as string
}

/**
 * D-16b module-load probe: assert this runtime's `digestFields` binding matches a known-good,
 * Node-computed vector BEFORE any real use. Runs at MODULE-EVALUATION time (not per-call) so a
 * multi-copy `@noble/hashes` binding anomaly (spike finding 013's class of bug) is caught loudly
 * here — fail-closed — rather than silently producing a corrupt digest that only fails
 * cryptically at the authority verifier. Real enforcement is on Hermes on-device (45-09); a
 * Node/jest pass proves the contract shape only, not the Hermes binding.
 */
const PROBE_VECTOR = { nonce: 'probe-nonce-v1', deviceKey: 'probe-devicekey-v1' }
const PROBE_EXPECTED = 'epUx8O72zVpRIQl1WGnqZSQpvFJjJPPZtmgqJBcUfzI' // Node-computed literal; do NOT recompute dynamically

const probeResult = digestFields([PROBE_VECTOR.nonce, PROBE_VECTOR.deviceKey], hasher, encode)
if (probeResult !== PROBE_EXPECTED) {
	throw new Error(
		`real-attestation-producer: Digest() module-load probe FAILED on this runtime ` +
			`(got ${String(probeResult)}, expected ${PROBE_EXPECTED}) — likely a multi-copy ` +
			`@noble/hashes binding anomaly (spike finding 013's class of bug). Refusing to produce ` +
			`attestations with an unverified digest implementation.`,
	)
}
