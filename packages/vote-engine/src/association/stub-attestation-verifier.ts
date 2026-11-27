import type { AttestationChallenge, AttestationVerification, DeviceAttestation, IAttestationVerifier } from '@votetorrent/vote-core'

/**
 * StubAttestationVerifier — Node-testable `IAttestationVerifier` seam stub
 * (D-07).
 *
 * The real implementation lives in `play-integrity-verifier.ts`
 * (`PlayIntegrityVerifier`, Phase 43); this stub is now the D-14 dev-gate
 * fallback (`USE_STUB_ATTESTATION_VERIFIER`), not the only implementation.
 *
 * Real platform verification — cert-chain-to-root validation (iOS App
 * Attest), statement/signature validity (Android Play Integrity /
 * SafetyNet), and full replay protection beyond nonce matching — is
 * DEFERRED. This stub checks only:
 *   1. When the attestation carries an explicit platform-level nonce
 *      (`AndroidAttestationDetails.nonce` — the only platform detail this
 *      phase's model exposes a nonce on; `IOSAttestationDetails` has none),
 *      it must equal the issued challenge's nonce.
 *
 * D-10 (51-05): `AttestationChallenge` no longer carries an `expiration` —
 * the challenge-not-expired check that used to live here is GONE. Single-use
 * is enforced by D-11 (the authority consumes the challenge inside
 * `associate()`'s own transaction), not by a TTL this seam would check.
 *
 * This seam exists purely so `AssociationEngine`'s attestation flow is
 * exercisable on Node without a real device. Swap in a real verifier via
 * `new AssociationEngine(ctx, realVerifier)` — the engine's shape never
 * changes.
 */
export class StubAttestationVerifier implements IAttestationVerifier {
  async verify (challenge: AttestationChallenge, attestation: DeviceAttestation): Promise<AttestationVerification> {
    const platformNonce = attestation.platformDetails?.type === 'Android' ? attestation.platformDetails.nonce : undefined
    if (platformNonce !== undefined && platformNonce !== challenge.nonce) {
      return { ok: false, reason: 'attestation nonce does not answer the issued challenge nonce' }
    }

    return { ok: true }
  }
}
