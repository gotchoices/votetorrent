/**
 * registrant-access-trail.spec.ts — real-engine + mock-parity spec for the
 * RegistrantPrivate access trail (D-01/D-02, 47-07-PLAN.md).
 *
 * Covers:
 *   - the shared names-only sanitizer (`access-trail-fields.ts`): name
 *     collection (flat + nested groups), and the value-rejection lock that
 *     proves a private VALUE handed to the sanitizer can never survive it
 *   - RegistrationEngine.recordRegistrantAccessEvent / getRegistrantAccessEvents
 *     against the real schema: the insert is UNSIGNED (no new AdminSigning/
 *     AdminSignature row), Sequence is monotonic per registrant, update and
 *     delete are both rejected (InsertOnly), and the reviewer read returns
 *     viewer/timestamp/names newest-first
 *   - MockRegistrationEngine parity for both methods
 *
 * Framing (D-01, T-47-03), stated once here: `RegistrantAccessEvent` records
 * app-mediated access only, for accountability, deterrence, and regulatory
 * posture. It is **not a security control** — an officer holding the device
 * can read the local Quereus/LevelDB file directly and no row is written. No
 * test in this file asserts that the trail prevents, blocks, or restricts
 * anything, because it does not.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { PrivateDetail, Signature } from '@votetorrent/vote-core'
import { collectPrivateFieldNames, sanitizeAccessTrailFields } from '../src/registration/access-trail-fields.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { MockRegistrationEngine } from '../src/registration/mock-registration-engine.js'
import { sealRegistrantPrivateDetails } from '../src/registration/sealed-registration-content.js'
import { createTestNetwork, addTestAuthority, provisionTestIntakeRecipient, testKeyPairFor } from './fixtures/test-context.js'
import { nowCanonicalDatetime } from '../src/utils.js'
import type { EngineContext } from '../src/types.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'

describe('access-trail field sanitizer (D-01/T-47-02)', () => {
  describe('collectPrivateFieldNames', () => {
    it('returns the top-level names for a flat PrivateDetail[]', () => {
      const details: PrivateDetail[] = [
        { name: 'ssn', value: '000-00-0000' },
        { name: 'dob', value: '1980-01-01' }
      ]
      expect([...collectPrivateFieldNames(details)].sort()).to.deep.equal(['dob', 'ssn'])
    })

    it('QUALIFIES nested names with the dotted path the reveal UI emits, and keeps the group name too', () => {
      const details: PrivateDetail[] = [
        {
          name: 'address',
          value: [
            { name: 'street', value: '123 Main St' },
            { name: 'zip', value: '00000' }
          ]
        }
      ]
      // 'address.street', NOT a bare 'street'. The Authority app's
      // flattenPrivateDetails builds the same dotted path and PrivateFieldRow
      // reveals it under that name; collecting the bare segment made the
      // sanitizer's intersection empty and silently dropped every nested
      // reveal from the trail. The bare segments must NOT be present.
      const names = [...collectPrivateFieldNames(details)].sort()
      expect(names).to.deep.equal(['address', 'address.street', 'address.zip'])
      expect(names).to.not.include('street')
      expect(names).to.not.include('zip')
    })

    it('qualifies to full depth through a group nested inside a group', () => {
      const details: PrivateDetail[] = [
        {
          name: 'address',
          value: [
            { name: 'geo', value: [{ name: 'lat', value: '42.0' }] }
          ]
        }
      ]
      expect([...collectPrivateFieldNames(details)].sort()).to.deep.equal([
        'address', 'address.geo', 'address.geo.lat'
      ])
    })

    it('the nested reveal survives the sanitizer end-to-end — the D-14 seam CR-01 broke', () => {
      const details: PrivateDetail[] = [
        { name: 'ssn', value: '000-00-0000' },
        {
          name: 'address',
          value: [
            { name: 'street', value: '123 Main St' },
            { name: 'zip', value: '00000' }
          ]
        }
      ]
      // The exact strings the UI's flattenPrivateDetails produces for these
      // details (leaves only, dotted). Kept as a literal rather than derived
      // so this spec fails loudly if the app-side vocabulary ever changes;
      // the app-side half of this seam is locked by
      // apps/VoteTorrentAuthority/.../access-trail-seam.test.ts, which feeds
      // the REAL flattener into this REAL sanitizer.
      const revealedByUi = ['ssn', 'address.street', 'address.zip']
      const stored = sanitizeAccessTrailFields(revealedByUi, collectPrivateFieldNames(details))
      expect(stored).to.deep.equal(['address.street', 'address.zip', 'ssn'])
    })

    it('returns an empty Set for undefined, [], and a malformed element, without throwing', () => {
      expect(collectPrivateFieldNames(undefined).size).to.equal(0)
      expect(collectPrivateFieldNames([]).size).to.equal(0)
      const malformed = [
        { value: 'no name' } as unknown as PrivateDetail,
        { name: '', value: 'empty name' } as PrivateDetail,
        { name: 123, value: 'x' } as unknown as PrivateDetail
      ]
      expect(() => collectPrivateFieldNames(malformed)).to.not.throw()
      expect(collectPrivateFieldNames(malformed).size).to.equal(0)
    })
  })

  describe('sanitizeAccessTrailFields', () => {
    it('keeps only intersecting names, de-dupes a repeated name, and sorts ascending', () => {
      const allowed = new Set(['ssn', 'dob', 'phone'])
      const result = sanitizeAccessTrailFields(['phone', 'ssn', 'phone', 'unknown-field'], allowed)
      expect(result).to.deep.equal(['phone', 'ssn'])
    })

    it('returns [] for an empty requested list, no intersection, an empty allowed set, or undefined', () => {
      const allowed = new Set(['ssn'])
      expect(sanitizeAccessTrailFields([], allowed)).to.deep.equal([])
      expect(sanitizeAccessTrailFields(['dob'], allowed)).to.deep.equal([])
      expect(sanitizeAccessTrailFields(['ssn'], new Set())).to.deep.equal([])
      expect(sanitizeAccessTrailFields(undefined, allowed)).to.deep.equal([])
    })

    it('the value-rejection lock: a private VALUE handed in alongside a real name is dropped, never returned', () => {
      const allowed = new Set(['ssn', 'dob', 'phone'])
      const requested = ['123-45-6789', '1980-01-01', 'ssn']
      const result = sanitizeAccessTrailFields(requested, allowed)
      expect(result).to.deep.equal(['ssn'])
      expect(result).to.not.include('123-45-6789')
      expect(result).to.not.include('1980-01-01')
    })

    it('does not throw on the value-rejection lock input', () => {
      const allowed = new Set(['ssn'])
      expect(() => sanitizeAccessTrailFields(['123-45-6789', 'ssn'], allowed)).to.not.throw()
    })
  })
})

// ===========================================================================
// RegistrationEngine + MockRegistrationEngine — the trail itself (Task 3)
// ===========================================================================

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). */
function makeRealSigner (userId: string): (digest: Uint8Array) => Promise<Signature> {
  const { privateHex, publicHex } = testKeyPairFor(userId)
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes) // v2 default: prehash:true
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
}

let trailRegistrantSeq = 0
function nextTrailRegistrantId (): string {
  trailRegistrantSeq += 1
  return `access-trail-registrant-${Date.now()}-${trailRegistrantSeq}`
}

const TRAIL_FUTURE_EXPIRATION = Date.now() + 365 * 86_400_000

/** Three named private fields carrying obviously-fake sentinel values — the names allowlist is derived from these. */
const TRAIL_PRIVATE_DETAILS: PrivateDetail[] = [
  { name: 'ssn', value: '000-00-0000' },
  { name: 'dob', value: '1980-01-01' },
  { name: 'phone', value: '555-0100' }
]

/**
 * D-49 (62-31): seals `details` ONCE (sealing is randomized) and computes the Cid over that SAME
 * stored text — mirrors `registration.spec.ts`'s own `sealPrivateDetails` precedent, so a test
 * driving `createRegistrant` and the private-tier insert as two SEPARATE calls can still predict
 * the parent's `PrivateCid` before the child row exists, without re-sealing (which would produce a
 * DIFFERENT Cid and trip `RegistrantCidMatch`).
 */
async function sealTrailPrivateDetails (
  ctx: EngineContext,
  authorityId: string,
  registrantId: string,
  input: { expiration: number; details: PrivateDetail[] }
): Promise<{ storedDetails: string; cid: string }> {
  const storedDetails = await sealRegistrantPrivateDetails(ctx.db, { authorityId, registrantId, details: input.details })
  const expiration = new Date(input.expiration).toISOString()
  const row = await ctx.db
    .prepare('select cid(Digest(:registrantId, :expiration, :privateDetails)) as c')
    .get({ registrantId, expiration, privateDetails: storedDetails })
  return { storedDetails, cid: row!.c as string }
}

/** Narrow structural type for reaching `RegistrationEngine`'s private `insertRegistrantPrivateRow`
 * — the project's established convention for exercising engine-internal state from a spec. */
type EngineWithInsertRegistrantPrivateRow = Omit<RegistrationEngine, 'insertRegistrantPrivateRow'> & {
  insertRegistrantPrivateRow: (
    registrantId: string,
    authorityId: string,
    expiration: number,
    storedDetails: string,
    signatureOrCallback: (digest: Uint8Array) => Promise<Signature>
  ) => Promise<{ cid: string }>
}

async function setup (): Promise<{
  auth: TestAuthorityContext
  engine: RegistrationEngine
  sign: (digest: Uint8Array) => Promise<Signature>
}> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  // D-49 (62-31): seedRegistrant below writes non-empty private details through
  // createRegistrantPrivate (now D-49-sealed), and recordRegistrantAccessEvent/getRegistrantPrivate
  // must be able to open what was sealed — one provisioning call here covers every call site.
  await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
  const sign = makeRealSigner(auth.user.id)
  const engine = new RegistrationEngine(auth.ctx)
  return { auth, engine, sign }
}

/**
 * Seed a Registrant + a RegistrantPrivate row carrying `TRAIL_PRIVATE_DETAILS`.
 * The RegistrantPrivate row is mandatory, not decoration: the names allowlist
 * is derived from it, so a registrant without one records nothing (proven by
 * a dedicated test below).
 */
async function seedRegistrant (
  engine: RegistrationEngine,
  auth: TestAuthorityContext,
  sign: (digest: Uint8Array) => Promise<Signature>
): Promise<string> {
  const registrantId = nextTrailRegistrantId()
  const ctx = (engine as unknown as { ctx: EngineContext }).ctx
  const { storedDetails, cid: privateCid } = await sealTrailPrivateDetails(ctx, auth.authority.id, registrantId, { expiration: TRAIL_FUTURE_EXPIRATION, details: TRAIL_PRIVATE_DETAILS })
  await engine.createRegistrant(
    { id: registrantId, authorityId: auth.authority.id, privateCid, expiration: TRAIL_FUTURE_EXPIRATION },
    sign
  )
  await (engine as unknown as EngineWithInsertRegistrantPrivateRow).insertRegistrantPrivateRow(
    registrantId, auth.authority.id, TRAIL_FUTURE_EXPIRATION, storedDetails, sign
  )
  return registrantId
}

describe('RegistrantAccessEvent trail (D-01/D-02)', () => {
  it('is an unsigned insert: the row lands but neither AdminSigning nor AdminSignature grows', async () => {
    const { auth, engine, sign } = await setup()
    const registrantId = await seedRegistrant(engine, auth, sign)
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    const beforeSigning = await ctx.db.prepare('select count(*) as n from AdminSigning where AuthorityId = :id').get({ id: auth.authority.id })
    const beforeSignature = await ctx.db.prepare('select count(*) as n from AdminSignature').get()

    await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['ssn', 'dob'])

    const afterSigning = await ctx.db.prepare('select count(*) as n from AdminSigning where AuthorityId = :id').get({ id: auth.authority.id })
    const afterSignature = await ctx.db.prepare('select count(*) as n from AdminSignature').get()

    // The assertion that would go red if a later "hardening" added a ceremony —
    // D-02 forbids that because it would grow AdminSignature with read traffic.
    expect(Number(afterSigning?.n)).to.equal(Number(beforeSigning?.n))
    expect(Number(afterSignature?.n)).to.equal(Number(beforeSignature?.n))

    const rowCount = await ctx.db.prepare('select count(*) as n from RegistrantAccessEvent where RegistrantId = :registrantId').get({ registrantId })
    expect(Number(rowCount?.n)).to.equal(1)
  })

  it('Fields round-trips NAMES sorted ascending, with viewerUserId/sequence/a Z-suffixed timestamp (D-01/CR-02)', async () => {
    const { auth, engine, sign } = await setup()
    const registrantId = await seedRegistrant(engine, auth, sign)

    await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['ssn', 'dob'])

    const events = await engine.getRegistrantAccessEvents(registrantId)
    expect(events).to.have.length(1)
    const event = events[0]!
    expect(event.fields).to.deep.equal(['dob', 'ssn'])
    expect(event.viewerUserId).to.equal(auth.user.id)
    expect(event.sequence).to.equal(0)
    expect(event.timestamp).to.match(/Z$/)
    expect(new Date(event.timestamp).getTime()).to.be.closeTo(Date.now(), 5000)
  })

  it('the value-rejection lock: handing the write path the registrant\'s own private VALUES writes no row, and Fields never contains a sentinel', async () => {
    const { auth, engine, sign } = await setup()
    const registrantId = await seedRegistrant(engine, auth, sign)
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['000-00-0000', '1980-01-01'])

    const countAfterValues = await ctx.db.prepare('select count(*) as n from RegistrantAccessEvent where RegistrantId = :registrantId').get({ registrantId })
    expect(Number(countAfterValues?.n)).to.equal(0)

    let allFields = ''
    for await (const row of ctx.db.eval('select Fields from RegistrantAccessEvent where RegistrantId = :registrantId', { registrantId })) {
      allFields += String(row.Fields)
    }
    expect(allFields).to.not.include('000-00-0000')
    expect(allFields).to.not.include('1980-01-01')

    await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['ssn', '000-00-0000'])
    const events = await engine.getRegistrantAccessEvents(registrantId)
    expect(events).to.have.length(1)
    expect(events[0]!.fields).to.deep.equal(['ssn'])
  })

  it('Sequence is monotonic per registrant, and independent across registrants', async () => {
    const { auth, engine, sign } = await setup()
    const registrantId = await seedRegistrant(engine, auth, sign)

    await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['ssn'])
    await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['dob'])
    await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['phone'])

    const events = await engine.getRegistrantAccessEvents(registrantId)
    expect(events.map((e) => e.sequence).sort((a, b) => a - b)).to.deep.equal([0, 1, 2])

    const secondRegistrantId = await seedRegistrant(engine, auth, sign)
    await engine.recordRegistrantAccessEvent(secondRegistrantId, auth.user.id, ['ssn'])
    const secondEvents = await engine.getRegistrantAccessEvents(secondRegistrantId)
    expect(secondEvents).to.have.length(1)
    expect(secondEvents[0]!.sequence).to.equal(0)
  })

  it('two OVERLAPPING flushes both land, with distinct Sequences (WR-06 read-then-insert race)', async () => {
    // `useAccessTrailVisit` fires BOTH its flushes fire-and-forget
    // (`void visitRef.current?.flush()` on the background timer AND on
    // unmount), so two recordRegistrantAccessEvent calls really can be in
    // flight at once. Sequence allocation is a `select max(Sequence)` followed
    // by an unwrapped `insert`: without the retry, both reads returned the
    // same high-water mark and the loser violated
    // `primary key (RegistrantId, Sequence)` — and createAccessTrailVisit's
    // flush() swallows the rejection in an empty catch, so the losing audit
    // row disappeared with no error, no log line and no UI signal.
    const { auth, engine, sign } = await setup()
    const registrantId = await seedRegistrant(engine, auth, sign)

    await Promise.all([
      engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['ssn']),
      engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['dob'])
    ])

    const events = await engine.getRegistrantAccessEvents(registrantId)
    expect(events, 'BOTH overlapping flushes must be recorded — neither may be silently lost').to.have.length(2)
    expect(new Set(events.map((e) => e.sequence)).size, 'the two rows must carry DISTINCT sequences').to.equal(2)
    expect(events.map((e) => e.fields).flat().sort()).to.deep.equal(['dob', 'ssn'])
  })

  it('the landed-row probe survives a trailing-zero millisecond, which Quereus stores truncated (WR-01)', async () => {
    // REGRESSION LOCK for a ~10% flake that was a real duplicate-write defect.
    //
    // Quereus coerces the `datetime` column through a normalization that drops
    // the trailing `Z` AND strips trailing zeros from the fractional seconds:
    // a bound `...:31.910Z` comes back as `...:31.91`. The probe originally
    // compared the two as strings after removing only the `Z`, so whenever
    // `Date.now()` landed on a millisecond ending in zero the probe answered
    // "not ours", the retry ran, and a SECOND copy of the same logical event
    // was appended. `RegistrantAccessEvent` is InsertOnly, so the duplicate is
    // permanent.
    //
    // The sibling test below exercises the same path but with whatever
    // millisecond the clock happens to supply, so it only caught this about one
    // run in ten — it read as flakiness rather than as the defect it was. This
    // test PINS the clock to a trailing-zero millisecond so the regression is
    // deterministic. Do not "fix" a failure here by loosening the comparison to
    // ignore the timestamp: that would let a genuinely foreign row at the same
    // sequence be mistaken for ours and silently DROP an audit write.
    const { auth, engine, sign } = await setup()
    const registrantId = await seedRegistrant(engine, auth, sign)
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    const realNow = Date.now
    // .910 -> Quereus stores ".91". Any ms ending in 0 reproduces it.
    const pinned = new Date('2026-08-05T12:04:31.910Z').getTime()
    Date.now = () => pinned

    const realExec = ctx.db.exec.bind(ctx.db)
    let rejectedOnce = false
    ;(ctx.db as unknown as { exec: typeof ctx.db.exec }).exec = async (sql: any, params?: any) => {
      const result = await realExec(sql, params)
      if (!rejectedOnce && typeof sql === 'string' && sql.includes('insert into RegistrantAccessEvent')) {
        rejectedOnce = true
        throw new Error('stale revision: rev 1 vs rev 1')
      }
      return result
    }

    try {
      await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['ssn'])
    } finally {
      ;(ctx.db as unknown as { exec: typeof ctx.db.exec }).exec = realExec
      Date.now = realNow
    }

    expect(rejectedOnce, 'the fault injector must actually have fired, or this test is vacuous').to.equal(true)
    const events = await engine.getRegistrantAccessEvents(registrantId)
    expect(
      events,
      'a trailing-zero millisecond must not defeat the own-row probe and duplicate the audit row'
    ).to.have.length(1)
    expect(events[0]!.sequence).to.equal(0)
    expect(events[0]!.fields).to.deep.equal(['ssn'])
  })

  it('an insert that LANDS and then reports failure is not written twice (WR-01)', async () => {
    // The retry's original predicate was "did the high-water mark advance?".
    // Our own row advances it, so an exec that rejects AFTER the row landed
    // — project memory records intermittent `stale revision: rev 1 vs rev 1`
    // rejections from @optimystic/db-p2p 0.18 — was read as a lost race, and
    // the retry appended a SECOND copy of the same logical event at
    // sequence + 1. RegistrantAccessEvent is InsertOnly, so that duplicate
    // could never be removed.
    const { auth, engine, sign } = await setup()
    const registrantId = await seedRegistrant(engine, auth, sign)
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    const realExec = ctx.db.exec.bind(ctx.db)
    let rejectedOnce = false
    ;(ctx.db as unknown as { exec: typeof ctx.db.exec }).exec = async (sql: any, params?: any) => {
      const result = await realExec(sql, params)
      if (!rejectedOnce && typeof sql === 'string' && sql.includes('insert into RegistrantAccessEvent')) {
        rejectedOnce = true
        // The write COMMITTED; only the acknowledgement failed.
        throw new Error('stale revision: rev 1 vs rev 1')
      }
      return result
    }

    try {
      await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['ssn'])
    } finally {
      ;(ctx.db as unknown as { exec: typeof ctx.db.exec }).exec = realExec
    }

    expect(rejectedOnce, 'the fault injector must actually have fired, or this test is vacuous').to.equal(true)
    const events = await engine.getRegistrantAccessEvents(registrantId)
    expect(events, 'the landed row must NOT be duplicated by the retry').to.have.length(1)
    expect(events[0]!.sequence).to.equal(0)
    expect(events[0]!.fields).to.deep.equal(['ssn'])
  })

  it('a probe failure inside the retry never REPLACES the original insert error (WR-01)', async () => {
    // `readNextSequence` / the own-row probe are fresh round trips issued
    // immediately after a storage failure, i.e. exactly when they are most
    // likely to fail too. If one rejects, the caller must still be handed the
    // INSERT's error, not a `select` failure, or the diagnosis is misleading.
    const { auth, engine, sign } = await setup()
    const registrantId = await seedRegistrant(engine, auth, sign)
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    const realExec = ctx.db.exec.bind(ctx.db)
    const realPrepare = ctx.db.prepare.bind(ctx.db)
    let insertFailed = false
    ;(ctx.db as unknown as { exec: typeof ctx.db.exec }).exec = async (sql: any, params?: any) => {
      if (typeof sql === 'string' && sql.includes('insert into RegistrantAccessEvent')) {
        insertFailed = true
        throw new Error('THE-REAL-INSERT-FAILURE')
      }
      return await realExec(sql, params)
    }
    ;(ctx.db as unknown as { prepare: typeof ctx.db.prepare }).prepare = (sql: any, ...rest: any[]) => {
      if (insertFailed && typeof sql === 'string' && sql.includes('RegistrantAccessEvent')) {
        throw new Error('THE-PROBE-FAILURE')
      }
      return realPrepare(sql, ...rest)
    }

    let caught: unknown
    try {
      await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['ssn'])
    } catch (err) {
      caught = err
    } finally {
      ;(ctx.db as unknown as { exec: typeof ctx.db.exec }).exec = realExec
      ;(ctx.db as unknown as { prepare: typeof ctx.db.prepare }).prepare = realPrepare
    }

    expect(insertFailed, 'the fault injector must actually have fired').to.equal(true)
    expect(caught).to.be.instanceOf(Error)
    expect(String((caught as Error).message)).to.contain('THE-REAL-INSERT-FAILURE')
    expect(String((caught as Error).message), 'the probe failure must not mask the insert failure').to.not.contain('THE-PROBE-FAILURE')
  })

  it('getRegistrantAccessEvents returns newest-first (Sequence descending)', async () => {
    const { auth, engine, sign } = await setup()
    const registrantId = await seedRegistrant(engine, auth, sign)

    await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['ssn'])
    await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['dob'])
    await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['phone'])

    const events = await engine.getRegistrantAccessEvents(registrantId)
    expect(events.map((e) => e.sequence)).to.deep.equal([2, 1, 0])
    expect(events[0]!.fields).to.deep.equal(['phone'])
  })

  it('InsertOnly rejects both update and delete, leaving prior rows present and unmodified', async () => {
    const { auth, engine, sign } = await setup()
    const registrantId = await seedRegistrant(engine, auth, sign)
    await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['ssn'])

    const ctx = (engine as unknown as { ctx: EngineContext }).ctx

    let updateErr: unknown
    try {
      await ctx.db.exec(
        "update RegistrantAccessEvent with context Tid = 9, now = :now set ViewerUserId = 'X'",
        { now: nowCanonicalDatetime() }
      )
    } catch (err) {
      updateErr = err
    }
    // A missing-mutation-context error may fire before InsertOnly itself —
    // either rejection satisfies the append-only property (authority.spec.ts precedent).
    expect(updateErr).to.be.instanceOf(Error)

    let deleteErr: unknown
    try {
      await ctx.db.exec(
        'delete from RegistrantAccessEvent with context Tid = 9, now = :now',
        { now: nowCanonicalDatetime() }
      )
    } catch (err) {
      deleteErr = err
    }
    expect(deleteErr).to.be.instanceOf(Error)

    const events = await engine.getRegistrantAccessEvents(registrantId)
    expect(events).to.have.length(1)
    expect(events[0]!.viewerUserId).to.equal(auth.user.id)
    expect(events[0]!.fields).to.deep.equal(['ssn'])
  })

  it('an empty fields list writes no row and does not throw', async () => {
    const { auth, engine, sign } = await setup()
    const registrantId = await seedRegistrant(engine, auth, sign)

    await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, [])

    const events = await engine.getRegistrantAccessEvents(registrantId)
    expect(events).to.have.length(0)
  })

  it('a registrant with no RegistrantPrivate row writes no row and does not throw', async () => {
    const { auth, engine, sign } = await setup()
    const registrantId = nextTrailRegistrantId()
    const ctx = (engine as unknown as { ctx: EngineContext }).ctx
    const { cid: privateCid } = await sealTrailPrivateDetails(ctx, auth.authority.id, registrantId, { expiration: TRAIL_FUTURE_EXPIRATION, details: TRAIL_PRIVATE_DETAILS })
    await engine.createRegistrant(
      { id: registrantId, authorityId: auth.authority.id, privateCid, expiration: TRAIL_FUTURE_EXPIRATION },
      sign
    )
    // Deliberately no createRegistrantPrivate call — no RegistrantPrivate row exists.
    await engine.recordRegistrantAccessEvent(registrantId, auth.user.id, ['ssn'])

    const events = await engine.getRegistrantAccessEvents(registrantId)
    expect(events).to.have.length(0)
  })

  describe('MockRegistrationEngine parity', () => {
    async function setupMock (): Promise<{ mock: MockRegistrationEngine; registrantId: string }> {
      const mock = new MockRegistrationEngine()
      const registrantId = nextTrailRegistrantId()
      const stubSign = async (): Promise<Signature> => ({ signerUserId: 'mock-user', signerKey: 'mock-key', signature: 'mock-sig' })
      await mock.register(
        {
          registrant: { id: registrantId, authorityId: 'mock-authority', expiration: TRAIL_FUTURE_EXPIRATION },
          private: { expiration: TRAIL_FUTURE_EXPIRATION, details: TRAIL_PRIVATE_DETAILS }
        },
        stubSign
      )
      return { mock, registrantId }
    }

    it('names round-trip sorted and de-duped', async () => {
      const { mock, registrantId } = await setupMock()
      await mock.recordRegistrantAccessEvent(registrantId, 'viewer-1', ['dob', 'ssn', 'dob'])
      const events = await mock.getRegistrantAccessEvents(registrantId)
      expect(events).to.have.length(1)
      expect(events[0]!.fields).to.deep.equal(['dob', 'ssn'])
    })

    it('value strings are dropped', async () => {
      const { mock, registrantId } = await setupMock()
      await mock.recordRegistrantAccessEvent(registrantId, 'viewer-1', ['000-00-0000', 'ssn'])
      const events = await mock.getRegistrantAccessEvents(registrantId)
      expect(events).to.have.length(1)
      expect(events[0]!.fields).to.deep.equal(['ssn'])
    })

    it('sequence is 0, 1, 2 on repeated calls', async () => {
      const { mock, registrantId } = await setupMock()
      await mock.recordRegistrantAccessEvent(registrantId, 'viewer-1', ['ssn'])
      await mock.recordRegistrantAccessEvent(registrantId, 'viewer-1', ['dob'])
      await mock.recordRegistrantAccessEvent(registrantId, 'viewer-1', ['phone'])
      const events = await mock.getRegistrantAccessEvents(registrantId)
      expect(events.map((e) => e.sequence).sort((a, b) => a - b)).to.deep.equal([0, 1, 2])
    })

    it('getRegistrantAccessEvents returns newest-first', async () => {
      const { mock, registrantId } = await setupMock()
      await mock.recordRegistrantAccessEvent(registrantId, 'viewer-1', ['ssn'])
      await mock.recordRegistrantAccessEvent(registrantId, 'viewer-1', ['dob'])
      const events = await mock.getRegistrantAccessEvents(registrantId)
      expect(events.map((e) => e.sequence)).to.deep.equal([1, 0])
    })

    it('an empty list writes nothing', async () => {
      const { mock, registrantId } = await setupMock()
      await mock.recordRegistrantAccessEvent(registrantId, 'viewer-1', [])
      const events = await mock.getRegistrantAccessEvents(registrantId)
      expect(events).to.have.length(0)
    })

    it('the returned array is a copy — mutating it does not change what a subsequent read returns', async () => {
      const { mock, registrantId } = await setupMock()
      await mock.recordRegistrantAccessEvent(registrantId, 'viewer-1', ['ssn'])
      const events = await mock.getRegistrantAccessEvents(registrantId)
      events.pop()
      const eventsAgain = await mock.getRegistrantAccessEvents(registrantId)
      expect(eventsAgain).to.have.length(1)
    })
  })
})
