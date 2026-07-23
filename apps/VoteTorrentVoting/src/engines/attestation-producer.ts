/**
 * attestation-producer.ts — D-03 device-side attestation PRODUCER seam (Phase 44-03).
 *
 * This is the boundary between "the stub screens compute a `DeviceAttestation`" and
 * "that value is handed to `AssociationAssociateBuilder.setAttestation(...)`". It is
 * the phase's one genuinely net-new interface: `44-PATTERNS.md` confirms neither app
 * has a prior instance of a *producer* type (only the pre-existing *verifier* seam,
 * `StubAttestationVerifier` / `USE_STUB_ATTESTATION_VERIFIER`, has an analog).
 *
 * Phase 45 drops a `RealAttestationProducer` implementing the IDENTICAL
 * `AttestationProducer` type into this seam — no navigation/engine re-wiring, per
 * D-03's explicit requirement. Do NOT wire this module into any screen here (44-08
 * does the wiring) and do NOT construct AssociationEngine here.
 *
 * T-44-08 (Spoofing, mitigate): the stub producer is reachable ONLY when `__DEV__`
 * is true. A non-`__DEV__` build calling `resolveAttestationProducer()` without a
 * real producer supplied THROWS instead of silently returning the stub — mirroring
 * the authority app's `USE_STUB_ATTESTATION_VERIFIER` / CR-03 fail-closed posture
 * (`apps/VoteTorrentAuthority/src/engines/engine-factory.ts`'s `'association'` case).
 *
 * T-44-09 (Tampering, accept): only `challenge.nonce` is threaded through the stub
 * this phase. The real `Digest(nonce, deviceKey)` anti-relay welding is Phase 45's
 * contract (43-CONTEXT.md D-06) — deferred, not silently omitted.
 */

import type { AttestationChallenge, DeviceAttestation } from '@votetorrent/vote-core'

/**
 * A device-side attestation producer: given the authority-issued challenge and the
 * device's voting public key, produces the platform `DeviceAttestation` answering
 * that challenge. Phase 45's `RealAttestationProducer` (Play Integrity token +
 * hardware Keystore key attestation) implements this exact type.
 */
export type AttestationProducer = (
	challenge: AttestationChallenge,
	deviceKey: string,
) => Promise<DeviceAttestation>

/**
 * StubAttestationProducer — dev-only `AttestationProducer` implementation.
 *
 * Synthesizes a `DeviceAttestation` whose `platformDetails.nonce` round-trips the
 * issued `challenge.nonce` (the only real-world invariant `StubAttestationVerifier`
 * checks), with deterministic, clearly-non-real placeholder cert/key/deviceId
 * values. Never used outside `__DEV__` (see `resolveAttestationProducer` below).
 */
export const StubAttestationProducer: AttestationProducer = async (
	challenge: AttestationChallenge,
	deviceKey: string,
): Promise<DeviceAttestation> => {
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
}

/**
 * Resolve the `AttestationProducer` to use, gated the SAME way as
 * `USE_STUB_ATTESTATION_VERIFIER`: `__DEV__`-only returns the stub; the real-branch
 * throws a clear "real attestation producer not provided" error (fail-closed, CR-03
 * posture) rather than silently falling back to the stub. Phase 45 flips one branch
 * (supplies `realProducer`) to make this a pure drop-in — no other call site changes.
 */
export function resolveAttestationProducer(realProducer?: AttestationProducer): AttestationProducer {
	if (__DEV__) {
		return StubAttestationProducer
	}
	if (realProducer === undefined) {
		throw new Error(
			'attestation-producer: real attestation producer not provided outside __DEV__ — fail-closed (CR-03 posture). Phase 45 must supply a RealAttestationProducer.',
		)
	}
	return realProducer
}
