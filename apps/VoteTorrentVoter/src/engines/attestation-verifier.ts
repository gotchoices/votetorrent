/**
 * attestation-verifier.ts — which `IAttestationVerifier` the voter app's `'association'`
 * engine is built with.
 *
 * Mirrors the authority app's gate shape exactly (`__DEV__ && USE_STUB_ATTESTATION_VERIFIER`
 * selects the stub, never a silent prod fallback), with ONE deliberate difference in what the
 * non-stub branch is:
 *
 *   - The authority's non-stub branch is the REAL platform-dispatching verifier, built from
 *     provisioned key material (Play Console integrity keys, pinned hardware / App Attest roots,
 *     the revocation list). The authority is the party that verifies a device attestation.
 *   - The voter never verifies an attestation — it PRODUCES one (`attestation-producer.ts`) and
 *     the authority checks it. The only engine paths that reach the verifier are
 *     `AssociationEngine.associate()` and the intake driver `processPendingAssociationRequests()`
 *     (which calls `associate()`), and `no-vrg-ceremony.gate.test.ts` fails the build if either
 *     ceremony is ever reintroduced under the voter's src. Shipping the authority's verifier here
 *     would put Play Integrity decryption keys in a client that has no use for them.
 *
 * So the voter's non-stub branch is `RefusingAttestationVerifier`: it rejects every
 * attestation. If some future path ever did route a verification through the voter, it fails
 * CLOSED instead of passing on a nonce-only check.
 */
import type {
	AttestationChallenge,
	AttestationVerification,
	DeviceAttestation,
	IAttestationVerifier,
} from '@votetorrent/vote-core'
import { StubAttestationVerifier } from '@votetorrent/vote-engine/rn'

/** Fail-closed verifier: the voter app is never the verifying party. */
export class RefusingAttestationVerifier implements IAttestationVerifier {
	async verify (_challenge: AttestationChallenge, _attestation: DeviceAttestation): Promise<AttestationVerification> {
		return { ok: false, reason: 'device attestations are verified by the authority, not the voter app' }
	}
}

/**
 * Picks the voter's association verifier. The stub (nonce-freshness only) is selected ONLY when
 * BOTH `isDev` (`__DEV__` at the call site) and the `USE_STUB_ATTESTATION_VERIFIER` proof flag
 * are true; a release build gets the refusing verifier no matter what the flag file holds.
 */
export function selectAttestationVerifier (isDev: boolean, useStubFlag: boolean): IAttestationVerifier {
	return isDev && useStubFlag ? new StubAttestationVerifier() : new RefusingAttestationVerifier()
}
