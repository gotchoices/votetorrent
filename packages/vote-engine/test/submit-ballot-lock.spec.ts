// submit-ballot-lock.spec.ts — WR-04 (62-62)
//
// submitBallotForConfirmation must refuse, BEFORE any write and before the proposer's sign
// callback, a ballot that is already out for confirmation (open ballot Task) or confirmed
// (Ballot row). proposeBallot, submitBallotForConfirmation and getBallotConfirmationState
// share one lock read, so a reached-but-unfinalized session reads locked everywhere.

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import { hexToBytes, bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 as secp } from '@noble/curves/secp256k1.js'
import type { BallotSignatureTask, Signature } from '@votetorrent/vote-core'
import { ElectionEngine } from '../src/election/election-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  seedProposedBallot,
  testKeyPairFor,
} from './fixtures/test-context.js'
import { createThresholdAuthority, type ThresholdAuthorityFixture } from './fixtures/threshold-authority.js'

const SUBMITTED = /already submitted for confirmation/
const CONFIRMED = /already confirmed/

function makeNetworkRef () {
  return {
    hash: 'test-submit-lock-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

async function setupElection () {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  return addTestElection(auth)
}

type Elec = Awaited<ReturnType<typeof setupElection>>

async function getBallotTask (engine: SignatureTasksEngine, ballotId: string): Promise<BallotSignatureTask> {
  const tasks = await engine.getRequestedSignatures(true)
  const found = tasks.find(
    t => t.signatureType === 'ballot' && (t as BallotSignatureTask).ballot?.proposed?.id === ballotId
  ) as BallotSignatureTask | undefined
  if (!found) throw new Error(`no pending BallotSignatureTask for ${ballotId}`)
  return found
}

/** Threshold-1 officer accept through completeSignature. */
async function accept1 (elec: Elec, ballotId: string): Promise<void> {
  const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
  const task = await getBallotTask(engine, ballotId)
  const digest = await engine.getSignatureDigest(task)
  const privKey = hexToBytes(testKeyPairFor(elec.user.id).privateHex)
  const sigHex = bytesToHex(secp.sign(digest, privKey) as unknown as Uint8Array)
  await engine.completeSignature(task, {
    isAccepted: true,
    signature: { signerUserId: elec.user.id, signerKey: bytesToHex(secp.getPublicKey(privKey)), signature: sigHex },
  })
}

async function count (db: Database, sql: string, params: Record<string, unknown> = {}): Promise<number> {
  const row = await db.prepare(sql).get(params)
  return Number(row?.n ?? 0)
}

async function counts (db: Database) {
  return {
    adminSigning: await count(db, 'select count(*) as n from AdminSigning'),
    officerSignature: await count(db, 'select count(*) as n from OfficerSignature'),
    task: await count(db, 'select count(*) as n from Task'),
    ext: await count(db, 'select count(*) as n from BallotSignatureTaskExtension'),
  }
}

async function refusal (p: Promise<unknown>, re: RegExp): Promise<Error> {
  let thrown: unknown
  try { await p } catch (e) { thrown = e }
  expect(thrown, 'call must be refused').to.be.instanceOf(Error)
  expect((thrown as Error).message).to.match(re)
  return thrown as Error
}

type FinalizeProto = { finalizeBallot: (...args: unknown[]) => Promise<void> }

/** Patch finalizeBallot to throw once; returns a restore fn. */
function failFinalizeOnce (): () => void {
  const proto = SignatureTasksEngine.prototype as unknown as FinalizeProto
  const original = proto.finalizeBallot
  let calls = 0
  proto.finalizeBallot = async function (this: SignatureTasksEngine, ...args: unknown[]): Promise<void> {
    calls++
    if (calls === 1) throw new Error('forced finalize fault')
    return original.apply(this, args)
  }
  return () => { proto.finalizeBallot = original }
}

describe('submitBallotForConfirmation lock (WR-04, threshold 1)', function () {
  this.timeout(60_000)

  it('S1: first submit succeeds and locks the ballot (positive control)', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)
    // gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
    expect(await elec.electionEngine.getBallotConfirmationState(ballotId)).to.deep.equal({ locked: true, confirmed: false, canWithdraw: true, ownTaskOpen: true })
  })

  it('S2: a second submit is refused with row counts unchanged', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)
    const before = await counts(elec.ctx.db)
    const err = await refusal(elec.electionEngine.submitBallotForConfirmation(ballotId), SUBMITTED)
    expect(err.message.endsWith('This ballot is already submitted for confirmation.')).to.equal(true)
    expect(await counts(elec.ctx.db)).to.deep.equal(before)
  })

  it('S3: submit after confirm is refused with row counts unchanged', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)
    await accept1(elec, ballotId)
    const before = await counts(elec.ctx.db)
    const err = await refusal(elec.electionEngine.submitBallotForConfirmation(ballotId), CONFIRMED)
    expect(err.message.endsWith('This ballot is already confirmed.')).to.equal(true)
    expect(await counts(elec.ctx.db)).to.deep.equal(before)
  })

  it('S4: submit after Withdraw succeeds with a fresh session (positive control)', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)
    await elec.electionEngine.withdrawBallotConfirmation(ballotId)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)
    // gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
    expect(await elec.electionEngine.getBallotConfirmationState(ballotId)).to.deep.equal({ locked: true, confirmed: false, canWithdraw: true, ownTaskOpen: true })
  })

  it('S5: reached-but-unfinalized reads locked, refuses propose and submit, and unlocks once finalized', async () => {
    const elec = await setupElection()
    const db = elec.ctx.db
    const { ballotId } = await seedProposedBallot(elec)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)
    const nonceRow = await db
      .prepare(
        `select T.SigningNonce as n from Task T join BallotSignatureTaskExtension E on E.TaskId = T.Id
         where E.BallotId = :ballotId limit 1`
      )
      .get({ ballotId })
    const nonce = nonceRow!.n as string

    const restore = failFinalizeOnce()
    try {
      let msg: string | undefined
      try { await accept1(elec, ballotId) } catch (e) { msg = (e as Error).message }
      expect(msg, 'forced fault must surface').to.include('forced finalize fault')

      expect(await count(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })).to.equal(1)
      expect(await count(db, 'select count(*) as n from Task where SigningNonce = :nonce and IsCompleted = 0', { nonce })).to.equal(1)
      expect(await count(db, 'select count(*) as n from Ballot where Id = :ballotId', { ballotId })).to.equal(0)

      // gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
      expect(await elec.electionEngine.getBallotConfirmationState(ballotId)).to.deep.equal({ locked: true, confirmed: false, canWithdraw: false, ownTaskOpen: true })

      const rowBefore = await db.prepare('select * from ProposedBallot where Id = :ballotId').get({ ballotId })
      const row = rowBefore as Record<string, unknown>
      await refusal(
        elec.electionEngine.proposeBallot({
          id: ballotId,
          electionId: row.ElectionId as string,
          authorityId: row.AuthorityId as string,
          description: 'drift',
          districts: JSON.parse((row.Districts as string) ?? '[]'),
          questions: row.Questions ? JSON.parse(row.Questions as string) : [],
        }),
        /out for confirmation/
      )
      expect(await db.prepare('select * from ProposedBallot where Id = :ballotId').get({ ballotId })).to.deep.equal(rowBefore)

      const before = await counts(db)
      await refusal(elec.electionEngine.submitBallotForConfirmation(ballotId), SUBMITTED)
      expect(await counts(db)).to.deep.equal(before)
    } finally {
      restore()
    }

    await accept1(elec, ballotId)
    // gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
    expect(await elec.electionEngine.getBallotConfirmationState(ballotId)).to.deep.equal({ locked: false, confirmed: true, canWithdraw: false, ownTaskOpen: false })
  })
})

describe('submitBallotForConfirmation lock (WR-04, threshold 2)', function () {
  this.timeout(60_000)

  function countingSign (fx: ThresholdAuthorityFixture) {
    const holder = fx.holders[0]!
    let calls = 0
    const sign = async (digest: Uint8Array): Promise<Signature> => {
      calls++
      return holder.sign(digest)
    }
    return { sign, calls: () => calls }
  }

  async function openUsers (db: Database, nonce: string): Promise<string[]> {
    const rows: string[] = []
    for await (const row of db.eval(
      'select distinct UserId from Task where SigningNonce = :nonce and IsCompleted = 0 order by UserId',
      { nonce }
    )) rows.push(row.UserId as string)
    return rows
  }

  it('S6: a second submit is refused, sign invoked 0 times, counts unchanged', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'sl-s6')
    const first = countingSign(fx)
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, first.sign)
    expect(first.calls(), 'first submit signs once').to.equal(1)
    const before = await counts(db)
    const second = countingSign(fx)
    await refusal(fx.elec.electionEngine.submitBallotForConfirmation(ballotId, second.sign), SUBMITTED)
    expect(second.calls()).to.equal(0)
    expect(await counts(db)).to.deep.equal(before)
  })

  it('S7: reached-but-unfinalized reads locked, refuses submit with 0 signs, unlocks after retry with D-09 siblings open', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'sl-s7')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)
    const nonce = (await db
      .prepare(
        `select Task.SigningNonce as n from Task join BallotSignatureTaskExtension E on E.TaskId = Task.Id
         where E.BallotId = :ballotId limit 1`
      )
      .get({ ballotId }))!.n as string

    const engine1 = new SignatureTasksEngine(makeNetworkRef(), { db, user: fx.holders[1]!.user })
    const task1 = (await engine1.getRequestedSignatures(true)).find((t) => t.signatureType === 'ballot')!
    const sig1 = await fx.holders[1]!.sign(await engine1.getSignatureDigest(task1))

    const restore = failFinalizeOnce()
    try {
      let msg: string | undefined
      try {
        await engine1.completeSignature(task1, { isAccepted: true, signature: sig1, sign: fx.holders[1]!.sign })
      } catch (e) { msg = (e as Error).message }
      expect(msg).to.include('forced finalize fault')
      expect(await count(db, 'select count(*) as n from Ballot where Id = :ballotId', { ballotId })).to.equal(0)

      // gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
      expect(await fx.elec.electionEngine.getBallotConfirmationState(ballotId)).to.deep.equal({ locked: true, confirmed: false, canWithdraw: false, ownTaskOpen: false })

      const before = await counts(db)
      const probe = countingSign(fx)
      await refusal(fx.elec.electionEngine.submitBallotForConfirmation(ballotId, probe.sign), SUBMITTED)
      expect(probe.calls()).to.equal(0)
      expect(await counts(db)).to.deep.equal(before)
    } finally {
      restore()
    }

    await engine1.completeSignature(task1, { isAccepted: true, signature: sig1, sign: fx.holders[1]!.sign })
    // gap8/WR-03: the state now says who may withdraw and whether the officer has a task (canWithdraw/ownTaskOpen).
    expect(await fx.elec.electionEngine.getBallotConfirmationState(ballotId)).to.deep.equal({ locked: false, confirmed: true, canWithdraw: false, ownTaskOpen: false })
    expect((await openUsers(db, nonce)).length, 'D-09 siblings stay open').to.be.greaterThan(0)
  })
})

describe('submitBallotForConfirmation in-transaction lock (gap8/WR-02, threshold 2)', function () {
  this.timeout(60_000)

  /** A second officer's engine over the same database (a submit that replicated in). */
  async function engineOf (fx: ThresholdAuthorityFixture, holderIdx: number): Promise<ElectionEngine> {
    const row = await fx.elec.ctx.db
      .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
      .get({ authorityId: fx.authorityId })
    return new ElectionEngine(
      { id: row!.Id as string, authorityId: fx.authorityId },
      { db: fx.elec.ctx.db, user: fx.holders[holderIdx]!.user }
    )
  }

  it('S8: a submit that raced its own signature prompt is refused in the transaction, one session only', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'sl-s8')
    const other = await engineOf(fx, 1)
    const cebBefore = await count(db, "select count(*) as n from AdminSigning where Scope = 'ceb'")
    const officerBefore = await count(db, 'select count(*) as n from OfficerSignature')
    const racingSign = async (digest: Uint8Array): Promise<Signature> => {
      // The user-paced prompt is open; another officer's submit lands meanwhile.
      await other.submitBallotForConfirmation(ballotId, fx.holders[1]!.sign)
      return fx.holders[0]!.sign(digest)
    }
    await refusal(fx.elec.electionEngine.submitBallotForConfirmation(ballotId, racingSign), SUBMITTED)
    expect(await count(db, "select count(*) as n from AdminSigning where Scope = 'ceb'") - cebBefore).to.equal(1)
    expect(await count(db, 'select count(*) as n from OfficerSignature') - officerBefore).to.equal(1)
    expect(
      await count(
        db,
        `select count(distinct T.SigningNonce) as n from Task T join BallotSignatureTaskExtension E on E.TaskId = T.Id
         where E.BallotId = :ballotId`,
        { ballotId }
      )
    ).to.equal(1)
  })

  it('S8b: the in-transaction check reports confirmed when the racing submit also got confirmed', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'sl-s8b')
    const other = await engineOf(fx, 1)
    const racingSign = async (digest: Uint8Array): Promise<Signature> => {
      await other.submitBallotForConfirmation(ballotId, fx.holders[1]!.sign)
      const engine2 = new SignatureTasksEngine(makeNetworkRef(), { db, user: fx.holders[2]!.user })
      const task = (await engine2.getRequestedSignatures(true)).find((t) => t.signatureType === 'ballot')!
      await engine2.completeSignature(task, {
        isAccepted: true,
        signature: await fx.holders[2]!.sign(await engine2.getSignatureDigest(task)),
        sign: fx.holders[2]!.sign,
      })
      return fx.holders[0]!.sign(digest)
    }
    await refusal(fx.elec.electionEngine.submitBallotForConfirmation(ballotId, racingSign), CONFIRMED)
    expect(
      await count(
        db,
        `select count(distinct T.SigningNonce) as n from Task T join BallotSignatureTaskExtension E on E.TaskId = T.Id
         where E.BallotId = :ballotId`,
        { ballotId }
      )
    ).to.equal(1)
    expect(await count(db, 'select count(*) as n from Ballot where Id = :ballotId', { ballotId })).to.equal(1)
  })

  it('S8c: with no concurrent submit the threshold-2 submit succeeds as before (positive control)', async () => {
    const fx = await createThresholdAuthority()
    const { ballotId } = await seedProposedBallot(fx.elec, 'sl-s8c')
    await fx.elec.electionEngine.submitBallotForConfirmation(ballotId, fx.holders[0]!.sign)
    expect((await fx.elec.electionEngine.getBallotConfirmationState(ballotId)).locked).to.equal(true)
  })
})
