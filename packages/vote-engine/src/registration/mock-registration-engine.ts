import { setCommit, setDisclose, randomBytes } from '@optimystic/quereus-plugin-crypto'
import { RegistrationRegisterBuilder } from './builders/registration-register-builder.js'
import type {
  DisclosedSelective,
  ElectionDisclosurePolicy,
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
  SelectiveLeaf,
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
  /** D-11/D-12/D-13: in-memory parity for RegistrantSelective, keyed by registrantId. */
  private readonly registrantSelectives = new Map<string, RegistrantSelective>()
  /** D-17: authority-only roster — in-memory parity for ElectionRegistrant, keyed by `${electionId}${registrantId}`. */
  private readonly electionRegistrants = new Set<string>()
  /** D-08/D-10: in-memory parity for ElectionRegistrationField policy, keyed by `${electionId}/${fieldName}`. */
  private readonly electionRegistrationFields = new Map<string, ElectionRegistrationField>()
  /** D-14: in-memory parity for ElectionDisclosurePolicy, keyed by `${electionId}/${fieldName}`. */
  private readonly electionDisclosurePolicies = new Map<string, ElectionDisclosurePolicy>()

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

    // D-11/D-12/D-13: mirrors RegistrationEngine's selective branch — ONLY a
    // non-empty selective.details list generates leaves + a Cid (Pitfall 3);
    // salts come from the plugin's own randomBytes (D-13, never an ad-hoc
    // JS RNG); Cid is the plugin's genuine setCommit root (parity with the
    // real engine's SQL cid(set_commit(...)), just JS-computed since the
    // mock has no DB).
    let selectiveLeaves: SelectiveLeaf[] | undefined
    let selectiveCid: string | undefined
    if (init.selective && init.selective.details.length > 0) {
      const seen = new Set<string>()
      for (const field of init.selective.details) {
        if (seen.has(field.name)) {
          throw new Error(`MockRegistrationEngine.register: duplicate selective field name '${field.name}' (D-13)`)
        }
        seen.add(field.name)
      }
      selectiveLeaves = init.selective.details.map((field) => {
        const salt = randomBytes(128) as string
        if (!salt) {
          throw new Error(`MockRegistrationEngine.register: engine could not obtain a non-empty salt for selective field '${field.name}' (D-13)`)
        }
        return { name: field.name, value: field.value, salt }
      })
      selectiveCid = setCommit(selectiveLeaves) as string
    }

    const registrant: Registrant = {
      id: registrantId,
      authorityId: init.registrant.authorityId,
      privateCid,
      publicCid,
      selectiveCid,
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

    if (selectiveLeaves && selectiveCid) {
      this.registrantSelectives.set(registrantId, {
        cid: selectiveCid,
        registrantId,
        expiration: init.selective!.expiration,
        selectiveDetails: selectiveLeaves
      })
    }
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

  async getRegistrantSelective (registrantId: string): Promise<RegistrantSelective | undefined> {
    return this.registrantSelectives.get(registrantId)
  }

  /** D-14: mirrors RegistrationEngine.getDisclosedSelective using the plugin's own setDisclose (parity). */
  async getDisclosedSelective (electionId: string, registrantId: string, audience: string): Promise<DisclosedSelective | null> {
    const row = this.registrantSelectives.get(registrantId)
    if (!row) return null
    const leaves = row.selectiveDetails ?? []

    const permitted = new Set<string>()
    for (const policy of this.electionDisclosurePolicies.values()) {
      if (policy.electionId === electionId && (policy.audience === audience || policy.audience === 'everyone')) {
        permitted.add(policy.fieldName)
      }
    }

    const { disclosed, hidden } = setDisclose(leaves, [...permitted])
    const disclosedOut: SelectiveLeaf[] = disclosed.map((leaf) => ({
      name: leaf.name,
      value: leaf.value as SelectiveLeaf['value'],
      salt: typeof leaf.salt === 'string' ? leaf.salt : String(leaf.salt)
    }))
    const root = setCommit(leaves) as string

    return { cid: row.cid, root, disclosed: disclosedOut, hidden: [...hidden] }
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

  /** D-08/D-10: policy declaration — in-memory Map add, no signing. */
  async addElectionRegistrationField (field: ElectionRegistrationField, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionRegistrationFields.set(`${field.electionId}/${field.fieldName}`, field)
  }

  /** D-08/D-10: policy removal — in-memory Map delete, no signing. */
  async removeElectionRegistrationField (electionId: string, fieldName: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionRegistrationFields.delete(`${electionId}/${fieldName}`)
  }

  async getElectionRegistrationFields (electionId: string): Promise<ElectionRegistrationField[]> {
    return [...this.electionRegistrationFields.values()].filter((f) => f.electionId === electionId)
  }

  /** D-14: policy declaration — in-memory Map add, no signing (additive, mirrors addElectionRegistrationField). */
  async addElectionDisclosurePolicy (policy: ElectionDisclosurePolicy, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionDisclosurePolicies.set(`${policy.electionId}/${policy.fieldName}`, policy)
  }

  /** D-14: policy removal — in-memory Map delete, no signing. */
  async removeElectionDisclosurePolicy (electionId: string, fieldName: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionDisclosurePolicies.delete(`${electionId}/${fieldName}`)
  }

  async getElectionDisclosurePolicies (electionId: string): Promise<ElectionDisclosurePolicy[]> {
    return [...this.electionDisclosurePolicies.values()].filter((p) => p.electionId === electionId)
  }
}
