import { setCommit, setDisclose, randomBytes } from '@optimystic/quereus-plugin-crypto'
import { RegistrationRegisterBuilder } from './builders/registration-register-builder.js'
import { clampPageSize } from './registrant-list-query.js'
import { collectPrivateFieldNames, sanitizeAccessTrailFields } from './access-trail-fields.js'
import { findLikelyDuplicates, extractRegistrationIdentity } from './duplicate-detection.js'
import type { DuplicateComparable } from './duplicate-detection.js'
import type {
  DisclosedSelective,
  ElectionAttestationPolicy,
  ElectionDisclosurePolicy,
  ElectionRegistrant,
  ElectionRegistrationField,
  IRegistrationEngine,
  IRegistrationRegisterBuilder,
  LikelyDuplicateRequest,
  PriorRejection,
  PrivateDetail,
  RegisterInit,
  Registrant,
  RegistrantAccessEvent,
  RegistrantListFilter,
  RegistrantListPage,
  RegistrantListResult,
  RegistrantListRow,
  RegistrantPrivate,
  RegistrantPublic,
  RegistrantSelective,
  RegistrantStatus,
  RegistrationBridgeKey,
  RegistrationBridgeKeyInit,
  RegistrationDecisionPublishOptions,
  RegistrationDecisionPublishPort,
  RegistrationDecisionPublishResult,
  RegistrationDuplicateClosure,
  RegistrationDuplicateClosureRepairReport,
  RegistrationDuplicateClosureState,
  RegistrationRequestDecision,
  RegistrationRequestInit,
  RegistrationRequestIssuerType,
  RegistrationRequestListFilter,
  RegistrationRequestListPage,
  RegistrationRequestListResult,
  RegistrationRequestListRow,
  RegistrationRequestRead,
  RegistrationRequestStatus,
  RegistrationTransparencyStats,
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
  /**
   * D-01/D-02: in-memory parity for RegistrantAccessEvent, keyed by
   * registrantId. Append-only by construction (never spliced/cleared) — the
   * in-memory form of the schema's `InsertOnly` constraint. `sequence` is
   * derived from array length at append time (see
   * `recordRegistrantAccessEvent`), which is only correct because nothing
   * ever removes an entry; adding a `clear()`-style method later would be a
   * deliberate parity break, not a refactor.
   */
  private readonly registrantAccessEvents = new Map<string, RegistrantAccessEvent[]>()
  /** D-17: authority-only roster — in-memory parity for ElectionRegistrant, keyed by `${electionId}/${registrantId}`. */
  private readonly electionRegistrants = new Map<string, ElectionRegistrant>()
  /** D-08/D-10: in-memory parity for ElectionRegistrationField policy, keyed by `${electionId}/${fieldName}`. */
  private readonly electionRegistrationFields = new Map<string, ElectionRegistrationField>()
  /** D-14: in-memory parity for ElectionDisclosurePolicy, keyed by `${electionId}/${fieldName}`. */
  private readonly electionDisclosurePolicies = new Map<string, ElectionDisclosurePolicy>()
  /** D-14b: in-memory parity for ElectionAttestationPolicy, keyed by `electionId` ALONE (single-row-per-election). */
  private readonly electionAttestationPolicies = new Map<string, ElectionAttestationPolicy>()
  /**
   * 48-07/48-08 (D-02/D-06/D-09): in-memory parity for RegistrationRequest,
   * keyed by requestId. Verifies no signature. The decision fields
   * (decidedAt/decidingOfficerUserId/rejectionReason/verificationCid) are
   * OPTIONAL — `submitRegistrationRequest` never sets them (a fresh
   * submission is always pending); only the seeded fixture rows below and a
   * future rejection-plan mock method populate them.
   */
  private readonly duplicateClosures = new Map<string, RegistrationDuplicateClosureState>()

  /**
   * Mock-only test seam. Stands in for the real engine's `RegistrationDecision` 'd' /
   * `ClosesRequestId` rows (D-44), so screens can be tested against duplicate closure
   * without the schema. The request's own Status stays 'p', as in the real engine.
   */
  markDuplicateClosure (
    requestId: string,
    state: RegistrationDuplicateClosureState,
    options?: { closedByRequestId?: string, closedAt?: string }
  ): void {
    // Mirrors vote-core models.ts RegistrationDuplicateClosure: 'closing' always has a closer (it is
    // defined by another decision naming it) and never a closedAt; 'closed' may have a null closer
    // (a 'd' row no decision names) and carries the 'd' row's DecidedAt.
    const closedByRequestId = options?.closedByRequestId ?? null
    if (state === 'closing' && closedByRequestId === null) {
      throw new Error("markDuplicateClosure: a 'closing' request must name the request that closes it")
    }
    this.duplicateClosures.set(requestId, state)
    this.duplicateClosureDetails.set(requestId, {
      closedByRequestId,
      ...(state === 'closed' ? { closedAt: options?.closedAt ?? new Date().toISOString() } : {})
    })
  }

  private readonly duplicateClosureDetails = new Map<string, { closedByRequestId: string | null, closedAt?: string }>()

  private readonly registrationRequests = new Map<string, {
    id: string
    authorityId: string
    payload: RegisterInit
    submittedAt: string
    requesterKey: string
    issuerType: string
    bridgeId: string | null
    receivedAt: string
    status: string
    decidedAt?: string
    decidingOfficerUserId?: string
    rejectionReason?: string
    verificationCid?: string
  }>()
  /** 48-07/D-03: in-memory parity for the RegistrationBridgeKey registry, keyed by bridge key id. */
  private readonly registrationBridgeKeys = new Map<string, RegistrationBridgeKey>()

  constructor () {
    this.seedRegistrationRequestFixtures()
  }

  buildRegister (): IRegistrationRegisterBuilder {
    return new RegistrationRegisterBuilder(this)
  }

  /**
   * 48-08: a small DETERMINISTIC fixture the wave-7 screens (inbox,
   * approval, stats card) render against with NO real database — this is
   * the mock's only source of read-surface data until a real
   * `submitRegistrationRequest`/decision call is made against the SAME
   * instance. Deliberately includes:
   *   - one bridge-issued row (`fixture-request-bridge-1`), registered
   *     against a matching `RegistrationBridgeKey` so `bridgeLabel`
   *     resolves, AND whose `submittedAt`/`receivedAt` deliberately
   *     DIVERGE — the two-timestamp case, not only the degenerate one
   *     where they coincide.
   *   - one registrant-issued PENDING row
   *     (`fixture-request-pending-repeat`) sharing its `requesterKey` with
   *     the rejected row below — the prior-rejection callout fixture.
   *   - one REJECTED row (`fixture-request-rejected-1`) carrying a reason
   *     and a deciding officer, same `requesterKey` as the row above.
   *   - one APPROVED row (`fixture-request-approved-1`) whose
   *     `payload.registrant.id` resolves to a real fixture `Registrant`
   *     row seeded alongside it, so `getRegistrationRequest`'s
   *     existence-probe finds it and reports `registrantId`.
   */
  private seedRegistrationRequestFixtures (): void {
    const authorityId = 'fixture-authority-1'
    const officerUserId = 'fixture-officer-1'
    const now = Date.now()
    const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

    const bridgeId = 'fixture-bridge-1'
    this.registrationBridgeKeys.set(bridgeId, {
      id: bridgeId,
      authorityId,
      label: 'County Clerk Import',
      key: 'fixture-bridge-key-1'
    })

    const bridgePayload: RegisterInit = {
      registrant: { id: 'fixture-registrant-bridge-1', authorityId, expiration: iso(now + 365 * 86_400_000) },
      public: { lastName: 'Alvarez', firstName: 'Jordan' },
      private: { expiration: iso(now + 365 * 86_400_000), details: [] }
    }
    this.registrationRequests.set('fixture-request-bridge-1', {
      id: 'fixture-request-bridge-1',
      authorityId,
      payload: bridgePayload,
      // Deliberately DIVERGENT — the claim is 2 hours before the observation.
      submittedAt: iso(now - 2 * 60 * 60_000),
      receivedAt: iso(now - 60_000),
      requesterKey: 'fixture-bridge-key-1',
      issuerType: 'bridge',
      bridgeId,
      status: 'p'
    })

    const repeatRequesterKey = 'fixture-requester-repeat'
    const rejectedPayload: RegisterInit = {
      registrant: { id: 'fixture-registrant-rejected-1', authorityId, expiration: iso(now + 365 * 86_400_000) },
      public: { lastName: 'Chen', firstName: 'Priya' },
      private: { expiration: iso(now + 365 * 86_400_000), details: [] }
    }
    this.registrationRequests.set('fixture-request-rejected-1', {
      id: 'fixture-request-rejected-1',
      authorityId,
      payload: rejectedPayload,
      submittedAt: iso(now - 10 * 86_400_000),
      receivedAt: iso(now - 10 * 86_400_000),
      requesterKey: repeatRequesterKey,
      issuerType: 'registrant',
      bridgeId: null,
      status: 'r',
      decidedAt: iso(now - 9 * 86_400_000),
      decidingOfficerUserId: officerUserId,
      rejectionReason: 'Could not verify identity against the provided roll entry.'
    })

    const resubmissionPayload: RegisterInit = {
      registrant: { id: 'fixture-registrant-resubmission-1', authorityId, expiration: iso(now + 365 * 86_400_000) },
      public: { lastName: 'Chen', firstName: 'Priya' },
      private: { expiration: iso(now + 365 * 86_400_000), details: [] }
    }
    this.registrationRequests.set('fixture-request-pending-repeat', {
      id: 'fixture-request-pending-repeat',
      authorityId,
      payload: resubmissionPayload,
      submittedAt: iso(now - 30_000),
      receivedAt: iso(now - 30_000),
      requesterKey: repeatRequesterKey,
      issuerType: 'registrant',
      bridgeId: null,
      status: 'p'
    })

    // D-43/D-44 (Phase 62 Plan 19): a look-alike PENDING pair — same public name, no dob
    // conflict, two DIFFERENT requester keys — so `getLikelyDuplicateRequests` has something to
    // flag against a fresh mock. Checked first: none of the four fixtures above form such a pair
    // (the two PENDING entries, `fixture-request-bridge-1` and `fixture-request-pending-repeat`,
    // carry different names). Both land in the SAME authority as every other fixture above, and
    // neither touches `this.registrants` (same "no exact-count-assertion contamination" rule the
    // comment below states for `approvedRegistrantId`).
    const duplicatePairPayloadA: RegisterInit = {
      registrant: { id: 'fixture-registrant-duplicate-a', authorityId, expiration: iso(now + 365 * 86_400_000) },
      public: { lastName: 'Dupree', firstName: 'Sam' },
      private: { expiration: iso(now + 365 * 86_400_000), details: [] }
    }
    this.registrationRequests.set('fixture-request-pending-duplicate-a', {
      id: 'fixture-request-pending-duplicate-a',
      authorityId,
      payload: duplicatePairPayloadA,
      submittedAt: iso(now - 20 * 60_000),
      receivedAt: iso(now - 20 * 60_000),
      requesterKey: 'fixture-requester-duplicate-a',
      issuerType: 'registrant',
      bridgeId: null,
      status: 'p'
    })
    const duplicatePairPayloadB: RegisterInit = {
      registrant: { id: 'fixture-registrant-duplicate-b', authorityId, expiration: iso(now + 365 * 86_400_000) },
      public: { lastName: 'Dupree', firstName: 'Sam' },
      private: { expiration: iso(now + 365 * 86_400_000), details: [] }
    }
    this.registrationRequests.set('fixture-request-pending-duplicate-b', {
      id: 'fixture-request-pending-duplicate-b',
      authorityId,
      payload: duplicatePairPayloadB,
      submittedAt: iso(now - 10 * 60_000),
      receivedAt: iso(now - 10 * 60_000),
      requesterKey: 'fixture-requester-duplicate-b',
      issuerType: 'registrant',
      bridgeId: null,
      status: 'p'
    })

    // Deliberately does NOT also seed `this.registrants` — that Map is
    // shared with `listRegistrants`/`getRegistrant`, which several
    // pre-existing specs exercise against a FRESH `new
    // MockRegistrationEngine()` with exact-count assertions
    // (`registrant-list-query.spec.ts` et al.); adding an entry there would
    // silently contaminate those unrelated suites. See
    // `getRegistrationRequest`'s own comment for how `registrantId`
    // resolution compensates.
    const approvedRegistrantId = 'fixture-registrant-approved-1'
    const approvedPayload: RegisterInit = {
      registrant: { id: approvedRegistrantId, authorityId, expiration: iso(now + 365 * 86_400_000) },
      public: { lastName: 'Okafor', firstName: 'Amara' },
      private: { expiration: iso(now + 365 * 86_400_000), details: [] }
    }
    this.registrationRequests.set('fixture-request-approved-1', {
      id: 'fixture-request-approved-1',
      authorityId,
      payload: approvedPayload,
      submittedAt: iso(now - 5 * 86_400_000),
      receivedAt: iso(now - 5 * 86_400_000),
      requesterKey: 'fixture-requester-approved',
      issuerType: 'registrant',
      bridgeId: null,
      status: 'a',
      decidedAt: iso(now - 4 * 86_400_000),
      decidingOfficerUserId: officerUserId
    })
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

  /**
   * D-01/D-02: mirrors RegistrationEngine.recordRegistrantAccessEvent —
   * accountability/deterrence/regulatory posture only, NOT a security
   * control, and deliberately UNSIGNED (no ceremony). Derives the same
   * names-only allowlist from `RegistrantPrivate.PrivateDetails` via the
   * SAME shared `collectPrivateFieldNames`/`sanitizeAccessTrailFields`
   * functions the real engine uses, so the mock cannot disagree about what
   * may be recorded.
   */
  async recordRegistrantAccessEvent (registrantId: string, viewerUserId: string, fields: string[]): Promise<void> {
    const privateDetails: PrivateDetail[] | undefined = this.registrantPrivates.get(registrantId)?.privateDetails
    const allowedNames = collectPrivateFieldNames(privateDetails)
    const safeFields = sanitizeAccessTrailFields(fields, allowedNames)
    if (safeFields.length === 0) return

    const existing = this.registrantAccessEvents.get(registrantId) ?? []
    // `sequence: existing.length` reproduces the real engine's
    // `coalesce(max(Sequence), -1) + 1` because this array is append-only
    // and never deleted from (see the field's own doc comment).
    existing.push({
      registrantId,
      viewerUserId,
      sequence: existing.length,
      timestamp: new Date().toISOString(),
      fields: safeFields
    })
    this.registrantAccessEvents.set(registrantId, existing)
  }

  /** D-01: mirrors RegistrationEngine.getRegistrantAccessEvents — newest first, a copy (never the stored array by reference). */
  async getRegistrantAccessEvents (registrantId: string): Promise<RegistrantAccessEvent[]> {
    const events = this.registrantAccessEvents.get(registrantId) ?? []
    return [...events].sort((a, b) => b.sequence - a.sequence)
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

  /** D-17: authority-only roster — in-memory Map set, no signing. */
  async enrollElectionRegistrant (electionId: string, registrantId: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionRegistrants.set(`${electionId}/${registrantId}`, { electionId, registrantId })
  }

  /** D-17: authority-only roster — in-memory Map delete, no signing. */
  async removeElectionRegistrant (electionId: string, registrantId: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionRegistrants.delete(`${electionId}/${registrantId}`)
  }

  /** D-07: mirrors RegistrationEngine.getElectionRegistrants — real enrolled pairs, not always []. */
  async getElectionRegistrants (electionId: string): Promise<ElectionRegistrant[]> {
    return [...this.electionRegistrants.values()].filter((r) => r.electionId === electionId)
  }

  /**
   * D-04/D-07: in-memory parity for `listRegistrants`, applying filter
   * dimensions in the SAME predicate order as the real engine's SQL fragment
   * (`registrant-list-query.ts`). The mock stores one CURRENT public row per
   * registrant, so the D-06 currency question is structurally absent here —
   * that invariant lives entirely in `REGISTRANT_PUBLIC_CURRENCY_JOIN` on the
   * real engine.
   */
  async listRegistrants (filter?: RegistrantListFilter, page?: RegistrantListPage): Promise<RegistrantListResult> {
    let candidates = [...this.registrants.values()]

    if (filter?.authorityId !== undefined) {
      candidates = candidates.filter((r) => r.authorityId === filter.authorityId)
    }
    if (filter?.status !== undefined) {
      candidates = candidates.filter((r) => r.status === filter.status)
    }
    if (filter?.expiringBefore !== undefined) {
      candidates = candidates.filter((r) => String(r.expiration) < filter.expiringBefore!)
    }
    if (filter?.expiringAfter !== undefined) {
      candidates = candidates.filter((r) => String(r.expiration) > filter.expiringAfter!)
    }
    if (filter?.district !== undefined) {
      candidates = candidates.filter((r) => this.registrantPublics.get(r.id)?.district === filter.district)
    }
    if (filter?.electionId !== undefined) {
      candidates = candidates.filter((r) => this.electionRegistrants.has(`${filter.electionId}/${r.id}`))
    }
    if (filter?.name !== undefined) {
      // The ONE mock/real parity assumption in this method: mirrors SQL
      // `like '%q%'` with a case-insensitive substring test. 47-06 confirms
      // Quereus `like`'s actual case behavior against a real DB fixture and
      // reconciles the mock if it differs.
      const q = filter.name.toLowerCase()
      candidates = candidates.filter((r) => {
        const pub = this.registrantPublics.get(r.id)
        return (pub?.lastName ?? '').toLowerCase().includes(q) || (pub?.firstName ?? '').toLowerCase().includes(q)
      })
    }

    // Sort ascending by id with a plain relational comparison — a
    // locale-collation-aware string comparator would diverge from the SQL
    // `order by R.Id asc` text ordering and break keyset parity.
    candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    const total = page?.cursor === undefined ? candidates.length : undefined

    const cursor = page?.cursor
    const afterCursor = cursor === undefined ? candidates : candidates.filter((r) => r.id > cursor)
    const pageSize = clampPageSize(page?.pageSize)
    const pageRegistrants = afterCursor.slice(0, pageSize)

    const rows: RegistrantListRow[] = pageRegistrants.map((r) => {
      const pub = this.registrantPublics.get(r.id)
      return {
        registrantId: r.id,
        authorityId: r.authorityId,
        status: r.status,
        expiration: String(r.expiration),
        privateCid: r.privateCid,
        publicCid: r.publicCid,
        selectiveCid: r.selectiveCid,
        lastName: pub?.lastName,
        firstName: pub?.firstName,
        district: pub?.district
      }
    })

    const nextCursor = rows.length === pageSize ? rows[rows.length - 1]!.registrantId : undefined

    return { rows, nextCursor, total }
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

  /** D-14b: policy declaration — in-memory Map set (upsert), no signing (additive, mirrors addElectionRegistrationField). */
  async setElectionAttestationPolicy (electionId: string, attestationRequired: boolean, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionAttestationPolicies.set(electionId, { electionId, attestationRequired })
  }

  /** D-14b: returns `undefined` when absent — do NOT synthesize a `true` default (the fail-closed rule is the UI's job). */
  async getElectionAttestationPolicy (electionId: string): Promise<ElectionAttestationPolicy | undefined> {
    return this.electionAttestationPolicies.get(electionId)
  }

  /** D-07: revert-to-default — in-memory Map delete, no signing. */
  async removeElectionAttestationPolicy (electionId: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionAttestationPolicies.delete(electionId)
  }

  // ---------- Registration Request protocol + approval inbox (Phase 48) ----------
  // Throwing stub bodies only — 48-05 declares the contract; 48-07 (intake +
  // bridge registry), 48-08 (read surface + stats), and 48-12 (rejection)
  // replace these with real mock parity implementations. A stub MUST throw
  // and MUST NOT return a plausible empty value.

  /**
   * Mock parity — verifies NO signature, enforces NO CHECK, applies NO skew
   * bound. Exists for navigation/legibility only; a passing screen test here
   * proves an affordance, not a boundary (the same DECLARED BLIND SPOT
   * discipline the app suite already uses). `init.submittedAt` is stored
   * unmodified; `receivedAt` is a mock-stamped observation. Never calls
   * `signatureOrCallback` and never fabricates a `Signature`.
   */
  async submitRegistrationRequest (init: RegistrationRequestInit, requesterKey: string, _signatureOrCallback: SignatureOrCallback): Promise<string> {
    this.registrationRequests.set(init.id, {
      id: init.id,
      authorityId: init.authorityId,
      payload: init.payload,
      submittedAt: init.submittedAt,
      requesterKey,
      issuerType: init.issuerType ?? 'registrant',
      bridgeId: init.bridgeId ?? null,
      receivedAt: new Date().toISOString(),
      status: 'p'
    })
    return init.id
  }

  /** Mock parity — verifies NO signature, enforces NO CHECK. See submitRegistrationRequest's comment. */
  async registerBridgeKey (init: RegistrationBridgeKeyInit, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.registrationBridgeKeys.set(init.id, { id: init.id, authorityId: init.authorityId, label: init.label, key: init.key })
  }

  async listBridgeKeys (authorityId: string): Promise<RegistrationBridgeKey[]> {
    return [...this.registrationBridgeKeys.values()].filter((k) => k.authorityId === authorityId)
  }

  /**
   * D-06/D-09/T-48-08-11: in-memory parity for the triage list read —
   * oldest-`receivedAt`-first with an `id` tiebreak (mirrors the real
   * engine's order key EXACTLY; a mock that sorted by `submittedAt` would
   * teach the wave-7 screens the WRONG ordering contract), honoring the
   * SAME three filter dimensions in the SAME AND semantics.
   */
  async listRegistrationRequests (filter?: RegistrationRequestListFilter, page?: RegistrationRequestListPage): Promise<RegistrationRequestListResult> {
    let candidates = [...this.registrationRequests.values()]
    if (filter?.authorityId !== undefined) candidates = candidates.filter((r) => r.authorityId === filter.authorityId)
    if (filter?.status !== undefined) candidates = candidates.filter((r) => r.status === filter.status)
    // Mirrors the real engine's registrationRequestNotClosedSql: the pending filter drops closed/closing rows.
    if (filter?.status === 'p') candidates = candidates.filter((r) => !this.duplicateClosures.has(r.id))
    if (filter?.issuerType !== undefined) candidates = candidates.filter((r) => r.issuerType === filter.issuerType)
    if (filter?.name !== undefined) {
      const q = filter.name.toLowerCase()
      candidates = candidates.filter((r) => {
        const pub = r.payload.public
        return (pub?.lastName ?? '').toLowerCase().includes(q) || (pub?.firstName ?? '').toLowerCase().includes(q)
      })
    }

    // Oldest-receivedAt-first, id tiebreak — NEVER submittedAt (T-48-08-11).
    candidates.sort((a, b) => {
      if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    const total = page?.cursor === undefined ? candidates.length : undefined
    const cursor = page?.cursor
    // WR-09: the keyset predicate must key on the SAME column the sort above orders by. The
    // previous form was `r.id > cursor` while the sort compares `receivedAt` with an `id`
    // tiebreak — exactly the half-migration registration-request-query.ts's own header warns
    // about ("a predicate that still compares [the wrong column] while the order by compares
    // ReceivedAt typechecks perfectly and pages WRONG"). With ids uncorrelated to arrival order,
    // page 2 silently dropped and repeated rows — and because this mock backs the screens'
    // dev/test paths, it taught the WRONG paging contract.
    //
    // Both branches below key on `receivedAt`: "received-after OR (received-equal AND id-after)"
    // — the same two-branch shape buildRegistrationRequestListPageSql binds against the real DB.
    // (listRegistrants above deliberately keeps a bare `id > cursor`: THAT read orders by
    // `R.Id asc`, so there the predicate and the order key already agree.)
    const cursorRow = cursor === undefined ? undefined : this.registrationRequests.get(cursor)
    // An unresolvable (stale or fabricated) cursor degrades to an EMPTY page and must NOT fall
    // back to an un-cursored first page — the real engine's own rule (T-48-08-06,
    // registration-engine.ts's `if (!cursorRow) return { rows: [] }`); that fallback would make
    // `loadMore` restart the list forever.
    if (cursor !== undefined && cursorRow === undefined) return { rows: [], nextCursor: undefined, total }
    const afterCursor =
      cursorRow === undefined
        ? candidates
        : candidates.filter(
            (r) =>
              r.receivedAt > cursorRow.receivedAt ||
              (r.receivedAt === cursorRow.receivedAt && r.id > cursorRow.id)
          )
    const pageSize = clampPageSize(page?.pageSize)
    const pageRows = afterCursor.slice(0, pageSize)

    const rows: RegistrationRequestListRow[] = pageRows.map((r) => {
      const bridgeLabel = r.bridgeId ? this.registrationBridgeKeys.get(r.bridgeId)?.label : undefined
      // ONE pass over the map per row here is fine at fixture/mock scale —
      // the real engine's ONE-grouped-query discipline (T-48-08-06) is what
      // matters against a real database, not this in-memory parity layer.
      const hasPriorRejections = [...this.registrationRequests.values()].some(
        (other) => other.requesterKey === r.requesterKey && other.status === 'r' && other.id !== r.id
      )
      const closure = this.duplicateClosures.get(r.id)
      return {
        requestId: r.id,
        authorityId: r.authorityId,
        status: r.status as RegistrationRequestStatus,
        issuerType: r.issuerType as RegistrationRequestIssuerType,
        bridgeId: r.bridgeId ?? undefined,
        bridgeLabel,
        submittedAt: r.submittedAt,
        receivedAt: r.receivedAt,
        lastName: r.payload.public?.lastName,
        firstName: r.payload.public?.firstName,
        hasPriorRejections,
        ...(closure !== undefined ? { duplicateClosure: closure } : {})
      }
    })

    const nextCursor = rows.length === pageSize ? rows[rows.length - 1]!.requestId : undefined
    return { rows, nextCursor, total }
  }

  /** Mock parity for the point read — verifies NO signature, applies NO CHECK. registrantId mirrors the real engine's existence-probe discipline against the mock's own `registrants` map. */
  async getRegistrationRequest (requestId: string): Promise<RegistrationRequestRead | undefined> {
    const r = this.registrationRequests.get(requestId)
    if (!r) return undefined

    // Mock simplification (declared, not a security-relevant gap — this
    // class already carries the file's "verifies no signature, enforces no
    // CHECK" disclaimer throughout): reports payload.registrant.id directly
    // for an approved row WITHOUT probing `this.registrants` for existence.
    // The real engine's `getRegistrationRequest` DOES run that probe and it
    // IS load-bearing there (T-48-08-05) — the mock skips it only so the
    // fixture rows below don't have to also seed `this.registrants`, which
    // is shared with `listRegistrants`/`getRegistrant` and exercised by
    // unrelated pre-existing specs against a fresh, otherwise-empty mock.
    const registrantId = r.status === 'a' ? r.payload.registrant?.id : undefined

    return {
      requestId: r.id,
      authorityId: r.authorityId,
      requesterKey: r.requesterKey,
      issuerType: r.issuerType as RegistrationRequestIssuerType,
      bridgeId: r.bridgeId ?? undefined,
      bridgeLabel: r.bridgeId ? this.registrationBridgeKeys.get(r.bridgeId)?.label : undefined,
      payload: r.payload,
      payloadCid: `mock-payload-cid-${r.id}`,
      status: r.status as RegistrationRequestStatus,
      submittedAt: r.submittedAt,
      receivedAt: r.receivedAt,
      decidedAt: r.decidedAt,
      decidingOfficerUserId: r.decidingOfficerUserId,
      rejectionReason: r.rejectionReason,
      verificationCid: r.verificationCid,
      // Not recovered in the mock (no D-07 digest primitive without a real
      // DB) — the mock's own declared blind spot. The real engine's
      // recoverVerificationChecklist owns this.
      verificationChecklist: undefined,
      registrantId
    }
  }

  /** D-06: in-memory parity, key-scoped (not authority-scoped), newest-`decidedAt`-first. `excludeRequestId` mirrors the `other.id !== r.id` idiom from `hasPriorRejections` above — an omitted argument excludes nothing. */
  async getPriorRejections (requesterKey: string, excludeRequestId?: string): Promise<PriorRejection[]> {
    return [...this.registrationRequests.values()]
      .filter((r) => r.requesterKey === requesterKey && r.status === 'r' && r.id !== excludeRequestId)
      .sort((a, b) => {
        const aAt = a.decidedAt ?? ''
        const bAt = b.decidedAt ?? ''
        if (aAt !== bAt) return aAt < bAt ? 1 : -1
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
      })
      .map((r) => ({
        requestId: r.id,
        rejectedAt: r.decidedAt ?? '',
        rejectionReason: r.rejectionReason ?? '',
        decidingOfficerUserId: r.decidingOfficerUserId ?? ''
      }))
  }

  /** D-09: in-memory parity — counts + a median measured from receivedAt, matching the real engine's measurement basis. NO rating/score/rank surface. */
  async getRegistrationTransparencyStats (authorityId: string): Promise<RegistrationTransparencyStats> {
    const rows = [...this.registrationRequests.values()].filter((r) => r.authorityId === authorityId)
    // Mirrors registration-engine.ts getRegistrationTransparencyStats: pending excludes rows closed or
    // closing as duplicates, which are reported separately (present only when > 0).
    const pendingRows = rows.filter((r) => r.status === 'p')
    const closedAsDuplicate = pendingRows.filter((r) => this.duplicateClosures.has(r.id)).length
    const pending = pendingRows.length - closedAsDuplicate
    const approved = rows.filter((r) => r.status === 'a').length
    const rejected = rows.filter((r) => r.status === 'r').length

    const deltas = rows
      .filter((r) => r.decidedAt !== undefined)
      .map((r) => Date.parse(r.decidedAt!) - Date.parse(r.receivedAt))
      .filter((d) => Number.isFinite(d) && d >= 0)
      .sort((a, b) => a - b)

    let medianTimeToDecisionMs: number | undefined
    if (deltas.length > 0) {
      const mid = Math.floor(deltas.length / 2)
      medianTimeToDecisionMs = deltas.length % 2 === 1
        ? deltas[mid]!
        : Math.round((deltas[mid - 1]! + deltas[mid]!) / 2)
    }

    return closedAsDuplicate > 0
      ? { pending, approved, rejected, medianTimeToDecisionMs, closedAsDuplicate }
      : { pending, approved, rejected, medianTimeToDecisionMs }
  }

  async rejectRegistrationRequest (_requestId: string, _decision: RegistrationRequestDecision, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    // CONTRACT STUB — replaced by 48-12 (rejection)
    throw new Error('rejectRegistrationRequest is not implemented')
  }

  // ---------- D-44 duplicate detection and closure (Phase 62 Plan 19) ----------

  /**
   * D-44 mock parity: builds `DuplicateComparable`s from this map's PENDING entries of the
   * target's own authority (the mock holds no `RegistrationDecision` table, so every pending
   * entry is implicitly "not closed") and runs the SAME shared matcher the real engine uses.
   */
  async getLikelyDuplicateRequests (requestId: string): Promise<LikelyDuplicateRequest[]> {
    const target = this.registrationRequests.get(requestId)
    if (!target || target.status !== 'p') return []

    const pending = [...this.registrationRequests.values()].filter((r) => r.status === 'p' && r.authorityId === target.authorityId)
    const comparables: DuplicateComparable[] = pending.map((r) => ({
      requestId: r.id,
      authorityId: r.authorityId,
      requesterKey: r.requesterKey,
      receivedAt: r.receivedAt,
      identity: extractRegistrationIdentity(r.payload)
    }))
    const targetComparable = comparables.find((c) => c.requestId === requestId)
    if (!targetComparable) return []

    const byId = new Map(pending.map((r) => [r.id, r]))
    return findLikelyDuplicates(targetComparable, comparables).map((m) => {
      const r = byId.get(m.comparable.requestId)!
      return {
        requestId: r.id,
        authorityId: r.authorityId,
        issuerType: r.issuerType as RegistrationRequestIssuerType,
        submittedAt: r.submittedAt,
        receivedAt: r.receivedAt,
        firstName: r.payload.public?.firstName,
        lastName: r.payload.public?.lastName,
        matchedOn: m.matchedOn
      }
    })
  }

  /** D-44 mock parity: a request is closed only when a test marked it via `markDuplicateClosure`. */
  async getDuplicateClosure (requestId: string): Promise<RegistrationDuplicateClosure | undefined> {
    const state = this.duplicateClosures.get(requestId)
    if (state === undefined) return undefined
    const details = this.duplicateClosureDetails.get(requestId) ?? { closedByRequestId: null }
    return { requestId, state, closedByRequestId: details.closedByRequestId, ...(details.closedAt !== undefined ? { closedAt: details.closedAt } : {}) }
  }

  /** D-44 mock parity: the mock publishes no decisions, so nothing is ever "unpublished". */
  async listUnpublishedRegistrationDecisions (_authorityId: string): Promise<string[]> {
    return []
  }

  async publishRegistrationDecision (
    _publisher: RegistrationDecisionPublishPort,
    _requestId: string,
    _options?: RegistrationDecisionPublishOptions
  ): Promise<RegistrationDecisionPublishResult> {
    // CONTRACT STUB — the mock holds no RegistrationDecision table
    throw new Error('publishRegistrationDecision is not implemented')
  }

  async completeDuplicateClosures (_publisher: RegistrationDecisionPublishPort): Promise<RegistrationDuplicateClosureRepairReport> {
    // CONTRACT STUB — the mock holds no RegistrationDecision table
    throw new Error('completeDuplicateClosures is not implemented')
  }
}
