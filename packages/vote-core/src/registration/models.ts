import type { Signature, Timestamp } from '../common/index.js'

/** ********* Enums (D-08, text codes — avoids the number/boolean-in-Digest pitfalls) ***********/

/** RegistrantTier(Code) — which content-addressed tier a field's value lands in. */
export type RegistrantTier = 'public' | 'selective' | 'private'

/** FieldRequirement(Code) — whether a policy-declared field is mandatory at Register time. */
export type FieldRequirement = 'required' | 'optional'

/** RegistrantStatus(Code) — Active / Suspended / Revoked. */
export type RegistrantStatus = 'a' | 's' | 'r'

/** ********* Registrant (core, admin-signed under 'vrg') ***********/
export interface Registrant {
  /** 32 byte random unique registrant identifier */
  id: string

  /** Authority that validated this registrant */
  authorityId: string

  /** Content-addressed hash of the registrant's private data (never null — every registrant has a private tier) */
  privateCid: string

  /** Content-addressed hash of the registrant's public data (undefined if no public data) */
  publicCid?: string

  /** Content-addressed hash of the registrant's selective-disclosure data (undefined if none) */
  selectiveCid?: string

  /** references RegistrantStatus(Code) */
  status: RegistrantStatus

  expiration: Timestamp | string

  /** Public key of the authority signor */
  signorKey: string

  /** Signature of this record by the signor */
  signature: string
}

/** ********* RegistrantPublic (D-18: fixed columns + ExtraFields json) ***********/
export interface RegistrantPublic {
  /** Content-addressed hash of this record */
  cid: string

  /** references Registrant.id */
  registrantId: string

  lastName?: string
  firstName?: string
  district?: string

  /** Authority/election-specific extra public fields, resolved via json_extract/json_each */
  extraFields?: Record<string, unknown>
}

/**
 * Recursive private-detail attribute triple (RegistrantPrivate.PrivateDetails, D-21).
 * `value` is either a scalar (top-level field) or a nested array of triples (an object).
 * Never disclosed — the selectively-disclosable tier is a separate record (RegistrantSelective).
 */
export interface PrivateDetail {
  name: string
  value: string | number | boolean | PrivateDetail[]
  hint?: string
}

/** ********* RegistrantPrivate (authority-held, insert-only, 'vrg'-signed) ***********/
export interface RegistrantPrivate {
  /** Content-addressed hash of this record */
  cid: string

  /** references Registrant.id */
  registrantId: string

  expiration: Timestamp | string

  /** json array of { name, value, hint? } triples (recursive); never disclosed */
  privateDetails?: PrivateDetail[]

  /**
   * D-49: how `privateDetails` was read on THIS device. Optional — undefined when the reading
   * engine does not report it (e.g. `MockRegistrationEngine`); the real `RegistrationEngine`
   * always sets it. See `RegistrationContentAccess`'s own doc comment for the full vocabulary.
   */
  detailsAccess?: RegistrationContentAccess
}

/**
 * D-49: how a stored registration payload / private tier was read on THIS device.
 *
 * - `'opened'`          sealed envelope, opened with this device's officer key, PayloadCid recheck passed
 * - `'unsealed'`        stored without sealing (a pre-D-49 legacy row, or the constant '[]' for empty
 *                        private details), PayloadCid recheck passed where one applies
 * - `'no-opener'`       sealed, and this context has no opener (a voter, a host that has not wired one,
 *                        or no local key)
 * - `'not-a-recipient'` sealed, and this device's key is not among its recipients (e.g. an officer added
 *                        later, D-51)
 * - `'unreadable'`      malformed envelope, failed authentication, vault error, or plaintext that is not
 *                        the expected JSON shape
 * - `'tampered'`        Digest(opened or unsealed plaintext) !== PayloadCid (RegistrationRequest only)
 */
export type RegistrationContentAccess =
  'opened' | 'unsealed' | 'no-opener' | 'not-a-recipient' | 'unreadable' | 'tampered'

/**
 * Flat salted-leaf disclosure attribute (RegistrantSelective.SelectiveDetails, D-11/D-12/D-13).
 * Committed via the crypto plugin's set_commit as
 * leafDigest = digest([SD_LEAF_DOMAIN, name, value, salt]); Cid = cid(set_commit(SelectiveDetails))
 * over the sorted leaf digests (Optimystic issue #5 — the landed flat-set design, NOT a Merkle tree).
 */
export interface SaltedLeaf {
  name: string
  value: string | number | boolean
  /** random_bytes (>=128 bits); duplicate names and empty salts are rejected at commit */
  salt: string
}

/**
 * Alias for {@link SaltedLeaf}, mirroring the crypto plugin's own `SaltedLeaf`
 * naming (`@optimystic/quereus-plugin-crypto/src/sd.ts`) at the Register-flow
 * selective-disclosure surface (D-11/D-12/D-13/D-14) — the stored, salted
 * `{ name, value, salt }` shape returned by `getDisclosedSelective` (both the
 * revealed `disclosed` leaves and, structurally, the withheld ones before
 * they're reduced to opaque hidden digests).
 */
export type SelectiveLeaf = SaltedLeaf

/**
 * One caller-supplied selective-disclosure field input for the Register flow
 * (D-13). Deliberately carries NO `salt` — the engine generates a fresh
 * `random_bytes` (>=128 bits) salt per leaf at commit time; a caller-supplied
 * salt would defeat the "authority alone can enforce uniqueness / freshness"
 * property `assertUniqueNames`/`requireSaltBytes` rely on authority-side.
 */
export interface SelectiveFieldInput {
  name: string
  value: string | number | boolean
}

/**
 * Draft payload for the Register flow's optional selective-disclosure tier
 * (D-11/D-12/D-13) — an ORDERED list of `{ name, value }` field inputs, salts
 * omitted (engine-generated). Duplicate names are rejected before the DB
 * ceremony (D-13); an absent or empty list means no `RegistrantSelective`
 * row is ever created (Pitfall 3 — `set_commit` is never invoked on NULL).
 */
export type RegisterSelectivePayload = SelectiveFieldInput[]

/** ********* RegistrantSelective (authority-held, insert-only, 'vrg'-signed) ***********/
export interface RegistrantSelective {
  /** Content-addressed CIDv1 of the PLAINTEXT leaves: cid(set_commit(<plaintext leaves>)) */
  cid: string

  /** references Registrant.id */
  registrantId: string

  expiration: Timestamp | string

  /** json array of flat { name, value, salt } salted leaves (SaltedLeaf[]) */
  selectiveDetails?: SaltedLeaf[]

  /**
   * D-52: how `selectiveDetails` was read on THIS device. `selectiveDetails` is `undefined`
   * unless this is `'opened'` or `'unsealed'`. Undefined = not reported (e.g. `MockRegistrationEngine`).
   */
  detailsAccess?: RegistrationContentAccess
}

/**
 * Result of `getDisclosedSelective` (D-14) — a per-field disclosure of a
 * registrant's `RegistrantSelective` set, filtered by `ElectionDisclosurePolicy`
 * for the caller's audience. `root` is the BARE `set_commit(SelectiveDetails)`
 * value (base64url) that `setVerify(root, { disclosed, hidden })` checks
 * against — NOT the `cid()`-wrapped `SelectiveCid` (`cid` is included purely
 * for linkage back to `Registrant.selectiveCid` / the `RegistrantSelective`
 * row). `disclosed` carries the revealed `(name, value, salt)` triples;
 * `hidden` carries only opaque leaf digests (base64url) of the withheld
 * leaves — no name, no value, no salt ever crosses this boundary.
 */
export interface DisclosedSelective {
  cid: string
  root: string
  disclosed: SelectiveLeaf[]
  hidden: string[]

  /**
   * D-52: how the underlying `RegistrantSelective` leaves were read on THIS device. When it is not
   * `'opened'` or `'unsealed'`, `disclosed` and `hidden` are empty and `root` is `''`.
   * Undefined = not reported (e.g. the mock engine).
   */
  access?: RegistrationContentAccess
}

/** DisclosureAudience(Code) — which recipients a selective field may be revealed to. */
export type DisclosureAudience = 'district' | 'everyone'

/**
 * Election policy: which `RegistrantSelective` field names may be disclosed,
 * and to which audience (D-14). Companion to `ElectionRegistrationField` —
 * same 'mel'-signed, election-keyed shape. Delivery/filtering of disclosed
 * data to recipients is handled off-schema by `getDisclosedSelective` at
 * query time (no on-network disclosure record).
 */
export interface ElectionDisclosurePolicy {
  /** references Election.id */
  electionId: string

  /** a top-level attribute name within RegistrantSelective.SelectiveDetails */
  fieldName: string

  /** references DisclosureAudience(Code) */
  audience: DisclosureAudience
}

/**
 * Election policy: whether this election requires device attestation to Associate (D-14a/b).
 * Single row per election (admin-signed 'mel', keyed by electionId alone). Companion to
 * ElectionDisclosurePolicy/ElectionRegistrationField (same 'mel'-signed, election-keyed shape).
 * Fail-closed enforcement (no row => attestation required) is engine-side at the associate()
 * read (45-04) — this interface only describes the stored policy row itself.
 */
export interface ElectionAttestationPolicy {
  /** references Election.id */
  electionId: string

  /** true = attestation required (fail-closed default), false = not required */
  attestationRequired: boolean
}

/** ********* ElectionRegistrant (roster, authority-only 'vrg'-signed insert/delete) ***********/
export interface ElectionRegistrant {
  /** references Election.id */
  electionId: string

  /** references Registrant.id */
  registrantId: string
}

/** ********* RegistrantPrivate access trail (D-01/D-02) ***********/

/**
 * Authority-held, append-only record of app-mediated reads of a registrant's
 * private tier (D-01). Like `RegistrantPrivate` itself, it is never
 * replicated to the public Election Network. It exists for accountability,
 * deterrence, and regulatory posture and is **not a security control** — an
 * officer holding the device and the local Quereus/LevelDB file can read
 * that file directly, and no row is written by that path.
 */
export interface RegistrantAccessEvent {
  /** references Registrant.id */
  registrantId: string

  /**
   * The officer's User.Id. There is deliberately no foreign-key CHECK on
   * this column in the schema, so a caller must tolerate an id it cannot
   * resolve to a display name.
   */
  viewerUserId: string

  /**
   * Per-registrant monotonic ordering key starting at 0 (the `UserEvent`
   * idiom); it is not a `Tid` and does not reset per process.
   */
  sequence: number

  /**
   * Z-suffixed ISO — the engine re-stamps the Z-stripped `datetime`
   * read-back (CR-02), so a caller's `new Date(timestamp)` reads UTC and not
   * host-local time.
   */
  timestamp: string

  /**
   * The NAMES of the private attributes revealed during one screen-visit,
   * never their values. Names are filtered engine-side against the
   * registrant's own `RegistrantPrivate.PrivateDetails` vocabulary, so a
   * value handed in by a caller is dropped rather than stored.
   */
  fields: string[]
}

/** ********* Registrant roster read (D-04/D-05/D-06/D-07) ***********/

/**
 * Filter dimensions for `listRegistrants` (D-04: one method, one optional
 * filter object — no separate `searchRegistrants`). Every field is OPTIONAL;
 * every dimension supplied is ANDed with the others, never ORed.
 *
 * `name` performs a substring match against `RegistrantPublic.LastName`/
 * `FirstName` via SQL `like`, with NO wildcard escaping — a query containing
 * a literal `%` or `_` broadens the match beyond a plain substring. This is a
 * deliberate, documented omission (47-RESEARCH.md Open Question 2), not an
 * oversight, and is not a security issue: the query is local, non-networked,
 * and already `'vrg'`-scope-gated.
 *
 * `expiringBefore`/`expiringAfter` are ISO-Z datetime strings compared
 * directly against `Registrant.Expiration`, which the schema already
 * constrains to `isISODatetime` + `like('%Z', …)`, so plain string comparison
 * is chronological.
 */
export interface RegistrantListFilter {
  /**
   * When omitted, results span every authority present in the local
   * database. Every UI caller supplies it (the `RegistrantsList` route
   * carries a required `authorityId`); omission exists only so a non-UI
   * caller can read the whole local roster.
   */
  authorityId?: string
  status?: RegistrantStatus
  expiringBefore?: string
  expiringAfter?: string
  district?: string
  electionId?: string
  name?: string
}

/**
 * Keyset paging input for `listRegistrants` (D-05). `cursor` is the previous
 * page's `nextCursor`, which is the last row's `registrantId` verbatim — not
 * an encoded token.
 */
export interface RegistrantListPage {
  cursor?: string
  pageSize?: number
}

/**
 * One roster row (D-06). Deliberately omits `Registrant.SignorKey` and
 * `Registrant.Signature` and touches no `RegistrantPrivate`/
 * `RegistrantSelective` column — the roster read must not widen the
 * disclosure surface of the existing point reads (threat `T-47-05`).
 * `lastName`/`firstName`/`district` come from the CURRENT `RegistrantPublic`
 * row only (D-06) — never a stale historical row.
 */
export interface RegistrantListRow {
  registrantId: string
  authorityId: string
  status: RegistrantStatus
  expiration: string
  privateCid: string
  publicCid?: string
  selectiveCid?: string
  lastName?: string
  firstName?: string
  district?: string
}

/**
 * Result of `listRegistrants` (D-05). `total` is populated only on a
 * cursor-absent (first-page) call; it is `undefined` on paged calls AND when
 * the count query itself failed. `total` and `rows.length` may honestly
 * disagree by a row or two under concurrent mutation — this is explicitly not
 * an error state.
 */
export interface RegistrantListResult {
  rows: RegistrantListRow[]
  nextCursor?: string
  total?: number
}

/**
 * Per-election registration field policy (D-08/D-09/D-10). Declares which
 * registrant detail fields an election expects, which tier each belongs to,
 * and whether furnishing it is required. Companion to ElectionDisclosurePolicy.
 * Admin-signed under 'mel', keyed by ElectionId (election-scoped, not network-wide).
 * Enforcement that a Register submission furnishes the Required fields is
 * engine-side at Register time — this table only declares the policy.
 */
export interface ElectionRegistrationField {
  /** references Election.id */
  electionId: string

  /** Attribute name (a RegistrantPublic column / ExtraFields key, or a top-level name within SelectiveDetails / PrivateDetails) */
  fieldName: string

  /** references RegistrantTier(Code) */
  tier: RegistrantTier

  /** references FieldRequirement(Code) */
  requirement: FieldRequirement
}

/**
 * Draft payload for the Register builder (D-02). Carries the Registrant core
 * fields plus the optional Public/Private/Selective tier payloads; `private`
 * is required because Registrant.PrivateCid is never null on the schema.
 *
 * `electionId` (D-10, 42-07) scopes the submission to the ElectionRegistrationField
 * policy the engine enforces at Register time (D-09) — optional so a
 * submission with no election context (no field policy to enforce against)
 * behaves exactly as before this field was added.
 */
export interface RegisterInit {
  /** references Election.id — when present, gates the submission against that election's ElectionRegistrationField policy (D-09/D-10) */
  electionId?: string

  registrant: {
    id: string
    authorityId: string
    expiration: Timestamp | string
  }

  public?: {
    lastName?: string
    firstName?: string
    district?: string
    extraFields?: Record<string, unknown>
  }

  private: {
    expiration: Timestamp | string
    details: PrivateDetail[]
  }

  /**
   * D-11/D-12/D-13: optional selective-disclosure tier. `details` carries
   * PLAIN `{ name, value }` field inputs — no salt (engine-generated, D-13).
   * Absent or empty means no `RegistrantSelective` row is created at all
   * (Pitfall 3: `set_commit` is never invoked on NULL/absent details).
   */
  selective?: {
    expiration: Timestamp | string
    details: RegisterSelectivePayload
  }
}

/** ********* Registration Request protocol + approval inbox (Phase 48) ***********/

/** RegistrationRequestStatus(Code) — Pending / Approved / Rejected, mirrors `view RegistrationRequestStatus` (48-02). */
export type RegistrationRequestStatus = 'p' | 'a' | 'r'

/** RegistrationRequestIssuerType(Code) — who submitted the request, mirrors `view RegistrationRequestIssuer` (D-03). */
export type RegistrationRequestIssuerType = 'registrant' | 'bridge'

/**
 * D-07's four-item checklist vocabulary, matching the UI-SPEC's
 * `verificationChecklistItem*` i18n keys. This is the ONE declaration of the
 * union — the pure checklist module (serialization, `verificationCid`,
 * `isChecklistGateMet`) MUST import this alias rather than re-declaring it;
 * two declarations here would let the digest and the gate drift apart.
 * `'none'` is mutually exclusive with the other three items, but that rule
 * is enforced by the pure predicate (`isChecklistGateMet`), not by this type.
 */
export type RegistrationVerificationChecklistItem = 'id' | 'roll' | 'eligibility' | 'none'

/**
 * What a submitter (voter device or bridge) supplies to submit a
 * registration request (D-02). Deliberately carries NO `userId`, `userKey`,
 * or `IsUserValid` field — a prospective registrant has no `User` row, and
 * the row's own requester-key self-signature is the entire authorization
 * gate.
 *
 * `submittedAt` is **required, canonical ISO-Z (trailing `Z`), and chosen by
 * the SUBMITTER at signing time.** It is the **seventh argument of DG-1**,
 * the digest the requester's own signature covers (48-02 `<digest_register>`
 * / **L-3**), and the offline courier binding (48-09) has the submitter sign
 * at **staging** time while the authority INSERTs at some later,
 * unobservable intake moment with an **already-resolved `Signature`, never a
 * callback**. If the engine generated this value, the signer could not have
 * known it and no offline signature would ever verify — **the engine
 * neither generates nor rewrites it.**
 *
 * Consequence: this is an **attacker-controlled** value inside a signed
 * tuple. It is bounded, not trusted — absolutely by the schema's
 * `SubmittedAtSaneValid` CHECK (48-02) and relatively by
 * `submitRegistrationRequest`'s skew guard (48-07: no more than **5 minutes
 * after**, or **30 days before**, the authority's `receivedAt`). The
 * authority's own observation is `receivedAt`, which is inside no digest and
 * is what the triage queue sorts by.
 */
export interface RegistrationRequestInit {
  id: string
  authorityId: string
  payload: RegisterInit
  submittedAt: string
  issuerType?: RegistrationRequestIssuerType
  bridgeId?: string
}

/**
 * 62-01 (D-45): the plaintext a 62-04 `SealedEnvelope` seals into
 * `RegistrationRequestStaging.InitJson`. `registrationCode` exists ONLY inside this ciphertext —
 * it is NEVER copied into `RegisterInit`, `RegistrationRequest.Payload`, or any schema column
 * (since D-49 `RegistrationRequest.Payload` is itself sealed, 62-31; the code stays out of it
 * regardless, because the Authority's strand path hands that table's own Quereus DB to every peer
 * on the strand).
 *
 * The durable carrier of the code is the `RegistrationRequestStaging` row itself (kept forever,
 * D-07; sealed, D-04) — an officer matches a re-association by opening the ORIGINAL staging row
 * after decrypt (62-18), with a constant-time compare. Known limits: an officer added AFTER the
 * registration is not a recipient of the old envelope and must use the identity fallback
 * ({@link AssociationStagingPlaintext.identityFields}); a registration that arrived by REST bridge
 * or filesystem import has no staging row at all and always uses the identity fallback.
 */
export interface RegistrationStagingPlaintext {
  version: 1
  init: RegistrationRequestInit
  registrationCode?: string

  /**
   * V-3 / D-45: the requester's signature over
   * `sha256(REGISTRATION_CODE_BINDING_DOMAIN + '\n' + requestId + '\n' + code)`, verified
   * officer-side against the approved `RegistrationRequest.RequesterKey`. Present whenever
   * `registrationCode` is (written by `P2pRegistrationTransport.submitRequest`); a row with a code
   * and no valid binding signature is never a code match: it reads `unverifiable` and never takes
   * the automatic route.
   */
  registrationCodeSignature?: Signature
}

/**
 * The single-request read backing the approval screen's three modes
 * (pending / approved / rejected).
 *
 * `receivedAt` is **required** (the column is not-null) — the authority's
 * own observation of intake time, written by the engine with
 * `toIsoZDatetime`, and inside **no** digest; it is not something the
 * requester attests to. It is surfaced beside `submittedAt` deliberately:
 * within the accepted skew window a submitter may state a `submittedAt`
 * that diverges from when the authority actually received the request, and
 * the only way a reviewing officer can see that divergence is if both
 * values reach the screen. **Never render one as the other, and never
 * substitute one for the other when the other is inconvenient.**
 *
 * `registrantId` is populated **only** for `status === 'a'` — it is the
 * `Registrant.Id` the approval's `register()` call produced, and it exists
 * because the UI-SPEC flags resolving an approved request to its registrant
 * as an **engine** dependency, not a UI decision (it backs the approved-mode
 * "View Registrant" CTA into the existing `RegistrantDetail` route).
 */
export interface RegistrationRequestRead {
  requestId: string
  authorityId: string
  requesterKey: string
  issuerType: RegistrationRequestIssuerType
  bridgeId?: string
  bridgeLabel?: string
  payload: RegisterInit
  payloadCid: string
  status: RegistrationRequestStatus
  submittedAt: string
  receivedAt: string
  decidedAt?: string
  decidingOfficerUserId?: string
  rejectionReason?: string
  verificationCid?: string
  verificationChecklist?: RegistrationVerificationChecklistItem[]
  registrantId?: string

  /**
   * D-49: how `payload` was read on THIS device (see `RegistrationContentAccess`'s doc comment).
   * Optional — undefined when the reading engine does not report it (e.g. `MockRegistrationEngine`);
   * the real `RegistrationEngine` always sets it. When `payloadAccess` is anything other than
   * `'opened'`/`'unsealed'`, `payload` is the degrade-convention `{}` and `registrantId` is never
   * reported.
   */
  payloadAccess?: RegistrationContentAccess
}

/**
 * D-06/D-07: the officer's decision payload for `rejectRegistrationRequest`.
 * `checklist` is structured, not free text, precisely so D-09's counts can
 * aggregate over it. `rejectionReason` is the ONLY free-text field in this
 * phase's decision surface and is meaningful only on the reject path. This
 * type carries **no** `isAccepted` flag — see the `rejectRegistrationRequest`
 * -only engine surface (`IRegistrationEngine`); approval is reachable only
 * through the officer signature-task ceremony.
 */
export interface RegistrationRequestDecision {
  checklist: RegistrationVerificationChecklistItem[]
  rejectionReason?: string
}

/**
 * Filter dimensions for `listRegistrationRequests` (mirrors
 * `RegistrantListFilter`'s discipline). Every field is OPTIONAL and ANDed
 * with the others. `authorityId` is optional even though every UI caller
 * supplies it — the `RegistrationInbox` route carries a required
 * `authorityId`; omission exists only so a non-UI caller can read the whole
 * local set of requests.
 */
export interface RegistrationRequestListFilter {
  authorityId?: string
  status?: RegistrationRequestStatus
  issuerType?: RegistrationRequestIssuerType
  name?: string
}

/**
 * Keyset paging input for `listRegistrationRequests`, mirroring
 * `RegistrantListPage` verbatim: `cursor` is the previous page's last row
 * id, not an encoded token.
 */
export interface RegistrationRequestListPage {
  cursor?: string
  pageSize?: number
}

/**
 * Exactly what the inbox row renders and nothing more. Deliberately omits
 * `requesterSignature` and the full `payload` — the list read must not
 * widen the disclosure surface of the point read.
 *
 * `receivedAt` is **required** here too — it is the **ordering key of the
 * triage queue** (see `listRegistrationRequests` on `IRegistrationEngine`),
 * and a row should be able to render the value it is sorted by rather than
 * a value it is not. `hasPriorRejections` is required-not-optional so a
 * caller cannot render `undefined` as "no prior rejections" when the query
 * simply did not compute it.
 */
export interface RegistrationRequestListRow {
  requestId: string
  authorityId: string
  status: RegistrationRequestStatus
  issuerType: RegistrationRequestIssuerType
  bridgeId?: string
  bridgeLabel?: string
  submittedAt: string
  receivedAt: string
  lastName?: string
  firstName?: string
  hasPriorRejections: boolean

  /**
   * D-44: present only when this request is `'closed'` (a `'d'` `RegistrationDecision` row
   * exists) or `'closing'` (another decision names it in `ClosesRequestId` but its own `'d'` row
   * has not landed yet). Absent — never `undefined` as an assigned key — on every other row, so a
   * caller cannot distinguish "not computed" from "not closed".
   */
  duplicateClosure?: RegistrationDuplicateClosureState

  /**
   * D-49: how `lastName`/`firstName` were read on THIS device. `lastName`/`firstName` are
   * undefined unless `payloadAccess` is `'opened'`/`'unsealed'`. Optional — undefined when the
   * reading engine does not report it (e.g. `MockRegistrationEngine`).
   */
  payloadAccess?: RegistrationContentAccess
}

/**
 * Result of `listRegistrationRequests`. Carries Phase 47's exact `total`
 * semantics: populated only on a cursor-absent first-page call, `undefined`
 * both on paged calls and when the count query itself failed, and honest
 * disagreement with `rows.length` under concurrent mutation is not an error
 * state.
 */
export interface RegistrationRequestListResult {
  rows: RegistrationRequestListRow[]
  nextCursor?: string
  total?: number
}

/**
 * D-06: what makes a persisted rejection reachable by the next reviewing
 * officer.
 */
export interface PriorRejection {
  requestId: string
  rejectedAt: string
  rejectionReason: string
  decidingOfficerUserId: string
}

/**
 * D-09: the entire transparency surface this phase ships. `medianTimeToDecisionMs`
 * is optional and is `undefined` when no request has been decided yet; the UI
 * renders that case as an explicit "not enough data" string and **never** a
 * raw millisecond count, `NaN`, or `Invalid Date`.
 *
 * Deliberate negative space: this type carries **no rating, score, star,
 * thumbs, or comparative-rank field**. `doc/registration.md`'s rating system
 * is explicitly out of scope this phase (D-09) — an implementer must not add
 * one.
 */
export interface RegistrationTransparencyStats {
  pending: number
  approved: number
  rejected: number
  medianTimeToDecisionMs?: number

  /**
   * D-44: a COUNT of requests closed as a likely duplicate of another decided request — never a
   * rating. Present **only when greater than zero**, so the pre-existing zero-request deep-equal
   * (`{ pending: 0, approved: 0, rejected: 0, medianTimeToDecisionMs: undefined }`) stays exact
   * and this field never appears as an explicit `0`.
   */
  closedAsDuplicate?: number
}

/**
 * D-03 registry read shape — a bridge's registered key + display label.
 * `label` is authority-supplied registry text shown to the reviewing
 * officer, never attacker-supplied content from the request payload.
 */
export interface RegistrationBridgeKey {
  id: string
  authorityId: string
  label: string
  key: string
}

/** D-03 registry write shape — see `RegistrationBridgeKey` for the `label` provenance rule. */
export interface RegistrationBridgeKeyInit {
  id: string
  authorityId: string
  label: string
  key: string
}

/** ********* D-43/D-44: duplicate-registration detection and closure (Phase 62 Plan 19) ***********/

/**
 * D-44: which normalized identity signals two pending requests share. Values ONLY — never the
 * underlying field contents (a date of birth, an email, a phone number). This is the entire
 * disclosure surface `LikelyDuplicateRequest.matchedOn` and every `RegistrationDuplicateError`
 * message are allowed to carry about WHY a pair matched.
 */
export type RegistrationDuplicateMatchSignal = 'requester-key' | 'name' | 'dob' | 'email' | 'phone'

/**
 * D-44: one likely-duplicate candidate of a pending request, as computed by
 * `RegistrationEngine.getLikelyDuplicateRequests` — authority-side, in memory, over the
 * authority's own PENDING requests, and never a SQL CHECK (T-62-01-10 does not widen: nothing
 * derived from this comparison is ever persisted). Surface 3's `PossibleDuplicateCallout` renders
 * `candidates[0]`.
 */
export interface LikelyDuplicateRequest {
  requestId: string
  authorityId: string
  issuerType: RegistrationRequestIssuerType
  /** reZulu'd, as on `RegistrationRequestListRow`. */
  submittedAt: string
  /** reZulu'd; the ordering key (oldest first). */
  receivedAt: string
  /** Public tier only — already visible on the inbox row (never a selective/private field). */
  firstName?: string
  lastName?: string
  /** In `DUPLICATE_MATCH_SIGNAL_ORDER`. */
  matchedOn: RegistrationDuplicateMatchSignal[]
}

/**
 * D-44: a request is either `'closed'` — a `'d'` `RegistrationDecision` row exists for it — or
 * `'closing'` — another decision of the same authority names it in `ClosesRequestId` but its own
 * `'d'` row has not been written yet (the two-transaction close is mid-flight or was interrupted).
 * Either state makes the request undecidable: it cannot be rejected, approved, seeded, or counted
 * as pending.
 */
export type RegistrationDuplicateClosureState = 'closed' | 'closing'

/** D-44: the closure state of one request, as returned by `getDuplicateClosure`. */
export interface RegistrationDuplicateClosure {
  requestId: string
  state: RegistrationDuplicateClosureState
  /** `null` only for a `'d'` row that no decision names (the schema's own `DuplicateCloseValid`
   *  fallback case — see 62-01-SUMMARY.md). */
  closedByRequestId: string | null
  /** The `'d'` row's `DecidedAt`, present only when `state === 'closed'`. */
  closedAt?: string
}

/** D-44: the three `RegistrationDecision.Status` values a publish can produce. */
export type RegistrationDecisionPublicationStatus = 'a' | 'r' | 'd'

/**
 * D-44: what `RegistrationEngine.publishRegistrationDecision` hands to a
 * `RegistrationDecisionPublishPort`. Structurally assignable to 62-15's
 * `P2pRegistrationDecisionInput` (`packages/vote-engine/src/registration/transport/
 * p2p-registration-transport.ts`) — this type is declared independently here (vote-core has no
 * dependency on vote-engine's transport module) and the two are proven structurally compatible at
 * the call site, not by a shared declaration.
 */
export interface RegistrationDecisionPublication {
  requestId: string
  status: RegistrationDecisionPublicationStatus
  reason?: string
  /** Canonical ISO-Z (`toISOString` form). */
  decidedAt: string
  /** Set ONLY on the surviving `'a'`/`'r'` row — never on the `'d'` row that follows it. */
  closesRequestId?: string
}

/**
 * D-44: the host's wrapper around 62-15's `P2pRegistrationTransport.publishDecision` (or any
 * equivalent decision-publication channel). `authorityId` is the injected `decisionSigner`'s own
 * authority — the transport itself does not expose it, so the host carries it explicitly. The
 * publisher **must** write into the SAME Quereus database `RegistrationEngine` reads; a publisher
 * wired to a different database is refused `'publisher-db-mismatch'` (the written row is probed
 * back through the engine's own `ctx.db`, never assumed from the publisher's return value alone).
 */
export interface RegistrationDecisionPublishPort {
  readonly authorityId: string
  publishDecision(decision: RegistrationDecisionPublication): Promise<string>
}

/** D-44: the closure-target option for `publishRegistrationDecision`. */
export interface RegistrationDecisionPublishOptions {
  /**
   * `undefined` (omitted): automatic — the oldest flagged pending candidate received no later
   * than the decision closes. `null`: close nothing. A string: close exactly that request — it
   * must be a flagged, pending, not-closed candidate of the SAME authority, or the call refuses
   * `'not-a-likely-duplicate'` with zero rows written.
   */
  closesRequestId?: string | null
}

/** D-44: what a publish attempt actually did to the closure target, if any. */
export type RegistrationDuplicateClosureOutcome =
  | 'none' | 'closed' | 'already-closed' | 'pending-retry' | 'skipped-target-decided' | 'skipped-target-closed'

/** D-44: the result of one `publishRegistrationDecision` call. */
export interface RegistrationDecisionPublishResult {
  requestId: string
  outcome: 'published' | 'already-published'
  /** The status of the row now on the strand for `requestId`. */
  publishedStatus: RegistrationDecisionPublicationStatus
  /** Present when `outcome === 'published'`. */
  cursor?: string
  closesRequestId?: string
  closure: RegistrationDuplicateClosureOutcome
  /** Present when `closure === 'closed'`. */
  closureCursor?: string
  /** Present when `closure === 'pending-retry'`: the publisher error's own string `code` property,
   *  or `'unknown'` when the thrown error carried none. Never the error's message text. */
  closureErrorCode?: string
}

/** D-44: the report `completeDuplicateClosures` returns after resuming every interrupted close of
 *  one authority. */
export interface RegistrationDuplicateClosureRepairReport {
  /** Closed request ids whose `'d'` row THIS call wrote. */
  completed: string[]
  failed: Array<{ requestId: string; reason: 'target-decided' | 'publish-failed'; errorCode?: string }>
}
