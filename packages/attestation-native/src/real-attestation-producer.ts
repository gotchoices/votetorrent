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
 * isn't registered (Node/jest). The native module is accessed LAZILY (see
 * `createRealAttestationProducer` below) so that merely importing this module — and running
 * `computeBoundDigest` + the D-16b probe — works under Node/jest without the native module
 * present.
 */

import { digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'
import type { AttestationChallenge, DeviceAttestation } from '@votetorrent/vote-core'
// Type-only import — erased at compile time (isolatedModules requires this to be explicit), so
// it produces NO runtime require of './specs/NativeAttestation' and therefore does not trigger
// that module's top-level `TurboModuleRegistry.getEnforcing(...)` call. The runtime value is
// obtained lazily via `require(...)` inside `getNative()` below.
import type { Spec as NativeAttestationSpec } from './specs/NativeAttestation'

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

/**
 * Stable module-level Keystore alias (D-13 requires a STABLE alias so enrollment-change
 * invalidation is detectable — the native side deletes/regenerates under this SAME alias on
 * `KeyPermanentlyInvalidatedException`, per 45-02's `KeyAttestationHelper`).
 */
const KEY_ALIAS = 'VOTETORRENT_DEVICE_KEY_V1'

/**
 * Lazily resolve the native TurboModule via a plain CommonJS `require()` — NOT a top-level
 * `import` and NOT `import()` (bundler-dependent: a single-file bundler without code-splitting
 * can hoist a dynamic `import()` of a local relative module into a top-level static import,
 * defeating the deferral). `require()` inside a function body is unambiguously lazy under both
 * Metro's CommonJS-based module runtime and Jest/Babel's CommonJS transform — the module factory
 * only executes when this function is actually called. NEVER call this at module scope —
 * `getEnforcing(...)` throws in any environment where `AttestationNative` isn't registered
 * (Node/jest), which would break importing this module (and therefore `computeBoundDigest` + the
 * D-16b probe above) under test.
 */
function getNative(): NativeAttestationSpec {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, see comment above.
	return require('./specs/NativeAttestation').default as NativeAttestationSpec
}

/**
 * Base64-encode the UTF-8 bytes of a string (STANDARD alphabet, no URL-safe substitution) — the
 * native side decodes this with `Base64.decode(boundDigestUtf8Base64, Base64.NO_WRAP)`
 * (`AttestationNativeModule.kt`), which expects the standard `+`/`/` alphabet, not base64url.
 * Mirrors `packages/vote-engine/src/utils.ts`'s `bytesToBase64url` pattern (minus the URL-safe
 * substitution) — `btoa` is the established, device-proven global for this in the codebase
 * (RN/Hermes has no `Buffer`, but `btoa`/`atob` are proven available on-device).
 */
function base64FromUtf8(value: string): string {
	const bytes = new TextEncoder().encode(value)
	let binary = ''
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
	return btoa(binary)
}

/** Package-local two-method producer shape (D-08 — structurally, not nominally, typed). */
interface RealAttestationProducer {
	provisionDeviceKey(): Promise<{ publicKey: string }>
	produce(challenge: AttestationChallenge): Promise<DeviceAttestation>
}

/**
 * Injectable factory driving the D-11 two-step TurboModule seam. Takes a plain
 * `{ enablePlayIntegrity: boolean }` and passes it STRAIGHT into native `produceAttestation` —
 * this package holds NO app-level flag constant; the boolean is the ONLY injection point (D-12),
 * wired by the app call site (45-08's `resolvePlayIntegrityEnabled()`).
 */
export function createRealAttestationProducer(opts: { enablePlayIntegrity: boolean }): RealAttestationProducer {
	return {
		async provisionDeviceKey() {
			const native = getNative()
			const result = (await native.provisionDeviceKey(KEY_ALIAS)) as { publicKeyBase64: string; keyAlias: string }
			return { publicKey: result.publicKeyBase64 }
		},

		async produce(challenge: AttestationChallenge): Promise<DeviceAttestation> {
			// Three distinct nonce forms (Pitfall 5) — never reuse one variable for two:
			//   (1) challenge.nonce            — RAW authority nonce, used ONLY for platformDetails.nonce below.
			//   (2) boundDigest                — BOUND_DIGEST base64url string, sent AS-IS to Play Integrity setNonce (§2).
			//   (3) boundDigestUtf8Base64      — base64(utf8(BOUND_DIGEST)), sent to Keystore setAttestationChallenge (§3).
			// Do not symmetrize (2) and (3) — this asymmetry is intentional and matches the shipped verifier exactly.
			const boundDigest = computeBoundDigest(challenge.nonce, challenge.deviceKey)
			const boundDigestUtf8Base64 = base64FromUtf8(boundDigest)

			const native = getNative()
			const result = (await native.produceAttestation(KEY_ALIAS, boundDigest, boundDigestUtf8Base64, opts.enablePlayIntegrity)) as {
				certificateChainBase64: string[]
				integrityToken: string
				androidId: string
				attestationTimeMillis: number
			}

			return {
				publicKey: challenge.deviceKey,
				deviceId: result.androidId,
				attestationTime: result.attestationTimeMillis,
				// Native side already drops the trailing root (D-15b) — forward verbatim.
				certificateChain: result.certificateChainBase64,
				platformDetails: {
					type: 'Android',
					safetyNetAttestation: result.integrityToken,
					keystorePublicKey: challenge.deviceKey,
					// RAW challenge.nonce — NOT BOUND_DIGEST (Pitfall 5; AssociationAssociateBuilder's
					// validateNonceCrossField rejects BOUND_DIGEST here with NONCE_MISMATCH).
					nonce: challenge.nonce,
				},
			}
		},
	}
}
