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
 *   1. The challenge has not expired.
 *   2. When the attestation carries an explicit platform-level nonce
 *      (`AndroidAttestationDetails.nonce` — the only platform detail this
 *      phase's model exposes a nonce on; `IOSAttestationDetails` has none),
 *      it must equal the issued challenge's nonce.
 *
 * This seam exists purely so `AssociationEngine`'s attestation flow is
 * exercisable on Node without a real device. Swap in a real verifier via
 * `new AssociationEngine(ctx, realVerifier)` — the engine's shape never
 * changes.
 */
export class StubAttestationVerifier implements IAttestationVerifier {
  async verify (challenge: AttestationChallenge, attestation: DeviceAttestation): Promise<AttestationVerification> {
    const expMs = typeof challenge.expiration === 'number' ? challenge.expiration : Date.parse(challenge.expiration)
    if (Number.isNaN(expMs)) {
      return { ok: false, reason: 'AttestationChallenge.expiration is not a parseable datetime' }
    }
    if (Date.now() > expMs) {
      return { ok: false, reason: 'AttestationChallenge has expired' }
    }

    const platformNonce = attestation.platformDetails?.type === 'Android' ? attestation.platformDetails.nonce : undefined
    if (platformNonce !== undefined && platformNonce !== challenge.nonce) {
      return { ok: false, reason: 'attestation nonce does not answer the issued challenge nonce' }
    }

    return { ok: true }
  }
}
