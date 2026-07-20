/**
 * Phase 10 Plan 01 — Tasks-engine builder unit tests.
 *
 * Per BTEST-01: ~8 unit tests per builder, UNSKIPPED.
 * Per BTEST-02: 1 equivalence smoke per builder (it.skip + quereus#23).
 * Per FACT-04: mock-engine parity verified for all 3 task engines.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'
import type {
  IKeysTasksEngine,
  ISignatureTasksEngine,
  IOnboardingTasksEngine,
  NetworkReference,
  ReleaseKeyTask,
  SignatureTask,
  SignatureResult
} from '@votetorrent/vote-core'
import { CompleteKeyReleaseBuilder } from '../src/tasks/builders/complete-key-release-builder.js'
import { CompleteSignatureBuilder } from '../src/tasks/builders/complete-signature-builder.js'
import { SetOnboardingTaskCompletedBuilder } from '../src/tasks/builders/set-onboarding-task-completed-builder.js'
import { MockKeysTasksEngine } from '../src/tasks/mock-keys-tasks-engine.js'
import { MockSignatureTasksEngine } from '../src/tasks/mock-signature-tasks-engine.js'
import { MockOnboardingTasksEngine } from '../src/tasks/mock-onboarding-tasks-engine.js'
import { KeysTasksEngine } from '../src/tasks/keys-tasks-engine.js'
import { OnboardingTasksEngine } from '../src/tasks/onboarding-tasks-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { createTestNetwork, addTestAuthority } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { digestToBytes } from '../src/utils.js'

// ---- Stub engine factories (minimal interface satisfaction) ----

function makeStubKeysTasksEngine (): IKeysTasksEngine {
  return {
    completeKeyRelease: async (_task: ReleaseKeyTask) => {},
    getKeysToRelease: async (_pending: boolean) => [],
    buildCompleteKeyRelease () { return new CompleteKeyReleaseBuilder(this) }
  }
}

function makeStubSignatureTasksEngine (): ISignatureTasksEngine {
  return {
    completeSignature: async (_task: SignatureTask, _result: SignatureResult) => {},
    getRequestedSignatures: async (_pending: boolean) => [],
    buildCompleteSignature () { return new CompleteSignatureBuilder(this) }
  }
}

function makeStubOnboardingTasksEngine (): IOnboardingTasksEngine {
  return {
    setOnboardingTaskCompleted: async (_taskId: string) => {},
    getCompletedOnboardingTasks: async () => [],
    buildSetOnboardingTaskCompleted () { return new SetOnboardingTaskCompletedBuilder(this) }
  }
}

// ---- Fixture helpers ----

function makeReleaseKeyTask (): ReleaseKeyTask {
  return {
    type: 'release-key',
    userId: 'user-1',
    network: {
      hash: 'abc123',
      relays: ['/ip4/127.0.0.1/tcp/4001/p2p/test-peer'],
      imageUrl: 'https://example.com/img.png',
      name: 'Test Network',
      primaryAuthorityDomainName: 'test.example.com'
    },
    election: {
      election: {
        id: 'election-1',
        authorityId: 'auth-1',
        title: 'Test Election',
        date: Date.now(),
        revisionDeadline: Date.now(),
        type: 0,
        ballotDeadline: Date.now()
      },
      current: {
        electionId: 'election-1',
        revision: 1,
        revisionTimestamp: [Date.now()],
        tags: [],
        instructions: '',
        keyholders: [],
        timeline: {} as Record<string, number>,
        keyholderThreshold: 1
      }
    }
  }
}

function makeSignatureTask (): SignatureTask {
  return {
    type: 'signature',
    userId: 'user-1',
    signatureType: 'admin',
    network: {
      hash: 'abc123',
      relays: ['/ip4/127.0.0.1/tcp/4001/p2p/test-peer'],
      imageUrl: 'https://example.com/img.png',
      name: 'Test Network',
      primaryAuthorityDomainName: 'test.example.com'
    }
  }
}

function makeSignatureResult (): SignatureResult {
  return {
    isAccepted: true,
    signature: {
      signature: 'aa'.repeat(64),
      signerKey: '02' + 'bb'.repeat(32),
      signerUserId: 'user-1'
    }
  }
}

// ====================================================================
// CompleteKeyReleaseBuilder
// ====================================================================

describe('CompleteKeyReleaseBuilder', () => {
  it('empty builder reports isValid===false and lists required missingFields', () => {
    const engine = makeStubKeysTasksEngine()
    const builder = new CompleteKeyReleaseBuilder(engine)
    expect(builder.isValid()).to.equal(false)
    const missing = builder.missingFields()
    expect(missing.length).to.be.greaterThan(0)
    expect(missing.map(m => m.path)).to.include('task')
  })

  it('per-setter validation: task with wrong type records BuilderError without throwing', () => {
    const engine = makeStubKeysTasksEngine()
    const badTask = { ...makeReleaseKeyTask(), type: 'wrong-type' } as unknown as ReleaseKeyTask
    const builder = new CompleteKeyReleaseBuilder(engine).setTask(badTask)
    expect(builder.isValid()).to.equal(false)
    const errs = builder.errors()
    expect(errs.some(e => e.path === 'task.type')).to.equal(true)
  })

  it('errors/missingFields progression as setTask fills field', () => {
    const engine = makeStubKeysTasksEngine()
    const b1 = new CompleteKeyReleaseBuilder(engine)
    expect(b1.missingFields().length).to.equal(1) // task missing

    const b2 = b1.setTask(makeReleaseKeyTask())
    expect(b2.missingFields().length).to.equal(0)
    expect(b2.errors().length).to.equal(0)
    expect(b2.isValid()).to.equal(true)
  })

  it('SC4 DB-FREE: isValid===true => commit() does not throw AND double-commit throws BuilderAlreadyCommittedError synchronously', async () => {
    const engine = makeStubKeysTasksEngine()
    let called = false
    engine.completeKeyRelease = async (_task: ReleaseKeyTask) => { called = true }
    const builder = new CompleteKeyReleaseBuilder(engine).setTask(makeReleaseKeyTask())
    expect(builder.isValid()).to.equal(true)
    await builder.commit()
    expect(called).to.equal(true)
    expect(() => builder.commit()).to.throw(BuilderAlreadyCommittedError)
  })

  it('round-trip serialization: toJSON/fromJSON reproduces same draft and validation state', () => {
    const engine = makeStubKeysTasksEngine()
    const task = makeReleaseKeyTask()
    const builder = new CompleteKeyReleaseBuilder(engine).setTask(task)
    const json = builder.toJSON()
    const restored = CompleteKeyReleaseBuilder.fromJSON(json, engine)
    expect(restored.isValid()).to.equal(builder.isValid())
    expect(restored.toJSON()).to.deep.equal(json)
  })

  it('toEngineInput returns ReleaseKeyTask shape; throws BuilderValidationError on incomplete', () => {
    const engine = makeStubKeysTasksEngine()
    const empty = new CompleteKeyReleaseBuilder(engine)
    expect(() => empty.toEngineInput()).to.throw(BuilderValidationError)

    const full = empty.setTask(makeReleaseKeyTask())
    const input = full.toEngineInput()
    expect(input.type).to.equal('release-key')
    expect(input.userId).to.equal('user-1')
  })

  it('FACT-04 parity: MockKeysTasksEngine.buildCompleteKeyRelease() returns instanceof CompleteKeyReleaseBuilder', () => {
    const mock = new MockKeysTasksEngine({} as any)
    const builder = mock.buildCompleteKeyRelease()
    expect(builder).to.be.instanceOf(CompleteKeyReleaseBuilder)
  })

  it('REAL ENGINE equivalence smoke: engine.completeKeyRelease(task) vs builder.setTask(task).commit()', async () => {
    const stubRef: NetworkReference = {
      hash: 'h'.repeat(16),
      name: 'Test Network',
      relays: ['/dns4/relay.example.com/tcp/443/wss'],
      primaryAuthorityDomainName: 'authority.example.com'
    }
    const task = makeReleaseKeyTask()
    // Direct path — UPDATE is a no-op on empty Task table (no throw)
    const { ctx: ctx1 } = await createTestNetwork()
    const eng1 = new KeysTasksEngine(stubRef, ctx1)
    await eng1.completeKeyRelease(task)  // no throw
    // Builder path
    const { ctx: ctx2 } = await createTestNetwork()
    const eng2 = new KeysTasksEngine(stubRef, ctx2)
    await eng2.buildCompleteKeyRelease().setTask(task).commit()  // no throw
  })
})

// ====================================================================
// CompleteSignatureBuilder
// ====================================================================

describe('CompleteSignatureBuilder', () => {
  it('empty builder reports isValid===false and lists required missingFields', () => {
    const engine = makeStubSignatureTasksEngine()
    const builder = new CompleteSignatureBuilder(engine)
    expect(builder.isValid()).to.equal(false)
    const missing = builder.missingFields()
    expect(missing.length).to.equal(2)
    expect(missing.map(m => m.path)).to.include('task')
    expect(missing.map(m => m.path)).to.include('result')
  })

  it('per-setter validation: task with invalid signatureType records BuilderError', () => {
    const engine = makeStubSignatureTasksEngine()
    const badTask = { ...makeSignatureTask(), signatureType: 'invalid' } as unknown as SignatureTask
    const builder = new CompleteSignatureBuilder(engine).setTask(badTask)
    expect(builder.isValid()).to.equal(false)
    const errs = builder.errors()
    expect(errs.some(e => e.path === 'task.signatureType')).to.equal(true)
  })

  it('per-setter validation: result with missing signature fields records BuilderError', () => {
    const engine = makeStubSignatureTasksEngine()
    const badResult = { isAccepted: true, signature: {} } as unknown as SignatureResult
    const builder = new CompleteSignatureBuilder(engine).setResult(badResult)
    const errs = builder.errors()
    expect(errs.some(e => e.path.startsWith('result.signature'))).to.equal(true)
  })

  it('errors/missingFields progression as setTask+setResult fill fields', () => {
    const engine = makeStubSignatureTasksEngine()
    const b1 = new CompleteSignatureBuilder(engine)
    expect(b1.missingFields().length).to.equal(2) // task + result

    const b2 = b1.setTask(makeSignatureTask())
    expect(b2.missingFields().length).to.equal(1) // result still missing

    const b3 = b2.setResult(makeSignatureResult())
    expect(b3.missingFields().length).to.equal(0)
    expect(b3.errors().length).to.equal(0)
    expect(b3.isValid()).to.equal(true)
  })

  it('SC4 DB-FREE: isValid===true => commit() does not throw AND double-commit throws', async () => {
    const engine = makeStubSignatureTasksEngine()
    let calledWith: [SignatureTask, SignatureResult] | null = null
    engine.completeSignature = async (task: SignatureTask, result: SignatureResult) => {
      calledWith = [task, result]
    }
    const builder = new CompleteSignatureBuilder(engine)
      .setTask(makeSignatureTask())
      .setResult(makeSignatureResult())
    expect(builder.isValid()).to.equal(true)
    await builder.commit()
    expect(calledWith).to.not.equal(null)
    expect(() => builder.commit()).to.throw(BuilderAlreadyCommittedError)
  })

  it('round-trip serialization: toJSON/fromJSON reproduces same draft and validation state', () => {
    const engine = makeStubSignatureTasksEngine()
    const builder = new CompleteSignatureBuilder(engine)
      .setTask(makeSignatureTask())
      .setResult(makeSignatureResult())
    const json = builder.toJSON()
    const restored = CompleteSignatureBuilder.fromJSON(json, engine)
    expect(restored.isValid()).to.equal(builder.isValid())
    expect(restored.toJSON()).to.deep.equal(json)
  })

  it('toEngineInput returns {task, result} shape; throws on incomplete', () => {
    const engine = makeStubSignatureTasksEngine()
    const empty = new CompleteSignatureBuilder(engine)
    expect(() => empty.toEngineInput()).to.throw(BuilderValidationError)

    const full = empty.setTask(makeSignatureTask()).setResult(makeSignatureResult())
    const input = full.toEngineInput()
    expect(input.task.type).to.equal('signature')
    expect(input.result.isAccepted).to.equal(true)
  })

  it('FACT-04 parity: MockSignatureTasksEngine.buildCompleteSignature() returns instanceof CompleteSignatureBuilder', () => {
    const mock = new MockSignatureTasksEngine()
    const builder = mock.buildCompleteSignature()
    expect(builder).to.be.instanceOf(CompleteSignatureBuilder)
  })

  it('REAL ENGINE equivalence smoke: engine.completeSignature(task, result) vs builder.setTask(task).setResult(result).commit() — confirmed on quereus@4.2.1', async () => {
    const stubRef: NetworkReference = {
      hash: 'h'.repeat(16),
      name: 'Test Network',
      relays: ['/dns4/relay.example.com/tcp/443/wss'],
      primaryAuthorityDomainName: 'authority.example.com'
    }
    const task = makeSignatureTask()   // userId='user-1', signatureType='admin'
    // 999.1 R-02: no longer using the shared makeSignatureResult() dummy — each
    // seedPendingTask() call below builds its own real per-digest SignatureResult
    // (the schema's SignatureValid UDF now verifies these bytes for real).
    const taskNonce = crypto.randomUUID()
    const placeholderSig = 'a'.repeat(128)
    const thresholdPolicies = '[]'

    // ---- Helper: seed a pending admin signature Task in a fresh auth context ----
    async function seedPendingTask (taskId: string) {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      const { ctx } = auth
      const authorityId = auth.authority.id
      const userId = auth.user.id
      const signerKey = auth.user.activeKeys[0]!.key
      const tid = Date.now()
      const now = Date.now()

      const adminRow = await ctx.db
        .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
        .get({ authorityId })
      if (!adminRow) throw new Error('seedPendingTask: CurrentAdmin not found')
      const adminEffectiveAt = adminRow.EffectiveAt as number | string

      // Step 1: ensure ProposedAdmin exists (required by AdminSignatureTaskExtension.MutationValid)
      try {
        await ctx.db.exec(
          `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context IsUserValid = true, Tid = :tid, now = :now,
                        UserId = :userId, UserKey = :signerKey, Signature = :sig
           values (:authorityId, :adminEffectiveAt, :thresholdPolicies)`,
          { authorityId, adminEffectiveAt, thresholdPolicies, tid, now, userId, signerKey, sig: placeholderSig }
        )
      } catch {
        // Idempotent — ProposedAdmin already exists for this (AuthorityId, EffectiveAt) PK.
      }

      // Step 2: seed AdminSigning (required by AdminSignatureTaskExtension.MutationValid).
      // 999.1 R-02/R-04: this row is created BEFORE the officer actually signs (the task
      // is "pending" until completeSignature runs) — same DEBT-11 shape as
      // elections-engine.ts's debugSeedPendingTasks, so it takes the explicit
      // IsPlaceholderSignature escape hatch rather than a real signature.
      await ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad',
                 Digest(:tid, :authorityId, :adminEffectiveAt, :thresholdPolicies),
                 :userId, :signerKey, :sig)`,
        { nonce: taskNonce, authorityId, adminEffectiveAt, thresholdPolicies, tid, now, userId, signerKey, sig: placeholderSig }
      )

      // Compute the REAL AdminSigning.Digest so completeSignature()'s OfficerSignature
      // insert (999.1 R-02: verifies against this Digest via the UDF) can be signed for real.
      const digestRow = await ctx.db
        .prepare('select Digest from AdminSigning where Nonce = :nonce')
        .get({ nonce: taskNonce })
      const digestB64 = digestRow!.Digest as string
      const { privateHex, publicHex } = randomTestKeyPair()
      const realSig = bytesToHex(secp256k1.sign(digestToBytes(digestB64), hexToBytes(privateHex)))
      const realResult: SignatureResult = {
        isAccepted: true,
        signature: { signature: realSig, signerKey: publicHex, signerUserId: userId }
      }

      // Step 3: seed Task + AdminSignatureTaskExtension in an explicit BEGIN/COMMIT
      // transaction. Both deferred CHECKs (ExtensionExists on Task, TaskIdValid on
      // Extension) fire at COMMIT time when both rows are present — the same pattern
      // as elections.spec.ts line 818. Separate auto-committing exec calls cannot
      // satisfy the bidirectional deferred constraint pair.
      await ctx.db.exec('BEGIN')
      try {
        await ctx.db.exec(
          `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
           with context IsMutationValid = true, Tid = :tid
           values (:taskId, 'user-1', 'signature', 'admin', :nonce, 0)`,
          { tid, taskId, nonce: taskNonce }
        )
        await ctx.db.exec(
          `insert into AdminSignatureTaskExtension (TaskId, AuthorityId, AdminEffectiveAt)
           with context Tid = :tid
           values (:taskId, :authorityId, :adminEffectiveAt)`,
          { tid, taskId, authorityId, adminEffectiveAt }
        )
        await ctx.db.exec('COMMIT')
      } catch (err) {
        await ctx.db.exec('ROLLBACK')
        throw err
      }

      return { ctx, ref: auth.ref, result: realResult }
    }

    // ---- Direct path ----
    const { ctx: ctx1, ref: ref1, result: result1 } = await seedPendingTask('task-sig-direct')
    const eng1 = new SignatureTasksEngine(ref1, ctx1)
    await eng1.completeSignature(task, result1)
    const row1 = await ctx1.db
      .prepare('select IsCompleted from Task where Id = :id')
      .get({ id: 'task-sig-direct' })
    expect(row1?.IsCompleted, 'Direct path: Task must be marked completed (IsCompleted===1)').to.satisfy(
      (v: unknown) => v === 1 || v === true, 'expected IsCompleted to be 1 or true'
    )

    // ---- Builder path ----
    const { ctx: ctx2, ref: ref2, result: result2 } = await seedPendingTask('task-sig-builder')
    const eng2 = new SignatureTasksEngine(ref2, ctx2)
    await eng2.buildCompleteSignature().setTask(task).setResult(result2).commit()
    const row2 = await ctx2.db
      .prepare('select IsCompleted from Task where Id = :id')
      .get({ id: 'task-sig-builder' })
    expect(row2?.IsCompleted, 'Builder path: Task must be marked completed (IsCompleted===1)').to.satisfy(
      (v: unknown) => v === 1 || v === true, 'expected IsCompleted to be 1 or true'
    )
  })
})

// ====================================================================
// SetOnboardingTaskCompletedBuilder
// ====================================================================

describe('SetOnboardingTaskCompletedBuilder', () => {
  it('empty builder reports isValid===false and lists required missingFields', () => {
    const engine = makeStubOnboardingTasksEngine()
    const builder = new SetOnboardingTaskCompletedBuilder(engine)
    expect(builder.isValid()).to.equal(false)
    const missing = builder.missingFields()
    expect(missing.length).to.equal(1)
    expect(missing.map(m => m.path)).to.include('taskId')
  })

  it('per-setter validation: empty string records BuilderError without throwing', () => {
    const engine = makeStubOnboardingTasksEngine()
    const builder = new SetOnboardingTaskCompletedBuilder(engine).setTaskId('')
    expect(builder.isValid()).to.equal(false)
    const errs = builder.errors()
    expect(errs.some(e => e.path === 'taskId')).to.equal(true)
  })

  it('errors/missingFields progression as setTaskId fills field', () => {
    const engine = makeStubOnboardingTasksEngine()
    const b1 = new SetOnboardingTaskCompletedBuilder(engine)
    expect(b1.missingFields().length).to.equal(1)

    const b2 = b1.setTaskId('onboarding-task-1')
    expect(b2.missingFields().length).to.equal(0)
    expect(b2.errors().length).to.equal(0)
    expect(b2.isValid()).to.equal(true)
  })

  it('SC4 DB-FREE: isValid===true => commit() does not throw AND double-commit throws', async () => {
    const engine = makeStubOnboardingTasksEngine()
    let calledWith: string | null = null
    engine.setOnboardingTaskCompleted = async (taskId: string) => { calledWith = taskId }
    const builder = new SetOnboardingTaskCompletedBuilder(engine).setTaskId('onboarding-task-1')
    expect(builder.isValid()).to.equal(true)
    await builder.commit()
    expect(calledWith).to.equal('onboarding-task-1')
    expect(() => builder.commit()).to.throw(BuilderAlreadyCommittedError)
  })

  it('round-trip serialization: toJSON/fromJSON reproduces same draft and validation state', () => {
    const engine = makeStubOnboardingTasksEngine()
    const builder = new SetOnboardingTaskCompletedBuilder(engine).setTaskId('onboarding-task-1')
    const json = builder.toJSON()
    const restored = SetOnboardingTaskCompletedBuilder.fromJSON(json, engine)
    expect(restored.isValid()).to.equal(builder.isValid())
    expect(restored.toJSON()).to.deep.equal(json)
  })

  it('toEngineInput returns string; throws on incomplete', () => {
    const engine = makeStubOnboardingTasksEngine()
    const empty = new SetOnboardingTaskCompletedBuilder(engine)
    expect(() => empty.toEngineInput()).to.throw(BuilderValidationError)

    const full = empty.setTaskId('onboarding-task-1')
    const input = full.toEngineInput()
    expect(input).to.equal('onboarding-task-1')
  })

  it('FACT-04 parity: MockOnboardingTasksEngine.buildSetOnboardingTaskCompleted() returns instanceof SetOnboardingTaskCompletedBuilder', () => {
    const mock = new MockOnboardingTasksEngine()
    const builder = mock.buildSetOnboardingTaskCompleted()
    expect(builder).to.be.instanceOf(SetOnboardingTaskCompletedBuilder)
  })

  it('REAL ENGINE equivalence smoke: engine.setOnboardingTaskCompleted(taskId) vs builder.setTaskId(taskId).commit()', async () => {
    const taskId = 'onboarding-task-1'
    // Direct path — UPDATE is a no-op on empty Task table (no throw, IsMutationValid bypass)
    const { ctx: ctx1 } = await createTestNetwork()
    const eng1 = new OnboardingTasksEngine(ctx1)
    await eng1.setOnboardingTaskCompleted(taskId)  // no throw
    // Builder path
    const { ctx: ctx2 } = await createTestNetwork()
    const eng2 = new OnboardingTasksEngine(ctx2)
    await eng2.buildSetOnboardingTaskCompleted().setTaskId(taskId).commit()  // no throw
  })
})
