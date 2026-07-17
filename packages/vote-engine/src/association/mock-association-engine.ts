import { AssociationAssociateBuilder } from './builders/association-associate-builder.js'
import type {
  AssociateInit,
  Association,
  AttestationChallenge,
  IAssociationAssociateBuilder,
  IAssociationEngine,
  Signature
} from '@votetorrent/vote-core'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * MockAssociationEngine — UI-layer-only, in-memory parity implementation of
 * `IAssociationEngine` (D-01). Mirrors `MockElectionsEngine`'s `Map`-keyed
 * shape (elections/mock-elections-engine.ts) and `MockRegistrationEngine`'s
 * DEBT-02 conventions — no DB, no real signing.
 *
 * Challenges are keyed by `Nonce`; associations are keyed by
 * `${registrantId}:${deviceKey}` — a second `associate()` for the same key
 * throws (mock replay parity, matching the real engine's Association PK
 * collision behavior for D-06 replay).
 */
export class MockAssociationEngine implements IAssociationEngine {
  private readonly challenges = new Map<string, AttestationChallenge>()
  private readonly associations = new Map<string, Association>()

  async issueAttestationChallenge (
    registrantId: string,
    deviceKey: string,
    expiration: string,
    _signatureOrCallback: SignatureOrCallback
  ): Promise<AttestationChallenge> {
    const nonce = crypto.randomUUID()
    const challenge: AttestationChallenge = {
      nonce,
      authorityId: 'mock-authority',
      registrantId,
      deviceKey,
      expiration
    }
    this.challenges.set(nonce, challenge)
    return challenge
  }

  async removeAttestationChallenge (nonce: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.challenges.delete(nonce)
  }

  buildAssociate (): IAssociationAssociateBuilder {
    return new AssociationAssociateBuilder(this)
  }

  async associate (init: AssociateInit, signatureOrCallback: SignatureOrCallback): Promise<void> {
    const key = `${init.registrantId}:${init.deviceKey}`
    if (this.associations.has(key)) {
      throw new Error(`MockAssociationEngine.associate: an Association already exists for ${key} (mock replay parity — D-06)`)
    }
    const sig = typeof signatureOrCallback === 'function'
      ? await signatureOrCallback(new Uint8Array())
      : signatureOrCallback
    const challenge = this.challenges.get(init.nonce)
    this.associations.set(key, {
      registrantId: init.registrantId,
      deviceKey: init.deviceKey,
      deviceHash: init.deviceHash,
      attestationCid: `mock-attestation-cid-${key}`,
      expiration: challenge?.expiration ?? new Date(Date.now() + 3_600_000).toISOString(),
      signorKey: sig.signerKey,
      signature: sig.signature
    })
  }

  async getAssociation (registrantId: string, deviceKey: string): Promise<Association | undefined> {
    return this.associations.get(`${registrantId}:${deviceKey}`)
  }

  async removeAssociation (registrantId: string, deviceKey: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.associations.delete(`${registrantId}:${deviceKey}`)
  }
}
