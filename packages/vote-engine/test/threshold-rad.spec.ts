/**
 * threshold-rad.spec.ts — 62-13 (D-08, D-10, D-12, D-33): `rad` (administration) threshold-2
 * co-signing, end to end through production code.
 *
 * First describe pins the CONTEXT-named defects (RED on the unmodified engine): above rad
 * threshold 1, `proposeAdmin` creates no co-signer Task at all (R0a), and a late co-signature
 * re-enters `applyAdminProposal` a second time (R0b) once a Task exists by hand-fan-out.
 */

import { expect } from 'chai'
import type { Database, SqlValue } from '@quereus/quereus'
import type { AdminInit, AdminSignatureTask, Proposal, Scope, Signature, ThresholdPolicy } from '@votetorrent/vote-core'
import { AdminPromotionError } from '@votetorrent/vote-core'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { AuthorityEngine } from '../src/authority/authority-engine.js'
import {
  createThresholdAuthority,
  type ThresholdAuthorityFixture,
} from './fixtures/threshold-authority.js'
import {
  computeRadProposalDigest,
  readProposedRosterJson,
  adminSignatureTaskExtensionInserter,
} from '../src/authority/rad-roster-digest.js'
import { fanOutSignatureTasks } from '../src/signing/fan-out.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { digestToBytes, toCanonicalDatetime } from '../src/utils.js'
import { SigningEngine } from '../src/signing/signing-engine.js'
import { sortRosterEntries } from '../src/authority/authority-engine.js'

function makeNetworkRef () {
  return {
    hash: 'test-threshold-rad-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

function engineFor (fx: ThresholdAuthorityFixture, holder: ThresholdAuthorityFixture['holders'][number]): SignatureTasksEngine {
  return new SignatureTasksEngine(makeNetworkRef(), { db: fx.elec.ctx.db, user: holder.user })
}

async function countRows (db: Database, sql: string, params: Record<string, SqlValue> = {}): Promise<number> {
  const row = await db.prepare(sql).get(params)
  return Number(row?.n ?? 0)
}

async function openTaskUsers (db: Database, nonce: string): Promise<string[]> {
  const rows: string[] = []
  for await (const row of db.eval(
    'select distinct UserId from Task where SigningNonce = :nonce and IsCompleted = 0 order by UserId',
    { nonce }
  )) {
    rows.push(row.UserId as string)
  }
  return rows.sort()
}

/** Locate a 'rad' proposal's AdminSigning.Nonce by recomputing its digest — the canonical way
 *  to find a session this file never captured a return value for (proposeAdmin returns void). */
async function proposalNonce (
  db: Database,
  authorityId: string,
  effectiveAtCanon: string,
  thresholdPolicies: ThresholdPolicy[]
): Promise<string> {
  const officers = await readProposedRosterJson(db, authorityId, effectiveAtCanon)
  const digest = await computeRadProposalDigest(db, {
    authorityId,
    effectiveAt: effectiveAtCanon,
    officers,
    thresholdPolicies: JSON.stringify(thresholdPolicies),
  })
  const row = await db.prepare(`select Nonce from AdminSigning where Scope = 'rad' and Digest = :digest`).get({ digest })
  if (!row) throw new Error('proposalNonce: no AdminSigning row found for the computed proposal digest')
  return row.Nonce as string
}

/** The pending admin task for `holder` whose proposed EffectiveAt equals `effectiveAtCanon` —
 *  disambiguates when a holder has more than one open admin task (R11). */
async function adminTaskFor (
  fx: ThresholdAuthorityFixture,
  holder: ThresholdAuthorityFixture['holders'][number],
  effectiveAtCanon: string
): Promise<{ engine: SignatureTasksEngine; task: AdminSignatureTask }> {
  const engine = engineFor(fx, holder)
  const tasks = await engine.getRequestedSignatures(true)
  const task = tasks.find((t): t is AdminSignatureTask =>
    t.signatureType === 'admin' &&
    (t as AdminSignatureTask).administration?.proposed?.effectiveAt === effectiveAtCanon
  )
  if (!task) {
    throw new Error(
      `adminTaskFor: holder ${holder.user.id} has no pending admin task at proposed effectiveAt=${effectiveAtCanon}`
    )
  }
  return { engine, task }
}

interface ProposeArgs {
  effectiveAt: number
  rosterHolders: ThresholdAuthorityFixture['holders']
  thresholdPolicies: ThresholdPolicy[]
  initiatorUserId: string
  signerCallback: ((digest: Uint8Array) => Promise<Signature>) | Signature
}

/** Build and propose a 'rad' roster through the real `proposeAdmin` call — every R-test in this
 *  file drives the production entry point, never a hand-built row. Returns the canonical
 *  EffectiveAt; callers resolve the nonce separately via `proposalNonce` when they need it. */
async function proposeAdminRoster (fx: ThresholdAuthorityFixture, args: ProposeArgs): Promise<{ effectiveAtCanon: string }> {
  const proposal: Proposal<AdminInit> = {
    proposed: {
      officers: args.rosterHolders.map((h, i) => ({
        existing: {
          userId: h.user.id,
          authorityId: fx.authorityId,
          title: `Officer ${i}`,
          scopes: Array.from(new Set([...h.scopes, 'rad'])) as Scope[],
        },
      })),
      effectiveAt: args.effectiveAt,
      thresholdPolicies: args.thresholdPolicies,
    },
    signers: [args.initiatorUserId],
  }
  await fx.elec.authorityEngine.proposeAdmin(proposal, args.signerCallback)
  return { effectiveAtCanon: toCanonicalDatetime(args.effectiveAt) }
}

const RAD_THRESHOLD_2: ThresholdPolicy[] = [{ policy: 'rad' as Scope, threshold: 2 }]

describe('threshold-2 rad (RED pin)', function () {
  this.timeout(60_000)

  it('R0a (D-08 pin): proposeAdmin above threshold 1 fans out a co-signer Task to every other current rad holder', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000

    const { effectiveAtCanon } = await proposeAdminRoster(fx, {
      effectiveAt,
      rosterHolders: fx.holders.slice(0, 3),
      thresholdPolicies: RAD_THRESHOLD_2,
      initiatorUserId: fx.holders[0]!.user.id,
      signerCallback: fx.holders[0]!.sign,
    })
    const nonce = await proposalNonce(db, fx.authorityId, effectiveAtCanon, RAD_THRESHOLD_2)

    const expectedOpen = [fx.holders[1]!.user.id, fx.holders[2]!.user.id, fx.holders[3]!.user.id].sort()
    const openUsers = await openTaskUsers(db, nonce)
    expect(openUsers, 'R0a: openTaskUsers must equal holders[1..3]').to.deep.equal(expectedOpen)

    for (const userId of expectedOpen) {
      const extRow = await db
        .prepare(
          `select E.AdminEffectiveAt from Task T join AdminSignatureTaskExtension E on E.TaskId = T.Id
            where T.SigningNonce = :nonce and T.UserId = :userId`
        )
        .get({ nonce, userId })
      expect(extRow?.AdminEffectiveAt, `R0a: ${userId}'s task extension AdminEffectiveAt`).to.equal(effectiveAtCanon)
    }

    const officerSigCount = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })
    expect(officerSigCount, 'R0a: exactly 1 OfficerSignature (the proposer, holders[0])').to.equal(1)
    const adminSigCount = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
    expect(adminSigCount, 'R0a: 0 AdminSignature').to.equal(0)
  })

  it('R0b (D-10 pin): a late co-signature must not re-enter applyAdminProposal a second time', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000

    const { effectiveAtCanon } = await proposeAdminRoster(fx, {
      effectiveAt,
      rosterHolders: fx.holders.slice(0, 3),
      thresholdPolicies: RAD_THRESHOLD_2,
      initiatorUserId: fx.holders[0]!.user.id,
      signerCallback: fx.holders[0]!.sign,
    })
    const nonce = await proposalNonce(db, fx.authorityId, effectiveAtCanon, RAD_THRESHOLD_2)

    // Only hand-fan-out if proposeAdmin itself did not already (true before Task 2 lands; a
    // no-op once it does) — the same code is valid on both sides of this plan's own edit.
    const existingTaskCount = await countRows(db, 'select count(*) as n from Task where SigningNonce = :nonce', { nonce })
    if (existingTaskCount === 0) {
      const taskTid = await allocateTid(db, 'authority')
      await fanOutSignatureTasks(fx.elec.ctx, {
        authorityId: fx.authorityId,
        scope: 'rad' as Scope,
        nonce,
        initiatorUserId: fx.holders[0]!.user.id,
        signatureType: 'admin',
        taskTid,
        insertExtension: adminSignatureTaskExtensionInserter(db, fx.authorityId, effectiveAtCanon, taskTid),
      })
    }

    let promotionCalls = 0
    const originalApply = AuthorityEngine.prototype.applyAdminProposal
    AuthorityEngine.prototype.applyAdminProposal = async function (
      this: AuthorityEngine,
      ...args: Parameters<typeof originalApply>
    ) {
      promotionCalls++
      return originalApply.apply(this, args)
    } as typeof originalApply

    try {
      const { engine: engine1, task: task1 } = await adminTaskFor(fx, fx.holders[1]!, effectiveAtCanon)
      const digest1 = await engine1.getSignatureDigest(task1)
      await engine1.completeSignature(task1, {
        isAccepted: true,
        signature: await fx.holders[1]!.sign(digest1),
        sign: fx.holders[1]!.sign,
      })

      const { engine: engine2, task: task2 } = await adminTaskFor(fx, fx.holders[2]!, effectiveAtCanon)
      const digest2 = await engine2.getSignatureDigest(task2)
      await engine2.completeSignature(task2, {
        isAccepted: true,
        signature: await fx.holders[2]!.sign(digest2),
        sign: fx.holders[2]!.sign,
      })
    } finally {
      AuthorityEngine.prototype.applyAdminProposal = originalApply
    }

    const adminCount = await countRows(
      db,
      'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    expect(adminCount, 'R0b: exactly 1 Admin row at the proposed EffectiveAt').to.equal(1)
    const officerSigCount = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })
    expect(officerSigCount, 'R0b: 3 OfficerSignature rows').to.equal(3)
    const adminSigCount = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
    expect(adminSigCount, 'R0b: exactly 1 AdminSignature on the nonce').to.equal(1)
    const task2Row = await db
      .prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId')
      .get({ nonce, userId: fx.holders[2]!.user.id })
    expect(Number(task2Row?.IsCompleted), "R0b: holders[2]'s Task must be completed").to.equal(1)
    expect(promotionCalls, 'R0b: applyAdminProposal must be called exactly once').to.equal(1)
  })
})

/** R6/R7: a snapshot of every row class a refused proposeAdmin call must leave untouched,
 *  scoped to this authority so a refusal's "nothing written" claim is provable. */
async function snapshotCounts (db: Database, authorityId: string): Promise<Record<string, number>> {
  return {
    proposedAdmin: await countRows(db, 'select count(*) as n from ProposedAdmin where AuthorityId = :id', { id: authorityId }),
    proposedOfficer: await countRows(db, 'select count(*) as n from ProposedOfficer where AuthorityId = :id', { id: authorityId }),
    adminSigning: await countRows(db, `select count(*) as n from AdminSigning where AuthorityId = :id and Scope = 'rad'`, { id: authorityId }),
    officerSignature: await countRows(
      db,
      `select count(*) as n from OfficerSignature where SigningNonce in (select Nonce from AdminSigning where AuthorityId = :id and Scope = 'rad')`,
      { id: authorityId }
    ),
    task: await countRows(
      db,
      `select count(*) as n from Task where SigningNonce in (select Nonce from AdminSigning where AuthorityId = :id and Scope = 'rad')`,
      { id: authorityId }
    ),
    adminSignatureTaskExtension: await countRows(
      db,
      'select count(*) as n from AdminSignatureTaskExtension where AuthorityId = :id',
      { id: authorityId }
    ),
  }
}

describe('rad Trigger A: proposeAdmin fan-out (D-08, D-12)', function () {
  this.timeout(60_000)

  it('R1 (D-08): proposer signature recorded, co-signer tasks fanned out, lastPromotionOutcome and getSigningStatus report awaiting-co-signers', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    let callbackCalls = 0
    const countingCallback = async (digest: Uint8Array): Promise<Signature> => {
      callbackCalls++
      return fx.holders[0]!.sign(digest)
    }

    const { effectiveAtCanon } = await proposeAdminRoster(fx, {
      effectiveAt,
      rosterHolders: fx.holders.slice(0, 3),
      thresholdPolicies: RAD_THRESHOLD_2,
      initiatorUserId: fx.holders[0]!.user.id,
      signerCallback: countingCallback,
    })
    const nonce = await proposalNonce(db, fx.authorityId, effectiveAtCanon, RAD_THRESHOLD_2)

    const adminSigningCount = await countRows(db, 'select count(*) as n from AdminSigning where Nonce = :nonce', { nonce })
    expect(adminSigningCount, 'R1: exactly 1 rad AdminSigning session').to.equal(1)
    const officerSigCount = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })
    expect(officerSigCount, 'R1: exactly 1 OfficerSignature (holders[0])').to.equal(1)
    const adminSigCount = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
    expect(adminSigCount, 'R1: 0 AdminSignature').to.equal(0)

    const expectedOpen = [fx.holders[1]!.user.id, fx.holders[2]!.user.id, fx.holders[3]!.user.id].sort()
    const openUsers = await openTaskUsers(db, nonce)
    expect(openUsers, 'R1: openTaskUsers equals holders[1..3]').to.deep.equal(expectedOpen)

    for (const userId of [fx.holders[0]!.user.id, fx.nonHolder.user.id, fx.outsider.id]) {
      const n = await countRows(db, 'select count(*) as n from Task where SigningNonce = :nonce and UserId = :userId', { nonce, userId })
      expect(n, `R1: ${userId} must have 0 Tasks for the nonce`).to.equal(0)
    }

    for (const userId of expectedOpen) {
      const extRow = await db
        .prepare(
          `select E.AdminEffectiveAt from Task T join AdminSignatureTaskExtension E on E.TaskId = T.Id
            where T.SigningNonce = :nonce and T.UserId = :userId`
        )
        .get({ nonce, userId })
      expect(extRow?.AdminEffectiveAt, `R1: ${userId}'s extension AdminEffectiveAt`).to.equal(effectiveAtCanon)
    }

    const adminRowCount = await countRows(
      db,
      'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    expect(adminRowCount, 'R1: 0 Admin rows at the proposed EffectiveAt').to.equal(0)
    expect(callbackCalls, 'R1: the callback was invoked exactly once').to.equal(1)

    const outcome = (
      fx.elec.authorityEngine as unknown as {
        lastPromotionOutcome?: { status: string; nonce: string; threshold: number; recipientUserIds: string[] }
      }
    ).lastPromotionOutcome
    expect(outcome, 'R1: lastPromotionOutcome').to.deep.equal({
      status: 'awaiting-co-signers',
      nonce,
      threshold: 2,
      recipientUserIds: expectedOpen,
    })

    const status = await new SigningEngine(fx.elec.ctx).getSigningStatus(nonce)
    expect(status?.signatures, 'R1: getSigningStatus signatures').to.equal(1)
    expect(status?.openTasks, 'R1: getSigningStatus openTasks').to.equal(3)
    expect(status?.reached, 'R1: getSigningStatus reached').to.equal(false)
    expect(status?.unreachable, 'R1: getSigningStatus unreachable').to.equal(false)
  })

  it('R6 (unreachable at birth): a threshold exceeding the holder count is refused before any write or callback', async () => {
    const fx = await createThresholdAuthority({ holderCount: 4, thresholdPolicies: [{ policy: 'rad' as Scope, threshold: 5 }] })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    let callbackCalls = 0
    const countingCallback = async (digest: Uint8Array): Promise<Signature> => {
      callbackCalls++
      return fx.holders[0]!.sign(digest)
    }

    const before = await snapshotCounts(db, fx.authorityId)

    let caught: unknown
    try {
      await proposeAdminRoster(fx, {
        effectiveAt,
        rosterHolders: fx.holders.slice(0, 3),
        thresholdPolicies: [{ policy: 'rad' as Scope, threshold: 5 }],
        initiatorUserId: fx.holders[0]!.user.id,
        signerCallback: countingCallback,
      })
    } catch (err) {
      caught = err
    }
    expect(caught, 'R6: proposeAdmin must reject').to.be.instanceOf(Error)
    expect((caught as Error).message, 'R6: error text names the threshold and the actual holder count').to.include('only 4 officers')
    expect(callbackCalls, 'R6: the callback must be invoked 0 times').to.equal(0)

    const after = await snapshotCounts(db, fx.authorityId)
    expect(after, 'R6: row counts unchanged from before the call').to.deep.equal(before)
  })

  it('R7 (spoof): a signature whose signer differs from admin.signers[0] is refused before any write', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    const before = await snapshotCounts(db, fx.authorityId)

    let caught: unknown
    try {
      await proposeAdminRoster(fx, {
        effectiveAt,
        rosterHolders: fx.holders.slice(0, 3),
        thresholdPolicies: RAD_THRESHOLD_2,
        initiatorUserId: fx.holders[0]!.user.id,
        signerCallback: async (digest: Uint8Array): Promise<Signature> => fx.holders[1]!.sign(digest),
      })
    } catch (err) {
      caught = err
    }
    expect(caught, 'R7: proposeAdmin must reject').to.be.instanceOf(Error)
    expect((caught as Error).message, 'R7: error text').to.include('does not belong to the officer proposing')

    const after = await snapshotCounts(db, fx.authorityId)
    expect(after, 'R7: row counts unchanged from before the call').to.deep.equal(before)
  })

  it('R8 (atomic envelope): a fault inside the extension insert leaves no signed session and no Task behind', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt1 = Date.now() + 3_600_000
    const effectiveAtCanon1 = toCanonicalDatetime(effectiveAt1)

    const originalExec = db.exec.bind(db)
    let hitCount = 0
    let faultArmed = true
    db.exec = (async (sql: string, params?: unknown) => {
      if (faultArmed && typeof sql === 'string' && sql.includes('insert into AdminSignatureTaskExtension')) {
        hitCount++
        throw new Error('forced fan-out fault')
      }
      return originalExec(sql as never, params as never)
    }) as typeof db.exec

    let caught: unknown
    try {
      await proposeAdminRoster(fx, {
        effectiveAt: effectiveAt1,
        rosterHolders: fx.holders.slice(0, 3),
        thresholdPolicies: RAD_THRESHOLD_2,
        initiatorUserId: fx.holders[0]!.user.id,
        signerCallback: fx.holders[0]!.sign,
      })
    } catch (err) {
      caught = err
    } finally {
      faultArmed = false
      db.exec = originalExec
    }
    expect(caught, 'R8: proposeAdmin must reject').to.be.instanceOf(Error)
    expect((caught as Error).message, 'R8: the forced fan-out fault must propagate').to.include('forced fan-out fault')
    expect(hitCount, 'R8: the fault must have fired at least once').to.be.at.least(1)

    const digest1 = await computeRadProposalDigest(db, {
      authorityId: fx.authorityId,
      effectiveAt: effectiveAtCanon1,
      officers: await readProposedRosterJson(db, fx.authorityId, effectiveAtCanon1),
      thresholdPolicies: JSON.stringify(RAD_THRESHOLD_2),
    })
    const adminSigningCount = await countRows(db, `select count(*) as n from AdminSigning where Scope = 'rad' and Digest = :digest`, { digest: digest1 })
    expect(adminSigningCount, 'R8: 0 AdminSigning rows with the proposal digest').to.equal(0)
    const officerSigCount1 = await countRows(
      db,
      `select count(*) as n from OfficerSignature OS join AdminSigning A on A.Nonce = OS.SigningNonce where A.AuthorityId = :id and A.Scope = 'rad' and A.Digest = :digest`,
      { id: fx.authorityId, digest: digest1 }
    )
    expect(officerSigCount1, 'R8: 0 OfficerSignature rows for holders[0] on any new rad session').to.equal(0)
    const taskViaExtCount = await countRows(
      db,
      'select count(*) as n from AdminSignatureTaskExtension where AuthorityId = :id and AdminEffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon1 }
    )
    expect(taskViaExtCount, 'R8: 0 Task rows created for this proposal').to.equal(0)

    // The ProposedAdmin row IS present — the proposal rows committed in their own
    // transaction, pre-existing behaviour, asserted and documented, not hidden.
    const proposedAdminCount = await countRows(
      db,
      'select count(*) as n from ProposedAdmin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon1 }
    )
    expect(proposedAdminCount, 'R8: ProposedAdmin IS present (pre-existing behaviour)').to.equal(1)

    const effectiveAt2 = effectiveAt1 + 60_000
    await proposeAdminRoster(fx, {
      effectiveAt: effectiveAt2,
      rosterHolders: fx.holders.slice(0, 3),
      thresholdPolicies: RAD_THRESHOLD_2,
      initiatorUserId: fx.holders[0]!.user.id,
      signerCallback: fx.holders[0]!.sign,
    })
    const effectiveAtCanon2 = toCanonicalDatetime(effectiveAt2)
    const nonce2 = await proposalNonce(db, fx.authorityId, effectiveAtCanon2, RAD_THRESHOLD_2)
    const openUsers2 = await openTaskUsers(db, nonce2)
    expect(openUsers2.length, 'R8: a second proposeAdmin with a NEW EffectiveAt fans out to 3').to.equal(3)
  })

  it('R12 (threshold 1 unchanged): proposeAdmin promotes immediately, invoking the callback exactly twice, with no Task created', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    let callbackCalls = 0
    const countingCallback = async (digest: Uint8Array): Promise<Signature> => {
      callbackCalls++
      return fx.holders[0]!.sign(digest)
    }
    const thresholdPolicies: ThresholdPolicy[] = [{ policy: 'rad' as Scope, threshold: 1 }]

    const { effectiveAtCanon } = await proposeAdminRoster(fx, {
      effectiveAt,
      rosterHolders: fx.holders.slice(0, 3),
      thresholdPolicies,
      initiatorUserId: fx.holders[0]!.user.id,
      signerCallback: countingCallback,
    })

    const adminCount = await countRows(
      db,
      'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    expect(adminCount, 'R12: the Admin row must exist').to.equal(1)
    expect(callbackCalls, 'R12: the callback must be invoked exactly twice').to.equal(2)

    const outcome = (fx.elec.authorityEngine as unknown as { lastPromotionOutcome?: { status: string } }).lastPromotionOutcome
    expect(outcome?.status, 'R12: lastPromotionOutcome.status').to.equal('promoted')

    const nonce = await proposalNonce(db, fx.authorityId, effectiveAtCanon, thresholdPolicies)
    const taskCount = await countRows(db, 'select count(*) as n from Task where SigningNonce = :nonce', { nonce })
    expect(taskCount, 'R12: 0 Task rows exist for the nonce').to.equal(0)
  })

  it('R13 (bare Signature at threshold 2): fan-out never depends on the callback form', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    const effectiveAtCanon = toCanonicalDatetime(effectiveAt)
    const roster = fx.holders.slice(0, 3)
    const rosterScopes = roster.map((h) => Array.from(new Set([...h.scopes, 'rad'])) as Scope[])

    const entries = roster.map((h, i) => ({
      proposedName: h.user.name,
      userId: h.user.id,
      title: `Officer ${i}`,
      scopes: rosterScopes[i]!,
    }))
    const officers = JSON.stringify(sortRosterEntries(entries))
    const digest = await computeRadProposalDigest(db, {
      authorityId: fx.authorityId,
      effectiveAt: effectiveAtCanon,
      officers,
      thresholdPolicies: JSON.stringify(RAD_THRESHOLD_2),
    })
    const signature = await fx.holders[0]!.sign(digestToBytes(digest))

    const proposal: Proposal<AdminInit> = {
      proposed: {
        officers: roster.map((h, i) => ({
          existing: { userId: h.user.id, authorityId: fx.authorityId, title: `Officer ${i}`, scopes: rosterScopes[i]! },
        })),
        effectiveAt,
        thresholdPolicies: RAD_THRESHOLD_2,
      },
      signers: [fx.holders[0]!.user.id],
    }
    await fx.elec.authorityEngine.proposeAdmin(proposal, signature)

    const nonce = await proposalNonce(db, fx.authorityId, effectiveAtCanon, RAD_THRESHOLD_2)
    const expectedOpen = [fx.holders[1]!.user.id, fx.holders[2]!.user.id, fx.holders[3]!.user.id].sort()
    const openUsers = await openTaskUsers(db, nonce)
    expect(openUsers, 'R13: fans out to holders[1..3]').to.deep.equal(expectedOpen)

    const outcome = (fx.elec.authorityEngine as unknown as { lastPromotionOutcome?: { status: string } }).lastPromotionOutcome
    expect(outcome?.status, 'R13: lastPromotionOutcome.status').to.equal('awaiting-co-signers')
  })

  it('R14 (non-holder initiator): a non-holder officer fans out to all current holders; its own signature is not counted', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000

    // proposeAdmin's ProposedAdmin insert is a Class A IsUserValid site (verify-user-key.ts):
    // it requires a REAL UserKey row for whoever signs. createThresholdAuthority now registers
    // every fixture user's key (signer CHECKs require it), so the nonHolder needs no priming.

    const { effectiveAtCanon } = await proposeAdminRoster(fx, {
      effectiveAt,
      rosterHolders: fx.holders.slice(0, 3),
      thresholdPolicies: RAD_THRESHOLD_2,
      initiatorUserId: fx.nonHolder.user.id,
      signerCallback: fx.nonHolder.sign,
    })
    const nonce = await proposalNonce(db, fx.authorityId, effectiveAtCanon, RAD_THRESHOLD_2)

    const expectedOpen = fx.holders.map((h) => h.user.id).sort()
    const openUsers = await openTaskUsers(db, nonce)
    expect(openUsers, 'R14: all 4 current holders get a Task').to.deep.equal(expectedOpen)

    const status = await new SigningEngine(fx.elec.ctx).getSigningStatus(nonce)
    expect(status?.signatures, "R14: the non-holder initiator's own signature is not counted").to.equal(0)
  })
})

describe('rad Trigger B: co-sign end to end (D-08..D-12, D-33)', function () {
  this.timeout(60_000)

  /** holders[0] proposes holders[0..2] at rad threshold 2 (Task 2's own fan-out). */
  async function setupStandardProposal (
    fx: ThresholdAuthorityFixture,
    effectiveAt: number
  ): Promise<{ effectiveAtCanon: string; nonce: string; roster: ThresholdAuthorityFixture['holders'] }> {
    const roster = fx.holders.slice(0, 3)
    const { effectiveAtCanon } = await proposeAdminRoster(fx, {
      effectiveAt,
      rosterHolders: roster,
      thresholdPolicies: RAD_THRESHOLD_2,
      initiatorUserId: fx.holders[0]!.user.id,
      signerCallback: fx.holders[0]!.sign,
    })
    const nonce = await proposalNonce(fx.elec.ctx.db, fx.authorityId, effectiveAtCanon, RAD_THRESHOLD_2)
    return { effectiveAtCanon, nonce, roster }
  }

  /** Propose, then have holders[1] accept and cross the threshold — the common "after R2" setup
   *  R3/R9a's retry step/R10 build on. */
  async function proposeAndCross (
    fx: ThresholdAuthorityFixture,
    effectiveAt: number
  ): Promise<{ effectiveAtCanon: string; nonce: string }> {
    const { effectiveAtCanon, nonce } = await setupStandardProposal(fx, effectiveAt)
    const { engine, task } = await adminTaskFor(fx, fx.holders[1]!, effectiveAtCanon)
    const digest = await engine.getSignatureDigest(task)
    await engine.completeSignature(task, {
      isAccepted: true,
      signature: await fx.holders[1]!.sign(digest),
      sign: fx.holders[1]!.sign,
    })
    return { effectiveAtCanon, nonce }
  }

  it('R2 (crossing, D-33 end to end, D-09): the second holder crosses the threshold and promotes through the single promotion session', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    const { effectiveAtCanon, nonce, roster } = await setupStandardProposal(fx, effectiveAt)

    const { engine, task } = await adminTaskFor(fx, fx.holders[1]!, effectiveAtCanon)
    expect(task.authority?.id, "R2: holders[1]'s task authority.id").to.equal(fx.authorityId)
    expect(task.administration?.proposed?.effectiveAt, "R2: holders[1]'s task proposed effectiveAt").to.equal(effectiveAtCanon)

    const digest = await engine.getSignatureDigest(task)
    const expectedDigest = digestToBytes(
      await computeRadProposalDigest(db, {
        authorityId: fx.authorityId,
        effectiveAt: effectiveAtCanon,
        officers: await readProposedRosterJson(db, fx.authorityId, effectiveAtCanon),
        thresholdPolicies: JSON.stringify(RAD_THRESHOLD_2),
      })
    )
    expect(Buffer.from(digest).equals(Buffer.from(expectedDigest)), 'R2: getSignatureDigest byte-equals the proposal digest').to.equal(true)

    const radNoncesBefore = new Set<string>()
    for await (const row of db.eval(`select Nonce from AdminSigning where AuthorityId = :id and Scope = 'rad'`, { id: fx.authorityId })) {
      radNoncesBefore.add(row.Nonce as string)
    }

    let signCalls = 0
    const countingSign = async (d: Uint8Array): Promise<Signature> => {
      signCalls++
      return fx.holders[1]!.sign(d)
    }
    await engine.completeSignature(task, { isAccepted: true, signature: await fx.holders[1]!.sign(digest), sign: countingSign })

    const adminSigCount = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
    expect(adminSigCount, 'R2: exactly 1 AdminSignature on the proposal nonce').to.equal(1)

    const adminCount = await countRows(
      db,
      'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    expect(adminCount, 'R2: the Admin row exists at the proposed EffectiveAt').to.equal(1)

    const officerRows: Array<{ UserId: string; Title: string; Scopes: string }> = []
    for await (const row of db.eval(
      'select UserId, Title, Scopes from Officer where AuthorityId = :id and AdminEffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )) {
      officerRows.push({ UserId: row.UserId as string, Title: row.Title as string, Scopes: row.Scopes as string })
    }
    const actual = officerRows
      .map((r) => ({ userId: r.UserId, title: r.Title, scopes: (JSON.parse(r.Scopes) as string[]).slice().sort() }))
      .sort((a, b) => (a.userId < b.userId ? -1 : 1))
    const expected = roster
      .map((h, i) => ({
        userId: h.user.id,
        title: `Officer ${i}`,
        scopes: Array.from(new Set([...h.scopes, 'rad'])).slice().sort(),
      }))
      .sort((a, b) => (a.userId < b.userId ? -1 : 1))
    expect(actual, 'R2: the Officer rows equal the roster').to.deep.equal(expected)

    const radNoncesAfter: string[] = []
    for await (const row of db.eval(`select Nonce from AdminSigning where AuthorityId = :id and Scope = 'rad'`, { id: fx.authorityId })) {
      radNoncesAfter.push(row.Nonce as string)
    }
    const newNonces = radNoncesAfter.filter((n) => !radNoncesBefore.has(n))
    expect(newNonces.length, "R2: the 'rad' AdminSigning count rose by exactly 1 (the promotion session)").to.equal(1)
    const promotionAdminSigCount = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce: newNonces[0]! })
    expect(promotionAdminSigCount, 'R2: the promotion session has an AdminSignature').to.equal(1)

    expect(signCalls, "R2: holders[1]'s sign counter is exactly 1").to.equal(1)

    const task1Row = await db
      .prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId')
      .get({ nonce, userId: fx.holders[1]!.user.id })
    expect(Number(task1Row?.IsCompleted), "R2: holders[1]'s Task is completed").to.equal(1)
    const openUsers = await openTaskUsers(db, nonce)
    expect(openUsers, 'R2: holders[2] and holders[3] Tasks are still open').to.deep.equal(
      [fx.holders[2]!.user.id, fx.holders[3]!.user.id].sort()
    )
  })

  it('R3 (late, D-10): a late co-signature is recorded and never re-enters promotion', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const effectiveAt = Date.now() + 3_600_000
    const { effectiveAtCanon, nonce } = await proposeAndCross(fx, effectiveAt)
    const db = fx.elec.ctx.db

    const radAdminSigningCountBeforeLate = await countRows(
      db,
      `select count(*) as n from AdminSigning where AuthorityId = :id and Scope = 'rad'`,
      { id: fx.authorityId }
    )

    let promotionCalls = 0
    const originalApply = AuthorityEngine.prototype.applyAdminProposal
    AuthorityEngine.prototype.applyAdminProposal = async function (
      this: AuthorityEngine,
      ...args: Parameters<typeof originalApply>
    ) {
      promotionCalls++
      return originalApply.apply(this, args)
    } as typeof originalApply

    let signCalls = 0
    const countingSign = async (d: Uint8Array): Promise<Signature> => {
      signCalls++
      return fx.holders[2]!.sign(d)
    }

    let caught: unknown
    try {
      const { engine, task } = await adminTaskFor(fx, fx.holders[2]!, effectiveAtCanon)
      const digest = await engine.getSignatureDigest(task)
      await engine.completeSignature(task, {
        isAccepted: true,
        signature: await fx.holders[2]!.sign(digest),
        sign: countingSign,
      })
    } catch (err) {
      caught = err
    } finally {
      AuthorityEngine.prototype.applyAdminProposal = originalApply
    }
    expect(caught, `R3: the late accept must not throw — got: ${caught instanceof Error ? caught.message : String(caught)}`).to.be.undefined

    const officerSigCount = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })
    expect(officerSigCount, 'R3: 3 OfficerSignature rows').to.equal(3)
    const adminSigCount = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
    expect(adminSigCount, 'R3: 1 AdminSignature').to.equal(1)
    const adminCount = await countRows(
      db,
      'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    expect(adminCount, 'R3: Admin count unchanged (still 1)').to.equal(1)
    const officerCount = await countRows(
      db,
      'select count(*) as n from Officer where AuthorityId = :id and AdminEffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    expect(officerCount, 'R3: Officer count unchanged (still 3)').to.equal(3)
    const radAdminSigningCountAfterLate = await countRows(
      db,
      `select count(*) as n from AdminSigning where AuthorityId = :id and Scope = 'rad'`,
      { id: fx.authorityId }
    )
    expect(radAdminSigningCountAfterLate, "R3: 'rad' AdminSigning count unchanged from before the late accept").to.equal(
      radAdminSigningCountBeforeLate
    )
    expect(promotionCalls, 'R3: applyAdminProposal must not be re-invoked').to.equal(0)
    expect(signCalls, 'R3: the sign callback must not be invoked').to.equal(0)
    const task2Row = await db
      .prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId')
      .get({ nonce, userId: fx.holders[2]!.user.id })
    expect(Number(task2Row?.IsCompleted), "R3: holders[2]'s Task is completed").to.equal(1)
    // R0b's RED pin now passes — the applyAdminProposal counter it asserts equals exactly 1.
  })

  it('R4 (D-11 no veto): a rejection is a recorded vote, not a terminal state; a later accept still crosses', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    const { effectiveAtCanon, nonce } = await setupStandardProposal(fx, effectiveAt)

    const { engine: engine1, task: task1 } = await adminTaskFor(fx, fx.holders[1]!, effectiveAtCanon)
    await engine1.completeSignature(task1, {
      isAccepted: false,
      signature: { signature: '', signerKey: '', signerUserId: '' },
    })

    const statusAfterReject = await new SigningEngine(fx.elec.ctx).getSigningStatus(nonce)
    expect(statusAfterReject?.rejected, 'R4: rejected 1').to.equal(1)
    expect(statusAfterReject?.unreachable, 'R4: not unreachable yet').to.equal(false)
    expect(statusAfterReject?.reached, 'R4: not reached').to.equal(false)
    const adminCountAfterReject = await countRows(
      db,
      'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    expect(adminCountAfterReject, 'R4: no Admin row after the rejection').to.equal(0)

    const { engine: engine2, task: task2 } = await adminTaskFor(fx, fx.holders[2]!, effectiveAtCanon)
    const digest2 = await engine2.getSignatureDigest(task2)
    await engine2.completeSignature(task2, {
      isAccepted: true,
      signature: await fx.holders[2]!.sign(digest2),
      sign: fx.holders[2]!.sign,
    })
    const adminCountAfterAccept = await countRows(
      db,
      'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    expect(adminCountAfterAccept, 'R4: the Admin row exists after holders[2] crosses').to.equal(1)
  })

  it('R5 (D-11 unreachable): every holder rejecting makes the session unreachable, never crossed', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    const { effectiveAtCanon, nonce } = await setupStandardProposal(fx, effectiveAt)

    for (const holder of [fx.holders[1]!, fx.holders[2]!, fx.holders[3]!]) {
      const { engine, task } = await adminTaskFor(fx, holder, effectiveAtCanon)
      await engine.completeSignature(task, {
        isAccepted: false,
        signature: { signature: '', signerKey: '', signerUserId: '' },
      })
    }

    const status = await new SigningEngine(fx.elec.ctx).getSigningStatus(nonce)
    expect(status?.signatures, 'R5: signatures 1 (holders[0] only)').to.equal(1)
    expect(status?.openTasks, 'R5: openTasks 0').to.equal(0)
    expect(status?.unreachable, 'R5: unreachable true').to.equal(true)
    expect(status?.reached, 'R5: reached false').to.equal(false)

    const adminCount = await countRows(
      db,
      'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    expect(adminCount, 'R5: 0 Admin rows').to.equal(0)
    const adminSigCount = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
    expect(adminSigCount, 'R5: 0 AdminSignature on the nonce').to.equal(0)
  })

  it('R9a (non-promotion fault rolls back; a retry crosses cleanly)', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    const { effectiveAtCanon, nonce } = await setupStandardProposal(fx, effectiveAt)

    const originalApply = AuthorityEngine.prototype.applyAdminProposal
    let firstCall = true
    AuthorityEngine.prototype.applyAdminProposal = async function (
      this: AuthorityEngine,
      ...args: Parameters<typeof originalApply>
    ) {
      if (firstCall) {
        firstCall = false
        throw new Error('forced promotion fault')
      }
      return originalApply.apply(this, args)
    } as typeof originalApply

    try {
      const { engine, task } = await adminTaskFor(fx, fx.holders[1]!, effectiveAtCanon)
      const digest = await engine.getSignatureDigest(task)
      let caught: unknown
      try {
        await engine.completeSignature(task, {
          isAccepted: true,
          signature: await fx.holders[1]!.sign(digest),
          sign: fx.holders[1]!.sign,
        })
      } catch (err) {
        caught = err
      }
      expect(caught, 'R9a: the first (faulted) accept must reject').to.be.instanceOf(Error)
      expect((caught as Error).message, 'R9a: forced promotion fault must propagate').to.include('forced promotion fault')

      const adminSigCountAfterFault = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
      expect(adminSigCountAfterFault, 'R9a: 0 AdminSignature rows — the composed transaction rolled back').to.equal(0)
      const officerSigRow = await db
        .prepare('select 1 as x from OfficerSignature where SigningNonce = :nonce and UserId = :userId')
        .get({ nonce, userId: fx.holders[1]!.user.id })
      expect(officerSigRow, "R9a: holders[1] has no OfficerSignature — rolled back").to.equal(undefined)
      const task1RowAfterFault = await db
        .prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId')
        .get({ nonce, userId: fx.holders[1]!.user.id })
      expect(Number(task1RowAfterFault?.IsCompleted), "R9a: holders[1]'s Task is still open").to.equal(0)

      // Retry: the second call succeeds and crosses.
      const { engine: retryEngine, task: retryTask } = await adminTaskFor(fx, fx.holders[1]!, effectiveAtCanon)
      const retryDigest = await retryEngine.getSignatureDigest(retryTask)
      await retryEngine.completeSignature(retryTask, {
        isAccepted: true,
        signature: await fx.holders[1]!.sign(retryDigest),
        sign: fx.holders[1]!.sign,
      })
      const adminCount = await countRows(
        db,
        'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
        { id: fx.authorityId, e: effectiveAtCanon }
      )
      expect(adminCount, 'R9a: the Admin row exists after the retry').to.equal(1)
    } finally {
      AuthorityEngine.prototype.applyAdminProposal = originalApply
    }
  })

  it('R9b (resumable after a refused promotion): the next accept re-attempts and completes it', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    const { effectiveAtCanon, nonce } = await setupStandardProposal(fx, effectiveAt)

    const originalApply = AuthorityEngine.prototype.applyAdminProposal
    let promotionCalls = 0
    let firstCall = true
    AuthorityEngine.prototype.applyAdminProposal = async function (
      this: AuthorityEngine,
      ...args: Parameters<typeof originalApply>
    ) {
      promotionCalls++
      if (firstCall) {
        firstCall = false
        throw new AdminPromotionError('unresolvable-officer', args[0] as string)
      }
      return originalApply.apply(this, args)
    } as typeof originalApply

    try {
      const { engine: engine1, task: task1 } = await adminTaskFor(fx, fx.holders[1]!, effectiveAtCanon)
      const digest1 = await engine1.getSignatureDigest(task1)
      let caught: unknown
      try {
        await engine1.completeSignature(task1, {
          isAccepted: true,
          signature: await fx.holders[1]!.sign(digest1),
          sign: fx.holders[1]!.sign,
        })
      } catch (err) {
        caught = err
      }
      expect(caught, 'R9b: the refused-promotion accept must not throw — the signature still commits').to.be.undefined

      const adminSigCount1 = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
      expect(adminSigCount1, 'R9b: AdminSignature is 1 after the refused promotion').to.equal(1)
      const adminCount1 = await countRows(
        db,
        'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
        { id: fx.authorityId, e: effectiveAtCanon }
      )
      expect(adminCount1, 'R9b: no Admin row yet').to.equal(0)
      const task1Row = await db
        .prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId')
        .get({ nonce, userId: fx.holders[1]!.user.id })
      expect(Number(task1Row?.IsCompleted), "R9b: holders[1]'s Task is completed").to.equal(1)

      // holders[2]: threshold is reached, Admin row missing — promotion is re-attempted.
      const { engine: engine2, task: task2 } = await adminTaskFor(fx, fx.holders[2]!, effectiveAtCanon)
      const digest2 = await engine2.getSignatureDigest(task2)
      await engine2.completeSignature(task2, {
        isAccepted: true,
        signature: await fx.holders[2]!.sign(digest2),
        sign: fx.holders[2]!.sign,
      })
      const adminCount2 = await countRows(
        db,
        'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
        { id: fx.authorityId, e: effectiveAtCanon }
      )
      expect(adminCount2, 'R9b: the Admin row exists after the re-attempt').to.equal(1)
      expect(promotionCalls, 'R9b: applyAdminProposal was called exactly twice').to.equal(2)
    } finally {
      AuthorityEngine.prototype.applyAdminProposal = originalApply
    }
  })

  it('R10 (idempotency, second defence): a direct re-invocation of applyAdminProposal after promotion is a no-op', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    const { effectiveAtCanon, nonce } = await proposeAndCross(fx, effectiveAt)

    const adminCountBefore = await countRows(
      db,
      'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    const officerCountBefore = await countRows(
      db,
      'select count(*) as n from Officer where AuthorityId = :id and AdminEffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    const radAdminSigningCountBefore = await countRows(
      db,
      `select count(*) as n from AdminSigning where AuthorityId = :id and Scope = 'rad'`,
      { id: fx.authorityId }
    )

    let signCalls = 0
    const countingSign = async (d: Uint8Array): Promise<Signature> => {
      signCalls++
      return fx.holders[1]!.sign(d)
    }
    const authorityDetails = await fx.elec.authorityEngine.getDetails()
    const result = await new AuthorityEngine(authorityDetails.authority, fx.elec.ctx).applyAdminProposal(nonce, countingSign)
    expect(result.alreadyApplied, 'R10: alreadyApplied must be true').to.equal(true)

    const adminCountAfter = await countRows(
      db,
      'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    expect(adminCountAfter, 'R10: Admin count unchanged').to.equal(adminCountBefore)
    const officerCountAfter = await countRows(
      db,
      'select count(*) as n from Officer where AuthorityId = :id and AdminEffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    expect(officerCountAfter, 'R10: Officer count unchanged').to.equal(officerCountBefore)
    const radAdminSigningCountAfter = await countRows(
      db,
      `select count(*) as n from AdminSigning where AuthorityId = :id and Scope = 'rad'`,
      { id: fx.authorityId }
    )
    expect(radAdminSigningCountAfter, "R10: 'rad' AdminSigning count unchanged").to.equal(radAdminSigningCountBefore)
    expect(signCalls, 'R10: the sign counter was not invoked').to.equal(0)
  })

  it('R11 (disambiguation): an officer with two open admin tasks always signs the proposal its task names', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt1 = Date.now() + 3_600_000
    const effectiveAt2 = Date.now() + 7_200_000

    // P1: holders[0] proposes, holders[1] crosses — holders[2]/[3] keep open P1 siblings.
    const { effectiveAtCanon: effectiveAtCanon1, nonce: nonce1 } = await setupStandardProposal(fx, effectiveAt1)
    const { engine: engine1, task: task1 } = await adminTaskFor(fx, fx.holders[1]!, effectiveAtCanon1)
    const digest1 = await engine1.getSignatureDigest(task1)
    await engine1.completeSignature(task1, {
      isAccepted: true,
      signature: await fx.holders[1]!.sign(digest1),
      sign: fx.holders[1]!.sign,
    })

    // P2: a second proposal, a new EffectiveAt.
    const { effectiveAtCanon: effectiveAtCanon2, nonce: nonce2 } = await setupStandardProposal(fx, effectiveAt2)

    // holders[2] now has two open admin tasks (P1 and P2).
    const { engine: engine2, task: p2Task } = await adminTaskFor(fx, fx.holders[2]!, effectiveAtCanon2)
    const p2Digest = await engine2.getSignatureDigest(p2Task)
    const expectedP2Digest = digestToBytes(
      await computeRadProposalDigest(db, {
        authorityId: fx.authorityId,
        effectiveAt: effectiveAtCanon2,
        officers: await readProposedRosterJson(db, fx.authorityId, effectiveAtCanon2),
        thresholdPolicies: JSON.stringify(RAD_THRESHOLD_2),
      })
    )
    expect(Buffer.from(p2Digest).equals(Buffer.from(expectedP2Digest)), "R11: holders[2]'s P2 task digest equals P2's proposal digest").to.equal(true)
    const p2Status = await engine2.getTaskSigningStatus(p2Task)
    expect(p2Status?.nonce, "R11: getTaskSigningStatus(P2 task).nonce equals P2's nonce").to.equal(nonce2)

    const p1OfficerSigCountBefore = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce: nonce1 })
    const p2OfficerSigCountBefore = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce: nonce2 })

    await engine2.completeSignature(p2Task, {
      isAccepted: true,
      signature: await fx.holders[2]!.sign(p2Digest),
      sign: fx.holders[2]!.sign,
    })
    const p2OfficerSigCount = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce: nonce2 })
    expect(p2OfficerSigCount - p2OfficerSigCountBefore, "R11: the new OfficerSignature is on P2's nonce").to.equal(1)
    const p1OfficerSigCount = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce: nonce1 })
    expect(p1OfficerSigCount, "R11: P1's OfficerSignature count is unchanged").to.equal(p1OfficerSigCountBefore)
    const p1TaskRow = await db
      .prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId')
      .get({ nonce: nonce1, userId: fx.holders[2]!.user.id })
    expect(Number(p1TaskRow?.IsCompleted), "R11: holders[2]'s P1 Task is still open").to.equal(0)

    // Repeat with the task order reversed, for holders[3]: accept the P1 task first, then P2.
    const { engine: engine3p1, task: p1Task3 } = await adminTaskFor(fx, fx.holders[3]!, effectiveAtCanon1)
    const p1Digest3 = await engine3p1.getSignatureDigest(p1Task3)
    await engine3p1.completeSignature(p1Task3, {
      isAccepted: true,
      signature: await fx.holders[3]!.sign(p1Digest3),
      sign: fx.holders[3]!.sign,
    })
    const { engine: engine3p2, task: p2Task3 } = await adminTaskFor(fx, fx.holders[3]!, effectiveAtCanon2)
    const p2Digest3 = await engine3p2.getSignatureDigest(p2Task3)
    await engine3p2.completeSignature(p2Task3, {
      isAccepted: true,
      signature: await fx.holders[3]!.sign(p2Digest3),
      sign: fx.holders[3]!.sign,
    })
    const nonce1SigRow = await db
      .prepare('select 1 as x from OfficerSignature where SigningNonce = :nonce and UserId = :userId')
      .get({ nonce: nonce1, userId: fx.holders[3]!.user.id })
    expect(nonce1SigRow, "R11: holders[3]'s P1 accept resolved P1's own nonce").to.not.equal(undefined)
    const nonce2SigRow = await db
      .prepare('select 1 as x from OfficerSignature where SigningNonce = :nonce and UserId = :userId')
      .get({ nonce: nonce2, userId: fx.holders[3]!.user.id })
    expect(nonce2SigRow, "R11: holders[3]'s P2 accept resolved P2's own nonce").to.not.equal(undefined)
  })
})

export {
  makeNetworkRef,
  engineFor,
  countRows,
  openTaskUsers,
  proposalNonce,
  adminTaskFor,
  proposeAdminRoster,
  RAD_THRESHOLD_2,
}
export type { ProposeArgs }
