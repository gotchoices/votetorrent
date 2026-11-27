/**
 * admin-cancellation-assumptions.spec.ts — 66.1-01 Task 1.
 *
 * PERMANENT, VERDICT-RECORDING PROBE. Do not delete it or reduce it to a throwaway: it stays as a regression
 * guard for the Quereus behaviour the AdminCancellation design (contracts C4/C5) rests on. Same discipline as
 * keyholder-schema-probes.spec.ts: each hypothesis was run first, then the observed behaviour was pinned here.
 * Every candidate schema exists only in memory (setSchemaSql); votetorrent.qsql and schema-sql.ts are never
 * edited. The table literal below is deliberately independent of the real schema, so drift between this probe
 * and the shipped table stays visible.
 *
 * Measured 2026-11-05 on the installed Quereus (@quereus/quereus 4.26.0), every hypothesis held as written:
 * A1 VERDICT: PASS — a `text` AdminEffectiveAt binds and reads back as the 19-char canonical string (typeof text) and
 *   matches the `datetime` Admin/ProposedAdmin.EffectiveAt: A1a/A1b accepted (Admin and ProposedAdmin-only targets),
 *   A1c (no such row) and A1d (founding, already effective) refused naming TargetPending, A1e bound-:now selector skips
 *   the cancelled G and returns G in the uncancelled rig, A1f CurrentAdmin after a real wait shows founding in X and T in
 *   control rig Y. A1-dt: a `datetime` column also stores the canonical string (typeof text, 19 chars); only the canonical
 *   19-char digest pre-image verifies, canonical+Z and canonical+.000Z are refused.
 * A2 VERDICT: PASS — the self-referencing exclusion inside CancellerIsRadOfficer accepts a valid cancel (A2a, A2c) and
 *   refuses U2 whose only generation G2 was cancelled (A2b, names CancellerIsRadOfficer); the same scenario with
 *   `selfReference: false` ACCEPTS U2 (A2-control), so the self-reference is what refuses.
 * ORDER VERDICT: PASS — both `beforeView` and `end` apply, found a network, read CurrentAdmin = founding and accept one
 *   signed cancel; control: the same instrument refuses (at network founding, eager DDL) a view naming an absent table.
 * A3 VERDICT: see 66.1-01-SUMMARY.md (strand re-attach, measured outside this file)
 *
 * Not exercised here: the three edited inline CHECK sites (RegistrationDecision, AssociationDecision, ElectionTally)
 * compile as part of the applied schema, but no row is inserted into those tables by this file.
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

const DAY = 86_400_000

// ═══════════════════════════════════════════════════════════════════════════
// Candidate literals (contracts C4 / C5)
// ═══════════════════════════════════════════════════════════════════════════

const CANCEL_DIGEST_TAG = 'vt-admin-cancel'

/** C5: the exact exclusion text, one literal. */
const CANCEL_EXCLUSION =
  'and not exists (select 1 from AdminCancellation C where C.AuthorityId = A.AuthorityId and C.AdminEffectiveAt = A.EffectiveAt)'

/** The inline current-generation selector at the three CHECK sites (C5 sites 2-4). */
const OLD_CHECK_SELECTOR =
  'select max(A.EffectiveAt) from Admin A where A.AuthorityId = O.AuthorityId and A.EffectiveAt <= context.now'

/** C5 site 1. */
const CANDIDATE_CURRENT_ADMIN_VIEW =
  `view CurrentAdmin as select A.AuthorityId, max(A.EffectiveAt) as EffectiveAt from Admin A where A.EffectiveAt <= datetime('now') ${CANCEL_EXCLUSION} group by A.AuthorityId;`

type ColumnType = 'text' | 'datetime'
type Position = 'beforeView' | 'end'

interface TableOpts { column: ColumnType, selfReference: boolean }
interface CandidateOpts extends TableOpts { position: Position, editChecks: boolean }

/** C4 candidate table. Tab-indented like the schema. */
function adminCancellationTable (opts: TableOpts): string {
  const exclusion = opts.selfReference ? ` ${CANCEL_EXCLUSION}` : ''
  const digest = `Digest('${CANCEL_DIGEST_TAG}', new.AuthorityId, new.AdminEffectiveAt, new.UserId)`
  return `	table AdminCancellation (
		AuthorityId text,
		AdminEffectiveAt ${opts.column},
		UserId text,
		primary key (AuthorityId, AdminEffectiveAt),
		constraint CancelSignatureValid check on insert (
			(
				coalesce((select K.Type from UserKey K where K.PubKey = context.UserKey), 'M') = 'P'
				and SignatureValidP256(
					${digest},
					context.Signature,
					context.UserKey
				)
			)
			or (
				coalesce((select K.Type from UserKey K where K.PubKey = context.UserKey), 'M') <> 'P'
				and SignatureValid(
					${digest},
					context.Signature,
					context.UserKey
				)
			)
		),
		constraint TargetPending check on insert (
			new.AdminEffectiveAt > context.now
				and (
					exists (select 1 from Admin A where A.AuthorityId = new.AuthorityId and A.EffectiveAt = new.AdminEffectiveAt)
					or exists (select 1 from ProposedAdmin P where P.AuthorityId = new.AuthorityId and P.EffectiveAt = new.AdminEffectiveAt)
				)
		),
		constraint CancellerIsRadOfficer check on insert (
			exists (
				select 1 from UserKey K join Officer O on O.UserId = K.UserId and O.AuthorityId = new.AuthorityId
					where K.UserId = new.UserId and K.PubKey = context.UserKey and K.Expiration > context.now
						and O.AdminEffectiveAt = (
							select max(A.EffectiveAt) from Admin A where A.AuthorityId = O.AuthorityId and A.EffectiveAt <= context.now${exclusion}
						)
						and exists (select 1 from json_each(O.Scopes) where value = 'rad')
			)
		),
		constraint CantUpdate check on update (false),
		constraint CantDelete check on delete (false)
	)
		with context ( UserKey text null, Signature text null, now datetime );

`
}

const SHIPPED_TABLE_START = '\ttable AdminCancellation ('
const SHIPPED_TABLE_END = 'now datetime );'

/** Removes a shipped AdminCancellation block (after 66.1-04 lands) so the candidate can be spliced in. */
function stripShippedAdminCancellation (base: string): string {
  const start = base.indexOf(SHIPPED_TABLE_START)
  if (start === -1) return base
  const end = base.indexOf(SHIPPED_TABLE_END, start)
  if (end === -1) {
    throw new Error('stripShippedAdminCancellation: found the shipped table start but no following "now datetime );" end')
  }
  let stop = end + SHIPPED_TABLE_END.length
  if (base[stop] === '\n') stop += 1
  return base.slice(0, start) + base.slice(stop)
}

const VIEW_ANCHOR = 'view CurrentAdmin as'
const END_ANCHOR = '\tindex VoteBlockVoterBlock on VoteBlockVoter'
const ALREADY_EDITED = /^\s*and not exists \(select 1 from AdminCancellation/

function countOf (haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function buildCandidate (base: string, opts: CandidateOpts): string {
  // 1. strip a shipped block
  let out = stripShippedAdminCancellation(base)

  // 2. replace the CurrentAdmin view
  const viewCount = countOf(out, VIEW_ANCHOR)
  if (viewCount !== 1) {
    throw new Error(`buildCandidate: anchor '${VIEW_ANCHOR}' must occur exactly once, found ${viewCount}`)
  }
  const viewStart = out.indexOf(VIEW_ANCHOR)
  const viewEnd = out.indexOf(';', viewStart)
  if (viewEnd === -1) throw new Error(`buildCandidate: no ';' after '${VIEW_ANCHOR}'`)
  out = out.slice(0, viewStart) + CANDIDATE_CURRENT_ADMIN_VIEW + out.slice(viewEnd + 1)

  // 3. the three inline CHECK selectors
  const selectorCount = countOf(out, OLD_CHECK_SELECTOR)
  if (selectorCount !== 3) {
    throw new Error(`buildCandidate: the inline selector must occur exactly 3 times, found ${selectorCount}`)
  }
  if (opts.editChecks) {
    const parts = out.split(OLD_CHECK_SELECTOR)
    out = parts[0]!
    for (let i = 1; i < parts.length; i++) {
      const rest = parts[i]!
      out += OLD_CHECK_SELECTOR + (ALREADY_EDITED.test(rest) ? '' : ` ${CANCEL_EXCLUSION}`) + rest
    }
  }

  // 4. insert the table
  const table = adminCancellationTable(opts)
  if (opts.position === 'beforeView') {
    const anchor = `\t${VIEW_ANCHOR}`
    const n = countOf(out, anchor)
    if (n !== 1) throw new Error(`buildCandidate: anchor '\\t${VIEW_ANCHOR}' must occur exactly once, found ${n}`)
    out = out.replace(anchor, `${table}${anchor}`)
  } else {
    const n = countOf(out, END_ANCHOR)
    if (n !== 1) throw new Error(`buildCandidate: anchor '${END_ANCHOR.trim()}' must occur exactly once, found ${n}`)
    out = out.replace(END_ANCHOR, `${table}${END_ANCHOR}`)
  }

  // 5. must differ
  if (out === base) throw new Error('buildCandidate: candidate equals the base schema')
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// Rig helpers (private copies)
// ═══════════════════════════════════════════════════════════════════════════

interface Signer { userId: string, pubKey: string, sign: (digest: Uint8Array) => Promise<string> }

interface CancelRig {
  auth: TestAuthorityContext
  db: Database
  authorityId: string
  founder: Signer & { signCallback: (digest: Uint8Array) => Promise<Signature> }
  u2: Signer
  foundingEffectiveAt: string
}

/** Insert a second user with a first key (copy of the dashboard spec's `insertFixtureUser`). */
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

async function makeCancelRig (): Promise<CancelRig> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const p = makeP256TestKey()
  const user = makeDistinctTestUser()
  user.activeKeys = [{ key: p.pubHex, type: 'P' as UserKeyType, expiration: Date.now() + DAY }]
  await insertFixtureUser(auth, user)
  const founderCallback = makeTestSignCallback(net.user)
  const row = await auth.ctx.db
    .prepare('select min(EffectiveAt) as e from Admin where AuthorityId = :authorityId')
    .get({ authorityId: auth.authority.id })
  return {
    auth,
    db: auth.ctx.db,
    authorityId: auth.authority.id,
    founder: {
      userId: net.user.id,
      pubKey: net.user.activeKeys[0]!.key,
      signCallback: founderCallback,
      sign: async (digest) => (await founderCallback(digest)).signature
    },
    u2: {
      userId: user.id,
      pubKey: p.pubHex,
      sign: async (digest) => bytesToHex(p256.sign(digest, p.privBytes))
    },
    foundingEffectiveAt: row!.e as string
  }
}

type OfficerSel = AdminInit['officers'][number]

function existingOfficer (rig: CancelRig, userId: string, scopes: string[]): OfficerSel {
  return { existing: { userId, authorityId: rig.authorityId, title: 'Officer', scopes: scopes as Scope[] } } as OfficerSel
}

function initOfficer (name: string, scopes: string[]): OfficerSel {
  return { init: { name, title: 'Clerk', scopes: scopes as Scope[] } } as OfficerSel
}

/** Propose a generation at `effectiveAtMs` signed by the founder; returns its canonical EffectiveAt. */
async function proposeAt (rig: CancelRig, effectiveAtMs: number, officers: OfficerSel[]): Promise<string> {
  const proposal: Proposal<AdminInit> = {
    proposed: {
      officers,
      effectiveAt: effectiveAtMs,
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
    },
    signers: [rig.founder.userId]
  }
  await rig.auth.authorityEngine.proposeAdmin(proposal, rig.founder.signCallback)
  return toCanonicalDatetime(effectiveAtMs)
}

async function adminRowExists (rig: CancelRig, effectiveAt: string): Promise<boolean> {
  const row = await rig.db
    .prepare('select 1 as hit from Admin where AuthorityId = :authorityId and EffectiveAt = :effectiveAt')
    .get({ authorityId: rig.authorityId, effectiveAt })
  return row != null
}

async function proposedAdminRowExists (rig: CancelRig, effectiveAt: string): Promise<boolean> {
  const row = await rig.db
    .prepare('select 1 as hit from ProposedAdmin where AuthorityId = :authorityId and EffectiveAt = :effectiveAt')
    .get({ authorityId: rig.authorityId, effectiveAt })
  return row != null
}

async function cancelDigest (db: Database, a: { authorityId: string, effectiveAt: string, userId: string }): Promise<Uint8Array> {
  const row = await db
    .prepare('select Digest(:cancelTag, :authorityId, :effectiveAt, :userId) as d')
    .get({ cancelTag: CANCEL_DIGEST_TAG, authorityId: a.authorityId, effectiveAt: a.effectiveAt, userId: a.userId })
  if (row == null || row.d == null) throw new Error('cancelDigest: Digest() returned null')
  return digestToBytes(row.d)
}

interface RawCancel { authorityId: string, effectiveAt: string, userId: string, userKey: string | null, signature: string | null, now: string }

function rawCancel (db: Database, a: RawCancel): Promise<unknown> {
  const params: SqlParameters = {
    authorityId: a.authorityId,
    effectiveAt: a.effectiveAt,
    userId: a.userId,
    userKey: a.userKey,
    signature: a.signature,
    now: a.now
  }
  return db.exec(
    'insert into AdminCancellation (AuthorityId, AdminEffectiveAt, UserId) with context UserKey = :userKey, Signature = :signature, now = :now values (:authorityId, :effectiveAt, :userId)',
    params
  )
}

/**
 * A signed cancel by `who` of `effectiveAt`. The digest pre-image uses `digestForm` (default: the bound value),
 * while the row binds `effectiveAt`.
 */
async function signedCancel (rig: CancelRig, who: Signer, effectiveAt: string, now: string, digestForm?: string): Promise<unknown> {
  const digest = await cancelDigest(rig.db, { authorityId: rig.authorityId, effectiveAt: digestForm ?? effectiveAt, userId: who.userId })
  return rawCancel(rig.db, {
    authorityId: rig.authorityId,
    effectiveAt,
    userId: who.userId,
    userKey: who.pubKey,
    signature: await who.sign(digest),
    now
  })
}

async function expectRefused (p: Promise<unknown>, constraint: string): Promise<string> {
  let caught: unknown
  try { await p } catch (err) { caught = err }
  expect(caught, `expected a refusal naming ${constraint}`).to.be.instanceOf(Error)
  const message = (caught as Error).message
  expect(message).to.include(constraint)
  return message
}

async function outcome (p: Promise<unknown>): Promise<{ ok: boolean, message?: string }> {
  try {
    await p
    return { ok: true }
  } catch (err) {
    return { ok: false, message: (err as Error).message.slice(0, 200) }
  }
}

async function cancelCount (rig: CancelRig): Promise<number> {
  const row = await rig.db
    .prepare('select count(*) as n from AdminCancellation where AuthorityId = :authorityId')
    .get({ authorityId: rig.authorityId })
  return Number(row?.n)
}

async function currentAdmin (rig: CancelRig): Promise<unknown> {
  const row = await rig.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId: rig.authorityId })
  return row?.EffectiveAt
}

/** The inline selector form of the CHECK sites, as a bound SELECT. */
async function inlineCurrentAt (rig: CancelRig, now: string): Promise<unknown> {
  const row = await rig.db
    .prepare(`select max(A.EffectiveAt) as e from Admin A where A.AuthorityId = :authorityId and A.EffectiveAt <= :now ${CANCEL_EXCLUSION}`)
    .get({ authorityId: rig.authorityId, now })
  return row?.e
}

async function withCandidate<T> (sql: string, body: () => Promise<T>): Promise<T> {
  expect(sql).to.not.equal(VOTETORRENT_SCHEMA_SQL)
  setSchemaSql(sql)
  try {
    return await body()
  } finally {
    setSchemaSql(undefined)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ═══════════════════════════════════════════════════════════════════════════
// Verdict collection
// ═══════════════════════════════════════════════════════════════════════════

const verdicts: Record<string, Record<string, unknown>> = { A1: {}, A1dt: {}, A2: {}, ORDER: {} }

after(() => {
  setSchemaSql(undefined)
})

describe('admin-cancellation assumptions (66.1-01)', function () {
  this.timeout(180_000)

  after(() => {
    console.log('ADMIN-CANCELLATION-ASSUMPTION-VERDICTS ' + JSON.stringify(verdicts))
  })

  describe('A1 text AdminEffectiveAt vs datetime Admin.EffectiveAt', function () {
    const candidate = buildCandidate(VOTETORRENT_SCHEMA_SQL, { column: 'text', selfReference: true, position: 'beforeView', editChecks: true })

    it('A1a accepts a founder cancel of a promoted future generation; AdminEffectiveAt reads back as the canonical string', async () => {
      await withCandidate(candidate, async () => {
        const rig = await makeCancelRig()
        const g = await proposeAt(rig, Date.now() + 60_000, [existingOfficer(rig, rig.founder.userId, ['rad'])])
        expect(await adminRowExists(rig, g), 'G promoted into Admin').to.equal(true)
        await signedCancel(rig, rig.founder, g, nowCanonicalDatetime())
        const row = await rig.db
          .prepare('select AdminEffectiveAt as e, typeof(AdminEffectiveAt) as t from AdminCancellation where AuthorityId = :authorityId')
          .get({ authorityId: rig.authorityId })
        verdicts.A1!.readBackJsType = typeof row?.e
        verdicts.A1!.readBackSqlType = row?.t
        verdicts.A1!.readBackLength = String(row?.e).length
        verdicts.A1!.readBackEqualsCanonical = row?.e === g
        expect(row?.e).to.equal(g)
        verdicts.A1!.a = 'accepted'
      })
    })

    it('A1b accepts a founder cancel of a ProposedAdmin-only generation (`=` against ProposedAdmin.EffectiveAt)', async () => {
      await withCandidate(candidate, async () => {
        const rig = await makeCancelRig()
        const g = await proposeAt(rig, Date.now() + 60_000, [
          existingOfficer(rig, rig.founder.userId, ['rad']),
          initOfficer('Nobody Nowhere', ['vrg'])
        ])
        expect(await adminRowExists(rig, g), 'G is NOT promoted').to.equal(false)
        expect(await proposedAdminRowExists(rig, g), 'G is a ProposedAdmin row').to.equal(true)
        await signedCancel(rig, rig.founder, g, nowCanonicalDatetime())
        expect(await cancelCount(rig)).to.equal(1)
        verdicts.A1!.b = 'accepted'
      })
    })

    it('A1c refuses a cancel of an effectiveAt with no Admin/ProposedAdmin row, naming TargetPending', async () => {
      await withCandidate(candidate, async () => {
        const rig = await makeCancelRig()
        await proposeAt(rig, Date.now() + 60_000, [existingOfficer(rig, rig.founder.userId, ['rad'])])
        const nowhere = toCanonicalDatetime(Date.now() + 90_000)
        await expectRefused(signedCancel(rig, rig.founder, nowhere, nowCanonicalDatetime()), 'TargetPending')
        expect(await cancelCount(rig)).to.equal(0)
        verdicts.A1!.c = 'refused:TargetPending'
      })
    })

    it('A1d refuses a cancel of the founding (already effective) generation, naming TargetPending', async () => {
      await withCandidate(candidate, async () => {
        const rig = await makeCancelRig()
        await expectRefused(signedCancel(rig, rig.founder, rig.foundingEffectiveAt, nowCanonicalDatetime()), 'TargetPending')
        expect(await cancelCount(rig)).to.equal(0)
        verdicts.A1!.d = 'refused:TargetPending'
      })
    })

    it('A1e the inline selector with the exclusion skips a cancelled generation; an uncancelled one is current', async () => {
      await withCandidate(candidate, async () => {
        const gMs = Date.now() + 60_000
        const later = toCanonicalDatetime(gMs + 10_000)

        const x = await makeCancelRig()
        const gx = await proposeAt(x, gMs, [existingOfficer(x, x.founder.userId, ['rad'])])
        await signedCancel(x, x.founder, gx, nowCanonicalDatetime())
        const xCurrent = await inlineCurrentAt(x, later)

        const y = await makeCancelRig()
        const gy = await proposeAt(y, gMs, [existingOfficer(y, y.founder.userId, ['rad'])])
        const yCurrent = await inlineCurrentAt(y, later)

        verdicts.A1!.e = { cancelledReturnsFounding: xCurrent === x.foundingEffectiveAt, uncancelledReturnsG: yCurrent === gy }
        expect(xCurrent).to.equal(x.foundingEffectiveAt)
        expect(yCurrent).to.equal(gy)
      })
    })

    it('A1f after a real wait, CurrentAdmin skips a cancelled generation (X) and shows an uncancelled one (Y)', async function () {
      this.timeout(60_000)
      await withCandidate(candidate, async () => {
        const x = await makeCancelRig()
        const y = await makeCancelRig()

        const tx = Date.now() + 8_000
        const gx = await proposeAt(x, tx, [existingOfficer(x, x.founder.userId, ['rad'])])
        await signedCancel(x, x.founder, gx, nowCanonicalDatetime())
        const cancelDoneAt = Date.now()
        expect(cancelDoneAt, 'the cancel finished before T (a slow host fails here, not silently)').to.be.lessThan(tx - 1_000)

        const ty = Date.now() + 8_000
        const gy = await proposeAt(y, ty, [existingOfficer(y, y.founder.userId, ['rad'])])

        const waitUntil = Math.max(tx, ty) + 1_500
        await sleep(Math.max(0, waitUntil - Date.now()))

        const xCurrent = await currentAdmin(x)
        const yCurrent = await currentAdmin(y)
        verdicts.A1!.f = { cancelledViewReturnsFounding: xCurrent === x.foundingEffectiveAt, uncancelledViewReturnsT: yCurrent === gy }
        expect(xCurrent, 'X: the cancelled generation is never current').to.equal(x.foundingEffectiveAt)
        expect(yCurrent, 'Y control: the uncancelled generation became current, so the wait was long enough').to.equal(gy)
      })
    })
  })

  describe('A1-dt datetime AdminEffectiveAt (informational for 66.1-04)', function () {
    const candidate = buildCandidate(VOTETORRENT_SCHEMA_SQL, { column: 'datetime', selfReference: true, position: 'beforeView', editChecks: true })

    it('A1-dt records which digest pre-image verifies when AdminEffectiveAt is a datetime bound as the canonical string', async () => {
      await withCandidate(candidate, async () => {
        const forms: Record<string, { ok: boolean, message?: string }> = {}
        for (const [label, suffix] of [['canonical', ''], ['canonicalZ', 'Z'], ['canonicalMsZ', '.000Z']] as const) {
          const rig = await makeCancelRig()
          const g = await proposeAt(rig, Date.now() + 60_000, [existingOfficer(rig, rig.founder.userId, ['rad'])])
          forms[label] = await outcome(signedCancel(rig, rig.founder, g, nowCanonicalDatetime(), g + suffix))
          if (forms[label]!.ok) {
            const row = await rig.db
              .prepare('select AdminEffectiveAt as e, typeof(AdminEffectiveAt) as t from AdminCancellation where AuthorityId = :authorityId')
              .get({ authorityId: rig.authorityId })
            verdicts.A1dt!.readBack = { jsType: typeof row?.e, sqlType: row?.t, length: String(row?.e).length, equalsCanonical: row?.e === g }
          }
        }
        verdicts.A1dt!.digestForms = Object.fromEntries(Object.entries(forms).map(([k, v]) => [k, v.ok ? 'accepted' : 'refused']))
        // Pinned observation: only the canonical 19-char string verifies; the Z / .000Z pre-images are refused.
        expect(forms.canonical!.ok, 'the canonical 19-char form verifies').to.equal(true)
        expect(forms.canonicalZ!.ok, 'canonical + Z does not verify').to.equal(false)
        expect(forms.canonicalMsZ!.ok, 'canonical + .000Z does not verify').to.equal(false)
        expect(verdicts.A1dt!.readBack).to.deep.equal({ jsType: 'string', sqlType: 'text', length: 19, equalsCanonical: true })
      })
    })

    it('A1-dt c/d: unknown target and effective target are refused naming TargetPending', async () => {
      await withCandidate(candidate, async () => {
        const rig = await makeCancelRig()
        await proposeAt(rig, Date.now() + 60_000, [existingOfficer(rig, rig.founder.userId, ['rad'])])
        await expectRefused(signedCancel(rig, rig.founder, toCanonicalDatetime(Date.now() + 90_000), nowCanonicalDatetime()), 'TargetPending')
        await expectRefused(signedCancel(rig, rig.founder, rig.foundingEffectiveAt, nowCanonicalDatetime()), 'TargetPending')
        verdicts.A1dt!.cd = 'refused:TargetPending'
      })
    })
  })

  describe('A2 self-referencing exclusion inside CancellerIsRadOfficer', function () {
    interface A2World { rig: CancelRig, g2: string, g3: string, nowAfterG2: string }

    async function a2World (): Promise<A2World> {
      const rig = await makeCancelRig()
      const base = Date.now()
      const g2Ms = base + 60_000
      const g2 = await proposeAt(rig, g2Ms, [
        existingOfficer(rig, rig.founder.userId, ['rad']),
        existingOfficer(rig, rig.u2.userId, ['rad'])
      ])
      expect(await adminRowExists(rig, g2), 'G2 promoted').to.equal(true)
      // A2a: the founder cancels G2 at the real now.
      await signedCancel(rig, rig.founder, g2, nowCanonicalDatetime())
      const g3 = await proposeAt(rig, base + 120_000, [existingOfficer(rig, rig.founder.userId, ['rad'])])
      expect(await adminRowExists(rig, g3), 'G3 promoted').to.equal(true)
      return { rig, g2, g3, nowAfterG2: toCanonicalDatetime(g2Ms + 10_000) }
    }

    it('A2a/A2b/A2c with the self-reference: valid cancel accepted, U2 (only in cancelled G2) refused, founder accepted', async () => {
      const candidate = buildCandidate(VOTETORRENT_SCHEMA_SQL, { column: 'text', selfReference: true, position: 'beforeView', editChecks: true })
      await withCandidate(candidate, async () => {
        const w = await a2World()
        verdicts.A2!.a = 'accepted'
        await expectRefused(signedCancel(w.rig, w.rig.u2, w.g3, w.nowAfterG2), 'CancellerIsRadOfficer')
        verdicts.A2!.b = 'refused:CancellerIsRadOfficer'
        await signedCancel(w.rig, w.rig.founder, w.g3, w.nowAfterG2)
        expect(await cancelCount(w.rig)).to.equal(2)
        verdicts.A2!.c = 'accepted'
      })
    })

    it('A2-control with selfReference: false, U2 cancel of G3 is ACCEPTED (the self-reference is what refuses it)', async () => {
      const candidate = buildCandidate(VOTETORRENT_SCHEMA_SQL, { column: 'text', selfReference: false, position: 'beforeView', editChecks: true })
      await withCandidate(candidate, async () => {
        const w = await a2World()
        await signedCancel(w.rig, w.rig.u2, w.g3, w.nowAfterG2)
        expect(await cancelCount(w.rig)).to.equal(2)
        verdicts.A2!.control = 'accepted'
      })
    })
  })

  describe('ORDER declaration position', function () {
    for (const position of ['beforeView', 'end'] as const) {
      it(`ORDER ${position}: schema applies, network founds, CurrentAdmin reads, one signed cancel is accepted`, async () => {
        const candidate = buildCandidate(VOTETORRENT_SCHEMA_SQL, { column: 'text', selfReference: true, position, editChecks: true })
        await withCandidate(candidate, async () => {
          const rig = await makeCancelRig()
          expect(await cancelCount(rig)).to.equal(0)
          expect(await currentAdmin(rig)).to.equal(rig.foundingEffectiveAt)
          const g = await proposeAt(rig, Date.now() + 60_000, [existingOfficer(rig, rig.founder.userId, ['rad'])])
          await signedCancel(rig, rig.founder, g, nowCanonicalDatetime())
          expect(await cancelCount(rig)).to.equal(1)
          verdicts.ORDER![position] = 'works'
        })
      })
    }

    it('ORDER control: a view naming an undeclared table is caught by the same instrument', async () => {
      const good = buildCandidate(VOTETORRENT_SCHEMA_SQL, { column: 'text', selfReference: true, position: 'end', editChecks: true })
      const broken = good.replace(CANDIDATE_CURRENT_ADMIN_VIEW, CANDIDATE_CURRENT_ADMIN_VIEW.replace('from AdminCancellation C', 'from AdminCancellationAbsent C'))
      expect(broken).to.not.equal(good)
      await withCandidate(broken, async () => {
        let stage = 'none'
        let message = ''
        try {
          stage = 'found'
          const rig = await makeCancelRig()
          stage = 'currentAdmin'
          await currentAdmin(rig)
          stage = 'passed'
        } catch (err) {
          message = (err as Error).message.slice(0, 200)
        }
        // Measured: the DDL is resolved eagerly, so network founding itself fails ('found').
        verdicts.ORDER!.control = { failedAt: stage, refused: message.length > 0 }
        expect(stage, 'the instrument must see a view that cannot resolve').to.not.equal('passed')
      })
    })
  })

  describe('candidate builder guards', function () {
    it('strips a shipped AdminCancellation block and refuses a missing anchor', () => {
      const shipped = buildCandidate(VOTETORRENT_SCHEMA_SQL, { column: 'text', selfReference: true, position: 'end', editChecks: true })
      // A schema that already ships the table rebuilds to exactly one table and three edited CHECK sites.
      const rebuilt = buildCandidate(shipped, { column: 'text', selfReference: true, position: 'beforeView', editChecks: true })
      expect(countOf(rebuilt, SHIPPED_TABLE_START)).to.equal(1)
      // three CHECK sites + the candidate table's own CancellerIsRadOfficer = 4; never doubled
      expect(countOf(rebuilt, `${OLD_CHECK_SELECTOR} ${CANCEL_EXCLUSION}`)).to.equal(4)
      expect(countOf(rebuilt, `${CANCEL_EXCLUSION} ${CANCEL_EXCLUSION}`)).to.equal(0)
      expect(() => buildCandidate(VOTETORRENT_SCHEMA_SQL.replace(VIEW_ANCHOR, 'view Renamed as'), {
        column: 'text', selfReference: true, position: 'end', editChecks: true
      })).to.throw(/view CurrentAdmin as/)
    })
  })
})
