/**
 * intake-policy-cosign.spec.ts — co-signed AuthorityIntakePolicy changes above a 'vrg' threshold of 1
 * (the REST bridge URL and the re-association mode; the bridge config screen writes the same row).
 *
 * The initiator signs a PROPOSAL; every other current 'vrg' holder gets an 'intake-policy' signature
 * Task; the change takes effect when a co-signer's signature takes the session to its threshold. A
 * rejection is a vote, never a veto, and never applies anything. Before this change the write refused
 * with `threshold-requires-co-sign`.
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import type { IntakePolicySignatureTask } from '@votetorrent/vote-core'
import { IntakeEngine } from '../src/intake/intake-engine.js'
import { intakeQueryPortFromDb } from '../src/intake/query-port.js'
import { readIntakePolicyFrom } from '../src/intake/policy.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { createThresholdAuthority, type ThresholdAuthorityFixture } from './fixtures/threshold-authority.js'

const NET = { hash: 'intake-cosign', name: 'Intake co-sign', relays: [] as string[], primaryAuthorityDomainName: 'x.example' }

function tasksFor (fx: ThresholdAuthorityFixture, i: number): SignatureTasksEngine {
  return new SignatureTasksEngine(NET, { db: fx.elec.ctx.db, user: fx.holders[i]!.user })
}

function intakeFor (fx: ThresholdAuthorityFixture, i: number): IntakeEngine {
  return new IntakeEngine({ db: fx.elec.ctx.db, user: fx.holders[i]!.user })
}

async function intakeTasks (fx: ThresholdAuthorityFixture, i: number): Promise<IntakePolicySignatureTask[]> {
  const tasks = await tasksFor(fx, i).getRequestedSignatures(true)
  return tasks.filter((t) => t.signatureType === 'intake-policy') as IntakePolicySignatureTask[]
}

async function accept (fx: ThresholdAuthorityFixture, i: number, task: IntakePolicySignatureTask): Promise<void> {
  const engine = tasksFor(fx, i)
  const digest = await engine.getSignatureDigest(task)
  await engine.completeSignature(task, { isAccepted: true, signature: await fx.holders[i]!.sign(digest) })
}

async function reject (fx: ThresholdAuthorityFixture, i: number, task: IntakePolicySignatureTask): Promise<void> {
  await tasksFor(fx, i).completeSignature(task, { isAccepted: false, signature: { signature: '', signerKey: '', signerUserId: '' } })
}

async function policy (db: Database, authorityId: string) {
  return readIntakePolicyFrom(intakeQueryPortFromDb(db), authorityId)
}

describe('co-signed intake policy changes (vrg threshold 2)', function () {
  this.timeout(60_000)

  let fx: ThresholdAuthorityFixture

  beforeEach(async () => {
    // Four vrg holders, vrg threshold 2.
    fx = await createThresholdAuthority()
  })

  it('the initiator proposes; the policy in force is unchanged and every other holder gets a task', async () => {
    const view = await intakeFor(fx, 0).setIntakePolicy({ authorityId: fx.authorityId, restBridgeUrl: 'https://bridge.example/intake' }, fx.holders[0]!.sign)
    expect(view.isDefault).to.equal(true)
    expect(view.pendingProposal).to.include({ revision: 1, restBridgeUrl: 'https://bridge.example/intake', reassociationMode: 'manual', threshold: 2, signatures: 1, reached: false, applied: false })
    expect((await policy(fx.elec.ctx.db, fx.authorityId)).isDefault).to.equal(true)

    expect(await intakeTasks(fx, 0)).to.have.length(0)
    for (const i of [1, 2, 3]) {
      const tasks = await intakeTasks(fx, i)
      expect(tasks, `holder ${i}`).to.have.length(1)
      expect(tasks[0]!.authorityId).to.equal(fx.authorityId)
      expect(tasks[0]!.proposal).to.deep.equal({ revision: 1, restBridgeUrl: 'https://bridge.example/intake', reassociationMode: 'manual', setAt: view.pendingProposal!.setAt })
    }
    expect(await intakeFor(fx, 0).listIntakePolicyProposals(fx.authorityId)).to.have.length(1)
  })

  it("a co-signer's accept reaches the threshold and the change takes effect", async () => {
    await intakeFor(fx, 0).setIntakePolicy({ authorityId: fx.authorityId, reassociationMode: 'automatic' }, fx.holders[0]!.sign)
    const [task] = await intakeTasks(fx, 1)
    await accept(fx, 1, task!)
    const view = await policy(fx.elec.ctx.db, fx.authorityId)
    expect(view.revision).to.equal(1)
    expect(view.reassociationMode).to.equal('automatic')
    expect(await intakeTasks(fx, 1)).to.have.length(0)
    const [proposal] = await intakeFor(fx, 0).listIntakePolicyProposals(fx.authorityId)
    expect(proposal).to.include({ reached: true, applied: true, signatures: 2 })

    // A late co-signature after the change applied is recorded and changes nothing.
    const [late] = await intakeTasks(fx, 2)
    await accept(fx, 2, late!)
    expect((await policy(fx.elec.ctx.db, fx.authorityId)).revision).to.equal(1)
    const count = await fx.elec.ctx.db.prepare('select count(*) as n from AuthorityIntakePolicy where AuthorityId = :a and Revision = 1').get({ a: fx.authorityId })
    expect(Number(count!.n)).to.equal(1)
  })

  it('a rejection is a vote, not a veto, and applies nothing', async () => {
    await intakeFor(fx, 0).setIntakePolicy({ authorityId: fx.authorityId, restBridgeUrl: 'https://bridge.example' }, fx.holders[0]!.sign)
    const [t1] = await intakeTasks(fx, 1)
    await reject(fx, 1, t1!)
    expect((await policy(fx.elec.ctx.db, fx.authorityId)).isDefault).to.equal(true)
    const [t2] = await intakeTasks(fx, 2)
    await accept(fx, 2, t2!)
    expect((await policy(fx.elec.ctx.db, fx.authorityId)).restBridgeUrl).to.equal('https://bridge.example')
  })

  it('a second proposal takes the next revision; the newest applied revision is the policy in force', async () => {
    const first = await intakeFor(fx, 0).setIntakePolicy({ authorityId: fx.authorityId, reassociationMode: 'automatic' }, fx.holders[0]!.sign)
    const second = await intakeFor(fx, 1).setIntakePolicy({ authorityId: fx.authorityId, restBridgeUrl: 'https://two.example' }, fx.holders[1]!.sign)
    expect(first.pendingProposal!.revision).to.equal(1)
    expect(second.pendingProposal!.revision).to.equal(2)

    const forHolder2 = await intakeTasks(fx, 2)
    expect(forHolder2).to.have.length(2)
    const secondTask = forHolder2.find((t) => t.proposal.revision === 2)!
    const firstTask = forHolder2.find((t) => t.proposal.revision === 1)!
    await accept(fx, 2, secondTask)
    expect((await policy(fx.elec.ctx.db, fx.authorityId)).revision).to.equal(2)
    await accept(fx, 2, firstTask)
    const view = await policy(fx.elec.ctx.db, fx.authorityId)
    expect(view.revision).to.equal(2)
    expect(view.restBridgeUrl).to.equal('https://two.example')
  })

  it("a non-vrg officer still cannot propose", async () => {
    let caught: unknown
    try {
      await new IntakeEngine({ db: fx.elec.ctx.db, user: fx.nonHolder.user }).setIntakePolicy({ authorityId: fx.authorityId, restBridgeUrl: 'https://bridge.example' }, fx.nonHolder.sign)
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string })?.code).to.equal('not-authorized')
    expect(await intakeFor(fx, 0).listIntakePolicyProposals(fx.authorityId)).to.have.length(0)
  })
})
