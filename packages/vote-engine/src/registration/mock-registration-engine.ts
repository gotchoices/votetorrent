import { RegistrationRegisterBuilder } from './builders/registration-register-builder.js'
import type {
  ElectionRegistrant,
  ElectionRegistrationField,
  IRegistrationEngine,
  IRegistrationRegisterBuilder,
  RegisterInit,
  Registrant,
  RegistrantPrivate,
  RegistrantPublic,
  RegistrantSelective,
  RegistrantStatus,
  Signature
} from '@votetorrent/vote-core'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * MockRegistrationEngine — UI-layer-only, in-memory parity implementation of
 * `IRegistrationEngine` (D-01). Mirrors `MockElectionsEngine`'s `Map`-keyed
 * shape (elections/mock-elections-engine.ts) — no DB, no real signing.
 * DEBT-02 style: methods this plan doesn't own (lifecycle/roster/policy/
 * selective) throw a clear "not implemented in mock" error rather than
 * silently no-op-ing, mirroring `MockElectionsEngine.seedElectionSigning`.
 */
export class MockRegistrationEngine implements IRegistrationEngine {
  private readonly registrants = new Map<string, Registrant>()
  private readonly registrantPublics = new Map<string, RegistrantPublic>()
  private readonly registrantPrivates = new Map<string, RegistrantPrivate>()
  /** D-17: authority-only roster — in-memory parity for ElectionRegistrant, keyed by `${electionId}${registrantId}`. */
  private readonly electionRegistrants = new Set<string>()

  buildRegister (): IRegistrationRegisterBuilder {
    return new RegistrationRegisterBuilder(this)
  }

  async register (init: RegisterInit, signatureOrCallback: SignatureOrCallback): Promise<void> {
    const registrantId = init.registrant.id
    const sig = typeof signatureOrCallback === 'function'
      ? await signatureOrCallback(new Uint8Array())
      : signatureOrCallback

    const publicCid = init.public ? `mock-public-cid-${registrantId}` : undefined
    const privateCid = `mock-private-cid-${registrantId}`

    const registrant: Registrant = {
      id: registrantId,
      authorityId: init.registrant.authorityId,
      privateCid,
      publicCid,
      selectiveCid: init.selective ? `mock-selective-cid-${registrantId}` : undefined,
      status: 'a',
      expiration: init.registrant.expiration,
      signorKey: sig.signerKey,
      signature: sig.signature
    }
    this.registrants.set(registrantId, registrant)

    if (init.public) {
      this.registrantPublics.set(registrantId, {
        cid: publicCid!,
        registrantId,
        lastName: init.public.lastName,
        firstName: init.public.firstName,
        district: init.public.district,
        extraFields: init.public.extraFields
      })
    }

    this.registrantPrivates.set(registrantId, {
      cid: privateCid,
      registrantId,
      expiration: init.private.expiration,
      privateDetails: init.private.details
    })
  }

  async getRegistrant (registrantId: string): Promise<Registrant | undefined> {
    return this.registrants.get(registrantId)
  }

  async getRegistrantPublic (registrantId: string): Promise<RegistrantPublic | undefined> {
    return this.registrantPublics.get(registrantId)
  }

  async getRegistrantPrivate (registrantId: string): Promise<RegistrantPrivate | undefined> {
    return this.registrantPrivates.get(registrantId)
  }

  async getRegistrantSelective (_registrantId: string): Promise<RegistrantSelective | undefined> {
    throw new Error('MockRegistrationEngine.getRegistrantSelective: not implemented in mock (owned by Phase 42-08)')
  }

  /** D-16: permissive — no transition guard, mirrors the real engine's lack of one. */
  async changeStatus (registrantId: string, status: RegistrantStatus, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    const existing = this.registrants.get(registrantId)
    if (!existing) {
      throw new Error(`MockRegistrationEngine.changeStatus: Registrant not found for registrantId=${registrantId}`)
    }
    this.registrants.set(registrantId, { ...existing, status })
  }

  /** D-16: permissive — any Expiration value succeeds (no insert-only future check on update). */
  async changeExpiration (registrantId: string, expiration: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    const existing = this.registrants.get(registrantId)
    if (!existing) {
      throw new Error(`MockRegistrationEngine.changeExpiration: Registrant not found for registrantId=${registrantId}`)
    }
    this.registrants.set(registrantId, { ...existing, expiration })
  }

  /** D-17: authority-only roster — in-memory Set add, no signing. */
  async enrollElectionRegistrant (electionId: string, registrantId: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionRegistrants.add(`${electionId}${registrantId}`)
  }

  /** D-17: authority-only roster — in-memory Set delete, no signing. */
  async removeElectionRegistrant (electionId: string, registrantId: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionRegistrants.delete(`${electionId}${registrantId}`)
  }

  async getElectionRegistrants (_electionId: string): Promise<ElectionRegistrant[]> {
    return []
  }

  async addElectionRegistrationField (_field: ElectionRegistrationField, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    throw new Error('MockRegistrationEngine.addElectionRegistrationField: not implemented in mock (owned by Phase 42-07)')
  }

  async removeElectionRegistrationField (_electionId: string, _fieldName: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    throw new Error('MockRegistrationEngine.removeElectionRegistrationField: not implemented in mock (owned by Phase 42-07)')
  }

  async getElectionRegistrationFields (_electionId: string): Promise<ElectionRegistrationField[]> {
    return []
  }
}
