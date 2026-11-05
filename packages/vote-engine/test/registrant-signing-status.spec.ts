import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Database, SqlValue } from '@quereus/quereus'
import type { RegisterInit, RegistrationRequestInit, RegistrantSignatureTask, Signature } from '@votetorrent/vote-core'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { MockSignatureTasksEngine } from '../src/tasks/mock-signature-tasks-engine.js'
import { findRegistrantSessionNonce } from '../src/tasks/task-signing-status.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import type { EngineContext } from '../src/types.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { randomTestKeyPair, type TestKeyPair } from './fixtures/keys.js'
import { createThresholdAuthority, type ThresholdAuthorityFixture } from './fixtures/threshold-authority.js'
import { createTestNetwork, addTestAuthority, provisionTestIntakeRecipient } from './fixtures/test-context.js'

/**
 * registrant-signing-status.spec.ts — 62-27 (D-11 vrg): real-engine proof of
 * `ISignatureTasksEngine.getRegistrantSigningStatus`, the display-only read that keeps the
 * registrant vrg session readable AFTER the officer's own task has completed (the case
 * `getTaskSigningStatus` cannot see). Requests are submitted and seeded through the production
 * path, as in threshold-vrg.spec.ts; D-49 (62-31) means every context that submits or seeds a
 * request provisions an intake recipient first.
 */

function makeNetworkRef () {
  return {
    hash: 'test-registrant-signing-status-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

type Holder = ThresholdAuthorityFixture['holders'][number]

function engineFor (fx: ThresholdAuthorityFixture, holder: Holder): SignatureTasksEngine {
  return new SignatureTasksEngine(makeNetworkRef(), { db: fx.elec.ctx.db, user: holder.user, intakeOpener: fx.elec.ctx.intakeOpener })
}

async function countRows (db: Database, sql: string, params: Record<string, SqlValue> = {}): Promise<number> {
  const row = await db.prepare(sql).get(params)
  return Number(row?.n ?? 0)
}

function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

function makeTestPayload (authorityId: string): RegisterInit {
  return {
    registrant: {
      id: crypto.randomUUID(),
      authorityId,
      expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000),
    },
    private: {
      expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000),
      details: [],
    },
  }
}

async function submitPendingRequest (ctx: EngineContext, authorityId: string): Promise<string> {
  const requester = randomTestKeyPair()
  const engine = new RegistrationEngine(ctx)
  const init: RegistrationRequestInit = {
    id: crypto.randomUUID(),
    authorityId,
    payload: makeTestPayload(authorityId),
    submittedAt: toIsoZDatetime(Date.now()),
  }
  return engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
}

async function ownTask (engine: SignatureTasksEngine, requestId: string): Promise<RegistrantSignatureTask> {
  const tasks = await engine.getRequestedSignatures(true)
  const task = tasks.find(
    (t) => t.signatureType === 'registrant' && (t as RegistrantSignatureTask).requestId === requestId
  ) as RegistrantSignatureTask | undefined
  if (!task) throw new Error(`ownTask: no pending registrant task for requestId=${requestId}`)
  return task
}

async function rejectVote (engine: SignatureTasksEngine, requestId: string): Promise<RegistrantSignatureTask> {
  const task = await ownTask(engine, requestId)
  await engine.completeSignature(task, { isAccepted: false, signature: { signature: '', signerKey: '', signerUserId: '' } })
  return task
}

async function seedThresholdRequest (): Promise<{ fx: ThresholdAuthorityFixture; requestId: string }> {
  const fx = await createThresholdAuthority({ holderCount: 3 })
  await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)
  const requestId = await submitPendingRequest(fx.elec.ctx, fx.authorityId)
  // The inbox seed pass fans the tasks out to every current holder.
  await engineFor(fx, fx.holders[0]!).getRequestedSignatures(true)
  return { fx, requestId }
}

describe('registrant signing status seam (D-11 vrg)', function () {
  this.timeout(60_000)

  it('RS1: progress at vrg threshold 2 matches the session behind the officer\'s own task', async () => {
    const { fx, requestId } = await seedThresholdRequest()
    const engine = engineFor(fx, fx.holders[0]!)
    const status = await engine.getRegistrantSigningStatus(requestId)
    expect(status).to.not.equal(null)
    expect(status!.scope).to.equal('vrg')
    expect(status!.threshold).to.equal(2)
    expect(status!.signatures).to.equal(0)
    expect(status!.openTasks).to.equal(3)
    expect(status!.reached).to.equal(false)
    expect(status!.unreachable).to.equal(false)
    const own = await ownTask(engine, requestId)
    const ownStatus = await engine.getTaskSigningStatus(own)
    expect(status!.nonce).to.equal(ownStatus!.nonce)
  })

  it('RS2: the status survives the caller\'s own vote', async () => {
    const { fx, requestId } = await seedThresholdRequest()
    const engine = engineFor(fx, fx.holders[0]!)
    const task = await rejectVote(engine, requestId)
    expect(await engine.getTaskSigningStatus(task)).to.equal(null)
    const status = await engine.getRegistrantSigningStatus(requestId)
    expect(status).to.not.equal(null)
    expect(status!.rejected).to.equal(1)
    expect(status!.openTasks).to.equal(2)
    expect(status!.unreachable).to.equal(false)
  })

  it('RS3: unreachable once too few officers can still approve, request stays pending', async () => {
    const { fx, requestId } = await seedThresholdRequest()
    await rejectVote(engineFor(fx, fx.holders[0]!), requestId)
    await rejectVote(engineFor(fx, fx.holders[1]!), requestId)
    const status = await engineFor(fx, fx.holders[0]!).getRegistrantSigningStatus(requestId)
    expect(status).to.not.equal(null)
    expect(status!.rejected).to.equal(2)
    expect(status!.openTasks).to.equal(1)
    expect(status!.unreachable).to.equal(true)
    expect(status!.reached).to.equal(false)
    const row = await fx.elec.ctx.db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(row!.Status).to.equal('p')
  })

  it('RS4: a default (threshold 1) authority reports threshold 1', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
    const requestId = await submitPendingRequest(auth.ctx, auth.authority.id)
    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await engine.getRequestedSignatures(true)
    const status = await engine.getRegistrantSigningStatus(requestId)
    expect(status).to.not.equal(null)
    expect(status!.threshold).to.equal(1)
  })

  it('RS5: null (never a throw) for unknown ids, no Task rows yet, no ctx, the mock; an ambiguous nonce is never guessed', async () => {
    const fx = await createThresholdAuthority({ holderCount: 3 })
    await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)
    const engine = engineFor(fx, fx.holders[0]!)
    expect(await engine.getRegistrantSigningStatus('no-such-request')).to.equal(null)

    // A pending request whose seed pass has not run yet has no Task row.
    const requestId = await submitPendingRequest(fx.elec.ctx, fx.authorityId)
    expect(await engine.getRegistrantSigningStatus(requestId)).to.equal(null)

    expect(await new SignatureTasksEngine(makeNetworkRef()).getRegistrantSigningStatus(requestId)).to.equal(null)
    expect(await new MockSignatureTasksEngine().getRegistrantSigningStatus(requestId)).to.equal(null)

    // Ambiguity: two registrant Task rows with different nonces. The schema refuses a raw row
    // fixture, so the branch is proven with a stubbed query.
    const stub = (rows: Array<{ SigningNonce: string | null }>) =>
      ({ eval: async function * () { for (const r of rows) yield r } }) as unknown as Database
    expect(await findRegistrantSessionNonce(stub([{ SigningNonce: 'n1' }, { SigningNonce: 'n2' }]), 'r')).to.equal(undefined)
    expect(await findRegistrantSessionNonce(stub([]), 'r')).to.equal(undefined)
    expect(await findRegistrantSessionNonce(stub([{ SigningNonce: '' }]), 'r')).to.equal(undefined)
    expect(await findRegistrantSessionNonce(stub([{ SigningNonce: 'n1' }]), 'r')).to.equal('n1')
  })

  it('RS6: read-only — row counts unchanged across ten calls', async () => {
    const { fx, requestId } = await seedThresholdRequest()
    const db = fx.elec.ctx.db
    const engine = engineFor(fx, fx.holders[0]!)
    const snapshot = async () => ({
      task: await countRows(db, 'select count(*) as n from Task'),
      adminSigning: await countRows(db, 'select count(*) as n from AdminSigning'),
      officerSignature: await countRows(db, 'select count(*) as n from OfficerSignature'),
      adminSignature: await countRows(db, 'select count(*) as n from AdminSignature'),
      extension: await countRows(db, 'select count(*) as n from RegistrantSignatureTaskExtension'),
    })
    const before = await snapshot()
    for (let i = 0; i < 10; i++) await engine.getRegistrantSigningStatus(requestId)
    expect(await snapshot()).to.deep.equal(before)
  })
})
