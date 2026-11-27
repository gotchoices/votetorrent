import type { AssociationAttestationAnswer, AssociationIdentityField, AssociationRequestInit, AssociationRequestStatus, Signature } from '@votetorrent/vote-core'
import type { IAssociationRequestTransport, AssociationDecisionNotice } from './association-request-transport.js'
import { assertKnownAssociationStatus } from './association-request-transport.js'
import type {
  IAssociationRequestIntake,
  StagedAssociationRequest,
  StagedAttestation,
  AssociationDecisionDocument,
  RequestDigestFn,
  AttestationDigestFn
} from './filesystem-association-transport.js'
import {
  P2pStagingError,
  encodeStagingPlaintext,
  decodeStagingPlaintext,
  insertWithCursorRetry,
  readConformingRows,
  readDecisionRows,
  inSequenceHighWater
} from '../../registration/transport/p2p-staging-seam.js'
import type { StagingSealer, StagingOpener, StagingDecisionSigner, StagingReadReport, StagingUnreadableRow, StagingSqlPort } from '../../registration/transport/p2p-staging-seam.js'
import { sanitizeIdentityFields } from '../reassociation/identity-fields.js'
import { bytesToBase64url, digestToBytes, nowCanonicalDatetime } from '../../utils.js'

/**
 * p2p-association-transport.ts — the D-08/D-18 peer-cluster authority-protocol transport binding,
 * `IAssociationRequestTransport`'s THIRD implementation (`doc/registration.md:11` — the authority
 * reached in a clustered manner as one or more peers on the Election Network).
 *
 * ============================================================================
 * THIS LEG SHIPS code-complete, unverified.
 * ============================================================================
 * That is the deliverable's label, and it is load-bearing (D-08, and the locked `<blocker>` in
 * `48-CONTEXT.md`, whose framing this phase reuses verbatim). Node results and jest results are
 * NOT verification for this leg and must never be cited as such — this project has a documented
 * history of "implemented but unproven" being read as "done" (Phase 45 closed with four such legs;
 * Phase 41's Node gate was device-REFUTED). P2P-11 was root-caused 2026-08-24 (devices refused as
 * cadre non-members) and remains open; its wall has moved repeatedly across Phases 38 and 41 and
 * again since.
 *
 * ============================================================================
 * THE SEAM ARRIVES INJECTED — this module imports NO P2P package.
 * ============================================================================
 * The CadreNode/strand fabric (cadre-core, db-p2p, libp2p, ...) is never
 * imported here. Instead this file declares a narrow `AssociationStrandPort` — three methods,
 * `query`/`mutate`/`close` — and the host that CAN actually construct a `CadreNode` and open its
 * strand supplies one via `P2pAssociationTransportOptions.openStrand`. Likewise the D-03
 * sealer/opener/decision-signer are injected, SHARED with the registration binding via
 * `../../registration/transport/p2p-staging-seam.js` — this module never duplicates that seam.
 *
 * ============================================================================
 * D-03 — SEALED STAGING ON BOTH LEGS, NO PLAINTEXT FALLBACK.
 * ============================================================================
 * `InitJson` (leg 1, `submitRequest`) and `AnswerJson` (leg 2, `submitAttestation`) are both 62-04
 * sealed envelopes, never plaintext. Either leg throws `'no-sealer'` before any I/O when none is
 * supplied; a sealer that throws propagates unchanged with zero rows written.
 * `readStagedRequestsReport`/`readStagedAttestationsReport` throw `'no-opener'` before any I/O
 * when none is supplied, and open each row through the injected `opener` — a row the opener
 * cannot open is reported unreadable with a reason and NO plaintext, never blocking other rows.
 *
 * ============================================================================
 * D-05 — REQUESTER-SIGNED STAGING, CURSOR RACE CLOSED (shared seam).
 * ============================================================================
 * Every staging insert (both legs) carries a `Digest` computed exactly once per submit, through
 * the shared `insertWithCursorRetry` cursor-retry seam — see
 * `../../registration/transport/p2p-staging-seam.ts` for the full race-closing contract.
 *
 * ============================================================================
 * D-06/D-41/D-45 — OFFICER-SIGNED DECISIONS, carrying RevokesDeviceKey/MatchMethod.
 * ============================================================================
 * `publishDecision` signs the table-name-prefixed digest the strand's own `Digest()` UDF computes
 * (`Digest('AssociationDecision', StrandId, RequestId, AuthorityId, Status, ChallengeNonce,
 * Reason, RevokesDeviceKey, MatchMethod, DecidedAt)`), via the injected `decisionSigner`. Status is
 * deliberately NOT validated on write — the shared conformance suite publishes an out-of-vocabulary
 * `'x'` and requires the READ side (`pollDecisions`/`readDecisionRecords`), not this write side, to
 * reject it (`AssociationDecision` carries no Status vocabulary CHECK — see the table comment in
 * `votetorrent.qsql`).
 *
 * ============================================================================
 * WIRE SHAPE — reused, not reinvented.
 * ============================================================================
 * `readStagedRequests`/`readStagedAttestations`/`publishDecision` return the exact
 * `StagedAssociationRequest`/`StagedAttestation`/`AssociationDecisionDocument` shapes 51-06's
 * filesystem binding declared (`IAssociationRequestIntake`, imported below, never re-declared) — a
 * third wire shape here would be exactly how bindings drift apart behind a shared interface name.
 * Cursors use the same 16-digit zero-padded decimal-string discipline 51-06 landed, so a stale
 * cursor re-delivers (never loses a row) with the identical string-order semantics across all
 * three bindings.
 *
 * ============================================================================
 * KEY-MATERIAL DISCIPLINE.
 * ============================================================================
 * `submitRequest` and `submitAttestation` each receive either an already-resolved `Signature` or a
 * digest -> `Signature` callback, and never a raw private key. The transport never sees a secret
 * key of any kind: only the three injected seam ports — their own hosts hold key material, never
 * this module.
 *
 * This file makes no claim about scope enforcement anywhere in the authority ceremony this binding
 * eventually feeds.
 */

/** Local restatement of the seam's signature union (not exported by
 * `association-request-transport.ts`, so this module redeclares it — mirrors
 * `filesystem-association-transport.ts`'s own local alias). */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/** D-45: how an 'a' decision was matched — the sealed registration code, or an officer matching
 * identity fields by hand. Mirrors `AssociationMatchMethod`'s two codes (`votetorrent.qsql`). */
export type P2pAssociationMatchMethod = 'code' | 'identity'

/**
 * The narrow, injected seam a host must supply to construct this transport. Deliberately NOT a
 * `CadreNode` or a strand handle directly — a structural port keeps this module's import graph
 * free of any P2P package (see the module header). `query`/`mutate` accept a SQL-shaped string
 * plus named params; the host's real strand implementation is free to route these however its
 * CadreNode/strand fabric actually executes statements.
 */
export interface AssociationStrandPort extends StagingSqlPort {
  close(): Promise<void>
}

/**
 * `openStrand` is called at most once per transport instance (lazily, on first use, and memoized)
 * — the host that can actually open a strand supplies it; this module never opens one eagerly at
 * construction time, so constructing a `P2pAssociationTransport` never itself touches the P2P
 * fabric. `computeDigest`/`computeAttestationDigest` mirror 51-06's injected-digest discipline
 * exactly (two SEPARATE functions, one per leg, per D-18), so the shared conformance issuer can
 * drive this binding the same way it drives the filesystem one.
 */
export interface P2pAssociationTransportOptions {
  openStrand: () => Promise<AssociationStrandPort>
  computeDigest: RequestDigestFn
  computeAttestationDigest: AttestationDigestFn
  strandId: string
  /** Required by `submitRequest` / `submitAttestation`. */
  sealer?: StagingSealer
  /** Required by `readStagedRequests` / `readStagedRequestsReport` / `readStagedAttestations` /
   * `readStagedAttestationsReport`. */
  opener?: StagingOpener
  /** Required by `publishDecision`. */
  decisionSigner?: StagingDecisionSigner
}

/** D-03/D-45: the plaintext a `StagingSealer` seals into `InitJson` (vote-core's
 * `AssociationStagingPlaintext`, re-declared here only as an inline shape — mirrors the
 * registration binding's own `RegistrationStagingPlaintextShape`). */
interface AssociationStagingPlaintextShape {
  version: 1
  init: AssociationRequestInit
  registrationCode?: string
  identityFields?: AssociationIdentityField[]
}

export interface P2pStagedAssociationRequest extends StagedAssociationRequest {
  digest: string
  registrationCode?: string
  identityFields?: AssociationIdentityField[]
}

export interface P2pStagedAttestation extends StagedAttestation {
  digest: string
}

export type P2pAssociationDecisionInput = Omit<AssociationDecisionDocument, 'version'> & {
  /** D-41/D-45 — 'a' rows only (schema `RevocationShape`/`MatchMethodValid`). */
  revokesDeviceKey?: string
  matchMethod?: P2pAssociationMatchMethod
}

export interface P2pAssociationDecisionRecord {
  requestId: string
  authorityId: string
  status: AssociationRequestStatus
  challengeNonce?: string
  reason?: string
  revokesDeviceKey?: string
  matchMethod?: P2pAssociationMatchMethod
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

interface AttestationStagingRow {
  RequestId: string
  Digest: string
  AnswerJson: string
  RequesterKey: string
  SignatureJson: string
  StagedAt: string
  Cursor: string
}

interface DecisionRow {
  RequestId: string
  AuthorityId: string
  Status: string
  ChallengeNonce: string | null
  Reason: string | null
  RevokesDeviceKey: string | null
  MatchMethod: string | null
  DecidedAt: string
  DeciderKey: string
  DeciderSignature: string
  Cursor: string
}

const STAGING_SELECT_SQL =
  'select RequestId, Digest, InitJson, RequesterKey, SignatureJson, StagedAt, Cursor ' +
  'from AssociationRequestStaging where StrandId = :strandId ' +
  'and (:sinceCursor is null or Cursor > :sinceCursor) order by Cursor asc'

const STAGING_INSERT_SQL =
  'insert into AssociationRequestStaging (StrandId, Cursor, RequestId, Digest, InitJson, RequesterKey, SignatureJson, StagedAt) ' +
  'values (:strandId, :cursor, :requestId, :digest, :initJson, :requesterKey, :signatureJson, :stagedAt)'

const STAGING_IDENTITY_SQL =
  'select RequestId, Digest, RequesterKey, Cursor from AssociationRequestStaging ' +
  'where StrandId = :strandId and RequestId = :requestId'

const ATTESTATION_STAGING_SELECT_SQL =
  'select RequestId, Digest, AnswerJson, RequesterKey, SignatureJson, StagedAt, Cursor ' +
  'from AssociationAttestationStaging where StrandId = :strandId ' +
  'and (:sinceCursor is null or Cursor > :sinceCursor) order by Cursor asc'

const ATTESTATION_STAGING_INSERT_SQL =
  'insert into AssociationAttestationStaging (StrandId, Cursor, RequestId, Digest, AnswerJson, RequesterKey, SignatureJson, StagedAt) ' +
  'values (:strandId, :cursor, :requestId, :digest, :answerJson, :requesterKey, :signatureJson, :stagedAt)'

const ATTESTATION_STAGING_IDENTITY_SQL =
  'select RequestId, Digest, RequesterKey, Cursor from AssociationAttestationStaging ' +
  'where StrandId = :strandId and RequestId = :requestId'

const DECISION_SELECT_SQL =
  'select RequestId, AuthorityId, Status, ChallengeNonce, Reason, RevokesDeviceKey, MatchMethod, DecidedAt, DeciderKey, DeciderSignature, Cursor ' +
  'from AssociationDecision where StrandId = :strandId ' +
  'and (:sinceCursor is null or Cursor > :sinceCursor) order by Cursor asc'

const DECISION_INSERT_SQL =
  'insert into AssociationDecision (StrandId, Cursor, RequestId, AuthorityId, Status, ChallengeNonce, Reason, RevokesDeviceKey, MatchMethod, DecidedAt, DeciderKey, DeciderSignature) ' +
  'with context now = :now ' +
  'values (:strandId, :cursor, :requestId, :authorityId, :status, :challengeNonce, :reason, :revokesDeviceKey, :matchMethod, :decidedAt, :deciderKey, :deciderSignature)'

/** PK is `(StrandId, RequestId, Status)` — NOT `(StrandId, RequestId)` alone, because the channel
 * publishes TWO rows for one request ('c' then 'a'/'r'). */
const DECISION_IDENTITY_SQL =
  'select RequestId, Status, Cursor from AssociationDecision where StrandId = :strandId and RequestId = :requestId and Status = :status'

/** The table-name-prefixed digest tuple `AssociationDecision.SignatureValid` recomputes
 * (`votetorrent.qsql`) — byte-identical argument order, asserted by this plan's own acceptance
 * gate. */
const DECISION_DIGEST_SQL =
  "select Digest('AssociationDecision', :strandId, :requestId, :authorityId, :status, :challengeNonce, :reason, :revokesDeviceKey, :matchMethod, :decidedAt) as d"

/**
 * `P2pAssociationTransport` — the D-08/D-18 peer-cluster binding. See the module header above for
 * the injected-seam discipline, the wire-shape reuse, and the **code-complete, unverified** label
 * this class's every consumer must preserve.
 */
export class P2pAssociationTransport implements IAssociationRequestTransport, IAssociationRequestIntake {
  private readonly openStrandFn: () => Promise<AssociationStrandPort>
  private readonly computeDigest: RequestDigestFn
  private readonly computeAttestationDigest: AttestationDigestFn
  private readonly strandId: string
  private readonly sealer?: StagingSealer
  private readonly opener?: StagingOpener
  private readonly decisionSigner?: StagingDecisionSigner
  private strandPromise: Promise<AssociationStrandPort> | undefined

  constructor (options: P2pAssociationTransportOptions) {
    this.openStrandFn = options.openStrand
    this.computeDigest = options.computeDigest
    this.computeAttestationDigest = options.computeAttestationDigest
    this.strandId = options.strandId
    this.sealer = options.sealer
    this.opener = options.opener
    this.decisionSigner = options.decisionSigner
  }

  /** Opens the injected strand at most once per instance, memoized. Constructing this class never
   * itself opens a strand — only the first real call does. */
  private async strand (): Promise<AssociationStrandPort> {
    if (this.strandPromise === undefined) {
      this.strandPromise = this.openStrandFn()
    }
    return await this.strandPromise
  }

  /**
   * Stages a signed, SEALED association request onto the strand (leg 1, D-03/D-05). This
   * transport never receives, derives, or persists key material: it holds either a finished
   * `Signature` or a callback, never a raw private key.
   */
  async submitRequest (
    init: AssociationRequestInit,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback,
    extras?: { registrationCode?: string, identityFields?: readonly AssociationIdentityField[] }
  ): Promise<string> {
    if (this.sealer === undefined) {
      throw new P2pStagingError('no-sealer', 'P2pAssociationTransport.submitRequest: no sealer was supplied — refusing to stage any plaintext')
    }
    if (this.sealer.authorityId !== undefined && this.sealer.authorityId !== init.authorityId) {
      throw new P2pStagingError(
        'sealer-authority-mismatch',
        'P2pAssociationTransport.submitRequest: sealer.authorityId does not match init.authorityId'
      )
    }

    const digestBytes = await this.computeDigest(init, requesterKey)
    const signature = typeof signatureOrCallback === 'function'
      ? await signatureOrCallback(digestBytes)
      : signatureOrCallback
    const digest = bytesToBase64url(digestBytes)

    const plaintextValue: AssociationStagingPlaintextShape = {
      version: 1,
      init,
      ...(extras?.registrationCode === undefined ? {} : { registrationCode: extras.registrationCode }),
      ...(extras?.identityFields === undefined ? {} : { identityFields: [...extras.identityFields] })
    }
    const initJson = await this.sealer.seal(encodeStagingPlaintext(plaintextValue), { requestId: init.id, digest })

    const port = await this.strand()
    await insertWithCursorRetry(port, {
      table: 'AssociationRequestStaging',
      strandId: this.strandId,
      insertSql: STAGING_INSERT_SQL,
      params: {
        strandId: this.strandId,
        requestId: init.id,
        digest,
        initJson,
        requesterKey,
        signatureJson: JSON.stringify(signature),
        // This binding's own write-time marker — deliberately NOT init.submittedAt (51-06's same
        // StagedAssociationRequestDocument.stagedAt discipline).
        stagedAt: new Date().toISOString()
      },
      identity: { sql: STAGING_IDENTITY_SQL, params: { strandId: this.strandId, requestId: init.id } },
      onIdentityConflict: (existing) => {
        const row = existing[0]
        if (row !== undefined && row.Digest === digest && row.RequesterKey === requesterKey) return 'idempotent'
        return new P2pStagingError(
          'duplicate-request-id',
          `P2pAssociationTransport.submitRequest: a staged request already exists for request id ${init.id} with different content`
        )
      },
      where: 'P2pAssociationTransport.submitRequest'
    })
    return init.id
  }

  /**
   * Stages a signed, SEALED attestation-answer onto the strand (leg 2, D-03/D-05/D-18). Not a
   * widened `submitRequest` — a distinct second message with its own digest tuple, written into a
   * THIRD staging table, mirroring the filesystem binding's THIRD subdirectory (`attestations/`).
   * There is no sealer-authority-mismatch guard here: an answer carries no authority id.
   */
  async submitAttestation (
    answer: AssociationAttestationAnswer,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<void> {
    if (this.sealer === undefined) {
      throw new P2pStagingError('no-sealer', 'P2pAssociationTransport.submitAttestation: no sealer was supplied — refusing to stage any plaintext')
    }

    const digestBytes = await this.computeAttestationDigest(answer, requesterKey)
    const signature = typeof signatureOrCallback === 'function'
      ? await signatureOrCallback(digestBytes)
      : signatureOrCallback
    const digest = bytesToBase64url(digestBytes)

    const answerJson = await this.sealer.seal(encodeStagingPlaintext(answer), { requestId: answer.requestId, digest })

    const port = await this.strand()
    await insertWithCursorRetry(port, {
      table: 'AssociationAttestationStaging',
      strandId: this.strandId,
      insertSql: ATTESTATION_STAGING_INSERT_SQL,
      params: {
        strandId: this.strandId,
        requestId: answer.requestId,
        digest,
        answerJson,
        requesterKey,
        signatureJson: JSON.stringify(signature),
        // This binding's own write-time marker. In NO digest.
        stagedAt: new Date().toISOString()
      },
      identity: { sql: ATTESTATION_STAGING_IDENTITY_SQL, params: { strandId: this.strandId, requestId: answer.requestId } },
      onIdentityConflict: (existing) => {
        const row = existing[0]
        if (row !== undefined && row.Digest === digest && row.RequesterKey === requesterKey) return 'idempotent'
        return new P2pStagingError(
          'duplicate-request-id',
          `P2pAssociationTransport.submitAttestation: a staged attestation already exists for request id ${answer.requestId} with different content`
        )
      },
      where: 'P2pAssociationTransport.submitAttestation'
    })
  }

  /**
   * Pull model, matching the seam's own documented reasoning (no inbound listener). Cursors
   * advance monotonically; a stale cursor re-delivers rather than losing a row. `AssociationDecision`
   * carries no Status vocabulary CHECK — an out-of-vocabulary status (e.g. 'x') THROWS here
   * (unchanged from before this plan), via `assertKnownAssociationStatus`.
   *
   * Every conforming decision is delivered (WR-01). `cursor` is a forward-safe resume cursor: the
   * row's own cursor when in sequence, otherwise the last in-sequence cursor of the read, so
   * forwarding the last notice's cursor re-delivers and never skips.
   */
  async pollDecisions (sinceCursor?: string): Promise<AssociationDecisionNotice[]> {
    const port = await this.strand()
    const rows = await readDecisionRows<DecisionRow>(port, 'AssociationDecision', this.strandId, DECISION_SELECT_SQL, sinceCursor)
    return rows.map(({ row, resumeCursor }) => ({
      requestId: row.RequestId,
      status: assertKnownAssociationStatus(row.Status, 'P2pAssociationTransport.pollDecisions'),
      challengeNonce: row.ChallengeNonce ?? undefined,
      reason: row.Reason ?? undefined,
      cursor: resumeCursor
    }))
  }

  /**
   * The authority-side intake read for leg 1 (`IAssociationRequestIntake`, imported from 51-06's
   * single declaration — not re-declared here), with per-row unreadable reporting (D-03). Never
   * calls `computeDigest`.
   */
  async readStagedRequestsReport (sinceCursor?: string): Promise<StagingReadReport<P2pStagedAssociationRequest>> {
    if (this.opener === undefined) {
      throw new P2pStagingError('no-opener', 'P2pAssociationTransport.readStagedRequestsReport: no opener was supplied')
    }
    const port = await this.strand()
    const { rows, ceiling } = await readConformingRows<StagingRow>(port, 'AssociationRequestStaging', this.strandId, STAGING_SELECT_SQL, sinceCursor)

    const delivered: P2pStagedAssociationRequest[] = []
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

      const decoded = decodeStagingPlaintext(opened.plaintext) as Partial<AssociationStagingPlaintextShape> | undefined
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
        init: decoded.init as AssociationRequestInit,
        requesterKey: row.RequesterKey,
        signature,
        stagedAt: row.StagedAt,
        cursor: row.Cursor,
        digest: row.Digest,
        registrationCode: typeof decoded.registrationCode === 'string' ? decoded.registrationCode : undefined,
        identityFields: sanitizeIdentityFields(decoded.identityFields)
      })
    }

    return { delivered, unreadable, highWaterCursor }
  }

  async readStagedRequests (sinceCursor?: string): Promise<P2pStagedAssociationRequest[]> {
    return (await this.readStagedRequestsReport(sinceCursor)).delivered
  }

  /**
   * The authority-side intake read for leg 2 (D-18), with per-row unreadable reporting (D-03).
   * Mirrors `readStagedRequestsReport`, reading the attestation staging table and validating the
   * opened plaintext against `AssociationAttestationAnswer`'s own `requestId` member instead of
   * an `init.id`.
   */
  async readStagedAttestationsReport (sinceCursor?: string): Promise<StagingReadReport<P2pStagedAttestation>> {
    if (this.opener === undefined) {
      throw new P2pStagingError('no-opener', 'P2pAssociationTransport.readStagedAttestationsReport: no opener was supplied')
    }
    const port = await this.strand()
    const { rows, ceiling } = await readConformingRows<AttestationStagingRow>(port, 'AssociationAttestationStaging', this.strandId, ATTESTATION_STAGING_SELECT_SQL, sinceCursor)

    const delivered: P2pStagedAttestation[] = []
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

      const opened = await this.opener.open(row.AnswerJson, { requestId: row.RequestId, digest: row.Digest })
      if (!opened.ok) {
        unreadable.push({ requestId: row.RequestId, cursor: row.Cursor, requesterKey: row.RequesterKey, stagedAt: row.StagedAt, reason: opened.reason })
        continue
      }

      const decoded = decodeStagingPlaintext(opened.plaintext) as Partial<AssociationAttestationAnswer> | undefined
      if (
        decoded === undefined ||
        decoded === null ||
        typeof decoded !== 'object' ||
        decoded.requestId !== row.RequestId
      ) {
        unreadable.push({ requestId: row.RequestId, cursor: row.Cursor, requesterKey: row.RequesterKey, stagedAt: row.StagedAt, reason: 'invalid-plaintext' })
        continue
      }

      delivered.push({
        version: 1,
        requestId: row.RequestId,
        answer: decoded as AssociationAttestationAnswer,
        requesterKey: row.RequesterKey,
        signature,
        stagedAt: row.StagedAt,
        cursor: row.Cursor,
        digest: row.Digest
      })
    }

    return { delivered, unreadable, highWaterCursor }
  }

  async readStagedAttestations (sinceCursor?: string): Promise<P2pStagedAttestation[]> {
    return (await this.readStagedAttestationsReport(sinceCursor)).delivered
  }

  /**
   * Publishes an officer-signed decision outcome (including a `'c'` challenge-issued notice) onto
   * the strand (D-06/D-41/D-45) and returns the allocated cursor. Status is NOT validated on
   * write — the shared conformance suite publishes `'x'` and requires the READ side to throw.
   */
  async publishDecision (decision: P2pAssociationDecisionInput): Promise<string> {
    if (this.decisionSigner === undefined) {
      throw new P2pStagingError('no-decision-signer', 'P2pAssociationTransport.publishDecision: no decisionSigner was supplied')
    }
    const port = await this.strand()
    const authorityId = this.decisionSigner.authorityId
    const digestParams = {
      strandId: this.strandId,
      requestId: decision.requestId,
      authorityId,
      status: decision.status,
      challengeNonce: decision.challengeNonce ?? null,
      reason: decision.reason ?? null,
      revokesDeviceKey: decision.revokesDeviceKey ?? null,
      matchMethod: decision.matchMethod ?? null,
      decidedAt: decision.decidedAt
    }
    const digestRows = await port.query<{ d: string | null }>(DECISION_DIGEST_SQL, digestParams)
    const d = digestRows[0]?.d
    if (d === null || d === undefined) {
      throw new P2pStagingError('digest-unavailable', 'P2pAssociationTransport.publishDecision: the strand returned no digest for this decision')
    }
    const signature = await this.decisionSigner.sign(digestToBytes(d))

    const { cursor } = await insertWithCursorRetry(port, {
      table: 'AssociationDecision',
      strandId: this.strandId,
      insertSql: DECISION_INSERT_SQL,
      params: {
        ...digestParams,
        deciderKey: signature.signerKey,
        deciderSignature: signature.signature,
        now: nowCanonicalDatetime()
      },
      identity: {
        sql: DECISION_IDENTITY_SQL,
        params: { strandId: this.strandId, requestId: decision.requestId, status: decision.status }
      },
      onIdentityConflict: () => new P2pStagingError(
        'duplicate-decision',
        `P2pAssociationTransport.publishDecision: a decision with status ${JSON.stringify(decision.status)} already exists for request id ${decision.requestId}`
      ),
      where: 'P2pAssociationTransport.publishDecision'
    })
    return cursor
  }

  /** `readDecisionRecords` — every column of `P2pAssociationDecisionRecord` except `cursor`, which is
   * the resume cursor described on the record type. Routes `Status`
   * through `assertKnownAssociationStatus` (unknown status THROWS, unchanged). */
  async readDecisionRecords (sinceCursor?: string): Promise<P2pAssociationDecisionRecord[]> {
    const port = await this.strand()
    const rows = await readDecisionRows<DecisionRow>(port, 'AssociationDecision', this.strandId, DECISION_SELECT_SQL, sinceCursor)
    return rows.map(({ row, resumeCursor }) => ({
      requestId: row.RequestId,
      authorityId: row.AuthorityId,
      status: assertKnownAssociationStatus(row.Status, 'P2pAssociationTransport.readDecisionRecords'),
      challengeNonce: row.ChallengeNonce ?? undefined,
      reason: row.Reason ?? undefined,
      revokesDeviceKey: row.RevokesDeviceKey ?? undefined,
      matchMethod: (row.MatchMethod ?? undefined) as P2pAssociationMatchMethod | undefined,
      decidedAt: row.DecidedAt,
      deciderKey: row.DeciderKey,
      deciderSignature: row.DeciderSignature,
      cursor: resumeCursor
    }))
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
