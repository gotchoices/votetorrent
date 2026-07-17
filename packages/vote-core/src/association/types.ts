import type { Signature } from '../common/index.js'
import type { IBuilder } from '../common/builder.js'
import type { AssociateInit, Association, AttestationChallenge, DeviceAttestation } from './models.js'

/**
 * D-01/D-19: every mutating method's signing parameter is a `Signature` OR a
 * callback that receives the canonical digest bytes and returns one — NEVER
 * a raw private key. The engine never holds the key (D-01).
 */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

export interface IAssociationEngine {
  /** D-03: authority issues a one-time nonce-bound challenge before Associate. */
  issueAttestationChallenge(
    registrantId: string,
    deviceKey: string,
    expiration: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<AttestationChallenge>

  /** D-03: authority deletes a consumed/expired challenge. */
  removeAttestationChallenge(nonce: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** D-02: Associate is a builder — multi-field draft + signing + serialization. */
  buildAssociate(): IAssociationAssociateBuilder

  /**
   * Direct associate — the Associate builder's commit() delegates 1:1 to this
   * method. D-03 flow: authority verifies the device attestation off-chain
   * (via IAttestationVerifier), stores the sensitive half in AssociationPrivate,
   * and signs the public Association (committing to the attestation via AttestationCid).
   */
  associate(init: AssociateInit, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** Public Association row read. */
  getAssociation(registrantId: string, deviceKey: string): Promise<Association | undefined>

  /** 'vrg'-signed delete. */
  removeAssociation(registrantId: string, deviceKey: string, signatureOrCallback: SignatureOrCallback): Promise<void>
}

export interface IAssociationAssociateBuilder extends IBuilder<AssociateInit, void> {
  fromPayload(payload: AssociateInit): this
}

/** Result of an {@link IAttestationVerifier} check. */
export interface AttestationVerification {
  ok: boolean
  reason?: string
}

/**
 * D-07: attestation platform verification seam — no codebase analog. Real
 * iOS App Attest / Android Play Integrity verification (cert-chain-to-root,
 * statement validity, nonce freshness) is deferred; this minimal interface
 * exists so a real verifier can be injected into AssociationEngine later
 * without changing the engine's shape. SEAM-ONLY this phase — no default
 * auto-pass implementation ships here.
 */
export interface IAttestationVerifier {
  verify(challenge: AttestationChallenge, attestation: DeviceAttestation): Promise<AttestationVerification>
}
