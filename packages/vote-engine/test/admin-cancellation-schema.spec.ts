/**
 * admin-cancellation-schema.spec.ts — the AdminCancellation table (votetorrent.qsql, 66.1-04, decision D-05).
 *
 * Proves the write rule in both directions. One current officer who holds 'rad' (with a P-256 key or a secp256k1
 * key) can cancel one administration change that has not taken effect yet, whether the change was promoted into
 * Admin already or exists only as a ProposedAdmin row. Every other write is refused, and the refusal names the
 * CHECK that refused it (CancelSignatureValid, TargetPending, CancellerIsRadOfficer, CantUpdate, CantDelete).
 *
 * Attacks go through the RAW schema (`rawCancel`), never through an engine module, so the schema is what is under
 * test. The digest is computed here with the schema's own Digest() over the canonical 19-character effective time
 * (no zone suffix), which is the form the 66.1-01 probe measured as verifying.
 *
 * A nested describe then disables each CHECK, or one leg of it, in a FRESH database built on the mutated schema and
 * replays the same attack, which now succeeds. That shows every CHECK and every leg the refusals rely on does real
 * work.
 *
 * The officer-whose-only-generation-was-cancelled test (A2-shipped) and its mutation (M8) are present because the
 * 66.1-01 probe recorded A2 = PASS, so the shipped CancellerIsRadOfficer keeps the cancellation exclusion.
 */

import { expect } from 'chai'
import type { Database, SqlParameters } from '@quereus/quereus'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { AdminInit, Proposal, Scope, Signature, User, UserKeyType } from '@votetorrent/vote-core'
import { setSchemaSql } from '../src/database/initialize.js'
import { VOTETORRENT_SCHEMA_SQL } from '../src/database/schema-sql.js'
import { digestToBytes, nowCanonicalDatetime, toCanonicalDatetime } from '../src/utils.js'
import { makeP256TestKey } from './fixtures/p256-signer.js'
import {
  addTestAuthority,
  createTestNetwork,
  makeDistinctTestUser,
  makeTestSignCallback,
  seedUserInvite,
  type TestAuthorityContext
} from './fixtures/test-context.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const CANCEL_TAG = 'vt-admin-cancel'
const CANCEL_EXCLUSION =
  'and not exists (select 1 from AdminCancellation C where C.AuthorityId = A.AuthorityId and C.AdminEffectiveAt = A.EffectiveAt)'
const FULL_SCOPES: Scope[] = ['rn', 'rad', 'vrg', 'iad', 'uai', 'mel', 'ceb'] as Scope[]

interface Officer {
  userId: string
  pubKey: string
  sign: (digest: Uint8Array) => Promise<string>
}

interface Rig {
  auth: TestAuthorityContext
  db: Database
  authorityId: string
  base: number
  founder: Officer & { signCallback: (digest: Uint8Array) => Promise<Signature> }
  /** a current officer holding 'rad' whose only key is P-256 (expires in 1 day) */
  radP: Officer
  /** a current officer holding only 'mel' */
  nonRad: Officer
  /** a user with a live key who is never an officer */
  outsider: Officer
  /** holds 'rad' only in the future generation TP */
  lateRad: Officer
  foundingEffectiveAt: string
  g1: string
  tp: string
  /** raw ProposedAdmin targets (unpromoted) */
  ta: string
  tb: string
  tc: string
  td: string
  te: string
}

/** Insert a user with a first key (copy of the dashboard spec's `insertFixtureUser`). */
async function insertFixtureUser (auth: TestAuthorityContext, user: User): Promise<void> {
  const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, user)
  const tid = Date.now() + Math.floor(Math.random() * 1_000_000)
  await auth.ctx.db.exec(
    `insert into User (Id, Name, ImageRef)
     with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${tid}
     values (:userId, :userName, :userImageRef)`,
    {
      userId: user.id,
      userName: user.name,
      userImageRef: user.imageRef ? JSON.stringify(user.imageRef) : null,
      inviteSlotCid,
      inviteSignature
    }
  )
  const key = user.activeKeys[0]!
  await auth.ctx.db.exec(
    `insert into UserKey (UserId, Type, PubKey, Expiration)
     with context UserKey = null, Signature = null, Tid = ${tid + 1}, now = :now, IsSignatureValid = true
     values (:userId, :keyType, :pubKey, :expiration)`,
    {
      userId: user.id,
      keyType: key.type,
      pubKey: key.key,
      expiration: toCanonicalDatetime(key.expiration),
      now: nowCanonicalDatetime()
    }
  )
}

/** A secp256k1 fixture user with a distinct User.Name, inserted into the network. */
async function secpOfficer (auth: TestAuthorityContext, name: string): Promise<Officer> {
  const user: User = { ...makeDistinctTestUser(), name }
  await insertFixtureUser(auth, user)
  const cb = makeTestSignCallback(user)
  return { userId: user.id, pubKey: user.activeKeys[0]!.key, sign: async (d) => (await cb(d)).signature }
}

type OfficerSel = AdminInit['officers'][number]

function existing (rig: Pick<Rig, 'authorityId'>, userId: string, title: string, scopes: Scope[]): OfficerSel {
  return { existing: { userId, authorityId: rig.authorityId, title, scopes } } as OfficerSel
}

/** Engine proposal signed by the founder; returns the canonical EffectiveAt. */
async function propose (
  rig: Pick<Rig, 'auth' | 'founder'>,
  effectiveAtMs: number,
  officers: OfficerSel[]
): Promise<string> {
  const proposal: Proposal<AdminInit> = {
    proposed: { officers, effectiveAt: effectiveAtMs, thresholdPolicies: [{ policy: 'rad', threshold: 1 }] },
    signers: [rig.founder.userId]
  }
  await rig.auth.authorityEngine.proposeAdmin(proposal, rig.founder.signCallback)
  return toCanonicalDatetime(effectiveAtMs)
}

/** A raw, unpromoted target: one ProposedAdmin row, same columns and context as the engine's insert. */
async function seedProposedTarget (rig: Pick<Rig, 'db' | 'authorityId' | 'founder'>, effectiveAtMs: number): Promise<string> {
  const effectiveAt = toCanonicalDatetime(effectiveAtMs)
  const tid = Date.now() + Math.floor(Math.random() * 1_000_000)
  await rig.db.exec(
    `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
     with context UserId = :signerUserId, UserKey = :signerKey, Signature = :signature, Tid = ${tid}, now = :now, IsUserValid = :isUserValid
     values (:authorityId, :effectiveAt, :thresholdPolicies)`,
    {
      authorityId: rig.authorityId,
      effectiveAt,
      thresholdPolicies: JSON.stringify([{ policy: 'rad', threshold: 1 }]),
      signerUserId: rig.founder.userId,
      signerKey: rig.founder.pubKey,
      signature: 'raw-test-seed',
      now: nowCanonicalDatetime(),
      isUserValid: true
    }
  )
  return effectiveAt
}

async function currentAdmin (rig: Rig): Promise<unknown> {
  const row = await rig.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId: rig.authorityId })
  return row?.EffectiveAt
}

async function adminRowExists (rig: Rig, effectiveAt: string): Promise<boolean> {
  const row = await rig.db
    .prepare('select 1 as hit from Admin where AuthorityId = :authorityId and EffectiveAt = :effectiveAt')
    .get({ authorityId: rig.authorityId, effectiveAt })
  return row != null
}

async function makeRig (): Promise<Rig> {
  const base = Date.now()
  const net = await createTestNetwork({
    network: {
      admin: {
        officers: [{ init: { name: 'Admin A', title: 'Chair', scopes: FULL_SCOPES } }],
        effectiveAt: base - 2 * HOUR,
        thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
      }
    }
  })
  const auth = await addTestAuthority(net)
  const db = auth.ctx.db
  const authorityId = auth.authority.id

  const founderCallback = makeTestSignCallback(net.user)
  const founder = {
    userId: net.user.id,
    pubKey: net.user.activeKeys[0]!.key,
    signCallback: founderCallback,
    sign: async (d: Uint8Array) => (await founderCallback(d)).signature
  }

  const pKey = makeP256TestKey()
  const radPUser: User = { ...makeDistinctTestUser(), name: 'Rad P-256 Officer' }
  radPUser.activeKeys = [{ key: pKey.pubHex, type: 'P' as UserKeyType, expiration: base + DAY }]
  await insertFixtureUser(auth, radPUser)
  const radP: Officer = {
    userId: radPUser.id,
    pubKey: pKey.pubHex,
    sign: async (d) => bytesToHex(p256.sign(d, pKey.privBytes))
  }
  const nonRad = await secpOfficer(auth, 'Non-rad Officer')
  const outsider = await secpOfficer(auth, 'Outsider')
  const lateRad = await secpOfficer(auth, 'Late Rad Officer')

  const founding = await db
    .prepare('select min(EffectiveAt) as e from Admin where AuthorityId = :authorityId')
    .get({ authorityId })
  const partial = { auth, db, authorityId, founder }

  const g1Roster = [
    existing(partial, founder.userId, 'Chair', FULL_SCOPES),
    existing(partial, radP.userId, 'Rad Officer', ['rad'] as Scope[]),
    existing(partial, nonRad.userId, 'Clerk', ['mel'] as Scope[])
  ]
  const g1 = await propose(partial, base - HOUR, g1Roster)
  const tp = await propose(partial, base + 10 * MIN, [
    ...g1Roster,
    existing(partial, lateRad.userId, 'Late Officer', ['rad'] as Scope[])
  ])

  const ta = await seedProposedTarget(partial, base + 2 * HOUR)
  const tb = await seedProposedTarget(partial, base + 4 * HOUR)
  const tc = await seedProposedTarget(partial, base + 3 * DAY)
  const td = await seedProposedTarget(partial, base + 3 * DAY + 30 * MIN)
  const te = await seedProposedTarget(partial, base + 3 * DAY + HOUR)

  const rig: Rig = {
    auth, db, authorityId, base, founder, radP, nonRad, outsider, lateRad,
    foundingEffectiveAt: founding!.e as string,
    g1, tp, ta, tb, tc, td, te
  }

  // G1 was promoted and is current; TP was promoted into Admin and waits for its time.
  expect(await currentAdmin(rig)).to.equal(g1)
  expect(await adminRowExists(rig, tp)).to.equal(true)
  return rig
}

async function cancelDigest (db: Database, a: { authorityId: string, effectiveAt: string, userId: string }): Promise<Uint8Array> {
  const row = await db
    .prepare('select Digest(:cancelTag, :authorityId, :effectiveAtForm, :userId) as d')
    .get({ cancelTag: CANCEL_TAG, authorityId: a.authorityId, effectiveAtForm: a.effectiveAt, userId: a.userId })
  if (row == null || row.d == null) throw new Error('cancelDigest: Digest() returned null')
  return digestToBytes(row.d)
}

/** Sign the cancel digest of (rig authority, effectiveAt, digestUserId) as `officer`. */
async function signAs (rig: Rig, officer: Officer, effectiveAt: string, digestUserId?: string): Promise<string> {
  const digest = await cancelDigest(rig.db, { authorityId: rig.authorityId, effectiveAt, userId: digestUserId ?? officer.userId })
  return officer.sign(digest)
}

interface RawCancel {
  authorityId: string
  effectiveAt: string
  userId: string
  userKey: string | null
  signature: string | null
  now?: string
}

/** The exact insert shape 66.1-06 issues, with every context value under the caller's control. */
function rawCancel (db: Database, a: RawCancel): Promise<unknown> {
  const ctx = ['UserKey = :userKey', 'Signature = :signature']
  const params: SqlParameters = {
    authorityId: a.authorityId,
    effectiveAt: a.effectiveAt,
    userId: a.userId,
    userKey: a.userKey,
    signature: a.signature
  }
  if (a.now !== undefined) {
    ctx.push('now = :now')
    params.now = a.now
  }
  return db.exec(
    `insert into AdminCancellation (AuthorityId, AdminEffectiveAt, UserId) with context ${ctx.join(', ')} values (:authorityId, :effectiveAt, :userId)`,
    params
  )
}

/** A correctly signed cancel by `officer` of `effectiveAt`. */
async function signedCancel (rig: Rig, officer: Officer, effectiveAt: string, now?: string): Promise<unknown> {
  return rawCancel(rig.db, {
    authorityId: rig.authorityId,
    effectiveAt,
    userId: officer.userId,
    userKey: officer.pubKey,
    signature: await signAs(rig, officer, effectiveAt),
    now: now ?? nowCanonicalDatetime()
  })
}

async function expectRefused (p: Promise<unknown>, constraint: string | RegExp): Promise<void> {
  let caught: unknown
  try { await p } catch (err) { caught = err }
  expect(caught, `expected a refusal naming ${String(constraint)}`).to.be.instanceOf(Error)
  const message = (caught as Error).message
  if (typeof constraint === 'string') expect(message).to.include(constraint)
  else expect(message).to.match(constraint)
}

async function cancelledRows (rig: Rig): Promise<number> {
  const row = await rig.db.prepare('select count(*) as n from AdminCancellation').get({})
  return Number(row?.n)
}

async function isCancelled (rig: Rig, effectiveAt: string): Promise<boolean> {
  const row = await rig.db
    .prepare('select 1 as x from AdminCancellation where AuthorityId = :authorityId and AdminEffectiveAt = :effectiveAt')
    .get({ authorityId: rig.authorityId, effectiveAt })
  return row != null
}

/** One minute after TP's effective time (TP is base + 10 min). */
const afterTp = (rig: Rig): string => toCanonicalDatetime(rig.base + 11 * MIN)

const updateSql =
  'update AdminCancellation with context UserKey = :userKey, Signature = :signature, now = :now set UserId = :x where AuthorityId = :a and AdminEffectiveAt = :e'
const deleteSql =
  'delete from AdminCancellation with context UserKey = :userKey, Signature = :signature, now = :now where AuthorityId = :a and AdminEffectiveAt = :e'

// The attacks, each as a function that RUNS the raw insert, so the mutation controls replay the same one.
const attacks = {
  /** R1: a current officer without 'rad' signs a valid cancel of TB. */
  async nonRadOfficer (rig: Rig): Promise<unknown> {
    return signedCancel(rig, rig.nonRad, rig.tb)
  },
  /** R2: a live key of a user who is not an officer. */
  async outsider (rig: Rig): Promise<unknown> {
    return signedCancel(rig, rig.outsider, rig.tb)
  },
  /** R3: UserId names the founder, but the key and signature are radP's over the founder-UserId digest. */
  async otherUsersKey (rig: Rig): Promise<unknown> {
    return rawCancel(rig.db, {
      authorityId: rig.authorityId,
      effectiveAt: rig.tb,
      userId: rig.founder.userId,
      userKey: rig.radP.pubKey,
      signature: await signAs(rig, rig.radP, rig.tb, rig.founder.userId),
      now: nowCanonicalDatetime()
    })
  },
  /** R4: radP cancels TC at now + 2 days, after radP's key has expired. */
  async expiredKey (rig: Rig): Promise<unknown> {
    return signedCancel(rig, rig.radP, rig.tc, toCanonicalDatetime(rig.base + 2 * DAY))
  },
  /** R5: the founder (a rad officer of every generation) cancels G1, which is already in effect. */
  async alreadyEffective (rig: Rig): Promise<unknown> {
    return signedCancel(rig, rig.founder, rig.g1)
  },
  /** R6: a target with no Admin or ProposedAdmin row. */
  async unknownTarget (rig: Rig): Promise<unknown> {
    return signedCancel(rig, rig.radP, toCanonicalDatetime(rig.base + 5 * HOUR))
  },
  /** R7: radP's valid signature for TA, reused on TB. */
  async replay (rig: Rig): Promise<unknown> {
    return rawCancel(rig.db, {
      authorityId: rig.authorityId,
      effectiveAt: rig.tb,
      userId: rig.radP.userId,
      userKey: rig.radP.pubKey,
      signature: await signAs(rig, rig.radP, rig.ta),
      now: nowCanonicalDatetime()
    })
  },
  /** A2-shipped: lateRad, whose only generation TP is cancelled, cancels TD one minute after TP's time. */
  async cancelledGenerationOfficer (rig: Rig): Promise<unknown> {
    return signedCancel(rig, rig.lateRad, rig.td, afterTp(rig))
  }
}

describe('AdminCancellation schema write rule (66.1-04)', function () {
  this.timeout(300_000)

  after(() => {
    setSchemaSql(undefined)
  })

  describe('accept and refuse', () => {
    let rig: Rig
    let rowsBefore: number

    before(async () => {
      rig = await makeRig()
    })

    beforeEach(async () => {
      rowsBefore = await cancelledRows(rig)
    })

    it('S0 starts with no cancellations and CurrentAdmin reads G1', async () => {
      expect(await cancelledRows(rig)).to.equal(0)
      expect(await currentAdmin(rig)).to.equal(rig.g1)
    })

    it('S1 accepts a P-256 cancel by a current rad officer of an unpromoted target', async () => {
      await signedCancel(rig, rig.radP, rig.ta)
      const row = await rig.db
        .prepare('select AuthorityId, AdminEffectiveAt, UserId, typeof(AdminEffectiveAt) as t from AdminCancellation where AuthorityId = :authorityId and AdminEffectiveAt = :effectiveAt')
        .get({ authorityId: rig.authorityId, effectiveAt: rig.ta })
      expect(row).to.not.equal(undefined)
      expect(row!.AuthorityId).to.equal(rig.authorityId)
      expect(row!.AdminEffectiveAt).to.equal(rig.ta)
      expect(typeof row!.AdminEffectiveAt).to.equal('string')
      expect(row!.t).to.equal('text')
      expect(row!.UserId).to.equal(rig.radP.userId)
      expect(await cancelledRows(rig)).to.equal(rowsBefore + 1)
    })

    it('S2 accepts a secp256k1 cancel of a promoted change waiting for its time', async () => {
      expect(await adminRowExists(rig, rig.tp)).to.equal(true)
      await signedCancel(rig, rig.founder, rig.tp)
      expect(await isCancelled(rig, rig.tp)).to.equal(true)
      expect(await cancelledRows(rig)).to.equal(rowsBefore + 1)
      // a cancel of a future generation leaves the current one as it was
      expect(await currentAdmin(rig)).to.equal(rig.g1)
    })

    it('R1 refuses a current officer without rad, naming CancellerIsRadOfficer', async () => {
      await expectRefused(attacks.nonRadOfficer(rig), 'CancellerIsRadOfficer')
      expect(await cancelledRows(rig)).to.equal(rowsBefore)
    })

    it('R2 refuses a user who is not an officer, naming CancellerIsRadOfficer', async () => {
      await expectRefused(attacks.outsider(rig), 'CancellerIsRadOfficer')
      expect(await cancelledRows(rig)).to.equal(rowsBefore)
    })

    it('R3 refuses a key that belongs to another user, naming CancellerIsRadOfficer', async () => {
      await expectRefused(attacks.otherUsersKey(rig), 'CancellerIsRadOfficer')
      expect(await cancelledRows(rig)).to.equal(rowsBefore)
    })

    it('R4 refuses an expired key, naming CancellerIsRadOfficer', async () => {
      await expectRefused(attacks.expiredKey(rig), 'CancellerIsRadOfficer')
      expect(await cancelledRows(rig)).to.equal(rowsBefore)
    })

    it('R5 refuses a cancel of a generation already in effect (G1 and founding), naming TargetPending', async () => {
      await expectRefused(attacks.alreadyEffective(rig), 'TargetPending')
      await expectRefused(signedCancel(rig, rig.founder, rig.foundingEffectiveAt), 'TargetPending')
      expect(await cancelledRows(rig)).to.equal(rowsBefore)
    })

    it('R6 refuses an unknown target, naming TargetPending', async () => {
      await expectRefused(attacks.unknownTarget(rig), 'TargetPending')
      expect(await cancelledRows(rig)).to.equal(rowsBefore)
    })

    it('R7 refuses a signature replayed onto another target, naming CancelSignatureValid', async () => {
      await expectRefused(attacks.replay(rig), 'CancelSignatureValid')
      expect(await cancelledRows(rig)).to.equal(rowsBefore)
    })

    it('R8 refuses a wrong-curve signature, naming CancelSignatureValid', async () => {
      // radP's P-256 key bound, with the founder's secp256k1 signature over the correct TB digest for radP
      const digest = await cancelDigest(rig.db, { authorityId: rig.authorityId, effectiveAt: rig.tb, userId: rig.radP.userId })
      await expectRefused(
        rawCancel(rig.db, {
          authorityId: rig.authorityId,
          effectiveAt: rig.tb,
          userId: rig.radP.userId,
          userKey: rig.radP.pubKey,
          signature: await rig.founder.sign(digest),
          now: nowCanonicalDatetime()
        }),
        'CancelSignatureValid'
      )
      expect(await cancelledRows(rig)).to.equal(rowsBefore)
    })

    it('R9 refuses an unsigned insert', async () => {
      await expectRefused(
        rawCancel(rig.db, {
          authorityId: rig.authorityId,
          effectiveAt: rig.tb,
          userId: rig.radP.userId,
          userKey: null,
          signature: null,
          now: nowCanonicalDatetime()
        }),
        // both legitimately fail: no signature, and no key row matches a null key
        /CancelSignatureValid|CancellerIsRadOfficer/
      )
      expect(await cancelledRows(rig)).to.equal(rowsBefore)
    })

    it('R10 refuses an insert with no now bound', async () => {
      let caught: unknown
      try {
        await rawCancel(rig.db, {
          authorityId: rig.authorityId,
          effectiveAt: rig.tb,
          userId: rig.radP.userId,
          userKey: rig.radP.pubKey,
          signature: await signAs(rig, rig.radP, rig.tb)
        })
      } catch (err) { caught = err }
      expect(caught).to.be.instanceOf(Error)
      expect(await cancelledRows(rig)).to.equal(rowsBefore)
    })

    it('R11 refuses a second cancel of the same generation (primary key)', async () => {
      let caught: unknown
      try { await signedCancel(rig, rig.founder, rig.ta) } catch (err) { caught = err }
      expect(caught).to.be.instanceOf(Error)
      expect(await cancelledRows(rig)).to.equal(rowsBefore)
      const row = await rig.db
        .prepare('select UserId from AdminCancellation where AuthorityId = :authorityId and AdminEffectiveAt = :effectiveAt')
        .get({ authorityId: rig.authorityId, effectiveAt: rig.ta })
      expect(row!.UserId).to.equal(rig.radP.userId)
    })

    it('R12 refuses update and delete of a committed cancellation, naming CantUpdate and CantDelete', async () => {
      const ctxParams = {
        userKey: rig.radP.pubKey,
        signature: await signAs(rig, rig.radP, rig.ta),
        now: nowCanonicalDatetime(),
        a: rig.authorityId,
        e: rig.ta
      }
      await expectRefused(rig.db.exec(updateSql, { ...ctxParams, x: rig.founder.userId }), 'CantUpdate')
      await expectRefused(rig.db.exec(deleteSql, ctxParams), 'CantDelete')
      const row = await rig.db
        .prepare('select UserId from AdminCancellation where AuthorityId = :authorityId and AdminEffectiveAt = :effectiveAt')
        .get({ authorityId: rig.authorityId, effectiveAt: rig.ta })
      expect(row!.UserId).to.equal(rig.radP.userId)
      expect(await cancelledRows(rig)).to.equal(rowsBefore)
    })

    it('A2-shipped refuses an officer whose only generation was cancelled, and accepts a current-generation officer at the same now', async () => {
      // S2 cancelled TP, the only generation that lists lateRad
      expect(await isCancelled(rig, rig.tp)).to.equal(true)
      await expectRefused(attacks.cancelledGenerationOfficer(rig), 'CancellerIsRadOfficer')
      expect(await cancelledRows(rig)).to.equal(rowsBefore)
      // control: the bound-now path works for an officer of the generation that is current (G1)
      await signedCancel(rig, rig.radP, rig.te, afterTp(rig))
      expect(await isCancelled(rig, rig.te)).to.equal(true)
    })

    it('P1 the schema carries the cancellation exclusion five times and the cancel tag in both curve branches', () => {
      const count = (hay: string, needle: string): number => hay.split(needle).length - 1
      expect(count(VOTETORRENT_SCHEMA_SQL, CANCEL_EXCLUSION)).to.equal(5)

      const start = VOTETORRENT_SCHEMA_SQL.indexOf('table AdminCancellation (')
      const end = VOTETORRENT_SCHEMA_SQL.indexOf('with context ( UserKey text null', start)
      expect(start).to.be.greaterThan(-1)
      expect(end).to.be.greaterThan(start)
      const block = VOTETORRENT_SCHEMA_SQL.slice(start, end)
      expect(count(block, `'${CANCEL_TAG}'`)).to.equal(2)

      const viewStart = VOTETORRENT_SCHEMA_SQL.indexOf('view CurrentAdmin as')
      const viewBody = VOTETORRENT_SCHEMA_SQL.slice(viewStart, VOTETORRENT_SCHEMA_SQL.indexOf(';', viewStart))
      expect(viewBody).to.include('AdminCancellation')
    })
  })

  describe('each CHECK is load-bearing', () => {
    const BLOCK_START = 'table AdminCancellation ('
    const BLOCK_END = 'with context ( UserKey text null'

    /** Replace `needle` EXACTLY ONCE inside the table's block. */
    function disableInTable (sql: string, needle: string, replacement: string): string {
      const start = sql.indexOf(BLOCK_START)
      expect(start, 'table block present').to.be.greaterThan(-1)
      const end = sql.indexOf(BLOCK_END, start)
      expect(end, 'table block end present').to.be.greaterThan(start)
      const block = sql.slice(start, end)
      const count = block.split(needle).length - 1
      if (count !== 1) throw new Error(`disableInTable: needle occurs ${count} times in the block: ${needle}`)
      return sql.slice(0, start) + block.replace(needle, replacement) + sql.slice(end)
    }

    /** Index of the `)` matching the `(` at `open`, ignoring parentheses inside '...' literals. */
    function matchingParen (sql: string, open: number): number {
      let depth = 0
      let inString = false
      for (let i = open; i < sql.length; i++) {
        const ch = sql[i]
        if (inString) {
          if (ch === "'") inString = false
          continue
        }
        if (ch === "'") inString = true
        else if (ch === '(') depth += 1
        else if (ch === ')') {
          depth -= 1
          if (depth === 0) return i
        }
      }
      throw new Error('disableCheck: unbalanced parentheses')
    }

    /** Replace the body of `constraint <name> check [on verb]` in the table's block with `(true)`. */
    function disableCheck (sql: string, name: string): string {
      const start = sql.indexOf(BLOCK_START)
      const end = sql.indexOf(BLOCK_END, start)
      const block = sql.slice(start, end)
      const m = new RegExp(`constraint ${name} check(?: on (?:insert|update|delete))?\\s*`).exec(block)
      if (m === null) throw new Error(`disableCheck: no constraint ${name} in the block`)
      const open = block.indexOf('(', m.index + m[0].length - 1)
      const close = matchingParen(block, open)
      const mutatedBlock = block.slice(0, open) + '(true)' + block.slice(close + 1)
      return sql.slice(0, start) + mutatedBlock + sql.slice(end)
    }

    /** Run `body` against a FRESH network built on the mutated schema; the override is always reset. */
    async function withMutation (mutated: string, body: (r: Rig) => Promise<void>): Promise<void> {
      expect(mutated).to.not.equal(VOTETORRENT_SCHEMA_SQL)
      setSchemaSql(mutated)
      try {
        const r = await makeRig()
        await body(r)
      } finally {
        setSchemaSql(undefined)
      }
    }

    it('M1 disabling CancelSignatureValid lets the replayed signature through', async () => {
      await withMutation(disableCheck(VOTETORRENT_SCHEMA_SQL, 'CancelSignatureValid'), async (r) => {
        await attacks.replay(r)
        expect(await isCancelled(r, r.tb)).to.equal(true)
      })
    })

    it('M2 disabling TargetPending lets the unknown target through', async () => {
      await withMutation(disableCheck(VOTETORRENT_SCHEMA_SQL, 'TargetPending'), async (r) => {
        await attacks.unknownTarget(r)
        expect(await cancelledRows(r)).to.equal(1)
      })
    })

    it('M3 removing the not-yet-effective leg lets the cancel of G1 through', async () => {
      const mutated = disableInTable(VOTETORRENT_SCHEMA_SQL, 'new.AdminEffectiveAt > context.now', 'true')
      await withMutation(mutated, async (r) => {
        await attacks.alreadyEffective(r)
        expect(await isCancelled(r, r.g1)).to.equal(true)
      })
    })

    it('M4 disabling CancellerIsRadOfficer lets the outsider through', async () => {
      await withMutation(disableCheck(VOTETORRENT_SCHEMA_SQL, 'CancellerIsRadOfficer'), async (r) => {
        await attacks.outsider(r)
        expect(await isCancelled(r, r.tb)).to.equal(true)
      })
    })

    it('M5 removing the rad-scope leg lets the non-rad officer through', async () => {
      const mutated = disableInTable(VOTETORRENT_SCHEMA_SQL, "and exists (select 1 from json_each(O.Scopes) where value = 'rad')", '')
      await withMutation(mutated, async (r) => {
        await attacks.nonRadOfficer(r)
        expect(await isCancelled(r, r.tb)).to.equal(true)
      })
    })

    it('M6 removing the key-expiration leg lets the expired key through', async () => {
      const mutated = disableInTable(VOTETORRENT_SCHEMA_SQL, ' and K.Expiration > context.now', '')
      await withMutation(mutated, async (r) => {
        await attacks.expiredKey(r)
        expect(await isCancelled(r, r.tc)).to.equal(true)
      })
    })

    it('M7 removing the same-user leg lets another user\'s key through', async () => {
      const mutated = disableInTable(VOTETORRENT_SCHEMA_SQL, 'K.UserId = new.UserId and ', '')
      await withMutation(mutated, async (r) => {
        await attacks.otherUsersKey(r)
        expect(await isCancelled(r, r.tb)).to.equal(true)
      })
    })

    it('M8 removing the cancellation exclusion lets an officer of a cancelled generation through', async () => {
      const mutated = disableInTable(VOTETORRENT_SCHEMA_SQL, ` ${CANCEL_EXCLUSION}`, '')
      await withMutation(mutated, async (r) => {
        await signedCancel(r, r.founder, r.tp)
        await attacks.cancelledGenerationOfficer(r)
        expect(await isCancelled(r, r.td)).to.equal(true)
      })
    })

    it('M9 disabling CantUpdate lets the update through', async () => {
      await withMutation(disableCheck(VOTETORRENT_SCHEMA_SQL, 'CantUpdate'), async (r) => {
        await signedCancel(r, r.radP, r.ta)
        await r.db.exec(updateSql, {
          userKey: r.radP.pubKey,
          signature: await signAs(r, r.radP, r.ta),
          now: nowCanonicalDatetime(),
          a: r.authorityId,
          e: r.ta,
          x: r.founder.userId
        })
        const row = await r.db
          .prepare('select UserId from AdminCancellation where AuthorityId = :authorityId and AdminEffectiveAt = :effectiveAt')
          .get({ authorityId: r.authorityId, effectiveAt: r.ta })
        expect(row!.UserId).to.equal(r.founder.userId)
      })
    })

    it('M10 disabling CantDelete lets the delete through', async () => {
      await withMutation(disableCheck(VOTETORRENT_SCHEMA_SQL, 'CantDelete'), async (r) => {
        await signedCancel(r, r.radP, r.ta)
        await r.db.exec(deleteSql, {
          userKey: r.radP.pubKey,
          signature: await signAs(r, r.radP, r.ta),
          now: nowCanonicalDatetime(),
          a: r.authorityId,
          e: r.ta
        })
        expect(await isCancelled(r, r.ta)).to.equal(false)
      })
    })
  })
})
