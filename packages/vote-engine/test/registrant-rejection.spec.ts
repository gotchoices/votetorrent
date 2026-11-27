/**
 * registrant-rejection.spec.ts — Phase 48 Plan 12 (D-06, D-07)
 *
 * Proves the D-06 rejection ceremony end-to-end against the REAL Quereus schema with REAL
 * secp256k1 signatures, and the no-sign discipline that makes it safe.
 *
 * A rejection is permanent because that permanence is what lets an applicant be told why, lets
 * a re-application carry its own history (`getPriorRejections`), and makes D-09's transparency
 * counts mean anything (D-06) — a rejection that left no trace would be indistinguishable from a
 * request that was never reviewed.
 *
 * These assertions prove the RECORD and its REACHABILITY, not scope enforcement — the `'vrg'`
 * gate on `DecisionValid` is a data-model label, not an enforced boundary (Phase 999.1).
 * `AdminSigning.SignerKeyValid`/`OfficerSignature.OfficerValid` are hardcoded stub CHECKs, and
 * `AdminSigning.UserIdValid` only requires the signer be SOME officer at that authority.
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { createTestNetwork, addTestAuthority, makeTestSignCallback, provisionTestIntakeRecipient } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { toIsoZDatetime, toDeferredCheckDatetime, restoreCanonicalDatetime } from '../src/signing/ceremony-helpers.js'
import { seedSignedMutation } from '../src/signing/signed-mutation.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { SigningEngine } from '../src/signing/signing-engine.js'
import { verificationCid } from '@votetorrent/vote-core'
import type { EngineContext } from '../src/types.js'
import type {
  ISigningEngine,
  RegisterInit,
  RegistrationRequestInit,
  RegistrationVerificationChecklistItem,
  RegistrantSignatureTask,
  Signature,
} from '@votetorrent/vote-core'

type TestAuthority = Awaited<ReturnType<typeof addTestAuthority>>

// ---------------------------------------------------------------------------
// Module-level helpers (mirrors registrant-approval.spec.ts's shape)
// ---------------------------------------------------------------------------

function makeNetworkRef () {
  return {
    hash: 'test-registrant-rejection-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

async function setup (): Promise<TestAuthority> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  // D-49 (62-31): every test in this file submits a pending request through the real
  // submitRegistrationRequest() (submitPendingRequest below) — now sealed — so a single
  // provisioning call here covers every call site.
  await provisionTestIntakeRecipient(auth.ctx, auth.authority.id)
  return auth
}

/** WR-10 prehash contract: mirrors authority-transport.spec.ts / registrant-approval.spec.ts. */
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

/** Submits one pending RegistrationRequest through the REAL engine method (D-02 intake, 48-07). */
async function submitPendingRequest (
  auth: TestAuthority,
  opts?: { requesterKey?: TestKeyPair; registrantId?: string }
): Promise<{ requestId: string; requester: TestKeyPair; init: RegistrationRequestInit }> {
  const requester = opts?.requesterKey ?? randomTestKeyPair()
  const engine = new RegistrationEngine(auth.ctx)
  const init: RegistrationRequestInit = {
    id: crypto.randomUUID(),
    authorityId: auth.authority.id,
    payload: makeTestPayload(auth.authority.id, opts?.registrantId),
    submittedAt: toIsoZDatetime(Date.now()),
  }
  const requestId = await engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
  return { requestId, requester, init }
}

async function countRows (ctx: EngineContext, sql: string, params: Record<string, unknown> = {}): Promise<number> {
  const row = await ctx.db.prepare(sql).get(params as Record<string, unknown>)
  return Number(row?.n ?? 0)
}

/** The digest primitive the read surface/rejection ceremony both use — the SAME cid(Digest(...)) call shape. */
async function computeChecklistCidFor (ctx: EngineContext, canonical: string): Promise<string> {
  const row = await ctx.db.prepare('select cid(Digest(:canonical)) as c').get({ canonical })
  if (!row || row.c == null) {
    throw new Error('computeChecklistCidFor: cid(Digest(...)) returned null — crypto plugin not registered?')
  }
  return row.c as string
}

/** Runs the real rejectRegistrationRequest ceremony under the fixture officer's REAL secp256k1 key. */
async function rejectRequest (
  auth: TestAuthority,
  requestId: string,
  opts?: { rejectionReason?: string; checklist?: RegistrationVerificationChecklistItem[] }
): Promise<void> {
  const engine = new RegistrationEngine(auth.ctx)
  await engine.rejectRegistrationRequest(
    requestId,
    { checklist: opts?.checklist ?? ['id'], rejectionReason: opts?.rejectionReason ?? 'Photo ID did not match the roll entry' },
    makeTestSignCallback(auth.user)
  )
}

// ---------------------------------------------------------------------------

describe('rejectRegistrationRequest', () => {
  it('rejects a pending request by a real signer, landing Status=r with all four decision columns non-null', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)

    await rejectRequest(auth, requestId, { rejectionReason: 'Photo ID did not match the roll entry' })

    const row = await auth.ctx.db
      .prepare('select Status, RejectionReason, DecidingOfficerUserId, DecidedAt, VerificationCid from RegistrationRequest where Id = :id')
      .get({ id: requestId })
    expect(row!.Status).to.equal('r')
    expect(row!.RejectionReason, 'RejectionReason must be non-null').to.equal('Photo ID did not match the roll entry')
    expect(row!.DecidingOfficerUserId, 'DecidingOfficerUserId must be non-null').to.equal(auth.user.id)
    expect(row!.DecidedAt, 'DecidedAt must be non-null').to.be.a('string').and.not.equal('')
    expect(row!.VerificationCid, 'VerificationCid must be non-null').to.be.a('string').and.not.equal('')
  })

  it('persists a VerificationCid equal to verificationCid(decision.checklist, <db digest>) recomputed independently', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    const checklist: RegistrationVerificationChecklistItem[] = ['id', 'roll']

    await rejectRequest(auth, requestId, { checklist })

    const row = await auth.ctx.db.prepare('select VerificationCid from RegistrationRequest where Id = :id').get({ id: requestId })
    const expectedCid = await verificationCid(checklist, async (canonical) => computeChecklistCidFor(auth.ctx, canonical))
    expect(row!.VerificationCid).to.equal(expectedCid)
  })

  it('throws on an empty/whitespace-only rejectionReason, leaving Status still p', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)

    let threw = false
    try {
      await rejectRequest(auth, requestId, { rejectionReason: '   ' })
    } catch {
      threw = true
    }
    expect(threw, 'a whitespace-only rejectionReason must throw').to.be.true

    const row = await auth.ctx.db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(row!.Status, 'the request must remain pending after a rejected-reason rejection').to.equal('p')
  })

  it('throws on an unknown requestId', async () => {
    const auth = await setup()
    let threw = false
    try {
      await rejectRequest(auth, 'no-such-request-id')
    } catch {
      threw = true
    }
    expect(threw, 'rejecting an unknown requestId must throw').to.be.true
  })

  it('throws on rejecting an already-decided request, leaving the stored RejectionReason unchanged', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    await rejectRequest(auth, requestId, { rejectionReason: 'Original reason' })

    let threw = false
    try {
      await rejectRequest(auth, requestId, { rejectionReason: 'Second attempt reason' })
    } catch {
      threw = true
    }
    expect(threw, 'rejecting an already-decided request must throw').to.be.true

    const row = await auth.ctx.db.prepare('select RejectionReason from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(row!.RejectionReason, 'the ORIGINAL reason must survive a rejected second decision attempt').to.equal('Original reason')
  })
})

// ---------------------------------------------------------------------------
// Task 2 — the no-sign discipline: both negatives, asserted explicitly
// ---------------------------------------------------------------------------

/** Finds the seeded RegistrantSignatureTask for a given requestId out of a pending pull. */
async function getRegistrantTask (engine: SignatureTasksEngine, requestId: string): Promise<RegistrantSignatureTask> {
  const tasks = await engine.getRequestedSignatures(true)
  const found = tasks.find(
    (t) => t.signatureType === 'registrant' && (t as RegistrantSignatureTask).requestId === requestId
  ) as RegistrantSignatureTask | undefined
  expect(found, `registrant task for requestId=${requestId} must be present`).to.not.be.undefined
  return found!
}

/**
 * Wraps a real SigningEngine's `sign` method in a counting proxy — every OTHER ISigningEngine
 * method delegates untouched via Reflect. This is the literal "wrap the engine's signingEngine.sign
 * in a counting proxy" the plan specifies, constructed through SignatureTasksEngine's own
 * constructor-injected `signingEngine` field (48-11's documented injection seam).
 */
/**
 * 62-11 deviation (Rule 1): `SignatureTasksEngine.completeSignature`'s non-admin accept path now
 * calls `signWithOutcome()` directly (D-10's crossedNow signal), not `sign()` — `sign()` itself
 * still delegates to `signWithOutcome()` internally, but that internal call happens on the REAL
 * engine, not through this Proxy, so a Proxy that intercepted only `sign` would silently stop
 * observing every completeSignature-driven signature (both the "never signs on reject" case this
 * spec asserts AND the accept control run that proves the spy is live). Intercepting
 * `signWithOutcome` as well — the ONE signing primitive both `sign()` and `completeSignature`
 * ultimately route through — keeps this spy accurate to its own doc comment's "sign() is never
 * called" claim (which means "no signature is ever recorded", not "this one specific method
 * name is never invoked").
 */
function makeCountingSigningEngine (ctx: EngineContext): { engine: ISigningEngine; counter: { calls: number } } {
  const real = new SigningEngine(ctx)
  const counter = { calls: 0 }
  const engine = new Proxy(real, {
    get (target, prop, receiver) {
      if (prop === 'sign') {
        return async (...args: Parameters<ISigningEngine['sign']>) => {
          counter.calls += 1
          return target.sign(...args)
        }
      }
      if (prop === 'signWithOutcome') {
        return async (...args: Parameters<ISigningEngine['signWithOutcome']>) => {
          counter.calls += 1
          return target.signWithOutcome(...args)
        }
      }
      return Reflect.get(target, prop, receiver)
    }
  }) as unknown as ISigningEngine
  return { engine, counter }
}

describe('completeSignature — registrant reject path', () => {
  it('sign() is never called on reject — and DOES record 1 call on an accept control run, so the spy cannot pass vacuously', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    const { engine: countingSigningEngine, counter } = makeCountingSigningEngine(auth.ctx)
    const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx, countingSigningEngine)
    await tasksEngine.getRequestedSignatures(true)

    const officerSign = makeTestSignCallback(auth.user)
    const task = await getRegistrantTask(tasksEngine, requestId)
    const digestBytes = await tasksEngine.getSignatureDigest(task)
    const headerSignature = await officerSign(digestBytes)

    // asserting only `status === 'r'` here would pass against code that signed anyway — this
    // spec asserts the ABSENCE of the sign() side-effect, not the presence of a status value.
    await tasksEngine.completeSignature(task, { isAccepted: false, signature: headerSignature })

    const signCalls = counter.calls
    expect(signCalls, 'sign() must be called exactly 0 times on reject').to.equal(0)

    // Control run: a fresh pending request, ACCEPTED, on the SAME counting proxy — proves the
    // spy itself is a live signal, not a permanently-broken counter that would pass vacuously
    // either way.
    const { requestId: controlRequestId } = await submitPendingRequest(auth)
    await tasksEngine.getRequestedSignatures(true)
    const controlTask = await getRegistrantTask(tasksEngine, controlRequestId)
    const controlDigest = await tasksEngine.getSignatureDigest(controlTask)
    const controlHeaderSig = await officerSign(controlDigest)
    await tasksEngine.completeSignature(controlTask, {
      isAccepted: true,
      signature: controlHeaderSig,
      sign: officerSign,
      decision: { checklist: ['id'] },
    })
    expect(counter.calls, 'the SAME wrapper DOES record 1 call on an isAccepted:true control run').to.equal(1)
  })

  it('no AdminSignature advance on reject — the count delta is exactly 0', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await tasksEngine.getRequestedSignatures(true)

    const officerSign = makeTestSignCallback(auth.user)
    const task = await getRegistrantTask(tasksEngine, requestId)
    const digestBytes = await tasksEngine.getSignatureDigest(task)
    const headerSignature = await officerSign(digestBytes)
    const nonceRow = await auth.ctx.db
      .prepare(
        `select Task.SigningNonce from Task join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id where E.RequestId = :requestId`
      )
      .get({ requestId })
    const nonce = nonceRow!.SigningNonce as string

    const before = await countRows(auth.ctx, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
    await tasksEngine.completeSignature(task, { isAccepted: false, signature: headerSignature })
    const after = await countRows(auth.ctx, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })

    const adminSignatureDelta = after - before
    expect(adminSignatureDelta, 'the vrg AdminSigning session must not advance on a rejection').to.equal(0)
  })

  it('register() is never reached — a prototype spy on RegistrationEngine.register AND zero new Registrant rows', async () => {
    const auth = await setup()
    const { requestId, init } = await submitPendingRequest(auth)
    const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await tasksEngine.getRequestedSignatures(true)

    const officerSign = makeTestSignCallback(auth.user)
    const task = await getRegistrantTask(tasksEngine, requestId)
    const digestBytes = await tasksEngine.getSignatureDigest(task)
    const headerSignature = await officerSign(digestBytes)

    // Prototype spy: finalizeRegistrantApproval constructs `new RegistrationEngine(ctx)` and calls
    // `.register(...)` directly (no DI seam) — a prototype patch is the only way to observe the
    // CALL without altering the code path itself. Always restored, even on assertion failure.
    let registerCalls = 0
    const originalRegister = RegistrationEngine.prototype.register
    RegistrationEngine.prototype.register = async function (this: RegistrationEngine, ...args: Parameters<typeof originalRegister>) {
      registerCalls += 1
      return originalRegister.apply(this, args)
    } as typeof originalRegister

    try {
      await tasksEngine.completeSignature(task, { isAccepted: false, signature: headerSignature })
    } finally {
      RegistrationEngine.prototype.register = originalRegister
    }

    // The spy proves the CODE PATH; the row count proves the OUTCOME and survives any future
    // refactor of how the register() reference is injected.
    expect(registerCalls, 'register() must be reached exactly 0 times on reject').to.equal(0)

    const anyRegistrant = await auth.ctx.db.prepare('select 1 as x from Registrant where Id = :id').get({ id: init.payload.registrant.id })
    expect(anyRegistrant, 'no Registrant row may exist for a rejected request').to.be.undefined
  })

  it('the task still closes — the discipline forbids advancing the signature, not closing the task', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await tasksEngine.getRequestedSignatures(true)

    const officerSign = makeTestSignCallback(auth.user)
    const task = await getRegistrantTask(tasksEngine, requestId)
    const digestBytes = await tasksEngine.getSignatureDigest(task)
    const headerSignature = await officerSign(digestBytes)

    await tasksEngine.completeSignature(task, { isAccepted: false, signature: headerSignature })

    const taskRow = await auth.ctx.db
      .prepare(`select Task.IsCompleted from Task join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id where E.RequestId = :requestId`)
      .get({ requestId })
    expect(Number(taskRow!.IsCompleted), 'a rejected task must still close').to.equal(1)
  })
})

// ---------------------------------------------------------------------------
// Task 3 — permanence and reachability. No source file is modified by this task; it proves
// properties Task 1, 48-02, and 48-08 already own, and its value is that nothing else proves
// them end to end. Attempts a direct, ceremony-shaped 'r' -> 'a' UPDATE (bypassing the engine,
// since IRegistrationEngine deliberately exposes no approve method) to prove DecisionValid's
// single-transition conjunction, not merely rejectRegistrationRequest's own already-decided guard.
// ---------------------------------------------------------------------------

/**
 * Attempts a fully ceremony-shaped UPDATE RegistrationRequest set Status = :toStatus, built the
 * SAME way rejectRegistrationRequest/finalizeRegistrantApproval build theirs (real seedSignedMutation
 * ceremony, restoreCanonicalDatetime-rebound SubmittedAt/ReceivedAt). Used ONLY to prove
 * DecisionValid's own `old.Status = 'p'` conjunct rejects a transition off an already-decided row —
 * a real signed digest changes nothing when the OLD status disqualifies the row.
 */
async function attemptDirectStatusFlip (auth: TestAuthority, requestId: string, toStatus: 'a' | 'r'): Promise<void> {
  const ctx = auth.ctx
  const row = await ctx.db
    .prepare('select AuthorityId, SubmittedAt, ReceivedAt from RegistrationRequest where Id = :id')
    .get({ id: requestId })
  const authorityId = row!.AuthorityId as string
  const submittedAt = restoreCanonicalDatetime(row!.SubmittedAt as string)
  const receivedAt = restoreCanonicalDatetime(row!.ReceivedAt as string)
  const tid = await allocateTid(ctx.db, 'registration-request')
  const decidedAt = toIsoZDatetime(Date.now())
  const decidedAtForDigest = toDeferredCheckDatetime(decidedAt)
  const verificationCidVal = 'test-direct-flip-cid'
  const rejectionReason = toStatus === 'r' ? 'direct flip attempt' : null
  const digestExpr = 'select Digest(:tid, :requestId, :status, :verificationCid, :decidedAt, :decidingOfficerUserId, :rejectionReason) as d'
  const digestParams = {
    tid,
    requestId,
    status: toStatus,
    verificationCid: verificationCidVal,
    decidedAt: decidedAtForDigest,
    decidingOfficerUserId: auth.user.id,
    rejectionReason,
  }
  const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, makeTestSignCallback(auth.user))
  await ctx.db.exec(
    `update RegistrationRequest
     with context SigningNonce = :signingNonce, Tid = ${tid}
     set Status = :status, VerificationCid = :verificationCid, DecidedAt = :decidedAt, DecidingOfficerUserId = :decidingOfficerUserId,
         RejectionReason = :rejectionReason, SubmittedAt = :submittedAt, ReceivedAt = :receivedAt
     where Id = :requestId`,
    {
      signingNonce: nonce,
      status: toStatus,
      verificationCid: verificationCidVal,
      decidedAt,
      decidingOfficerUserId: auth.user.id,
      rejectionReason,
      submittedAt,
      receivedAt,
      requestId,
    }
  )
}

describe('a rejected request is permanent', () => {
  it('NoDelete rejects a delete attempt, and the row survives', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    await rejectRequest(auth, requestId, { rejectionReason: 'Photo ID mismatch' })

    let threw = false
    try {
      await auth.ctx.db.exec('delete from RegistrationRequest where Id = :id', { id: requestId })
    } catch {
      threw = true
    }
    expect(threw, 'a delete of a decided RegistrationRequest must be rejected by NoDelete').to.be.true

    // Assert on the row's CONTINUED EXISTENCE, not merely that the statement threw.
    const countRow = await auth.ctx.db.prepare('select count(*) as n from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(Number(countRow!.n), 'the row must still exist after the rejected delete attempt').to.equal(1)
  })

  it('admits no further update — a second reject throws, a direct r->a flip is rejected by DecisionValid, and stored decision fields survive byte-identical', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    await rejectRequest(auth, requestId, { rejectionReason: 'Original reason' })

    let secondRejectThrew = false
    try {
      await rejectRequest(auth, requestId, { rejectionReason: 'Second reason' })
    } catch {
      secondRejectThrew = true
    }
    expect(secondRejectThrew, 'a second rejectRegistrationRequest on an already-decided row must throw').to.be.true

    let directFlipThrew = false
    try {
      // old.Status = 'p' is false (already 'r') — DecisionValid's conjunction rejects this
      // regardless of the digest being otherwise well-formed and validly signed.
      await attemptDirectStatusFlip(auth, requestId, 'a')
    } catch {
      directFlipThrew = true
    }
    expect(directFlipThrew, "a direct signed update attempting 'r' -> 'a' must be rejected by DecisionValid").to.be.true

    const row = await auth.ctx.db
      .prepare('select Status, RejectionReason, DecidingOfficerUserId from RegistrationRequest where Id = :id')
      .get({ id: requestId })
    expect(row!.Status, 'Status must remain byte-identical after both rejected attempts').to.equal('r')
    expect(row!.RejectionReason, 'RejectionReason must remain byte-identical after both rejected attempts').to.equal('Original reason')
    expect(row!.DecidingOfficerUserId, 'DecidingOfficerUserId must remain byte-identical after both rejected attempts').to.equal(auth.user.id)
  })

  it('leaves Payload unchanged across the decision — PayloadImmutable plus the reject update setting only the decision columns', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    const before = await auth.ctx.db.prepare('select Payload from RegistrationRequest where Id = :id').get({ id: requestId })

    await rejectRequest(auth, requestId, { rejectionReason: 'Payload must survive this' })

    const after = await auth.ctx.db.prepare('select Payload from RegistrationRequest where Id = :id').get({ id: requestId })
    // This is what lets a later reader see WHAT was refused, not just that something was.
    expect(after!.Payload, 'Payload must be byte-identical across the decision').to.equal(before!.Payload)
  })
})

describe('D-06 reachability — getPriorRejections surfaces the record', () => {
  it('returns exactly one entry carrying the reason and the deciding officer id after a rejection', async () => {
    const auth = await setup()
    const requester = randomTestKeyPair()
    const { requestId } = await submitPendingRequest(auth, { requesterKey: requester })
    await rejectRequest(auth, requestId, { rejectionReason: 'Roll entry not found' })

    const engine = new RegistrationEngine(auth.ctx)
    const rejections = await engine.getPriorRejections(requester.publicHex)
    expect(rejections.length, 'exactly one prior rejection for this requesterKey').to.equal(1)
    expect(rejections[0]!.rejectionReason).to.equal('Roll entry not found')
    expect(rejections[0]!.decidingOfficerUserId).to.equal(auth.user.id)
  })

  it('surfaces the prior rejection on a brand-new submission from the SAME RequesterKey (keyed by key, not request id)', async () => {
    const auth = await setup()
    const requester = randomTestKeyPair()
    const { requestId: firstRequestId } = await submitPendingRequest(auth, { requesterKey: requester })
    await rejectRequest(auth, firstRequestId, { rejectionReason: 'Address could not be verified' })

    // A brand-new submission from the SAME RequesterKey — a DIFFERENT request id.
    const { requestId: secondRequestId } = await submitPendingRequest(auth, { requesterKey: requester })
    expect(secondRequestId, 'the fresh submission must be a genuinely new request id').to.not.equal(firstRequestId)

    const engine = new RegistrationEngine(auth.ctx)
    const rejections = await engine.getPriorRejections(requester.publicHex)
    expect(rejections.map((r) => r.requestId)).to.deep.equal([firstRequestId])
    expect(rejections.map((r) => r.requestId), "the new request's own id must NOT appear in prior rejections").to.not.include(secondRequestId)
  })

  it('returns an empty array for a different RequesterKey — the history does not leak across applicants', async () => {
    const auth = await setup()
    const rejectedRequester = randomTestKeyPair()
    const { requestId } = await submitPendingRequest(auth, { requesterKey: rejectedRequester })
    await rejectRequest(auth, requestId, { rejectionReason: 'Not eligible in this district' })

    const otherRequester = randomTestKeyPair()
    const engine = new RegistrationEngine(auth.ctx)
    const rejections = await engine.getPriorRejections(otherRequester.publicHex)
    expect(rejections, "a different requesterKey's history must not leak the other applicant's rejection").to.deep.equal([])
  })

  it('R3: excludes the named request from its own citation — a rejected request must not cite itself', async () => {
    const auth = await setup()
    const requester = randomTestKeyPair()
    const { requestId } = await submitPendingRequest(auth, { requesterKey: requester })
    await rejectRequest(auth, requestId, { rejectionReason: 'Self-citation must be excluded' })

    const engine = new RegistrationEngine(auth.ctx)
    const rejections = await engine.getPriorRejections(requester.publicHex, requestId)
    expect(rejections, "a rejected request's own detail view must not cite itself as a prior rejection").to.deep.equal([])
  })

  it('R3: a genuine earlier sibling rejection still surfaces when a later request excludes only its own id', async () => {
    const auth = await setup()
    const requester = randomTestKeyPair()
    const { requestId: firstRequestId } = await submitPendingRequest(auth, { requesterKey: requester })
    await rejectRequest(auth, firstRequestId, { rejectionReason: 'Earlier sibling rejection' })

    const { requestId: secondRequestId } = await submitPendingRequest(auth, { requesterKey: requester })
    await rejectRequest(auth, secondRequestId, { rejectionReason: 'Later rejection under review' })

    const engine = new RegistrationEngine(auth.ctx)
    const rejections = await engine.getPriorRejections(requester.publicHex, secondRequestId)
    expect(rejections.map((r) => r.requestId), 'excluding the second request must still surface the earlier sibling').to.deep.equal([firstRequestId])
  })

  it('R3: the one-argument call is unchanged — both rejections still surface with no exclusion supplied', async () => {
    const auth = await setup()
    const requester = randomTestKeyPair()
    const { requestId: firstRequestId } = await submitPendingRequest(auth, { requesterKey: requester })
    await rejectRequest(auth, firstRequestId, { rejectionReason: 'Earlier sibling rejection' })

    const { requestId: secondRequestId } = await submitPendingRequest(auth, { requesterKey: requester })
    await rejectRequest(auth, secondRequestId, { rejectionReason: 'Later rejection under review' })

    const engine = new RegistrationEngine(auth.ctx)
    const rejections = await engine.getPriorRejections(requester.publicHex)
    expect(rejections.map((r) => r.requestId), 'the one-argument form must keep returning both rows, newest-DecidedAt-first').to.deep.equal([secondRequestId, firstRequestId])
  })

  it('R3: an exclusion id that matches nothing is inert — it must not filter any row', async () => {
    const auth = await setup()
    const requester = randomTestKeyPair()
    const { requestId } = await submitPendingRequest(auth, { requesterKey: requester })
    await rejectRequest(auth, requestId, { rejectionReason: 'Unknown exclusion id must not filter' })

    const engine = new RegistrationEngine(auth.ctx)
    const withUnknownExclusion = await engine.getPriorRejections(requester.publicHex, 'no-such-request')
    const withNoExclusion = await engine.getPriorRejections(requester.publicHex)
    expect(withUnknownExclusion.map((r) => r.requestId), 'an id matching nothing must not remove any row').to.deep.equal(withNoExclusion.map((r) => r.requestId))
  })
})
