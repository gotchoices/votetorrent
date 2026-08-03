import { setDisclose } from '@optimystic/quereus-plugin-crypto'
import { digestToBytes, nowCanonicalDatetime, parseJsonOr, asText } from '../utils.js'
import { seedSignedMutation } from '../signing/signed-mutation.js'
import { allocateTid } from '../database/tid-allocator.js'
import { toIsoZDatetime, toDeferredCheckDatetime, reZuluDatetime, resolveSign as resolveSignHelper, requireCtx as requireCtxHelper, rethrow as rethrowHelper } from '../signing/ceremony-helpers.js'
import { RegistrationRegisterBuilder } from './builders/registration-register-builder.js'
import { validateFieldPolicy } from './field-policy.js'
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
  PrivateDetail,
  RegisterInit,
  RegisterSelectivePayload,
  Registrant,
  RegistrantPrivate,
  RegistrantPublic,
  RegistrantSelective,
  RegistrantStatus,
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

  /** RegistrantPrivate.CidValid: Cid = cid(Digest(RegistrantId, Expiration, PrivateDetails)). */
  private async computeRegistrantPrivateCid (
    registrantId: string,
    input: { expiration: Timestamp | string; details: PrivateDetail[] }
  ): Promise<string> {
    const ctx = this.ctx!
    const expiration = toIsoZDatetime(input.expiration)
    const privateDetailsJson = JSON.stringify(input.details ?? [])
    const row = await ctx.db
      .prepare('select cid(Digest(:registrantId, :expiration, :privateDetails)) as c')
      .get({ registrantId, expiration, privateDetails: privateDetailsJson })
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
    options?: { ownsTransaction?: boolean }
  ): Promise<Registrant> {
    this.requireCtx('createRegistrant')
    const ctx = this.ctx!
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
    options?: { ownsTransaction?: boolean }
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
   * Insert a `RegistrantPrivate` tier row (authority-held, insert-only,
   * never disclosed). Requires the parent `Registrant` row to already exist.
   */
  async createRegistrantPrivate (
    input: { registrantId: string; expiration: Timestamp | string; details: PrivateDetail[] },
    signatureOrCallback: SignatureOrCallback,
    options?: { ownsTransaction?: boolean }
  ): Promise<RegistrantPrivate> {
    this.requireCtx('createRegistrantPrivate')
    const ctx = this.ctx!
    const tid = await allocateTid(ctx.db, 'registration')
    try {
      const registrantRow = await ctx.db
        .prepare('select AuthorityId from Registrant where Id = :registrantId')
        .get({ registrantId: input.registrantId })
      if (!registrantRow) {
        throw new Error(`createRegistrantPrivate: Registrant not found for registrantId=${input.registrantId}`)
      }
      const authorityId = asText(registrantRow.AuthorityId, 'Registrant.AuthorityId')

      const details = input.details ?? []
      const expiration = toIsoZDatetime(input.expiration)
      const privateDetailsJson = JSON.stringify(details)
      const cid = await this.computeRegistrantPrivateCid(input.registrantId, { expiration: input.expiration, details })

      // InsertValid contains a subquery (exists(...)) -> DEFERRED check -> its
      // new.Expiration snapshot is Z-stripped (see toDeferredCheckDatetime).
      // CidValid (above, immediate) correctly used the Z-suffixed form.
      const expirationForDeferredCheck = toDeferredCheckDatetime(input.expiration)
      const digestExpr = 'select Digest(:tid, :cid, :registrantId, :expirationDeferred, :privateDetails) as d'
      const digestParams = { tid, cid, registrantId: input.registrantId, expirationDeferred: expirationForDeferredCheck, privateDetails: privateDetailsJson }
      const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback), options)

      await ctx.db.exec(
        `insert into RegistrantPrivate (Cid, RegistrantId, Expiration, PrivateDetails)
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         values (:cid, :registrantId, :expiration, :privateDetails)`,
        {
          cid,
          registrantId: input.registrantId,
          expiration,
          privateDetails: privateDetailsJson,
          signingNonce: nonce,
          now: nowCanonicalDatetime()
        }
      )

      return { cid, registrantId: input.registrantId, expiration: input.expiration, privateDetails: details }
    } catch (err) {
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
    cid: string,
    signatureOrCallback: SignatureOrCallback,
    options?: { ownsTransaction?: boolean }
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
    const selectiveDetailsJson = JSON.stringify(leaves)

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

    return { cid, registrantId, expiration, selectiveDetails: leaves }
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
      return await this.insertRegistrantSelectiveRow(input.registrantId, input.expiration, leaves, cid, signatureOrCallback, options)
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
        .prepare('select Cid, RegistrantId, LastName, FirstName, District, ExtraFields from RegistrantPublic where RegistrantId = :registrantId')
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
          .prepare(`select ${column} as v from RegistrantPublic where RegistrantId = :registrantId`)
          .get({ registrantId })
        return row?.v == null ? undefined : asText(row.v, `RegistrantPublic.${column}`)
      }
      const path = `$.${fieldName}`
      const row = await ctx.db
        .prepare("select cast(json_extract(ExtraFields, :path) as text) as v from RegistrantPublic where RegistrantId = :registrantId")
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
        .prepare('select ExtraFields from RegistrantPublic where RegistrantId = :registrantId')
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
        .prepare('select Cid, RegistrantId, Expiration, PrivateDetails from RegistrantPrivate where RegistrantId = :registrantId')
        .get({ registrantId })
      if (!row) return undefined
      return {
        cid: asText(row.Cid, 'RegistrantPrivate.Cid'),
        registrantId: asText(row.RegistrantId, 'RegistrantPrivate.RegistrantId'),
        expiration: reZuluDatetime(row.Expiration as string),
        privateDetails: parseJsonOr<PrivateDetail[]>(row.PrivateDetails, [], 'RegistrantPrivate.PrivateDetails')
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
        .prepare('select Cid, RegistrantId, Expiration, SelectiveDetails from RegistrantSelective where RegistrantId = :registrantId')
        .get({ registrantId })
      if (!row) return undefined
      return {
        cid: asText(row.Cid, 'RegistrantSelective.Cid'),
        registrantId: asText(row.RegistrantId, 'RegistrantSelective.RegistrantId'),
        expiration: reZuluDatetime(row.Expiration as string),
        selectiveDetails: parseJsonOr<SelectiveLeaf[]>(row.SelectiveDetails, [], 'RegistrantSelective.SelectiveDetails')
      }
    } catch (err) {
      this.rethrow(err, 'getRegistrantSelective')
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
        .prepare('select Cid, SelectiveDetails from RegistrantSelective where RegistrantId = :registrantId')
        .get({ registrantId })
      if (!row) return null
      const cid = asText(row.Cid, 'RegistrantSelective.Cid')
      const leaves = parseJsonOr<SelectiveLeaf[]>(row.SelectiveDetails, [], 'RegistrantSelective.SelectiveDetails')

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

      const selectiveDetailsText = asText(row.SelectiveDetails, 'RegistrantSelective.SelectiveDetails')
      const rootRow = await ctx.db.prepare('select set_commit(:details) as r').get({ details: selectiveDetailsText })
      if (!rootRow || rootRow.r == null) {
        throw new Error('getDisclosedSelective: set_commit(...) returned null — crypto plugin not registered?')
      }
      const root = asText(rootRow.r, 'set_commit root')

      return { cid, root, disclosed: disclosedOut, hidden: [...hidden] }
    } catch (err) {
      this.rethrow(err, 'getDisclosedSelective')
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
  async register (init: RegisterInit, signatureOrCallback: SignatureOrCallback): Promise<void> {
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
          details: init.private.details
        })

        // Parent row first, carrying the pre-computed Cids (own vrg ceremony).
        // `{ ownsTransaction: false }`: register() already owns the outer BEGIN
        // above — Quereus's transaction model is flat (no nested BEGIN), so the
        // inner ceremony's SigningEngine.sign() must NOT start its own nested
        // transaction (see SigningEngine.sign()'s doc comment / T-42-03).
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
          { ownsTransaction: false }
        )

        // Tier rows after — each recomputes the SAME deterministic Cid and runs
        // its OWN vrg ceremony (Pitfall 4); RegistrantCidMatch now finds the
        // just-committed parent Cid.
        if (init.public) {
          await this.createRegistrantPublic({ registrantId, ...init.public }, signatureOrCallback, { ownsTransaction: false })
        }
        await this.createRegistrantPrivate(
          { registrantId, expiration: init.private.expiration, details: init.private.details },
          signatureOrCallback,
          { ownsTransaction: false }
        )
        if (selectiveLeaves && selectiveCid) {
          await this.insertRegistrantSelectiveRow(
            registrantId,
            init.selective!.expiration,
            selectiveLeaves,
            selectiveCid,
            signatureOrCallback,
            { ownsTransaction: false }
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

  async getElectionRegistrants (_electionId: string): Promise<ElectionRegistrant[]> {
    return []
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

  // ---------- helpers ----------

  private requireCtx (method: string): void {
    requireCtxHelper(this.ctx, 'RegistrationEngine', method)
  }

  private rethrow (err: unknown, method: string): never {
    return rethrowHelper(err, 'RegistrationEngine', method)
  }
}
