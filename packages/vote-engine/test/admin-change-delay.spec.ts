/**
 * admin-change-delay.spec.ts — an administration change takes effect by itself when its time comes, and the engine
 * enforces the change rules (66.1: D-01, D-02, D-04, D-05, D-07, D-08).
 *
 * What this file proves, on the real clock and through the real AuthorityEngine:
 * - A change dated a few seconds ahead is not current until its time passes. After a real wait it is current for the
 *   CurrentAdmin view, `getAdminDetails().admin` and `isCurrentPairingOfficer`, with nobody doing anything (D-01).
 * - `getAdminDetails().pending` shows the latest future change that was not cancelled, promoted or not, and is gone
 *   once the change has taken effect or was cancelled. `proposed` hides cancelled and stale (past) proposals (D-04).
 * - While a change is pending, a second one is refused with `admin-change-pending` before any write and before the
 *   sign callback. A cancelled or elapsed change does not block, a stale refused proposal does not block, and a
 *   future proposal whose promotion was refused does block until it is cancelled (D-08).
 * - A change that leaves nobody holding `rad`, or that sets the `rad` threshold above the number of `rad` holders in
 *   the new roster, is refused with `admin-no-rad-holder` before any write and before the sign callback. The pending
 *   check runs first (D-07).
 * - `cancelAdminChange` costs exactly one sign call for any current `rad` holder, a repeat cancel costs none, a
 *   cancelled change never becomes current, and the cancel service's refusal codes reach the caller unchanged (D-05).
 *
 * D-02: the short delay is only passed as the second argument of `adminChangeEffectiveAt`. The shipped delay (five
 * minutes) is pinned by admin-change-constant.spec.ts; nothing here switches it.
 */

import { expect } from 'chai'
import type { Database, SqlValue } from '@quereus/quereus'
import { ADMIN_CHANGE_ERROR_CODES, adminChangeEffectiveAt } from '@votetorrent/vote-core'
import type { AdminDetails, AdminInit, OfficerSelection, Proposal, Scope, Signature, ThresholdPolicy } from '@votetorrent/vote-core'
import { createThresholdAuthority, type ThresholdAuthorityFixture } from './fixtures/threshold-authority.js'
import { isCurrentPairingOfficer } from '../src/pairing/pairing-statement.js'
import { fromCanonicalDatetime, nowCanonicalDatetime, toCanonicalDatetime } from '../src/utils.js'

/** The test-only delay, passed in as an argument (D-02). */
const INJECTED_DELAY_MS = 5_000

type SignFn = (digest: Uint8Array) => Promise<Signature>
type CountingSign = SignFn & { calls: number }

/** The roster a screen would start from: every current officer as an `existing` selection, optionally edited. */
async function rosterFromCurrent (
  fx: ThresholdAuthorityFixture,
  edit?: (officers: OfficerSelection[]) => OfficerSelection[]
): Promise<OfficerSelection[]> {
  const details = await fx.elec.authorityEngine.getAdminDetails()
  const officers: OfficerSelection[] = details.admin.officers.map((officer) => ({
    existing: { ...officer, scopes: [...officer.scopes] }
  }))
  return edit ? edit(officers) : officers
}

async function currentPolicies (fx: ThresholdAuthorityFixture): Promise<ThresholdPolicy[]> {
  return (await fx.elec.authorityEngine.getAdminDetails()).admin.thresholdPolicies
}

/** The founder proposes `officers` at `effectiveAt` through the real engine. */
async function propose (
  fx: ThresholdAuthorityFixture,
  officers: OfficerSelection[],
  effectiveAt: string,
  sign: SignFn,
  thresholdPolicies?: ThresholdPolicy[]
): Promise<void> {
  const proposal: Proposal<AdminInit> = {
    proposed: {
      officers,
      effectiveAt,
      thresholdPolicies: thresholdPolicies ?? await currentPolicies(fx)
    },
    signers: [fx.holders[0]!.user.id]
  }
  await fx.elec.authorityEngine.proposeAdmin(proposal, sign)
}

/** Counts sign calls. One call is one biometric prompt in the Authority app. A refusal must show 0. An accepted
 *  proposal shows exactly 1, promoted or not (G-1: the one signature covers the promotion digest). A cancel shows
 *  exactly 1, a repeat cancel 0. */
function countingSign (base: SignFn): CountingSign {
  const wrapped = (async (digest: Uint8Array): Promise<Signature> => {
    wrapped.calls++
    return base(digest)
  }) as CountingSign
  wrapped.calls = 0
  return wrapped
}

async function countOf (db: Database, sql: string, params: Record<string, SqlValue>): Promise<number> {
  const row = await db.prepare(sql).get(params)
  return Number(row?.n ?? 0)
}

/** Every row class a refused proposal or cancel must leave untouched, scoped to this authority. */
async function snapshot (db: Database, authorityId: string): Promise<Record<string, number>> {
  const p = { authorityId }
  return {
    proposedAdmin: await countOf(db, 'select count(*) as n from ProposedAdmin where AuthorityId = :authorityId', p),
    proposedOfficer: await countOf(db, 'select count(*) as n from ProposedOfficer where AuthorityId = :authorityId', p),
    admin: await countOf(db, 'select count(*) as n from Admin where AuthorityId = :authorityId', p),
    officer: await countOf(db, 'select count(*) as n from Officer where AuthorityId = :authorityId', p),
    adminCancellation: await countOf(db, 'select count(*) as n from AdminCancellation where AuthorityId = :authorityId', p),
    radAdminSigning: await countOf(db, `select count(*) as n from AdminSigning where AuthorityId = :authorityId and Scope = 'rad'`, p),
    radOfficerSignature: await countOf(
      db,
      `select count(*) as n from OfficerSignature OS join AdminSigning S on S.Nonce = OS.SigningNonce where S.AuthorityId = :authorityId and S.Scope = 'rad'`,
      p
    )
  }
}

async function currentAdminAt (db: Database, authorityId: string): Promise<string> {
  const row = await db.prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId').get({ authorityId })
  if (!row) throw new Error('currentAdminAt: no CurrentAdmin row')
  return toCanonicalDatetime(row.EffectiveAt as string)
}

/** Sleep until 1.5 s after `effectiveAtCanon`. Fails loudly first if setup already ran past it (R-41). */
async function waitPast (effectiveAtCanon: string): Promise<void> {
  const at = fromCanonicalDatetime(effectiveAtCanon)
  expect(Date.now() < at, 'host too slow: setup ran past the injected delay').to.equal(true)
  const until = at + 1_500
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(10, until - Date.now()))))
  }
}

/** A fresh future time a second apart from `prevCanon` (canonical strings have one-second resolution). */
async function distinctSecond (prevCanon: string): Promise<string> {
  let next = adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS)
  while (next === prevCanon) {
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    next = adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS)
  }
  return next
}

async function rejection (promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise
    return undefined
  } catch (err) {
    return err as Error
  }
}

/** A refusal must carry `code` and a fixed message with no engine text in it. */
function expectRefusal (err: Error | undefined, code: string, label: string): void {
  expect(err, `${label}: must reject`).to.be.instanceOf(Error)
  expect((err as { code?: string }).code, `${label}: code`).to.equal(code)
  const message = String(err?.message ?? '')
  expect(message, `${label}: no SQL in the message`).to.not.match(/\b(select|insert|update|delete|constraint|check)\b/i)
  expect(message, `${label}: no constraint name in the message`).to.not.match(/\b[A-Z][a-z]+[A-Z][A-Za-z]*\b/)
}

function lastOutcome (fx: ThresholdAuthorityFixture): { status?: string, reason?: string } | undefined {
  return (fx.elec.authorityEngine as unknown as { lastPromotionOutcome?: { status?: string, reason?: string } })
    .lastPromotionOutcome
}

function withOutsider (fx: ThresholdAuthorityFixture): (officers: OfficerSelection[]) => OfficerSelection[] {
  return (officers) => [
    ...officers,
    { existing: { userId: fx.outsider.id, authorityId: fx.authorityId, title: 'Clerk', scopes: ['mel'] as Scope[] } }
  ]
}

const NOBODY: OfficerSelection = { init: { name: 'Nobody Has This Name 66.1', title: 'Clerk', scopes: ['mel'] as Scope[] } }

function officerIds (details: AdminDetails): string[] {
  return details.admin.officers.map((o) => o.userId)
}

describe('admin change delay and rules (66.1)', function () {
  this.timeout(60_000)

  it('D-01/D-04/D-08: a change 5 s ahead is pending, blocks a second change, then takes effect by itself', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const founding = toCanonicalDatetime(fx.adminEffectiveAt as string)
    const policies = await currentPolicies(fx)

    const a = adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS)
    await propose(fx, await rosterFromCurrent(fx, withOutsider(fx)), a, fx.holders[0]!.sign, policies)
    expect(lastOutcome(fx)?.status, 'A is promoted into Admin at its future time').to.equal('promoted')

    // Before T: nothing is current yet.
    expect(await currentAdminAt(db, fx.authorityId), 'CurrentAdmin before T').to.equal(founding)
    const before = await fx.elec.authorityEngine.getAdminDetails()
    expect(officerIds(before), 'admin.officers before T').to.not.include(fx.outsider.id)
    expect(await isCurrentPairingOfficer(db, { userId: fx.outsider.id, nowCanonical: nowCanonicalDatetime() }), 'isCurrentPairingOfficer before T').to.equal(false)

    // Pending read (C2).
    expect(before.pending, 'pending before T').to.not.equal(undefined)
    expect(before.pending!.effectiveAt, 'pending.effectiveAt is the canonical string').to.equal(a)
    expect(before.pending!.promoted, 'pending.promoted').to.equal(true)
    expect(before.pending!.thresholdPolicies, 'pending.thresholdPolicies').to.deep.equal(policies)
    const outsiderSel = before.pending!.officers.find((o) => o.existing?.userId === fx.outsider.id)
    expect(outsiderSel?.existing, 'the outsider is an existing selection in pending').to.not.equal(undefined)
    expect(outsiderSel?.existing?.scopes).to.deep.equal(['mel'])
    expect(before.pending!.officers.length, 'pending roster size').to.equal(before.admin.officers.length + 1)
    expect(before.proposed, 'a promoted change is not "proposed"').to.equal(undefined)

    // D-08: a second change is refused before any write and before the sign callback.
    const snap = await snapshot(db, fx.authorityId)
    const sign = countingSign(fx.holders[0]!.sign)
    const b = await distinctSecond(a)
    const err = await rejection(propose(fx, await rosterFromCurrent(fx), b, sign))
    expectRefusal(err, ADMIN_CHANGE_ERROR_CODES.pending, 'D-08 while A is pending')
    expect(sign.calls, 'D-08: sign callback calls').to.equal(0)
    expect(await snapshot(db, fx.authorityId), 'D-08: nothing written').to.deep.equal(snap)

    // Real wait: A takes effect with nobody doing anything.
    await waitPast(a)
    expect(await currentAdminAt(db, fx.authorityId), 'CurrentAdmin after T').to.equal(a)
    const after = await fx.elec.authorityEngine.getAdminDetails()
    expect(officerIds(after), 'admin.officers after T').to.include(fx.outsider.id)
    expect(await isCurrentPairingOfficer(db, { userId: fx.outsider.id, nowCanonical: nowCanonicalDatetime() }), 'isCurrentPairingOfficer after T').to.equal(true)
    expect(after.pending, 'pending after T').to.equal(undefined)
    expect(after.proposed, 'proposed after T').to.equal(undefined)

    // An elapsed change does not block.
    const c = await distinctSecond(a)
    const allowed = countingSign(fx.holders[0]!.sign)
    await propose(fx, await rosterFromCurrent(fx), c, allowed)
    expect(allowed.calls, 'a proposal after A elapsed is signed').to.equal(1)
    expect((await fx.elec.authorityEngine.getAdminDetails()).pending?.effectiveAt).to.equal(c)
  })

  it('D-08: a cancelled change does not block the next one', async () => {
    const fx = await createThresholdAuthority()
    const a = adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS)
    await propose(fx, await rosterFromCurrent(fx, withOutsider(fx)), a, fx.holders[0]!.sign)
    const pending = (await fx.elec.authorityEngine.getAdminDetails()).pending
    expect(pending?.effectiveAt).to.equal(a)

    await fx.elec.authorityEngine.cancelAdminChange(
      { effectiveAt: pending!.effectiveAt, userId: fx.holders[1]!.user.id },
      fx.holders[1]!.sign
    )
    expect((await fx.elec.authorityEngine.getAdminDetails()).pending, 'pending after cancel').to.equal(undefined)

    const b = await distinctSecond(a)
    const sign = countingSign(fx.holders[0]!.sign)
    await propose(fx, await rosterFromCurrent(fx), b, sign)
    expect(sign.calls).to.equal(1)
    expect((await fx.elec.authorityEngine.getAdminDetails()).pending?.effectiveAt, 'pending is B').to.equal(b)
  })

  it('R-33: a future proposal whose promotion was refused is pending, blocks, and stops blocking once cancelled', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const a = adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS)
    await propose(fx, await rosterFromCurrent(fx, (o) => [...o, NOBODY]), a, fx.holders[0]!.sign)
    expect(lastOutcome(fx)?.status, 'promotion of the { init } roster is refused').to.equal('refused')

    const details = await fx.elec.authorityEngine.getAdminDetails()
    expect(details.pending?.effectiveAt).to.equal(a)
    expect(details.pending?.promoted, 'pending.promoted').to.equal(false)
    expect(details.pending?.officers.some((o) => o.init?.name === NOBODY.init!.name), 'the init entry is in pending').to.equal(true)
    expect(details.proposed, 'an unpromoted future proposal is proposed').to.not.equal(undefined)
    expect(toCanonicalDatetime(details.proposed!.proposed.effectiveAt)).to.equal(a)

    const snap = await snapshot(db, fx.authorityId)
    const sign = countingSign(fx.holders[0]!.sign)
    const err = await rejection(propose(fx, await rosterFromCurrent(fx), await distinctSecond(a), sign))
    expectRefusal(err, ADMIN_CHANGE_ERROR_CODES.pending, 'R-33 refused-promotion change still blocks')
    expect(sign.calls).to.equal(0)
    expect(await snapshot(db, fx.authorityId)).to.deep.equal(snap)

    await fx.elec.authorityEngine.cancelAdminChange(
      { effectiveAt: details.pending!.effectiveAt, userId: fx.holders[0]!.user.id },
      fx.holders[0]!.sign
    )
    const cleared = await fx.elec.authorityEngine.getAdminDetails()
    expect(cleared.pending, 'pending after cancel').to.equal(undefined)
    expect(cleared.proposed, 'proposed hides a cancelled proposal').to.equal(undefined)

    const next = countingSign(fx.holders[0]!.sign)
    await propose(fx, await rosterFromCurrent(fx), await distinctSecond(a), next)
    expect(next.calls).to.equal(1)
  })

  it('F4: a stale (past) refused proposal is neither pending nor proposed and does not block', async () => {
    const fx = await createThresholdAuthority()
    const past = toCanonicalDatetime(Date.now() - 30_000)
    await propose(fx, await rosterFromCurrent(fx, (o) => [...o, NOBODY]), past, fx.holders[0]!.sign)
    expect(lastOutcome(fx)?.status, 'the stale { init } roster is refused at promotion').to.equal('refused')

    const details = await fx.elec.authorityEngine.getAdminDetails()
    expect(details.pending, 'a stale proposal is not pending').to.equal(undefined)
    expect(details.proposed, 'a stale proposal is not proposed').to.equal(undefined)

    const a = adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS)
    const sign = countingSign(fx.holders[0]!.sign)
    await propose(fx, await rosterFromCurrent(fx), a, sign)
    expect(sign.calls).to.equal(1)
    expect((await fx.elec.authorityEngine.getAdminDetails()).pending?.effectiveAt).to.equal(a)
  })

  describe('D-07: a change must leave somebody able to revise the administration', function () {
    const cases: Array<{ name: string, roster: (fx: ThresholdAuthorityFixture) => Promise<OfficerSelection[]> }> = [
      {
        name: 'the founder loses rad',
        roster: async (fx) => rosterFromCurrent(fx, (officers) => officers.map((o) =>
          o.existing?.userId === fx.holders[0]!.user.id
            ? { existing: { ...o.existing, scopes: o.existing.scopes.filter((s) => s !== 'rad') } }
            : o
        ))
      },
      {
        name: 'only the officer without rad stays',
        roster: async (fx) => rosterFromCurrent(fx, (officers) => officers.filter((o) => o.existing?.userId === fx.nonHolder.user.id))
      },
      {
        name: 'every officer is removed',
        roster: async () => []
      }
    ]

    for (const c of cases) {
      it(`refuses when ${c.name}, before any write or sign call`, async () => {
        const fx = await createThresholdAuthority({ holderCount: 1 })
        const db = fx.elec.ctx.db
        const roster = await c.roster(fx)
        expect(roster.some((o) => o.existing?.scopes.includes('rad' as Scope) || o.init?.scopes.includes('rad' as Scope)),
          'precondition: the roster has no rad holder').to.equal(false)
        const snap = await snapshot(db, fx.authorityId)
        const sign = countingSign(fx.holders[0]!.sign)
        const err = await rejection(propose(fx, roster, adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS), sign))
        expectRefusal(err, ADMIN_CHANGE_ERROR_CODES.noRadHolder, `D-07 (${c.name})`)
        expect(sign.calls, 'sign callback calls').to.equal(0)
        expect(await snapshot(db, fx.authorityId), 'nothing written').to.deep.equal(snap)
      })
    }

    it('positive control: keeping the founder\'s rad is accepted', async () => {
      const fx = await createThresholdAuthority({ holderCount: 1 })
      const roster = await rosterFromCurrent(fx, (officers) => officers.map((o) =>
        o.existing?.userId === fx.nonHolder.user.id ? { existing: { ...o.existing, title: 'Records Clerk' } } : o
      ))
      const sign = countingSign(fx.holders[0]!.sign)
      await propose(fx, roster, adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS), sign)
      expect(sign.calls).to.equal(1)
    })

    it('hardening: a rad threshold above the new roster\'s rad holders is refused; at the holder count it resolves', async () => {
      const fx = await createThresholdAuthority()
      const db = fx.elec.ctx.db
      const roster = await rosterFromCurrent(fx)
      const radHolders = roster.filter((o) => o.existing?.scopes.includes('rad' as Scope)).length
      expect(radHolders, 'precondition: four rad holders').to.equal(4)
      const base = await currentPolicies(fx)
      const withRad = (n: number): ThresholdPolicy[] => [
        ...base.filter((p) => p.policy !== 'rad'),
        { policy: 'rad' as Scope, threshold: n }
      ]

      const snap = await snapshot(db, fx.authorityId)
      const refusedSign = countingSign(fx.holders[0]!.sign)
      const err = await rejection(propose(fx, roster, adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS), refusedSign, withRad(5)))
      expectRefusal(err, ADMIN_CHANGE_ERROR_CODES.noRadHolder, 'rad threshold 5 with 4 rad holders')
      expect(refusedSign.calls).to.equal(0)
      expect(await snapshot(db, fx.authorityId)).to.deep.equal(snap)

      // Positive control: threshold 4 with 4 holders resolves (it leaves a pending change; the test ends here).
      const okSign = countingSign(fx.holders[0]!.sign)
      await propose(fx, roster, adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS), okSign, withRad(4))
      expect(okSign.calls).to.equal(1)
    })

    it('order: with a change pending, a rad-less proposal is refused as pending, not as no-rad-holder', async () => {
      const fx = await createThresholdAuthority({ holderCount: 1 })
      const a = adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS)
      await propose(fx, await rosterFromCurrent(fx), a, fx.holders[0]!.sign)
      expect((await fx.elec.authorityEngine.getAdminDetails()).pending?.effectiveAt).to.equal(a)

      const sign = countingSign(fx.holders[0]!.sign)
      const radless = await rosterFromCurrent(fx, (officers) => officers.filter((o) => o.existing?.userId === fx.nonHolder.user.id))
      const err = await rejection(propose(fx, radless, await distinctSecond(a), sign))
      expectRefusal(err, ADMIN_CHANGE_ERROR_CODES.pending, 'pending first')
      expect(sign.calls).to.equal(0)
    })
  })

  describe('G-1: one Confirm is one sign call', function () {
    /** Records every digest handed to the callback, base64url, in call order. */
    function capturingSign (base: SignFn): CountingSign & { digests: string[] } {
      const wrapped = (async (digest: Uint8Array): Promise<Signature> => {
        wrapped.calls++
        wrapped.digests.push(Buffer.from(digest).toString('base64url'))
        return base(digest)
      }) as CountingSign & { digests: string[] }
      wrapped.calls = 0
      wrapped.digests = []
      return wrapped
    }

    it('a promoted change signs once, over the digest of its one rad promotion session, and every row lands', async () => {
      const fx = await createThresholdAuthority()
      const db = fx.elec.ctx.db
      const before = await snapshot(db, fx.authorityId)
      const roster = await rosterFromCurrent(fx, withOutsider(fx))
      const a = adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS)
      const sign = capturingSign(fx.holders[0]!.sign)
      await propose(fx, roster, a, sign)

      // The 2-prompt defect (66.1 UAT tests 4, 9, 15) is exactly this count being 2.
      expect(sign.calls, 'one sign call for the proposal and its promotion').to.equal(1)
      const outcome = (fx.elec.authorityEngine as unknown as { lastPromotionOutcome?: { status?: string, nonce?: string } })
        .lastPromotionOutcome
      expect(outcome?.status).to.equal('promoted')

      const after = await snapshot(db, fx.authorityId)
      expect(after.proposedAdmin - before.proposedAdmin, 'one ProposedAdmin').to.equal(1)
      expect(after.proposedOfficer - before.proposedOfficer, 'the whole roster is proposed').to.equal(roster.length)
      expect(after.admin - before.admin, 'one Admin').to.equal(1)
      expect(after.officer - before.officer, 'every officer of the roster').to.equal(roster.length)
      expect(after.radAdminSigning - before.radAdminSigning, 'one rad session').to.equal(1)
      expect(after.radOfficerSignature - before.radOfficerSignature, 'one rad officer signature').to.equal(1)

      // The one session is the one the Admin and Officer CHECKs verified (they admit only a session whose Digest is the
      // promotion digest), it carries the signed digest, the founder's signature and its AdminSignature.
      const session = await db
        .prepare(`select Nonce, Digest, UserId, Signature from AdminSigning where Nonce = :nonce and Scope = 'rad'`)
        .get({ nonce: outcome!.nonce! })
      expect(session, 'the outcome nonce is the rad session').to.not.equal(undefined)
      expect(session!.Digest, 'the signed digest is the session digest').to.equal(sign.digests[0])
      expect(session!.UserId).to.equal(fx.holders[0]!.user.id)
      const officerSig = await db
        .prepare('select UserId, Signature from OfficerSignature where SigningNonce = :nonce')
        .get({ nonce: outcome!.nonce! })
      expect(officerSig?.UserId).to.equal(fx.holders[0]!.user.id)
      expect(officerSig?.Signature, 'the officer signature is the one signature').to.equal(session!.Signature)
      expect(await countOf(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce: outcome!.nonce! }))
        .to.equal(1)

      const pending = (await fx.elec.authorityEngine.getAdminDetails()).pending
      expect(pending?.effectiveAt).to.equal(a)
      expect(pending?.promoted).to.equal(true)
    })

    it('a change whose promotion is refused also signs once (the proposal digest), and stays pending unpromoted', async () => {
      const fx = await createThresholdAuthority()
      const db = fx.elec.ctx.db
      const before = await snapshot(db, fx.authorityId)
      const a = adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS)
      const sign = capturingSign(fx.holders[0]!.sign)
      await propose(fx, await rosterFromCurrent(fx, (o) => [...o, NOBODY]), a, sign)
      expect(lastOutcome(fx)?.status).to.equal('refused')
      expect(sign.calls, 'one sign call').to.equal(1)
      const after = await snapshot(db, fx.authorityId)
      expect(after.radAdminSigning - before.radAdminSigning, 'the proposal session only').to.equal(1)
      expect(after.admin - before.admin, 'nothing promoted').to.equal(0)
      expect(await countOf(db, `select count(*) as n from AdminSigning where Scope = 'rad' and Digest = :d`, { d: sign.digests[0]! }))
        .to.equal(1)
      expect((await fx.elec.authorityEngine.getAdminDetails()).pending?.promoted).to.equal(false)
    })
  })

  describe('D-05: cancel through the engine', function () {
    it('a different current rad holder cancels with one prompt, a repeat costs none, and the change never takes effect', async () => {
      const fx = await createThresholdAuthority()
      const db = fx.elec.ctx.db
      const founding = toCanonicalDatetime(fx.adminEffectiveAt as string)
      const a = adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS)
      await propose(fx, await rosterFromCurrent(fx, withOutsider(fx)), a, fx.holders[0]!.sign)
      expect(lastOutcome(fx)?.status).to.equal('promoted')
      const pending = (await fx.elec.authorityEngine.getAdminDetails()).pending
      expect(pending?.effectiveAt).to.equal(a)

      const canceller = fx.holders[1]!
      const first = countingSign(canceller.sign)
      await fx.elec.authorityEngine.cancelAdminChange({ effectiveAt: pending!.effectiveAt, userId: canceller.user.id }, first)
      expect(first.calls, 'one prompt for the cancel').to.equal(1)

      const second = countingSign(canceller.sign)
      await fx.elec.authorityEngine.cancelAdminChange({ effectiveAt: pending!.effectiveAt, userId: canceller.user.id }, second)
      expect(second.calls, 'a repeat cancel prompts nobody').to.equal(0)
      expect(await countOf(db, 'select count(*) as n from AdminCancellation where AuthorityId = :authorityId', { authorityId: fx.authorityId }))
        .to.equal(1)

      const cancelled = await fx.elec.authorityEngine.getAdminDetails()
      expect(cancelled.pending, 'pending after cancel').to.equal(undefined)
      expect(cancelled.proposed, 'proposed after cancel').to.equal(undefined)

      await waitPast(a)
      expect(await currentAdminAt(db, fx.authorityId), 'CurrentAdmin after T').to.equal(founding)
      const after = await fx.elec.authorityEngine.getAdminDetails()
      expect(officerIds(after), 'admin.officers after T').to.not.include(fx.outsider.id)
      expect(await isCurrentPairingOfficer(db, { userId: fx.outsider.id, nowCanonical: nowCanonicalDatetime() }), 'isCurrentPairingOfficer after T').to.equal(false)
      expect(after.pending).to.equal(undefined)
    })

    it('refusal codes from the cancel service reach the caller unchanged, with no prompt', async () => {
      const fx = await createThresholdAuthority()
      const db = fx.elec.ctx.db
      const a = adminChangeEffectiveAt(Date.now(), INJECTED_DELAY_MS)
      await propose(fx, await rosterFromCurrent(fx, withOutsider(fx)), a, fx.holders[0]!.sign)
      const snap = await snapshot(db, fx.authorityId)

      const nonHolderSign = countingSign(fx.nonHolder.sign)
      const notAuthorized = await rejection(fx.elec.authorityEngine.cancelAdminChange(
        { effectiveAt: a, userId: fx.nonHolder.user.id },
        nonHolderSign
      ))
      expectRefusal(notAuthorized, ADMIN_CHANGE_ERROR_CODES.cancelNotAuthorized, 'cancel by an officer without rad')
      expect(nonHolderSign.calls).to.equal(0)

      const nothingThere = toCanonicalDatetime(fromCanonicalDatetime(a) + 600_000)
      const holderSign = countingSign(fx.holders[0]!.sign)
      const notPending = await rejection(fx.elec.authorityEngine.cancelAdminChange(
        { effectiveAt: nothingThere, userId: fx.holders[0]!.user.id },
        holderSign
      ))
      expectRefusal(notPending, ADMIN_CHANGE_ERROR_CODES.cancelNotPending, 'cancel of a time with no proposal')
      expect(holderSign.calls).to.equal(0)

      expect(await snapshot(db, fx.authorityId), 'no refusal wrote anything').to.deep.equal(snap)
      expect((await fx.elec.authorityEngine.getAdminDetails()).pending?.effectiveAt, 'A is still pending').to.equal(a)
    })
  })
})
