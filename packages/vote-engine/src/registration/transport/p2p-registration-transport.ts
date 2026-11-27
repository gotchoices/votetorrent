import type { RegistrationRequestInit, RegistrationRequestStatus, Signature } from '@votetorrent/vote-core'
import type { IRegistrationRequestTransport, RegistrationDecisionNotice } from './registration-request-transport.js'
import { assertKnownRegistrationStatus } from './registration-request-transport.js'
import type {
  IRegistrationRequestIntake,
  StagedRequest,
  RequestDigestFn
} from './filesystem-registration-transport.js'
import {
  STAGING_CURSOR_MAX_ATTEMPTS,
  P2pStagingError,
  encodeStagingPlaintext,
  decodeStagingPlaintext,
  insertWithCursorRetry,
  readConformingRows,
  readDecisionRows,
  inSequenceHighWater
} from './p2p-staging-seam.js'
import type {
  StagingSealer,
  StagingOpener,
  StagingOpenResult,
  StagingDecisionSigner,
  P2pStagingErrorCode,
  StagingReadReport,
  StagingUnreadableRow,
  StagingUnreadableReason,
  StagingSqlPort
} from './p2p-staging-seam.js'
import { bytesToBase64url, digestToBytes, nowCanonicalDatetime } from '../../utils.js'
import { registrationCodeBindingDigest } from '../../association/reassociation/registration-code.js'

// Re-exported so 62-18/62-19/62-21/62-22/62-24 can import the whole seam from this one module
// (explicit names only — never `export *` of the seam — so `insertWithCursorRetry` and the
// plaintext encode/decode helpers stay internal to the two transports, out of every barrel).
export { STAGING_CURSOR_MAX_ATTEMPTS, P2pStagingError }
export type { StagingSealer, StagingOpener, StagingOpenResult, StagingDecisionSigner, P2pStagingErrorCode,
  StagingReadReport, StagingUnreadableRow, StagingUnreadableReason }

/**
 * p2p-registration-transport.ts — the D-01/D-11 peer-cluster authority-protocol transport binding,
 * `IRegistrationRequestTransport`'s THIRD implementation (`doc/registration.md:11` — the authority
 * reached in a clustered manner as one or more peers on the Election Network).
 *
 * ============================================================================
 * THIS LEG SHIPS code-complete, unverified.
 * ============================================================================
 * That is the deliverable's label, and it is load-bearing (D-11, and the locked `<blocker>` in
 * `48-CONTEXT.md`). Node results and jest results are NOT verification for this leg and must
 * never be cited as such — this project has a documented history of "implemented but unproven"
 * being read as "done" (Phase 45 closed with four such legs; Phase 41's Node gate was
 * device-REFUTED). P2P-11 is device-REFUTED and its wall has moved repeatedly across Phases 38
 * and 41 — and again during this very phase. The failure signature this module was written
 * against is therefore dated, not permanent.
 *
 * ============================================================================
 * THE SEAM ARRIVES INJECTED — this module imports NO P2P package.
 * ============================================================================
 * The CadreNode/strand fabric (cadre-core, db-p2p, libp2p, ...) is
 * never imported here. Instead this file declares a narrow `RegistrationStrandPort` — three
 * methods, `query`/`mutate`/`close` — and the host that CAN actually construct a `CadreNode` and
 * open its strand supplies one via `P2pRegistrationTransportOptions.openStrand`. Likewise the
 * D-03 sealer/opener/decision-signer (62-15's `p2p-staging-seam.ts`) are injected, not
 * constructed here — 62-14's production factories resolve the D-32 recipients from replicated
 * rows and are consumed by interface only.
 *
 * ============================================================================
 * D-03 — SEALED STAGING, NO PLAINTEXT FALLBACK.
 * ============================================================================
 * Every staged `InitJson` row is a 62-04 sealed envelope (via the injected `StagingSealer`), never plaintext.
 * `submitRequest` throws `'no-sealer'` before any I/O when none is supplied, and a sealer that
 * throws (e.g. a zero-recipient seal) propagates unchanged with zero rows written.
 * `readStagedRequestsReport` throws `'no-opener'` before any I/O when none is supplied, and opens
 * each row through the injected `opener` — a row the opener cannot open is reported in
 * `StagingReadReport.unreadable` with a reason and NO plaintext, and never blocks the other rows.
 *
 * ============================================================================
 * D-05 — REQUESTER-SIGNED STAGING, CURSOR RACE CLOSED.
 * ============================================================================
 * Every staging insert carries `Digest = bytesToBase64url(await computeDigest(init,
 * requesterKey))`, computed EXACTLY ONCE per submit (whether the caller passed a callback or a
 * pre-resolved `Signature`) — never on the read path. The strand schema's own `SignatureValid`
 * CHECK is the authorization gate; a forged signature is refused `'rejected'` with zero rows. A
 * duplicate `RequestId` with different content is `'duplicate-request-id'`; an identical re-submit
 * is idempotent. The former client-side max+1 cursor-allocation race (a unique-index conflict on
 * `(StrandId, Cursor)`) is now closed by `insertWithCursorRetry` (`p2p-staging-seam.ts`): a
 * conflict is retried, reading the cursor back, up to `STAGING_CURSOR_MAX_ATTEMPTS` times, after
 * which the write fails `'cursor-exhausted'` — no row is ever silently lost or written twice.
 *
 * ============================================================================
 * D-06 — OFFICER-SIGNED DECISIONS.
 * ============================================================================
 * `publishDecision` signs the table-name-prefixed digest the strand's own `Digest()` UDF computes
 * (`Digest('RegistrationDecision', StrandId, RequestId, AuthorityId, Status, Reason,
 * ClosesRequestId, DecidedAt)`), via the injected `decisionSigner`. A transport with no
 * `decisionSigner` refuses `'no-decision-signer'`; a non-officer or non-'vrg' officer's signature
 * is refused `'rejected'` by the schema's `DeciderIsOfficerWithScope` CHECK.
 *
 * ============================================================================
 * WIRE SHAPE — reused, not reinvented.
 * ============================================================================
 * `readStagedRequests`/`publishDecision` return the exact `StagedRequest`/`DecisionDocument`
 * shapes 48-09's filesystem binding declared (`IRegistrationRequestIntake`, imported below, never
 * re-declared) — a third wire shape here would be exactly how bindings drift apart behind a
 * shared interface name. Cursors use the same 16-digit zero-padded decimal-string discipline
 * 48-09 landed, so a stale cursor re-delivers (never loses a row) with the identical string-order
 * semantics across all three bindings.
 *
 * ============================================================================
 * KEY-MATERIAL DISCIPLINE.
 * ============================================================================
 * `submitRequest` receives either an already-resolved `Signature` or a digest -> `Signature`
 * callback, and never a raw private key. The transport never sees a secret key of any kind: only
 * the three injected seam ports (`StagingSealer`, `StagingOpener`, `StagingDecisionSigner`) —
 * their own hosts (62-14's vault, the device signer) hold key material, never this module.
 *
 * This file makes no claim about scope enforcement anywhere in the authority ceremony this
 * binding eventually feeds.
 */

/** Local restatement of the seam's signature union (not exported by
 * `registration-request-transport.ts`, so this module redeclares it — mirrors
 * `filesystem-registration-transport.ts`'s own local alias). */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/** D-44: the reason `pollDecisions` reports for a 'd' (closed-as-duplicate) row, instead of
 * throwing — a single closed-duplicate row on a shared strand must never make every voter's poll
 * throw. */
export const REGISTRATION_DUPLICATE_CLOSED_REASON = 'closed-as-duplicate'

/**
 * The narrow, injected seam a host must supply to construct this transport. Deliberately NOT a
 * `CadreNode` or a strand handle directly — a structural port keeps this module's import graph
 * free of any P2P package (see the module header). `query`/`mutate` accept a SQL-shaped string
 * plus named params; the host's real strand implementation is free to route these however its
 * CadreNode/strand fabric actually executes statements.
 */
export interface RegistrationStrandPort extends StagingSqlPort {
  close(): Promise<void>
}

/**
 * `openStrand` is called at most once per transport instance (lazily, on first use, and memoized)
 * — the host that can actually open a strand supplies it; this module never opens one eagerly at
 * construction time, so constructing a `P2pRegistrationTransport` never itself touches the P2P
 * fabric. `computeDigest` mirrors 48-09's injected-digest discipline exactly, so the shared
 * conformance issuer can drive this binding the same way it drives the filesystem one.
 */
export interface P2pRegistrationTransportOptions {
  openStrand: () => Promise<RegistrationStrandPort>
  computeDigest: RequestDigestFn
  strandId: string
  /** Required by `submitRequest`. */
  sealer?: StagingSealer
  /** Required by `readStagedRequests` / `readStagedRequestsReport`. */
  opener?: StagingOpener
  /** Required by `publishDecision`. */
  decisionSigner?: StagingDecisionSigner
}

/** D-03: the plaintext a `StagingSealer` seals into `InitJson` (vote-core's
 * `RegistrationStagingPlaintext`, re-declared here only as an inline shape so this module does not
 * need a value import for a type it already has structurally from `RegistrationRequestInit`). */
interface RegistrationStagingPlaintextShape {
  version: 1
  init: RegistrationRequestInit
  registrationCode?: string
  /** V-3: the requester's signature over (RequestId, registrationCode); sealed with the rest. */
  registrationCodeSignature?: Signature
}

export interface P2pStagedRequest extends StagedRequest {
  digest: string
  registrationCode?: string
}

export interface P2pRegistrationDecisionInput {
  requestId: string
  status: RegistrationRequestStatus | 'd'
  reason?: string
  decidedAt: string
  /** D-44: set on the surviving 'a'/'r' row only. */
  closesRequestId?: string
}

export interface P2pRegistrationDecisionRecord {
  requestId: string
  authorityId: string
  status: 'a' | 'r' | 'd'
  reason?: string
  closesRequestId?: string
  decidedAt: string
  deciderKey: string
  deciderSignature: string
  /**
   * A resume cursor, not a row identifier: forward the last value as `sinceCursor` to continue
   * (re-delivery is permitted, loss is not). Opaque; compare for equality only. In the P2P binding
   * a decision above the in-sequence ceiling carries the last in-sequence cursor of the read (else
   * the caller's conforming `sinceCursor`, else the re-read sentinel `0000000000000000`), so
   * several notices can share one value and it can differ from the cursor `publishDecision`
   * returned. See `readDecisionRows` in `p2p-staging-seam.ts`.
   * Audit consumers must not key records on it.
   */
  cursor: string
}

interface StagingRow {
  RequestId: string
  Digest: string
  InitJson: string
  RequesterKey: string
  SignatureJson: string
  StagedAt: string
  Cursor: string
}

interface DecisionRow {
  RequestId: string
  AuthorityId: string
  Status: string
  Reason: string | null
  ClosesRequestId: string | null
  DecidedAt: string
  DeciderKey: string
  DeciderSignature: string
  Cursor: string
}

const STAGING_SELECT_SQL =
  'select RequestId, Digest, InitJson, RequesterKey, SignatureJson, StagedAt, Cursor ' +
  'from RegistrationRequestStaging where StrandId = :strandId ' +
  'and (:sinceCursor is null or Cursor > :sinceCursor) order by Cursor asc'

const STAGING_INSERT_SQL =
  'insert into RegistrationRequestStaging (StrandId, Cursor, RequestId, Digest, InitJson, RequesterKey, SignatureJson, StagedAt) ' +
  'values (:strandId, :cursor, :requestId, :digest, :initJson, :requesterKey, :signatureJson, :stagedAt)'

const STAGING_IDENTITY_SQL =
  'select RequestId, Digest, RequesterKey, Cursor from RegistrationRequestStaging ' +
  'where StrandId = :strandId and RequestId = :requestId'

const DECISION_SELECT_SQL =
  'select RequestId, AuthorityId, Status, Reason, ClosesRequestId, DecidedAt, DeciderKey, DeciderSignature, Cursor ' +
  'from RegistrationDecision where StrandId = :strandId ' +
  'and (:sinceCursor is null or Cursor > :sinceCursor) order by Cursor asc'

const DECISION_INSERT_SQL =
  'insert into RegistrationDecision (StrandId, Cursor, RequestId, AuthorityId, Status, Reason, ClosesRequestId, DecidedAt, DeciderKey, DeciderSignature) ' +
  'with context now = :now ' +
  'values (:strandId, :cursor, :requestId, :authorityId, :status, :reason, :closesRequestId, :decidedAt, :deciderKey, :deciderSignature)'

const DECISION_IDENTITY_SQL =
  'select RequestId, Cursor from RegistrationDecision where StrandId = :strandId and RequestId = :requestId'

/** The table-name-prefixed digest tuple `RegistrationDecision.SignatureValid` recomputes
 * (`votetorrent.qsql`) — byte-identical argument order, asserted by this plan's own acceptance
 * gate. */
const DECISION_DIGEST_SQL =
  "select Digest('RegistrationDecision', :strandId, :requestId, :authorityId, :status, :reason, :closesRequestId, :decidedAt) as d"

/**
 * `P2pRegistrationTransport` — the D-01/D-11 peer-cluster binding. See the module header above
 * for the injected-seam discipline, the wire-shape reuse, and the **code-complete, unverified**
 * label this class's every consumer must preserve.
 */
export class P2pRegistrationTransport implements IRegistrationRequestTransport, IRegistrationRequestIntake {
  private readonly openStrandFn: () => Promise<RegistrationStrandPort>
  private readonly computeDigest: RequestDigestFn
  private readonly strandId: string
  private readonly sealer?: StagingSealer
  private readonly opener?: StagingOpener
  private readonly decisionSigner?: StagingDecisionSigner
  private strandPromise: Promise<RegistrationStrandPort> | undefined

  constructor (options: P2pRegistrationTransportOptions) {
    this.openStrandFn = options.openStrand
    this.computeDigest = options.computeDigest
    this.strandId = options.strandId
    this.sealer = options.sealer
    this.opener = options.opener
    this.decisionSigner = options.decisionSigner
  }

  /** Opens the injected strand at most once per instance, memoized. Constructing this class never
   * itself opens a strand — only the first real call does. */
  private async strand (): Promise<RegistrationStrandPort> {
    if (this.strandPromise === undefined) {
      this.strandPromise = this.openStrandFn()
    }
    return await this.strandPromise
  }

  /**
   * Stages a signed, SEALED registration request onto the strand (D-03/D-05). The bridge case
   * needs no separate method — expressed entirely through `init.issuerType`/`init.bridgeId`,
   * copied through verbatim inside the sealed plaintext, exactly like the filesystem and REST
   * bindings copy them in the clear. This transport never receives, derives, or persists key
   * material: it holds either a finished `Signature` or a callback, never a raw private key.
   *
   * V-3 binding: when a registration code is carried, the requester's key also signs
   * `sha256(REGISTRATION_CODE_BINDING_DOMAIN, RequestId, code)` through the SAME callback (a signer
   * that unwraps its key once adds no extra prompt) and the signature is sealed inside the
   * plaintext. A finished `Signature` cannot produce that binding, so a code with one is refused
   * with 'code-binding-requires-signer' before any signing, sealing or write.
   */
  async submitRequest (
    init: RegistrationRequestInit,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback,
    extras?: { registrationCode?: string }
  ): Promise<string> {
    if (this.sealer === undefined) {
      throw new P2pStagingError('no-sealer', 'P2pRegistrationTransport.submitRequest: no sealer was supplied — refusing to stage any plaintext')
    }
    if (this.sealer.authorityId !== undefined && this.sealer.authorityId !== init.authorityId) {
      throw new P2pStagingError(
        'sealer-authority-mismatch',
        "P2pRegistrationTransport.submitRequest: sealer.authorityId does not match init.authorityId"
      )
    }

    const registrationCode = extras?.registrationCode
    if (registrationCode !== undefined && typeof signatureOrCallback !== 'function') {
      throw new P2pStagingError(
        'code-binding-requires-signer',
        'P2pRegistrationTransport.submitRequest: a registration code needs a signing callback to produce its binding signature'
      )
    }

    const digestBytes = await this.computeDigest(init, requesterKey)
    const signature = typeof signatureOrCallback === 'function'
      ? await signatureOrCallback(digestBytes)
      : signatureOrCallback
    const digest = bytesToBase64url(digestBytes)

    let plaintextValue: RegistrationStagingPlaintextShape
    if (registrationCode === undefined) {
      plaintextValue = { version: 1, init }
    } else {
      const bindingSignature = await (signatureOrCallback as (digest: Uint8Array) => Promise<Signature>)(
        registrationCodeBindingDigest(init.id, registrationCode)
      )
      if (bindingSignature.signerKey !== requesterKey) {
        throw new P2pStagingError(
          'rejected',
          'P2pRegistrationTransport.submitRequest: the registration code binding was not signed by the requester key'
        )
      }
      plaintextValue = { version: 1, init, registrationCode, registrationCodeSignature: bindingSignature }
    }
    const initJson = await this.sealer.seal(encodeStagingPlaintext(plaintextValue), { requestId: init.id, digest })

    const port = await this.strand()
    await insertWithCursorRetry(port, {
      table: 'RegistrationRequestStaging',
      strandId: this.strandId,
      insertSql: STAGING_INSERT_SQL,
      params: {
        strandId: this.strandId,
        requestId: init.id,
        digest,
        initJson,
        requesterKey,
        signatureJson: JSON.stringify(signature),
        // This binding's own write-time marker — deliberately NOT init.submittedAt (48-09's same
        // StagedRequestDocument.stagedAt discipline).
        stagedAt: new Date().toISOString()
      },
      identity: { sql: STAGING_IDENTITY_SQL, params: { strandId: this.strandId, requestId: init.id } },
      onIdentityConflict: (existing) => {
        const row = existing[0]
        if (row !== undefined && row.Digest === digest && row.RequesterKey === requesterKey) return 'idempotent'
        return new P2pStagingError(
          'duplicate-request-id',
          `P2pRegistrationTransport.submitRequest: a staged request already exists for request id ${init.id} with different content`
        )
      },
      where: 'P2pRegistrationTransport.submitRequest'
    })
    return init.id
  }

  /**
   * Pull model, matching the seam's own documented reasoning (no inbound listener). Cursors
   * advance monotonically; a stale cursor re-delivers rather than losing a row. D-44: a 'd'
   * (closed-as-duplicate) row maps to `{ status: 'r', reason: REGISTRATION_DUPLICATE_CLOSED_REASON }`
   * rather than throwing — without this mapping a single closed-duplicate row on a shared strand
   * would make every voter's poll throw.
   *
   * Every conforming decision is delivered (WR-01). `cursor` is a forward-safe resume cursor: the
   * row's own cursor when in sequence, otherwise the last in-sequence cursor of the read, so
   * forwarding the last notice's cursor re-delivers and never skips.
   */
  async pollDecisions (sinceCursor?: string): Promise<RegistrationDecisionNotice[]> {
    const port = await this.strand()
    const rows = await readDecisionRows<DecisionRow>(port, 'RegistrationDecision', this.strandId, DECISION_SELECT_SQL, sinceCursor)
    return rows.map(({ row, resumeCursor }) => {
      if (row.Status === 'd') {
        return { requestId: row.RequestId, status: 'r', reason: REGISTRATION_DUPLICATE_CLOSED_REASON, cursor: resumeCursor }
      }
      return {
        requestId: row.RequestId,
        status: assertKnownRegistrationStatus(row.Status, 'P2pRegistrationTransport.pollDecisions'),
        reason: row.Reason ?? undefined,
        cursor: resumeCursor
      }
    })
  }

  /**
   * The authority-side intake read (`IRegistrationRequestIntake`, imported from 48-09's single
   * declaration — not re-declared here), with per-row unreadable reporting (D-03). Never calls
   * `computeDigest` — the shared conformance suite's cases 4/6 pin `allocationCount === 1` per
   * submit, and this read path must not re-issue one.
   */
  async readStagedRequestsReport (sinceCursor?: string): Promise<StagingReadReport<P2pStagedRequest>> {
    if (this.opener === undefined) {
      throw new P2pStagingError('no-opener', 'P2pRegistrationTransport.readStagedRequestsReport: no opener was supplied')
    }
    const port = await this.strand()
    const { rows, ceiling } = await readConformingRows<StagingRow>(port, 'RegistrationRequestStaging', this.strandId, STAGING_SELECT_SQL, sinceCursor)

    const delivered: P2pStagedRequest[] = []
    const unreadable: StagingUnreadableRow[] = []
    let highWaterCursor: string | undefined

    for (const row of rows) {
      highWaterCursor = inSequenceHighWater(highWaterCursor, row.Cursor, ceiling)

      let signature: Signature
      try {
        signature = JSON.parse(row.SignatureJson) as Signature
      } catch {
        unreadable.push({ requestId: row.RequestId, cursor: row.Cursor, requesterKey: row.RequesterKey, stagedAt: row.StagedAt, reason: 'malformed-row' })
        continue
      }

      const opened = await this.opener.open(row.InitJson, { requestId: row.RequestId, digest: row.Digest })
      if (!opened.ok) {
        unreadable.push({ requestId: row.RequestId, cursor: row.Cursor, requesterKey: row.RequesterKey, stagedAt: row.StagedAt, reason: opened.reason })
        continue
      }

      const decoded = decodeStagingPlaintext(opened.plaintext) as Partial<RegistrationStagingPlaintextShape> | undefined
      if (
        decoded === undefined ||
        decoded === null ||
        typeof decoded !== 'object' ||
        decoded.version !== 1 ||
        decoded.init === null ||
        typeof decoded.init !== 'object' ||
        (decoded.init as { id?: unknown }).id !== row.RequestId
      ) {
        unreadable.push({ requestId: row.RequestId, cursor: row.Cursor, requesterKey: row.RequesterKey, stagedAt: row.StagedAt, reason: 'invalid-plaintext' })
        continue
      }

      delivered.push({
        version: 1,
        requestId: row.RequestId,
        init: decoded.init as RegistrationRequestInit,
        requesterKey: row.RequesterKey,
        signature,
        stagedAt: row.StagedAt,
        cursor: row.Cursor,
        digest: row.Digest,
        registrationCode: typeof decoded.registrationCode === 'string' ? decoded.registrationCode : undefined
      })
    }

    return { delivered, unreadable, highWaterCursor }
  }

  async readStagedRequests (sinceCursor?: string): Promise<P2pStagedRequest[]> {
    return (await this.readStagedRequestsReport(sinceCursor)).delivered
  }

  /** Publishes an officer-signed decision outcome onto the strand (D-06) and returns the
   * allocated cursor. */
  async publishDecision (decision: P2pRegistrationDecisionInput): Promise<string> {
    if (this.decisionSigner === undefined) {
      throw new P2pStagingError('no-decision-signer', 'P2pRegistrationTransport.publishDecision: no decisionSigner was supplied')
    }
    const port = await this.strand()
    const authorityId = this.decisionSigner.authorityId
    const digestParams = {
      strandId: this.strandId,
      requestId: decision.requestId,
      authorityId,
      status: decision.status,
      reason: decision.reason ?? null,
      closesRequestId: decision.closesRequestId ?? null,
      decidedAt: decision.decidedAt
    }
    const digestRows = await port.query<{ d: string | null }>(DECISION_DIGEST_SQL, digestParams)
    const d = digestRows[0]?.d
    if (d === null || d === undefined) {
      throw new P2pStagingError('digest-unavailable', 'P2pRegistrationTransport.publishDecision: the strand returned no digest for this decision')
    }
    const signature = await this.decisionSigner.sign(digestToBytes(d))

    const { cursor } = await insertWithCursorRetry(port, {
      table: 'RegistrationDecision',
      strandId: this.strandId,
      insertSql: DECISION_INSERT_SQL,
      params: {
        ...digestParams,
        deciderKey: signature.signerKey,
        deciderSignature: signature.signature,
        now: nowCanonicalDatetime()
      },
      identity: { sql: DECISION_IDENTITY_SQL, params: { strandId: this.strandId, requestId: decision.requestId } },
      onIdentityConflict: () => new P2pStagingError(
        'duplicate-decision',
        `P2pRegistrationTransport.publishDecision: a decision already exists for request id ${decision.requestId}`
      ),
      where: 'P2pRegistrationTransport.publishDecision'
    })
    return cursor
  }

  /** `readDecisionRecords` — every column of `P2pRegistrationDecisionRecord` except `cursor`, which is
   * the resume cursor described on the record type, including D-44's 'd' status. Throws (naming only the offending status) on anything outside `a`/`r`/`d`. */
  async readDecisionRecords (sinceCursor?: string): Promise<P2pRegistrationDecisionRecord[]> {
    const port = await this.strand()
    const rows = await readDecisionRows<DecisionRow>(port, 'RegistrationDecision', this.strandId, DECISION_SELECT_SQL, sinceCursor)
    return rows.map(({ row, resumeCursor }) => {
      if (row.Status !== 'a' && row.Status !== 'r' && row.Status !== 'd') {
        throw new Error(`P2pRegistrationTransport.readDecisionRecords: decision record carries a status outside a/r/d: ${JSON.stringify(row.Status)}`)
      }
      return {
        requestId: row.RequestId,
        authorityId: row.AuthorityId,
        status: row.Status,
        reason: row.Reason ?? undefined,
        closesRequestId: row.ClosesRequestId ?? undefined,
        decidedAt: row.DecidedAt,
        deciderKey: row.DeciderKey,
        deciderSignature: row.DeciderSignature,
        cursor: resumeCursor
      }
    })
  }

  /** Closes the injected strand port, if one was ever opened. Safe to call on an instance that
   * never made a real call. */
  async close (): Promise<void> {
    if (this.strandPromise !== undefined) {
      const port = await this.strandPromise
      await port.close()
      this.strandPromise = undefined
    }
  }
}
