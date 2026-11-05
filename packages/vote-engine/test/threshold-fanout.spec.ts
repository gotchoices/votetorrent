import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AdminDigestArgs, Signature } from '@votetorrent/vote-core'
import { SigningEngine } from '../src/signing/signing-engine.js'
import { DerivedSigningError } from '../src/signing/threshold.js'
import { fanOutSignatureTasks, FanOutError, SIGNATURE_TYPE_SCOPE } from '../src/signing/fan-out.js'
import { seedSignedMutation } from '../src/signing/signed-mutation.js'
import { BALLOT_HEADER_TID } from '../src/election/election-engine.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import {
  createThresholdAuthority,
  signSessionDigest,
  insertBallotHeaderSession,
  ballotExtensionInserter,
  type ThresholdOfficer,
} from './fixtures/threshold-authority.js'
import { seedProposedBallot } from './fixtures/test-context.js'
import { digestToBytes, nowCanonicalDatetime } from '../src/utils.js'
import type { Database } from '@quereus/quereus'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function installedQuereusVersion (): string {
  const pkgPath = path.join(__dirname, '..', 'node_modules', '@quereus', 'quereus', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
  return pkg.version
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mirrors signing.spec.ts's `realSignAdminDigest` — PATH A `startSigningSession`'s own
 *  `Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies)` formula, signed for real
 *  by a `ThresholdOfficer`'s fixture key. */
async function realSignAdminDigest (
  db: Database,
  authorityId: string,
  digestArgs: AdminDigestArgs,
  officer: ThresholdOfficer
): Promise<Signature> {
  const row = await db
    .prepare('select Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies) as d')
    .get({
      authorityId,
      effectiveAt: digestArgs.effectiveAt,
      officers: digestArgs.officers,
      thresholdPolicies: digestArgs.thresholdPolicies,
    })
  const digestB64 = row!.d as string
  return officer.sign(digestToBytes(digestB64))
}

function placeholderSignature (signerUserId: string): Signature {
  return { signerUserId, signerKey: '0'.repeat(66), signature: '0'.repeat(128) }
}

// ===========================================================================
// threshold core (62-07) — Task 1: contracts, holder-only counting, signDerived,
// getSigningStatus, and the multi-holder fixture.
// ===========================================================================

describe('threshold core (62-07)', function () {
  this.timeout(60_000)

  it('T1: crossedNow is true exactly once per nonce (D-10)', async () => {
    const fx = await createThresholdAuthority()
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-t1')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    const engine = new SigningEngine(fx.elec.ctx)

    const sig0 = await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[0]!.user)
    const r0 = await engine.signWithOutcome(nonce, sig0)
    expect(r0.thresholdReached, 'r0.thresholdReached').to.equal(false)
    expect(r0.crossedNow, 'r0.crossedNow').to.equal(false)

    const sig1 = await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[1]!.user)
    const r1 = await engine.signWithOutcome(nonce, sig1)
    expect(r1.thresholdReached, 'r1.thresholdReached').to.equal(true)
    expect(r1.crossedNow, 'r1.crossedNow').to.equal(true)

    const sig2 = await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[2]!.user)
    const r2 = await engine.signWithOutcome(nonce, sig2)
    expect(r2.thresholdReached, 'r2.thresholdReached').to.equal(true)
    expect(r2.crossedNow, 'r2.crossedNow (late signature)').to.equal(false)

    const adminSigCount = await fx.elec.ctx.db
      .prepare('select count(*) as n from AdminSignature where SigningNonce = :nonce')
      .get({ nonce })
    expect(Number(adminSigCount?.n), 'exactly 1 AdminSignature row').to.equal(1)

    const officerSigCount = await fx.elec.ctx.db
      .prepare('select count(*) as n from OfficerSignature where SigningNonce = :nonce')
      .get({ nonce })
    expect(Number(officerSigCount?.n), 'exactly 3 OfficerSignature rows').to.equal(3)
  })

  it('T2: holder-only counting at threshold>1 (D-08/D-12, Pitfall 5)', async () => {
    const fx = await createThresholdAuthority()
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-t2')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    const engine = new SigningEngine(fx.elec.ctx)

    await engine.signWithOutcome(nonce, await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[0]!.user))

    const rNonHolder = await engine.signWithOutcome(nonce, await signSessionDigest(fx.elec.ctx.db, nonce, fx.nonHolder.user))
    expect(rNonHolder.thresholdReached, 'non-holder signature must not complete').to.equal(false)

    // A non-officer can no longer sign at all: OfficerSignature.OfficerValid is engine-computed
    // (was a hardcoded `true`), so the outsider's signature is refused rather than recorded and
    // ignored.
    let outsiderError: Error | undefined
    try {
      await engine.signWithOutcome(nonce, await signSessionDigest(fx.elec.ctx.db, nonce, fx.outsider))
    } catch (err) {
      outsiderError = err as Error
    }
    expect(outsiderError?.message, 'non-officer signature is refused').to.include('OfficerValid')

    const officerCount = await fx.elec.ctx.db
      .prepare('select count(*) as n from OfficerSignature where SigningNonce = :nonce')
      .get({ nonce })
    expect(Number(officerCount?.n), '2 OfficerSignature rows recorded (holder + non-holder officer)').to.equal(2)

    const adminCount = await fx.elec.ctx.db
      .prepare('select count(*) as n from AdminSignature where SigningNonce = :nonce')
      .get({ nonce })
    expect(Number(adminCount?.n), '0 AdminSignature rows — neither non-holder nor outsider qualified').to.equal(0)

    const status = await engine.getSigningStatus(nonce)
    expect(status?.signatures, 'only the 1 real holder signature qualifies').to.equal(1)

    const r1 = await engine.signWithOutcome(nonce, await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[1]!.user))
    expect(r1.crossedNow, 'a second REAL holder crosses the threshold').to.equal(true)
  })

  it('T3: the same holder signing twice stays at signatures=1 (idempotent)', async () => {
    const fx = await createThresholdAuthority()
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-t3')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    const engine = new SigningEngine(fx.elec.ctx)

    const r0 = await engine.signWithOutcome(nonce, await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[0]!.user))
    expect(r0.thresholdReached).to.equal(false)

    const r0b = await engine.signWithOutcome(nonce, await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[0]!.user))
    expect(r0b.thresholdReached, 'repeat signature must not complete').to.equal(false)
    expect(r0b.crossedNow).to.equal(false)

    const status = await engine.getSigningStatus(nonce)
    expect(status?.signatures, 'repeat signature does not double-count').to.equal(1)
  })

  it('T4: the threshold-1 path is unchanged (rad)', async () => {
    const fx = await createThresholdAuthority()
    const engine = new SigningEngine(fx.elec.ctx)
    const digestArgs: AdminDigestArgs = {
      authorityId: fx.authorityId,
      effectiveAt: 'test-effective-at-t4',
      officers: '[]',
      thresholdPolicies: '[]',
    }
    const sig0 = await realSignAdminDigest(fx.elec.ctx.db, fx.authorityId, digestArgs, fx.holders[0]!)
    const result = await engine.startSigningSession(fx.authorityId, digestArgs, 'rad', sig0)
    expect(result.thresholdReached, 'threshold=1 reached on the first signature').to.equal(true)
    expect(result.crossedNow, 'startSigningSession crossed it').to.equal(true)

    const r1 = await engine.signWithOutcome(result.nonce, await signSessionDigest(fx.elec.ctx.db, result.nonce, fx.holders[1]!.user))
    expect(r1.thresholdReached).to.equal(true)
    expect(r1.crossedNow, 'a second signature on an already-reached rad session').to.equal(false)

    const r2 = await engine.sign(result.nonce, await signSessionDigest(fx.elec.ctx.db, result.nonce, fx.holders[2]!.user))
    expect(r2, 'sign() keeps returning the boolean').to.equal(true)
  })

  it('T5: signDerived inherits header satisfaction (Finding 4.1)', async () => {
    const fx = await createThresholdAuthority()
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-t5')
    const { nonce: header } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    const engine = new SigningEngine(fx.elec.ctx)
    const db = fx.elec.ctx.db

    const derivedNonce = crypto.randomUUID()
    await db.exec(
      `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
       with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
       values (:nonce, :authorityId, :adminEffectiveAt, 'ceb', Digest('derived-62-07', :n), :userId, :signerKey, :signature)`,
      {
        nonce: derivedNonce,
        authorityId: fx.authorityId,
        adminEffectiveAt: fx.adminEffectiveAt,
        n: derivedNonce,
        userId: fx.holders[0]!.user.id,
        signerKey: '0'.repeat(66),
        signature: '0'.repeat(128),
        now: nowCanonicalDatetime(),
      }
    )
    const placeholderSig = placeholderSignature(fx.holders[0]!.user.id)

    let caught: unknown
    try {
      await engine.signDerived(derivedNonce, placeholderSig, header, { isPlaceholderSignature: true })
    } catch (err) {
      caught = err
    }
    expect(caught, 'throws before the header is reached').to.be.instanceOf(DerivedSigningError)
    expect((caught as DerivedSigningError).reason).to.equal('header-not-reached')

    const adminCount0 = await db.prepare('select count(*) as n from AdminSignature where SigningNonce = :n').get({ n: derivedNonce })
    expect(Number(adminCount0?.n), 'no AdminSignature written on refusal').to.equal(0)
    const officerCount0 = await db.prepare('select count(*) as n from OfficerSignature where SigningNonce = :n').get({ n: derivedNonce })
    expect(Number(officerCount0?.n), 'no OfficerSignature written on refusal').to.equal(0)

    await engine.signWithOutcome(header, await signSessionDigest(db, header, fx.holders[0]!.user))
    await engine.signWithOutcome(header, await signSessionDigest(db, header, fx.holders[1]!.user))

    const r1 = await engine.signDerived(derivedNonce, placeholderSig, header, { isPlaceholderSignature: true })
    expect(r1.thresholdReached).to.equal(true)
    expect(r1.crossedNow).to.equal(true)

    const adminCount1 = await db.prepare('select count(*) as n from AdminSignature where SigningNonce = :n').get({ n: derivedNonce })
    expect(Number(adminCount1?.n), 'exactly 1 AdminSignature after the header is reached').to.equal(1)

    const r2 = await engine.signDerived(derivedNonce, placeholderSig, header, { isPlaceholderSignature: true })
    expect(r2.thresholdReached).to.equal(true)
    expect(r2.crossedNow, 'repeat call does not re-cross').to.equal(false)

    // scope-mismatch: a 'rad' header (T4's shape) against a 'ceb' derived row.
    const digestArgs: AdminDigestArgs = {
      authorityId: fx.authorityId,
      effectiveAt: 'test-effective-at-t5',
      officers: '[]',
      thresholdPolicies: '[]',
    }
    const radSig = await realSignAdminDigest(db, fx.authorityId, digestArgs, fx.holders[2]!)
    const radResult = await engine.startSigningSession(fx.authorityId, digestArgs, 'rad', radSig)

    const derivedNonce2 = crypto.randomUUID()
    await db.exec(
      `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
       with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
       values (:nonce, :authorityId, :adminEffectiveAt, 'ceb', Digest('derived-62-07-b', :n), :userId, :signerKey, :signature)`,
      {
        nonce: derivedNonce2,
        authorityId: fx.authorityId,
        adminEffectiveAt: fx.adminEffectiveAt,
        n: derivedNonce2,
        userId: fx.holders[0]!.user.id,
        signerKey: '0'.repeat(66),
        signature: '0'.repeat(128),
        now: nowCanonicalDatetime(),
      }
    )
    let caught2: unknown
    try {
      await engine.signDerived(derivedNonce2, placeholderSignature(fx.holders[0]!.user.id), radResult.nonce, { isPlaceholderSignature: true })
    } catch (err) {
      caught2 = err
    }
    expect(caught2, 'throws on a scope mismatch').to.be.instanceOf(DerivedSigningError)
    expect((caught2 as DerivedSigningError).reason).to.equal('scope-mismatch')
  })

  it('T6: getSigningStatus (D-11)', async () => {
    const fx = await createThresholdAuthority()
    const engine = new SigningEngine(fx.elec.ctx)

    const statusUnknown = await engine.getSigningStatus('unknown-nonce-62-07')
    expect(statusUnknown, 'unknown nonce returns null').to.equal(null)

    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-t6')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    await engine.signWithOutcome(nonce, await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[0]!.user))

    const status = await engine.getSigningStatus(nonce)
    expect(status?.threshold).to.equal(2)
    expect(status?.signatures).to.equal(1)
    expect(status?.reached).to.equal(false)
    expect(status?.scope).to.equal('ceb')
  })
})

// ===========================================================================
// fan-out helper (62-07) — Task 2: the N=3 one-transaction probe (A11), then
// fanOutSignatureTasks's contract and the seedSignedMutation headerNonce route.
// ===========================================================================

describe('fan-out helper (62-07)', function () {
  this.timeout(60_000)

  it('P0: PROBE A11 — N=3 one-transaction Task+Extension insert (A11)', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db

    // Shape (a): no flush between pairs — informational only, NEVER asserted.
    const { ballotId: ballotA } = await seedProposedBallot(fx.elec, 'ballot-p0a')
    const { nonce: nonceA } = await insertBallotHeaderSession(fx, ballotA, fx.holders[0]!.user.id)
    let shapeAOutcome: string
    try {
      await db.exec('BEGIN')
      for (const officer of [fx.holders[1]!, fx.holders[2]!, fx.holders[3]!]) {
        const taskId = crypto.randomUUID()
        await db.exec(
          `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
           with context IsMutationValid = true, Tid = :tid
           values (:id, :userId, 'signature', 'ballot', :nonce, 0)`,
          { id: taskId, userId: officer.user.id, nonce: nonceA, tid: BALLOT_HEADER_TID }
        )
        await db.exec(
          `insert into BallotSignatureTaskExtension (TaskId, BallotId) with context Tid = :tid values (:taskId, :ballotId)`,
          { taskId, ballotId: ballotA, tid: BALLOT_HEADER_TID }
        )
      }
      await db.exec('COMMIT')
      shapeAOutcome = 'pass'
    } catch (err) {
      try {
        await db.exec('ROLLBACK')
      } catch {
        // best-effort — shape (a) is informational only
      }
      shapeAOutcome = `fail: ${err instanceof Error ? err.message : String(err)}`
    }
    // eslint-disable-next-line no-console
    console.log(`PROBE-A11 batched-no-flush: ${shapeAOutcome} (quereus ${installedQuereusVersion()})`)

    // Shape (b): flush after each pair — MUST commit, exactly 3 open Task rows.
    const { ballotId: ballotB } = await seedProposedBallot(fx.elec, 'ballot-p0b')
    const { nonce: nonceB } = await insertBallotHeaderSession(fx, ballotB, fx.holders[0]!.user.id)
    await db.exec('BEGIN')
    for (const officer of [fx.holders[1]!, fx.holders[2]!, fx.holders[3]!]) {
      const taskId = crypto.randomUUID()
      await db.exec(
        `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
         with context IsMutationValid = true, Tid = :tid
         values (:id, :userId, 'signature', 'ballot', :nonce, 0)`,
        { id: taskId, userId: officer.user.id, nonce: nonceB, tid: BALLOT_HEADER_TID }
      )
      await db.exec(
        `insert into BallotSignatureTaskExtension (TaskId, BallotId) with context Tid = :tid values (:taskId, :ballotId)`,
        { taskId, ballotId: ballotB, tid: BALLOT_HEADER_TID }
      )
      await db.runDeferredRowConstraints()
    }
    await db.exec('COMMIT')
    const openCount = await db
      .prepare('select count(*) as n from Task where SigningNonce = :nonce and IsCompleted = 0')
      .get({ nonce: nonceB })
    expect(Number(openCount?.n), 'shape (b) must commit exactly 3 open Task rows').to.equal(3)
  })

  it('F1: fans out to every current holder except the initiator (D-08)', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-f1')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    await new SigningEngine(fx.elec.ctx).signWithOutcome(nonce, await signSessionDigest(db, nonce, fx.holders[0]!.user))

    const taskTid = await allocateTid(db, 'ballot-fanout-test')
    const result = await fanOutSignatureTasks(fx.elec.ctx, {
      authorityId: fx.authorityId,
      scope: 'ceb',
      nonce,
      initiatorUserId: fx.holders[0]!.user.id,
      signatureType: 'ballot',
      taskTid,
      insertExtension: ballotExtensionInserter(db, ballotId),
    })

    const expectedRecipients = [fx.holders[1]!.user.id, fx.holders[2]!.user.id, fx.holders[3]!.user.id].sort()
    expect(result.taskIds.length).to.equal(3)
    expect(result.recipientUserIds).to.deep.equal(expectedRecipients)

    for (const nonRecipientId of [fx.holders[0]!.user.id, fx.nonHolder.user.id, fx.outsider.id]) {
      const row = await db
        .prepare('select count(*) as n from Task where SigningNonce = :nonce and UserId = :userId')
        .get({ nonce, userId: nonRecipientId })
      expect(Number(row?.n), `no Task row for ${nonRecipientId}`).to.equal(0)
    }

    const rows: Array<{ Type: string, SignatureType: string, IsCompleted: number, SigningNonce: string }> = []
    for await (const row of db.eval('select Type, SignatureType, IsCompleted, SigningNonce from Task where SigningNonce = :nonce', { nonce })) {
      rows.push(row as unknown as { Type: string, SignatureType: string, IsCompleted: number, SigningNonce: string })
    }
    expect(rows.length).to.equal(3)
    for (const row of rows) {
      expect(row.Type).to.equal('signature')
      expect(row.SignatureType).to.equal('ballot')
      expect(Number(row.IsCompleted)).to.equal(0)
      expect(row.SigningNonce).to.equal(nonce)
    }
  })

  it('F2: initiatorUserId=null fans out to every holder (A5)', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-f2')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    const taskTid = await allocateTid(db, 'ballot-fanout-test')
    const result = await fanOutSignatureTasks(fx.elec.ctx, {
      authorityId: fx.authorityId,
      scope: 'ceb',
      nonce,
      initiatorUserId: null,
      signatureType: 'ballot',
      taskTid,
      insertExtension: ballotExtensionInserter(db, ballotId),
    })
    expect(result.recipientUserIds.length).to.equal(4)
    expect(result.recipientUserIds).to.deep.equal(fx.holders.map(h => h.user.id).sort())
  })

  it('F3: atomicity — a failing insertExtension leaves zero Task rows', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-f3')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    const taskTid = await allocateTid(db, 'ballot-fanout-test')
    const boom = new Error('boom-f3')
    let calls = 0
    let caught: unknown
    try {
      await fanOutSignatureTasks(fx.elec.ctx, {
        authorityId: fx.authorityId,
        scope: 'ceb',
        nonce,
        initiatorUserId: fx.holders[0]!.user.id,
        signatureType: 'ballot',
        taskTid,
        insertExtension: async (taskId, recipientUserId) => {
          calls++
          if (calls === 2) throw boom
          await ballotExtensionInserter(db, ballotId)(taskId, recipientUserId)
        },
      })
    } catch (err) {
      caught = err
    }
    expect(caught).to.equal(boom)
    const row = await db.prepare('select count(*) as n from Task where SigningNonce = :nonce').get({ nonce })
    expect(Number(row?.n), 'zero Task rows survive a mid-fan-out failure').to.equal(0)
  })

  it('F4: composability — ownsTransaction:false leaves the caller in control', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-f4')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    const taskTid = await allocateTid(db, 'ballot-fanout-test')
    await db.exec('BEGIN')
    await fanOutSignatureTasks(
      fx.elec.ctx,
      {
        authorityId: fx.authorityId,
        scope: 'ceb',
        nonce,
        initiatorUserId: fx.holders[0]!.user.id,
        signatureType: 'ballot',
        taskTid,
        insertExtension: ballotExtensionInserter(db, ballotId),
      },
      { ownsTransaction: false }
    )
    expect(db.getAutocommit(), 'still inside the caller-owned transaction').to.equal(false)
    await db.exec('ROLLBACK')
    const row = await db.prepare('select count(*) as n from Task where SigningNonce = :nonce').get({ nonce })
    expect(Number(row?.n), 'the caller ROLLBACK undoes the fan-out too').to.equal(0)
  })

  it("F5: 'already-reached' is refused (rad)", async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const engine = new SigningEngine(fx.elec.ctx)
    const digestArgs: AdminDigestArgs = {
      authorityId: fx.authorityId,
      effectiveAt: 'test-effective-at-f5',
      officers: '[]',
      thresholdPolicies: '[]',
    }
    const sig = await realSignAdminDigest(db, fx.authorityId, digestArgs, fx.holders[0]!)
    const { nonce } = await engine.startSigningSession(fx.authorityId, digestArgs, 'rad', sig)

    const taskTid = await allocateTid(db, 'admin-fanout-test')
    let caught: unknown
    try {
      await fanOutSignatureTasks(fx.elec.ctx, {
        authorityId: fx.authorityId,
        scope: 'rad',
        nonce,
        initiatorUserId: fx.holders[0]!.user.id,
        signatureType: 'admin',
        taskTid,
        insertExtension: async () => {
          throw new Error('insertExtension must not be called once already-reached')
        },
      })
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(FanOutError)
    expect((caught as FanOutError).reason).to.equal('already-reached')
    const row = await db.prepare('select count(*) as n from Task where SigningNonce = :nonce').get({ nonce })
    expect(Number(row?.n)).to.equal(0)
  })

  it("F6: 'unreachable-at-birth' is refused", async () => {
    const fx = await createThresholdAuthority({
      thresholdPolicies: [
        { policy: 'rad', threshold: 1 },
        { policy: 'ceb', threshold: 5 },
        { policy: 'vrg', threshold: 2 },
      ],
    })
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-f6')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    const taskTid = await allocateTid(db, 'ballot-fanout-test')
    let caught: unknown
    try {
      await fanOutSignatureTasks(fx.elec.ctx, {
        authorityId: fx.authorityId,
        scope: 'ceb',
        nonce,
        initiatorUserId: fx.holders[0]!.user.id,
        signatureType: 'ballot',
        taskTid,
        insertExtension: ballotExtensionInserter(db, ballotId),
      })
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(FanOutError)
    expect((caught as FanOutError).reason).to.equal('unreachable-at-birth')
    const row = await db.prepare('select count(*) as n from Task where SigningNonce = :nonce').get({ nonce })
    expect(Number(row?.n)).to.equal(0)
  })

  it("F7: 'session-mismatch' is refused both ways", async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-f7')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    const taskTid = await allocateTid(db, 'ballot-fanout-test')

    let caughtWrongType: unknown
    try {
      await fanOutSignatureTasks(fx.elec.ctx, {
        authorityId: fx.authorityId,
        scope: 'ceb',
        nonce,
        initiatorUserId: fx.holders[0]!.user.id,
        signatureType: 'registrant',
        taskTid,
        insertExtension: async () => {},
      })
    } catch (err) {
      caughtWrongType = err
    }
    expect(caughtWrongType).to.be.instanceOf(FanOutError)
    expect((caughtWrongType as FanOutError).reason).to.equal('session-mismatch')

    let caughtWrongScope: unknown
    try {
      await fanOutSignatureTasks(fx.elec.ctx, {
        authorityId: fx.authorityId,
        scope: 'vrg',
        nonce,
        initiatorUserId: fx.holders[0]!.user.id,
        signatureType: 'ballot',
        taskTid,
        insertExtension: async () => {},
      })
    } catch (err) {
      caughtWrongScope = err
    }
    expect(caughtWrongScope).to.be.instanceOf(FanOutError)
    expect((caughtWrongScope as FanOutError).reason).to.equal('session-mismatch')
    expect(SIGNATURE_TYPE_SCOPE.ballot).to.equal('ceb')
    expect(SIGNATURE_TYPE_SCOPE.registrant).to.equal('vrg')
    expect(SIGNATURE_TYPE_SCOPE.admin).to.equal('rad')
  })

  it("F8: 'session-not-found' is refused", async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const taskTid = await allocateTid(db, 'ballot-fanout-test')
    let caught: unknown
    try {
      await fanOutSignatureTasks(fx.elec.ctx, {
        authorityId: fx.authorityId,
        scope: 'ceb',
        nonce: 'unknown-nonce-f8-62-07',
        initiatorUserId: fx.holders[0]!.user.id,
        signatureType: 'ballot',
        taskTid,
        insertExtension: async () => {},
      })
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(FanOutError)
    expect((caught as FanOutError).reason).to.equal('session-not-found')
  })

  it('F9: end-to-end — siblings stay open, status derives correctly, no veto (D-09/D-10/D-11)', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const engine = new SigningEngine(fx.elec.ctx)
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-f9')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    await engine.signWithOutcome(nonce, await signSessionDigest(db, nonce, fx.holders[0]!.user))

    const taskTid = await allocateTid(db, 'ballot-fanout-test')
    const fanOutResult = await fanOutSignatureTasks(fx.elec.ctx, {
      authorityId: fx.authorityId,
      scope: 'ceb',
      nonce,
      initiatorUserId: fx.holders[0]!.user.id,
      signatureType: 'ballot',
      taskTid,
      insertExtension: ballotExtensionInserter(db, ballotId),
    })
    expect(fanOutResult.recipientUserIds.length).to.equal(3)

    const taskIdFor = async (userId: string): Promise<string> => {
      const row = await db.prepare('select Id from Task where SigningNonce = :nonce and UserId = :userId').get({ nonce, userId })
      if (!row) throw new Error(`no Task for ${userId}`)
      return row.Id as string
    }

    // Step 1: holders[1]'s Task completed WITHOUT a signature — the exact rejection shape
    // completeSignature uses (signature-tasks-engine.ts).
    const rejectedTaskId = await taskIdFor(fx.holders[1]!.user.id)
    const rejectTid = await allocateTid(db, 'signature-tasks')
    await db.exec(
      `update Task with context IsMutationValid = true, Tid = ${rejectTid} set IsCompleted = 1 where Id = :id`,
      { id: rejectedTaskId }
    )

    let status = await engine.getSigningStatus(nonce)
    expect(status?.signatures, 'step1 signatures').to.equal(1)
    expect(status?.openTasks, 'step1 openTasks').to.equal(2)
    expect(status?.rejected, 'step1 rejected').to.equal(1)
    expect(status?.reached, 'step1 reached').to.equal(false)
    expect(status?.unreachable, 'step1 unreachable').to.equal(false)

    // Step 2: holders[2] signs and crosses.
    const r2 = await engine.signWithOutcome(nonce, await signSessionDigest(db, nonce, fx.holders[2]!.user))
    expect(r2.crossedNow, 'step2 crossedNow').to.equal(true)
    status = await engine.getSigningStatus(nonce)
    expect(status?.reached, 'step2 reached').to.equal(true)

    // Step 3: holders[3]'s Task is STILL open (D-09 — siblings stay open after the threshold).
    const holders3TaskId = await taskIdFor(fx.holders[3]!.user.id)
    const holders3TaskRow = await db.prepare('select IsCompleted from Task where Id = :id').get({ id: holders3TaskId })
    expect(Number(holders3TaskRow?.IsCompleted), 'step3 holders[3] Task still open').to.equal(0)

    // Step 4: holders[3] signs late — recorded, but does not re-cross (D-10).
    const r3 = await engine.signWithOutcome(nonce, await signSessionDigest(db, nonce, fx.holders[3]!.user))
    expect(r3.thresholdReached, 'step4 thresholdReached').to.equal(true)
    expect(r3.crossedNow, 'step4 crossedNow (late signature)').to.equal(false)

    const adminCount = await db.prepare('select count(*) as n from AdminSignature where SigningNonce = :nonce').get({ nonce })
    expect(Number(adminCount?.n), 'exactly 1 AdminSignature row').to.equal(1)
    const officerCount = await db.prepare('select count(*) as n from OfficerSignature where SigningNonce = :nonce').get({ nonce })
    expect(Number(officerCount?.n), 'exactly 3 OfficerSignature rows').to.equal(3)
  })

  it('F10: unreachable when every recipient Task is rejected (D-11)', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const engine = new SigningEngine(fx.elec.ctx)
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-f10')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    await engine.signWithOutcome(nonce, await signSessionDigest(db, nonce, fx.holders[0]!.user))

    const taskTid = await allocateTid(db, 'ballot-fanout-test')
    await fanOutSignatureTasks(fx.elec.ctx, {
      authorityId: fx.authorityId,
      scope: 'ceb',
      nonce,
      initiatorUserId: fx.holders[0]!.user.id,
      signatureType: 'ballot',
      taskTid,
      insertExtension: ballotExtensionInserter(db, ballotId),
    })

    for (const holder of [fx.holders[1]!, fx.holders[2]!, fx.holders[3]!]) {
      const row = await db
        .prepare('select Id from Task where SigningNonce = :nonce and UserId = :userId')
        .get({ nonce, userId: holder.user.id })
      const tid = await allocateTid(db, 'signature-tasks')
      await db.exec(
        `update Task with context IsMutationValid = true, Tid = ${tid} set IsCompleted = 1 where Id = :id`,
        { id: row!.Id as string }
      )
    }

    const status = await engine.getSigningStatus(nonce)
    expect(status?.signatures).to.equal(1)
    expect(status?.openTasks).to.equal(0)
    expect(status?.rejected).to.equal(3)
    expect(status?.unreachable, 'unreachable once every recipient is rejected').to.equal(true)
    expect(status?.reached).to.equal(false)
    const adminCount = await db.prepare('select count(*) as n from AdminSignature where SigningNonce = :nonce').get({ nonce })
    expect(Number(adminCount?.n)).to.equal(0)
  })

  it('F11: seedSignedMutation headerNonce routes through signDerived', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const engine = new SigningEngine(fx.elec.ctx)
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-f11')
    const { nonce: headerNonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    await engine.signWithOutcome(headerNonce, await signSessionDigest(db, headerNonce, fx.holders[0]!.user))
    await engine.signWithOutcome(headerNonce, await signSessionDigest(db, headerNonce, fx.holders[1]!.user))

    const tidWith = await allocateTid(db, 'derived-f11-test')
    const nonceWith = await seedSignedMutation(
      fx.elec.ctx,
      fx.authorityId,
      'ceb',
      tidWith,
      "select Digest(:tid, 'derived-62-07') as d",
      { tid: tidWith },
      fx.holders[0]!.sign,
      { headerNonce }
    )
    const adminCountWith = await db.prepare('select count(*) as n from AdminSignature where SigningNonce = :nonce').get({ nonce: nonceWith })
    expect(Number(adminCountWith?.n), 'headerNonce routes through signDerived').to.equal(1)

    const tidWithout = await allocateTid(db, 'derived-f11-test')
    const nonceWithout = await seedSignedMutation(
      fx.elec.ctx,
      fx.authorityId,
      'ceb',
      tidWithout,
      "select Digest(:tid, 'derived-62-07-b') as d",
      { tid: tidWithout },
      fx.holders[0]!.sign
    )
    const adminCountWithout = await db.prepare('select count(*) as n from AdminSignature where SigningNonce = :nonce').get({ nonce: nonceWithout })
    expect(Number(adminCountWithout?.n), 'without headerNonce, threshold-2 ceb stays unreached (pre-existing gap)').to.equal(0)
  })
})

// ===========================================================================
// threshold-fanout structure (62-07) — Task 3: mechanically enforces D-09
// (SigningEngine and fan-out never close/delete a Task) so a future edit
// cannot silently break it.
// ===========================================================================

describe('threshold-fanout structure (62-07)', () => {
  it('SigningEngine and fan-out.ts never update/delete Task; fan-out.ts flushes deferred constraints', () => {
    const stripComments = (src: string): string =>
      src
        .split('\n')
        .filter(line => {
          const trimmed = line.trim()
          return !trimmed.startsWith('//') && !trimmed.startsWith('*')
        })
        .join('\n')

    const fanOutSrc = stripComments(readFileSync(path.join(__dirname, '..', 'src', 'signing', 'fan-out.ts'), 'utf8'))
    const signingEngineSrc = stripComments(readFileSync(path.join(__dirname, '..', 'src', 'signing', 'signing-engine.ts'), 'utf8'))

    const forbiddenUpdate = new RegExp(['up', 'date\\s+Task'].join(''), 'i')
    const forbiddenDelete = new RegExp(['delete\\s+from\\s+', 'Task'].join(''), 'i')

    expect(forbiddenUpdate.test(fanOutSrc), 'fan-out.ts must never UPDATE Task').to.equal(false)
    expect(forbiddenUpdate.test(signingEngineSrc), 'signing-engine.ts must never UPDATE Task').to.equal(false)
    expect(forbiddenDelete.test(fanOutSrc), 'fan-out.ts must never DELETE FROM Task').to.equal(false)
    expect(forbiddenDelete.test(signingEngineSrc), 'signing-engine.ts must never DELETE FROM Task').to.equal(false)

    expect(fanOutSrc.includes('runDeferredRowConstraints'), 'fan-out.ts flushes deferred constraints').to.equal(true)
    expect(signingEngineSrc.includes('crossedNow'), 'signing-engine.ts carries crossedNow').to.equal(true)
  })
})
