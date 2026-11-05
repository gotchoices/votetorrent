/**
 * registrant-list.spec.ts — Phase 47's Wave-0 scaffolding for D-04 (filter
 * dimensions), D-05 (keyset paging + cached count(*) + cross-authority
 * isolation), D-06 (the PublicCid-currency join predicate), and D-07
 * (getElectionRegistrants as a real read) per 47-VALIDATION.md.
 *
 * All specs run the REAL `RegistrationEngine` over a `createTestNetwork()`
 * in-memory DB (real PK/CHECK semantics) plus `MockRegistrationEngine` for
 * shape/behavior parity — no `jest.fn()`-style stubs, no hand-rolled fake DB.
 *
 * The D-06 block (`listRegistrants PublicCid currency predicate`, Task 2) is
 * a REGRESSION LOCK, not a nicety: its leg 2 (the "MUTATION LOCK" naive-join
 * assertion) must NEVER be weakened into a single-row fixture — a fixture
 * with only one `RegistrantPublic` row per registrant cannot distinguish a
 * currency-aware join from a currency-less one, and would silently let the
 * `RP.Cid = R.PublicCid` predicate be removed from `registrant-list-query.ts`
 * without any test going red.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { MockRegistrationEngine } from '../src/registration/mock-registration-engine.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  seedAuthorityInvite,
  seedSignedMutation as seedSignedMutationFixture, testKeyPairFor
} from './fixtures/test-context.js'
import { digestToBytes, nowCanonicalDatetime } from '../src/utils.js'
import { toDeferredCheckDatetime, reZuluDatetime } from '../src/signing/ceremony-helpers.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import type { Signature, Scope } from '@votetorrent/vote-core'
import type { EngineContext } from '../src/types.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Local helpers (mirror authority-config.spec.ts:30-66 / registration.spec.ts:42-108)
// ---------------------------------------------------------------------------

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). */
function makeRegistrantSigner (userId: string): { sign: (digest: Uint8Array) => Promise<Signature>; publicHex: string } {
  const { privateHex, publicHex } = testKeyPairFor(userId)
  const privBytes = hexToBytes(privateHex)
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes) // v2 default: prehash:true
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
  return { sign, publicHex }
}

// Zero-padded sequence so lexicographic string order matches numeric creation
// order regardless of digit count — the pagination describe block depends on
// registrant ids sorting in the SAME order they were created (D-05's `R.Id asc`
// keyset contract). An unpadded `${seq}` suffix (e.g. "...9" vs "...10") would
// sort "10" before "9" and silently corrupt the ordering assertions.
let registrantSeq = 0
function nextRegistrantId (): string {
  registrantSeq += 1
  return `registrant-list-${Date.now()}-${String(registrantSeq).padStart(6, '0')}`
}

const FUTURE_EXPIRATION = Date.now() + 365 * 86_400_000

async function setupRosterTest (): Promise<{
  auth: TestAuthorityContext
  engine: RegistrationEngine
  sign: (digest: Uint8Array) => Promise<Signature>
}> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const { sign } = makeRegistrantSigner(auth.user.id)
  const engine = new RegistrationEngine(auth.ctx)
  return { auth, engine, sign }
}

/**
 * Mirrors RegistrationEngine's private computeRegistrantPublicCid — a
 * standalone createRegistrantPublic() call needs the PARENT Registrant row
 * to already carry this SAME deterministic Cid in its PublicCid column
 * (RegistrantCidMatch), exactly like register() does internally (compute
 * BEFORE the Registrant insert, Pitfall 4).
 */
async function computePublicCid (
  ctx: EngineContext,
  registrantId: string,
  input: { lastName?: string; firstName?: string; district?: string; extraFields?: Record<string, unknown> }
): Promise<string> {
  const row = await ctx.db
    .prepare('select cid(Digest(:registrantId, :lastName, :firstName, :district, :extraFields)) as c')
    .get({
      registrantId,
      lastName: input.lastName ?? null,
      firstName: input.firstName ?? null,
      district: input.district ?? null,
      extraFields: input.extraFields ? JSON.stringify(input.extraFields) : null
    })
  return row!.c as string
}

/**
 * Seeds a Registrant + current RegistrantPublic row through the real engine.
 * `status`/`expirationOffsetDays` are applied via changeStatus/changeExpiration
 * AFTER create — Registrant.ExpirationFuture is `check on insert` ONLY (a past
 * expiration cannot be inserted directly; an expired fixture is made by
 * creating with a future expiration, then calling changeExpiration with a
 * past ISO-Z string, which the constraint does not gate on update).
 */
async function seedRegistrant (
  engine: RegistrationEngine,
  ctx: EngineContext,
  auth: TestAuthorityContext,
  sign: (digest: Uint8Array) => Promise<Signature>,
  opts: {
    lastName?: string
    firstName?: string
    district?: string
    status?: 'a' | 's' | 'r'
    expirationIso?: string
    authorityId?: string
  } = {}
): Promise<string> {
  const registrantId = nextRegistrantId()
  const authorityId = opts.authorityId ?? auth.authority.id
  const publicCid = await computePublicCid(ctx, registrantId, {
    lastName: opts.lastName,
    firstName: opts.firstName,
    district: opts.district
  })
  await engine.createRegistrant(
    {
      id: registrantId,
      authorityId,
      privateCid: 'test-private-cid',
      publicCid,
      expiration: FUTURE_EXPIRATION
    },
    sign
  )
  await engine.createRegistrantPublic(
    { registrantId, lastName: opts.lastName, firstName: opts.firstName, district: opts.district },
    sign
  )
  if (opts.status !== undefined && opts.status !== 'a') {
    await engine.changeStatus(registrantId, opts.status, sign)
  }
  if (opts.expirationIso !== undefined) {
    await engine.changeExpiration(registrantId, opts.expirationIso, sign)
  }
  return registrantId
}

/** Resolve the single Election row seeded by addTestElection() for this authority. */
async function resolveElectionId (ctx: EngineContext, authorityId: string): Promise<string> {
  const row = await ctx.db
    .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
    .get({ authorityId })
  if (!row) throw new Error('resolveElectionId: Election not found for authority')
  return row.Id as string
}

/**
 * Materializes a genuine SECOND authority in the SAME network via the real
 * invite flow (registration.spec.ts:818-878's two-authorities recipe), with
 * its own Admin + Officer so it can legitimately produce a `vrg` AdminSigning.
 * Returns the new Authority.Id.
 */
async function createSecondAuthority (auth: TestAuthorityContext, name: string, domainName: string): Promise<string> {
  // 'rad' scope/threshold mirrors the proven working recipe at
  // registration.spec.ts:818-878 (the CR-01 two-authorities test). The
  // registrant-creation ceremonies below are 'vrg'-scoped regardless of this
  // authority's own declared officer scope — MutationValid only requires a
  // valid AdminSignature/AdminSigning pair under the target scope + threshold,
  // not that the officer's own `Scopes` list happens to declare it.
  const inviteCtx = await seedAuthorityInvite(auth, {
    name,
    domainName,
    officers: [{ userId: auth.user.id, title: 'Chair', scopes: JSON.stringify(['rad']) }]
  })
  await auth.networkEngine.createAuthority(
    { name, domainName },
    {
      officers: [{ init: { name: 'Officer', title: 'Chair', scopes: ['rad'] as Scope[] } }],
      effectiveAt: inviteCtx.adminEffectiveAt,
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
    },
    { inviteSlotCid: inviteCtx.inviteSlotCid, inviteSignature: 'a'.repeat(128) }
  )
  const row = await auth.ctx.db.prepare('select Id from Authority where Name = :n').get({ n: name })
  return row!.Id as string
}

/**
 * D-06 test-only ceremony: repoints Registrant.PublicCid to a NEW Cid,
 * mirroring registration-engine.ts:1301-1371's private `updateRegistrantRow`
 * EXACTLY — same row-level 7-field SignatureValid digest formula
 * (Digest(Id, AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status,
 * Expiration)), same 10-field MutationValid ceremony digest (adds Tid,
 * SignorKey, Signature) with `toDeferredCheckDatetime` coercion for the
 * deferred-check snapshot. A mismatch in either formula surfaces as an
 * opaque CHECK failure — this is the most likely place this file's Task 2
 * would stall, hence the verbatim mirroring.
 */
async function repointPublicCid (
  auth: TestAuthorityContext,
  registrantId: string,
  newPublicCid: string,
  sign: (digest: Uint8Array) => Promise<Signature>
): Promise<void> {
  const ctx = auth.ctx
  const currentRow = await ctx.db
    .prepare('select AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status, Expiration from Registrant where Id = :registrantId')
    .get({ registrantId })
  if (!currentRow) throw new Error('repointPublicCid: Registrant not found')
  const authorityId = currentRow.AuthorityId as string
  const privateCid = currentRow.PrivateCid as string
  const selectiveCid = (currentRow.SelectiveCid as string | null) ?? null
  const status = currentRow.Status as string
  const expiration = reZuluDatetime(currentRow.Expiration as string)

  const tid = await allocateTid(ctx.db, 'registration')

  // 1. Row-level signor signature (D-19) — SAME 7-field formula as
  //    createRegistrant's SignatureValid / updateRegistrantRow.
  const rowDigestRow = await ctx.db
    .prepare('select Digest(:id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expiration) as d')
    .get({ id: registrantId, authorityId, privateCid, publicCid: newPublicCid, selectiveCid, status, expiration })
  const rowSignature = await sign(digestToBytes(rowDigestRow!.d))

  // 2. AdminSigning ('vrg') ceremony — 10-field MutationValid formula;
  //    toDeferredCheckDatetime coerces Expiration for the deferred-check
  //    (subquery-bearing) snapshot Quereus re-derives (T-42-03).
  const expirationDeferred = toDeferredCheckDatetime(expiration)
  const digestExpr = 'select Digest(:tid, :id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expirationDeferred, :rowSignorKey, :rowSignature) as d'
  const digestParams = {
    tid,
    id: registrantId,
    authorityId,
    privateCid,
    publicCid: newPublicCid,
    selectiveCid,
    status,
    expirationDeferred,
    rowSignorKey: rowSignature.signerKey,
    rowSignature: rowSignature.signature
  }
  const { nonce } = await seedSignedMutationFixture(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, auth.user)

  // Status/Expiration are unchanged but MUST be included in the SET clause —
  // ExpirationValid re-evaluates on every update (not scoped `on insert`), and
  // Quereus's internally re-derived `new.Expiration` for a column NOT touched
  // by this UPDATE is the Z-stripped stored form, which fails `like('%Z', ...)`.
  // Explicitly re-asserting the Z-suffixed value keeps the check satisfied,
  // mirroring updateRegistrantRow's full SET clause exactly.
  await ctx.db.exec(
    `update Registrant
     with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
     set PublicCid = :publicCid, Status = :status, Expiration = :expiration, SignorKey = :signorKey, Signature = :signature
     where Id = :id`,
    {
      id: registrantId,
      publicCid: newPublicCid,
      status,
      expiration,
      signorKey: rowSignature.signerKey,
      signature: rowSignature.signature,
      signingNonce: nonce,
      now: nowCanonicalDatetime()
    }
  )
}

// ===========================================================================
// listRegistrants (D-04/D-05/D-06/D-07)
// ===========================================================================

describe('listRegistrants (D-04/D-05/D-06/D-07)', () => {
  // -------------------------------------------------------------------------
  // filter dimensions (D-04)
  // -------------------------------------------------------------------------
  describe('filter dimensions (D-04)', () => {
    it('filters by authorityId — a registrant under a different authority is excluded', async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      const authorityBId = await createSecondAuthority(auth, 'Filter AuthorityId B', 'filter-authority-b.example.com')

      const inA1 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'InA1' })
      const inA2 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'InA2' })
      await seedRegistrant(engine, ctx, auth, sign, { lastName: 'InB', authorityId: authorityBId })

      const result = await engine.listRegistrants({ authorityId: auth.authority.id })
      expect(result.rows.map((r) => r.registrantId).sort()).to.deep.equal([inA1, inA2].sort())
    })

    it('filters by status', async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      const active1 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'ActiveOne' })
      const active2 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'ActiveTwo' })
      const suspended = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Suspended' })
      await engine.changeStatus(suspended, 's', sign)

      const result = await engine.listRegistrants({ authorityId: auth.authority.id, status: 'a' })
      expect(result.rows.map((r) => r.registrantId).sort()).to.deep.equal([active1, active2].sort())
    })

    it('filters by expiringBefore', async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      const soon1 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Soon1' })
      const soon2 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Soon2' })
      await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Later' }) // keeps FUTURE_EXPIRATION (365d out)
      await engine.changeExpiration(soon1, new Date(Date.now() + 5 * 86_400_000).toISOString(), sign)
      await engine.changeExpiration(soon2, new Date(Date.now() + 6 * 86_400_000).toISOString(), sign)

      const cutoff = new Date(Date.now() + 30 * 86_400_000).toISOString()
      const result = await engine.listRegistrants({ authorityId: auth.authority.id, expiringBefore: cutoff })
      expect(result.rows.map((r) => r.registrantId).sort()).to.deep.equal([soon1, soon2].sort())
    })

    it('filters by expiringAfter', async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      const soonId = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Soon' })
      await engine.changeExpiration(soonId, new Date(Date.now() + 5 * 86_400_000).toISOString(), sign)
      const later1 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Later1' }) // keeps FUTURE_EXPIRATION
      const later2 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Later2' }) // keeps FUTURE_EXPIRATION

      const cutoff = new Date(Date.now() + 30 * 86_400_000).toISOString()
      const result = await engine.listRegistrants({ authorityId: auth.authority.id, expiringAfter: cutoff })
      expect(result.rows.map((r) => r.registrantId).sort()).to.deep.equal([later1, later2].sort())
    })

    it('filters by district', async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      const north1 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'North1', district: 'D-NORTH' })
      const north2 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'North2', district: 'D-NORTH' })
      await seedRegistrant(engine, ctx, auth, sign, { lastName: 'South1', district: 'D-SOUTH' })

      const result = await engine.listRegistrants({ authorityId: auth.authority.id, district: 'D-NORTH' })
      expect(result.rows.map((r) => r.registrantId).sort()).to.deep.equal([north1, north2].sort())
    })

    it('filters by electionId — only registrants enrolled in that election match', async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      const elec = await addTestElection(auth)
      const electionId = await resolveElectionId(elec.ctx, elec.authority.id)
      const enrolled1 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Enrolled1' })
      const enrolled2 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Enrolled2' })
      await seedRegistrant(engine, ctx, auth, sign, { lastName: 'NotEnrolled' })
      await engine.enrollElectionRegistrant(electionId, enrolled1, sign)
      await engine.enrollElectionRegistrant(electionId, enrolled2, sign)

      const result = await engine.listRegistrants({ authorityId: auth.authority.id, electionId })
      expect(result.rows.map((r) => r.registrantId).sort()).to.deep.equal([enrolled1, enrolled2].sort())
    })

    it('filters by name — substring match against LastName or FirstName', async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      const byFirst = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Olsen', firstName: 'Ada' })
      const byLast = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Adamsky', firstName: 'Erik' })
      await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Nilsen', firstName: 'Ole' })

      const result = await engine.listRegistrants({ authorityId: auth.authority.id, name: 'Ada' })
      expect(result.rows.map((r) => r.registrantId).sort()).to.deep.equal([byFirst, byLast].sort())
    })

    it("documents the name filter's UNESCAPED % (D-04/RESEARCH Open Question 2, deliberate, not a bug)", async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      const withEn1 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Olsen', firstName: 'Ada' })
      const withEn2 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Nilsen', firstName: 'Ole' })
      // Neither registrant's LastName/FirstName contains a literal '%' character.
      // If '%' were escaped, this query would match ZERO rows (no name has a
      // literal '%'). Since it is NOT escaped, '%en' becomes the LIKE pattern
      // '%%en%' == '%en%' — matching every name containing the substring 'en',
      // broadening the match beyond a plain literal search.
      const result = await engine.listRegistrants({ authorityId: auth.authority.id, name: '%en' })
      expect(
        result.rows.map((r) => r.registrantId).sort(),
        'a % in the search term is a live SQL wildcard, not an escaped literal — documented D-04 behavior, not a bug'
      ).to.deep.equal([withEn1, withEn2].sort())
    })

    it('returns NO private-tier field on any row (roster read exposes Registrant + current RegistrantPublic columns only)', async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Privacy', firstName: 'Check' })

      const result = await engine.listRegistrants({ authorityId: auth.authority.id })
      expect(result.rows.length).to.be.greaterThan(0)
      for (const row of result.rows) {
        expect(row).to.not.have.property('privateDetails')
        const privateLikeKeys = Object.keys(row).filter((k) => /ssn|dob|birth|phone/i.test(k))
        expect(privateLikeKeys, 'roster row must carry no private-tier-shaped key').to.deep.equal([])
      }
    })
  })

  // -------------------------------------------------------------------------
  // filter combinations (D-04)
  // -------------------------------------------------------------------------
  describe('filter combinations (D-04)', () => {
    it('status + district together — a registrant matching only ONE dimension is excluded', async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      const bothMatch = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Both', district: 'D-NORTH' })
      await seedRegistrant(engine, ctx, auth, sign, { lastName: 'WrongDistrict', district: 'D-SOUTH' })
      const wrongStatus = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'WrongStatus', district: 'D-NORTH' })
      await engine.changeStatus(wrongStatus, 's', sign)

      const result = await engine.listRegistrants({ authorityId: auth.authority.id, status: 'a', district: 'D-NORTH' })
      expect(result.rows.map((r) => r.registrantId)).to.deep.equal([bothMatch])
    })

    it('electionId + name together — a registrant matching only ONE dimension is excluded', async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      const elec = await addTestElection(auth)
      const electionId = await resolveElectionId(elec.ctx, elec.authority.id)
      const bothMatch = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Olsen', firstName: 'Ada' })
      const wrongName = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Nilsen', firstName: 'Ole' })
      await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Olsen', firstName: 'Astrid' }) // right name, not enrolled
      await engine.enrollElectionRegistrant(electionId, bothMatch, sign)
      await engine.enrollElectionRegistrant(electionId, wrongName, sign)

      const result = await engine.listRegistrants({ authorityId: auth.authority.id, electionId, name: 'Olsen' })
      expect(result.rows.map((r) => r.registrantId)).to.deep.equal([bothMatch])
    })
  })

  // -------------------------------------------------------------------------
  // keyset pagination (D-05)
  // -------------------------------------------------------------------------
  describe('keyset pagination (D-05)', () => {
    it('walks every registrant exactly once via nextCursor, ascending, until nextCursor is null/undefined', async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        ids.push(await seedRegistrant(engine, ctx, auth, sign, { lastName: `Walk${i}` }))
      }

      const seen: string[] = []
      let cursor: string | undefined
      let guard = 0
      while (true) {
        guard += 1
        if (guard > 20) throw new Error('pagination walk exceeded expected iteration bound')
        const page = await engine.listRegistrants({ authorityId: auth.authority.id }, { cursor, pageSize: 2 })
        for (const row of page.rows) seen.push(row.registrantId)
        if (page.nextCursor === undefined) break
        cursor = page.nextCursor
      }

      expect(seen.length, 'every id must appear exactly once').to.equal(new Set(seen).size)
      expect(seen.sort()).to.deep.equal(ids.sort())
      expect(seen, 'ids ascending across pages').to.deep.equal([...seen].sort())
    })

    it('is stable against a concurrent insert whose id sorts BELOW the current cursor', async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        ids.push(await seedRegistrant(engine, ctx, auth, sign, { lastName: `Stable${i}` }))
      }

      const page1 = await engine.listRegistrants({ authorityId: auth.authority.id }, { pageSize: 2 })
      expect(page1.rows.length).to.equal(2)
      expect(page1.nextCursor, 'page 1 of 5 at pageSize 2 must report a cursor').to.not.equal(undefined)

      // Seed a 6th registrant whose id sorts LEXICOGRAPHICALLY BELOW the current
      // cursor — 'aaa-' sorts before every 'registrant-list-...' id this file
      // generates.
      const belowRegistrantId = 'aaa-below-current-cursor'
      const belowPublicCid = await computePublicCid(ctx, belowRegistrantId, { lastName: 'Below' })
      await engine.createRegistrant(
        { id: belowRegistrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', publicCid: belowPublicCid, expiration: FUTURE_EXPIRATION },
        sign
      )
      await engine.createRegistrantPublic({ registrantId: belowRegistrantId, lastName: 'Below' }, sign)

      const seen = [...page1.rows.map((r) => r.registrantId)]
      let cursor = page1.nextCursor
      let guard = 0
      while (cursor !== undefined) {
        guard += 1
        if (guard > 20) throw new Error('pagination walk exceeded expected iteration bound')
        const page = await engine.listRegistrants({ authorityId: auth.authority.id }, { cursor, pageSize: 2 })
        for (const row of page.rows) seen.push(row.registrantId)
        cursor = page.nextCursor
      }

      // This is the property keyset paging buys over offset paging — assert it
      // explicitly, not incidentally.
      expect(
        seen.filter((id) => id === belowRegistrantId).length,
        'an id inserted below the cursor must never surface mid-scroll (keyset paging property, not a bug)'
      ).to.equal(0)
      const seenSet = new Set(seen)
      expect(seen.length, 'no already-returned id is returned twice').to.equal(seenSet.size)
      for (const id of ids) {
        expect(seenSet.has(id), `pre-existing id ${id} must not be skipped`).to.equal(true)
      }
    })
  })

  // -------------------------------------------------------------------------
  // cached count(*) (D-05)
  // -------------------------------------------------------------------------
  describe('cached count(*) (D-05)', () => {
    it('total matches an independent uncached count(*) run over the same predicates', async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      // 2 active + 2 suspended — makes the filtered count non-trivial (not "all rows").
      await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Count0' })
      await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Count1' })
      const suspended1 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Count2' })
      const suspended2 = await seedRegistrant(engine, ctx, auth, sign, { lastName: 'Count3' })
      await engine.changeStatus(suspended1, 's', sign)
      await engine.changeStatus(suspended2, 's', sign)

      const page1 = await engine.listRegistrants({ authorityId: auth.authority.id, status: 'a' }, { pageSize: 1 })
      expect(page1.total).to.not.equal(undefined)

      const countRow = await ctx.db
        .prepare('select count(*) as n from Registrant where AuthorityId = :authorityId and Status = :status')
        .get({ authorityId: auth.authority.id, status: 'a' })
      expect(page1.total).to.equal(Number(countRow?.n))
    })

    it('total is identical across two cursor-absent reads, and undefined on a paged (cursor-present) call', async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      for (let i = 0; i < 4; i++) {
        await seedRegistrant(engine, ctx, auth, sign, { lastName: `Scroll${i}` })
      }

      const readA = await engine.listRegistrants({ authorityId: auth.authority.id }, { pageSize: 2 })
      const readB = await engine.listRegistrants({ authorityId: auth.authority.id }, { pageSize: 2 })
      expect(readA.total).to.equal(4)
      expect(readB.total).to.equal(4)
      expect(readA.total, 'total is stable across two cursor-absent reads of the same unmutated filter').to.equal(readB.total)

      const page2 = await engine.listRegistrants({ authorityId: auth.authority.id }, { cursor: readA.nextCursor, pageSize: 2 })
      expect(
        page2.total,
        'total is undefined on a cursor-present (paged) call — the caller caches page 1s value for the scroll, per D-05'
      ).to.equal(undefined)
    })
  })

  // -------------------------------------------------------------------------
  // cross-authority count(*) isolation (D-05, Pitfall 5)
  // -------------------------------------------------------------------------
  describe('cross-authority count(*) isolation (D-05, Pitfall 5)', () => {
    it("authority A's total and rows are unaffected by authority B's registrants (strand storage per-network isolation)", async () => {
      const { auth, engine, sign } = await setupRosterTest()
      const ctx = auth.ctx
      const authorityBId = await createSecondAuthority(auth, 'Isolation Authority B', 'isolation-authority-b.example.com')

      for (let i = 0; i < 2; i++) {
        await seedRegistrant(engine, ctx, auth, sign, { lastName: `IsoA${i}` })
      }
      for (let i = 0; i < 3; i++) {
        await seedRegistrant(engine, ctx, auth, sign, { lastName: `IsoB${i}`, authorityId: authorityBId })
      }

      const result = await engine.listRegistrants({ authorityId: auth.authority.id })
      expect(
        result.total,
        "strand storage per-network isolation: authority A's total must not include authority B's rows"
      ).to.equal(2)
      for (const row of result.rows) {
        expect(
          row.authorityId,
          "strand storage per-network isolation: authority A's page must not include authority B's rows"
        ).to.equal(auth.authority.id)
      }
    })
  })

  // -------------------------------------------------------------------------
  // MockRegistrationEngine parity (D-04/D-07)
  // -------------------------------------------------------------------------
  describe('MockRegistrationEngine parity (D-04/D-07)', () => {
    const dummySign = async (): Promise<Signature> => ({ signerUserId: 'u', signerKey: 'k', signature: 's' })

    it('listRegistrants returns the same result shape as the real engine (rows/nextCursor/total)', async () => {
      const mock = new MockRegistrationEngine()
      await mock.register(
        {
          registrant: { id: 'mock-shape-1', authorityId: 'auth-mock-shape', expiration: FUTURE_EXPIRATION },
          public: { lastName: 'Mocker' },
          private: { expiration: FUTURE_EXPIRATION, details: [] }
        },
        dummySign
      )

      const result = await mock.listRegistrants({ authorityId: 'auth-mock-shape' }, { pageSize: 10 })
      expect(result).to.have.all.keys('rows', 'nextCursor', 'total')
      expect(result.rows).to.be.an('array')
    })

    it('honors the status filter and pageSize', async () => {
      const mock = new MockRegistrationEngine()
      for (let i = 0; i < 3; i++) {
        await mock.register(
          {
            registrant: { id: `mock-status-${i}`, authorityId: 'auth-mock-status', expiration: FUTURE_EXPIRATION },
            private: { expiration: FUTURE_EXPIRATION, details: [] }
          },
          dummySign
        )
      }
      await mock.changeStatus('mock-status-1', 's', dummySign)

      const active = await mock.listRegistrants({ authorityId: 'auth-mock-status', status: 'a' })
      expect(active.rows.map((r) => r.registrantId).sort()).to.deep.equal(['mock-status-0', 'mock-status-2'])

      const paged = await mock.listRegistrants({ authorityId: 'auth-mock-status' }, { pageSize: 1 })
      expect(paged.rows.length).to.equal(1)
    })

    it('getElectionRegistrants returns the enrolled { electionId, registrantId } pairs', async () => {
      const mock = new MockRegistrationEngine()
      await mock.enrollElectionRegistrant('election-mock-list', 'registrant-mock-list', dummySign)
      const registrants = await mock.getElectionRegistrants('election-mock-list')
      expect(registrants).to.deep.equal([{ electionId: 'election-mock-list', registrantId: 'registrant-mock-list' }])
    })
  })

  // ===========================================================================
  // listRegistrants PublicCid currency predicate (D-06) — regression-locked
  // ===========================================================================
  describe('listRegistrants PublicCid currency predicate (D-06) — regression-locked', () => {
    let auth: TestAuthorityContext
    let engine: RegistrationEngine
    let sign: (digest: Uint8Array) => Promise<Signature>
    let registrantId: string

    beforeEach(async () => {
      const setup = await setupRosterTest()
      auth = setup.auth
      engine = setup.engine
      sign = setup.sign
      const ctx = auth.ctx
      registrantId = nextRegistrantId()

      const cidOld = await computePublicCid(ctx, registrantId, { lastName: 'Olsen', firstName: 'Ada', district: 'D-OLD' })
      await engine.createRegistrant(
        { id: registrantId, authorityId: auth.authority.id, privateCid: 'test-private-cid', publicCid: cidOld, expiration: FUTURE_EXPIRATION },
        sign
      )
      await engine.createRegistrantPublic({ registrantId, lastName: 'Olsen', firstName: 'Ada', district: 'D-OLD' }, sign)

      const cidNew = await computePublicCid(ctx, registrantId, { lastName: 'Nyman', firstName: 'Ada', district: 'D-NEW' })
      await repointPublicCid(auth, registrantId, cidNew, sign)
      await engine.createRegistrantPublic({ registrantId, lastName: 'Nyman', firstName: 'Ada', district: 'D-NEW' }, sign)

      // Fixture precondition, not optional: a single-row fixture cannot exercise
      // D-06 at all. If this assertion is ever weakened to 1, the entire block
      // becomes vacuous.
      const countRow = await ctx.db
        .prepare('select count(*) as n from RegistrantPublic where RegistrantId = :registrantId')
        .get({ registrantId })
      expect(
        Number(countRow?.n),
        'D-06 fixture precondition: a single-row fixture cannot exercise the currency predicate at all'
      ).to.equal(2)
    })

    it('returns the CURRENT RegistrantPublic district/name, never the superseded one', async () => {
      const result = await engine.listRegistrants({ authorityId: auth.authority.id })
      const matches = result.rows.filter((r) => r.registrantId === registrantId)
      expect(matches.length, 'the registrant must appear EXACTLY ONCE — a currency-less join would duplicate it').to.equal(1)
      const row = matches[0]!
      expect(row.district).to.equal('D-NEW')
      expect(row.lastName).to.equal('Nyman')
      expect(row.district).to.not.equal('D-OLD')
      expect(row.lastName).to.not.equal('Olsen')
    })

    it('MUTATION LOCK: the same fixture with the currency predicate dropped returns the STALE row', async () => {
      const ctx = auth.ctx
      // The naive join Pitfall 4 describes — RP.RegistrantId = R.Id ONLY, no
      // "and RP.Cid = R.PublicCid". If RP.Cid = R.PublicCid is ever removed
      // from registrant-list-query.ts's REGISTRANT_PUBLIC_CURRENCY_JOIN,
      // listRegistrants BECOMES this query — whose output (both rows, both
      // districts) differs from the prior test's expectation (exactly one
      // row, D-NEW only) — so that behavioral leg goes RED. This is the
      // executable replacement for a manual "temporarily edit the source and
      // eyeball it" step.
      const naiveRows: Array<{ Id: unknown; LastName: unknown; District: unknown }> = []
      for await (const row of ctx.db.eval(
        'select R.Id, RP.LastName, RP.District from Registrant R left join RegistrantPublic RP on RP.RegistrantId = R.Id where R.Id = :registrantId',
        { registrantId }
      )) {
        naiveRows.push(row as { Id: unknown; LastName: unknown; District: unknown })
      }
      expect(naiveRows.length, 'the naive join demonstrably serves BOTH the current and superseded rows').to.equal(2)
      const naiveDistricts = [...new Set(naiveRows.map((r) => r.District as string))].sort()
      expect(naiveDistricts).to.deep.equal(['D-NEW', 'D-OLD'])

      const engineResult = await engine.listRegistrants({ authorityId: auth.authority.id })
      const engineMatches = engineResult.rows.filter((r) => r.registrantId === registrantId)
      expect(engineMatches.length).to.equal(1)
      expect(engineMatches[0]!.district).to.equal('D-NEW')
    })

    it('SOURCE GUARD: no RegistrantPublic join in the shared predicate builder omits the currency predicate', () => {
      // NOTE: the D-06 predicate lives in registrant-list-query.ts's
      // REGISTRANT_PUBLIC_CURRENCY_JOIN constant (the "ONE shared predicate
      // builder" per that file's own header comment), NOT inline in
      // registration-engine.ts — registration-engine.ts only IMPORTS
      // buildRegistrantListPageSql/buildRegistrantListCountSql from it (47-05
      // factored the predicate out into a shared module for 47-06/47-11
      // reuse). registration-engine.ts's own source text therefore contains
      // ZERO occurrences of "RP.Cid = R.PublicCid" — this guard targets the
      // actual landed location so its positive assertion is non-vacuous, and
      // additionally scans registration-engine.ts's own source defensively
      // (in case a future edit adds a raw inline join there instead of
      // reusing the shared builder).
      const queryBuilderPath = join(__dirname, '..', 'src', 'registration', 'registrant-list-query.ts')
      const enginePath = join(__dirname, '..', 'src', 'registration', 'registration-engine.ts')

      const stripAndNormalize = (source: string): string =>
        source
          .split('\n')
          .filter((line) => {
            const t = line.trim()
            return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
          })
          .map((line) => line.replace(/\/\/.*$/, ''))
          .join('\n')
          .replace(/\s+/g, ' ')

      const queryBuilderNormalized = stripAndNormalize(readFileSync(queryBuilderPath, 'utf8'))
      const engineNormalized = stripAndNormalize(readFileSync(enginePath, 'utf8'))

      expect(queryBuilderNormalized).to.match(
        /RP\.Cid\s*=\s*R\.PublicCid/,
        'D-06: registrant-list-query.ts must carry the RP.Cid = R.PublicCid currency predicate'
      )

      const bareJoinPattern = /RP\.RegistrantId\s*=\s*R\.Id(?!\s*and\s+RP\.Cid\s*=\s*R\.PublicCid)/g
      const bareInBuilder = queryBuilderNormalized.match(bareJoinPattern) ?? []
      const bareInEngine = engineNormalized.match(bareJoinPattern) ?? []
      expect(
        bareInBuilder.length + bareInEngine.length,
        'any query touching RegistrantPublic that joins on RegistrantId alone (Pitfall 4 warning sign)'
      ).to.equal(0)
    })

    // -----------------------------------------------------------------------
    // WR-04 (47-REVIEW): the same D-06 currency rule, on the POINT reads
    // -----------------------------------------------------------------------
    //
    // The roster carried the currency predicate and said so emphatically; every
    // single-registrant point read (`getRegistrantPublic`, `getRegistrantPrivate`,
    // `getRegistrantSelective`, `getDisclosedSelective`, and the allowlist read
    // inside `recordRegistrantAccessEvent`) did a bare
    // `where RegistrantId = :registrantId` `.get()` with no `and Cid = <parent
    // Cid>`. All three tier tables are `InsertOnly` with PK `(RegistrantId, Cid)`,
    // so those reads returned whichever revision the storage layer yielded first
    // — on the private tier that means a superseded SSN/DOB on the detail screen,
    // and an access-trail allowlist derived from a superseded revision.
    //
    // The fixture above already carries TWO RegistrantPublic revisions with
    // `Registrant.PublicCid` repointed at the second, which is exactly what a
    // point read needs to be non-vacuous.

    it('getRegistrantPublic returns the CURRENT revision, never the superseded one', async () => {
      const row = await engine.getRegistrantPublic(registrantId)
      expect(row, 'the current public tier must be found').to.not.equal(undefined)
      expect(row!.district).to.equal('D-NEW')
      expect(row!.lastName).to.equal('Nyman')
      expect(row!.district).to.not.equal('D-OLD')
      expect(row!.lastName).to.not.equal('Olsen')
    })

    it('getRegistrantPublic agrees with listRegistrants — the detail screen and the roster cannot disagree', async () => {
      // registrant-display.ts formats names from BOTH surfaces. Before this fix
      // the roster was currency-aware and the detail screen was not, so the same
      // registrant could render two different names in one session.
      const point = await engine.getRegistrantPublic(registrantId)
      const listed = (await engine.listRegistrants({ authorityId: auth.authority.id })).rows.find(
        (r) => r.registrantId === registrantId
      )
      expect(listed, 'roster precondition').to.not.equal(undefined)
      expect(point!.lastName).to.equal(listed!.lastName)
      expect(point!.firstName).to.equal(listed!.firstName)
      expect(point!.district).to.equal(listed!.district)
    })

    it('SOURCE GUARD: every tier point read in registration-engine.ts carries a currency join', () => {
      // Structural cover for the four point reads this fixture cannot reach
      // cheaply (private/selective would each need their own repoint ceremony).
      // Scans for any `from <TierTable>` in the engine source that is not
      // immediately followed by that tier's currency-join constant reference.
      const enginePath = join(__dirname, '..', 'src', 'registration', 'registration-engine.ts')
      const engineSource = readFileSync(enginePath, 'utf8')
        .split('\n')
        .filter((line) => {
          const t = line.trim()
          return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
        })
        .join('\n')

      const tiers: Array<[string, string]> = [
        ['RegistrantPublic', 'REGISTRANT_PUBLIC_POINT_CURRENCY_JOIN'],
        ['RegistrantPrivate', 'REGISTRANT_PRIVATE_POINT_CURRENCY_JOIN'],
        ['RegistrantSelective', 'REGISTRANT_SELECTIVE_POINT_CURRENCY_JOIN']
      ]

      for (const [table, constantName] of tiers) {
        // `from <Table> T ${CONSTANT}` is the one sanctioned point-read shape.
        const sanctioned = new RegExp(`from ${table} T \\$\\{${constantName}\\}`, 'g')
        // Any other `from <Table>` is a currency-less read.
        const unsanctionedPattern = new RegExp(`from ${table}(?! T \\$\\{${constantName}\\})`, 'g')

        const sanctionedCount = (engineSource.match(sanctioned) ?? []).length
        const unsanctioned = engineSource.match(unsanctionedPattern) ?? []

        expect(
          sanctionedCount,
          `expected at least one currency-joined point read of ${table} — if this is 0 the guard is vacuous`
        ).to.be.greaterThan(0)
        expect(
          unsanctioned.length,
          `registration-engine.ts has ${unsanctioned.length} currency-LESS read(s) of ${table}. `
          + `Every point read must be \`from ${table} T \${${constantName}}\` — a bare `
          + 'where-RegistrantId read serves whichever revision the storage layer yields first.'
        ).to.equal(0)
      }
    })
  })
})
