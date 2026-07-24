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
 * ONLY when `__DEV__` is true. Outside `__DEV__`, `resolveAttestationProducer()`
 * (with no real producer supplied) returns the REAL producer via
 * `createRealAttestationProducer({ enablePlayIntegrity: resolvePlayIntegrityEnabled() })`
 * (real by default; D-12 independent stub tier via `USE_STUB_PLAY_INTEGRITY`) — never
 * the stub —
 * mirroring the authority app's `USE_STUB_ATTESTATION_VERIFIER` / CR-03 fail-closed
 * posture (`apps/VoteTorrentAuthority/src/engines/engine-factory.ts`'s `'association'`
 * case).
 */

import type { AttestationChallenge, DeviceAttestation } from '@votetorrent/vote-core'
import { createRealAttestationProducer } from '@votetorrent/attestation-native'
import { USE_STUB_PLAY_INTEGRITY } from './proof-flags.generated'

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
 * Resolve the `AttestationProducer` to use, gated the SAME way as
 * `USE_STUB_ATTESTATION_VERIFIER` (fail-closed, CR-03 posture). Precedence:
 *
 *   1. A supplied real producer ALWAYS wins — regardless of `__DEV__` — so Phase 45
 *      can exercise/A-B its real producer in a debug build (the "pure drop-in, no
 *      other call site changes" contract, D-03).
 *   2. Otherwise, in `__DEV__` fall back to the dev-only `StubAttestationProducer`
 *      (unchanged from Phase 44 — stub-only-in-DEV spoofing posture).
 *   3. Otherwise (release build, no real producer supplied) return the REAL producer
 *      via `createRealAttestationProducer` — never the stub. This preserves CR-03:
 *      the stub is STILL only reachable when `__DEV__` is true.
 */
export function resolveAttestationProducer(realProducer?: AttestationProducer): AttestationProducer {
	if (realProducer !== undefined) {
		return realProducer
	}
	if (__DEV__) {
		return StubAttestationProducer
	}
	return createRealAttestationProducer({ enablePlayIntegrity: resolvePlayIntegrityEnabled() })
}
