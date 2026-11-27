import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { ElectionEngine } from '../src/election/election-engine.js'
import { SigningEngine } from '../src/signing/signing-engine.js'
import { fanOutSignatureTasks } from '../src/signing/fan-out.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import {
  createThresholdAuthority,
  insertBallotHeaderSession,
  ballotExtensionInserter,
  type ThresholdAuthorityFixture,
} from './fixtures/threshold-authority.js'
import { seedProposedBallot } from './fixtures/test-context.js'

/**
 * threshold-ceb.spec.ts — 62-11 (D-08..D-12): ballot-confirmation (`ceb`) threshold-2
 * end-to-end wiring. The first describe pins the CONTEXT "Specific Ideas" defect
 * (RED on the unmodified engine): at ceb threshold 2, the first accept commits its
 * OfficerSignature, then `finalizeBallot` throws on `Ballot.MutationValid` (no
 * AdminSignature yet), and the Task is left open.
 */

function makeNetworkRef () {
  return {
    hash: 'test-threshold-ceb-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

function engineFor (fx: ThresholdAuthorityFixture, holder: ThresholdAuthorityFixture['holders'][number]): SignatureTasksEngine {
  return new SignatureTasksEngine(makeNetworkRef(), { db: fx.elec.ctx.db, user: holder.user })
}

async function countRows (db: Database, sql: string, params: Record<string, unknown> = {}): Promise<number> {
  const row = await db.prepare(sql).get(params as Record<string, unknown>)
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

async function headerNonceForBallot (db: Database, ballotId: string): Promise<string> {
  const row = await db
    .prepare(
      `select Task.SigningNonce from Task
         join BallotSignatureTaskExtension E on E.TaskId = Task.Id
         where E.BallotId = :ballotId
         limit 1`
    )
    .get({ ballotId })
  if (!row) throw new Error(`headerNonceForBallot: no Task for ballotId=${ballotId}`)
  return row.SigningNonce as string
}

async function electionIdForBallot (db: Database, ballotId: string): Promise<string> {
  const row = await db.prepare('select ElectionId from ProposedBallot where Id = :ballotId').get({ ballotId })
  if (!row) throw new Error(`electionIdForBallot: no ProposedBallot for ballotId=${ballotId}`)
  return row.ElectionId as string
}

/** Build an ElectionEngine over a specific holder's own ctx.user — mirrors how
 *  `addTestElection`'s own `elec.electionEngine` is constructed (ElectionsEngine.openElection),
 *  but for a NON-founder holder whose ctx.user must be their own. */
async function electionEngineFor (
  fx: ThresholdAuthorityFixture,
  holder: ThresholdAuthorityFixture['holders'][number],
  ballotId: string
): Promise<ElectionEngine> {
  const electionId = await electionIdForBallot(fx.elec.ctx.db, ballotId)
  return new ElectionEngine({ id: electionId, authorityId: fx.authorityId }, { db: fx.elec.ctx.db, user: holder.user })
}

describe('threshold-2 first accept (ceb, RED pin)', function () {
  this.timeout(60_000)

  it('C0: at ceb threshold 2, the first accept records the signature and leaves the Task open — does not throw, mints no Ballot', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'tb-c0')

    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    await fanOutSignatureTasks(fx.elec.ctx, {
      authorityId: fx.authorityId,
      scope: 'ceb',
      nonce,
      initiatorUserId: null,
      signatureType: 'ballot',
      taskTid: await allocateTid(db, 'election'),
      insertExtension: ballotExtensionInserter(db, ballotId),
    })

    const engine = engineFor(fx, fx.holders[0]!)
    const tasks = await engine.getRequestedSignatures(true)
    const task = tasks.find(
      (t) => t.signatureType === 'ballot' && (t as any).ballot?.proposed?.id === ballotId
    )
    expect(task, 'holders[0] must have a pending ballot task').to.not.be.undefined

    const digest = await engine.getSignatureDigest(task!)
    const signature = await fx.holders[0]!.sign(digest)

    let caught: unknown
    try {
      await engine.completeSignature(task!, { isAccepted: true, signature, sign: fx.holders[0]!.sign })
    } catch (err) {
      caught = err
    }
    expect(caught, `the accept must not throw — got: ${caught instanceof Error ? caught.message : String(caught)}`).to.be.undefined

    const officerCount = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })
    expect(officerCount, 'exactly 1 OfficerSignature').to.equal(1)
    const adminCount = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
    expect(adminCount, '0 AdminSignature at threshold 2 after only 1 accept').to.equal(0)

    const ballotCount = await countRows(db, 'select count(*) as n from Ballot where Id = :id', { id: ballotId })
    expect(ballotCount, '0 Ballot rows — the session has not reached its threshold').to.equal(0)

    const holder0TaskRow = await db
      .prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId')
      .get({ nonce, userId: fx.holders[0]!.user.id })
    expect(Number(holder0TaskRow?.IsCompleted), "holders[0]'s Task must be completed").to.equal(1)

    const openUsers = await openTaskUsers(db, nonce)
    const expectedOpen = [fx.holders[1]!.user.id, fx.holders[2]!.user.id, fx.holders[3]!.user.id].sort()
    expect(openUsers, 'holders[1..3] still have open Tasks').to.deep.equal(expectedOpen)
  })
})

/** Task.Id for a specific (nonce, userId) pair — used by C11 to resolve a completed holder's
 *  own Task id directly (its own row stays IsCompleted=1, not deleted). */
async function taskIdFor (db: Database, nonce: string, userId: string): Promise<string> {
  const row = await db.prepare('select Id from Task where SigningNonce = :nonce and UserId = :userId').get({ nonce, userId })
  if (!row) throw new Error(`taskIdFor: no Task for nonce=${nonce} userId=${userId}`)
  return row.Id as string
}

/** Count of AdminSignature rows for derived (Question/Option) ceb sessions at `authorityId`,
 *  EXCLUDING the header nonce itself — C2/C3/C11's "signDerived actually wrote" probe. */
async function derivedCebAdminSignatureCount (db: Database, authorityId: string, headerNonce: string): Promise<number> {
  return countRows(
    db,
    `select count(*) as n from AdminSignature S
       join AdminSigning A on A.Nonce = S.SigningNonce
       where A.AuthorityId = :authorityId and A.Scope = 'ceb' and A.Nonce != :headerNonce`,
    { authorityId, headerNonce }
  )
}

describe('ceb threshold-2 end to end (D-08..D-12)', function () {
  this.timeout(60_000)

  it('C1 (D-08): submit at threshold 2 records the proposer signature and fans out to every other holder', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'tb-c1')

    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)
    const nonce = await headerNonceForBallot(db, ballotId)

    const officerRows: Array<{ UserId: string }> = []
    for await (const row of db.eval('select UserId from OfficerSignature where SigningNonce = :nonce', { nonce })) {
      officerRows.push({ UserId: row.UserId as string })
    }
    expect(officerRows.length, 'exactly 1 OfficerSignature').to.equal(1)
    expect(officerRows[0]!.UserId).to.equal(fx.holders[0]!.user.id)
    expect(await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })).to.equal(0)

    const openUsers = await openTaskUsers(db, nonce)
    expect(openUsers).to.deep.equal([fx.holders[1]!.user.id, fx.holders[2]!.user.id, fx.holders[3]!.user.id].sort())
    for (const nonRecipient of [fx.holders[0]!.user.id, fx.nonHolder.user.id, fx.outsider.id]) {
      expect(
        await countRows(db, 'select count(*) as n from Task where SigningNonce = :nonce and UserId = :userId', { nonce, userId: nonRecipient }),
        `no Task for ${nonRecipient}`
      ).to.equal(0)
    }

    const state = await fx.elec.electionEngine.getBallotConfirmationState(ballotId)
    // gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
    expect(state).to.deep.equal({ locked: true, confirmed: false, canWithdraw: true, ownTaskOpen: false })
  })

  it('C2 (D-10 crossing + D-09 + derived sessions): the second accept finalizes exactly once', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'tb-c2')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)
    const nonce = await headerNonceForBallot(db, ballotId)

    const engine1 = engineFor(fx, fx.holders[1]!)
    const task1 = (await engine1.getRequestedSignatures(true)).find(
      (t) => t.signatureType === 'ballot' && (t as any).ballot?.proposed?.id === ballotId
    )!
    await engine1.completeSignature(task1, {
      isAccepted: true,
      signature: await fx.holders[1]!.sign(await engine1.getSignatureDigest(task1)),
      sign: fx.holders[1]!.sign,
    })

    expect(await countRows(db, 'select count(*) as n from Ballot where Id = :id', { id: ballotId })).to.equal(1)
    expect(await countRows(db, 'select count(*) as n from Question where BallotId = :id', { id: ballotId })).to.equal(1)
    expect(await countRows(db, 'select count(*) as n from Option where BallotId = :id', { id: ballotId })).to.equal(2)
    expect(await derivedCebAdminSignatureCount(db, fx.authorityId, nonce), 'signDerived wrote 1 AdminSignature per Question+Option').to.equal(3)

    const holder1TaskRow = await db.prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId').get({ nonce, userId: fx.holders[1]!.user.id })
    expect(Number(holder1TaskRow?.IsCompleted)).to.equal(1)
    expect(await openTaskUsers(db, nonce)).to.deep.equal([fx.holders[2]!.user.id, fx.holders[3]!.user.id].sort())

    const state = await fx.elec.electionEngine.getBallotConfirmationState(ballotId)
    // gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
    expect(state).to.deep.equal({ locked: false, confirmed: true, canWithdraw: false, ownTaskOpen: false })
  })

  it('C3 (D-10 late signature): a third accept after crossing is recorded, re-finalizes nothing', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'tb-c3')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)
    const nonce = await headerNonceForBallot(db, ballotId)

    const engine1 = engineFor(fx, fx.holders[1]!)
    const task1 = (await engine1.getRequestedSignatures(true)).find((t) => t.signatureType === 'ballot')!
    await engine1.completeSignature(task1, {
      isAccepted: true,
      signature: await fx.holders[1]!.sign(await engine1.getSignatureDigest(task1)),
      sign: fx.holders[1]!.sign,
    })

    const engine2 = engineFor(fx, fx.holders[2]!)
    const task2 = (await engine2.getRequestedSignatures(true)).find((t) => t.signatureType === 'ballot')!
    let caught: unknown
    try {
      await engine2.completeSignature(task2, {
        isAccepted: true,
        signature: await fx.holders[2]!.sign(await engine2.getSignatureDigest(task2)),
        sign: fx.holders[2]!.sign,
      })
    } catch (err) {
      caught = err
    }
    expect(caught, `a late accept must not throw — got: ${caught instanceof Error ? caught.message : String(caught)}`).to.be.undefined

    expect(await countRows(db, 'select count(*) as n from Ballot where Id = :id', { id: ballotId })).to.equal(1)
    expect(await countRows(db, 'select count(*) as n from Question where BallotId = :id', { id: ballotId })).to.equal(1)
    expect(await countRows(db, 'select count(*) as n from Option where BallotId = :id', { id: ballotId })).to.equal(2)
    expect(await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })).to.equal(3)
    expect(await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })).to.equal(1)

    const holder2TaskRow = await db.prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId').get({ nonce, userId: fx.holders[2]!.user.id })
    expect(Number(holder2TaskRow?.IsCompleted)).to.equal(1)
  })

  it('C4 (D-11 no veto): a rejection is a vote, not a veto — the session still crosses', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'tb-c4')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)
    const nonce = await headerNonceForBallot(db, ballotId)

    const engine1 = engineFor(fx, fx.holders[1]!)
    const task1 = (await engine1.getRequestedSignatures(true)).find((t) => t.signatureType === 'ballot')!
    await engine1.completeSignature(task1, {
      isAccepted: false,
      signature: { signature: '', signerKey: '', signerUserId: '' },
    })

    const status = await new SigningEngine(fx.elec.ctx).getSigningStatus(nonce)
    expect(status?.rejected).to.equal(1)
    expect(status?.unreachable).to.equal(false)
    expect(status?.reached).to.equal(false)

    const engine2 = engineFor(fx, fx.holders[2]!)
    const task2 = (await engine2.getRequestedSignatures(true)).find((t) => t.signatureType === 'ballot')!
    await engine2.completeSignature(task2, {
      isAccepted: true,
      signature: await fx.holders[2]!.sign(await engine2.getSignatureDigest(task2)),
      sign: fx.holders[2]!.sign,
    })

    expect(await countRows(db, 'select count(*) as n from Ballot where Id = :id', { id: ballotId })).to.equal(1)
  })

  it('C5 (D-11 unreachable): every other holder rejects — the session is unreachable, not reached', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'tb-c5')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)
    const nonce = await headerNonceForBallot(db, ballotId)

    for (const holder of [fx.holders[1]!, fx.holders[2]!, fx.holders[3]!]) {
      const engine = engineFor(fx, holder)
      const task = (await engine.getRequestedSignatures(true)).find((t) => t.signatureType === 'ballot')!
      await engine.completeSignature(task, { isAccepted: false, signature: { signature: '', signerKey: '', signerUserId: '' } })
    }

    const status = await new SigningEngine(fx.elec.ctx).getSigningStatus(nonce)
    expect(status?.signatures).to.equal(1)
    expect(status?.openTasks).to.equal(0)
    expect(status?.unreachable).to.equal(true)
    expect(status?.reached).to.equal(false)

    expect(await countRows(db, 'select count(*) as n from Ballot where Id = :id', { id: ballotId })).to.equal(0)
    const state = await fx.elec.electionEngine.getBallotConfirmationState(ballotId)
    expect(state.locked).to.equal(false)
  })

  it('C6 (withdraw, research problem 8): only the proposer may withdraw an unreached session; a reached one refuses', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db

    // (a) + (b): a fresh, unreached ballot.
    const { ballotId: ballotAB } = await seedProposedBallot(fx.elec, 'tb-c6ab')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotAB, fx.holders[0]!.sign)
    const nonceAB = await headerNonceForBallot(db, ballotAB)

    // (a) A non-proposer's withdraw throws and deletes nothing.
    const engine1 = await electionEngineFor(fx, fx.holders[1]!, ballotAB)
    let caughtA: unknown
    try {
      await engine1.withdrawBallotConfirmation(ballotAB)
    } catch (err) {
      caughtA = err
    }
    expect(caughtA, 'a non-proposer withdraw must throw').to.not.be.undefined
    expect((caughtA as Error).message).to.include('Only the officer who submitted')
    expect(await openTaskUsers(db, nonceAB), '(a) deletes nothing').to.deep.equal(
      [fx.holders[1]!.user.id, fx.holders[2]!.user.id, fx.holders[3]!.user.id].sort()
    )

    // (b) The proposer's withdraw succeeds and deletes every open sibling + extension row.
    const openTaskIdsBefore: string[] = []
    for await (const row of db.eval('select Id from Task where SigningNonce = :nonce and IsCompleted = 0', { nonce: nonceAB })) {
      openTaskIdsBefore.push(row.Id as string)
    }
    await fx.elec.electionEngine.withdrawBallotConfirmation(ballotAB)
    expect(await countRows(db, 'select count(*) as n from Task where SigningNonce = :nonce and IsCompleted = 0', { nonce: nonceAB })).to.equal(0)
    for (const taskId of openTaskIdsBefore) {
      expect(await countRows(db, 'select count(*) as n from BallotSignatureTaskExtension where TaskId = :taskId', { taskId })).to.equal(0)
    }
    const stateAfterB = await fx.elec.electionEngine.getBallotConfirmationState(ballotAB)
    expect(stateAfterB.locked).to.equal(false)

    // (c) A fresh ballot that has crossed (C2 shape) refuses withdraw entirely.
    const { ballotId: ballotC } = await seedProposedBallot(fx.elec, 'tb-c6c')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotC, fx.holders[0]!.sign)
    const nonceC = await headerNonceForBallot(db, ballotC)
    const engineCross = engineFor(fx, fx.holders[1]!)
    const taskCross = (await engineCross.getRequestedSignatures(true)).find(
      (t) => t.signatureType === 'ballot' && (t as any).ballot?.proposed?.id === ballotC
    )!
    await engineCross.completeSignature(taskCross, {
      isAccepted: true,
      signature: await fx.holders[1]!.sign(await engineCross.getSignatureDigest(taskCross)),
      sign: fx.holders[1]!.sign,
    })

    let caughtC: unknown
    try {
      await fx.elec.electionEngine.withdrawBallotConfirmation(ballotC)
    } catch (err) {
      caughtC = err
    }
    expect(caughtC, 'withdraw of a confirmed ballot must throw').to.not.be.undefined
    expect((caughtC as Error).message).to.include('already confirmed')
    for (const holder of [fx.holders[2]!, fx.holders[3]!]) {
      const row = await db.prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId').get({ nonce: nonceC, userId: holder.user.id })
      expect(Number(row?.IsCompleted), `${holder.user.id} task still open`).to.equal(0)
    }
  })

  it('C7 (no sign at threshold 2): submit with no callback throws before any write', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'tb-c7')

    const before = {
      adminSigning: await countRows(db, 'select count(*) as n from AdminSigning'),
      officerSignature: await countRows(db, 'select count(*) as n from OfficerSignature'),
      task: await countRows(db, 'select count(*) as n from Task'),
    }

    let caught: unknown
    try {
      await fx.elec.electionEngine.submitBallotForConfirmation(ballotId)
    } catch (err) {
      caught = err
    }
    expect(caught, 'submit with no callback at threshold 2 must throw').to.not.be.undefined
    expect((caught as Error).message).to.include('your signature is required')

    expect(await countRows(db, 'select count(*) as n from AdminSigning')).to.equal(before.adminSigning)
    expect(await countRows(db, 'select count(*) as n from OfficerSignature')).to.equal(before.officerSignature)
    expect(await countRows(db, 'select count(*) as n from Task')).to.equal(before.task)
  })

  it('C8 (signer spoof): a sign callback whose signerUserId does not match the proposer is refused', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'tb-c8')

    const before = {
      adminSigning: await countRows(db, 'select count(*) as n from AdminSigning'),
      officerSignature: await countRows(db, 'select count(*) as n from OfficerSignature'),
      task: await countRows(db, 'select count(*) as n from Task'),
    }

    let caught: unknown
    try {
      await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[1]!.sign)
    } catch (err) {
      caught = err
    }
    expect(caught, 'a spoofed signer must be refused').to.not.be.undefined

    expect(await countRows(db, 'select count(*) as n from AdminSigning')).to.equal(before.adminSigning)
    expect(await countRows(db, 'select count(*) as n from OfficerSignature')).to.equal(before.officerSignature)
    expect(await countRows(db, 'select count(*) as n from Task')).to.equal(before.task)
  })

  it('C9 (unreachable at birth): a threshold higher than the holder count refuses before invoking sign', async () => {
    const fx = await createThresholdAuthority({
      thresholdPolicies: [
        { policy: 'rad', threshold: 1 },
        { policy: 'ceb', threshold: 5 },
        { policy: 'vrg', threshold: 2 },
      ],
    })
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'tb-c9')

    const before = {
      adminSigning: await countRows(db, 'select count(*) as n from AdminSigning'),
      officerSignature: await countRows(db, 'select count(*) as n from OfficerSignature'),
      task: await countRows(db, 'select count(*) as n from Task'),
    }

    let invocations = 0
    const countingSign = async (digest: Uint8Array) => {
      invocations++
      return fx.holders[0]!.sign(digest)
    }

    let caught: unknown
    try {
      await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, countingSign)
    } catch (err) {
      caught = err
    }
    expect(caught, 'an unreachable-at-birth threshold must throw').to.not.be.undefined
    expect((caught as Error).message).to.include('only 4 officers')
    expect(invocations, 'the sign callback must never be invoked').to.equal(0)

    expect(await countRows(db, 'select count(*) as n from AdminSigning')).to.equal(before.adminSigning)
    expect(await countRows(db, 'select count(*) as n from OfficerSignature')).to.equal(before.officerSignature)
    expect(await countRows(db, 'select count(*) as n from Task')).to.equal(before.task)
  })

  it('C10 (WR-05 at threshold 2): a finalize failure after crossing leaves the Task retryable', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'tb-c10')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)
    const nonce = await headerNonceForBallot(db, ballotId)

    const proto = SignatureTasksEngine.prototype as unknown as {
      finalizeBallot: (...args: unknown[]) => Promise<void>
    }
    const original = proto.finalizeBallot
    let calls = 0
    proto.finalizeBallot = async function (this: SignatureTasksEngine, ...args: unknown[]): Promise<void> {
      calls++
      if (calls === 1) throw new Error('forced finalize fault')
      return original.apply(this, args)
    }

    try {
      const engine1 = engineFor(fx, fx.holders[1]!)
      const task1 = (await engine1.getRequestedSignatures(true)).find((t) => t.signatureType === 'ballot')!
      const digest1 = await engine1.getSignatureDigest(task1)
      const sig1 = await fx.holders[1]!.sign(digest1)

      let firstMessage: string | undefined
      try {
        await engine1.completeSignature(task1, { isAccepted: true, signature: sig1, sign: fx.holders[1]!.sign })
      } catch (err) {
        firstMessage = err instanceof Error ? err.message : String(err)
      }
      expect(firstMessage, 'the forced fault must surface on the first accept').to.not.be.undefined
      expect(firstMessage).to.include('forced finalize fault')

      expect(await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })).to.equal(1)
      const holder1TaskRow = await db.prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId').get({ nonce, userId: fx.holders[1]!.user.id })
      expect(Number(holder1TaskRow?.IsCompleted), 'the Task must still be open after the forced fault').to.equal(0)
      expect(await countRows(db, 'select count(*) as n from Ballot where Id = :id', { id: ballotId })).to.equal(0)

      let secondMessage: string | undefined
      try {
        await engine1.completeSignature(task1, { isAccepted: true, signature: sig1, sign: fx.holders[1]!.sign })
      } catch (err) {
        secondMessage = err instanceof Error ? err.message : String(err)
      }
      expect(secondMessage, `the retry must succeed outright — got: ${String(secondMessage)}`).to.be.undefined

      expect(await countRows(db, 'select count(*) as n from Ballot where Id = :id', { id: ballotId })).to.equal(1)
      expect(await countRows(db, 'select count(*) as n from Question where BallotId = :id', { id: ballotId })).to.equal(1)
      expect(await countRows(db, 'select count(*) as n from Option where BallotId = :id', { id: ballotId })).to.equal(2)
    } finally {
      proto.finalizeBallot = original
    }
  })

  it('C11 (finalize idempotency, second defence): a direct re-invocation after crossing is a no-op', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'tb-c11')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)
    const nonce = await headerNonceForBallot(db, ballotId)

    const engine1 = engineFor(fx, fx.holders[1]!)
    const task1 = (await engine1.getRequestedSignatures(true)).find((t) => t.signatureType === 'ballot')!
    await engine1.completeSignature(task1, {
      isAccepted: true,
      signature: await fx.holders[1]!.sign(await engine1.getSignatureDigest(task1)),
      sign: fx.holders[1]!.sign,
    })

    const before = {
      ballot: await countRows(db, 'select count(*) as n from Ballot where Id = :id', { id: ballotId }),
      question: await countRows(db, 'select count(*) as n from Question where BallotId = :id', { id: ballotId }),
      option: await countRows(db, 'select count(*) as n from Option where BallotId = :id', { id: ballotId }),
      adminSigning: await countRows(db, 'select count(*) as n from AdminSigning'),
    }

    const taskId1 = await taskIdFor(db, nonce, fx.holders[1]!.user.id)
    let caught: unknown
    try {
      await (engine1 as any).finalizeBallot(taskId1, nonce, fx.holders[1]!.sign)
    } catch (err) {
      caught = err
    }
    expect(caught, 'a direct re-invocation must resolve without throwing').to.be.undefined

    expect(await countRows(db, 'select count(*) as n from Ballot where Id = :id', { id: ballotId })).to.equal(before.ballot)
    expect(await countRows(db, 'select count(*) as n from Question where BallotId = :id', { id: ballotId })).to.equal(before.question)
    expect(await countRows(db, 'select count(*) as n from Option where BallotId = :id', { id: ballotId })).to.equal(before.option)
    expect(await countRows(db, 'select count(*) as n from AdminSigning')).to.equal(before.adminSigning)
  })

  it('C12 (threshold 1 unchanged, D-06 self-confirm): no callback needed, self-confirm still works', async () => {
    const fx = await createThresholdAuthority({
      thresholdPolicies: [
        { policy: 'rad', threshold: 1 },
        { policy: 'ceb', threshold: 1 },
        { policy: 'vrg', threshold: 2 },
      ],
    })
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'tb-c12')

    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId)
    const nonce = await headerNonceForBallot(db, ballotId)
    expect(await openTaskUsers(db, nonce)).to.deep.equal([fx.holders[0]!.user.id])
    expect(await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })).to.equal(0)

    const engine0 = engineFor(fx, fx.holders[0]!)
    const task0 = (await engine0.getRequestedSignatures(true)).find((t) => t.signatureType === 'ballot')!
    await engine0.completeSignature(task0, {
      isAccepted: true,
      signature: await fx.holders[0]!.sign(await engine0.getSignatureDigest(task0)),
      sign: fx.holders[0]!.sign,
    })
    expect(await countRows(db, 'select count(*) as n from Ballot where Id = :id', { id: ballotId })).to.equal(1)
  })
})

export { makeNetworkRef, engineFor, countRows, openTaskUsers, headerNonceForBallot, electionEngineFor }
