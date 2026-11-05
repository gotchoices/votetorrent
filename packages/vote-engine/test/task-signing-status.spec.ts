import { expect } from 'chai'
import type { Database, SqlValue } from '@quereus/quereus'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { MockSignatureTasksEngine } from '../src/tasks/mock-signature-tasks-engine.js'
import { digestToBytes } from '../src/utils.js'
import {
  createThresholdAuthority,
  type ThresholdAuthorityFixture,
} from './fixtures/threshold-authority.js'
import { seedProposedBallot, createTestNetwork, addTestAuthority, addTestElection } from './fixtures/test-context.js'
import type { BallotSignatureTask } from '@votetorrent/vote-core'

/**
 * task-signing-status.spec.ts — 62-12 (Surface 5, D-09/D-10/D-11): real-engine proof of
 * `ISignatureTasksEngine.getTaskSigningStatus` over 62-11's ceb fan-out. Every session is built
 * through the PRODUCTION path 62-11 wired (`submitBallotForConfirmation` / `completeSignature`),
 * never by hand-built task objects — tasks are always read back through
 * `engineFor(fx, holder).getRequestedSignatures(true)`.
 */

function makeNetworkRef () {
  return {
    hash: 'test-task-signing-status-hash',
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

async function pendingBallotTaskFor (
  fx: ThresholdAuthorityFixture,
  holder: ThresholdAuthorityFixture['holders'][number],
  ballotId: string
) {
  const engine = engineFor(fx, holder)
  const tasks = await engine.getRequestedSignatures(true)
  const task = tasks.find(
    (t) => t.signatureType === 'ballot' && (t as BallotSignatureTask).ballot?.proposed?.id === ballotId
  )
  if (!task) throw new Error(`pendingBallotTaskFor: no pending ballot task for ${holder.user.id} / ${ballotId}`)
  return { engine, task: task as BallotSignatureTask }
}

describe('task signing status seam (Surface 5)', function () {
  this.timeout(60_000)

  it('S1: progress + digest parity — threshold 2, first holder pending, status matches getSignatureDigest\'s nonce', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 's1-ballot')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)

    const { engine, task } = await pendingBallotTaskFor(fx, fx.holders[1]!, ballotId)
    const status = await engine.getTaskSigningStatus(task)
    expect(status, 'status must not be null').to.not.be.null
    expect(status!.scope).to.equal('ceb')
    expect(status!.threshold).to.equal(2)
    expect(status!.signatures).to.equal(1)
    expect(status!.reached).to.equal(false)
    expect(status!.unreachable).to.equal(false)

    // Digest parity: the status's nonce resolves to the SAME AdminSigning.Digest bytes that
    // getSignatureDigest(task) returns for the same task.
    const row = await db.prepare('select Digest from AdminSigning where Nonce = :nonce').get({ nonce: status!.nonce })
    expect(row, 'AdminSigning row for the status nonce must exist').to.not.be.undefined
    const statusDigestBytes = digestToBytes(row!.Digest)
    const engineDigestBytes = await engine.getSignatureDigest(task)
    expect(Buffer.from(statusDigestBytes).equals(Buffer.from(engineDigestBytes)), 'digest bytes must byte-equal').to.equal(true)
  })

  it('S2: reached, siblings still open (D-09) — second accept crosses, third holder still sees the task', async () => {
    const fx = await createThresholdAuthority()
    const { ballotId } = await seedProposedBallot(fx.elec, 's2-ballot')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)

    const { engine: engine1, task: task1 } = await pendingBallotTaskFor(fx, fx.holders[1]!, ballotId)
    await engine1.completeSignature(task1, {
      isAccepted: true,
      signature: await fx.holders[1]!.sign(await engine1.getSignatureDigest(task1)),
      sign: fx.holders[1]!.sign,
    })

    const { engine: engine2, task: task2 } = await pendingBallotTaskFor(fx, fx.holders[2]!, ballotId)
    const status = await engine2.getTaskSigningStatus(task2)
    expect(status!.reached).to.equal(true)
    expect(status!.signatures).to.equal(2)
    expect(status!.unreachable).to.equal(false)

    // holders[2]'s task is still returned by getRequestedSignatures(true).
    const stillPending = await engine2.getRequestedSignatures(true)
    expect(stillPending.some((t) => t.signatureType === 'ballot' && (t as BallotSignatureTask).ballot?.proposed?.id === ballotId)).to.equal(true)
  })

  it('S3: late signature (D-10) — a third accept after crossing, fourth holder sees signatures 3', async () => {
    const fx = await createThresholdAuthority()
    const { ballotId } = await seedProposedBallot(fx.elec, 's3-ballot')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)

    const { engine: engine1, task: task1 } = await pendingBallotTaskFor(fx, fx.holders[1]!, ballotId)
    await engine1.completeSignature(task1, {
      isAccepted: true,
      signature: await fx.holders[1]!.sign(await engine1.getSignatureDigest(task1)),
      sign: fx.holders[1]!.sign,
    })
    const { engine: engine2, task: task2 } = await pendingBallotTaskFor(fx, fx.holders[2]!, ballotId)
    await engine2.completeSignature(task2, {
      isAccepted: true,
      signature: await fx.holders[2]!.sign(await engine2.getSignatureDigest(task2)),
      sign: fx.holders[2]!.sign,
    })

    const { engine: engine3, task: task3 } = await pendingBallotTaskFor(fx, fx.holders[3]!, ballotId)
    const status = await engine3.getTaskSigningStatus(task3)
    expect(status!.reached).to.equal(true)
    expect(status!.signatures).to.equal(3)
  })

  it('S4: completed task returns null — no throw', async () => {
    const fx = await createThresholdAuthority()
    const { ballotId } = await seedProposedBallot(fx.elec, 's4-ballot')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)

    const { engine: engine1, task: task1 } = await pendingBallotTaskFor(fx, fx.holders[1]!, ballotId)
    await engine1.completeSignature(task1, {
      isAccepted: true,
      signature: await fx.holders[1]!.sign(await engine1.getSignatureDigest(task1)),
      sign: fx.holders[1]!.sign,
    })

    // holders[1]'s own task object is now completed — the pending lookup finds no row.
    let caught: unknown
    let result: unknown
    try {
      result = await engine1.getTaskSigningStatus(task1)
    } catch (err) {
      caught = err
    }
    expect(caught, 'must not throw').to.be.undefined
    expect(result).to.equal(null)
  })

  it('S5: rejection is a vote, then unreachable (D-11) — threshold 3, still returned by getRequestedSignatures', async () => {
    const fx = await createThresholdAuthority({
      thresholdPolicies: [
        { policy: 'rad', threshold: 1 },
        { policy: 'ceb', threshold: 3 },
        { policy: 'vrg', threshold: 2 },
      ],
    })
    const { ballotId } = await seedProposedBallot(fx.elec, 's5-ballot')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)

    const { engine: engine1, task: task1 } = await pendingBallotTaskFor(fx, fx.holders[1]!, ballotId)
    await engine1.completeSignature(task1, { isAccepted: false, signature: { signature: '', signerKey: '', signerUserId: '' } })

    const { engine: engine3, task: task3a } = await pendingBallotTaskFor(fx, fx.holders[3]!, ballotId)
    const statusAfterOneReject = await engine3.getTaskSigningStatus(task3a)
    expect(statusAfterOneReject!.rejected).to.equal(1)
    expect(statusAfterOneReject!.unreachable).to.equal(false)

    const { engine: engine2, task: task2 } = await pendingBallotTaskFor(fx, fx.holders[2]!, ballotId)
    await engine2.completeSignature(task2, { isAccepted: false, signature: { signature: '', signerKey: '', signerUserId: '' } })

    const { engine: engine3b, task: task3b } = await pendingBallotTaskFor(fx, fx.holders[3]!, ballotId)
    const statusAfterTwoRejects = await engine3b.getTaskSigningStatus(task3b)
    expect(statusAfterTwoRejects!.rejected).to.equal(2)
    expect(statusAfterTwoRejects!.unreachable).to.equal(true)
    expect(statusAfterTwoRejects!.reached).to.equal(false)

    // The engine never closes an unreachable session's remaining task; the UI filter does the hiding.
    const stillPending = await engine3b.getRequestedSignatures(true)
    expect(stillPending.some((t) => t.signatureType === 'ballot' && (t as BallotSignatureTask).ballot?.proposed?.id === ballotId)).to.equal(true)
  })

  it('S6: threshold 1 — default createTestNetwork authority, submitted ballot task returns threshold 1', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const elec = await addTestElection(auth)
    const { ballotId } = await seedProposedBallot(elec, 's6-ballot')
    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    const engine = new SignatureTasksEngine(makeNetworkRef(), { db: elec.ctx.db, user: elec.user })
    const tasks = await engine.getRequestedSignatures(true)
    const task = tasks.find(
      (t) => t.signatureType === 'ballot' && (t as BallotSignatureTask).ballot?.proposed?.id === ballotId
    ) as BallotSignatureTask
    expect(task, 'the self-confirm task must exist at threshold 1').to.not.be.undefined

    const status = await engine.getTaskSigningStatus(task)
    expect(status, 'status must not be null at threshold 1').to.not.be.null
    expect(status!.threshold).to.equal(1)
  })

  it('S7: null cases — no ctx, mock engine, and an unmatched ballot id', async () => {
    const fx = await createThresholdAuthority()
    const { ballotId } = await seedProposedBallot(fx.elec, 's7-ballot')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)
    const { task } = await pendingBallotTaskFor(fx, fx.holders[1]!, ballotId)

    // a) no-ctx engine
    const noCtxEngine = new SignatureTasksEngine(makeNetworkRef())
    expect(await noCtxEngine.getTaskSigningStatus(task)).to.equal(null)

    // b) mock engine
    const mockEngine = new MockSignatureTasksEngine()
    expect(await mockEngine.getTaskSigningStatus(task)).to.equal(null)

    // c) a ballot task object whose ballot.proposed.id matches no row
    const unmatchedTask: BallotSignatureTask = {
      ...task,
      ballot: { ...task.ballot, proposed: { ...task.ballot.proposed, id: 'no-such-ballot-id' } },
    }
    const engine1 = engineFor(fx, fx.holders[1]!)
    expect(await engine1.getTaskSigningStatus(unmatchedTask)).to.equal(null)
  })

  it('S8: read-only — row counts unchanged across ten getTaskSigningStatus calls', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 's8-ballot')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)
    const { engine, task } = await pendingBallotTaskFor(fx, fx.holders[1]!, ballotId)

    const countsBefore = {
      task: await countRows(db, 'select count(*) as n from Task'),
      adminSigning: await countRows(db, 'select count(*) as n from AdminSigning'),
      officerSignature: await countRows(db, 'select count(*) as n from OfficerSignature'),
      adminSignature: await countRows(db, 'select count(*) as n from AdminSignature'),
      extension: await countRows(db, 'select count(*) as n from BallotSignatureTaskExtension'),
    }

    for (let i = 0; i < 10; i++) {
      await engine.getTaskSigningStatus(task)
    }

    const countsAfter = {
      task: await countRows(db, 'select count(*) as n from Task'),
      adminSigning: await countRows(db, 'select count(*) as n from AdminSigning'),
      officerSignature: await countRows(db, 'select count(*) as n from OfficerSignature'),
      adminSignature: await countRows(db, 'select count(*) as n from AdminSignature'),
      extension: await countRows(db, 'select count(*) as n from BallotSignatureTaskExtension'),
    }

    expect(countsAfter).to.deep.equal(countsBefore)
  })
})
