import { setDisclose } from '@optimystic/quereus-plugin-crypto'
import { digestToBytes, nowCanonicalDatetime, parseJsonOr, asText, asNumberOr, SEQUENCE_ALLOCATION_ATTEMPTS } from '../utils.js'
import { seedSignedMutation } from '../signing/signed-mutation.js'
import { readAuthorityThreshold } from '../signing/threshold.js'
import { allocateTid } from '../database/tid-allocator.js'
import { resolveSignedSubmittedAt } from '../signing/signed-submitted-at.js'
import { toIsoZDatetime, toDeferredCheckDatetime, reZuluDatetime, restoreCanonicalDatetime, resolveSign as resolveSignHelper, requireCtx as requireCtxHelper, rethrow as rethrowHelper } from '../signing/ceremony-helpers.js'
import { RegistrationRegisterBuilder } from './builders/registration-register-builder.js'
import { validateFieldPolicy } from './field-policy.js'
import {
  buildRegistrantListCountSql,
  buildRegistrantListPageSql,
  clampPageSize,
  REGISTRANT_PRIVATE_POINT_CURRENCY_JOIN,
  REGISTRANT_PUBLIC_POINT_CURRENCY_JOIN,
  REGISTRANT_SELECTIVE_POINT_CURRENCY_JOIN
} from './registrant-list-query.js'
import {
  buildPriorRejectionCountSql,
  buildRegistrationRequestListCountSql,
  buildRegistrationRequestListPageSql,
  STATUS_APPROVED,
  STATUS_PENDING,
  STATUS_REJECTED
} from './registration-request-query.js'
import { collectPrivateFieldNames, sanitizeAccessTrailFields } from './access-trail-fields.js'
import { findLikelyDuplicates, extractRegistrationIdentity, matchRegistrationIdentities } from './duplicate-detection.js'
import type { DuplicateComparable } from './duplicate-detection.js'
import { registrationRequestNotClosedSql, readDuplicateClosure, readDuplicateClosureStates } from './duplicate-closure.js'
import {
  REGISTRATION_REQUEST_NAME_SCAN_BATCH,
  registrationRequestNameMatches
} from './registration-request-query.js'
import { isSealedRegistrationContent, openRegistrationPayload, openRegistrantPrivateDetails, openRegistrantSelectiveDetails, sealRegistrationPayload, sealRegistrantPrivateDetails, sealRegistrantSelectiveDetails } from './sealed-registration-content.js'
import type { RegistrationPayloadRead } from './sealed-registration-content.js'
import { IntakeError } from '../intake/types.js'
import {
  isChecklistGateMet,
  VERIFICATION_CHECKLIST_ITEM_ORDER,
  verificationCid as computeVerificationCidFor,
  RegistrantAlreadyExistsError,
  RegistrationDuplicateError,
  RequesterSignatureUnverifiableError
} from '@votetorrent/vote-core'
import type { SqlValue } from '@quereus/quereus'
import type { EngineContext } from '../types.js'
import type {
  DisclosedSelective,
  DisclosureAudience,
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
  RegisterSelectivePayload,
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
  RegistrationDecisionPublication,
  RegistrationDecisionPublishOptions,
  RegistrationDecisionPublishPort,
  RegistrationDecisionPublishResult,
  RegistrationDuplicateClosure,
  RegistrationDuplicateClosureOutcome,
  RegistrationDuplicateClosureRepairReport,
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
  RegistrationVerificationChecklistItem,
  SelectiveLeaf,
  Signature,
  Timestamp
} from '@votetorrent/vote-core'

/**
 * D-01/D-19: every mutating method's signing parameter is a real `Signature`
 * OR a callback that receives the canonical digest bytes and returns one —
 * NEVER a raw private key. The engine never holds the key (D-01). Matches
 * `IRegistrationEngine`'s (unexported) `SignatureOrCallback` shape structurally.
 */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * L-3 skew guard bounds for `submitRegistrationRequest`'s submitter-supplied
 * `SubmittedAt` (48-02 `<digest_register>` / 48-07). Named module-level
 * constants, not inline magic numbers, because both bounds are pinned by a
 * test from each side (48-07 Task 3, tests 7/8) — a later change to either
 * has to move a test, not just a comment.
 *
 * +5 minutes forward: a submitter's device clock is not the authority's own.
 * This project has a recorded ~45s emulator/host clock-skew failure (project
 * memory: device proof clock skew) — the tolerance is deliberately an order
 * of magnitude wider than that observed drift, so an honest fast clock is
 * never rejected. Beyond 5 minutes the claim is to have signed AFTER the
 * authority received the document, which no clock error explains.
 */
const SUBMITTED_AT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

/**
 * -30 days backward: the filesystem courier (48-09) is a BATCH/periodic sync
 * (doc/registration.md:12) — a staged document may legitimately sit in a
 * drop directory, and a bulk import prepared from a legacy roll may be
 * delivered well after it was signed. 30 days accommodates any realistic
 * courier delay while still bounding what lands in the audit record and in
 * D-09's median time-to-decision.
 */
const SUBMITTED_AT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * D-07/48-08: bounded enumeration of the CLOSED, 4-item checklist vocabulary
 * (`VERIFICATION_CHECKLIST_ITEM_ORDER`, imported — its four members are NOT
 * re-listed here; re-declaring the vocabulary in more than one place is
 * exactly how a digest and its gate drift apart)'s gate-valid subsets — at
 * most 8 of the 16 possible subsets pass
 * `isChecklistGateMet`. Computed ONCE at module scope (the vocabulary is
 * fixed, so this never needs recomputation per call) and consumed by
 * `RegistrationEngine.recoverVerificationChecklist` to recover a decided
 * request's checklist from its persisted `VerificationCid` WITHOUT storing
 * the item set anywhere (no new storage — D-09). Enumeration is sound only
 * because the vocabulary is closed and small; widening it beyond 4 items
 * requires revisiting this enumeration (2^n subsets) or persisting the
 * items directly — do not "fix" a widened vocabulary by growing this loop
 * unboundedly.
 */
const CHECKLIST_GATE_VALID_CANDIDATES: RegistrationVerificationChecklistItem[][] = (() => {
  const items = VERIFICATION_CHECKLIST_ITEM_ORDER
  const candidates: RegistrationVerificationChecklistItem[][] = []
  for (let mask = 1; mask < (1 << items.length); mask++) {
    const subset: RegistrationVerificationChecklistItem[] = []
    for (let i = 0; i < items.length; i++) {
      if ((mask & (1 << i)) !== 0) subset.push(items[i]!)
    }
    if (isChecklistGateMet(subset)) candidates.push(subset)
  }
  return candidates
})()

// 999.1 D-01/D-02: RegistrationEngine mutations allocate Tids through the
// shared durable, peer-safe allocator (`../database/tid-allocator.js`,
// namespace 'registration') instead of a process-local `Date.now()` counter
// — closes the restart/multi-peer Tid-collision replay window this module
// previously carried (superseded the retired `nextRegistrationTid`/
// `peekNextRegistrationTid()` pair; see `tid-allocator.ts`'s `peekTid` for
// the equivalent introspection hook).

// WR-01/WR-04 (42-REVIEW): the datetime + ceremony helpers were consolidated
// into ../signing/ceremony-helpers.js so the three Phase-42 engines share ONE
// canonical copy (the divergent registration copy of toIsoZDatetime that lost
// the bare-ISO read-back branch was WR-01). See that module for the doc comments.

/**
 * RegistrationEngine — Phase 42-03 (D-01/D-02/D-15/D-18/D-21) implementation.
 *
 * Unwired `(ctx?: EngineContext)` constructor per the `ElectionsEngine`
 * precedent (RESEARCH Open Question 1) — no `INetworkEngine` factory this
 * phase; `AuthorityId` is a per-row field, not a fixed engine-instance
 * identity.
 *
 * Scope boundaries (this plan): Registrant + RegistrantPublic + RegistrantPrivate
 * tier create/read + the multi-row Register ceremony. `RegistrantSelective`
 * (42-08), `ElectionRegistrant` roster + Status/Expiration lifecycle (42-06),
 * and `ElectionRegistrationField` policy (42-07) are stubbed below with clear
 * "not yet implemented" errors — they exist on `IRegistrationEngine` because
 * later Phase-42 plans extend this SAME class, not because they're silently
 * dropped.
 */
export class RegistrationEngine implements IRegistrationEngine {
  constructor (private readonly ctx?: EngineContext) {}

  // ---------- signing helpers ----------

  /** Normalizes the Signature|callback union into a single callback shape (WR-04: shared). */
  private resolveSign (signatureOrCallback: SignatureOrCallback): (digest: Uint8Array) => Promise<Signature> {
    return resolveSignHelper(signatureOrCallback)
  }

  // ---------- Cid compute helpers (pure, no insert — Pitfall 4: Cids-before-parent) ----------

  /** RegistrantPublic.CidValid: Cid = cid(Digest(RegistrantId, LastName, FirstName, District, ExtraFields)). */
  private async computeRegistrantPublicCid (
    registrantId: string,
    input: { lastName?: string; firstName?: string; district?: string; extraFields?: Record<string, unknown> }
  ): Promise<string> {
    const ctx = this.ctx!
    const extraFieldsJson = input.extraFields ? JSON.stringify(input.extraFields) : null
    const row = await ctx.db
      .prepare('select cid(Digest(:registrantId, :lastName, :firstName, :district, :extraFields)) as c')
      .get({
        registrantId,
        lastName: input.lastName ?? null,
        firstName: input.firstName ?? null,
        district: input.district ?? null,
        extraFields: extraFieldsJson
      })
    if (!row || row.c == null) {
      throw new Error('computeRegistrantPublicCid: cid(Digest(...)) returned null — crypto plugin not registered?')
    }
    return row.c as string
  }

  /**
   * RegistrantPrivate.CidValid: Cid = cid(Digest(RegistrantId, Expiration, PrivateDetails)).
   * D-49: `storedDetails` is the EXACT text that will be bound into the `PrivateDetails` column —
   * the sealed envelope string, or `REGISTRANT_PRIVATE_EMPTY_DETAILS` — never a re-stringified copy
   * of the plaintext leaves (sealing is randomized, so re-stringifying would digest DIFFERENT bytes
   * than what the row actually stores, and `RegistrantCidMatch` would fail).
   */
  private async computeRegistrantPrivateCid (
    registrantId: string,
    input: { expiration: Timestamp | string; storedDetails: string }
  ): Promise<string> {
    const ctx = this.ctx!
    const expiration = toIsoZDatetime(input.expiration)
    const row = await ctx.db
      .prepare('select cid(Digest(:registrantId, :expiration, :privateDetails)) as c')
      .get({ registrantId, expiration, privateDetails: input.storedDetails })
    if (!row || row.c == null) {
      throw new Error('computeRegistrantPrivateCid: cid(Digest(...)) returned null — crypto plugin not registered?')
    }
    return row.c as string
  }

  /**
   * RegistrantSelective.CidValid: Cid = cid(set_commit(SelectiveDetails)) — the
   * DB computes the root (never hand-rolled in JS) so it byte-matches the
   * schema's own re-derivation. Unlike RegistrantPublic/Private's CidValid,
   * this formula does NOT include RegistrantId (schema's own formula, verbatim).
   */
  private async computeRegistrantSelectiveCid (selectiveDetailsJson: string): Promise<string> {
    const ctx = this.ctx!
    const row = await ctx.db
      .prepare('select cid(set_commit(:details)) as c')
      .get({ details: selectiveDetailsJson })
    if (!row || row.c == null) {
      throw new Error('computeRegistrantSelectiveCid: cid(set_commit(...)) returned null — crypto plugin not registered?')
    }
    return row.c as string
  }

  /**
   * D-13: turn caller-supplied `{name, value}` field inputs into engine-
   * generated `SelectiveLeaf[]` — a fresh SQL `random_bytes` (>=128 bits)
   * salt per leaf, NEVER a JS ad-hoc RNG. Duplicate names and an empty/
   * missing salt are rejected BEFORE any DB ceremony runs: the duplicate
   * check runs first (pure, no DB call) so a caller never pays for salt
   * generation on a payload that's going to be rejected anyway.
   */
  private async buildSelectiveLeaves (fields: RegisterSelectivePayload): Promise<SelectiveLeaf[]> {
    const ctx = this.ctx!
    const seen = new Set<string>()
    for (const field of fields) {
      if (seen.has(field.name)) {
        throw new Error(`register: duplicate selective field name '${field.name}' (D-13)`)
      }
      seen.add(field.name)
    }
    const leaves: SelectiveLeaf[] = []
    for (const field of fields) {
      const saltRow = await ctx.db.prepare('select random_bytes(128) as s').get({})
      const salt = saltRow?.s == null ? '' : String(saltRow.s)
      if (!salt) {
        throw new Error(`register: engine could not obtain a non-empty salt for selective field '${field.name}' (D-13)`)
      }
      leaves.push({ name: field.name, value: field.value, salt })
    }
    return leaves
  }

  // ---------- tier create methods ----------

  /**
   * Insert the parent `Registrant` row. Two DISTINCT digests/signatures are
   * involved (Pitfall 4 / T-42-03-01/02):
   *   1. The row-level "signor" signature — a REAL secp256k1 signature over
   *      `Digest(Id, AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status,
   *      Expiration)`, independently verified by the schema's `SignatureValid`
   *      CHECK (a portable, self-verifiable proof — D-19).
   *   2. The `vrg`-scoped `AdminSigning`/`AdminSignature` ceremony pair, whose
   *      Digest covers the row's ENTIRE field list INCLUDING the SignorKey/
   *      Signature values produced by (1) — `MutationValid`'s own formula.
   * `signatureOrCallback` is resolved (and invoked) independently for each —
   * a real callback receives two DIFFERENT digest byte sequences and must
   * sign both; a static `Signature` is reused for both (safe: only (1) is
   * ever independently crypto-verified by the schema).
   */
  async createRegistrant (
    input: {
      id: string
      authorityId: string
      privateCid: string
      publicCid?: string
      selectiveCid?: string
      status?: RegistrantStatus
      expiration: Timestamp | string
    },
    signatureOrCallback: SignatureOrCallback,
    options?: { ownsTransaction?: boolean; headerNonce?: string }
  ): Promise<Registrant> {
    this.requireCtx('createRegistrant')
    const ctx = this.ctx!

    // R2/D-04/D-05: same guard as register() — protects a direct caller of
    // createRegistrant() too. Kept outside the try/catch below for the same
    // reason (this.rethrow() would otherwise wrap it into a plain Error).
    const existingRegistrant = await ctx.db
      .prepare('select 1 from Registrant where Id = :id')
      .get({ id: input.id })
    if (existingRegistrant) {
      throw new RegistrantAlreadyExistsError(input.id)
    }

    const tid = await allocateTid(ctx.db, 'registration')
    try {
      const status = input.status ?? 'a'
      const expiration = toIsoZDatetime(input.expiration)
      const publicCid = input.publicCid ?? null
      const selectiveCid = input.selectiveCid ?? null

      // 1. Row-level signor signature (D-19 portable proof).
      const rowDigestRow = await ctx.db
        .prepare('select Digest(:id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expiration) as d')
        .get({
          id: input.id,
          authorityId: input.authorityId,
          privateCid: input.privateCid,
          publicCid,
          selectiveCid,
          status,
          expiration
        })
      if (!rowDigestRow || rowDigestRow.d == null) {
        throw new Error('createRegistrant: Digest() returned null for row-level signature — crypto plugin not registered?')
      }
      const rowDigestBytes = digestToBytes(rowDigestRow.d)
      const rowSignature = await this.resolveSign(signatureOrCallback)(rowDigestBytes)

      // 2. AdminSigning ceremony ('vrg') — MutationValid's own field list, including
      //    the SignorKey/Signature produced in step 1. NOTE 1: bind names
      //    `rowSignorKey`/`rowSignature` (NOT `signerKey`/`signature`) —
      //    seedSignedMutation reserves `signerKey`/`signature`/`userId`/etc for ITS
      //    OWN ceremony bind params and would silently overwrite a same-named
      //    digestParams entry (T-42-03 bug found via TDD: a `signature` key here
      //    collided with the ceremony's own admin signature bind, corrupting the
      //    stored AdminSigning.Digest). NOTE 2: `MutationValid` contains a subquery
      //    (`exists(...)`) so it is a DEFERRED check — Quereus's deferred-check
      //    snapshot coerces `new.Expiration` through a Z-stripping round-trip
      //    (see `toDeferredCheckDatetime`'s doc comment); the ceremony digest MUST
      //    use that coerced form, NOT the Z-suffixed `expiration` bound on the row.
      const expirationForDeferredCheck = toDeferredCheckDatetime(input.expiration)
      const digestExpr = 'select Digest(:tid, :id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expirationDeferred, :rowSignorKey, :rowSignature) as d'
      const digestParams = {
        tid,
        id: input.id,
        authorityId: input.authorityId,
        privateCid: input.privateCid,
        publicCid,
        selectiveCid,
        status,
        expirationDeferred: expirationForDeferredCheck,
        rowSignorKey: rowSignature.signerKey,
        rowSignature: rowSignature.signature
      }
      const nonce = await seedSignedMutation(
        ctx,
        input.authorityId,
        'vrg',
        tid,
        digestExpr,
        digestParams,
        this.resolveSign(signatureOrCallback),
        options
      )

      await ctx.db.exec(
        `insert into Registrant (
          Id, AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status, Expiration, SignorKey, Signature
        )
        with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
        values (:id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expiration, :signorKey, :signature)`,
        {
          id: input.id,
          authorityId: input.authorityId,
          privateCid: input.privateCid,
          publicCid,
          selectiveCid,
          status,
          expiration,
          signorKey: rowSignature.signerKey,
          signature: rowSignature.signature,
          signingNonce: nonce,
          now: nowCanonicalDatetime()
        }
      )

      return {
        id: input.id,
        authorityId: input.authorityId,
        privateCid: input.privateCid,
        publicCid: publicCid ?? undefined,
        selectiveCid: selectiveCid ?? undefined,
        status,
        expiration: input.expiration,
        signorKey: rowSignature.signerKey,
        signature: rowSignature.signature
      }
    } catch (err) {
      this.rethrow(err, 'createRegistrant')
    }
  }

  /**
   * Insert a `RegistrantPublic` tier row. Requires the parent `Registrant`
   * row to already exist (its `AuthorityId` is looked up to seed the `vrg`
   * ceremony; `RegistrantCidMatch` requires `Registrant.PublicCid = new.Cid`).
   */
  async createRegistrantPublic (
    input: {
      registrantId: string
      lastName?: string
      firstName?: string
      district?: string
      extraFields?: Record<string, unknown>
    },
    signatureOrCallback: SignatureOrCallback,
    options?: { ownsTransaction?: boolean; headerNonce?: string }
  ): Promise<RegistrantPublic> {
    this.requireCtx('createRegistrantPublic')
    const ctx = this.ctx!
    const tid = await allocateTid(ctx.db, 'registration')
    try {
      const registrantRow = await ctx.db
        .prepare('select AuthorityId from Registrant where Id = :registrantId')
        .get({ registrantId: input.registrantId })
      if (!registrantRow) {
        throw new Error(`createRegistrantPublic: Registrant not found for registrantId=${input.registrantId}`)
      }
      const authorityId = asText(registrantRow.AuthorityId, 'Registrant.AuthorityId')

      const cid = await this.computeRegistrantPublicCid(input.registrantId, input)
      const extraFieldsJson = input.extraFields ? JSON.stringify(input.extraFields) : null
      const lastName = input.lastName ?? null
      const firstName = input.firstName ?? null
      const district = input.district ?? null

      const digestExpr = 'select Digest(:tid, :cid, :registrantId, :lastName, :firstName, :district, :extraFields) as d'
      const digestParams = {
        tid,
        cid,
        registrantId: input.registrantId,
        lastName,
        firstName,
        district,
        extraFields: extraFieldsJson
      }
      const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback), options)

      await ctx.db.exec(
        `insert into RegistrantPublic (Cid, RegistrantId, LastName, FirstName, District, ExtraFields)
         with context SigningNonce = :signingNonce, Tid = ${tid}
         values (:cid, :registrantId, :lastName, :firstName, :district, :extraFields)`,
        {
          cid,
          registrantId: input.registrantId,
          lastName,
          firstName,
          district,
          extraFields: extraFieldsJson,
          signingNonce: nonce
        }
      )

      return {
        cid,
        registrantId: input.registrantId,
        lastName: lastName ?? undefined,
        firstName: firstName ?? undefined,
        district: district ?? undefined,
        extraFields: input.extraFields
      }
    } catch (err) {
      this.rethrow(err, 'createRegistrantPublic')
    }
  }

  /**
   * D-49: the shared insert path for a `RegistrantPrivate` tier row — accepts the ALREADY-SEALED
   * `storedDetails` text (the sealed envelope, or `REGISTRANT_PRIVATE_EMPTY_DETAILS`) and performs
   * only the digest/seedSignedMutation/INSERT ceremony. Never seals — callers seal exactly once,
   * before calling this (sealing is randomized; sealing twice for one row would produce two
   * different Cids and RegistrantCidMatch would fail). `authorityId` is supplied by the caller
   * rather than re-queried, so `register()` can call this from inside its own transaction right
   * after the parent `Registrant` row's INSERT (Pitfall 4, Cids-before-parent) without a redundant
   * read of the row it just wrote.
   */
  private async insertRegistrantPrivateRow (
    registrantId: string,
    authorityId: string,
    expiration: Timestamp | string,
    storedDetails: string,
    signatureOrCallback: SignatureOrCallback,
    options?: { ownsTransaction?: boolean; headerNonce?: string }
  ): Promise<{ cid: string }> {
    const ctx = this.ctx!
    const tid = await allocateTid(ctx.db, 'registration')
    const expirationZ = toIsoZDatetime(expiration)
    const cid = await this.computeRegistrantPrivateCid(registrantId, { expiration, storedDetails })

    // InsertValid contains a subquery (exists(...)) -> DEFERRED check -> its
    // new.Expiration snapshot is Z-stripped (see toDeferredCheckDatetime).
    // CidValid (above, immediate) correctly used the Z-suffixed form.
    const expirationForDeferredCheck = toDeferredCheckDatetime(expiration)
    const digestExpr = 'select Digest(:tid, :cid, :registrantId, :expirationDeferred, :privateDetails) as d'
    const digestParams = { tid, cid, registrantId, expirationDeferred: expirationForDeferredCheck, privateDetails: storedDetails }
    const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback), options)

    await ctx.db.exec(
      `insert into RegistrantPrivate (Cid, RegistrantId, Expiration, PrivateDetails)
       with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
       values (:cid, :registrantId, :expiration, :privateDetails)`,
      {
        cid,
        registrantId,
        expiration: expirationZ,
        privateDetails: storedDetails,
        signingNonce: nonce,
        now: nowCanonicalDatetime()
      }
    )

    return { cid }
  }

  /**
   * Insert a `RegistrantPrivate` tier row (authority-held, insert-only,
   * never disclosed). Requires the parent `Registrant` row to already exist.
   * D-49: seals `input.details` ONCE (62-14's `createIntakeSealer`, resolved to the current
   * officers of the Registrant's own authority) before computing the Cid and inserting — the
   * returned `privateDetails`/`detailsAccess` reflect what THIS CALL just wrote, not a fresh open.
   */
  async createRegistrantPrivate (
    input: { registrantId: string; expiration: Timestamp | string; details: PrivateDetail[] },
    signatureOrCallback: SignatureOrCallback,
    options?: { ownsTransaction?: boolean; headerNonce?: string }
  ): Promise<RegistrantPrivate> {
    this.requireCtx('createRegistrantPrivate')
    const ctx = this.ctx!
    try {
      const registrantRow = await ctx.db
        .prepare('select AuthorityId from Registrant where Id = :registrantId')
        .get({ registrantId: input.registrantId })
      if (!registrantRow) {
        throw new Error(`createRegistrantPrivate: Registrant not found for registrantId=${input.registrantId}`)
      }
      const authorityId = asText(registrantRow.AuthorityId, 'Registrant.AuthorityId')
      const details = input.details ?? []

      const storedDetails = await sealRegistrantPrivateDetails(ctx.db, { authorityId, registrantId: input.registrantId, details })
      const { cid } = await this.insertRegistrantPrivateRow(input.registrantId, authorityId, input.expiration, storedDetails, signatureOrCallback, options)

      return { cid, registrantId: input.registrantId, expiration: input.expiration, privateDetails: details, detailsAccess: 'opened' }
    } catch (err) {
      if (err instanceof IntakeError) throw err
      this.rethrow(err, 'createRegistrantPrivate')
    }
  }

  /**
   * Shared insert path for `RegistrantSelective` — accepts PRECOMPUTED leaves
   * (with their engine-generated salts already fixed) + the matching Cid.
   * `register()`'s Cids-before-parent step and this row-level insert MUST
   * share the IDENTICAL leaf set: salts are random, so recomputing them here
   * would silently produce a Cid that no longer matches the one already
   * embedded in `Registrant.SelectiveCid` (Pitfall 4 variant unique to the
   * salted-set construction — Digest()-based tiers don't have this hazard
   * since their Cid formula is pure/deterministic over the same inputs).
   */
  private async insertRegistrantSelectiveRow (
    registrantId: string,
    expiration: Timestamp | string,
    leaves: SelectiveLeaf[],
    storedDetails: string,
    cid: string,
    signatureOrCallback: SignatureOrCallback,
    options?: { ownsTransaction?: boolean; headerNonce?: string }
  ): Promise<RegistrantSelective> {
    const ctx = this.ctx!
    const tid = await allocateTid(ctx.db, 'registration')
    const registrantRow = await ctx.db
      .prepare('select AuthorityId from Registrant where Id = :registrantId')
      .get({ registrantId })
    if (!registrantRow) {
      throw new Error(`createRegistrantSelective: Registrant not found for registrantId=${registrantId}`)
    }
    const authorityId = asText(registrantRow.AuthorityId, 'Registrant.AuthorityId')
    const expirationZ = toIsoZDatetime(expiration)
    // D-52: the STORED text (sealed envelope, or the '[]' empty constant) feeds the vrg digest and the INSERT.
    const selectiveDetailsJson = storedDetails

    // InsertValid contains a subquery (exists(...)) -> DEFERRED check -> its
    // new.Expiration snapshot is Z-stripped (see toDeferredCheckDatetime).
    const expirationForDeferredCheck = toDeferredCheckDatetime(expiration)
    const digestExpr = 'select Digest(:tid, :cid, :registrantId, :expirationDeferred, :selectiveDetails) as d'
    const digestParams = { tid, cid, registrantId, expirationDeferred: expirationForDeferredCheck, selectiveDetails: selectiveDetailsJson }
    const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback), options)

    await ctx.db.exec(
      `insert into RegistrantSelective (Cid, RegistrantId, Expiration, SelectiveDetails)
       with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
       values (:cid, :registrantId, :expiration, :selectiveDetails)`,
      {
        cid,
        registrantId,
        expiration: expirationZ,
        selectiveDetails: selectiveDetailsJson,
        signingNonce: nonce,
        now: nowCanonicalDatetime()
      }
    )

    return { cid, registrantId, expiration, selectiveDetails: leaves, detailsAccess: isSealedRegistrationContent(storedDetails) ? 'opened' : 'unsealed' }
  }

  /**
   * Insert a `RegistrantSelective` tier row (authority-held, insert-only,
   * flat salted-leaf set commitment, D-11/D-12/D-13). Standalone/additive
   * counterpart to `createRegistrantPublic`/`createRegistrantPrivate` — the
   * Register flow's own selective branch (in `register()` below) generates
   * its leaves + Cid via the SAME `buildSelectiveLeaves`/
   * `computeRegistrantSelectiveCid` helpers but does NOT call this method
   * directly (it needs the leaves/Cid BEFORE the parent Registrant insert —
   * see `insertRegistrantSelectiveRow`'s doc comment).
   */
  async createRegistrantSelective (
    input: { registrantId: string; expiration: Timestamp | string; fields: RegisterSelectivePayload },
    signatureOrCallback: SignatureOrCallback,
    options?: { ownsTransaction?: boolean }
  ): Promise<RegistrantSelective> {
    this.requireCtx('createRegistrantSelective')
    try {
      const leaves = await this.buildSelectiveLeaves(input.fields)
      const cid = await this.computeRegistrantSelectiveCid(JSON.stringify(leaves))
      // D-52: seal ONCE (Cid is over the plaintext leaves, computed above). An empty field set keeps its
      // pre-D-52 behavior: the constant '[]' is stored unsealed (no recipient needed to say "nothing") and reads back 'unsealed'.
      const registrantRow = await this.ctx!.db
        .prepare('select AuthorityId from Registrant where Id = :registrantId')
        .get({ registrantId: input.registrantId })
      if (!registrantRow) {
        throw new Error(`createRegistrantSelective: Registrant not found for registrantId=${input.registrantId}`)
      }
      const stored = leaves.length === 0
        ? '[]'
        : await sealRegistrantSelectiveDetails(this.ctx!.db, {
          authorityId: asText(registrantRow.AuthorityId, 'Registrant.AuthorityId'),
          registrantId: input.registrantId,
          cid,
          leaves
        })
      return await this.insertRegistrantSelectiveRow(input.registrantId, input.expiration, leaves, stored, cid, signatureOrCallback, options)
    } catch (err) {
      this.rethrow(err, 'createRegistrantSelective')
    }
  }

  // ---------- reads ----------

  async getRegistrant (registrantId: string): Promise<Registrant | undefined> {
    if (!this.ctx) return undefined
    try {
      const row = await this.ctx.db
        .prepare('select Id, AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status, Expiration, SignorKey, Signature from Registrant where Id = :id')
        .get({ id: registrantId })
      if (!row) return undefined
      return {
        id: asText(row.Id, 'Registrant.Id'),
        authorityId: asText(row.AuthorityId, 'Registrant.AuthorityId'),
        privateCid: asText(row.PrivateCid, 'Registrant.PrivateCid'),
        publicCid: row.PublicCid == null ? undefined : asText(row.PublicCid, 'Registrant.PublicCid'),
        selectiveCid: row.SelectiveCid == null ? undefined : asText(row.SelectiveCid, 'Registrant.SelectiveCid'),
        status: asText(row.Status, 'Registrant.Status') as RegistrantStatus,
        expiration: reZuluDatetime(row.Expiration as string),
        signorKey: asText(row.SignorKey, 'Registrant.SignorKey'),
        signature: asText(row.Signature, 'Registrant.Signature')
      }
    } catch (err) {
      this.rethrow(err, 'getRegistrant')
    }
  }

  /**
   * D-18: fixed columns (LastName/FirstName/District) plus the ExtraFields
   * json object, parsed via `parseJsonOr` (single source of truth for
   * JSON-parse-with-fallback per utils.ts). See `getRegistrantPublicField`/
   * `getRegistrantPublicExtraFieldKeys` below for the D-21 json_extract/
   * json_each SQL-level resolution paths a field-policy caller uses.
   */
  async getRegistrantPublic (registrantId: string): Promise<RegistrantPublic | undefined> {
    if (!this.ctx) return undefined
    try {
      const row = await this.ctx.db
        .prepare(
          'select T.Cid, T.RegistrantId, T.LastName, T.FirstName, T.District, T.ExtraFields '
          + `from RegistrantPublic T ${REGISTRANT_PUBLIC_POINT_CURRENCY_JOIN} `
          + 'where T.RegistrantId = :registrantId'
        )
        .get({ registrantId })
      if (!row) return undefined
      return {
        cid: asText(row.Cid, 'RegistrantPublic.Cid'),
        registrantId: asText(row.RegistrantId, 'RegistrantPublic.RegistrantId'),
        lastName: row.LastName == null ? undefined : asText(row.LastName, 'RegistrantPublic.LastName'),
        firstName: row.FirstName == null ? undefined : asText(row.FirstName, 'RegistrantPublic.FirstName'),
        district: row.District == null ? undefined : asText(row.District, 'RegistrantPublic.District'),
        extraFields: parseJsonOr<Record<string, unknown>>(row.ExtraFields, {}, 'RegistrantPublic.ExtraFields')
      }
    } catch (err) {
      this.rethrow(err, 'getRegistrantPublic')
    }
  }

  /**
   * D-18/D-21: resolve a policy-declared field name to a `RegistrantPublic`
   * fixed column if one exists, else to an `ExtraFields` json key via
   * `json_extract` — cast to text, since json_extract's JSON-typed return is
   * not directly `=`-comparable (the 36-01 Probe 3b pitfall).
   */
  async getRegistrantPublicField (registrantId: string, fieldName: string): Promise<string | undefined> {
    this.requireCtx('getRegistrantPublicField')
    const ctx = this.ctx!
    const fixedColumns: Record<string, string> = { lastname: 'LastName', firstname: 'FirstName', district: 'District' }
    const column = fixedColumns[fieldName.toLowerCase()]
    try {
      if (column) {
        const row = await ctx.db
          .prepare(
            `select T.${column} as v `
            + `from RegistrantPublic T ${REGISTRANT_PUBLIC_POINT_CURRENCY_JOIN} `
            + 'where T.RegistrantId = :registrantId'
          )
          .get({ registrantId })
        return row?.v == null ? undefined : asText(row.v, `RegistrantPublic.${column}`)
      }
      const path = `$.${fieldName}`
      const row = await ctx.db
        .prepare(
          'select cast(json_extract(T.ExtraFields, :path) as text) as v '
          + `from RegistrantPublic T ${REGISTRANT_PUBLIC_POINT_CURRENCY_JOIN} `
          + 'where T.RegistrantId = :registrantId'
        )
        .get({ registrantId, path })
      return row?.v == null ? undefined : String(row.v)
    } catch (err) {
      this.rethrow(err, 'getRegistrantPublicField')
    }
  }

  /** D-18/D-21: enumerate all ExtraFields keys via `json_each`. */
  async getRegistrantPublicExtraFieldKeys (registrantId: string): Promise<string[]> {
    this.requireCtx('getRegistrantPublicExtraFieldKeys')
    const ctx = this.ctx!
    try {
      const row = await ctx.db
        .prepare(
          'select T.ExtraFields '
          + `from RegistrantPublic T ${REGISTRANT_PUBLIC_POINT_CURRENCY_JOIN} `
          + 'where T.RegistrantId = :registrantId'
        )
        .get({ registrantId })
      if (!row || row.ExtraFields == null) return []
      const keys: string[] = []
      for await (const r of ctx.db.eval('select key as k from json_each(:extraFields)', { extraFields: row.ExtraFields })) {
        keys.push(String(r.k))
      }
      return keys
    } catch (err) {
      this.rethrow(err, 'getRegistrantPublicExtraFieldKeys')
    }
  }

  async getRegistrantPrivate (registrantId: string): Promise<RegistrantPrivate | undefined> {
    if (!this.ctx) return undefined
    try {
      const row = await this.ctx.db
        .prepare(
          'select T.Cid, T.RegistrantId, T.Expiration, T.PrivateDetails '
          + `from RegistrantPrivate T ${REGISTRANT_PRIVATE_POINT_CURRENCY_JOIN} `
          + 'where T.RegistrantId = :registrantId'
        )
        .get({ registrantId })
      if (!row) return undefined
      // D-49: open through the one seal/open module — never parseJsonOr the raw column again.
      const read = await openRegistrantPrivateDetails(this.ctx.db, this.ctx.intakeOpener, {
        registrantId: asText(row.RegistrantId, 'RegistrantPrivate.RegistrantId'),
        stored: row.PrivateDetails
      })
      return {
        cid: asText(row.Cid, 'RegistrantPrivate.Cid'),
        registrantId: asText(row.RegistrantId, 'RegistrantPrivate.RegistrantId'),
        expiration: reZuluDatetime(row.Expiration as string),
        privateDetails: read.details ?? [],
        detailsAccess: read.access
      }
    } catch (err) {
      this.rethrow(err, 'getRegistrantPrivate')
    }
  }

  /** Authority-side, full (undisclosed) RegistrantSelective read (D-11/D-12/D-13). */
  async getRegistrantSelective (registrantId: string): Promise<RegistrantSelective | undefined> {
    if (!this.ctx) return undefined
    try {
      const row = await this.ctx.db
        .prepare(
          'select T.Cid, T.RegistrantId, T.Expiration, T.SelectiveDetails '
          + `from RegistrantSelective T ${REGISTRANT_SELECTIVE_POINT_CURRENCY_JOIN} `
          + 'where T.RegistrantId = :registrantId'
        )
        .get({ registrantId })
      if (!row) return undefined
      const cid = asText(row.Cid, 'RegistrantSelective.Cid')
      const registrantIdText = asText(row.RegistrantId, 'RegistrantSelective.RegistrantId')
      // D-52: open through the one seal/open module (tier-2 set_commit recheck inside) — never parse the raw column.
      const read = await openRegistrantSelectiveDetails(this.ctx.db, this.ctx.intakeOpener, {
        registrantId: registrantIdText,
        cid,
        stored: row.SelectiveDetails
      })
      return {
        cid,
        registrantId: registrantIdText,
        expiration: reZuluDatetime(row.Expiration as string),
        selectiveDetails: read.leaves,
        detailsAccess: read.access
      }
    } catch (err) {
      this.rethrow(err, 'getRegistrantSelective')
    }
  }

  /**
   * D-01: record one app-mediated read of a registrant's private tier.
   * Accountability/deterrence/regulatory posture only — NOT a security
   * control; direct local database access bypasses this entirely and writes
   * no row. D-02: deliberately UNSIGNED — no `seedSignedMutation`, no
   * `SigningNonce`, no signature parameter. `vrg`-signing every read would
   * grow `AdminSignature` with read traffic, which D-02 refused to pay.
   */
  async recordRegistrantAccessEvent (registrantId: string, viewerUserId: string, fields: string[]): Promise<void> {
    this.requireCtx('recordRegistrantAccessEvent')
    const ctx = this.ctx!
    try {
      // The allowlist derivation must read RegistrantPrivate.PrivateDetails —
      // which carries the registrant's actual SSN/DOB/phone VALUES — in order
      // to learn the NAMES. `privateDetails` is confined to this one `const`
      // and goes out of scope immediately below: it is never logged, never
      // interpolated into a message, never returned, and never rethrown; only
      // the NAME set `collectPrivateFieldNames` derives from it leaves this
      // statement (T-47-11).
      // D-49: opened through the one seal/open module. An unread access (no opener, not a
      // recipient, unreadable) yields an EMPTY allowlist — this ctx cannot prove which fields are
      // genuinely private, so it records nothing rather than guessing (fail closed, T-47-11's own
      // discipline extended to sealed rows).
      const privateRow = await ctx.db
        .prepare(
          'select T.PrivateDetails '
          + `from RegistrantPrivate T ${REGISTRANT_PRIVATE_POINT_CURRENCY_JOIN} `
          + 'where T.RegistrantId = :registrantId'
        )
        .get({ registrantId })
      const privateRead = await openRegistrantPrivateDetails(ctx.db, ctx.intakeOpener, { registrantId, stored: privateRow?.PrivateDetails ?? null })
      const privateDetails = privateRead.details ?? []
      const allowedNames = collectPrivateFieldNames(privateDetails)

      const safeFields = sanitizeAccessTrailFields(fields, allowedNames)
      if (safeFields.length === 0) {
        // The normal no-reveal case (an empty visit accumulator flushes
        // nothing) and also what a caller passing VALUES instead of NAMES
        // collapses to — resolve without allocating a Tid or touching the DB.
        return
      }

      // Sequence allocation is a read-then-insert with no enclosing
      // transaction, so two overlapping calls can read the same
      // `max(Sequence)` and the second insert then violates
      // `primary key (RegistrantId, Sequence)`. This is genuinely reachable:
      // `useAccessTrailVisit` fires BOTH its flushes as fire-and-forget
      // (`void visitRef.current?.flush()`), so a background flush and an
      // unmount flush can overlap, and `createAccessTrailVisit.flush()`
      // swallows the rejection in an empty catch — the losing audit row would
      // disappear with no trace at all.
      //
      // Retry rather than lock: on a failed insert, re-read the high-water
      // mark. If it ADVANCED past the sequence we tried, another writer won
      // the race and we retry with the new value. If it did not advance, the
      // failure was not a race (a CHECK violation, a storage error) and is
      // rethrown immediately — deliberately not sniffing the driver's error
      // TEXT for "primary key", which would silently stop working the moment
      // that wording changed. Known imprecision, accepted: a non-race failure
      // that COINCIDES with an unrelated writer advancing the counter is
      // still classified as a race and retried. It costs at most
      // SEQUENCE_ALLOCATION_ATTEMPTS attempts before the original error is
      // rethrown, and the own-row probe below keeps it from duplicating a row.
      const readNextSequence = async (): Promise<number> => {
        const seqRow = await ctx.db
          .prepare('select coalesce(max(Sequence), -1) + 1 as n from RegistrantAccessEvent where RegistrantId = :registrantId')
          .get({ registrantId })
        return asNumberOr(seqRow?.n, 0, 'RegistrantAccessEvent.Sequence')
      }

      const timestamp = toIsoZDatetime(Date.now())
      const fieldsJson = JSON.stringify(safeFields)

      // "Did the counter move?" is NOT the same question as "did another
      // writer win?" — our own row moves it too. If `db.exec` rejects AFTER
      // the row landed (project memory records intermittent
      // `stale revision: rev 1 vs rev 1` rejections from @optimystic/db-p2p
      // 0.18), a bare high-water test reads our own row as someone else's,
      // retries at sequence + 1, and appends a SECOND copy of the same
      // logical event. `RegistrantAccessEvent` is
      // `constraint InsertOnly check on update, delete (false)`, so that
      // duplicate can never be removed. The fresh-Tid-per-attempt note above
      // rules out Tid replay, not row duplication.
      //
      // So probe for OUR row specifically, comparing every non-key column:
      // a row another writer placed at this sequence differs in at least one
      // of ViewerUserId / Timestamp / Fields. (Two flushes that agree on all
      // three are byte-identical audit rows for one viewer at one instant;
      // treating those as already-landed is the safe reading, since the
      // alternative is a permanent unremovable duplicate.)
      //
      // TIMESTAMP COMPARISON MUST BE SEMANTIC, NOT TEXTUAL.
      //
      // `Timestamp` does not round-trip as the string that was bound. Quereus
      // coerces the `datetime` column through a `Temporal.PlainDateTime`-shaped
      // normalization which (a) drops the trailing `Z` that `TimestampValid`
      // requires on the way IN, and (b) STRIPS TRAILING ZEROS from the
      // fractional seconds. Observed: bound `2026-08-05T12:04:31.910Z` stored
      // as `2026-08-05T12:04:31.91`.
      //
      // (b) is why an earlier `stripZ`-only comparison was intermittently
      // wrong rather than always wrong: it only diverges when `Date.now()`
      // lands on a millisecond ending in zero, i.e. roughly one call in ten.
      // The consequence was the exact defect this probe exists to prevent —
      // the probe answered "not ours", the retry ran, and a SECOND copy of the
      // same logical event was appended to a table declared
      // `constraint InsertOnly check on update, delete (false)`, so the
      // duplicate could never be removed. It presented as a ~10% flaky test.
      //
      // Comparing instants sidesteps every formatting question: parse both
      // sides to epoch milliseconds, appending `Z` to the stored value because
      // Quereus stores UTC without a designator and `new Date()` would
      // otherwise read it as LOCAL time (see `fromCanonicalDatetime` in
      // utils.ts). Any future change to the stored spelling — more or fewer
      // fractional digits, a space separator — is absorbed automatically.
      const asInstant = (value: string): number => {
        const withZone = value.endsWith('Z') ? value : `${value}Z`
        return new Date(withZone).getTime()
      }
      const sameInstant = (stored: string, bound: string): boolean => {
        const a = asInstant(stored)
        const b = asInstant(bound)
        // An unparseable value must never compare equal — that would report a
        // foreign row as ours and DROP a legitimate audit write.
        return !Number.isNaN(a) && !Number.isNaN(b) && a === b
      }
      const ownRowLanded = async (seq: number): Promise<boolean> => {
        const row = await ctx.db
          .prepare('select ViewerUserId, Timestamp, Fields from RegistrantAccessEvent where RegistrantId = :registrantId and Sequence = :sequence')
          .get({ registrantId, sequence: seq })
        if (row === null || row === undefined) return false
        return String(row.ViewerUserId ?? '') === viewerUserId &&
          sameInstant(String(row.Timestamp ?? ''), timestamp) &&
          String(row.Fields ?? '') === fieldsJson
      }

      for (let attempt = 0; attempt < SEQUENCE_ALLOCATION_ATTEMPTS; attempt++) {
        const sequence = await readNextSequence()
        // A fresh Tid per attempt — a Tid is consumed by the attempt that
        // used it, never replayed into a second insert.
        const tid = await allocateTid(ctx.db, 'registration')

        try {
          // CORRECTNESS TRAP (T-47-15): `Timestamp`'s `TimestampValid` CHECK is
          // IMMEDIATE (no subquery), so it sees the raw bound value and requires
          // a trailing `Z`. `nowCanonicalDatetime()` returns a 19-char string
          // with NO `Z` — binding it into the `Timestamp` COLUMN fails the
          // CHECK. Bind a Z-suffixed value into the column and the Z-less
          // canonical form into the context `now`, matching `createRegistrant`'s
          // Z-suffixed `expiration` alongside a Z-less `now`. NOTE: this
          // deliberately diverges from `47-RESEARCH.md` Code Examples §1 and
          // `47-PATTERNS.md` §6, which both show `:now` bound into `Timestamp` —
          // that form fails this CHECK.
          await ctx.db.exec(
            `insert into RegistrantAccessEvent (RegistrantId, ViewerUserId, Sequence, Timestamp, Fields)
             with context Tid = ${tid}, now = :now
             values (:registrantId, :viewerUserId, :sequence, :timestamp, :fields)`,
            {
              registrantId,
              viewerUserId,
              sequence,
              timestamp,
              now: nowCanonicalDatetime(),
              fields: fieldsJson
            }
          )
          return
        } catch (err) {
          if (attempt + 1 >= SEQUENCE_ALLOCATION_ATTEMPTS) throw err
          // Both probes are fresh round trips issued immediately after a
          // storage failure — i.e. exactly when they are most likely to fail
          // too. Their own rejection must never REPLACE the insert error the
          // caller actually needs to see, so the whole diagnosis is wrapped
          // and collapses to `throw err`.
          let anotherWriterWon: boolean
          try {
            if (await ownRowLanded(sequence)) return
            anotherWriterWon = (await readNextSequence()) > sequence
          } catch {
            throw err
          }
          if (!anotherWriterWon) throw err
        }
      }
    } catch (err) {
      this.rethrow(err, 'recordRegistrantAccessEvent')
    }
  }

  /**
   * D-01: the reviewer read — a write-only trail was explicitly rejected.
   * The select list is fixed at RegistrantId/ViewerUserId/Sequence/
   * Timestamp/Fields and touches no `RegistrantPrivate`, `RegistrantSelective`,
   * or `RegistrantPublic` column, so this read cannot widen the private
   * tier's disclosure surface (T-47-12).
   */
  async getRegistrantAccessEvents (registrantId: string): Promise<RegistrantAccessEvent[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: RegistrantAccessEvent[] = []
    try {
      for await (const row of ctx.db.eval(
        'select RegistrantId, ViewerUserId, Sequence, Timestamp, Fields from RegistrantAccessEvent where RegistrantId = :registrantId order by Sequence desc',
        { registrantId }
      )) {
        out.push({
          registrantId: asText(row.RegistrantId, 'RegistrantAccessEvent.RegistrantId'),
          viewerUserId: asText(row.ViewerUserId, 'RegistrantAccessEvent.ViewerUserId'),
          sequence: asNumberOr(row.Sequence, 0, 'RegistrantAccessEvent.Sequence'),
          timestamp: reZuluDatetime(row.Timestamp as string),
          fields: parseJsonOr<string[]>(row.Fields, [], 'RegistrantAccessEvent.Fields')
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getRegistrantAccessEvents')
    }
  }

  /**
   * D-14: off-schema read (JS only — no SQL set_verify) revealing only the
   * `ElectionDisclosurePolicy`-permitted subset of a registrant's selective
   * set for `audience` (or the 'everyone' audience). Withheld leaves are
   * reduced to opaque digests by the plugin's own `setDisclose` — their raw
   * `value`/`salt` NEVER cross this boundary, and `SelectiveDetails` is never
   * logged (Information Disclosure mitigation, T-42-08-05). Returns `null`
   * when the registrant has no `RegistrantSelective` row at all.
   */
  async getDisclosedSelective (electionId: string, registrantId: string, audience: string): Promise<DisclosedSelective | null> {
    this.requireCtx('getDisclosedSelective')
    const ctx = this.ctx!
    try {
      const row = await ctx.db
        .prepare(
          'select T.Cid, T.SelectiveDetails '
          + `from RegistrantSelective T ${REGISTRANT_SELECTIVE_POINT_CURRENCY_JOIN} `
          + 'where T.RegistrantId = :registrantId'
        )
        .get({ registrantId })
      if (!row) return null
      const cid = asText(row.Cid, 'RegistrantSelective.Cid')
      const read = await openRegistrantSelectiveDetails(ctx.db, ctx.intakeOpener, { registrantId, cid, stored: row.SelectiveDetails })
      // D-52: an unread row never yields a partial disclosure.
      if (read.leaves === undefined) return { cid, root: '', disclosed: [], hidden: [], access: read.access }
      const leaves = read.leaves

      const permitted = new Set<string>()
      for await (const policyRow of ctx.db.eval(
        'select FieldName from ElectionDisclosurePolicy where ElectionId = :electionId and (Audience = :audience or Audience = :everyone)',
        { electionId, audience, everyone: 'everyone' }
      )) {
        permitted.add(asText(policyRow.FieldName, 'ElectionDisclosurePolicy.FieldName'))
      }

      const { disclosed, hidden } = setDisclose(leaves, [...permitted])
      const disclosedOut: SelectiveLeaf[] = disclosed.map((leaf) => ({
        name: leaf.name,
        value: leaf.value as SelectiveLeaf['value'],
        salt: typeof leaf.salt === 'string' ? leaf.salt : asText(leaf.salt, 'salt')
      }))

      const rootRow = await ctx.db.prepare('select set_commit(:plaintextLeaves) as r').get({ plaintextLeaves: JSON.stringify(leaves) })
      if (!rootRow || rootRow.r == null) {
        throw new Error('getDisclosedSelective: set_commit(...) returned null — crypto plugin not registered?')
      }
      const root = asText(rootRow.r, 'set_commit root')

      return { cid, root, disclosed: disclosedOut, hidden: [...hidden], access: read.access }
    } catch (err) {
      this.rethrow(err, 'getDisclosedSelective')
    }
  }

  /**
   * D-04/D-05/D-06: the registrant roster read. Filter dimensions are ANDed
   * (D-04); paging is keyset on `Registrant.Id` with `total` computed only on
   * a cursor-absent call (D-05); rows join the CURRENT `RegistrantPublic` row
   * only, via the shared `buildRegistrantListFragment`'s D-06 currency
   * predicate (see `registrant-list-query.ts`). Mirrors
   * `getElectionRegistrationFields`'s no-ctx convention — no context yet
   * means an empty page, not an error.
   */
  async listRegistrants (filter?: RegistrantListFilter, page?: RegistrantListPage): Promise<RegistrantListResult> {
    if (!this.ctx) return { rows: [] }
    const ctx = this.ctx
    try {
      const pageSize = clampPageSize(page?.pageSize)
      const cursor = page?.cursor
      const { sql, params } = buildRegistrantListPageSql(filter, cursor, pageSize)
      const rows: RegistrantListRow[] = []
      for await (const row of ctx.db.eval(sql, params as Record<string, SqlValue>)) {
        rows.push({
          registrantId: asText(row.Id, 'Registrant.Id'),
          authorityId: asText(row.AuthorityId, 'Registrant.AuthorityId'),
          status: asText(row.Status, 'Registrant.Status') as RegistrantStatus,
          expiration: reZuluDatetime(row.Expiration as string),
          privateCid: asText(row.PrivateCid, 'Registrant.PrivateCid'),
          publicCid: row.PublicCid == null ? undefined : asText(row.PublicCid, 'Registrant.PublicCid'),
          selectiveCid: row.SelectiveCid == null ? undefined : asText(row.SelectiveCid, 'Registrant.SelectiveCid'),
          lastName: row.LastName == null ? undefined : asText(row.LastName, 'RegistrantPublic.LastName'),
          firstName: row.FirstName == null ? undefined : asText(row.FirstName, 'RegistrantPublic.FirstName'),
          district: row.District == null ? undefined : asText(row.District, 'RegistrantPublic.District')
        })
      }

      const nextCursor = rows.length === pageSize ? rows[rows.length - 1]!.registrantId : undefined

      let total: number | undefined
      if (cursor === undefined) {
        // D-05: run once per filter-change (a cursor-absent call), never per
        // page. A failed count degrades to `total: undefined` — the roster
        // read must never fail because counting failed.
        try {
          const countSql = buildRegistrantListCountSql(filter)
          const countRow = await ctx.db.prepare(countSql.sql).get(countSql.params as Record<string, SqlValue>)
          total = asNumberOr(countRow?.n, 0, 'listRegistrants.total')
        } catch {
          // T-47-06: deliberately NOT logged and NOT interpolated into any
          // message — the count query's bound params can carry the
          // officer's typed `name` search term, which is registrant PII
          // under D-01's never-log rule. A future "let's log this" change
          // must be a deliberate decision, not an accident.
          total = undefined
        }
      }

      return { rows, nextCursor, total }
    } catch (err) {
      this.rethrow(err, 'listRegistrants')
    }
  }

  // ---------- Register builder ----------

  buildRegister (): IRegistrationRegisterBuilder {
    return new RegistrationRegisterBuilder(this)
  }

  /**
   * D-02/Pitfall 4: the multi-row Register ceremony. Computes ALL tier Cids
   * BEFORE the `Registrant` insert (its PrivateCid/PublicCid/SelectiveCid
   * columns are NOT NULL-or-precomputed and must already carry the tier's
   * derived Cid), inserts the parent `Registrant` row, THEN inserts the tier
   * rows (each independently re-deriving the SAME deterministic Cid — or,
   * for the selective tier, reusing the SAME engine-generated leaves — and
   * running its OWN `vrg` ceremony) — all inside one BEGIN/COMMIT/ROLLBACK
   * envelope so a partial failure never strands an orphaned `Registrant`.
   */
  async register (
    init: RegisterInit,
    signatureOrCallback: SignatureOrCallback,
    options?: { headerNonce?: string }
  ): Promise<void> {
    this.requireCtx('register')
    const ctx = this.ctx!
    // D-09: engine-side field-policy enforcement runs BEFORE any DB ceremony —
    // there is NO schema CHECK backstop (deliberate gap, RESEARCH V5). Only
    // runs when the submission carries an electionId (D-10 election-scoped
    // policy) — a submission with no electionId has no policy to enforce
    // against and proceeds exactly as before this plan.
    if (init.electionId) {
      // WR-03 (42-REVIEW): the election whose field policy governs this
      // submission MUST belong to the same authority that is registering this
      // person. Without this check, a caller could pass an electionId owned by
      // an unrelated authority — enforcing that authority's policy, or (worse)
      // silently passing validation against a policy-less election while the
      // caller's own election carries a stricter one. Mirrors CR-01's
      // authority-ownership discipline at the engine layer (field policy has no
      // schema CHECK backstop per D-09, so this IS the only guard).
      const electionAuthorityId = await this.resolveElectionAuthorityId(init.electionId, 'register')
      if (electionAuthorityId !== init.registrant.authorityId) {
        throw new Error(
          `RegistrationEngine.register: electionId ${init.electionId} belongs to authority ${electionAuthorityId}, not the registrant's authority ${init.registrant.authorityId} — cross-authority registration is not permitted`
        )
      }
      await validateFieldPolicy(ctx, init.electionId, init)
    }

    // D-11/D-12/D-13: validate + generate the selective leaves BEFORE the DB
    // ceremony (BEGIN) — duplicate-name/empty-salt rejection must never open
    // a transaction. Pitfall 3: the "payload provided" and "insert a
    // RegistrantSelective row" gates are the SAME — only a non-empty
    // `selective.details` list enters this branch; an absent/empty payload
    // never touches `set_commit` and `Registrant.SelectiveCid` stays NULL.
    let selectiveLeaves: SelectiveLeaf[] | undefined
    let selectiveCid: string | undefined
    if (init.selective && init.selective.details.length > 0) {
      selectiveLeaves = await this.buildSelectiveLeaves(init.selective.details)
      selectiveCid = await this.computeRegistrantSelectiveCid(JSON.stringify(selectiveLeaves))
    }

    const registrantId = init.registrant.id

    // R2/D-04/D-05: idempotency pre-check. A second register() call with the
    // same registrant.id must fail with a typed, instanceof-checkable error
    // BEFORE any transaction opens — never by deleting/rotating the existing
    // row (registration is a multi-step ceremony; a destructive retry risks
    // key-bound state). Deliberately kept OUTSIDE the try/catch below: this
    // method's own catch funnels through `this.rethrow()`, which wraps any
    // plain Error into a fresh `new Error(...)` (ceremony-helpers.ts) and
    // would destroy the instanceof check callers rely on.
    const existingRegistrant = await ctx.db
      .prepare('select 1 from Registrant where Id = :id')
      .get({ id: registrantId })
    if (existingRegistrant) {
      throw new RegistrantAlreadyExistsError(registrantId)
    }

    // D-49: seal the private tier ONCE, before BEGIN and outside the try below — sealing is
    // randomized (a fresh content key per call), so sealing twice for one row would yield two
    // different Cids and RegistrantCidMatch (the parent row vs. the tier row) would fail. Kept
    // outside the try/catch for the SAME reason as the idempotency pre-check above: this.rethrow()
    // wraps a plain Error and would destroy the IntakeError instanceof check.
    const storedPrivateDetails = await sealRegistrantPrivateDetails(ctx.db, {
      authorityId: init.registrant.authorityId,
      registrantId,
      details: init.private.details
    })

    // D-52: seal the selective tier ONCE (leaves are randomly salted and sealing is randomized), after
    // the Cid is known and before BEGIN, outside the try for the same IntakeError reason as above. The
    // same sealed text feeds the vrg digest and the INSERT.
    let storedSelectiveDetails: string | undefined
    if (selectiveLeaves && selectiveCid) {
      storedSelectiveDetails = await sealRegistrantSelectiveDetails(ctx.db, {
        authorityId: init.registrant.authorityId,
        registrantId,
        cid: selectiveCid,
        leaves: selectiveLeaves
      })
    }

    try {
      await ctx.db.exec('BEGIN')
      try {
        // Cids-before-parent (Pitfall 4).
        let publicCid: string | undefined
        if (init.public) {
          publicCid = await this.computeRegistrantPublicCid(registrantId, init.public)
        }
        const privateCid = await this.computeRegistrantPrivateCid(registrantId, {
          expiration: init.private.expiration,
          storedDetails: storedPrivateDetails
        })

        // Parent row first, carrying the pre-computed Cids (own vrg ceremony).
        // `{ ownsTransaction: false }`: register() already owns the outer BEGIN
        // above — Quereus's transaction model is flat (no nested BEGIN), so the
        // inner ceremony's SigningEngine.sign() must NOT start its own nested
        // transaction (see SigningEngine.sign()'s doc comment / T-42-03).
        // 62-11 (research Finding 4.1): `options?.headerNonce`, when set (the registrant-approval
        // ceremony calling through a threshold-above-1 'vrg' header), routes EVERY one of these
        // four ceremonies through signDerived instead of each recomputing its OWN (often
        // threshold-1, non-holder) signer count. Every pre-62-11 caller omits it and is
        // unaffected (routes through sign() exactly as before).
        await this.createRegistrant(
          {
            id: registrantId,
            authorityId: init.registrant.authorityId,
            privateCid,
            publicCid,
            selectiveCid,
            expiration: init.registrant.expiration
          },
          signatureOrCallback,
          { ownsTransaction: false, headerNonce: options?.headerNonce }
        )

        // Tier rows after — each recomputes the SAME deterministic Cid and runs
        // its OWN vrg ceremony (Pitfall 4); RegistrantCidMatch now finds the
        // just-committed parent Cid.
        if (init.public) {
          await this.createRegistrantPublic({ registrantId, ...init.public }, signatureOrCallback, { ownsTransaction: false, headerNonce: options?.headerNonce })
        }
        // D-49: insertRegistrantPrivateRow directly (never the public createRegistrantPrivate
        // wrapper, which would seal a SECOND time) — storedPrivateDetails was already sealed once,
        // above, and already fed privateCid's computation.
        await this.insertRegistrantPrivateRow(
          registrantId,
          init.registrant.authorityId,
          init.private.expiration,
          storedPrivateDetails,
          signatureOrCallback,
          { ownsTransaction: false, headerNonce: options?.headerNonce }
        )
        if (selectiveLeaves && selectiveCid && storedSelectiveDetails !== undefined) {
          await this.insertRegistrantSelectiveRow(
            registrantId,
            init.selective!.expiration,
            selectiveLeaves,
            storedSelectiveDetails,
            selectiveCid,
            signatureOrCallback,
            { ownsTransaction: false, headerNonce: options?.headerNonce }
          )
        }

        await ctx.db.exec('COMMIT')
      } catch (innerErr) {
        await ctx.db.exec('ROLLBACK')
        throw innerErr
      }
    } catch (err) {
      this.rethrow(err, 'register')
    }
  }

  // ---------- ElectionRegistrant roster (authority-only, D-17) ----------

  /**
   * D-17: authority-only roster enrollment. `ElectionRegistrant` is `NoUpdate`
   * (no update method exists, deliberately — see `IRegistrationEngine`'s doc
   * comment) — insert/delete are the only mutations. `InsertValid` requires a
   * `vrg`-scoped AdminSignature over `Digest(Tid, ElectionId, RegistrantId)`;
   * there is NO self-enroll code path — the officer's `sign` callback is the
   * sole authorization route (`RegistrantIdValid`/`RegistrantNotExpired`
   * independently gate eligibility at the schema layer).
   */
  async enrollElectionRegistrant (electionId: string, registrantId: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('enrollElectionRegistrant')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveRegistrantAuthorityId(registrantId, 'enrollElectionRegistrant')
      const tid = await allocateTid(ctx.db, 'registration')
      const digestExpr = 'select Digest(:tid, :electionId, :registrantId) as d'
      const digestParams = { tid, electionId, registrantId }
      const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `insert into ElectionRegistrant (ElectionId, RegistrantId)
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         values (:electionId, :registrantId)`,
        { electionId, registrantId, signingNonce: nonce, now: nowCanonicalDatetime() }
      )
    } catch (err) {
      this.rethrow(err, 'enrollElectionRegistrant')
    }
  }

  /**
   * D-17: authority-only roster removal. `DeleteValid` requires a `vrg`-
   * scoped AdminSignature over `Digest(Tid, ElectionId, RegistrantId, 'delete')`
   * — the literal `'delete'` sentinel is a SQL literal inside the digest
   * expression, not a bound param (matches the schema's own formula verbatim).
   */
  async removeElectionRegistrant (electionId: string, registrantId: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('removeElectionRegistrant')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveRegistrantAuthorityId(registrantId, 'removeElectionRegistrant')
      const tid = await allocateTid(ctx.db, 'registration')
      const digestExpr = "select Digest(:tid, :electionId, :registrantId, 'delete') as d"
      const digestParams = { tid, electionId, registrantId }
      const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `delete from ElectionRegistrant
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         where ElectionId = :electionId and RegistrantId = :registrantId`,
        { electionId, registrantId, signingNonce: nonce, now: nowCanonicalDatetime() }
      )
    } catch (err) {
      this.rethrow(err, 'removeElectionRegistrant')
    }
  }

  /**
   * D-07: thin, faithful direct read of `ElectionRegistrant` — NOT routed
   * through `listRegistrants`. The declared return type is
   * `ElectionRegistrant[]` (`{electionId, registrantId}` pairs), a much
   * narrower shape than `RegistrantListResult`; this method exists for
   * non-UI callers of the interface's declared signature. The roster
   * SCREEN uses `listRegistrants({ electionId })` instead.
   */
  async getElectionRegistrants (electionId: string): Promise<ElectionRegistrant[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: ElectionRegistrant[] = []
    try {
      for await (const row of ctx.db.eval(
        'select ElectionId, RegistrantId from ElectionRegistrant where ElectionId = :electionId',
        { electionId }
      )) {
        out.push({
          electionId: asText(row.ElectionId, 'ElectionRegistrant.ElectionId'),
          registrantId: asText(row.RegistrantId, 'ElectionRegistrant.RegistrantId')
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getElectionRegistrants')
    }
  }

  // ---------- Permissive registrant lifecycle (D-16) ----------

  /**
   * D-16: change Status ('a'|'s'|'r'). Deliberately NO transition guard beyond
   * the schema's own `StatusValid` enum membership check — any direction is
   * allowed; the `vrg` AdminSignature is the sole control (`MutationValid`).
   */
  async changeStatus (registrantId: string, status: RegistrantStatus, signatureOrCallback: SignatureOrCallback): Promise<void> {
    try {
      await this.updateRegistrantRow(registrantId, { status }, signatureOrCallback, 'changeStatus')
    } catch (err) {
      this.rethrow(err, 'changeStatus')
    }
  }

  /**
   * D-16: renewal — change Expiration under a fresh `vrg`-signed mutation.
   * `ExpirationFuture` is `check on insert` ONLY — an update to ANY Expiration
   * value (including one `ExpirationFuture` would reject on insert) succeeds.
   */
  async changeExpiration (registrantId: string, expiration: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    try {
      await this.updateRegistrantRow(registrantId, { expiration }, signatureOrCallback, 'changeExpiration')
    } catch (err) {
      this.rethrow(err, 'changeExpiration')
    }
  }

  /**
   * D-08/D-10: election-keyed, `mel`-signed policy declaration — the
   * `ElectionDisclosurePolicy` twin. `AuthorityId` for the ceremony is
   * resolved from the OWNING election row (`Election.AuthorityId`), matching
   * the schema's own `join Election E on E.Id = new.ElectionId` +
   * `A.AuthorityId = E.AuthorityId` clause. Tier/Requirement are TEXT codes
   * validated against the `RegistrantTier`/`FieldRequirement` enum views by
   * the schema's own `TierValid`/`RequirementValid` CHECKs — this method
   * does not re-validate them app-side (D-08 single source of truth).
   */
  async addElectionRegistrationField (field: ElectionRegistrationField, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('addElectionRegistrationField')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveElectionAuthorityId(field.electionId, 'addElectionRegistrationField')
      const tid = await allocateTid(ctx.db, 'registration')
      const digestExpr = 'select Digest(:tid, :electionId, :fieldName, :tier, :requirement) as d'
      const digestParams = { tid, electionId: field.electionId, fieldName: field.fieldName, tier: field.tier, requirement: field.requirement }
      const nonce = await seedSignedMutation(ctx, authorityId, 'mel', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `insert into ElectionRegistrationField (ElectionId, FieldName, Tier, Requirement)
         with context SigningNonce = :signingNonce, Tid = ${tid}
         values (:electionId, :fieldName, :tier, :requirement)`,
        {
          electionId: field.electionId,
          fieldName: field.fieldName,
          tier: field.tier,
          requirement: field.requirement,
          signingNonce: nonce
        }
      )
    } catch (err) {
      this.rethrow(err, 'addElectionRegistrationField')
    }
  }

  /**
   * D-08/D-10: policy removal. `DeleteValid` re-derives
   * `Digest(Tid, old.ElectionId, old.FieldName, old.Tier, old.Requirement, 'delete')`
   * — unlike `AuthorityPeer`/`PollingDevice` (whose whole row IS the PK), this
   * table carries Tier/Requirement DATA beyond its `(ElectionId, FieldName)`
   * PK, so the ceremony digest must read the row's CURRENT Tier/Requirement
   * back from the DB before computing the delete digest.
   */
  async removeElectionRegistrationField (electionId: string, fieldName: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('removeElectionRegistrationField')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveElectionAuthorityId(electionId, 'removeElectionRegistrationField')
      const existing = await ctx.db
        .prepare('select Tier, Requirement from ElectionRegistrationField where ElectionId = :electionId and FieldName = :fieldName')
        .get({ electionId, fieldName })
      if (!existing) {
        throw new Error(`removeElectionRegistrationField: ElectionRegistrationField not found for electionId=${electionId}, fieldName=${fieldName}`)
      }
      const tier = asText(existing.Tier, 'ElectionRegistrationField.Tier')
      const requirement = asText(existing.Requirement, 'ElectionRegistrationField.Requirement')
      const tid = await allocateTid(ctx.db, 'registration')
      const digestExpr = "select Digest(:tid, :electionId, :fieldName, :tier, :requirement, 'delete') as d"
      const digestParams = { tid, electionId, fieldName, tier, requirement }
      const nonce = await seedSignedMutation(ctx, authorityId, 'mel', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `delete from ElectionRegistrationField
         with context SigningNonce = :signingNonce, Tid = ${tid}
         where ElectionId = :electionId and FieldName = :fieldName`,
        { electionId, fieldName, signingNonce: nonce }
      )
    } catch (err) {
      this.rethrow(err, 'removeElectionRegistrationField')
    }
  }

  async getElectionRegistrationFields (electionId: string): Promise<ElectionRegistrationField[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: ElectionRegistrationField[] = []
    try {
      for await (const row of ctx.db.eval(
        'select ElectionId, FieldName, Tier, Requirement from ElectionRegistrationField where ElectionId = :electionId',
        { electionId }
      )) {
        out.push({
          electionId: asText(row.ElectionId, 'ElectionRegistrationField.ElectionId'),
          fieldName: asText(row.FieldName, 'ElectionRegistrationField.FieldName'),
          tier: asText(row.Tier, 'ElectionRegistrationField.Tier') as ElectionRegistrationField['tier'],
          requirement: asText(row.Requirement, 'ElectionRegistrationField.Requirement') as ElectionRegistrationField['requirement']
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getElectionRegistrationFields')
    }
  }

  // ---------- ElectionDisclosurePolicy (D-14, additive — declares which selective ----------
  // ---------- fields getDisclosedSelective may reveal, and to which audience) ----------

  /**
   * D-14: election policy declaring which `RegistrantSelective` field names
   * may be disclosed, and to which audience ('district' | 'everyone').
   * Companion to `ElectionRegistrationField` (42-07) — the SAME 'mel'-scoped,
   * election-keyed ceremony shape (`AuthorityId` resolved from the OWNING
   * `Election` row). Additive (not part of `IRegistrationEngine`, mirroring
   * `createRegistrant*`'s additive-CRUD precedent) — `getDisclosedSelective`
   * is the interface's disclosure-facing READ; this is the policy-declaring
   * WRITE those rows need to exist at all (the schema only declares the
   * table + its CHECKs, it does not seed policy rows).
   */
  async addElectionDisclosurePolicy (policy: ElectionDisclosurePolicy, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('addElectionDisclosurePolicy')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveElectionAuthorityId(policy.electionId, 'addElectionDisclosurePolicy')
      const tid = await allocateTid(ctx.db, 'registration')
      const digestExpr = 'select Digest(:tid, :electionId, :fieldName, :audience) as d'
      const digestParams = { tid, electionId: policy.electionId, fieldName: policy.fieldName, audience: policy.audience }
      const nonce = await seedSignedMutation(ctx, authorityId, 'mel', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `insert into ElectionDisclosurePolicy (ElectionId, FieldName, Audience)
         with context SigningNonce = :signingNonce, Tid = ${tid}
         values (:electionId, :fieldName, :audience)`,
        { electionId: policy.electionId, fieldName: policy.fieldName, audience: policy.audience, signingNonce: nonce }
      )
    } catch (err) {
      this.rethrow(err, 'addElectionDisclosurePolicy')
    }
  }

  /**
   * D-14: policy removal. `DeleteValid` re-derives
   * `Digest(Tid, old.ElectionId, old.FieldName, old.Audience, 'delete')` — this
   * table carries `Audience` DATA beyond its `(ElectionId, FieldName)` PK, so
   * the ceremony digest must read the row's CURRENT Audience back from the DB
   * first (same shape as `removeElectionRegistrationField`'s Tier/Requirement
   * re-read).
   */
  async removeElectionDisclosurePolicy (electionId: string, fieldName: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('removeElectionDisclosurePolicy')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveElectionAuthorityId(electionId, 'removeElectionDisclosurePolicy')
      const existing = await ctx.db
        .prepare('select Audience from ElectionDisclosurePolicy where ElectionId = :electionId and FieldName = :fieldName')
        .get({ electionId, fieldName })
      if (!existing) {
        throw new Error(`removeElectionDisclosurePolicy: ElectionDisclosurePolicy not found for electionId=${electionId}, fieldName=${fieldName}`)
      }
      const audience = asText(existing.Audience, 'ElectionDisclosurePolicy.Audience')
      const tid = await allocateTid(ctx.db, 'registration')
      const digestExpr = "select Digest(:tid, :electionId, :fieldName, :audience, 'delete') as d"
      const digestParams = { tid, electionId, fieldName, audience }
      const nonce = await seedSignedMutation(ctx, authorityId, 'mel', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `delete from ElectionDisclosurePolicy
         with context SigningNonce = :signingNonce, Tid = ${tid}
         where ElectionId = :electionId and FieldName = :fieldName`,
        { electionId, fieldName, signingNonce: nonce }
      )
    } catch (err) {
      this.rethrow(err, 'removeElectionDisclosurePolicy')
    }
  }

  async getElectionDisclosurePolicies (electionId: string): Promise<ElectionDisclosurePolicy[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: ElectionDisclosurePolicy[] = []
    try {
      for await (const row of ctx.db.eval(
        'select ElectionId, FieldName, Audience from ElectionDisclosurePolicy where ElectionId = :electionId',
        { electionId }
      )) {
        out.push({
          electionId: asText(row.ElectionId, 'ElectionDisclosurePolicy.ElectionId'),
          fieldName: asText(row.FieldName, 'ElectionDisclosurePolicy.FieldName'),
          audience: asText(row.Audience, 'ElectionDisclosurePolicy.Audience') as DisclosureAudience
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getElectionDisclosurePolicies')
    }
  }

  // ---------- ElectionAttestationPolicy (D-14b, additive -- declares whether an ----------
  // ---------- election requires device attestation to Associate; consumed by 45-04's ----------
  // ---------- associate() ceremony) ----------

  /**
   * D-14b: election policy declaring whether device attestation is required to Associate.
   * Single row per election (PK = ElectionId alone, unlike ElectionRegistrationField's
   * append-only (ElectionId, FieldName) PK) -- an UPSERT via `insert or replace`
   * (Quereus-supported, precedented by `election-engine.ts`'s `proposeBallot`
   * `insert or replace into ProposedBallot`). Same 'mel'-scoped, election-keyed
   * ceremony shape as addElectionRegistrationField/addElectionDisclosurePolicy
   * (`AuthorityId` resolved from the OWNING `Election` row). The digest arg order
   * (`Tid, ElectionId, AttestationRequired`) MUST match the table's own `MutationValid`
   * CHECK exactly.
   */
  async setElectionAttestationPolicy (electionId: string, attestationRequired: boolean, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('setElectionAttestationPolicy')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveElectionAuthorityId(electionId, 'setElectionAttestationPolicy')
      const tid = await allocateTid(ctx.db, 'registration')
      const requiredInt = attestationRequired ? 1 : 0
      const digestExpr = 'select Digest(:tid, :electionId, :attestationRequired) as d'
      const digestParams = { tid, electionId, attestationRequired: requiredInt }
      const nonce = await seedSignedMutation(ctx, authorityId, 'mel', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `insert or replace into ElectionAttestationPolicy (ElectionId, AttestationRequired)
         with context SigningNonce = :signingNonce, Tid = ${tid}
         values (:electionId, :attestationRequired)`,
        { electionId, attestationRequired: requiredInt, signingNonce: nonce }
      )
    } catch (err) {
      this.rethrow(err, 'setElectionAttestationPolicy')
    }
  }

  /** D-14b: read the stored attestation-required flag for an election; undefined when no policy row exists. */
  async getElectionAttestationPolicy (electionId: string): Promise<ElectionAttestationPolicy | undefined> {
    if (!this.ctx) return undefined
    const ctx = this.ctx
    try {
      const row = await ctx.db
        .prepare('select ElectionId, AttestationRequired from ElectionAttestationPolicy where ElectionId = :electionId')
        .get({ electionId })
      if (!row) return undefined
      return {
        electionId: asText(row.ElectionId, 'ElectionAttestationPolicy.ElectionId'),
        attestationRequired: Number(row.AttestationRequired) !== 0
      }
    } catch (err) {
      this.rethrow(err, 'getElectionAttestationPolicy')
    }
  }

  /**
   * D-07 (46): revert-to-default — a 'mel'-signed read-then-delete mirroring
   * `removeElectionDisclosurePolicy`'s structure. The re-read is mandatory:
   * `DeleteValid`'s digest binds the OLD `AttestationRequired` value
   * (`votetorrent.qsql:1775` — `Digest(context.Tid, old.ElectionId,
   * old.AttestationRequired, 'delete')`), and the PK (`ElectionId` alone) is
   * not sufficient to reconstruct it. After this succeeds,
   * `getElectionAttestationPolicy` returns `undefined` again, so the
   * fail-closed "absent = REQUIRED" default (enforced by 45-04's associate()
   * ceremony / 46-07's UI) applies once more.
   */
  async removeElectionAttestationPolicy (electionId: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('removeElectionAttestationPolicy')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveElectionAuthorityId(electionId, 'removeElectionAttestationPolicy')
      const existing = await ctx.db
        .prepare('select AttestationRequired from ElectionAttestationPolicy where ElectionId = :electionId')
        .get({ electionId })
      if (!existing) {
        throw new Error(`removeElectionAttestationPolicy: ElectionAttestationPolicy not found for electionId=${electionId}`)
      }
      const attestationRequired = Number(existing.AttestationRequired)
      const tid = await allocateTid(ctx.db, 'registration')
      const digestExpr = "select Digest(:tid, :electionId, :attestationRequired, 'delete') as d"
      const digestParams = { tid, electionId, attestationRequired }
      const nonce = await seedSignedMutation(ctx, authorityId, 'mel', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `delete from ElectionAttestationPolicy
         with context SigningNonce = :signingNonce, Tid = ${tid}
         where ElectionId = :electionId`,
        { electionId, signingNonce: nonce }
      )
    } catch (err) {
      this.rethrow(err, 'removeElectionAttestationPolicy')
    }
  }

  /** Resolve an Election's owning AuthorityId (needed to seed the vrg/mel ceremony's CurrentAdmin lookup). */
  private async resolveElectionAuthorityId (electionId: string, method: string): Promise<string> {
    const ctx = this.ctx!
    const row = await ctx.db
      .prepare('select AuthorityId from Election where Id = :electionId')
      .get({ electionId })
    if (!row) {
      throw new Error(`${method}: Election not found for electionId=${electionId}`)
    }
    return asText(row.AuthorityId, 'Election.AuthorityId')
  }

  // ---------- 42-06 helpers ----------

  /** Resolve a Registrant's owning AuthorityId (needed to seed the vrg ceremony's CurrentAdmin lookup). */
  private async resolveRegistrantAuthorityId (registrantId: string, method: string): Promise<string> {
    const ctx = this.ctx!
    const row = await ctx.db
      .prepare('select AuthorityId from Registrant where Id = :registrantId')
      .get({ registrantId })
    if (!row) {
      throw new Error(`${method}: Registrant not found for registrantId=${registrantId}`)
    }
    return asText(row.AuthorityId, 'Registrant.AuthorityId')
  }

  /**
   * Shared UPDATE ceremony for `changeStatus`/`changeExpiration` — retargets
   * `createRegistrant`'s dual-signing pattern (row-level SignatureValid proof
   * + the vrg AdminSigning/AdminSignature MutationValid ceremony) to an
   * UPDATE. Only Status/Expiration/SignorKey/Signature are ever written —
   * Id/AuthorityId/*Cid stay untouched (IdImmutable/AuthorityIdImmutable).
   */
  private async updateRegistrantRow (
    registrantId: string,
    changes: { status?: RegistrantStatus; expiration?: Timestamp | string },
    signatureOrCallback: SignatureOrCallback,
    method: string
  ): Promise<void> {
    this.requireCtx(method)
    const ctx = this.ctx!
    const currentRow = await ctx.db
      .prepare('select AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status, Expiration from Registrant where Id = :registrantId')
      .get({ registrantId })
    if (!currentRow) {
      throw new Error(`${method}: Registrant not found for registrantId=${registrantId}`)
    }
    const authorityId = asText(currentRow.AuthorityId, 'Registrant.AuthorityId')
    const privateCid = asText(currentRow.PrivateCid, 'Registrant.PrivateCid')
    const publicCid = currentRow.PublicCid == null ? null : asText(currentRow.PublicCid, 'Registrant.PublicCid')
    const selectiveCid = currentRow.SelectiveCid == null ? null : asText(currentRow.SelectiveCid, 'Registrant.SelectiveCid')
    const status = changes.status ?? (asText(currentRow.Status, 'Registrant.Status') as RegistrantStatus)
    const expiration = changes.expiration !== undefined
      ? toIsoZDatetime(changes.expiration)
      : reZuluDatetime(currentRow.Expiration as string)

    const tid = await allocateTid(ctx.db, 'registration')

    // 1. Row-level signor signature (D-19) — SAME 7-field formula as createRegistrant's SignatureValid.
    const rowDigestRow = await ctx.db
      .prepare('select Digest(:id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expiration) as d')
      .get({ id: registrantId, authorityId, privateCid, publicCid, selectiveCid, status, expiration })
    if (!rowDigestRow || rowDigestRow.d == null) {
      throw new Error(`${method}: Digest() returned null for row-level signature — crypto plugin not registered?`)
    }
    const rowDigestBytes = digestToBytes(rowDigestRow.d)
    const rowSignature = await this.resolveSign(signatureOrCallback)(rowDigestBytes)

    // 2. AdminSigning ceremony ('vrg') — MutationValid's 10-field formula (Tid,
    //    Id, AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status,
    //    Expiration, SignorKey, Signature) — deferred-check-coerced Expiration
    //    (see toDeferredCheckDatetime's doc comment / T-42-03).
    const expirationForDeferredCheck = toDeferredCheckDatetime(expiration)
    const digestExpr = 'select Digest(:tid, :id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expirationDeferred, :rowSignorKey, :rowSignature) as d'
    const digestParams = {
      tid,
      id: registrantId,
      authorityId,
      privateCid,
      publicCid,
      selectiveCid,
      status,
      expirationDeferred: expirationForDeferredCheck,
      rowSignorKey: rowSignature.signerKey,
      rowSignature: rowSignature.signature
    }
    const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

    await ctx.db.exec(
      `update Registrant
       with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
       set Status = :status, Expiration = :expiration, SignorKey = :signorKey, Signature = :signature
       where Id = :id`,
      {
        id: registrantId,
        status,
        expiration,
        signorKey: rowSignature.signerKey,
        signature: rowSignature.signature,
        signingNonce: nonce,
        now: nowCanonicalDatetime()
      }
    )
  }

  // ---------- Registration Request protocol + approval inbox (Phase 48) ----------
  // Throwing stub bodies only — 48-05 declares the contract; 48-07 (intake +
  // bridge registry), 48-08 (read surface + stats), and 48-12 (rejection)
  // replace these with real implementations against the schema. A stub MUST
  // throw and MUST NOT return a plausible empty value.

  /**
   * D-02/D-03/D-04: the phase's ceremony-free intake. A prospective
   * registrant carries no `User` row and no officer scope to seed a signing
   * session against — so this INSERT runs NO `seedSignedMutation`, holds NO
   * `SigningNonce`-bearing `AdminSigning` ceremony, and consults no
   * `IsUserValid`/`userKey`. The row's own requester-key self-signature over
   * DG-1 (`SignatureValid`) is the ENTIRE authorization gate. Pattern-
   * matching this method against the five sibling `vrg` ceremonies in this
   * file (e.g. `createRegistrant` above) would reintroduce the `ProposedX`
   * context envelope `48-CONTEXT.md`'s D-02 rejects — the exact regression
   * this phase's design correction exists to prevent.
   *
   * L-3 timestamp contract: `SubmittedAt` is `init.submittedAt`, bound
   * VERBATIM — the submitter's own staging-time value, never engine-
   * generated — because the offline courier (48-09) signs at staging time
   * and hands this method an ALREADY-RESOLVED `Signature`, not a callback;
   * `resolveSign` returns that signature verbatim, so the engine gets no
   * chance to re-sign anything a regenerated timestamp would invalidate.
   * `ReceivedAt` is this engine's own `toIsoZDatetime` observation, written
   * outside every digest, and is bounded against `SubmittedAt` by the named
   * skew constants above rather than trusted.
   */
  async submitRegistrationRequest (
    init: RegistrationRequestInit,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<string> {
    this.requireCtx('submitRegistrationRequest')
    const ctx = this.ctx!
    try {
      // A NEW allocator namespace, distinct from 'registration' above — shared
      // with registerBridgeKey below so a Tid is never reused across the
      // intake path and the registry path.
      const tid = await allocateTid(ctx.db, 'registration-request')

      // D-03 issuer normalization. bridgeId binds null (never undefined — a
      // bound undefined and a bound null are not interchangeable in the
      // digest).
      const issuerType = init.issuerType ?? 'registrant'
      const bridgeId = init.bridgeId ?? null

      // Pre-flight guard: produces an ATTRIBUTABLE error only. BridgeIdValid
      // remains the actual enforcement boundary — this guard must never be
      // described as the boundary itself.
      if (issuerType === 'registrant' && bridgeId !== null) {
        throw new Error('submitRegistrationRequest: issuerType is registrant but bridgeId is set — a registrant-issued row cannot carry a BridgeId')
      }
      if (issuerType === 'bridge' && bridgeId === null) {
        throw new Error('submitRegistrationRequest: issuerType is bridge but bridgeId is null — a bridge-issued row must carry a BridgeId')
      }

      // D-49 (62-31, T-62-01-10): PayloadCid is the Digest of the PLAINTEXT payload (inside
      // DG-1, below) — the Payload COLUMN instead holds a sealed envelope over that same
      // plaintext (62-03 dropped the CHECK that once forced Payload itself to hash to
      // PayloadCid; openRegistrationPayload's tier-2 recheck re-derives that binding at every
      // read, for sealed AND legacy-unsealed rows).
      const payload = JSON.stringify(init.payload)
      const payloadCidRow = await ctx.db.prepare('select Digest(:payload) as d').get({ payload })
      if (!payloadCidRow || payloadCidRow.d == null) {
        throw new Error('submitRegistrationRequest: Digest() returned null for Payload — crypto plugin not registered?')
      }
      const payloadCid = payloadCidRow.d as string

      // D-49: seal right after payloadCid is computed and BEFORE the DG-1 digest is signed below —
      // a zero-recipient refusal (IntakeError) must never consume the requester's signature (P7:
      // the sign callback's own call count stays 0 on this path).
      const storedPayload = await sealRegistrationPayload(ctx.db, {
        authorityId: init.authorityId,
        requestId: init.id,
        payloadCid,
        plaintext: payload
      })

      // L-3: SubmittedAt is the SUBMITTER's own value, bound VERBATIM.
      // NEVER toIsoZDatetime(new Date()) / nowCanonicalDatetime() here — see
      // the doc comment above.
      const submittedAt = init.submittedAt
      if (Number.isNaN(Date.parse(submittedAt))) {
        // Attributable-error guard only; SubmittedAtValid/SubmittedAtSaneValid remain the enforcement.
        throw new Error(`submitRegistrationRequest: init.submittedAt does not parse as a date: ${submittedAt}`)
      }

      // ReceivedAt: the AUTHORITY's OWN observation of intake time, inside NO digest.
      const receivedAt = toIsoZDatetime(Date.now())

      // Skew guard: BOUNDS the submitter-supplied SubmittedAt, does not
      // authenticate it — inside the window it remains a submitter-chosen
      // value covered only by the submitter's own signature (T-48-07-12).
      const submittedAtMs = Date.parse(submittedAt)
      const receivedAtMs = Date.parse(receivedAt)
      if (submittedAtMs - receivedAtMs > SUBMITTED_AT_MAX_FUTURE_SKEW_MS) {
        throw new Error(
          `submitRegistrationRequest: submittedAt (${submittedAt}) is more than ${SUBMITTED_AT_MAX_FUTURE_SKEW_MS}ms ahead of receivedAt (${receivedAt})`
        )
      }
      if (receivedAtMs - submittedAtMs > SUBMITTED_AT_MAX_AGE_MS) {
        throw new Error(
          `submitRegistrationRequest: submittedAt (${submittedAt}) is more than ${SUBMITTED_AT_MAX_AGE_MS}ms before receivedAt (${receivedAt})`
        )
      }

      // D-02's ONLY authorization gate: DG-1, field for field —
      // Digest(Id, AuthorityId, RequesterKey, IssuerType, BridgeId, PayloadCid, SubmittedAt).
      // NO context.Tid, NO ReceivedAt (the requester never observed ReceivedAt at signing time).
      const digestRow = await ctx.db
        .prepare('select Digest(:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
        .get({
          id: init.id,
          rowAuthorityId: init.authorityId,
          requesterKey,
          issuerType,
          bridgeId,
          payloadCid,
          submittedAt
        })
      if (!digestRow || digestRow.d == null) {
        throw new Error('submitRegistrationRequest: Digest() returned null — crypto plugin not registered?')
      }
      const digestBytes = digestToBytes(digestRow.d)
      const signature = await this.resolveSign(signatureOrCallback)(digestBytes)
      // D-02/D-04: `signature.signerUserId` is NEVER read here — a
      // prospective registrant has no user id, the field is a type artifact
      // on this path, and touching it is how a User dependency would creep
      // back in.

      // No signing session exists at INSERT — signingNonce binds null.
      await ctx.db.exec(
        `insert into RegistrationRequest (
          Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, Status, SubmittedAt, ReceivedAt, RequesterSignature
        )
        with context SigningNonce = :signingNonce, Tid = ${tid}
        values (:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :status, :submittedAt, :receivedAt, :requesterSignature)`,
        {
          id: init.id,
          rowAuthorityId: init.authorityId,
          // The requesterKey PARAMETER — not signature.signerKey — because DG-1
          // digested the parameter and the CHECK verifies against the column.
          requesterKey,
          issuerType,
          bridgeId,
          payload: storedPayload,
          payloadCid,
          status: 'p',
          submittedAt,
          receivedAt,
          requesterSignature: signature.signature,
          signingNonce: null
        }
      )

      return init.id
    } catch (err) {
      // D-49: an IntakeError (e.g. 'no-recipients') propagates UNCHANGED — this.rethrow() below
      // wraps any plain Error into a fresh `new Error(...)` and would destroy the instanceof check
      // callers rely on (62-19's identical pattern for RegistrationDuplicateError).
      if (err instanceof IntakeError) throw err
      this.rethrow(err, 'submitRegistrationRequest')
    }
  }

  /**
   * D-03 registry write. Unlike `submitRegistrationRequest` above, this IS
   * an authority act and DOES run the full ceremony: registering a bridge
   * key is a decision the authority makes about whom to trust, whereas
   * submitting a request is an act an untrusted party performs. Follows
   * `Registrant.MutationValid`'s `AdminSignature`-join shape through
   * `seedSignedMutation` at scope `'vrg'` (48-02 L-1 — NOT the `'cap'`
   * RESEARCH speculated).
   *
   * No revoke ceremony ships this phase (48-02): `RevokedAt` exists so
   * `listBridgeKeys`/`BridgeIdValid` can stay honest about revocation, but
   * nothing writes it here — do not add one.
   */
  async registerBridgeKey (init: RegistrationBridgeKeyInit, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('registerBridgeKey')
    const ctx = this.ctx!
    try {
      // The SAME durable allocator namespace submitRegistrationRequest uses
      // above — a Tid is never reused across the intake path and the
      // registry path.
      const tid = await allocateTid(ctx.db, 'registration-request')

      // DG-3, field for field: Digest(context.Tid, new.Id, new.AuthorityId,
      // new.Label, new.BridgeKey, new.RevokedAt). `rowAuthorityId`/`bridgeKey`
      // are DEFENSIVE RENAMES — `authorityId` and a `signerKey`-adjacent name
      // are among seedSignedMutation's eight reserved bind names and would be
      // silently overwritten by the helper's own ceremony binds (the real
      // Phase 42-03 bug documented at createRegistrant's NOTE 1 above).
      const digestExpr = 'select Digest(:tid, :id, :rowAuthorityId, :label, :bridgeKey, :revokedAt) as d'
      const digestParams = {
        tid,
        id: init.id,
        rowAuthorityId: init.authorityId,
        label: init.label,
        bridgeKey: init.key,
        revokedAt: null
      }
      const nonce = await seedSignedMutation(
        ctx,
        init.authorityId,
        'vrg',
        tid,
        digestExpr,
        digestParams,
        this.resolveSign(signatureOrCallback)
      )

      await ctx.db.exec(
        `insert into RegistrationBridgeKey (Id, AuthorityId, Label, BridgeKey, RevokedAt)
        with context SigningNonce = :signingNonce, Tid = ${tid}
        values (:id, :rowAuthorityId, :label, :bridgeKey, :revokedAt)`,
        {
          id: init.id,
          rowAuthorityId: init.authorityId,
          label: init.label,
          bridgeKey: init.key,
          revokedAt: null,
          signingNonce: nonce
        }
      )
    } catch (err) {
      this.rethrow(err, 'registerBridgeKey')
    }
  }

  /**
   * D-03 registry read. The `RevokedAt is null` filter mirrors
   * `BridgeIdValid`'s own predicate exactly, so the set a reviewing officer
   * reads here can never disagree with the set the CHECK accepts. Returns
   * `[]` for an authority with no registered keys — never throws on empty.
   */
  async listBridgeKeys (authorityId: string): Promise<RegistrationBridgeKey[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: RegistrationBridgeKey[] = []
    for await (const row of ctx.db.eval(
      'select Id, AuthorityId, Label, BridgeKey from RegistrationBridgeKey where AuthorityId = :authorityId and RevokedAt is null order by Label',
      { authorityId }
    )) {
      out.push({
        id: asText(row.Id, 'RegistrationBridgeKey.Id'),
        authorityId: asText(row.AuthorityId, 'RegistrationBridgeKey.AuthorityId'),
        label: asText(row.Label, 'RegistrationBridgeKey.Label'),
        key: asText(row.BridgeKey, 'RegistrationBridgeKey.BridgeKey')
      })
    }
    return out
  }

  /**
   * D-06/D-09/T-48-08-11: the triage inbox read. Oldest-`ReceivedAt`-first —
   * the AUTHORITY's own intake observation — NEVER oldest-`SubmittedAt`-first
   * (48-05's recorded supersession of this plan's original wording; see
   * `registration-request-query.ts`'s header comment for the full
   * anti-backdating argument). Mirrors `listRegistrants`'s six pagination
   * mechanics exactly (no-context convention, `clampPageSize`, keyset
   * accumulation, cursor-absent-only `total`, the silent T-47-06
   * count-failure catch) — only the order key and the row shape differ.
   */
  /** D-49: builds one inbox row from a raw page/scan row plus its already-opened payload. */
  private buildRegistrationRequestListRow (row: Record<string, unknown>, read: RegistrationPayloadRead): RegistrationRequestListRow {
    return {
      requestId: asText(row.Id, 'RegistrationRequest.Id'),
      authorityId: asText(row.AuthorityId, 'RegistrationRequest.AuthorityId'),
      status: asText(row.Status, 'RegistrationRequest.Status') as RegistrationRequestStatus,
      issuerType: asText(row.IssuerType, 'RegistrationRequest.IssuerType') as RegistrationRequestIssuerType,
      bridgeId: row.BridgeId == null ? undefined : asText(row.BridgeId, 'RegistrationRequest.BridgeId'),
      bridgeLabel: row.BridgeLabel == null ? undefined : asText(row.BridgeLabel, 'RegistrationBridgeKey.Label'),
      // BOTH timestamps reach the row — submittedAt is DISPLAYED beside
      // receivedAt (the sort key), so a divergence between claim and
      // observation is visible, never collapsed. Never render one as
      // the other.
      submittedAt: reZuluDatetime(row.SubmittedAt as string),
      receivedAt: reZuluDatetime(row.ReceivedAt as string),
      // D-49: undefined whenever the payload was not read (read.payload is undefined for every
      // access other than 'opened'/'unsealed') — never a throw, the inbox row must still render.
      lastName: read.payload?.public?.lastName,
      firstName: read.payload?.public?.firstName,
      // Placeholder — overwritten below once the prior-rejection counts
      // are known. A caller must never observe this placeholder value;
      // the field is required-not-optional precisely so `undefined`
      // never means "no prior rejections" (see the overwrite below).
      hasPriorRejections: false,
      payloadAccess: read.access
    }
  }

  async listRegistrationRequests (filter?: RegistrationRequestListFilter, page?: RegistrationRequestListPage): Promise<RegistrationRequestListResult> {
    if (!this.ctx) return { rows: [] }
    const ctx = this.ctx
    try {
      const pageSize = clampPageSize(page?.pageSize)
      const cursor = page?.cursor
      const nameQuery = filter?.name

      // Cursor resolution POINT-READS ReceivedAt — matching the order key,
      // never Id alone and never SubmittedAt. An unresolvable (stale or
      // fabricated) cursor degrades to an empty page and must NOT fall back
      // to an un-cursored first page (T-48-08-06) — that fallback would make
      // `loadMore` restart the list forever.
      let cursorReceivedAt: string | undefined
      if (cursor !== undefined) {
        const cursorRow = await ctx.db.prepare('select ReceivedAt from RegistrationRequest where Id = :cursor').get({ cursor })
        if (!cursorRow) return { rows: [] }
        cursorReceivedAt = asText(cursorRow.ReceivedAt, 'RegistrationRequest.ReceivedAt')
      }

      const rows: RegistrationRequestListRow[] = []
      // Parallel array (not a field on RegistrationRequestListRow — the list
      // row deliberately omits RequesterKey/the full payload, T-48-08-10) so
      // the hasPriorRejections pass below can still key back to each row.
      const requesterKeys: string[] = []

      if (nameQuery === undefined) {
        // COLLECT the page rows first, then open each — never await a db.prepare inside a
        // ctx.db.eval iteration (this file's existing habit).
        const { sql, params } = buildRegistrationRequestListPageSql(filter, cursor, cursorReceivedAt, pageSize)
        const rawRows: Array<Record<string, unknown>> = []
        for await (const row of ctx.db.eval(sql, params as Record<string, SqlValue>)) rawRows.push(row as Record<string, unknown>)
        for (const row of rawRows) {
          const requestId = asText(row.Id, 'RegistrationRequest.Id')
          const payloadCid = asText(row.PayloadCid, 'RegistrationRequest.PayloadCid')
          const read = await openRegistrationPayload(ctx.db, ctx.intakeOpener, { requestId, payloadCid, stored: row.Payload })
          requesterKeys.push(asText(row.RequesterKey, 'RegistrationRequest.RequesterKey'))
          rows.push(this.buildRegistrationRequestListRow(row, read))
        }
      } else {
        // D-49/WR-12: a sealed Payload has no SQL-visible names — the SQL fragment no longer
        // filters on `filter.name` (registration-request-query.ts), so this scans the name-FREE
        // keyset in bounded batches (REGISTRATION_REQUEST_NAME_SCAN_BATCH), opening each row once,
        // keeping only the ones whose opened public names match. An unread row's names are
        // `undefined` and can never match (registrationRequestNameMatches requires a defined
        // field). `nextCursor` is the last KEPT row's id, matching the un-filtered branch's own
        // contract (a caller `loadMore`s from the last row it actually received).
        let scanCursor = cursor
        let scanCursorReceivedAt = cursorReceivedAt
        let exhausted = false
        while (rows.length < pageSize && !exhausted) {
          const { sql, params } = buildRegistrationRequestListPageSql(filter, scanCursor, scanCursorReceivedAt, REGISTRATION_REQUEST_NAME_SCAN_BATCH)
          const batch: Array<Record<string, unknown>> = []
          for await (const row of ctx.db.eval(sql, params as Record<string, SqlValue>)) batch.push(row as Record<string, unknown>)
          if (batch.length === 0) {
            exhausted = true
            break
          }
          for (const row of batch) {
            const requestId = asText(row.Id, 'RegistrationRequest.Id')
            const payloadCid = asText(row.PayloadCid, 'RegistrationRequest.PayloadCid')
            const read = await openRegistrationPayload(ctx.db, ctx.intakeOpener, { requestId, payloadCid, stored: row.Payload })
            if (registrationRequestNameMatches({ lastName: read.payload?.public?.lastName, firstName: read.payload?.public?.firstName }, nameQuery)) {
              requesterKeys.push(asText(row.RequesterKey, 'RegistrationRequest.RequesterKey'))
              rows.push(this.buildRegistrationRequestListRow(row, read))
              if (rows.length >= pageSize) break
            }
          }
          const lastScanned = batch[batch.length - 1]!
          scanCursor = asText(lastScanned.Id, 'RegistrationRequest.Id')
          scanCursorReceivedAt = asText(lastScanned.ReceivedAt, 'RegistrationRequest.ReceivedAt')
          if (batch.length < REGISTRATION_REQUEST_NAME_SCAN_BATCH) exhausted = true
        }
      }

      // ONE grouped query for the WHOLE page (T-48-08-06) — never a per-row
      // subquery.
      if (rows.length > 0) {
        const rejectionSql = buildPriorRejectionCountSql(filter)
        const rejectionCounts = new Map<string, number>()
        for await (const rejRow of ctx.db.eval(rejectionSql.sql, rejectionSql.params as Record<string, SqlValue>)) {
          rejectionCounts.set(asText(rejRow.k, 'RegistrationRequest.RequesterKey'), asNumberOr(rejRow.n, 0, 'priorRejectionCount'))
        }
        for (let i = 0; i < rows.length; i++) {
          const count = rejectionCounts.get(requesterKeys[i]!) ?? 0
          // A rejected request does not count itself as its own prior
          // rejection — this is a `!== undefined` boolean by construction,
          // satisfying the "required, not optional" contract.
          rows[i]!.hasPriorRejections = count > (rows[i]!.status === STATUS_REJECTED ? 1 : 0)
        }

        // D-44 (62-19): ONE grouped query for the whole page, never a per-row query. A row whose
        // id is absent from the map gets no `duplicateClosure` key at all (never an assigned
        // `undefined`) — a caller must not be able to observe a difference between "not computed"
        // and "not closed".
        const closureStates = await readDuplicateClosureStates(ctx.db, filter?.authorityId)
        for (let i = 0; i < rows.length; i++) {
          const state = closureStates.get(rows[i]!.requestId)
          if (state !== undefined) rows[i]!.duplicateClosure = state
        }
      }

      const nextCursor = rows.length === pageSize ? rows[rows.length - 1]!.requestId : undefined

      let total: number | undefined
      if (cursor === undefined) {
        // D-05/T-47-09 pattern: run once per filter-change (a cursor-absent
        // call), never per page.
        try {
          if (nameQuery === undefined) {
            const countSql = buildRegistrationRequestListCountSql(filter)
            const countRow = await ctx.db.prepare(countSql.sql).get(countSql.params as Record<string, SqlValue>)
            total = asNumberOr(countRow?.n, 0, 'listRegistrationRequests.total')
          } else {
            // D-49/WR-12: no SQL count exists for a name-filtered set anymore — scan the whole
            // name-free keyset to exhaustion, same open-per-row discipline as the page scan above.
            total = await this.countNameFilteredRegistrationRequests(filter, nameQuery)
          }
        } catch {
          // T-47-06 (carried verbatim): deliberately NOT logged and NOT
          // interpolated into any message — the count query's bound params
          // can carry the officer's typed `name` search term, which is PII
          // under D-01's never-log rule. A future "let's log this" change
          // must be a deliberate decision, not an accident.
          total = undefined
        }
      }

      return { rows, nextCursor, total }
    } catch (err) {
      this.rethrow(err, 'listRegistrationRequests')
    }
  }

  /**
   * D-49/WR-12: counts the WHOLE name-filtered set by scanning the name-free keyset to
   * exhaustion in `REGISTRATION_REQUEST_NAME_SCAN_BATCH` batches, opening each row once — the
   * unindexed-scan performance residual recorded in this plan's `<interfaces>` block. Runs only on
   * a cursor-absent call, same as the SQL count it replaces for this one filter shape.
   */
  private async countNameFilteredRegistrationRequests (filter: RegistrationRequestListFilter | undefined, nameQuery: string): Promise<number> {
    const ctx = this.ctx!
    let count = 0
    let scanCursor: string | undefined
    let scanCursorReceivedAt: string | undefined
    let exhausted = false
    while (!exhausted) {
      const { sql, params } = buildRegistrationRequestListPageSql(filter, scanCursor, scanCursorReceivedAt, REGISTRATION_REQUEST_NAME_SCAN_BATCH)
      const batch: Array<Record<string, unknown>> = []
      for await (const row of ctx.db.eval(sql, params as Record<string, SqlValue>)) batch.push(row as Record<string, unknown>)
      if (batch.length === 0) break
      for (const row of batch) {
        const requestId = asText(row.Id, 'RegistrationRequest.Id')
        const payloadCid = asText(row.PayloadCid, 'RegistrationRequest.PayloadCid')
        const read = await openRegistrationPayload(ctx.db, ctx.intakeOpener, { requestId, payloadCid, stored: row.Payload })
        if (registrationRequestNameMatches({ lastName: read.payload?.public?.lastName, firstName: read.payload?.public?.firstName }, nameQuery)) {
          count++
        }
      }
      const lastScanned = batch[batch.length - 1]!
      scanCursor = asText(lastScanned.Id, 'RegistrationRequest.Id')
      scanCursorReceivedAt = asText(lastScanned.ReceivedAt, 'RegistrationRequest.ReceivedAt')
      if (batch.length < REGISTRATION_REQUEST_NAME_SCAN_BATCH) exhausted = true
    }
    return count
  }

  /**
   * The point read backing all three approval-screen modes (pending /
   * approved / rejected). Returns `undefined` for an unknown id and NEVER
   * throws on one.
   */
  async getRegistrationRequest (requestId: string): Promise<RegistrationRequestRead | undefined> {
    if (!this.ctx) return undefined
    const ctx = this.ctx
    try {
      // No tier join here (unlike getRegistrantPublic/Private/Selective) —
      // if a future change ever joins this read to a tier table, it must
      // adopt the D-06 REGISTRANT_*_POINT_CURRENCY_JOIN currency predicate
      // shape rather than a naive equi-join (that trap cost Phase 47 a fix).
      const row = await ctx.db
        .prepare(
          `select R.Id, R.AuthorityId, R.RequesterKey, R.IssuerType, R.BridgeId, R.Payload, R.PayloadCid, R.Status,
                  R.SubmittedAt, R.ReceivedAt, R.DecidedAt, R.DecidingOfficerUserId, R.RejectionReason, R.VerificationCid,
                  B.Label as BridgeLabel
           from RegistrationRequest R left join RegistrationBridgeKey B on B.Id = R.BridgeId
           where R.Id = :requestId`
        )
        .get({ requestId })
      if (!row) return undefined

      // D-49: open through the one seal/open module (the tier-2 PayloadCid recheck included) —
      // never parseJsonOr the raw column again. An unread payload degrades to the EXISTING `{}`
      // convention (payloadAccess carries WHY), and the registrantId probe below only runs when the
      // payload was actually read.
      const payloadCid = asText(row.PayloadCid, 'RegistrationRequest.PayloadCid')
      const payloadRead = await openRegistrationPayload(ctx.db, ctx.intakeOpener, { requestId, payloadCid, stored: row.Payload })
      const payload = payloadRead.payload ?? ({} as RegisterInit)
      const status = asText(row.Status, 'RegistrationRequest.Status') as RegistrationRequestStatus

      // T-48-08-05: registrantId is reported ONLY when status === 'a' AND a
      // `select Id from Registrant` probe confirms the row actually exists.
      // Reporting an id the approval never actually produced would put a
      // "View Registrant" CTA on the approval screen that dead-ends,
      // presenting to the officer as a broken app rather than as the data
      // inconsistency it is. A miss leaves registrantId undefined — the CTA
      // does not render — it is not an error.
      let registrantId: string | undefined
      if (status === STATUS_APPROVED && payloadRead.payload !== undefined) {
        const candidateId = payload.registrant?.id
        if (candidateId) {
          const registrantRow = await ctx.db.prepare('select Id from Registrant where Id = :id').get({ id: candidateId })
          if (registrantRow) registrantId = candidateId
        }
      }

      // D-07: no new storage — the checklist is RECOVERED, not stored. See
      // `recoverVerificationChecklist`'s own comment for the
      // bounded-enumeration argument.
      let verificationCidOut: string | undefined
      let verificationChecklist: RegistrationVerificationChecklistItem[] | undefined
      if (row.VerificationCid != null) {
        verificationCidOut = asText(row.VerificationCid, 'RegistrationRequest.VerificationCid')
        verificationChecklist = await this.recoverVerificationChecklist(verificationCidOut)
      }

      return {
        requestId: asText(row.Id, 'RegistrationRequest.Id'),
        authorityId: asText(row.AuthorityId, 'RegistrationRequest.AuthorityId'),
        requesterKey: asText(row.RequesterKey, 'RegistrationRequest.RequesterKey'),
        issuerType: asText(row.IssuerType, 'RegistrationRequest.IssuerType') as RegistrationRequestIssuerType,
        bridgeId: row.BridgeId == null ? undefined : asText(row.BridgeId, 'RegistrationRequest.BridgeId'),
        bridgeLabel: row.BridgeLabel == null ? undefined : asText(row.BridgeLabel, 'RegistrationBridgeKey.Label'),
        payload,
        payloadCid: asText(row.PayloadCid, 'RegistrationRequest.PayloadCid'),
        status,
        // Surface BOTH timestamps — this is not redundancy. submittedAt is
        // what the requester CLAIMED at signing time; receivedAt is what
        // the authority OBSERVED at intake. Within 48-07's accepted skew
        // window the two can legitimately diverge, and the ONLY way a
        // reviewing officer can ever see that divergence is if both reach
        // the screen. Never render one as the other, never substitute one
        // for the other when the other is inconvenient, never "simplify"
        // this read by dropping one.
        submittedAt: reZuluDatetime(row.SubmittedAt as string),
        receivedAt: reZuluDatetime(row.ReceivedAt as string),
        decidedAt: row.DecidedAt == null ? undefined : reZuluDatetime(row.DecidedAt as string),
        decidingOfficerUserId: row.DecidingOfficerUserId == null ? undefined : asText(row.DecidingOfficerUserId, 'RegistrationRequest.DecidingOfficerUserId'),
        rejectionReason: row.RejectionReason == null ? undefined : asText(row.RejectionReason, 'RegistrationRequest.RejectionReason'),
        verificationCid: verificationCidOut,
        verificationChecklist,
        registrantId,
        payloadAccess: payloadRead.access
      }
    } catch (err) {
      this.rethrow(err, 'getRegistrationRequest')
    }
  }

  /**
   * D-06: what makes a persisted rejection REACHABLE by the next reviewing
   * officer — not merely recorded. Without this, the rejection record
   * exists and nobody sees it, and a rejected applicant can re-submit and
   * be approved by an officer with no way to know — the repudiation risk
   * `48-RESEARCH.md` § Security Domain names. Keyed by `requesterKey`
   * (never by request id) precisely so a NEW request carries the OLD
   * history. `DecidedAt` is an AUTHORITY-written decision timestamp, not a
   * submitter-supplied value, so ordering on it — newest first — carries
   * NONE of the backdating hazard that moved the triage queue off
   * `SubmittedAt`. Returns `[]` for a key with no rejections and NEVER
   * throws on an unknown key.
   */
  async getPriorRejections (requesterKey: string, excludeRequestId?: string): Promise<PriorRejection[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    try {
      const out: PriorRejection[] = []
      // The SQL fragment and its binding are built from the SAME condition so the predicate
      // can never be present-but-unbound (a vacuous exclusion that would still pass tests) nor
      // bound-but-absent (a dead parameter). When excludeRequestId is omitted the emitted SQL
      // is byte-identical to the one-argument form.
      const hasExclusion = typeof excludeRequestId === 'string' && excludeRequestId.length > 0
      const excludeClause = hasExclusion ? ' and R.Id != :excludeRequestId' : ''
      const bindings: Record<string, SqlValue> = { requesterKey, status: STATUS_REJECTED }
      if (hasExclusion) bindings.excludeRequestId = excludeRequestId
      for await (const row of ctx.db.eval(
        `select R.Id, R.DecidedAt, R.RejectionReason, R.DecidingOfficerUserId
         from RegistrationRequest R
         where R.RequesterKey = :requesterKey and R.Status = :status${excludeClause}
         order by R.DecidedAt desc, R.Id desc`,
        bindings
      )) {
        out.push({
          requestId: asText(row.Id, 'RegistrationRequest.Id'),
          // WR-03: `DecidedAt` is a `datetime null` column, and the two columns below were
          // null-guarded while this one was not — `reZuluDatetime(null)` is `null.endsWith(...)`,
          // a TypeError this method's own catch rethrows as an engine error. On the approval
          // screen that sets `priorRejectionsUnavailable` and blocks Approve for EVERY request
          // from that requester key, which is the exact "must not crash on a row a future
          // migration left partial" case the comment below claims to tolerate.
          // `getRegistrationRequest` already guards the same column this way, so the two read
          // surfaces now agree.
          rejectedAt: row.DecidedAt == null ? '' : reZuluDatetime(row.DecidedAt as string),
          // Deliberately NOT `asText` on the two columns below — it throws
          // on null. `DecisionValid` SHOULD make both present on a rejected
          // row, but a read surface must not crash on a row a future
          // migration left partial; the UI renders an empty reason through
          // its own i18n string.
          rejectionReason: row.RejectionReason == null ? '' : String(row.RejectionReason),
          decidingOfficerUserId: row.DecidingOfficerUserId == null ? '' : String(row.DecidingOfficerUserId)
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getPriorRejections')
    }
  }

  // ---------- D-44 duplicate detection and closure ----------

  /**
   * The ONE payload source for duplicate detection: every PENDING, not-closed request of
   * `authorityId`, mapped to a pure `DuplicateComparable` plus the display fields
   * `getLikelyDuplicateRequests` needs. Collects the raw rows into an array BEFORE opening
   * (this file's own "do not interleave eval + prepare" habit).
   *
   * D-49 (62-31): the payload is opened through the one seal/open module (the tier-2 PayloadCid
   * recheck included). An unread row (no opener, not a recipient, unreadable, tampered) contributes
   * an EMPTY identity — it can never be flagged as a duplicate of anything, and can never flag
   * another row — and undefined display names, never a throw.
   */
  private async readPendingComparables (authorityId: string): Promise<Array<{
    comparable: DuplicateComparable
    display: { issuerType: RegistrationRequestIssuerType; submittedAt: string; receivedAt: string; firstName?: string; lastName?: string }
  }>> {
    const ctx = this.ctx!
    const rawRows: Array<{ Id: string; RequesterKey: string; IssuerType: string; Payload: unknown; PayloadCid: string; SubmittedAt: string; ReceivedAt: string }> = []
    for await (const row of ctx.db.eval(
      `select R.Id, R.RequesterKey, R.IssuerType, R.Payload, R.PayloadCid, R.SubmittedAt, R.ReceivedAt
         from RegistrationRequest R
         where R.AuthorityId = :rowAuthorityId and R.Status = 'p' and ${registrationRequestNotClosedSql('R')}`,
      { rowAuthorityId: authorityId }
    )) {
      rawRows.push({
        Id: asText(row.Id, 'RegistrationRequest.Id'),
        RequesterKey: asText(row.RequesterKey, 'RegistrationRequest.RequesterKey'),
        IssuerType: asText(row.IssuerType, 'RegistrationRequest.IssuerType'),
        Payload: row.Payload,
        PayloadCid: asText(row.PayloadCid, 'RegistrationRequest.PayloadCid'),
        SubmittedAt: row.SubmittedAt as string,
        ReceivedAt: row.ReceivedAt as string
      })
    }

    const out: Array<{
      comparable: DuplicateComparable
      display: { issuerType: RegistrationRequestIssuerType; submittedAt: string; receivedAt: string; firstName?: string; lastName?: string }
    }> = []
    for (const row of rawRows) {
      const read = await openRegistrationPayload(ctx.db, ctx.intakeOpener, { requestId: row.Id, payloadCid: row.PayloadCid, stored: row.Payload })
      const payload = read.payload
      const receivedAt = reZuluDatetime(row.ReceivedAt)
      out.push({
        comparable: {
          requestId: row.Id,
          authorityId,
          requesterKey: row.RequesterKey,
          receivedAt,
          identity: extractRegistrationIdentity(payload)
        },
        display: {
          issuerType: row.IssuerType as RegistrationRequestIssuerType,
          submittedAt: reZuluDatetime(row.SubmittedAt),
          receivedAt,
          firstName: payload?.public?.firstName,
          lastName: payload?.public?.lastName
        }
      })
    }
    return out
  }

  /**
   * D-44: likely duplicates of `requestId`, authority-side and in memory — never throws. Returns
   * `[]` for an unknown id, a non-pending target, or a target that is itself closed/closing.
   */
  async getLikelyDuplicateRequests (requestId: string): Promise<LikelyDuplicateRequest[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    try {
      const targetRow = await ctx.db
        .prepare('select Id, AuthorityId, Status from RegistrationRequest where Id = :requestId')
        .get({ requestId })
      if (!targetRow) return []
      const authorityId = asText(targetRow.AuthorityId, 'RegistrationRequest.AuthorityId')
      if (asText(targetRow.Status, 'RegistrationRequest.Status') !== 'p') return []
      if (await readDuplicateClosure(ctx.db, requestId, authorityId)) return []

      const comparables = await this.readPendingComparables(authorityId)
      const targetEntry = comparables.find((c) => c.comparable.requestId === requestId)
      if (!targetEntry) return []

      const matches = findLikelyDuplicates(targetEntry.comparable, comparables.map((c) => c.comparable))
      const displayByRequestId = new Map(comparables.map((c) => [c.comparable.requestId, c.display]))

      return matches.map((m) => {
        const display = displayByRequestId.get(m.comparable.requestId)!
        return {
          requestId: m.comparable.requestId,
          authorityId: m.comparable.authorityId,
          issuerType: display.issuerType,
          submittedAt: display.submittedAt,
          receivedAt: display.receivedAt,
          firstName: display.firstName,
          lastName: display.lastName,
          matchedOn: m.matchedOn
        }
      })
    } catch (err) {
      this.rethrow(err, 'getLikelyDuplicateRequests')
    }
  }

  /** D-44: the closure state of one request, or `undefined` when it is neither closed nor closing. */
  async getDuplicateClosure (requestId: string): Promise<RegistrationDuplicateClosure | undefined> {
    if (!this.ctx) return undefined
    const ctx = this.ctx
    try {
      const row = await ctx.db.prepare('select AuthorityId from RegistrationRequest where Id = :requestId').get({ requestId })
      if (!row) return undefined
      const authorityId = asText(row.AuthorityId, 'RegistrationRequest.AuthorityId')
      return await readDuplicateClosure(ctx.db, requestId, authorityId)
    } catch (err) {
      this.rethrow(err, 'getDuplicateClosure')
    }
  }

  /** D-44: decided (`'a'`/`'r'`) request ids of `authorityId` with no `RegistrationDecision` row
   *  yet, oldest `DecidedAt` first (then `Id`) — the peer-sync drain list. */
  async listUnpublishedRegistrationDecisions (authorityId: string): Promise<string[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: string[] = []
    try {
      // T-62-19-QUEREUS-01 (found via TDD): `R.AuthorityId = :x and R.Status in ('a','r')` (and the
      // equivalent `and (R.Status = 'a' or R.Status = 'r')`, with either literal or bound operands)
      // silently returns ZERO rows against this table, while the identical predicate keyed on `R.Id`
      // instead of `R.AuthorityId` works. `R.AuthorityId = :x and R.Status = :oneValue` also works —
      // only the AuthorityId-equality-AND-Status-OR combination is affected. `Status <> 'p'` is
      // semantically identical here (StatusValid closes the vocabulary to exactly 'p'/'a'/'r') and
      // does not trip the bug — empirically confirmed before shipping this form.
      for await (const row of ctx.db.eval(
        `select R.Id, R.DecidedAt from RegistrationRequest R
           where R.AuthorityId = :rowAuthorityId and R.Status <> 'p'
             and not exists (select 1 from RegistrationDecision D where D.RequestId = R.Id and D.AuthorityId = R.AuthorityId)
           order by R.DecidedAt, R.Id`,
        { rowAuthorityId: authorityId }
      )) {
        out.push(asText(row.Id, 'RegistrationRequest.Id'))
      }
      return out
    } catch (err) {
      this.rethrow(err, 'listUnpublishedRegistrationDecisions')
    }
  }

  /**
   * D-44: writes ONE `'d'` (closed-as-duplicate) row for `targetRequestId` through `publisher`.
   * Never throws: a publisher rejection resolves `closure: 'pending-retry'` with the thrown
   * error's own string `code` property (or `'unknown'` when it carried none) — never the error's
   * message text. Shared by `publishRegistrationDecision`'s transaction 2, its "already
   * published, resume the interrupted close" branch, and `completeDuplicateClosures`.
   */
  private async publishDuplicateCloseRow (
    publisher: RegistrationDecisionPublishPort,
    targetRequestId: string
  ): Promise<{ closure: RegistrationDuplicateClosureOutcome; closureCursor?: string; closureErrorCode?: string }> {
    try {
      const closureCursor = await publisher.publishDecision({
        requestId: targetRequestId,
        status: 'd',
        decidedAt: toIsoZDatetime(Date.now())
      })
      return { closure: 'closed', closureCursor }
    } catch (err) {
      const errorCode =
        err !== null && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : 'unknown'
      return { closure: 'pending-retry', closureErrorCode: errorCode }
    }
  }

  /**
   * D-44: publishes a decided request's `RegistrationDecision` through `publisher` — 62-01's
   * protocol exactly, in TWO separate transactions (Quereus mis-evaluates
   * `DuplicateCloseValid`'s self-referential `EXISTS` when two deferred entries land in one
   * COMMIT; a caller-open transaction would also roll the first row back together with the
   * second). `publisher` MUST write into this engine's OWN database — a publisher wired to a
   * different one is refused `'publisher-db-mismatch'` once its first write is not visible here.
   */
  async publishRegistrationDecision (
    publisher: RegistrationDecisionPublishPort,
    requestId: string,
    options?: RegistrationDecisionPublishOptions
  ): Promise<RegistrationDecisionPublishResult> {
    this.requireCtx('publishRegistrationDecision')
    const ctx = this.ctx!
    try {
      if (!ctx.db.getAutocommit()) {
        throw new RegistrationDuplicateError(
          'transaction-open',
          requestId,
          'publishRegistrationDecision: must not be called inside an open transaction — the two decision inserts must commit separately'
        )
      }

      const row = await ctx.db
        .prepare(
          'select Id, AuthorityId, Status, DecidedAt, RejectionReason, RequesterKey, Payload, PayloadCid, ReceivedAt ' +
          'from RegistrationRequest where Id = :requestId'
        )
        .get({ requestId })
      if (!row) {
        throw new RegistrationDuplicateError('request-not-found', requestId, `publishRegistrationDecision: no RegistrationRequest for requestId=${requestId}`)
      }
      const authorityId = asText(row.AuthorityId, 'RegistrationRequest.AuthorityId')
      const status = asText(row.Status, 'RegistrationRequest.Status') as RegistrationRequestStatus
      if (status === 'p') {
        throw new RegistrationDuplicateError('request-not-decided', requestId, `publishRegistrationDecision: RegistrationRequest ${requestId} is still pending`)
      }
      if (authorityId !== publisher.authorityId) {
        throw new RegistrationDuplicateError(
          'authority-mismatch',
          requestId,
          "publishRegistrationDecision: publisher.authorityId does not match the request's AuthorityId"
        )
      }

      // Already published?
      const existing = await ctx.db
        .prepare('select Status, ClosesRequestId from RegistrationDecision where RequestId = :requestId and AuthorityId = :rowAuthorityId')
        .get({ requestId, rowAuthorityId: authorityId })
      if (existing) {
        const publishedStatus = asText(existing.Status, 'RegistrationDecision.Status') as RegistrationDecisionPublication['status']
        const existingCloses = existing.ClosesRequestId == null ? undefined : asText(existing.ClosesRequestId, 'RegistrationDecision.ClosesRequestId')
        if (existingCloses === undefined) {
          return { requestId, outcome: 'already-published', publishedStatus, closure: 'none' }
        }
        const targetClosure = await readDuplicateClosure(ctx.db, existingCloses, authorityId)
        if (targetClosure?.state === 'closed') {
          return { requestId, outcome: 'already-published', publishedStatus, closesRequestId: existingCloses, closure: 'already-closed' }
        }
        const closeResult = await this.publishDuplicateCloseRow(publisher, existingCloses)
        return { requestId, outcome: 'already-published', publishedStatus, closesRequestId: existingCloses, ...closeResult }
      }

      // D-49: opens through the one seal/open module. An unread row contributes an EMPTY identity
      // — the SAME fail-closed contract readPendingComparables already carries.
      const buildComparable = async (comparableRequestId: string, requesterKey: string, payloadCid: string, storedPayload: unknown, receivedAtRaw: string): Promise<DuplicateComparable> => {
        const read = await openRegistrationPayload(ctx.db, ctx.intakeOpener, { requestId: comparableRequestId, payloadCid, stored: storedPayload })
        return {
          requestId: comparableRequestId,
          authorityId,
          requesterKey,
          receivedAt: reZuluDatetime(receivedAtRaw),
          identity: extractRegistrationIdentity(read.payload)
        }
      }

      // Resolve the closure target.
      let target: string | undefined
      let closureNoneReason: 'skipped-target-decided' | 'skipped-target-closed' | undefined
      const explicit = options?.closesRequestId
      if (explicit === null) {
        // Decide without closing — target stays undefined, closure 'none'.
      } else if (typeof explicit === 'string') {
        if (explicit === requestId) {
          throw new RegistrationDuplicateError('self-closure', requestId, 'publishRegistrationDecision: closesRequestId must not name the request itself', explicit)
        }
        const xRow = await ctx.db
          .prepare('select Id, AuthorityId, Status, RequesterKey, Payload, PayloadCid, ReceivedAt from RegistrationRequest where Id = :x')
          .get({ x: explicit })
        if (!xRow || asText(xRow.AuthorityId, 'RegistrationRequest.AuthorityId') !== authorityId) {
          throw new RegistrationDuplicateError(
            'not-a-likely-duplicate',
            requestId,
            `publishRegistrationDecision: closesRequestId ${explicit} is not a request of the same authority`,
            explicit
          )
        }
        if (asText(xRow.Status, 'RegistrationRequest.Status') !== 'p') {
          closureNoneReason = 'skipped-target-decided'
        } else if (await readDuplicateClosure(ctx.db, explicit, authorityId)) {
          closureNoneReason = 'skipped-target-closed'
        } else {
          const aComparable = await buildComparable(requestId, asText(row.RequesterKey, 'RegistrationRequest.RequesterKey'), asText(row.PayloadCid, 'RegistrationRequest.PayloadCid'), row.Payload, row.ReceivedAt as string)
          const xComparable = await buildComparable(explicit, asText(xRow.RequesterKey, 'RegistrationRequest.RequesterKey'), asText(xRow.PayloadCid, 'RegistrationRequest.PayloadCid'), xRow.Payload, xRow.ReceivedAt as string)
          if (matchRegistrationIdentities(aComparable, xComparable) === undefined) {
            throw new RegistrationDuplicateError(
              'not-a-likely-duplicate',
              requestId,
              `publishRegistrationDecision: closesRequestId ${explicit} does not match requestId ${requestId}'s identity`,
              explicit
            )
          }
          target = explicit
        }
      } else {
        // Automatic: the oldest flagged pending candidate received no later than A's DecidedAt.
        const decidedAtRaw = row.DecidedAt as string | null
        const decidedMs = decidedAtRaw == null ? NaN : Date.parse(reZuluDatetime(decidedAtRaw))
        const aComparable = await buildComparable(requestId, asText(row.RequesterKey, 'RegistrationRequest.RequesterKey'), asText(row.PayloadCid, 'RegistrationRequest.PayloadCid'), row.Payload, row.ReceivedAt as string)
        const pending = await this.readPendingComparables(authorityId)
        const candidates = findLikelyDuplicates(aComparable, pending.map((p) => p.comparable))
          .filter((m) => !Number.isNaN(decidedMs) && Date.parse(m.comparable.receivedAt) <= decidedMs)
        target = candidates[0]?.comparable.requestId
      }

      // decidedAt for the surviving row.
      const decidedAtRaw = row.DecidedAt as string | null
      const decidedAtParsed = decidedAtRaw == null ? NaN : Date.parse(reZuluDatetime(decidedAtRaw))
      const decidedAt = Number.isNaN(decidedAtParsed) ? toIsoZDatetime(Date.now()) : new Date(decidedAtParsed).toISOString()

      const rawReason = row.RejectionReason == null ? '' : String(row.RejectionReason).trim()
      const reason = status === 'r' && rawReason.length > 0 ? rawReason : undefined

      // Transaction 1: the surviving row.
      const cursor = await publisher.publishDecision({
        requestId,
        status,
        reason,
        decidedAt,
        closesRequestId: target
      })
      const verifyRow = await ctx.db
        .prepare('select Status from RegistrationDecision where RequestId = :requestId and AuthorityId = :rowAuthorityId')
        .get({ requestId, rowAuthorityId: authorityId })
      if (!verifyRow) {
        throw new RegistrationDuplicateError(
          'publisher-db-mismatch',
          requestId,
          "publishRegistrationDecision: the publisher reported success, but the decision row is not visible in this engine's own database"
        )
      }

      // Transaction 2, only when there is a target.
      let closure: RegistrationDuplicateClosureOutcome
      let closureCursor: string | undefined
      let closureErrorCode: string | undefined
      if (target === undefined) {
        closure = closureNoneReason ?? 'none'
      } else {
        const closeResult = await this.publishDuplicateCloseRow(publisher, target)
        closure = closeResult.closure
        closureCursor = closeResult.closureCursor
        closureErrorCode = closeResult.closureErrorCode
      }

      return { requestId, outcome: 'published', publishedStatus: status, cursor, closesRequestId: target, closure, closureCursor, closureErrorCode }
    } catch (err) {
      if (err instanceof RegistrationDuplicateError) throw err
      this.rethrow(err, 'publishRegistrationDecision')
    }
  }

  /**
   * D-44: resumes every interrupted two-transaction close of `publisher.authorityId` — writes
   * the missing `'d'` row for each target exactly once. Never throws per target: a failure is
   * reported in `failed`, never thrown.
   */
  async completeDuplicateClosures (publisher: RegistrationDecisionPublishPort): Promise<RegistrationDuplicateClosureRepairReport> {
    this.requireCtx('completeDuplicateClosures')
    const ctx = this.ctx!
    try {
      if (!ctx.db.getAutocommit()) {
        throw new RegistrationDuplicateError(
          'transaction-open',
          '',
          'completeDuplicateClosures: must not be called inside an open transaction — each resumed close must commit on its own'
        )
      }

      const targets: string[] = []
      for await (const row of ctx.db.eval(
        `select D.ClosesRequestId as Target from RegistrationDecision D
           where D.AuthorityId = :rowAuthorityId and D.ClosesRequestId is not null
             and not exists (
               select 1 from RegistrationDecision X
                 where X.RequestId = D.ClosesRequestId and X.AuthorityId = D.AuthorityId and X.Status = 'd'
             )`,
        { rowAuthorityId: publisher.authorityId }
      )) {
        targets.push(asText(row.Target, 'RegistrationDecision.ClosesRequestId'))
      }

      const completed: string[] = []
      const failed: Array<{ requestId: string; reason: 'target-decided' | 'publish-failed'; errorCode?: string }> = []
      for (const target of targets) {
        const localRow = await ctx.db.prepare('select Status from RegistrationRequest where Id = :target').get({ target })
        if (localRow && asText(localRow.Status, 'RegistrationRequest.Status') !== 'p') {
          failed.push({ requestId: target, reason: 'target-decided' })
          continue
        }
        const result = await this.publishDuplicateCloseRow(publisher, target)
        if (result.closure === 'closed') {
          completed.push(target)
        } else {
          failed.push({ requestId: target, reason: 'publish-failed', errorCode: result.closureErrorCode })
        }
      }
      return { completed, failed }
    } catch (err) {
      if (err instanceof RegistrationDuplicateError) throw err
      this.rethrow(err, 'completeDuplicateClosures')
    }
  }

  /**
   * D-07: recovers the decision-time checklist from the persisted
   * `VerificationCid` by BOUNDED ENUMERATION over the module-level
   * `CHECKLIST_GATE_VALID_CANDIDATES` — the schema persists only the
   * digest, never the item set (no new storage). Sound only because the
   * vocabulary is closed and small (4 items, at most 8 gate-valid
   * subsets); widening it requires revisiting this method or persisting
   * the items directly. Uses the D-07 module's OWN canonical
   * serializer/digest helper (`verificationCid`, imported as
   * `computeVerificationCidFor`) — re-deriving the serialization or
   * re-declaring the vocabulary here is exactly how the digest and the
   * gate would drift apart. No match (a stored `VerificationCid` produced
   * by a widened vocabulary, or one that otherwise cannot be reproduced)
   * returns `undefined` — the raw `verificationCid` is still returned by
   * the caller regardless.
   */
  private async recoverVerificationChecklist (storedVerificationCid: string): Promise<RegistrationVerificationChecklistItem[] | undefined> {
    for (const candidate of CHECKLIST_GATE_VALID_CANDIDATES) {
      const candidateCid = await computeVerificationCidFor(candidate, async (canonical) => this.computeChecklistCid(canonical))
      if (candidateCid === storedVerificationCid) {
        // Already in VERIFICATION_CHECKLIST_ITEM_ORDER's canonical order —
        // the candidate was built from that same order above, so the
        // read-only checklist renders stably.
        return candidate
      }
    }
    return undefined
  }

  /** Digest primitive for `recoverVerificationChecklist` — the SAME `cid(Digest(...))` call shape `computeRegistrantPrivateCid`/`computeRegistrantSelectiveCid` use above, never a JS-side hash. */
  private async computeChecklistCid (canonical: string): Promise<string> {
    const ctx = this.ctx!
    const row = await ctx.db.prepare('select cid(Digest(:canonical)) as c').get({ canonical })
    if (!row || row.c == null) {
      throw new Error('computeChecklistCid: cid(Digest(...)) returned null — crypto plugin not registered?')
    }
    return row.c as string
  }

  /**
   * D-09: pending/approved/rejected counts plus ONE median time-to-decision
   * — TWO queries against `RegistrationRequest` columns that already exist.
   * NO new storage: no column, no table, no cached aggregate, no
   * memoization.
   *
   * Negative space, stated as a decision rather than an omission: this
   * method computes counts and one median. It computes NO rating, NO
   * score, NO star value, NO thumbs, and NO comparative figure between
   * authorities. `doc/registration.md`'s separate rating system is
   * explicitly out of scope this phase (D-09); the reserved `InviteType`
   * `'r'` stays reserved and consumed by nothing. An implementer who
   * believes a "stats surface" implies more than counts + one median is
   * wrong — the omission IS the decision. A comparative figure between
   * authorities would also be a PRIVACY violation, not only a scope one: it
   * would publish a comparative judgement no authority consented to.
   */
  async getRegistrationTransparencyStats (authorityId: string): Promise<RegistrationTransparencyStats> {
    if (!this.ctx) return { pending: 0, approved: 0, rejected: 0 }
    const ctx = this.ctx
    try {
      let pending = 0
      let approved = 0
      let rejected = 0
      for await (const row of ctx.db.eval(
        'select R.Status as s, count(*) as n from RegistrationRequest R where R.AuthorityId = :authorityId group by R.Status',
        { authorityId }
      )) {
        const n = asNumberOr(row.n, 0, 'getRegistrationTransparencyStats.count')
        // A status code outside the schema's three-value union is ignored,
        // not thrown on — StatusValid already forbids it at the schema
        // level, and a read surface should not be the thing that fails.
        if (row.s === STATUS_PENDING) pending = n
        else if (row.s === STATUS_APPROVED) approved = n
        else if (row.s === STATUS_REJECTED) rejected = n
      }

      // D-44 (62-19): a pending request closed or closing as a duplicate is not really pending —
      // subtract it, and report its count separately. Computed as (total pending) minus (pending
      // AND not-closed) rather than a single `not (${registrationRequestNotClosedSql('R')})` form
      // — both sub-queries here reuse the EXACT shape `readPendingComparables` already proves safe
      // against this table (`R.AuthorityId = :x and R.Status = 'p' and registrationRequestNotClosedSql('R')`),
      // where a NOT-wrapped compound predicate is an unproven shape against this table.
      let closedAsDuplicate = 0
      if (pending > 0) {
        const notClosedPendingRow = await ctx.db
          .prepare(
            `select count(*) as n from RegistrationRequest R
               where R.AuthorityId = :rowAuthorityId and R.Status = 'p' and ${registrationRequestNotClosedSql('R')}`
          )
          .get({ rowAuthorityId: authorityId })
        const notClosedPending = asNumberOr(notClosedPendingRow?.n, 0, 'getRegistrationTransparencyStats.notClosedPending')
        closedAsDuplicate = Math.max(0, pending - notClosedPending)
        pending = notClosedPending
      }

      // MEDIAN, measured from ReceivedAt — the authority's OWN observation —
      // NEVER from SubmittedAt (submitter-supplied, 48-02 L-3). SubmittedAt
      // could move the published responsiveness figure in either direction
      // without the authority doing anything differently: forward-dating
      // shrinks the measured interval and flatters the authority's apparent
      // responsiveness, backdating inflates it and defames the authority.
      // Neither number would measure anything the authority did. ReceivedAt
      // is the SAME clock the triage queue sorts by (T-48-08-11) — the two
      // must never diverge.
      const deltas: number[] = []
      for await (const row of ctx.db.eval(
        'select R.ReceivedAt as recv, R.DecidedAt as dec from RegistrationRequest R where R.AuthorityId = :authorityId and R.DecidedAt is not null',
        { authorityId }
      )) {
        const delta = Date.parse(row.dec as string) - Date.parse(row.recv as string)
        // Discard anything not Number.isFinite and any clock-skewed
        // negative delta — this project has a documented emulator
        // clock-skew lesson, so a negative delta is an EXPECTED input, not
        // a hypothetical.
        if (Number.isFinite(delta) && delta >= 0) deltas.push(delta)
      }
      deltas.sort((a, b) => a - b)

      let medianTimeToDecisionMs: number | undefined
      if (deltas.length > 0) {
        const mid = Math.floor(deltas.length / 2)
        medianTimeToDecisionMs = deltas.length % 2 === 1
          ? deltas[mid]!
          : Math.round((deltas[mid - 1]! + deltas[mid]!) / 2)
      }
      // medianTimeToDecisionMs is therefore ALWAYS either a finite
      // non-negative integer or undefined — never NaN, never a float,
      // never Infinity. `undefined` is the UI's "not enough data" case; the
      // UI renders the number as a short duration, never as a raw
      // millisecond count.

      // closedAsDuplicate is present ONLY when greater than zero — the pre-existing zero-request
      // deep-equal (`{ pending: 0, approved: 0, rejected: 0, medianTimeToDecisionMs: undefined }`)
      // must stay exact.
      return closedAsDuplicate > 0
        ? { pending, approved, rejected, medianTimeToDecisionMs, closedAsDuplicate }
        : { pending, approved, rejected, medianTimeToDecisionMs }
    } catch (err) {
      this.rethrow(err, 'getRegistrationTransparencyStats')
    }
  }

  /**
   * D-06/D-07 — the rejection ceremony. Rejecting a request produces a
   * PERMANENT, ATTRIBUTABLE, signed record: `Status` moves `'p'` -> `'r'`
   * and the row carries `RejectionReason`, `DecidingOfficerUserId`,
   * `DecidedAt`, and the decision-time `VerificationCid`, all inside the
   * DG-2 digest the officer's `'vrg'`-scoped `AdminSigning` ceremony
   * covers. There is no delete path (`NoDelete check on delete (false)`)
   * — that permanence is what lets an applicant be told why, what lets a
   * re-application carry its own history (`getPriorRejections`), and what
   * makes D-09's transparency counts mean anything. A rejection that left
   * no trace would be indistinguishable from a request never reviewed.
   *
   * D-07: `VerificationCid` rides inside the SAME DG-2 digest as
   * `Status`/`DecidedAt`/`DecidingOfficerUserId`/`RejectionReason`, so the
   * officer's real signature transitively covers the checklist as it
   * stood at decision time — mirrors 48-11's accept-path weld exactly.
   *
   * This runs under a `'vrg'`-scoped `AdminSigning` ceremony —
   * `AdminSigning.UserIdValid` merely requires the signer be SOME officer
   * at that authority, not a `'vrg'`-scoped one specifically (Phase
   * 999.1); this method never claims the scope is enforced.
   *
   * This is a REJECT-ONLY method by design (48-05 T-48-05-02):
   * `IRegistrationEngine` deliberately exposes no sibling "approve" method
   * and no single boolean-flagged "decide" method that branches on the
   * outcome — approval is reachable ONLY through the officer signature-task
   * ceremony (`SignatureTasksEngine.finalizeRegistrantApproval`), so no
   * single engine call can mint a `Registrant`. Do not add either shape.
   */
  async rejectRegistrationRequest (requestId: string, decision: RegistrationRequestDecision, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('rejectRegistrationRequest')
    const ctx = this.ctx!
    try {
      // SubmittedAt/ReceivedAt are read here too, mirroring
      // finalizeRegistrantApproval's opening shape exactly (48-11 handoff):
      // the decision UPDATE below must explicitly rebind BOTH via
      // restoreCanonicalDatetime, or Quereus's unqualified
      // SubmittedAtValid/ReceivedAtValid/SignatureValid CHECKs re-evaluate
      // against a Z-stripped, precision-truncated snapshot of the row and
      // fail — a real, empirically-confirmed defect class (T-42-06),
      // NOT avoided by leaving the columns untouched or by
      // self-referencing them (`SubmittedAt = SubmittedAt`).
      const row = await ctx.db
        .prepare('select Id, AuthorityId, Status, SubmittedAt, ReceivedAt from RegistrationRequest where Id = :requestId')
        .get({ requestId })
      if (!row) {
        throw new Error(`rejectRegistrationRequest: RegistrationRequest not found for requestId=${requestId}`)
      }
      const authorityId = asText(row.AuthorityId, 'RegistrationRequest.AuthorityId')
      const status = asText(row.Status, 'RegistrationRequest.Status')
      if (status !== 'p') {
        // DecisionValid would reject the update anyway (its conjunction only
        // permits old.Status = 'p'), but a clear engine-level error beats an
        // opaque CHECK failure.
        throw new Error(`rejectRegistrationRequest: RegistrationRequest ${requestId} is already decided (Status=${status})`)
      }

      // D-44: a request closed or closing as a duplicate is undecidable — checked BEFORE the
      // threshold guard below and before any ceremony write, mirroring the "already decided"
      // check immediately above it.
      const duplicateClosure = await readDuplicateClosure(ctx.db, requestId, authorityId)
      if (duplicateClosure) {
        throw new RegistrationDuplicateError(
          'closed-as-duplicate',
          requestId,
          'This request was closed as a duplicate of another request and can no longer be decided.',
          duplicateClosure.closedByRequestId ?? undefined
        )
      }

      // The exact spelling the requester signed (resolveSignedSubmittedAt), resolved BEFORE any officer signature.
      const submittedAt = await resolveSignedSubmittedAt(ctx.db, 'RegistrationRequest', requestId, asText(row.SubmittedAt, 'RegistrationRequest.SubmittedAt'))
      const receivedAt = restoreCanonicalDatetime(asText(row.ReceivedAt, 'RegistrationRequest.ReceivedAt'))

      // rejectionReason is optional on the TYPE (meaningless on the accept
      // path) but required IN PRACTICE on this path — the reject UI gates on
      // this same trimmed-non-empty rule.
      const rejectionReason = (decision.rejectionReason ?? '').trim()
      if (!rejectionReason) {
        throw new Error('rejectRegistrationRequest: decision.rejectionReason must be a non-empty string')
      }

      // WR-02: the D-07 gate is enforced HERE — on the write path — not only by the approval
      // screen's `disabled` prop. Both decision paths (this one and
      // SignatureTasksEngine.completeSignature's registrant accept) now apply the SAME imported
      // vote-core predicate, never a local length/includes re-derivation.
      //
      // The sharper reason this matters on the REJECT path specifically:
      // `recoverVerificationChecklist` (above) recovers a decided request's checklist by
      // enumerating only the GATE-VALID subsets in CHECKLIST_GATE_VALID_CANDIDATES. A
      // non-gate-valid checklist — `[]`, or `'none'` alongside a substantive item — produces a
      // perfectly valid VerificationCid that that enumeration can never invert, so the permanent,
      // NoDelete rejection record would silently lose the checklist it exists to preserve, and the
      // read surface could not tell "empty checklist" from "vocabulary widened" from "digest
      // corrupted".
      //
      // Officer-visible consequence, recorded rather than hidden: an officer who refuses a request
      // without ticking anything now gets this refusal on the approval screen's existing
      // InlineError surface and must record what they verified — including the explicit `'none'`
      // ("I verified nothing"), which IS gate-valid on its own. `'none'` is deliberately NOT
      // substituted for an empty checklist here: that would write an assertion into a signed,
      // permanent record that the officer never actually made.
      if (!isChecklistGateMet(decision.checklist)) {
        throw new Error(
          'rejectRegistrationRequest: decision.checklist does not satisfy the D-07 gate (empty, or "none" combined with a substantive item)'
        )
      }

      // 62-11 (D-11, no veto): above vrg threshold 1, ONE officer rejecting a request through
      // this ceremony would be a VETO — a single officer could unilaterally kill a request that
      // the REST of the vrg holders might have approved. Refused HERE, BEFORE the DG-2 digest
      // ceremony below runs (readAuthorityThreshold precedes every write), so no orphan
      // AdminSigning/OfficerSignature rows are created. The rejection is still recorded as a
      // VOTE: the officer completes their own signature task through
      // SignatureTasksEngine.completeSignature({isAccepted:false, ...}), which records no
      // OfficerSignature and advances nothing (D-11's no-veto derivation).
      const rejectThreshold = await readAuthorityThreshold(ctx.db, authorityId, 'vrg')
      if (rejectThreshold > 1) {
        // 62-19 crossnote (claimed): the previous text pointed the officer at a screen it cannot
        // reach — registrant tasks are filtered out of TasksScreen (62-12). The corrected text
        // below states what actually happened and how the request IS decided (every officer's
        // rejection counts as one vote, through their own signature task), without naming a screen.
        throw new Error(
          `rejectRegistrationRequest: This authority needs ${rejectThreshold} approvals for registrations. One officer cannot reject a request on their own, so nothing was recorded. Each officer's rejection counts as one vote, and the request is refused only when the remaining officers can no longer reach ${rejectThreshold} approvals.`
        )
      }

      // D-07: derive VerificationCid through the SAME injected-digest helper
      // (and the SAME private computeChecklistCid primitive) the read
      // surface's recoverVerificationChecklist uses — never an independent
      // createHash reimplementation (digest-vectors.ts's standing rule).
      const verificationCid = await computeVerificationCidFor(decision.checklist, async (canonical) => this.computeChecklistCid(canonical))

      const tid = await allocateTid(ctx.db, 'registration-request')

      // DecidedAt must carry a trailing 'Z' (DecidedAtValid's like('%Z', ...))
      // — toIsoZDatetime, never the other datetime helper this file's other
      // ceremonies avoid on this same column (48-02 hygiene item 3).
      const decidedAt = toIsoZDatetime(Date.now())
      const decidingOfficerUserId = ctx.user?.id ?? null
      if (!decidingOfficerUserId) {
        // An unattributable rejection would be a permanent record no one can
        // be held to, degrading D-06 to a bare status flag — refuse rather
        // than write an anonymous decision.
        throw new Error('rejectRegistrationRequest: no signed-in officer (ctx.user) — a rejection must be attributable')
      }

      // DG-2, field for field — 48-11's accept path passes the IDENTICAL
      // seven-argument tuple with status: 'a'. None of seedSignedMutation's
      // eight reserved bind names (nonce, authorityId, adminEffectiveAt,
      // scope, userId, signerKey, signature, now) appears here;
      // `decidingOfficerUserId` is deliberately NOT named `userId` for
      // exactly that reason — a same-named digestParams entry would be
      // silently overwritten by seedSignedMutation's own ceremony binds
      // (the real Phase 42-03 bug, registration-engine.ts:238-244 /
      // createRegistrant's NOTE 1 above).
      //
      // T-42-03: RegistrationRequest.DecisionValid contains a subquery, so
      // it is a Quereus DEFERRED CHECK — it re-derives new.DecidedAt from a
      // Temporal-coerced, Z-stripped, minimal-precision snapshot at
      // re-evaluation. The digest argument MUST use that coerced form
      // (toDeferredCheckDatetime), NOT the raw toIsoZDatetime value, or
      // DecisionValid's re-derivation will never match the stored Digest.
      // The STORED DecidedAt column (the UPDATE below) still uses the RAW
      // value — only the digest argument is coerced.
      const decidedAtForDigest = toDeferredCheckDatetime(decidedAt)
      const digestExpr = 'select Digest(:tid, :requestId, :status, :verificationCid, :decidedAt, :decidingOfficerUserId, :rejectionReason) as d'
      const digestParams = {
        tid,
        requestId,
        status: 'r',
        verificationCid,
        decidedAt: decidedAtForDigest,
        decidingOfficerUserId,
        rejectionReason
      }
      const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        // SubmittedAt/ReceivedAt are explicitly rebound (restoreCanonicalDatetime,
        // above) rather than left untouched or self-referenced — either of those
        // leaves Quereus's unqualified SubmittedAtValid/ReceivedAtValid CHECKs
        // evaluating a Z-stripped reconstruction of the row on this UPDATE.
        // No other column is set: Payload and Id are guarded by
        // PayloadImmutable/IdImmutable, and this is what lets a later reader
        // see WHAT was refused, not just that something was.
        `update RegistrationRequest
         with context SigningNonce = :signingNonce, Tid = ${tid}
         set Status = 'r', RejectionReason = :rejectionReason, DecidingOfficerUserId = :decidingOfficerUserId,
             DecidedAt = :decidedAt, VerificationCid = :verificationCid,
             SubmittedAt = :submittedAt, ReceivedAt = :receivedAt
         where Id = :requestId`,
        {
          signingNonce: nonce,
          rejectionReason,
          decidingOfficerUserId,
          decidedAt,
          verificationCid,
          submittedAt,
          receivedAt,
          requestId
        }
      )
    } catch (err) {
      if (err instanceof RegistrationDuplicateError || err instanceof RequesterSignatureUnverifiableError) throw err
      this.rethrow(err, 'rejectRegistrationRequest')
    }
  }

  // ---------- helpers ----------

  private requireCtx (method: string): void {
    requireCtxHelper(this.ctx, 'RegistrationEngine', method)
  }

  private rethrow (err: unknown, method: string): never {
    return rethrowHelper(err, 'RegistrationEngine', method)
  }
}
