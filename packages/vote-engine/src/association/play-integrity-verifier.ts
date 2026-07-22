import type { AttestationChallenge, AttestationVerification, DeviceAttestation, IAttestationVerifier } from '@votetorrent/vote-core'
import type { IIntegrityKeyProvider } from './key-provider.js'
import { verifyPlayIntegrity } from './verifiers/play-integrity.js'
import { verifyKeyAttestation } from './verifiers/key-attestation.js'
import type { ExpectedAppIdentity } from './verifiers/app-identity.js'

/**
 * PlayIntegrityVerifier — the real `IAttestationVerifier` implementation
 * (D-01/D-02/D-04/D-06), replacing `StubAttestationVerifier` behind the
 * unchanged seam. Real platform verification, deferred by the stub, lands
 * here: offline classic-API Google Play Integrity decrypt+verify
 * (`verifiers/play-integrity.ts`) composed with offline Android Keystore
 * hardware Key Attestation cert-chain validation
 * (`verifiers/key-attestation.ts`) — D-01 requires BOTH mechanisms to
 * pass; a single passing half never authorizes association. The stub
 * remains the dev-gate fallback (D-14, `USE_STUB_ATTESTATION_VERIFIER`).
 *
 * Never throws for adversarial input — like `StubAttestationVerifier`,
 * every rejection is an early-returned `{ ok: false, reason }` tuple; the
 * caller (`association-engine.ts:255-261`) converts `!ok` into a thrown
 * `Error` itself.
 */
export class PlayIntegrityVerifier implements IAttestationVerifier {
  constructor (
    private readonly keyProvider: IIntegrityKeyProvider,
    private readonly pinnedHardwareRoots: Uint8Array[],
    private readonly expectedAppIdentity: ExpectedAppIdentity,
    private readonly revokedSerials: Set<string> = new Set<string>()
  ) {}

  async verify (challenge: AttestationChallenge, attestation: DeviceAttestation): Promise<AttestationVerification> {
    const android = attestation.platformDetails?.type === 'Android' ? attestation.platformDetails : undefined
    if (!android) {
      return { ok: false, reason: 'attestation carries no Android platform details' }
    }

    const piResult = await verifyPlayIntegrity(android.safetyNetAttestation, challenge, this.keyProvider, this.expectedAppIdentity)
    if (!piResult.ok) return piResult

    const certChainDer = attestation.certificateChain.map((cert) => new Uint8Array(Buffer.from(cert, 'base64')))
    const keyAttResult = await verifyKeyAttestation(certChainDer, challenge, this.pinnedHardwareRoots, this.revokedSerials, this.expectedAppIdentity)
    if (!keyAttResult.ok) return keyAttResult

    return { ok: true }
  }
}
