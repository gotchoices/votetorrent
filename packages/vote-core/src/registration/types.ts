import type { Signature } from '../common/index.js'
import type { IBuilder } from '../common/builder.js'
import type {
  DisclosedSelective,
  ElectionAttestationPolicy,
  ElectionDisclosurePolicy,
  ElectionRegistrant,
  ElectionRegistrationField,
  LikelyDuplicateRequest,
  PriorRejection,
  RegisterInit,
  Registrant,
  RegistrantAccessEvent,
  RegistrantListFilter,
  RegistrantListPage,
  RegistrantListResult,
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
  RegistrationRequestDecision,
  RegistrationRequestInit,
  RegistrationRequestListFilter,
  RegistrationRequestListPage,
  RegistrationRequestListResult,
  RegistrationRequestRead,
  RegistrationTransparencyStats
} from './models.js'

/**
 * D-01/D-19: every mutating method's signing parameter is a `Signature` OR a
 * callback that receives the canonical digest bytes and returns one — NEVER
 * a raw private key. The engine never holds the key (D-01).
 */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

export interface IRegistrationEngine {
  /** D-02: Register is a builder — multi-field draft + signing + serialization. */
  buildRegister(): IRegistrationRegisterBuilder

  /**
   * Direct register — the Register builder's commit() delegates 1:1 to this
   * method. Drives the multi-row ceremony (Registrant + optional Public/
   * Private/Selective tiers) under one or more 'vrg'-scoped AdminSignatures.
   */
  register(init: RegisterInit, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** Core Registrant row read. */
  getRegistrant(registrantId: string): Promise<Registrant | undefined>

  /** Public tier read. */
  getRegistrantPublic(registrantId: string): Promise<RegistrantPublic | undefined>

  /** Private tier read — authority-side only, never disclosed. */
  getRegistrantPrivate(registrantId: string): Promise<RegistrantPrivate | undefined>

  /** Selective tier read — authority-side, full (undisclosed) record. */
  getRegistrantSelective(registrantId: string): Promise<RegistrantSelective | undefined>

  /**
   * D-14: reveal a per-field subset of a registrant's selective-disclosure
   * set, filtered by `ElectionDisclosurePolicy` for `audience` (or the
   * 'everyone' audience). Returns `null` when the registrant has no
   * `RegistrantSelective` row. The returned `{ disclosed, hidden }` subset
   * independently verifies against `root` via the crypto plugin's
   * `setVerify` — withheld leaves never appear as more than opaque digests.
   */
  getDisclosedSelective(electionId: string, registrantId: string, audience: string): Promise<DisclosedSelective | null>

  /**
   * D-04: the registrant roster read — ONE method, ONE optional filter
   * object (no separate `searchRegistrants`). D-05: keyset paging on the
   * `Registrant.Id` PK; `total` is computed only on a cursor-absent call and
   * cached by the caller for the duration of the scroll. D-06: rows carry
   * the CURRENT `RegistrantPublic` district/name only — never a stale
   * historical row.
   */
  listRegistrants(filter?: RegistrantListFilter, page?: RegistrantListPage): Promise<RegistrantListResult>

  /**
   * D-16: change Status ('a' | 's' | 'r'). Status transitions stay permissive —
   * any 'vrg'-admin-signed change is allowed; the AdminSignature is the control.
   */
  changeStatus(registrantId: string, status: RegistrantStatus, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** D-16: renewal — change Expiration under a fresh 'vrg'-signed mutation. */
  changeExpiration(registrantId: string, expiration: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** D-17: authority-only roster enrollment ('vrg'-signed insert). */
  enrollElectionRegistrant(electionId: string, registrantId: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** D-17: authority-only roster removal ('vrg'-signed delete). */
  removeElectionRegistrant(electionId: string, registrantId: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** Roster read for an election. */
  getElectionRegistrants(electionId: string): Promise<ElectionRegistrant[]>

  /**
   * D-01: record one app-mediated read of a registrant's private tier — the
   * authority-held, append-only accountability/deterrence/regulatory-posture
   * record described on `RegistrantAccessEvent`. It is not a security control:
   * direct local database access bypasses it entirely and writes no row.
   * D-02: deliberately **unsigned** — there is no signature parameter,
   * because `vrg`-signing every read would grow `AdminSignature` with read
   * traffic. `fields` carries attribute NAMES, never values; the engine
   * filters them against the registrant's own `RegistrantPrivate` vocabulary,
   * and a call whose names all fail that filter resolves without writing a
   * row.
   */
  recordRegistrantAccessEvent(registrantId: string, viewerUserId: string, fields: string[]): Promise<void>

  /**
   * D-01: the reviewer read — a write-only trail was explicitly rejected.
   * Returns every `RegistrantAccessEvent` for `registrantId`, newest first
   * (`Sequence` descending), unbounded.
   */
  getRegistrantAccessEvents(registrantId: string): Promise<RegistrantAccessEvent[]>

  /** D-08/D-09/D-10: per-election field policy CRUD ('mel'-signed, election-scoped). */
  addElectionRegistrationField(field: ElectionRegistrationField, signatureOrCallback: SignatureOrCallback): Promise<void>

  removeElectionRegistrationField(electionId: string, fieldName: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  getElectionRegistrationFields(electionId: string): Promise<ElectionRegistrationField[]>

  /**
   * D-14: per-election selective-disclosure policy CRUD ('mel'-signed,
   * election-scoped). Declares which `RegistrantSelective` field names may be
   * disclosed, and to which audience — consumed by `getDisclosedSelective`.
   */
  addElectionDisclosurePolicy(policy: ElectionDisclosurePolicy, signatureOrCallback: SignatureOrCallback): Promise<void>

  removeElectionDisclosurePolicy(electionId: string, fieldName: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  getElectionDisclosurePolicies(electionId: string): Promise<ElectionDisclosurePolicy[]>

  /**
   * D-14b: election policy declaring whether device attestation is required
   * to Associate ('mel'-signed, single row per election). An UPSERT — a
   * second call replaces the stored value rather than erroring/duplicating.
   */
  setElectionAttestationPolicy(electionId: string, attestationRequired: boolean, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** D-14b: read the stored policy; `undefined` when no row exists — MUST NOT synthesize a default. */
  getElectionAttestationPolicy(electionId: string): Promise<ElectionAttestationPolicy | undefined>

  /**
   * D-07: revert-to-default — deletes the `ElectionAttestationPolicy` row so
   * the fail-closed "absent row = attestation REQUIRED" default (owned by the
   * associate() ceremony and, for Phase 46, the UI) applies again.
   */
  removeElectionAttestationPolicy(electionId: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /**
   * D-02: submit a registration request. Returns the assigned request id.
   * The signature deliberately has no `userId`/`userKey`/`IsUserValid`
   * parameter — the caller is an untrusted party with no `User` row and no
   * officer scope, and this INSERT runs **no** `seedSignedMutation`/
   * `AdminSigning` ceremony; the row's own requester-key self-signature is
   * the only authorization gate. D-03: a bridge submission sets
   * `init.issuerType = 'bridge'` + `init.bridgeId` and passes the
   * **registered bridge key** as `requesterKey`, so a bridge assertion is
   * machine-distinguishable from a voter's own act at the data layer, not
   * merely in the UI.
   *
   * Timestamp contract (48-02 **L-3**): the engine takes `SubmittedAt` from
   * `init.submittedAt` **verbatim** and generates none of its own, because a
   * caller may pass an **already-resolved `Signature` produced at some
   * earlier staging moment** — which is exactly what the filesystem courier
   * binding does — and every byte inside the verified digest must therefore
   * be a value that caller already knew. The engine separately records its
   * own `ReceivedAt` at INSERT, which is inside no digest, and rejects an
   * `init.submittedAt` implausibly far from it in either direction.
   */
  submitRegistrationRequest(init: RegistrationRequestInit, requesterKey: string, signatureOrCallback: SignatureOrCallback): Promise<string>

  /** D-03: registry write, an authority-signed ceremony (runs under a `'vrg'`-scoped `AdminSigning` ceremony). */
  registerBridgeKey(init: RegistrationBridgeKeyInit, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** D-03: registry read; the inbox resolves a row's `bridgeLabel` through this registry. */
  listBridgeKeys(authorityId: string): Promise<RegistrationBridgeKey[]>

  /**
   * ONE method, ONE optional filter object. Oldest-**`receivedAt`**-first
   * (triage order, the opposite of a directory listing), keyset paging on
   * the request id, and `total` computed only on a cursor-absent call — i.e.
   * mirroring `listRegistrants` rather than inventing a second pagination
   * scheme.
   *
   * **The ordering key is `receivedAt`, not `submittedAt`.** `submittedAt`
   * is submitter-supplied (see `RegistrationRequestInit`), so ordering the
   * triage queue by it would let a submitter buy its own position by
   * backdating — a self-serve priority channel into an officer's attention.
   * `receivedAt` is the authority's own observation and cannot be influenced
   * from outside. The list still **carries** `submittedAt` for display; it
   * does not **sort** by it. This supersedes the oldest-`submittedAt`-first
   * wording in `48-08-PLAN.md`, whose implementation must follow the
   * contract declared here.
   */
  listRegistrationRequests(filter?: RegistrationRequestListFilter, page?: RegistrationRequestListPage): Promise<RegistrationRequestListResult>

  /**
   * Returns `undefined` for an unknown id, never throws. Resolves
   * `registrantId` for an approved request, and returns **both**
   * `submittedAt` and `receivedAt` so the approval screen can show the
   * officer any divergence between what the requester claimed and what the
   * authority observed.
   */
  getRegistrationRequest(requestId: string): Promise<RegistrationRequestRead | undefined>

  /**
   * D-06, newest-first. This is what makes persisted rejections actually
   * reachable by the reviewing officer, and it is keyed by `requesterKey`
   * (not by request id) so a re-application from the same key carries its
   * history. `excludeRequestId` omits the request currently being viewed so
   * a rejected request cannot cite itself; it excludes exactly one row by
   * id — it is not a general-purpose filter and must never be used to hide
   * a rejection an officer is entitled to see.
   */
  getPriorRejections(requesterKey: string, excludeRequestId?: string): Promise<PriorRejection[]>

  /**
   * D-09. Derived from `Status`/`SubmittedAt`/`DecidedAt` with **no new
   * storage**; counts plus a median are the entire transparency surface
   * this phase ships — no rating is designed here.
   */
  getRegistrationTransparencyStats(authorityId: string): Promise<RegistrationTransparencyStats>

  /**
   * D-06: this is a reject-only method **by design**. There is deliberately
   * no approve-a-request method and no accept/reject-flag decide method
   * (an `isAccepted` boolean parameter) on this interface, because approval must run the officer
   * signature-task ceremony (which produces the real `AdminSignature` and
   * drives the unchanged `register()`), and a single boolean-flagged decide
   * method would let a caller mint a `Registrant` through one engine call
   * while bypassing that ceremony. `decision.rejectionReason` is required
   * in practice on this path even though the type marks it optional (the
   * reject UI gates on a non-empty trimmed reason).
   */
  rejectRegistrationRequest(requestId: string, decision: RegistrationRequestDecision, signatureOrCallback: SignatureOrCallback): Promise<void>

  // ---------- D-44 duplicate detection and closure (Phase 62 Plan 19) ----------

  /**
   * D-44: likely duplicates of `requestId`, authority-side, computed IN MEMORY over the
   * authority's own PENDING requests' already-decrypted identity fields — never a SQL CHECK, and
   * nothing derived from the comparison is persisted anywhere (T-62-01-10 is referenced, not
   * widened). Never throws: an unknown id, a non-pending target, or a closed/closing target all
   * resolve `[]`.
   */
  getLikelyDuplicateRequests(requestId: string): Promise<LikelyDuplicateRequest[]>

  /** D-44: the closure state of one request — `undefined` when it is neither closed nor closing. */
  getDuplicateClosure(requestId: string): Promise<RegistrationDuplicateClosure | undefined>

  /** D-44: decided (`'a'`/`'r'`) request ids of `authorityId` with no `RegistrationDecision` row
   *  yet, oldest `DecidedAt` first (then `Id`) — the peer-sync drain list. */
  listUnpublishedRegistrationDecisions(authorityId: string): Promise<string[]>

  /**
   * D-44: publishes a decided request's `RegistrationDecision` through `publisher`, which MUST
   * write into the SAME database this engine reads. Resolves the surviving `'a'`/`'r'` row first
   * (carrying `ClosesRequestId` when a duplicate closure target is chosen), then — in a SEPARATE
   * publisher call, with the database in autocommit between the two — the closed request's own
   * `'d'` row. An interrupted close never throws from this method: it reports `closure:
   * 'pending-retry'` instead, resumable by `completeDuplicateClosures`.
   */
  publishRegistrationDecision(
    publisher: RegistrationDecisionPublishPort,
    requestId: string,
    options?: RegistrationDecisionPublishOptions
  ): Promise<RegistrationDecisionPublishResult>

  /** D-44: resumes every interrupted two-transaction close of `publisher.authorityId` — writes
   *  the missing `'d'` row for each target exactly once. Idempotent: a target already closed by a
   *  prior call is simply absent from a later call's `completed` list. */
  completeDuplicateClosures(publisher: RegistrationDecisionPublishPort): Promise<RegistrationDuplicateClosureRepairReport>
}

export interface IRegistrationRegisterBuilder extends IBuilder<RegisterInit, void> {
  fromPayload(payload: RegisterInit): this
}
