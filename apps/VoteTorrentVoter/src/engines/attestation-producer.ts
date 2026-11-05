/**
 * attestation-producer.ts — D-03/D-11 device-side attestation PRODUCER seam
 * (Phase 44-03, reshaped to the two-step seam in Phase 45-05).
 *
 * This is the boundary between "the screens drive attestation production" and
 * "that value is handed to `AssociationAssociateBuilder.setAttestation(...)`".
 * `44-PATTERNS.md` confirms neither app has a prior instance of a *producer* type
 * (only the pre-existing *verifier* seam, `StubAttestationVerifier` /
 * `USE_STUB_ATTESTATION_VERIFIER`, has an analog).
 *
 * D-11 two-step seam: `provisionDeviceKey()` generates/returns the hardware-backed
 * P-256 public key BEFORE the authority-issued challenge exists; `produce(challenge)`
 * then answers that challenge. Phase 45's `createRealAttestationProducer` (from
 * `@votetorrent/attestation-native`) implements this exact shape — no navigation/
 * engine re-wiring here (44-08/45-06 own the screen wiring; do NOT construct
 * AssociationEngine here).
 *
 * T-44-08 (Spoofing, mitigate) / T-45-05-04 (CR-03): the stub producer is reachable
 * ONLY when `__DEV__` is true AND `USE_REAL_ATTESTATION_PRODUCER` is false (the
 * committed default). Outside `__DEV__`, `resolveAttestationProducer()` (with no
 * real producer supplied) returns the REAL producer via
 * `createRealAttestationProducer({ enablePlayIntegrity: resolvePlayIntegrityEnabled() })`
 * (real by default; D-12 independent stub tier via `USE_STUB_PLAY_INTEGRITY`) — never
 * the stub — mirroring the authority app's `USE_STUB_ATTESTATION_VERIFIER` / CR-03
 * fail-closed posture (`apps/VoteTorrentAuthority/src/engines/engine-factory.ts`'s
 * `'association'` case).
 *
 * 45-09-gap / D-12: `USE_REAL_ATTESTATION_PRODUCER` (via `resolveRealProducerForced()`)
 * additionally lets a `__DEV__` build reach the REAL producer — Metro live-reload stays
 * intact while real hardware key attestation runs — WITHOUT weakening CR-03: the
 * predicate is `__DEV__ && USE_REAL_ATTESTATION_PRODUCER`, so it is unconditionally
 * `false` in a release build no matter the flag's value, and the release rung below is
 * completely unchanged.
 *
 * Plan 11 addition (D-02/D-18): the voter's self-signed association-request messages must
 * carry a signature that verifies directly against the P-256 key `provisionDeviceKey()`
 * returned (the schema's own check compares the signature to that exact public key, not to
 * any registered identity). `signDeviceKeyDigest` is the seam for that.
 *
 * Plan 51-14 CLOSED the gap plan 11/51-11/51-13 flagged: the real hardware-backed producer
 * (`createRealAttestationProducer`, `@votetorrent/attestation-native`) now implements
 * `signDeviceKeyDigest` via the existing `native.signWithDeviceKey` TurboModule call (the same
 * primitive the iOS path already used for its §4 proof-of-possession step) — it is no longer
 * stub-only. The method stays declared OPTIONAL on this interface for structural flexibility
 * (a caller-supplied producer/test fixture that only implements `provisionDeviceKey`/`produce`
 * remains valid TypeScript, e.g. `attestation-producer.test.ts`'s drop-in-override fixtures) —
 * but any producer actually used for the association ceremony MUST implement it. A caller must
 * treat its absence as "cannot self-sign," never silently skip it (`ConfirmationScreen.tsx`'s
 * `associationSign` guard does exactly this, unchanged by 51-14).
 *
 * Vote signing: `resolveVoteSigningProducer()` (bottom of file) always returns the REAL producer, and
 * `signDeviceKeyDigest` takes an optional `{ prompt }` carrying the biometric prompt copy.
 */

import type { AttestationChallenge, DeviceAttestation, Signature } from '@votetorrent/vote-core'
import { createRealAttestationProducer } from '@votetorrent/attestation-native'
import type { SignDeviceKeyDigestOptions } from '@votetorrent/attestation-native'
import { USE_STUB_PLAY_INTEGRITY, USE_REAL_ATTESTATION_PRODUCER } from './proof-flags.generated'
import { dismissKeyboardForSystemPrompt } from '../utils/dismissKeyboardForSystemPrompt'

/**
 * A device-side attestation producer (D-11 two-step seam):
 *   (1) `provisionDeviceKey()` — generates/returns the hardware-backed P-256 public
 *       key BEFORE the challenge is issued.
 *   (2) `produce(challenge)` — answers an already-issued challenge bound to that key.
 * Phase 45's real producer (Play Integrity token + hardware Keystore key attestation)
 * implements this exact shape.
 *
 * `signDeviceKeyDigest` (plan 11 addition, declared OPTIONAL — see this file's header comment)
 * signs an arbitrary digest under the SAME key `provisionDeviceKey()` returned, for the
 * voter's self-signed association-request submissions (D-02/D-18) — never for anything a
 * schema `AdminSigning`/officer ceremony verifies. Implemented by BOTH concrete producers
 * (`StubAttestationProducer` below, and the real hardware-backed producer as of plan 51-14).
 */
export interface AttestationProducer {
	provisionDeviceKey(): Promise<{ publicKey: string }>
	/**
	 * READ-ONLY lookup of the CURRENT device key (63-18 fix): never generates, rotates or prompts.
	 * Every LOOKUP (association queries, registration status, continuity) must use this;
	 * `provisionDeviceKey` is for CREATION flows only, because on Android it mints a NEW key on
	 * every call. Rejects with code `DEVICE_KEY_ABSENT` / `DEVICE_KEY_INVALIDATED`.
	 */
	getCurrentDeviceKey(): Promise<{ publicKey: string }>
	produce(challenge: AttestationChallenge): Promise<DeviceAttestation>
	signDeviceKeyDigest?(digest: Uint8Array, options?: SignDeviceKeyDigestOptions): Promise<Signature>
}

/**
 * An `AttestationProducer` whose `signDeviceKeyDigest` is statically present. Vote signing has no
 * "cannot sign" branch: `resolveVoteSigningProducer` returns this type.
 */
export type VoteSigningProducer = AttestationProducer & {
	signDeviceKeyDigest(digest: Uint8Array, options?: SignDeviceKeyDigestOptions): Promise<Signature>
}

/**
 * StubAttestationProducer — dev-only `AttestationProducer` implementation.
 *
 * `provisionDeviceKey()` returns a clearly-non-real placeholder public key.
 * `produce(challenge)` synthesizes a `DeviceAttestation` whose `platformDetails.nonce`
 * round-trips the RAW issued `challenge.nonce` (the only real-world invariant
 * `StubAttestationVerifier` checks — never BOUND_DIGEST here, Pitfall 5), with
 * deterministic, clearly-non-real placeholder cert/key/deviceId values. Never used
 * outside `__DEV__` (see `resolveAttestationProducer` below).
 */
export const StubAttestationProducer: AttestationProducer = {
	async provisionDeviceKey(): Promise<{ publicKey: string }> {
		return { publicKey: 'STUB_DEVICE_PUBLIC_KEY_PLACEHOLDER_NOT_REAL' }
	},

	// Same placeholder as provisionDeviceKey: the stub has one fixed key, so lookup === creation.
	async getCurrentDeviceKey(): Promise<{ publicKey: string }> {
		return { publicKey: 'STUB_DEVICE_PUBLIC_KEY_PLACEHOLDER_NOT_REAL' }
	},

	// Plan 11 (D-02/D-18): a clearly-non-real placeholder signature — never a real cryptographic
	// signature, and never something a schema SignatureValid check will accept. Dev-only, mirrors
	// the other STUB_* placeholder values in this file.
	// The stub ignores prompt copy. It honours `options.signal` like the real producer (review WR-01):
	// an already-aborted signal rejects an AbortError with code ABORTED instead of signing.
	async signDeviceKeyDigest(_digest: Uint8Array, options?: SignDeviceKeyDigestOptions): Promise<Signature> {
		if (options?.signal?.aborted) {
			throw Object.assign(new Error('signDeviceKeyDigest: abandoned before the native sign'), { name: 'AbortError', code: 'ABORTED' })
		}
		return {
			signature: 'STUB_DEVICE_KEY_SIGNATURE_PLACEHOLDER_NOT_REAL',
			signerKey: 'STUB_DEVICE_PUBLIC_KEY_PLACEHOLDER_NOT_REAL',
			signerUserId: '',
		}
	},

	async produce(challenge: AttestationChallenge): Promise<DeviceAttestation> {
		const deviceKey = challenge.deviceKey
		return {
			publicKey: deviceKey,
			deviceId: `STUB_DEVICE_ID_${challenge.registrantId}`,
			attestationTime: Date.now(),
			certificateChain: ['STUB_CERTIFICATE_PLACEHOLDER_NOT_REAL'],
			platformDetails: {
				type: 'Android',
				safetyNetAttestation: 'STUB_SAFETYNET_ATTESTATION_PLACEHOLDER_NOT_REAL',
				keystorePublicKey: deviceKey,
				nonce: challenge.nonce,
			},
		}
	},
}

/**
 * D-12: the SINGLE named source of truth for the native `enablePlayIntegrity` gate
 * value. Mirrors the `!(__DEV__ && USE_LOCAL_DB_FACTORY)` idiom in engine-factory.ts —
 * real (`true`) by default; only `__DEV__ && USE_STUB_PLAY_INTEGRITY === true` disables
 * the Play Integrity leg (the "real-key + stub-PI" tier). A release build always
 * evaluates to `true` regardless of the flag's value — it can never weaken production.
 * Independent of `resolveAttestationProducer`'s stub-selection precedence below.
 */
export function resolvePlayIntegrityEnabled(): boolean {
	return !(__DEV__ && USE_STUB_PLAY_INTEGRITY)
}

/**
 * 45-09-gap / D-12: the SINGLE named source of truth for whether a `__DEV__` build
 * should be FORCED onto the REAL producer instead of `StubAttestationProducer`.
 *
 * The polarity here is DELIBERATELY the inverse of `resolvePlayIntegrityEnabled()`'s:
 * that predicate is `true` by default and only `false` inside `__DEV__` with its flag
 * set; this predicate is `false` by default and only `true` inside `__DEV__` with ITS
 * flag set. Concretely: `__DEV__ && USE_REAL_ATTESTATION_PRODUCER`.
 *
 * This can only ever be `true` inside `__DEV__` — a release build evaluates `__DEV__`
 * to `false`, so the `&&` short-circuits to `false` regardless of what
 * `USE_REAL_ATTESTATION_PRODUCER` holds in the committed (or a locally edited) copy of
 * `proof-flags.generated.ts`. When this predicate is `false`, the pre-existing
 * precedence in `resolveAttestationProducer` below is byte-for-byte unchanged — so a
 * release build's behavior is completely untouched by this flag's existence. This is
 * what preserves CR-03 / T-45-05-04: release NEVER reaches `StubAttestationProducer`.
 */
export function resolveRealProducerForced(): boolean {
	return __DEV__ && USE_REAL_ATTESTATION_PRODUCER
}

/**
 * Resolve the `AttestationProducer` to use, gated the SAME way as
 * `USE_STUB_ATTESTATION_VERIFIER` (fail-closed, CR-03 posture). Precedence:
 *
 *   1. A supplied real producer ALWAYS wins — regardless of `__DEV__` — so Phase 45
 *      can exercise/A-B its real producer in a debug build (the "pure drop-in, no
 *      other call site changes" contract, D-03).
 *   2. Otherwise, if `resolveRealProducerForced()` is true (`__DEV__` AND
 *      `USE_REAL_ATTESTATION_PRODUCER`), return the REAL producer via
 *      `createRealAttestationProducer` — the 45-09-gap D-12 real-key + stub-PI tier,
 *      reachable from a `__DEV__` build with Metro live-reload intact.
 *   3. Otherwise, in `__DEV__` fall back to the dev-only `StubAttestationProducer`
 *      (unchanged from Phase 44 — stub-only-in-DEV spoofing posture, Phase 44 default
 *      behavior for every existing caller that passes no flag override).
 *   4. Otherwise (release build, no real producer supplied) return the REAL producer
 *      via `createRealAttestationProducer` — never the stub. This preserves CR-03:
 *      the stub is STILL only reachable when `__DEV__` is true AND
 *      `USE_REAL_ATTESTATION_PRODUCER` is false (the committed default).
 *
 * Both real-producer rungs (2 and 4) thread the IDENTICAL `enablePlayIntegrity:
 * resolvePlayIntegrityEnabled()` wiring — D-12 must flow through either rung the same
 * way, so the two flags (`USE_REAL_ATTESTATION_PRODUCER` / `USE_STUB_PLAY_INTEGRITY`)
 * stay independent of each other.
 */
/**
 * Wraps the REAL producer so the soft keyboard is closed (and gone) before either call that raises
 * a native BiometricPrompt: `produce` and `signDeviceKeyDigest`. On MIUI/Android 10 a prompt
 * started over an open IME is never drawn and times out ~10 min later; the continue-on-another-
 * device flow reaches `produce` straight from a typed code with the keyboard still up.
 * `provisionDeviceKey` and `getCurrentDeviceKey` raise no prompt and pass through untouched (including any extra fields
 * the real producer returns).
 */
export function withKeyboardDismissedBeforePrompts(producer: AttestationProducer): AttestationProducer {
	const wrapped: AttestationProducer = {
		provisionDeviceKey: () => producer.provisionDeviceKey(),
		getCurrentDeviceKey: () => producer.getCurrentDeviceKey(),
		produce: async (challenge: AttestationChallenge) => {
			await dismissKeyboardForSystemPrompt()
			return producer.produce(challenge)
		},
	}
	if (typeof producer.signDeviceKeyDigest === 'function') {
		const sign = producer.signDeviceKeyDigest.bind(producer)
		wrapped.signDeviceKeyDigest = async (digest: Uint8Array, options?: SignDeviceKeyDigestOptions) => {
			await dismissKeyboardForSystemPrompt()
			// Forward the prompt copy only when supplied, so single-argument callers see no change.
			return options === undefined ? sign(digest) : sign(digest, options)
		}
	}
	return wrapped
}

export function resolveAttestationProducer(realProducer?: AttestationProducer): AttestationProducer {
	if (realProducer !== undefined) {
		return realProducer
	}
	if (resolveRealProducerForced()) {
		return withKeyboardDismissedBeforePrompts(createRealAttestationProducer({ enablePlayIntegrity: resolvePlayIntegrityEnabled() }))
	}
	if (__DEV__) {
		return StubAttestationProducer
	}
	return withKeyboardDismissedBeforePrompts(createRealAttestationProducer({ enablePlayIntegrity: resolvePlayIntegrityEnabled() }))
}

/**
 * The producer the voter's vote signing uses. Vote signing is REAL in `__DEV__` and in release
 * alike, so dev voting needs an enrolled fingerprint. This resolver deliberately bypasses the stub
 * and the forced-real flag: it never consults `__DEV__`. `override` is a dependency-injection seam
 * for jest and the device probe; it is returned unchanged when it can sign. The ban on the stub
 * token in vote-casting code is enforced by the vote-casting source gate, and on device by the
 * device proof. Each call returns a FRESH instance: call `provisionDeviceKey()` and then
 * `signDeviceKeyDigest()` on the SAME returned instance, because the current key is per instance.
 */
export function resolveVoteSigningProducer(override?: AttestationProducer): VoteSigningProducer {
	if (override !== undefined) {
		if (typeof override.signDeviceKeyDigest !== 'function') {
			throw new Error('resolveVoteSigningProducer: the supplied producer cannot sign (signDeviceKeyDigest missing)')
		}
		return override as VoteSigningProducer
	}
	return createRealAttestationProducer({ enablePlayIntegrity: resolvePlayIntegrityEnabled() })
}
