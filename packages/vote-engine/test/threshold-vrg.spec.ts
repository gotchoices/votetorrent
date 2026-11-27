import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Database } from '@quereus/quereus'
import type { RegisterInit, RegistrationRequestInit, RegistrationVerificationChecklistItem, RegistrantSignatureTask, Signature } from '@votetorrent/vote-core'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SigningEngine } from '../src/signing/signing-engine.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { randomTestKeyPair, type TestKeyPair } from './fixtures/keys.js'
import {
  createThresholdAuthority,
  type ThresholdAuthorityFixture,
} from './fixtures/threshold-authority.js'
import { provisionTestIntakeRecipient } from './fixtures/test-context.js'

/**
 * threshold-vrg.spec.ts — 62-11 (D-08..D-12): registrant-approval (`vrg`) threshold-2
 * end-to-end wiring. The first describe pins the CONTEXT "Specific Ideas" defect (RED on
 * the unmodified engine): at vrg threshold 2, the inbox seed pass still seeds only ONE
 * Task (the legacy threshold-1 shape), so the first accept's finalize runs below
 * threshold and the derived `vrg` sessions (DG-2, Registrant, RegistrantPrivate) can
 * never reach AdminSignature.
 */

function makeNetworkRef () {
  return {
    hash: 'test-threshold-vrg-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

function engineFor (fx: ThresholdAuthorityFixture, holder: ThresholdAuthorityFixture['holders'][number]): SignatureTasksEngine {
  // D-49 (62-31): every holder reads through the SAME provisioned opener (fx.elec.ctx.intakeOpener,
  // set by provisionTestIntakeRecipient against the founder) — this file is not testing D-49 itself,
  // it needs every officer's read of a sealed RegistrationRequest.Payload to materialise a REAL
  // RegistrantSignatureTask (with requestId), not degrade to the base-task fallback.
  return new SignatureTasksEngine(makeNetworkRef(), { db: fx.elec.ctx.db, user: holder.user, intakeOpener: fx.elec.ctx.intakeOpener })
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

async function headerNonceForRequest (db: Database, requestId: string): Promise<string> {
  const row = await db
    .prepare(
      `select Task.SigningNonce from Task
         join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id
         where E.RequestId = :requestId
         limit 1`
    )
    .get({ requestId })
  if (!row) throw new Error(`headerNonceForRequest: no Task for requestId=${requestId}`)
  return row.SigningNonce as string
}

/** WR-10 prehash contract — mirrors registrant-approval.spec.ts's makeCallbackSigner
 *  verbatim, adapted for this file's local scope (no vote-core signerUserId). */
function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

function makeTestPayload (authorityId: string, registrantId?: string): RegisterInit {
  return {
    registrant: {
      id: registrantId ?? crypto.randomUUID(),
      authorityId,
      expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000),
    },
    private: {
      expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000),
      details: [],
    },
  }
}

/** Submits one pending RegistrationRequest addressed to `fx.authorityId` through the REAL
 *  engine method (adapted from registrant-approval.spec.ts's submitPendingRequest, no
 *  electionId in the payload). */
async function submitPendingRequest (
  fx: ThresholdAuthorityFixture,
  registrantId?: string
): Promise<{ requestId: string; init: RegistrationRequestInit }> {
  const requester = randomTestKeyPair()
  const engine = new RegistrationEngine(fx.elec.ctx)
  const init: RegistrationRequestInit = {
    id: crypto.randomUUID(),
    authorityId: fx.authorityId,
    payload: makeTestPayload(fx.authorityId, registrantId),
    submittedAt: toIsoZDatetime(Date.now()),
  }
  const requestId = await engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
  return { requestId, init }
}

describe('threshold-2 first accept (vrg, RED pin)', function () {
  this.timeout(60_000)

  it('V0: at vrg threshold 2, the first accept does not throw, mints no Registrant, and leaves the request pending', async () => {
    const fx = await createThresholdAuthority()
    await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)
    const db = fx.elec.ctx.db
    const { requestId, init } = await submitPendingRequest(fx)

    const engine = engineFor(fx, fx.holders[0]!)
    const tasks = await engine.getRequestedSignatures(true)
    const task = tasks.find((t) => t.signatureType === 'registrant' && (t as any).requestId === requestId)
    expect(task, 'holders[0] must have a pending registrant task').to.not.be.undefined

    let caught: unknown
    try {
      await engine.completeSignature(task!, {
        isAccepted: true,
        signature: await fx.holders[0]!.sign(await engine.getSignatureDigest(task!)),
        sign: fx.holders[0]!.sign,
        decision: { checklist: ['id'] },
      })
    } catch (err) {
      caught = err
    }
    expect(caught, `the accept must not throw — got: ${caught instanceof Error ? caught.message : String(caught)}`).to.be.undefined

    const statusRow = await db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(statusRow!.Status, 'RegistrationRequest.Status must still be p').to.equal('p')

    const registrantRow = await db.prepare('select 1 from Registrant where Id = :id').get({ id: init.payload.registrant.id })
    expect(registrantRow, 'no Registrant row must exist').to.be.undefined

    const headerNonce = await headerNonceForRequest(db, requestId)
    const officerCount = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce: headerNonce })
    expect(officerCount, 'exactly 1 OfficerSignature on the header nonce').to.equal(1)
    const adminCount = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce: headerNonce })
    expect(adminCount, '0 AdminSignature at threshold 2 after only 1 accept').to.equal(0)

    const holder0TaskRow = await db
      .prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId')
      .get({ nonce: headerNonce, userId: fx.holders[0]!.user.id })
    expect(Number(holder0TaskRow?.IsCompleted), "holders[0]'s Task must be completed").to.equal(1)
  })
})

/** Task.Id for a specific (nonce, userId) pair — used by V7 to resolve a completed holder's own
 *  Task id directly. */
async function taskIdFor (db: Database, nonce: string, userId: string): Promise<string> {
  const row = await db.prepare('select Id from Task where SigningNonce = :nonce and UserId = :userId').get({ nonce, userId })
  if (!row) throw new Error(`taskIdFor: no Task for nonce=${nonce} userId=${userId}`)
  return row.Id as string
}

/** Count of 'vrg' AdminSigning rows at `authorityId` that are derived (not the header) AND whose
 *  AdminSignature has NOT been written — V2/V3/V7's "every derived session inherited header
 *  satisfaction" probe. Zero means every derived DG-2/Registrant/RegistrantPrivate/... session
 *  reached AdminSignature via signDerived(headerNonce). */
async function derivedVrgUnreachedCount (db: Database, authorityId: string, headerNonce: string): Promise<number> {
  return countRows(
    db,
    `select count(*) as n from AdminSigning A
       where A.AuthorityId = :authorityId and A.Scope = 'vrg' and A.Nonce != :headerNonce
         and not exists (select 1 from AdminSignature S where S.SigningNonce = A.Nonce)`,
    { authorityId, headerNonce }
  )
}

/** Count of DISTINCT derived 'vrg' AdminSigning rows (not the header) at `authorityId` — used
 *  alongside `derivedVrgUnreachedCount` to prove derived sessions actually exist (not merely
 *  "zero because none were created"). */
async function derivedVrgCount (db: Database, authorityId: string, headerNonce: string): Promise<number> {
  return countRows(
    db,
    `select count(*) as n from AdminSigning A where A.AuthorityId = :authorityId and A.Scope = 'vrg' and A.Nonce != :headerNonce`,
    { authorityId, headerNonce }
  )
}

/** Runs the full accept ceremony for a seeded registrant Task under `holder`'s real key —
 *  mirrors registrant-approval.spec.ts's `acceptRequest`, adapted to this file's fixture. */
async function acceptRegistrant (
  fx: ThresholdAuthorityFixture,
  holder: ThresholdAuthorityFixture['holders'][number],
  requestId: string,
  checklist: RegistrationVerificationChecklistItem[] = ['id']
): Promise<RegistrantSignatureTask> {
  const engine = engineFor(fx, holder)
  const tasks = await engine.getRequestedSignatures(true)
  const task = tasks.find(
    (t) => t.signatureType === 'registrant' && (t as RegistrantSignatureTask).requestId === requestId
  ) as RegistrantSignatureTask | undefined
  if (!task) throw new Error(`acceptRegistrant: no pending registrant task for holder=${holder.user.id} requestId=${requestId}`)
  const digest = await engine.getSignatureDigest(task)
  await engine.completeSignature(task, {
    isAccepted: true,
    signature: await holder.sign(digest),
    sign: holder.sign,
    decision: { checklist },
  })
  return task
}

/** Rejects a seeded registrant Task — the D-11 "vote, not veto" shape completeSignature itself
 *  uses (no OfficerSignature, Task completed). */
async function rejectRegistrant (
  fx: ThresholdAuthorityFixture,
  holder: ThresholdAuthorityFixture['holders'][number],
  requestId: string
): Promise<void> {
  const engine = engineFor(fx, holder)
  const tasks = await engine.getRequestedSignatures(true)
  const task = tasks.find(
    (t) => t.signatureType === 'registrant' && (t as RegistrantSignatureTask).requestId === requestId
  ) as RegistrantSignatureTask | undefined
  if (!task) throw new Error(`rejectRegistrant: no pending registrant task for holder=${holder.user.id} requestId=${requestId}`)
  await engine.completeSignature(task, { isAccepted: false, signature: { signature: '', signerKey: '', signerUserId: '' } })
}

describe('vrg threshold-2 end to end (D-08..D-12)', function () {
  this.timeout(60_000)

  it('V1 (D-08 + A5): the inbox seed pass fans out to every current holder, seeding officer included', async () => {
    const fx = await createThresholdAuthority()
    await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)
    const db = fx.elec.ctx.db
    const { requestId } = await submitPendingRequest(fx)

    await engineFor(fx, fx.holders[0]!).getRequestedSignatures(true)
    const nonce = await headerNonceForRequest(db, requestId)

    expect(await openTaskUsers(db, nonce)).to.deep.equal(fx.holders.map((h) => h.user.id).sort())
    for (const nonRecipient of [fx.nonHolder.user.id, fx.outsider.id]) {
      expect(
        await countRows(db, 'select count(*) as n from Task where SigningNonce = :nonce and UserId = :userId', { nonce, userId: nonRecipient })
      ).to.equal(0)
    }
    expect(await countRows(db, "select count(*) as n from AdminSigning where Nonce = :nonce and Scope = 'vrg'", { nonce })).to.equal(1)
    expect(await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })).to.equal(0)

    const taskCountBefore = await countRows(db, 'select count(*) as n from Task where SigningNonce = :nonce', { nonce })
    const extCountBefore = await countRows(db, 'select count(*) as n from RegistrantSignatureTaskExtension where RequestId = :requestId', { requestId })
    const adminSigningCountBefore = await countRows(db, 'select count(*) as n from AdminSigning')

    await engineFor(fx, fx.holders[1]!).getRequestedSignatures(true)

    expect(await countRows(db, 'select count(*) as n from Task where SigningNonce = :nonce', { nonce }), "holders[1]'s pull adds no Task").to.equal(taskCountBefore)
    expect(
      await countRows(db, 'select count(*) as n from RegistrantSignatureTaskExtension where RequestId = :requestId', { requestId }),
      "holders[1]'s pull adds no extension row"
    ).to.equal(extCountBefore)
    expect(await countRows(db, 'select count(*) as n from AdminSigning'), "holders[1]'s pull adds no AdminSigning row").to.equal(adminSigningCountBefore)
  })

  it('V2 (crossing): the second accept mints the Registrant and inherits header satisfaction', async () => {
    const fx = await createThresholdAuthority()
    await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)
    const db = fx.elec.ctx.db
    const { requestId, init } = await submitPendingRequest(fx)
    await engineFor(fx, fx.holders[0]!).getRequestedSignatures(true)
    const nonce = await headerNonceForRequest(db, requestId)

    await acceptRegistrant(fx, fx.holders[0]!, requestId)
    let statusRow = await db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(statusRow!.Status).to.equal('p')
    expect(await countRows(db, 'select count(*) as n from Registrant where Id = :id', { id: init.payload.registrant.id })).to.equal(0)

    await acceptRegistrant(fx, fx.holders[1]!, requestId)
    statusRow = await db.prepare('select Status, DecidingOfficerUserId from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(statusRow!.Status).to.equal('a')
    expect(statusRow!.DecidingOfficerUserId).to.equal(fx.holders[1]!.user.id)
    expect(await countRows(db, 'select count(*) as n from Registrant where Id = :id', { id: init.payload.registrant.id })).to.equal(1)

    const derivedTotal = await derivedVrgCount(db, fx.authorityId, nonce)
    expect(derivedTotal, 'DG-2 + Registrant + RegistrantPrivate derived sessions exist').to.be.greaterThanOrEqual(3)
    expect(await derivedVrgUnreachedCount(db, fx.authorityId, nonce), 'every derived vrg session inherited header satisfaction (signDerived)').to.equal(0)

    for (const holder of [fx.holders[2]!, fx.holders[3]!]) {
      const row = await db.prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId').get({ nonce, userId: holder.user.id })
      expect(Number(row?.IsCompleted), `${holder.user.id} task still open (D-09)`).to.equal(0)
    }
  })

  it('V3 (D-10 late): a third accept after crossing is recorded, re-decides nothing', async () => {
    const fx = await createThresholdAuthority()
    await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)
    const db = fx.elec.ctx.db
    const { requestId, init } = await submitPendingRequest(fx)
    await engineFor(fx, fx.holders[0]!).getRequestedSignatures(true)
    const nonce = await headerNonceForRequest(db, requestId)

    await acceptRegistrant(fx, fx.holders[0]!, requestId)
    await acceptRegistrant(fx, fx.holders[1]!, requestId)

    let caught: unknown
    try {
      await acceptRegistrant(fx, fx.holders[2]!, requestId)
    } catch (err) {
      caught = err
    }
    expect(caught, `a late accept must not throw — got: ${caught instanceof Error ? caught.message : String(caught)}`).to.be.undefined

    const statusRow = await db.prepare('select Status, DecidingOfficerUserId from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(statusRow!.Status).to.equal('a')
    expect(statusRow!.DecidingOfficerUserId, 'unchanged from the crossing officer').to.equal(fx.holders[1]!.user.id)
    expect(await countRows(db, 'select count(*) as n from Registrant where Id = :id', { id: init.payload.registrant.id })).to.equal(1)

    expect(await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })).to.equal(3)
    expect(await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })).to.equal(1)

    const holder2Row = await db.prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId').get({ nonce, userId: fx.holders[2]!.user.id })
    expect(Number(holder2Row?.IsCompleted)).to.equal(1)
  })

  it('V4 (D-11 no veto): a rejection is a vote, not a veto — the request still crosses', async () => {
    const fx = await createThresholdAuthority()
    await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)
    const db = fx.elec.ctx.db
    const { requestId, init } = await submitPendingRequest(fx)
    await engineFor(fx, fx.holders[0]!).getRequestedSignatures(true)
    const nonce = await headerNonceForRequest(db, requestId)

    await rejectRegistrant(fx, fx.holders[0]!, requestId)
    let statusRow = await db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(statusRow!.Status).to.equal('p')

    const status = await new SigningEngine(fx.elec.ctx).getSigningStatus(nonce)
    expect(status?.rejected).to.equal(1)
    expect(status?.unreachable).to.equal(false)

    await acceptRegistrant(fx, fx.holders[1]!, requestId)
    await acceptRegistrant(fx, fx.holders[2]!, requestId)

    statusRow = await db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(statusRow!.Status).to.equal('a')
    expect(await countRows(db, 'select count(*) as n from Registrant where Id = :id', { id: init.payload.registrant.id })).to.equal(1)
  })

  it('V5 (D-11 unreachable): three rejections and one accept leave the session unreachable', async () => {
    const fx = await createThresholdAuthority()
    await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)
    const db = fx.elec.ctx.db
    const { requestId, init } = await submitPendingRequest(fx)
    await engineFor(fx, fx.holders[0]!).getRequestedSignatures(true)
    const nonce = await headerNonceForRequest(db, requestId)

    await rejectRegistrant(fx, fx.holders[0]!, requestId)
    await rejectRegistrant(fx, fx.holders[1]!, requestId)
    await rejectRegistrant(fx, fx.holders[2]!, requestId)
    await acceptRegistrant(fx, fx.holders[3]!, requestId)

    const status = await new SigningEngine(fx.elec.ctx).getSigningStatus(nonce)
    expect(status?.unreachable).to.equal(true)
    expect(status?.reached).to.equal(false)

    const statusRow = await db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(statusRow!.Status).to.equal('p')
    expect(await countRows(db, 'select count(*) as n from Registrant where Id = :id', { id: init.payload.registrant.id })).to.equal(0)
    expect(await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })).to.equal(0)
  })

  it('V6 (reject guard, D-11): a single officer cannot reject above vrg threshold 1', async () => {
    const fx = await createThresholdAuthority()
    await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)
    const db = fx.elec.ctx.db
    const { requestId } = await submitPendingRequest(fx)

    const before = {
      adminSigning: await countRows(db, 'select count(*) as n from AdminSigning'),
      officerSignature: await countRows(db, 'select count(*) as n from OfficerSignature'),
    }

    const engine = new RegistrationEngine({ db, user: fx.holders[0]!.user })
    let caught: unknown
    try {
      await engine.rejectRegistrationRequest(requestId, { checklist: ['id'], rejectionReason: 'x' }, fx.holders[0]!.sign)
    } catch (err) {
      caught = err
    }
    expect(caught, 'a single-officer reject above threshold 1 must throw').to.not.be.undefined
    expect((caught as Error).message).to.include('One officer cannot reject')

    const statusRow = await db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(statusRow!.Status).to.equal('p')
    expect(await countRows(db, 'select count(*) as n from AdminSigning')).to.equal(before.adminSigning)
    expect(await countRows(db, 'select count(*) as n from OfficerSignature')).to.equal(before.officerSignature)
  })

  it('V7 (finalize idempotency): a direct re-invocation after crossing is a no-op', async () => {
    const fx = await createThresholdAuthority()
    await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)
    const db = fx.elec.ctx.db
    const { requestId, init } = await submitPendingRequest(fx)
    await engineFor(fx, fx.holders[0]!).getRequestedSignatures(true)
    const nonce = await headerNonceForRequest(db, requestId)

    await acceptRegistrant(fx, fx.holders[0]!, requestId)
    await acceptRegistrant(fx, fx.holders[1]!, requestId)

    const before = {
      registrant: await countRows(db, 'select count(*) as n from Registrant where Id = :id', { id: init.payload.registrant.id }),
      adminSigning: await countRows(db, 'select count(*) as n from AdminSigning'),
      status: (await db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId }))!.Status,
    }

    const engine1 = engineFor(fx, fx.holders[1]!)
    const taskId1 = await taskIdFor(db, nonce, fx.holders[1]!.user.id)
    let caught: unknown
    try {
      await (engine1 as any).finalizeRegistrantApproval(taskId1, { checklist: ['id'] }, fx.holders[1]!.sign, nonce)
    } catch (err) {
      caught = err
    }
    expect(caught, 'a direct re-invocation must resolve without throwing').to.be.undefined

    expect(await countRows(db, 'select count(*) as n from Registrant where Id = :id', { id: init.payload.registrant.id })).to.equal(before.registrant)
    expect(await countRows(db, 'select count(*) as n from AdminSigning')).to.equal(before.adminSigning)
    const afterStatusRow = await db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(afterStatusRow!.Status).to.equal(before.status)
  })

  it('V8 (threshold 1 unchanged, legacy seed): the pull seeds only the one officer, accept mints', async () => {
    const fx = await createThresholdAuthority({
      thresholdPolicies: [
        { policy: 'rad', threshold: 1 },
        { policy: 'ceb', threshold: 2 },
        { policy: 'vrg', threshold: 1 },
      ],
    })
    await provisionTestIntakeRecipient(fx.elec.ctx, fx.authorityId)
    const db = fx.elec.ctx.db
    const { requestId, init } = await submitPendingRequest(fx)

    await engineFor(fx, fx.holders[0]!).getRequestedSignatures(true)
    const nonce = await headerNonceForRequest(db, requestId)
    expect(await openTaskUsers(db, nonce)).to.deep.equal([fx.holders[0]!.user.id])

    await acceptRegistrant(fx, fx.holders[0]!, requestId)
    const statusRow = await db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(statusRow!.Status).to.equal('a')
    expect(await countRows(db, 'select count(*) as n from Registrant where Id = :id', { id: init.payload.registrant.id })).to.equal(1)
  })
})

export { makeNetworkRef, engineFor, countRows, openTaskUsers, headerNonceForRequest, submitPendingRequest, makeTestPayload, makeCallbackSigner }
