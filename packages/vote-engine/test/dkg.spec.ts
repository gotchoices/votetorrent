/**
 * dkg.spec.ts — 62-17 Task 2 (scenarios A-F) + Task 3 (scenarios G-M,
 * appended below by Task 3).
 *
 * `KeyholderDkgEngine` over ONE shared DB, one independent
 * `InMemoryTestKeyVault` per keyholder device — a 3-of-5 happy path (A), a
 * bad dealer (B), a re-added disqualified keyholder (C), a false complaint
 * (D), the 3-attempt unresolved cap (E) and 3-of-3 threshold-unreachable (F).
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import { secp256k1, secp256k1_FROST } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  buildComplaintEvidence,
  dkgIdentifierForUser,
  dkgRound2,
  parseDkgSecret,
  encryptShare,
  reconstructGroupSecret,
  validateReleasedShare,
  type DkgRound1Wire,
  type EncryptedShare,
  type ReleasedShare
} from '../src/crypto/dkg.js'
import { InMemoryTestKeyVault, KEYHOLDER_DKG_RECEIVING_KEY_POLICY, KeyVaultError, keyholderDkgReceivingKeyAlias, keyholderDkgShareAlias } from '../src/crypto/vault.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { parseRound1Payload, parseRound2Payload, serializeRound2Payload, serializeRound3Payload } from '../src/keyholder/dkg-payloads.js'
import { KeyholderDkgEngine, KeyholderDkgError } from '../src/keyholder/keyholder-dkg-engine.js'
import { KeyReleaseEngine } from '../src/key-release/key-release-engine.js'
import { releasingKeysAt } from '../src/key-release/release-window.js'
import {
  inviteAndAcceptKeyholder,
  postSignedDkgMessage,
  readRoundRecord,
  runDkgToQuiescence,
  seedDkgElection,
  type DkgTestParticipant
} from './fixtures/dkg-keyholders.js'
import { bumpElectionRevision } from './fixtures/test-context.js'
import type { KeyholderDkgSigner } from '@votetorrent/vote-core'

async function countRows (db: Database, electionId: string, revision: number, attempt: number, round: number): Promise<number> {
  const row = await db
    .prepare('select count(*) as c from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = :attempt and DkgRound = :dkgRound')
    .get({ electionId, revision, attempt, dkgRound: round })
  return (row?.c as number | undefined) ?? 0
}

/**
 * A `stopWhen` boundary can be reached by whichever participant's call
 * happens to be the LAST needed — and that same call may cascade straight
 * into posting the NEXT round too (the engine does not artificially stop
 * at a round boundary it just completed). Scenarios that need a specific
 * participant to NOT yet have posted a given round pick dynamically,
 * rather than assuming `participants[0]` is still eligible.
 */
async function pickParticipantAwaitingRound (
  db: Database, electionId: string, revision: number, attempt: number, round: number, participants: DkgTestParticipant[]
): Promise<DkgTestParticipant> {
  for (const p of participants) {
    const row = await db
      .prepare('select 1 as x from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = :attempt and DkgRound = :dkgRound and SenderUserId = :senderUserId')
      .get({ electionId, revision, attempt, dkgRound: round, senderUserId: p.userId })
    if (!row) return p
  }
  throw new Error('pickParticipantAwaitingRound: every participant already posted this round')
}

async function bindingKeyFor (db: Database, electionId: string, revision: number, userId: string): Promise<string> {
  const row = await db
    .prepare('select DkgPublicKey from KeyholderDkgBinding where ElectionId = :electionId and ElectionRevision = :revision and UserId = :userId')
    .get({ electionId, revision, userId })
  if (!row) throw new Error(`bindingKeyFor: no binding for ${userId}`)
  return row.DkgPublicKey as string
}

/** Builds and posts a dealer's round-2 bundle WITHOUT using the dealer's own engine, perturbing the share to `badRecipient` by +1 (Fn arithmetic) so the real dealer secret (still vaulted at step 1, since the dealer's engine never ran round 2) produces a provably-bad share. */
async function injectBadDealerRound2 (
  db: Database, electionId: string, revision: number, attempt: number,
  dealer: DkgTestParticipant, badRecipient: DkgTestParticipant, roster: DkgTestParticipant[]
): Promise<void> {
  const dRecord = await readRoundRecord(dealer, electionId, revision, attempt, 1)
  if (!dRecord) throw new Error('injectBadDealerRound2: dealer has no step-1 round record')
  const secret = parseDkgSecret(dRecord.dkgSecret)
  const othersR1: DkgRound1Wire[] = []
  for (const p of roster) {
    if (p.userId === dealer.userId) continue
    const row = await db
      .prepare('select Payload from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = :attempt and DkgRound = 1 and SenderUserId = :senderUserId')
      .get({ electionId, revision, attempt, senderUserId: p.userId })
    if (!row) throw new Error(`injectBadDealerRound2: no round-1 row for ${p.name}`)
    const pkg = parseRound1Payload(row.Payload as string)
    if (!pkg) throw new Error(`injectBadDealerRound2: round-1 payload for ${p.name} did not parse`)
    othersR1.push(pkg)
  }
  const shares = dkgRound2(secret, othersR1)
  const Fn = secp256k1_FROST.utils.Fn
  const badRecipientIdentifier = dkgIdentifierForUser(badRecipient.userId)
  const entries: EncryptedShare[] = []
  for (const p of roster) {
    if (p.userId === dealer.userId) continue
    const theirIdentifier = dkgIdentifierForUser(p.userId)
    let shareBytes = shares[theirIdentifier]
    if (shareBytes === undefined) throw new Error(`injectBadDealerRound2: no share computed for ${p.name}`)
    if (theirIdentifier === badRecipientIdentifier) {
      shareBytes = Fn.toBytes(Fn.add(Fn.fromBytes(shareBytes), 1n))
    }
    const theirBindingKey = await bindingKeyFor(db, electionId, revision, p.userId)
    entries.push(encryptShare({ electionId, revision, attempt }, dkgIdentifierForUser(dealer.userId), theirIdentifier, theirBindingKey, shareBytes))
  }
  const payload = serializeRound2Payload(entries)
  await postSignedDkgMessage(db, dealer, { electionId, revision, attempt, dkgRound: 2, payload, resultKey: null })
}

/** Drives `dealer` to post round 0 (+ a likely round-1 cascade) FIRST among the roster, then the rest, so `dealer`'s own engine never reaches round 2 — the caller injects the dealer's round-2 bundle manually afterward. */
async function driveRound0And1WithDealerFirst (db: Database, electionId: string, revision: number, attempt: number, dealer: DkgTestParticipant, rest: DkgTestParticipant[]): Promise<void> {
  for (const p of rest) await p.engine.advanceDkg(electionId, p.signer)
  await dealer.engine.advanceDkg(electionId, dealer.signer)
  await runDkgToQuiescence(rest, electionId, {
    stopWhen: async () => (await countRows(db, electionId, revision, attempt, 1)) === rest.length + 1
  })
}

/**
 * V-1 regression (62-34): after a RETRIED DKG every honest participant must
 * still hold its share, and once the releasingKeys window opens (D-20) each
 * can release it and the release status reaches 'reconstructable'.
 */
async function expectHonestSharesSurviveAndRelease (
  db: Database, electionId: string, revision: number, honest: DkgTestParticipant[]
): Promise<void> {
  for (const p of honest) {
    expect(await p.vault.hasSecret(keyholderDkgShareAlias(electionId, revision, p.userId)), `${p.name} share survives the retry`).to.equal(true)
  }
  const tlRow = await db.prepare('select Timeline from ElectionRevision where ElectionId = :electionId').get({ electionId })
  const at = releasingKeysAt(JSON.parse(tlRow!.Timeline as string) as Record<string, number>)
  expect(at, 'fixture has a releasingKeys timeline entry').to.not.equal(null)
  for (const p of honest.slice(0, 3)) {
    const engine = new KeyReleaseEngine({ db }, { vault: p.vault, now: () => at! + 1 })
    const outcome = await engine.releaseKeyShare(electionId, p.signer)
    expect(outcome.outcome, `${p.name} release`).to.not.equal('already-released')
  }
  const status = await new KeyReleaseEngine({ db }, { now: () => at! + 1 }).getKeyReleaseStatus(electionId)
  expect(status.phase).to.equal('reconstructable')
}

describe('dkg.spec: KeyholderDkgEngine over one shared DB', function () {
  this.timeout(180000)

  // ===========================================================================
  // A. Happy path: 3-of-5
  // ===========================================================================

  describe('A: 3-of-5 happy path (D-13, D-14, D-16, D-19, D-26)', function () {
    this.timeout(180000)

    it('A: every status complete, one ElectionKey (Attempt 1, Threshold 3, Participants 5), vaulted shares reconstruct to Y, round-secret aliases all swept', async () => {
      const { auth, electionId, revision, participants } = await seedDkgElection({
        keyholders: ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'], threshold: 3
      })
      await runDkgToQuiescence(participants, electionId)

      for (const p of participants) {
        const status = await p.engine.getDkgStatus(electionId, p.userId)
        expect(status.phase, `${p.name} status`).to.equal('complete')
      }

      const ekCountRow = await auth.ctx.db.prepare('select count(*) as c from ElectionKey where ElectionId = :electionId').get({ electionId })
      expect(ekCountRow?.c).to.equal(1)
      const ek = await participants[0]!.engine.getElectionKey(electionId)
      expect(ek).to.not.equal(null)
      expect(ek!.attempt).to.equal(1)
      expect(ek!.threshold).to.equal(3)
      expect(ek!.participants).to.equal(5)

      for (let round = 0; round <= 4; round++) {
        expect(await countRows(auth.ctx.db, electionId, revision, 1, round), `round ${round} count`).to.equal(5)
      }
      expect(await countRows(auth.ctx.db, electionId, revision, 2, 0)).to.equal(0)
      expect(await countRows(auth.ctx.db, electionId, revision, 3, 0)).to.equal(0)

      const releasedShares: ReleasedShare[] = []
      for (const p of participants) {
        const alias = keyholderDkgShareAlias(electionId, revision, p.userId)
        const shareBytes = await p.vault.getSecret(alias)
        expect(shareBytes, `${p.name} share`).to.not.equal(null)
        const identifier = dkgIdentifierForUser(p.userId)
        const signingShare = bytesToHex(shareBytes!)
        expect(validateReleasedShare(3, 5, ek!.groupCommitments, { identifier, signingShare })).to.equal(true)
        releasedShares.push({ identifier, signingShare })
      }

      const subsets = [[0, 1, 2], [0, 1, 3], [0, 1, 4], [0, 2, 3], [1, 2, 4], [2, 3, 4]]
      for (const subset of subsets) {
        const shares = subset.map((i) => releasedShares[i]!)
        const result = reconstructGroupSecret({ threshold: 3, participants: 5, groupPublicKey: ek!.jointPublicKey, groupCommitments: ek!.groupCommitments, shares })
        expect(bytesToHex(secp256k1.getPublicKey(result.secretKey, true))).to.equal(ek!.jointPublicKey)
      }

      for (const p of participants) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          expect(await readRoundRecord(p, electionId, revision, attempt, 1), `${p.name} attempt ${attempt} step 1`).to.equal(null)
          expect(await readRoundRecord(p, electionId, revision, attempt, 2), `${p.name} attempt ${attempt} step 2`).to.equal(null)
        }
      }

      const verdict = await participants[0]!.engine.verifyDkgTranscript(electionId)
      expect(verdict.invalidRows).to.deep.equal([])
      expect(verdict.electionKeyConsistent).to.equal(true)
      expect(verdict.rowCount).to.equal(25)
    })
  })

  // ===========================================================================
  // B. Bad dealer
  // ===========================================================================

  describe('B: bad dealer (D-19, D-14)', function () {
    this.timeout(180000)

    it('B: D disqualified with invalid-share/complainantUserId X; removed-disqualified fires first; attempt 2 completes with Participants 4; D locked out', async () => {
      const { auth, electionId, revision, participants } = await seedDkgElection({
        keyholders: ['Dealer', 'Xena', 'Carol', 'Dave', 'Eve'], threshold: 3
      })
      const [D, X] = participants
      const rest = participants.slice(1)
      const db = auth.ctx.db

      await driveRound0And1WithDealerFirst(db, electionId, revision, 1, D!, rest)
      await runDkgToQuiescence(rest, electionId, {
        stopWhen: async () => (await countRows(db, electionId, revision, 1, 2)) === rest.length
      })
      await injectBadDealerRound2(db, electionId, revision, 1, D!, X!, participants)
      // D's own engine still owes an honest round-3 ack (D does not know its
      // own dealt share was bad) — without it the round-3 boundary can never
      // be reached. D is excluded from every round AFTER this.
      await D!.engine.advanceDkg(electionId, D!.signer)

      await runDkgToQuiescence(participants, electionId, { skip: [D!.userId] })

      const status = await participants[1]!.engine.getDkgStatus(electionId)
      const disq = status.disqualified.find((x) => x.userId === D!.userId)
      expect(disq?.reason).to.equal('invalid-share')
      expect(disq?.complainantUserId).to.equal(X!.userId)
      const attempt1Summary = status.attempts.find((a) => a.attempt === 1)
      expect(attempt1Summary?.outcome).to.equal('aborted')
      expect(attempt1Summary?.disqualified[0]?.reason).to.equal('invalid-share')

      const khRow = await db.prepare('select count(*) as c from Keyholder where ElectionId = :electionId and ElectionRevision = :revision and UserId = :userId').get({ electionId, revision, userId: D!.userId })
      expect(khRow?.c).to.equal(0)

      const ek = await participants[1]!.engine.getElectionKey(electionId)
      expect(ek!.attempt).to.equal(2)
      expect(ek!.participants).to.equal(4)
      expect(ek!.threshold).to.equal(3)

      const dStatus = await D!.engine.getDkgStatus(electionId, D!.userId)
      expect(dStatus.self?.isDisqualified).to.equal(true)
      expect(dStatus.self?.isParticipant).to.equal(false)

      const dAdvance = await D!.engine.advanceDkg(electionId, D!.signer)
      expect(dAdvance.actions).to.deep.equal([])

      expect(await D!.vault.hasSecret(keyholderDkgShareAlias(electionId, revision, D!.userId))).to.equal(false)
      expect(await readRoundRecord(D!, electionId, revision, 2, 1)).to.equal(null)
      expect(await readRoundRecord(D!, electionId, revision, 2, 2)).to.equal(null)

      // V-1 (62-34): every honest participant keeps its share across the retry and can release it.
      await expectHonestSharesSurviveAndRelease(db, electionId, revision, rest)
    })
  })

  // ===========================================================================
  // C. Re-added disqualified keyholder
  // ===========================================================================

  describe('C: re-added disqualified keyholder (D-14, the 62-02 constraint)', function () {
    this.timeout(180000)

    it('C: a raw-handle re-add of D is re-removed before any other honest action, and the final ElectionKey still has Participants 4', async () => {
      const { auth, electionId, revision, participants } = await seedDkgElection({
        keyholders: ['Dealer', 'Xena', 'Carol', 'Dave', 'Eve'], threshold: 3
      })
      const [D, X, Carol] = participants
      const rest = participants.slice(1)
      const db = auth.ctx.db

      await driveRound0And1WithDealerFirst(db, electionId, revision, 1, D!, rest)
      await runDkgToQuiescence(rest, electionId, {
        stopWhen: async () => (await countRows(db, electionId, revision, 1, 2)) === rest.length
      })
      await injectBadDealerRound2(db, electionId, revision, 1, D!, X!, participants)
      // D's own engine still owes an honest round-3 ack.
      await D!.engine.advanceDkg(electionId, D!.signer)

      // Let the bad-dealer flow run its natural course (X's complaint, the
      // abort, D's first removal) and pause once attempt 2's round 0
      // boundary is reached -- comfortably mid-attempt-2, so the DKG is
      // still in-progress (not complete) when D sneaks back in below.
      await runDkgToQuiescence(participants, electionId, {
        skip: [D!.userId],
        stopWhen: async () => (await countRows(db, electionId, revision, 2, 0)) === 4
      })

      const tid = await allocateTid(db, 'election')
      await db.exec(
        `insert into Keyholder (ElectionId, ElectionRevision, UserId)
           with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
           values (:electionId, :revision, :userId)`,
        { electionId, revision, userId: D!.userId }
      )

      const nextResult = await Carol!.engine.advanceDkg(electionId, Carol!.signer)
      expect(nextResult.actions[0]).to.equal('removed-disqualified')

      await runDkgToQuiescence(participants, electionId, { skip: [D!.userId] })

      const ek = await participants[1]!.engine.getElectionKey(electionId)
      expect(ek!.participants).to.equal(4)
    })
  })

  // ===========================================================================
  // D. False complaint
  // ===========================================================================

  describe('D: false complaint', function () {
    this.timeout(180000)

    it('D: X is disqualified with false-complaint against an honest dealer; attempt 2 completes without X', async () => {
      const { auth, electionId, revision, participants } = await seedDkgElection({
        keyholders: ['Dealer', 'Xena', 'Carol', 'Dave', 'Eve'], threshold: 3
      })
      const [D, X] = participants
      const db = auth.ctx.db

      await runDkgToQuiescence(participants, electionId, {
        stopWhen: async () => (await countRows(db, electionId, revision, 1, 2)) === participants.length
      })

      const row = await db
        .prepare('select Payload from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = 1 and DkgRound = 2 and SenderUserId = :senderUserId')
        .get({ electionId, revision, senderUserId: D!.userId })
      const entries = parseRound2Payload(row!.Payload as string)!
      const enc = entries.find((e) => e.recipient === dkgIdentifierForUser(X!.userId))!
      const evidence = [buildComplaintEvidence(enc, X!.receivingPrivateKey)]
      await postSignedDkgMessage(db, X!, { electionId, revision, attempt: 1, dkgRound: 3, payload: serializeRound3Payload({ v: 1, kind: 'complaint', evidence }), resultKey: null })

      await runDkgToQuiescence(participants, electionId, { skip: [X!.userId] })

      const status = await participants[0]!.engine.getDkgStatus(electionId)
      const disq = status.disqualified.find((d) => d.userId === X!.userId)
      expect(disq?.reason).to.equal('false-complaint')

      const ek = await participants[0]!.engine.getElectionKey(electionId)
      expect(ek!.attempt).to.equal(2)
      expect(ek!.participants).to.equal(4)

      // V-1 (62-34): every honest participant (all but the falsely complaining X) keeps its share and can release it.
      await expectHonestSharesSurviveAndRelease(db, electionId, revision, participants.filter((p) => p.userId !== X!.userId))
    })
  })

  // ===========================================================================
  // E. Unresolved cap
  // ===========================================================================

  describe('E: unresolved cap (attempts-exhausted)', function () {
    this.timeout(180000)

    it('E: an unresolved complaint in each of attempts 1-3 gives failed/attempts-exhausted, no ElectionKey, no Attempt>3 row, and a further advanceDkg writes no row', async () => {
      const { auth, electionId, revision, participants } = await seedDkgElection({
        keyholders: ['Dealer', 'Xena', 'Carol'], threshold: 2
      })
      const [D, X] = participants
      const db = auth.ctx.db

      for (let attempt = 1; attempt <= 3; attempt++) {
        await runDkgToQuiescence(participants, electionId, {
          stopWhen: async () => (await countRows(db, electionId, revision, attempt, 2)) === participants.length
        })
        const evidence = [{
          dealer: dkgIdentifierForUser(D!.userId),
          recipient: dkgIdentifierForUser(X!.userId),
          sharedSecret: bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))
        }]
        await postSignedDkgMessage(db, X!, { electionId, revision, attempt, dkgRound: 3, payload: serializeRound3Payload({ v: 1, kind: 'complaint', evidence }), resultKey: null })
        await runDkgToQuiescence(participants, electionId, {
          stopWhen: async () => (await countRows(db, electionId, revision, attempt, 3)) === participants.length
        })
      }
      await runDkgToQuiescence(participants, electionId)

      const status = await participants[0]!.engine.getDkgStatus(electionId)
      expect(status.phase).to.equal('failed')
      expect(status.failedReason).to.equal('attempts-exhausted')

      const ekCountRow = await db.prepare('select count(*) as c from ElectionKey where ElectionId = :electionId').get({ electionId })
      expect(ekCountRow?.c).to.equal(0)
      const beyond = await db.prepare('select count(*) as c from KeyholderDkgMessage where ElectionId = :electionId and Attempt > 3').get({ electionId })
      expect(beyond?.c).to.equal(0)

      const further = await participants[0]!.engine.advanceDkg(electionId, participants[0]!.signer)
      expect(further.actions).to.deep.equal([])

      for (const p of participants) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          for (const step of [1, 2] as const) {
            expect(await readRoundRecord(p, electionId, revision, attempt, step), `${p.name} attempt ${attempt} step ${step}`).to.equal(null)
          }
        }
      }
    })
  })

  // ===========================================================================
  // F. Threshold unreachable
  // ===========================================================================

  describe('F: threshold unreachable', function () {
    this.timeout(180000)

    it('F: 3-of-3 with a bad dealer gives failed/threshold-unreachable after D\'s removal, and no Attempt-2 row is written', async () => {
      const { auth, electionId, revision, participants } = await seedDkgElection({
        keyholders: ['Dealer', 'Xena', 'Carol'], threshold: 3
      })
      const [D, X] = participants
      const rest = participants.slice(1)
      const db = auth.ctx.db

      await driveRound0And1WithDealerFirst(db, electionId, revision, 1, D!, rest)
      await runDkgToQuiescence(rest, electionId, {
        stopWhen: async () => (await countRows(db, electionId, revision, 1, 2)) === rest.length
      })
      await injectBadDealerRound2(db, electionId, revision, 1, D!, X!, participants)
      // D's own engine still owes an honest round-3 ack.
      await D!.engine.advanceDkg(electionId, D!.signer)

      await runDkgToQuiescence(participants, electionId, { skip: [D!.userId] })

      const status = await participants[1]!.engine.getDkgStatus(electionId)
      expect(status.phase).to.equal('failed')
      expect(status.failedReason).to.equal('threshold-unreachable')

      const attempt2Count = await countRows(db, electionId, revision, 2, 0)
      expect(attempt2Count).to.equal(0)
    })
  })

  // ===========================================================================
  // G. Gates
  // ===========================================================================

  describe('G: gates', function () {
    this.timeout(180000)

    it('G: KeyholderThreshold 1 with 3 keyholders gives blocked/threshold-out-of-range, and advanceDkg writes no row', async () => {
      const { auth, electionId, revision, participants } = await seedDkgElection({ keyholders: ['A', 'B', 'C'], threshold: 1 })
      const status = await participants[0]!.engine.getDkgStatus(electionId)
      expect(status.phase).to.equal('blocked')
      expect(status.blockedReason).to.equal('threshold-out-of-range')

      const result = await participants[0]!.engine.advanceDkg(electionId, participants[0]!.signer)
      expect(result.actions).to.deep.equal([])
      expect(await countRows(auth.ctx.db, electionId, revision, 1, 0)).to.equal(0)
    })

    it('G: one unanswered unexpired keyholder invite gives blocked/pending-invites; accepting it unblocks the DKG, which then completes with that keyholder in the roster', async () => {
      const { auth, electionEngine, electionId, participants } = await seedDkgElection({ keyholders: ['A', 'B'], threshold: 2, pendingInvites: ['Cee'] })
      const blockedStatus = await participants[0]!.engine.getDkgStatus(electionId)
      expect(blockedStatus.phase).to.equal('blocked')
      expect(blockedStatus.blockedReason).to.equal('pending-invites')

      const cee = await inviteAndAcceptKeyholder(auth, electionEngine, electionId, 'Cee')
      const all = [...participants, cee]
      await runDkgToQuiescence(all, electionId)

      const finalStatus = await cee.engine.getDkgStatus(electionId)
      expect(finalStatus.phase).to.equal('complete')
      const ek = await cee.engine.getElectionKey(electionId)
      expect(ek!.participants).to.equal(3)
    })
  })

  // ===========================================================================
  // H. Officer revoke mid-attempt
  // ===========================================================================

  describe('H: officer revoke mid-attempt', function () {
    this.timeout(180000)

    it('H: a revoke after every R1 exists aborts attempt 1 with roster-changed; attempt 2 completes with Participants n-1', async () => {
      const { auth, electionEngine, electionId, revision, participants } = await seedDkgElection({
        keyholders: ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'], threshold: 3
      })
      const db = auth.ctx.db
      const revoked = participants[4]!

      await runDkgToQuiescence(participants, electionId, {
        stopWhen: async () => (await countRows(db, electionId, revision, 1, 1)) === participants.length
      })

      await electionEngine.revokeKeyholder({ name: revoked.name, type: 'k', expiration: '0', inviteKey: '', inviteSignature: '' }, electionId)

      await runDkgToQuiescence(participants, electionId, { skip: [revoked.userId] })

      const status = await participants[0]!.engine.getDkgStatus(electionId)
      const attempt1 = status.attempts.find((a) => a.attempt === 1)
      expect(attempt1?.outcome).to.equal('aborted')
      expect(attempt1?.abortReason).to.equal('roster-changed')

      const ek = await participants[0]!.engine.getElectionKey(electionId)
      expect(ek!.attempt).to.equal(2)
      expect(ek!.participants).to.equal(4)
    })
  })

  // ===========================================================================
  // I. Revision pin
  // ===========================================================================

  describe('I: revision pin', function () {
    this.timeout(180000)

    it('I: a revision bump after round 1 reports the new revision as blocked/no-keyholders; a further advanceDkg by an old participant writes no row, and old-revision rows are untouched', async () => {
      const { auth, electionsEngine, electionEngine, electionId, revision, participants } = await seedDkgElection({
        keyholders: ['Alice', 'Bob', 'Carol'], threshold: 2
      })
      const db = auth.ctx.db

      await runDkgToQuiescence(participants, electionId, {
        stopWhen: async () => (await countRows(db, electionId, revision, 1, 1)) === participants.length
      })
      const oldRound1Count = await countRows(db, electionId, revision, 1, 1)

      await bumpElectionRevision({ ...auth, electionsEngine, electionEngine })

      const status = await participants[0]!.engine.getDkgStatus(electionId)
      expect(status.revision).to.equal(revision + 1)
      expect(status.phase).to.equal('blocked')
      expect(status.blockedReason).to.equal('no-keyholders')

      const result = await participants[0]!.engine.advanceDkg(electionId, participants[0]!.signer)
      expect(result.actions).to.deep.equal([])

      expect(await countRows(db, electionId, revision, 1, 1)).to.equal(oldRound1Count)
    })
  })

  // ===========================================================================
  // J. Signer checks
  // ===========================================================================

  describe('J: signer checks', function () {
    this.timeout(180000)

    it('J: a signer whose userId is not a live keyholder gets actions: [] and self.isParticipant false', async () => {
      const { auth, electionId, participants } = await seedDkgElection({ keyholders: ['Alice', 'Bob'], threshold: 2 })
      const outsider: KeyholderDkgSigner = {
        userId: auth.user.id,
        signingPublicKey: auth.user.activeKeys[0]!.key,
        sign: participants[0]!.signer.sign // irrelevant — the outsider never reaches a post
      }
      const engine = new KeyholderDkgEngine(auth.ctx, { vault: new InMemoryTestKeyVault() })
      const result = await engine.advanceDkg(electionId, outsider)
      expect(result.actions).to.deep.equal([])
      const status = await engine.getDkgStatus(electionId, outsider.userId)
      expect(status.self?.isParticipant).to.equal(false)
    })

    it('J: a signingPublicKey that is not a UserKey of userId throws signer-key-mismatch and writes nothing', async () => {
      const { auth, electionId, revision, participants } = await seedDkgElection({ keyholders: ['Alice', 'Bob'], threshold: 2 })
      const p = participants[0]!
      const badSigner: KeyholderDkgSigner = { userId: p.userId, signingPublicKey: 'ff'.repeat(33), sign: p.signer.sign }
      let caught: unknown
      try {
        await p.engine.advanceDkg(electionId, badSigner)
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(KeyholderDkgError)
      expect((caught as KeyholderDkgError).code).to.equal('signer-key-mismatch')
      expect(await countRows(auth.ctx.db, electionId, revision, 1, 0)).to.equal(0)
    })

    it('J: a sign callback returning another key throws signature-mismatch and writes nothing', async () => {
      const { auth, electionId, revision, participants } = await seedDkgElection({ keyholders: ['Alice', 'Bob'], threshold: 2 })
      const p = participants[0]!
      const badSign = async (digest: Uint8Array) => {
        const real = await p.signer.sign(digest)
        return { ...real, signerKey: 'ff'.repeat(33) }
      }
      const badSigner: KeyholderDkgSigner = { userId: p.userId, signingPublicKey: p.signer.signingPublicKey, sign: badSign }
      let caught: unknown
      try {
        await p.engine.advanceDkg(electionId, badSigner)
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(KeyholderDkgError)
      expect((caught as KeyholderDkgError).code).to.equal('signature-mismatch')
      expect(await countRows(auth.ctx.db, electionId, revision, 1, 0)).to.equal(0)
    })
  })

  // ===========================================================================
  // K. Idempotency
  // ===========================================================================

  describe('K: idempotency', function () {
    this.timeout(180000)

    it('K: two concurrent advanceDkg calls post exactly one R0 row; a repeated call with no new rows leaves counts unchanged', async () => {
      const { auth, electionId, revision, participants } = await seedDkgElection({ keyholders: ['Alice', 'Bob'], threshold: 2 })
      const p = participants[0]!
      await Promise.all([
        p.engine.advanceDkg(electionId, p.signer),
        p.engine.advanceDkg(electionId, p.signer)
      ])
      expect(await countRows(auth.ctx.db, electionId, revision, 1, 0)).to.equal(1)

      const again = await p.engine.advanceDkg(electionId, p.signer)
      expect(again.actions).to.deep.equal([])
      expect(await countRows(auth.ctx.db, electionId, revision, 1, 0)).to.equal(1)
    })
  })

  // ===========================================================================
  // L. Missing receiving key
  // ===========================================================================

  describe('L: missing receiving key', function () {
    this.timeout(180000)

    it('L: round 3 with the receiving key deleted throws receiving-key-missing; the message has no 64-hex run; no R3 row is posted', async () => {
      const { auth, electionId, revision, participants } = await seedDkgElection({
        keyholders: ['Alice', 'Bob', 'Carol'], threshold: 2
      })
      const db = auth.ctx.db
      await runDkgToQuiescence(participants, electionId, {
        stopWhen: async () => (await countRows(db, electionId, revision, 1, 2)) === participants.length
      })
      const p = await pickParticipantAwaitingRound(db, electionId, revision, 1, 3, participants)
      await p.vault.deleteSecret(keyholderDkgReceivingKeyAlias(p.userId))

      let caught: unknown
      try {
        await p.engine.advanceDkg(electionId, p.signer)
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(KeyholderDkgError)
      expect((caught as KeyholderDkgError).code).to.equal('receiving-key-missing')
      expect((caught as Error).message).to.not.match(/[0-9a-f]{64}/)

      expect(await countRows(db, electionId, revision, 1, 3)).to.satisfy((n: number) => n < participants.length)
      const row = await db.prepare('select 1 as x from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = 1 and DkgRound = 3 and SenderUserId = :senderUserId').get({ electionId, revision, senderUserId: p.userId })
      expect(row).to.equal(undefined)
    })
  })

  // ===========================================================================
  // M. Vault auth denied
  // ===========================================================================

  describe('M: vault auth denied', function () {
    this.timeout(180000)

    it('M: an InMemoryTestKeyVault that always denies rejects with KeyVaultError auth-denied at the round-3 receiving-key read, and posts no round-3 row for that user', async () => {
      const { auth, electionId, revision, participants } = await seedDkgElection({ keyholders: ['Alice', 'Bob', 'Carol'], threshold: 2 })
      const db = auth.ctx.db
      await runDkgToQuiescence(participants, electionId, {
        stopWhen: async () => (await countRows(db, electionId, revision, 1, 2)) === participants.length
      })
      const p = await pickParticipantAwaitingRound(db, electionId, revision, 1, 3, participants)

      // A fresh, always-denying vault for p, preloaded with the SAME
      // receiving key p's real vault holds — the alias EXISTS, so the
      // round-3 `getSecret` is this vault's first call and is denied.
      const denyVault = new InMemoryTestKeyVault({ authorize: () => false })
      await denyVault.putSecret(keyholderDkgReceivingKeyAlias(p.userId), p.receivingPrivateKey, KEYHOLDER_DKG_RECEIVING_KEY_POLICY)
      const denyEngine = new KeyholderDkgEngine(auth.ctx, { vault: denyVault })

      let caught: unknown
      try {
        await denyEngine.advanceDkg(electionId, p.signer)
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(KeyVaultError)
      expect((caught as KeyVaultError).code).to.equal('auth-denied')
      expect(denyVault.authPromptCount).to.equal(1)

      const row = await db.prepare('select 1 as x from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = 1 and DkgRound = 3 and SenderUserId = :senderUserId').get({ electionId, revision, senderUserId: p.userId })
      expect(row).to.equal(undefined)
    })
  })
})
