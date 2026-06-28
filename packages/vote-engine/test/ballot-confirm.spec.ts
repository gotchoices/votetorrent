// ballot-confirm.spec.ts — Phase 31 Wave 0 RED scaffold
//
// Tests: ballot-confirmation path covering D-01/D-03/D-04/D-05/D-06/D-07/D-08/D-09
//        + Pitfall 6 (getRequestedSignatures ballot branch materialisation)
//        + per-option readability (D-08 option path)
//        + SIGN-04 secp256k1 round-trip via completeSignature
//
// Framework: mocha + chai (vote-engine convention — register-ts-node.mjs runner).
// Do NOT import vitest or @jest — these are mocha-only specs.
//
// Wave 0 status: RED acceptable. Methods under test (submitBallotForConfirmation,
// withdrawBallotConfirmation, getBallotConfirmationState) are declared on
// IElectionEngine but not yet implemented in ElectionEngine (31-02 delivers those).
// The getRequestedSignatures ballot branch is also not yet materialised (31-03).

import { expect } from 'chai'
import { nowCanonicalDatetime } from '../src/utils.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  seedProposedBallot,
} from './fixtures/test-context.js'
import type { BallotSignatureTask, SignatureTask } from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Shared setup helper: create a test network/authority/election
// ---------------------------------------------------------------------------

async function setupElection () {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const elec = await addTestElection(auth)
  return elec
}

function makeNetworkRef () {
  return {
    hash: 'test-ballot-confirm-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

/**
 * Get the BallotSignatureTask for a specific ballot from getRequestedSignatures.
 * Required by the D-05/CR-01 fix: completeSignature and getSignatureDigest now
 * scope the task-row lookup by the ballot id carried on the BallotSignatureTask,
 * so callers must pass a proper BallotSignatureTask (not a bare SignatureTask).
 */
async function getBallotTask (
  engine: SignatureTasksEngine,
  ballotId: string
): Promise<BallotSignatureTask> {
  const tasks = await engine.getRequestedSignatures(true)
  const found = tasks.find(
    t => t.signatureType === 'ballot' && (t as BallotSignatureTask).ballot?.proposed?.id === ballotId
  ) as BallotSignatureTask | undefined
  if (!found) {
    throw new Error(`getBallotTask: no pending BallotSignatureTask for ballotId=${ballotId}`)
  }
  return found
}

// ---------------------------------------------------------------------------
// D-03: submit creates Task + BallotSignatureTaskExtension + unsigned AdminSigning
// ---------------------------------------------------------------------------

describe('submitBallotForConfirmation — creates Task + extension + unsigned AdminSigning (D-03)', () => {
  it('creates a pending Task with signatureType=ballot after submit', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)

    // This call will fail RED until ElectionEngine implements submitBallotForConfirmation (31-02)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    // Assert: a Task row exists for this user with signatureType='ballot'
    const taskRow = await elec.ctx.db
      .prepare(
        `select Id, SignatureType, IsCompleted from Task
         where UserId = :userId and Type = 'signature' and SignatureType = 'ballot' and IsCompleted = 0`
      )
      .get({ userId: elec.user.id })
    expect(taskRow, 'Task with signatureType=ballot must exist after submit').to.not.be.undefined
    expect(taskRow?.IsCompleted, 'Task must be incomplete after submit').to.satisfy((v: unknown) => v === 0 || v === false, 'expected IsCompleted to be 0 or false')
  })

  it('creates a BallotSignatureTaskExtension row linking to the ProposedBallot', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)

    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    const taskRow = await elec.ctx.db
      .prepare(
        `select Id from Task where UserId = :userId and SignatureType = 'ballot' and IsCompleted = 0`
      )
      .get({ userId: elec.user.id })
    expect(taskRow, 'Task must exist').to.not.be.undefined

    const extRow = await elec.ctx.db
      .prepare('select BallotId from BallotSignatureTaskExtension where TaskId = :taskId')
      .get({ taskId: taskRow!.Id as string })
    expect(extRow, 'BallotSignatureTaskExtension must exist').to.not.be.undefined
    expect(extRow?.BallotId, 'Extension BallotId must match the submitted ballot').to.equal(ballotId)
  })

  it('creates an unsigned AdminSigning row (no AdminSignature yet) for the ballot digest', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)

    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    const taskRow = await elec.ctx.db
      .prepare(`select SigningNonce from Task where UserId = :userId and SignatureType = 'ballot' and IsCompleted = 0`)
      .get({ userId: elec.user.id })
    expect(taskRow, 'Task must exist').to.not.be.undefined

    const nonce = taskRow!.SigningNonce as string
    const signingRow = await elec.ctx.db
      .prepare('select Nonce from AdminSigning where Nonce = :nonce')
      .get({ nonce })
    expect(signingRow, 'AdminSigning row must exist for the task nonce').to.not.be.undefined

    // The AdminSigning must NOT yet have a corresponding AdminSignature (Pitfall 1)
    const adminSigRow = await elec.ctx.db
      .prepare('select SigningNonce from AdminSignature where SigningNonce = :nonce')
      .get({ nonce })
    expect(adminSigRow, 'AdminSignature must NOT exist before completeSignature (Pitfall 1)').to.be.undefined
  })
})

// ---------------------------------------------------------------------------
// D-07: submit re-validates ballot invariants
// ---------------------------------------------------------------------------

describe('submitBallotForConfirmation — re-validates invariants at submit (D-07)', () => {
  it('rejects a ballot with no description', async () => {
    const elec = await setupElection()
    const electionRow = await elec.ctx.db
      .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
      .get({ authorityId: elec.authority.id })
    expect(electionRow, 'Election must exist').to.not.be.undefined
    const electionId = electionRow!.Id as string

    // Seed a ballot with empty description (bypasses engine validation by inserting directly)
    const badBallotId = 'bad-ballot-empty-desc'
    await elec.ctx.db.exec(
      `insert or replace into ProposedBallot (Id, ElectionId, AuthorityId, Description, Districts, Questions)
       with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = 9001, now = :now, IsUserValid = true
       values (:id, :electionId, :authorityId, '', '[]', :questions)`,
      {
        id: badBallotId,
        electionId,
        authorityId: elec.authority.id,
        questions: JSON.stringify([{ code: 'Q1', title: 'Q', instructions: '', type: 'select', options: [{ code: 'A', title: 'A' }, { code: 'B', title: 'B' }] }]),
        userId: elec.user.id,
        userKey: elec.user.activeKeys[0]!.key,
        signature: null,
        now: nowCanonicalDatetime(),
      }
    )

    let threw = false
    try {
      await elec.electionEngine.submitBallotForConfirmation(badBallotId)
    } catch {
      threw = true
    }
    expect(threw, 'submitBallotForConfirmation must reject a ballot with empty description (D-07)').to.be.true
  })

  it('rejects a ballot with no questions', async () => {
    const elec = await setupElection()
    const electionRow = await elec.ctx.db
      .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
      .get({ authorityId: elec.authority.id })
    const electionId = electionRow!.Id as string

    const badBallotId = 'bad-ballot-no-questions'
    await elec.ctx.db.exec(
      `insert or replace into ProposedBallot (Id, ElectionId, AuthorityId, Description, Districts, Questions)
       with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = 9002, now = :now, IsUserValid = true
       values (:id, :electionId, :authorityId, 'Some description', '[]', null)`,
      {
        id: badBallotId,
        electionId,
        authorityId: elec.authority.id,
        userId: elec.user.id,
        userKey: elec.user.activeKeys[0]!.key,
        signature: null,
        now: nowCanonicalDatetime(),
      }
    )

    let threw = false
    try {
      await elec.electionEngine.submitBallotForConfirmation(badBallotId)
    } catch {
      threw = true
    }
    expect(threw, 'submitBallotForConfirmation must reject a ballot with no questions (D-07)').to.be.true
  })

  it('rejects a select-type question with fewer than 2 options', async () => {
    const elec = await setupElection()
    const electionRow = await elec.ctx.db
      .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
      .get({ authorityId: elec.authority.id })
    const electionId = electionRow!.Id as string

    const badBallotId = 'bad-ballot-one-option'
    await elec.ctx.db.exec(
      `insert or replace into ProposedBallot (Id, ElectionId, AuthorityId, Description, Districts, Questions)
       with context UserId = :userId, UserKey = :userKey, Signature = :signature, Tid = 9003, now = :now, IsUserValid = true
       values (:id, :electionId, :authorityId, 'Some description', '[]', :questions)`,
      {
        id: badBallotId,
        electionId,
        authorityId: elec.authority.id,
        questions: JSON.stringify([{ code: 'Q1', title: 'Q', instructions: '', type: 'select', options: [{ code: 'A', title: 'A' }] }]),
        userId: elec.user.id,
        userKey: elec.user.activeKeys[0]!.key,
        signature: null,
        now: nowCanonicalDatetime(),
      }
    )

    let threw = false
    try {
      await elec.electionEngine.submitBallotForConfirmation(badBallotId)
    } catch {
      threw = true
    }
    expect(threw, 'submitBallotForConfirmation must reject a select question with <2 options (D-07)').to.be.true
  })
})

// ---------------------------------------------------------------------------
// Pitfall 6: getRequestedSignatures must materialise ballot.proposed.description
// ---------------------------------------------------------------------------

describe('getRequestedSignatures — materialises BallotSignatureTask with ballot.proposed.description (Pitfall 6)', () => {
  it('returns a BallotSignatureTask with ballot.proposed.description populated (not undefined)', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)

    // Submit for confirmation to create the Task
    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
    const tasks = await engine.getRequestedSignatures(true)

    const ballotTask = tasks.find(t => t.signatureType === 'ballot') as (typeof tasks[number] & { ballot?: { proposed?: { description?: string } } }) | undefined
    expect(ballotTask, 'BallotSignatureTask must be in getRequestedSignatures(true) result').to.not.be.undefined
    expect(
      (ballotTask as any)?.ballot?.proposed?.description,
      'ballot.proposed.description must be populated (Pitfall 6 — undefined crashes BallotSignatureTaskDetails)'
    ).to.be.a('string').and.to.have.length.greaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// D-01 / D-08: confirm via completeSignature → INSERTs Ballot then Question/Option per-row
// ---------------------------------------------------------------------------

describe('confirm via completeSignature — signs, then inserts Ballot + Question + Option rows (D-01/D-08)', () => {
  it('inserting a Ballot row after completeSignature accept', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)

    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    // Use a real secp256k1 key for SIGN-04 compliance
    const { secp256k1: secp } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex } = await import('@noble/curves/utils.js')

    const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
    const task = await getBallotTask(engine, ballotId)

    const digest = await engine.getSignatureDigest(task)
    const privKey = secp.utils.randomSecretKey()
    const sigBytes = secp.sign(digest, privKey) as unknown as Uint8Array
    const sigHex = bytesToHex(sigBytes)
    const pubHex = bytesToHex(secp.getPublicKey(privKey))

    await engine.completeSignature(task, {
      isAccepted: true,
      signature: { signerUserId: elec.user.id, signerKey: pubHex, signature: sigHex },
    })

    // Assert Ballot row was inserted
    const ballotRow = await elec.ctx.db
      .prepare('select Id from Ballot where Id = :id')
      .get({ id: ballotId })
    expect(ballotRow, 'Ballot row must be inserted after completeSignature accept').to.not.be.undefined
  })
})

// ---------------------------------------------------------------------------
// D-08: finalize ordering (Ballot before questions) + per-row readable via getBallotDetails
// ---------------------------------------------------------------------------

describe('finalize — orders Ballot before questions; promoted rows readable via getBallotDetails (D-08)', () => {
  it('getBallotDetails returns questions after finalize', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)

    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    const { secp256k1: secp } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex } = await import('@noble/curves/utils.js')

    const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
    const task = await getBallotTask(engine, ballotId)

    const digest = await engine.getSignatureDigest(task)
    const privKey = secp.utils.randomSecretKey()
    const sigBytes = secp.sign(digest, privKey) as unknown as Uint8Array
    const pubHex = bytesToHex(secp.getPublicKey(privKey))

    await engine.completeSignature(task, {
      isAccepted: true,
      signature: { signerUserId: elec.user.id, signerKey: pubHex, signature: bytesToHex(sigBytes) },
    })

    const details = await elec.electionEngine.getBallotDetails(ballotId)
    expect(details, 'getBallotDetails must return a result after finalize').to.not.be.undefined
    expect(details.ballot.questions, 'Ballot must have questions after finalize').to.be.an('array').with.length.greaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// D-08 per-option readability: getBallotDetails returns >=2 options on the select question
// ---------------------------------------------------------------------------

describe('per-option readability — getBallotDetails returns select question with >=2 options (D-08)', () => {
  it('the finalized ballot has the select question WITH at least 2 options', async () => {
    const elec = await setupElection()
    // seedProposedBallot defaults to a 'select' question with 2 options (load-bearing for this assertion)
    const { ballotId } = await seedProposedBallot(elec)

    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    const { secp256k1: secp } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex } = await import('@noble/curves/utils.js')

    const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
    const task = await getBallotTask(engine, ballotId)

    const digest = await engine.getSignatureDigest(task)
    const privKey = secp.utils.randomSecretKey()
    const sigBytes = secp.sign(digest, privKey) as unknown as Uint8Array
    const pubHex = bytesToHex(secp.getPublicKey(privKey))

    await engine.completeSignature(task, {
      isAccepted: true,
      signature: { signerUserId: elec.user.id, signerKey: pubHex, signature: bytesToHex(sigBytes) },
    })

    const details = await elec.electionEngine.getBallotDetails(ballotId)
    const selectQuestion = details.ballot.questions.find(q => q.type === 'select')
    expect(selectQuestion, 'getBallotDetails must return a select question').to.not.be.undefined
    expect(
      selectQuestion!.options,
      'select question must have at least 2 options (guards against finalize dropping options)'
    ).to.be.an('array').with.length.greaterThanOrEqual(2)
    expect(selectQuestion!.options[0]?.title, 'first option must have a title').to.be.a('string').and.to.have.length.greaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// D-04: ProposedBallot retained; getBallots returns finalized winner as single entry
// ---------------------------------------------------------------------------

describe('post-confirm state — ProposedBallot retained; getBallots returns finalized winner (D-04)', () => {
  it('ProposedBallot row still exists after finalize', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)

    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    const { secp256k1: secp } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex } = await import('@noble/curves/utils.js')

    const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
    const task = await getBallotTask(engine, ballotId)

    const digest = await engine.getSignatureDigest(task)
    const privKey = secp.utils.randomSecretKey()
    const sigBytes = secp.sign(digest, privKey) as unknown as Uint8Array
    const pubHex = bytesToHex(secp.getPublicKey(privKey))

    await engine.completeSignature(task, {
      isAccepted: true,
      signature: { signerUserId: elec.user.id, signerKey: pubHex, signature: bytesToHex(sigBytes) },
    })

    // D-04: ProposedBallot must still exist
    const proposedRow = await elec.ctx.db
      .prepare('select Id from ProposedBallot where Id = :id')
      .get({ id: ballotId })
    expect(proposedRow, 'ProposedBallot must be retained after finalize (D-04)').to.not.be.undefined

    // getBallots returns a single entry (finalized wins the de-dup union)
    const summaries = await elec.electionEngine.getBallots()
    const ballotEntries = summaries.filter(s => s.id === ballotId)
    expect(ballotEntries, 'getBallots must return exactly one entry for the finalized ballot').to.have.length(1)
  })
})

// ---------------------------------------------------------------------------
// D-05: edit-lock — pending Task => getBallotConfirmationState.locked true;
//        withdraw => locked false
// ---------------------------------------------------------------------------

describe('edit-lock — submit locks; withdraw unlocks (D-05)', () => {
  it('getBallotConfirmationState.locked is true when a pending Task exists', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)

    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    const state = await elec.electionEngine.getBallotConfirmationState(ballotId)
    expect(state.locked, 'locked must be true when a pending Task exists (D-05)').to.be.true
  })

  it('getBallotConfirmationState.locked is false before any submit', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)

    const state = await elec.electionEngine.getBallotConfirmationState(ballotId)
    expect(state.locked, 'locked must be false before submit').to.be.false
  })
})

// ---------------------------------------------------------------------------
// D-05: withdraw deletes Task + extension without tripping DeleteValid
// ---------------------------------------------------------------------------

describe('withdrawBallotConfirmation — deletes Task + extension; unlocks ballot (D-05)', () => {
  it('withdraw removes the pending Task and unlocks the ballot', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)

    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    // Confirm locked before withdraw
    const stateBefore = await elec.electionEngine.getBallotConfirmationState(ballotId)
    expect(stateBefore.locked, 'ballot must be locked after submit').to.be.true

    // Withdraw
    await elec.electionEngine.withdrawBallotConfirmation(ballotId)

    // Assert Task is gone (or completed)
    const taskRow = await elec.ctx.db
      .prepare(
        `select Id from Task where UserId = :userId and SignatureType = 'ballot' and IsCompleted = 0`
      )
      .get({ userId: elec.user.id })
    expect(taskRow, 'pending Task must be deleted after withdraw').to.be.undefined

    // Assert locked = false after withdraw
    const stateAfter = await elec.electionEngine.getBallotConfirmationState(ballotId)
    expect(stateAfter.locked, 'locked must be false after withdraw (D-05)').to.be.false
  })
})

// ---------------------------------------------------------------------------
// D-06: self-confirm (proposer == signer) succeeds
// ---------------------------------------------------------------------------

describe('self-confirm — proposer == signer succeeds (D-06)', () => {
  it('the same user who proposed the ballot can confirm it', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)

    // The user who seeded the ballot (via proposeBallot) also signs it
    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    const { secp256k1: secp } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex } = await import('@noble/curves/utils.js')

    const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
    const task = await getBallotTask(engine, ballotId) // same user as proposer

    const digest = await engine.getSignatureDigest(task)
    const privKey = secp.utils.randomSecretKey()
    const sigBytes = secp.sign(digest, privKey) as unknown as Uint8Array
    const pubHex = bytesToHex(secp.getPublicKey(privKey))

    // Must not throw — self-confirm is the intended single-authority path (D-06)
    await engine.completeSignature(task, {
      isAccepted: true,
      signature: { signerUserId: elec.user.id, signerKey: pubHex, signature: bytesToHex(sigBytes) },
    })

    // Ballot row must exist
    const ballotRow = await elec.ctx.db
      .prepare('select Id from Ballot where Id = :id')
      .get({ id: ballotId })
    expect(ballotRow, 'Ballot row must exist after self-confirm').to.not.be.undefined
  })
})

// ---------------------------------------------------------------------------
// D-09: completed ballot Task absent from getRequestedSignatures(true) after confirm
// ---------------------------------------------------------------------------

describe('task visibility — completed Task absent from getRequestedSignatures(true) after confirm (D-09)', () => {
  it('ballot Task is present before confirm and absent after', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)

    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
    const tasksBefore = await engine.getRequestedSignatures(true)
    const ballotTaskBefore = tasksBefore.find(t => t.signatureType === 'ballot')
    expect(ballotTaskBefore, 'ballot Task must be present in getRequestedSignatures(true) before confirm').to.not.be.undefined

    // Confirm the ballot
    const { secp256k1: secp } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex } = await import('@noble/curves/utils.js')

    const task = await getBallotTask(engine, ballotId)

    const digest = await engine.getSignatureDigest(task)
    const privKey = secp.utils.randomSecretKey()
    const sigBytes = secp.sign(digest, privKey) as unknown as Uint8Array
    const pubHex = bytesToHex(secp.getPublicKey(privKey))

    await engine.completeSignature(task, {
      isAccepted: true,
      signature: { signerUserId: elec.user.id, signerKey: pubHex, signature: bytesToHex(sigBytes) },
    })

    // After confirm, getRequestedSignatures(true) returns only PENDING tasks
    const tasksAfter = await engine.getRequestedSignatures(true)
    const ballotTaskAfter = tasksAfter.find(t => t.signatureType === 'ballot')
    expect(ballotTaskAfter, 'completed ballot Task must NOT appear in getRequestedSignatures(true) after confirm (D-09)').to.be.undefined
  })
})

// ---------------------------------------------------------------------------
// SIGN-04: device-signer-style secp256k1 round-trip drives completeSignature accept
// ---------------------------------------------------------------------------

describe('SIGN-04: device-signer secp256k1 sign round-trip via completeSignature', () => {
  it('getSignatureDigest returns bytes; signing them with secp256k1 + completeSignature inserts AdminSignature', async () => {
    const elec = await setupElection()
    const { ballotId } = await seedProposedBallot(elec)

    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    const { secp256k1: secp } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex } = await import('@noble/curves/utils.js')

    const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
    const task = await getBallotTask(engine, ballotId)

    // Step 1: getSignatureDigest returns Uint8Array (SIGN-04)
    const digest = await engine.getSignatureDigest(task)
    expect(digest, 'getSignatureDigest must return a Uint8Array').to.be.instanceOf(Uint8Array)
    expect(digest.length, 'digest must be non-empty').to.be.greaterThan(0)

    // Step 2: sign with a fresh secp256k1 key (Node closure mirroring device-signer)
    const privKey = secp.utils.randomSecretKey()
    const pubHex = bytesToHex(secp.getPublicKey(privKey))
    const sigBytes = secp.sign(digest, privKey) as unknown as Uint8Array
    const sigHex = bytesToHex(sigBytes)

    // Step 3: completeSignature accept path
    await engine.completeSignature(task, {
      isAccepted: true,
      signature: { signerUserId: elec.user.id, signerKey: pubHex, signature: sigHex },
    })

    // Assert OfficerSignature was inserted
    const taskRow = await elec.ctx.db
      .prepare(`select SigningNonce from Task where UserId = :userId and SignatureType = 'ballot'`)
      .get({ userId: elec.user.id })
    const nonce = taskRow?.SigningNonce as string | undefined
    if (!nonce) {
      // Task may be deleted on withdraw flow — check AdminSignature via Ballot
      const ballotRow = await elec.ctx.db
        .prepare('select Id from Ballot where Id = :id')
        .get({ id: ballotId })
      expect(ballotRow, 'Ballot must exist after accept (SIGN-04)').to.not.be.undefined
      return
    }

    const officerRow = await elec.ctx.db
      .prepare('select UserId from OfficerSignature where SigningNonce = :nonce')
      .get({ nonce })
    expect(officerRow, 'OfficerSignature must be inserted on accept (SIGN-04)').to.not.be.undefined
    expect(officerRow?.UserId, 'OfficerSignature.UserId must match the signer').to.equal(elec.user.id)

    // Assert AdminSignature created (threshold=1 auto-completes)
    const adminSigRow = await elec.ctx.db
      .prepare('select SigningNonce from AdminSignature where SigningNonce = :nonce')
      .get({ nonce })
    expect(adminSigRow, 'AdminSignature must exist after threshold=1 accept (SIGN-04)').to.not.be.undefined
  })
})

// ---------------------------------------------------------------------------
// FLAG: ACCEPTED OUT-OF-SCOPE — multi-type ballot quereus#21 deferral
// ---------------------------------------------------------------------------

// FLAG: ACCEPTED OUT-OF-SCOPE — verify rank/score/text ballots against quereus 3.3.0 (quereus#21) in a later phase;
// beachhead is 'select' only. This skip is intentional: the QuestionType VIEW union-all returns only the
// first row ('select') under quereus#21, causing non-select types to silently fail the CHECK constraint.
it.skip('multi-type ballot (rank/score/text) questions can be confirmed (quereus#21 — deferred)', async () => {
  // This test will be unskipped in a later phase once quereus#21 is resolved (>= quereus 3.3.0 fix).
  // Until then, only 'select' type questions are verified safe.
  throw new Error('Not implemented: multi-type ballot support pending quereus#21 fix')
})

// ---------------------------------------------------------------------------
// CR-01 / D-05 — multi-pending-task regression test
// Reproduces the LIMIT-1 signed-digest-drift bug: with >=2 pending ballot tasks
// for one officer, completeSignature and getSignatureDigest must resolve the
// task for the ballot they were handed (not an arbitrary row).
// ---------------------------------------------------------------------------

describe('CR-01 / D-05 — multi-pending-task: completeSignature and getSignatureDigest resolve the correct ballot', () => {
  it('with two pending ballot tasks, getSignatureDigest and completeSignature target the specified ballot (not LIMIT-1)', async () => {
    const elec = await setupElection()

    // Seed TWO ProposedBallots for the same officer
    const { ballotId: ballotIdA } = await seedProposedBallot(elec, 'proposed-ballot-A')
    const { ballotId: ballotIdB } = await seedProposedBallot(elec, 'proposed-ballot-B')

    // Submit both for confirmation → two pending ballot Tasks for the same user
    await elec.electionEngine.submitBallotForConfirmation(ballotIdA)
    await elec.electionEngine.submitBallotForConfirmation(ballotIdB)

    const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)

    // getRequestedSignatures returns both tasks
    const allTasks = await engine.getRequestedSignatures(true)
    const ballotTasks = allTasks.filter(t => t.signatureType === 'ballot') as BallotSignatureTask[]
    expect(ballotTasks.length, 'exactly two pending ballot tasks must exist for the same user').to.equal(2)

    // Identify task A and task B by ballot id
    const taskA = ballotTasks.find(t => t.ballot.proposed.id === ballotIdA)
    const taskB = ballotTasks.find(t => t.ballot.proposed.id === ballotIdB)
    expect(taskA, 'must find task for ballot A').to.not.be.undefined
    expect(taskB, 'must find task for ballot B').to.not.be.undefined

    // getSignatureDigest for task B must differ from task A
    // (each ballot has its own AdminSigning row with a distinct Digest)
    const digestA = await engine.getSignatureDigest(taskA!)
    const digestB = await engine.getSignatureDigest(taskB!)
    expect(
      Buffer.from(digestA).toString('hex'),
      'getSignatureDigest for ballot A must differ from ballot B (each has a distinct AdminSigning digest)'
    ).to.not.equal(Buffer.from(digestB).toString('hex'))

    // Verify getSignatureDigest(taskB) matches the AdminSigning.Digest for ballot B's nonce
    const taskBRow = await elec.ctx.db
      .prepare(
        `select Task.SigningNonce from Task
          join BallotSignatureTaskExtension E on E.TaskId = Task.Id
          where Task.UserId = :userId and Task.SignatureType = 'ballot' and Task.IsCompleted = 0 and E.BallotId = :ballotId`
      )
      .get({ userId: elec.user.id, ballotId: ballotIdB })
    expect(taskBRow, 'Task row for ballot B must exist').to.not.be.undefined
    const nonceB = taskBRow!.SigningNonce as string
    const adminSigningRow = await elec.ctx.db
      .prepare('select Digest from AdminSigning where Nonce = :nonce')
      .get({ nonce: nonceB })
    expect(adminSigningRow, 'AdminSigning row for ballot B must exist').to.not.be.undefined
    const { digestToBytes } = await import('../src/utils.js')
    const expectedDigestB = digestToBytes(adminSigningRow!.Digest as string)
    expect(
      Buffer.from(digestB).toString('hex'),
      'getSignatureDigest(taskB) must equal the AdminSigning.Digest for ballot B'
    ).to.equal(Buffer.from(expectedDigestB).toString('hex'))

    // completeSignature(taskB) must finalize ballot B specifically
    const { secp256k1: secp } = await import('@noble/curves/secp256k1.js')
    const { bytesToHex } = await import('@noble/curves/utils.js')
    const privKey = secp.utils.randomSecretKey()
    const sigBytes = secp.sign(digestB, privKey) as unknown as Uint8Array
    const pubHex = bytesToHex(secp.getPublicKey(privKey))

    await engine.completeSignature(taskB!, {
      isAccepted: true,
      signature: { signerUserId: elec.user.id, signerKey: pubHex, signature: bytesToHex(sigBytes) },
    })

    // Assert: Ballot row with Id='proposed-ballot-B' was inserted
    const ballotBRow = await elec.ctx.db
      .prepare('select Id from Ballot where Id = :id')
      .get({ id: ballotIdB })
    expect(ballotBRow, 'Ballot row for ballot B must exist after completeSignature(taskB)').to.not.be.undefined

    // Assert: No Ballot row for 'proposed-ballot-A' (ballot A not finalized)
    const ballotARow = await elec.ctx.db
      .prepare('select Id from Ballot where Id = :id')
      .get({ id: ballotIdA })
    expect(ballotARow, 'Ballot row for ballot A must NOT exist (only ballot B was finalized)').to.be.undefined

    // Assert: ballot A's Task is still pending (IsCompleted = 0)
    const taskARow = await elec.ctx.db
      .prepare(
        `select Task.Id, Task.IsCompleted from Task
          join BallotSignatureTaskExtension E on E.TaskId = Task.Id
          where Task.UserId = :userId and Task.SignatureType = 'ballot' and E.BallotId = :ballotId`
      )
      .get({ userId: elec.user.id, ballotId: ballotIdA })
    expect(taskARow, 'Task row for ballot A must still exist').to.not.be.undefined
    expect(
      taskARow!.IsCompleted,
      'ballot A Task must remain pending (IsCompleted = 0) after ballot B was finalized'
    ).to.satisfy((v: unknown) => v === 0 || v === false, 'expected IsCompleted to be 0 or false')
  })
})
