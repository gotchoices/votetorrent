import { MisuseError, QuereusError } from '@quereus/quereus'
import { digestToBytes, nowCanonicalDatetime, parseJsonOr, asText } from '../utils.js'
import { seedSignedMutation } from '../signing/signed-mutation.js'
import { RegistrationRegisterBuilder } from './builders/registration-register-builder.js'
import type { EngineContext } from '../types.js'
import type {
  ElectionRegistrant,
  ElectionRegistrationField,
  IRegistrationEngine,
  IRegistrationRegisterBuilder,
  PrivateDetail,
  RegisterInit,
  Registrant,
  RegistrantPrivate,
  RegistrantPublic,
  RegistrantSelective,
  RegistrantStatus,
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

// Phase 42-03 — module-scoped monotonic Tid counter for RegistrationEngine
// mutations, mirroring ElectionsEngine's `nextTid`/`peekNextElectionTid()`
// pattern (elections-engine.ts:45-48). Same WR-16/WR-25 heuristic caveats
// apply (seeded from Date.now(), not store-reconciled).
let nextRegistrationTid = Date.now()

/** For test use only — returns the Tid that the next RegistrationEngine mutation will use. */
export function peekNextRegistrationTid (): number { return nextRegistrationTid }

/**
 * Registrant/RegistrantPrivate/RegistrantSelective's `ExpirationValid` CHECK
 * requires `isISODatetime(Expiration) and like('%Z', Expiration)` — a
 * trailing `Z` is MANDATORY (verified against `initialize.ts`'s `isISODatetime`
 * regex: `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/`). This is a NEW
 * convention unique to the Phase 42 registration tables — every other
 * `datetime` column in the schema uses `toCanonicalDatetime`'s no-`Z` form.
 * Do NOT reuse `toCanonicalDatetime` for these Expiration columns.
 */
function toIsoZDatetime (input: Timestamp | string): string {
  if (typeof input === 'number') return new Date(input).toISOString()
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(input)) return input
  const parsed = new Date(input)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  return input
}

/**
 * T-42-03 (found via TDD — a genuinely flaky-test hunt, ~10% intrinsic
 * failure rate reproduced via a 150-iteration stress spec): Quereus's
 * DEFERRED CHECK constraints (any CHECK containing a subquery —
 * `MutationValid`/`InsertValid`/`RegistrantCidMatch`/`RegistrantIdValid` all
 * qualify, per `needsDeferred = containsSubquery(...)` in
 * `constraint-builder.js`) re-derive `new.*` from a COERCED snapshot
 * (`coerceNewSection` in `constraint-check.js`, GitHub quereus#25) — for a
 * `datetime` column this round-trips through `Temporal.PlainDateTime`
 * (`DATETIME_TYPE.parse` in `temporal-types.js`), which does TWO things a
 * naive Z-strip does NOT replicate:
 *   1. Drops the trailing `Z` entirely (bare wall-clock PlainDateTime).
 *   2. Serializes the fractional-seconds part at MINIMAL precision — trailing
 *      zero digits are dropped (`.930` -> `.93`, `.700` -> `.7`, `.000` -> the
 *      whole fractional part is dropped, not just zero-padded). A naive
 *      `.replace(/Z$/, '')` on `Date.toISOString()`'s ALWAYS-3-digit output
 *      preserves those trailing zeros, producing a BYTE-DIFFERENT string from
 *      what Quereus's own deferred-check snapshot sees whenever the epoch-ms
 *      timestamp's last digit happens to be `0` — empirically ~10% of random
 *      timestamps (confirmed via a 5000-sample comparison against
 *      `temporal-polyfill`'s own `Instant.from(iso).toZonedDateTimeISO('UTC')
 *      .toPlainDateTime().toString()`), matching the exact stress-test flake
 *      rate observed before this fix.
 * IMMEDIATE (non-deferred) CHECKs like `ExpirationValid`/`SignatureValid`/
 * `CidValid` see the RAW pre-coercion (Z-suffixed, always-3-digit) value —
 * unaffected. Only the digest fed into the `vrg` AdminSigning ceremony
 * (compared against a DEFERRED check) needs this minimal-precision form.
 */
function toDeferredCheckDatetime (input: Timestamp | string): string {
  let s = toIsoZDatetime(input).replace(/Z$/, '')
  if (s.includes('.')) {
    s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  }
  return s
}

/**
 * T-42-06 (found via TDD): a plain `select ... from Registrant` READ of the
 * `Expiration` datetime column comes back Z-STRIPPED (Quereus normalizes
 * `datetime`-typed column reads through the same wall-clock representation
 * the deferred-check snapshot uses — see `toDeferredCheckDatetime`'s doc
 * comment — even for a non-deferred, immediate SELECT). Re-stamping an
 * UNCHANGED Expiration value read back from the DB (e.g. `changeStatus`
 * leaving Expiration untouched) must NOT re-parse it through `new Date()`
 * (which treats a Z-less ISO string as LOCAL time, silently shifting the
 * instant by the host's UTC offset — see `fromCanonicalDatetime`'s doc
 * comment for the same JS `Date` pitfall) — it must have `Z` appended
 * directly, preserving the exact stored wall-clock digits as UTC.
 */
function reZuluDatetime (stored: string): string {
  return stored.endsWith('Z') ? stored : `${stored}Z`
}

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

  /** Normalizes the Signature|callback union into a single callback shape. */
  private resolveSign (signatureOrCallback: SignatureOrCallback): (digest: Uint8Array) => Promise<Signature> {
    return typeof signatureOrCallback === 'function'
      ? signatureOrCallback
      : async () => signatureOrCallback
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
    const tid = nextRegistrationTid++
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
    const tid = nextRegistrationTid++
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
    const tid = nextRegistrationTid++
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
        expiration: row.Expiration as string,
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
        expiration: row.Expiration as string,
        privateDetails: parseJsonOr<PrivateDetail[]>(row.PrivateDetails, [], 'RegistrantPrivate.PrivateDetails')
      }
    } catch (err) {
      this.rethrow(err, 'getRegistrantPrivate')
    }
  }

  /** Out of scope this plan — RegistrantSelective lands in Phase 42-08 (D-11/D-12/D-13). */
  async getRegistrantSelective (_registrantId: string): Promise<RegistrantSelective | undefined> {
    throw new Error('RegistrationEngine.getRegistrantSelective: not yet implemented — owned by Phase 42-08')
  }

  // ---------- Register builder ----------

  buildRegister (): IRegistrationRegisterBuilder {
    return new RegistrationRegisterBuilder(this)
  }

  /**
   * D-02/Pitfall 4: the multi-row Register ceremony. Computes BOTH tier Cids
   * BEFORE the `Registrant` insert (its PrivateCid/PublicCid columns are
   * NOT NULL and must already carry the tier's derived Cid), inserts the
   * parent `Registrant` row, THEN inserts the tier rows (each independently
   * re-deriving the SAME deterministic Cid and running its OWN `vrg`
   * ceremony) — all inside one BEGIN/COMMIT/ROLLBACK envelope so a partial
   * failure never strands an orphaned `Registrant`.
   */
  async register (init: RegisterInit, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('register')
    const ctx = this.ctx!
    if (init.selective) {
      throw new Error('RegistrationEngine.register: selective payload (RegistrantSelective) is out of scope for this plan — owned by Phase 42-08 (D-11)')
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

        // D-09 seam (intentionally a no-op this plan — 42-07 owns enforcement).
        this.applyFieldPolicy(init)

        await ctx.db.exec('COMMIT')
      } catch (innerErr) {
        await ctx.db.exec('ROLLBACK')
        throw innerErr
      }
    } catch (err) {
      this.rethrow(err, 'register')
    }
  }

  /**
   * D-09 seam: Register-time Required-field enforcement against
   * `ElectionRegistrationField` policy. Intentionally a NO-OP this plan —
   * the schema only DECLARES the policy (deliberate no-CHECK backstop);
   * 42-07 implements the actual query + rejection here.
   */
  private applyFieldPolicy (_init: RegisterInit): void {
    // no-op — see 42-07.
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
      const tid = nextRegistrationTid++
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
      const tid = nextRegistrationTid++
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

  async addElectionRegistrationField (_field: ElectionRegistrationField, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    throw new Error('RegistrationEngine.addElectionRegistrationField: not yet implemented — owned by Phase 42-07')
  }

  async removeElectionRegistrationField (_electionId: string, _fieldName: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    throw new Error('RegistrationEngine.removeElectionRegistrationField: not yet implemented — owned by Phase 42-07')
  }

  async getElectionRegistrationFields (_electionId: string): Promise<ElectionRegistrationField[]> {
    return []
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

    const tid = nextRegistrationTid++

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
    if (!this.ctx) {
      throw new Error(`RegistrationEngine.${method}: no EngineContext bound — construct with (ctx) for DB-backed methods`)
    }
  }

  private rethrow (err: unknown, method: string): never {
    if (err instanceof QuereusError) {
      throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
    } else if (err instanceof MisuseError) {
      throw new Error(`API misuse: ${err.message}`)
    } else if (err instanceof Error) {
      throw new Error(`RegistrationEngine.${method}: ${err.message}`)
    } else {
      throw new Error(`RegistrationEngine.${method}: unknown error: ${String(err)}`)
    }
  }
}
