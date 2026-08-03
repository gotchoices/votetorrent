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
 */

import type { AttestationChallenge, DeviceAttestation } from '@votetorrent/vote-core'
import { createRealAttestationProducer } from '@votetorrent/attestation-native'
import { USE_STUB_PLAY_INTEGRITY, USE_REAL_ATTESTATION_PRODUCER } from './proof-flags.generated'

/**
 * A device-side attestation producer (D-11 two-step seam):
 *   (1) `provisionDeviceKey()` — generates/returns the hardware-backed P-256 public
 *       key BEFORE the challenge is issued.
 *   (2) `produce(challenge)` — answers an already-issued challenge bound to that key.
 * Phase 45's real producer (Play Integrity token + hardware Keystore key attestation)
 * implements this exact shape.
 */
export interface AttestationProducer {
	provisionDeviceKey(): Promise<{ publicKey: string }>
	produce(challenge: AttestationChallenge): Promise<DeviceAttestation>
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
export function resolveAttestationProducer(realProducer?: AttestationProducer): AttestationProducer {
	if (realProducer !== undefined) {
		return realProducer
	}
	if (resolveRealProducerForced()) {
		return createRealAttestationProducer({ enablePlayIntegrity: resolvePlayIntegrityEnabled() })
	}
	if (__DEV__) {
		return StubAttestationProducer
	}
	return createRealAttestationProducer({ enablePlayIntegrity: resolvePlayIntegrityEnabled() })
}
