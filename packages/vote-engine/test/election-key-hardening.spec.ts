/**
 * election-key-hardening.spec.ts (62-34, V-2)
 *
 * A live keyholder can publish the write-once ElectionKey row with the right
 * joint key Y but junk (or non-JSON) GroupCommitments. These real-engine
 * regressions pin that:
 *   - the DKG status reports such a row as failed/'election-key-mismatch'
 *     (E1-E3) and no DKG reader throws on a malformed column, and
 *   - key release validates every share against commitments DERIVED FROM THE
 *     TRANSCRIPT, so the election key stays recoverable (R1-R3).
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { dkgIdentifierForUser } from '../src/crypto/dkg.js'
import { releasingKeysAt } from '../src/key-release/release-window.js'
import { KeyReleaseEngine } from '../src/key-release/key-release-engine.js'
import { KeysTasksEngine } from '../src/tasks/keys-tasks-engine.js'
import { keyholderDkgShareAlias } from '../src/crypto/vault.js'
import { parseRound4Payload, serializeRound4Payload } from '../src/keyholder/dkg-payloads.js'
import { digestToBytes } from '../src/utils.js'
import { postSignedDkgMessage, runDkgToQuiescence, seedDkgElection, type DkgTestParticipant } from './fixtures/dkg-keyholders.js'

async function countRound4 (db: Database, electionId: string, revision: number, attempt: number): Promise<number> {
  const row = await db
    .prepare('select count(*) as c from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = :attempt and DkgRound = 4')
    .get({ electionId, revision, attempt })
  return (row?.c as number | undefined) ?? 0
}

interface ForgedSetup {
  auth: Awaited<ReturnType<typeof seedDkgElection>>['auth']
  electionId: string
  revision: number
  participants: DkgTestParticipant[]
  /** Participants whose own engine posted round 4 (their vault holds the share). */
  holders: DkgTestParticipant[]
  /** The one participant whose round-4 row was injected so the schema's all-keyholders-agree check lets a forged key in before any honest publish. */
  late: DkgTestParticipant
  /** The honest round-4 result the forged row is built from. */
  y: string
  commitments: string[]
}

/**
 * Drives a 3-of-5 DKG until four of the five round-4 rows exist, then posts the fifth participant's round-4 row
 * directly (the ElectionKey table's AllKeyholdersAgree CHECK needs all five). No honest engine has run since, so no
 * honest publish can have happened: the caller's forged row is the write-once key.
 */
async function driveToRound4Minus1 (): Promise<ForgedSetup> {
  const { auth, electionId, revision, participants } = await seedDkgElection({
    keyholders: ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'], threshold: 3
  })
  const db = auth.ctx.db
  await runDkgToQuiescence(participants, electionId, {
    stopWhen: async () => (await countRound4(db, electionId, revision, 1)) === 4
  })
  const r4 = await db
    .prepare('select Payload from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = 1 and DkgRound = 4')
    .get({ electionId, revision })
  const parsed = parseRound4Payload(r4!.Payload as string)!
  let late: DkgTestParticipant | undefined
  for (const p of participants) {
    const row = await db
      .prepare('select 1 as x from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = 1 and DkgRound = 4 and SenderUserId = :u')
      .get({ electionId, revision, u: p.userId })
    if (!row) late = p
  }
  if (late === undefined) throw new Error('driveToRound4Minus1: every participant already posted round 4')
  await postSignedDkgMessage(db, late, {
    electionId, revision, attempt: 1, dkgRound: 4,
    payload: serializeRound4Payload({ groupPublicKey: parsed.groupPublicKey, groupCommitments: parsed.groupCommitments }), resultKey: parsed.groupPublicKey
  })
  const holders = participants.filter((p) => p.userId !== late!.userId)
  return { auth, electionId, revision, participants, holders, late, y: parsed.groupPublicKey, commitments: parsed.groupCommitments }
}

/** Raw-handle publish of a correctly SIGNED ElectionKey (copies the engine's Digest/sign/insert shape). */
async function publishForgedElectionKey (
  setup: ForgedSetup, publisher: DkgTestParticipant, over: { groupCommitments: string, participants?: number }
): Promise<void> {
  const { auth, electionId, revision } = setup
  const db = auth.ctx.db
  const publishedAt = new Date().toISOString()
  const participantsCount = over.participants ?? 5
  const digestRow = await db
    .prepare("select Digest('ElectionKey', :electionId, :revision, :attempt, :jointPublicKey, :groupCommitments, :threshold, :participants, :publishedAt, :publisherUserId) as d")
    .get({
      electionId, revision, attempt: 1, jointPublicKey: setup.y, groupCommitments: over.groupCommitments,
      threshold: 3, participants: participantsCount, publishedAt, publisherUserId: publisher.userId
    })
  const signature = await publisher.signer.sign(digestToBytes(digestRow!.d as string))
  await db.exec(
    `insert into ElectionKey (ElectionId, ElectionRevision, Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId, PublisherKey, Signature)
     values (:electionId, :revision, :attempt, :jointPublicKey, :groupCommitments, :threshold, :participants, :publishedAt, :publisherUserId, :publisherKey, :signature)`,
    {
      electionId, revision, attempt: 1, jointPublicKey: setup.y, groupCommitments: over.groupCommitments, threshold: 3,
      participants: participantsCount, publishedAt, publisherUserId: publisher.userId, publisherKey: signature.signerKey, signature: signature.signature
    }
  )
}

function junkCommitments (commitments: string[]): string {
  const other = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))
  const forged = [...commitments]
  forged[1] = other
  return JSON.stringify(forged)
}

async function releaseAt (db: Database, electionId: string): Promise<number> {
  const row = await db.prepare('select Timeline from ElectionRevision where ElectionId = :electionId').get({ electionId })
  const at = releasingKeysAt(JSON.parse(row!.Timeline as string) as Record<string, number>)
  if (at === null) throw new Error('releaseAt: fixture has no releasingKeys entry')
  return at
}

describe('election-key-hardening: V-2 (62-34)', function () {
  this.timeout(240000)

  describe('E: DKG status binds the ElectionKey to the round-4 result', function () {
    it('E1: an ElectionKey with right Y but junk GroupCommitments reads failed/election-key-mismatch, never complete', async () => {
      const setup = await driveToRound4Minus1()
      await publishForgedElectionKey(setup, setup.holders[0]!, { groupCommitments: junkCommitments(setup.commitments) })
      await runDkgToQuiescence(setup.holders, setup.electionId)

      const status = await setup.holders[1]!.engine.getDkgStatus(setup.electionId)
      expect(status.phase).to.equal('failed')
      expect(status.failedReason).to.equal('election-key-mismatch')
      const verdict = await setup.holders[1]!.engine.verifyDkgTranscript(setup.electionId)
      expect(verdict.electionKeyConsistent).to.equal(false)
    })

    it('E2: a non-JSON GroupCommitments makes no DKG reader throw; status is failed/election-key-mismatch and getElectionKey reports []', async () => {
      const setup = await driveToRound4Minus1()
      let refused: unknown = null
      try {
        await publishForgedElectionKey(setup, setup.holders[0]!, { groupCommitments: 'not-json' })
      } catch (err) {
        refused = err
      }
      if (refused !== null) {
        // The schema refused the text: the refusal itself is the proof; fall back to a JSON array of non-points.
        await publishForgedElectionKey(setup, setup.holders[0]!, { groupCommitments: JSON.stringify(['not-a-point', 'neither']) })
      }
      await runDkgToQuiescence(setup.holders, setup.electionId)

      const honest = setup.holders[1]!
      const status = await honest.engine.getDkgStatus(setup.electionId)
      expect(status.phase).to.equal('failed')
      expect(status.failedReason).to.equal('election-key-mismatch')
      const advance = await honest.engine.advanceDkg(setup.electionId, honest.signer)
      expect(advance.actions).to.be.an('array')
      const ek = await honest.engine.getElectionKey(setup.electionId)
      expect(ek).to.not.equal(null)
      expect(ek!.groupCommitments).to.deep.equal([])
      const verdict = await honest.engine.verifyDkgTranscript(setup.electionId)
      expect(verdict.electionKeyConsistent).to.equal(false)
    })

    it('E3: an ElectionKey whose Participants differs from the agreed roster reads failed/election-key-mismatch (measured: the schema refuses it, ParticipantsAreKeyholders)', async () => {
      const setup = await driveToRound4Minus1()
      let refused: unknown = null
      try {
        await publishForgedElectionKey(setup, setup.holders[0]!, { groupCommitments: JSON.stringify(setup.commitments), participants: 4 })
      } catch (err) {
        refused = err
      }
      await runDkgToQuiescence(setup.holders, setup.electionId)
      const status = await setup.holders[1]!.engine.getDkgStatus(setup.electionId)
      if (refused !== null) {
        // Schema refusal is the proof: the honest publish then completes the DKG.
        expect((refused as Error).message).to.match(/ParticipantsAreKeyholders/)
        expect(status.phase).to.equal('complete')
      } else {
        expect(status.phase).to.equal('failed')
        expect(status.failedReason).to.equal('election-key-mismatch')
      }
    })
  })

  describe('R: key release validates against transcript-derived commitments', function () {
    async function releaseThree (setup: ForgedSetup): Promise<{ at: number }> {
      const db = setup.auth.ctx.db
      const at = await releaseAt(db, setup.electionId)
      for (const p of setup.holders.slice(0, 3)) {
        const engine = new KeyReleaseEngine({ db }, { vault: p.vault, now: () => at + 1 })
        const outcome = await engine.releaseKeyShare(setup.electionId, p.signer)
        expect(outcome.outcome, `${p.name} release`).to.not.equal('already-released')
      }
      return { at }
    }

    it('R1: with junk commitments published, release succeeds for three honest keyholders and the key reconstructs to Y', async () => {
      const setup = await driveToRound4Minus1()
      await publishForgedElectionKey(setup, setup.holders[0]!, { groupCommitments: junkCommitments(setup.commitments) })
      await runDkgToQuiescence(setup.holders, setup.electionId)
      for (const p of setup.holders) {
        expect(await p.vault.hasSecret(keyholderDkgShareAlias(setup.electionId, setup.revision, p.userId)), `${p.name} share`).to.equal(true)
      }

      const { at } = await releaseThree(setup)
      const engine = new KeyReleaseEngine({ db: setup.auth.ctx.db }, { now: () => at + 1 })
      const status = await engine.getKeyReleaseStatus(setup.electionId)
      expect(status.phase).to.equal('reconstructable')
      expect(status.rejectedReleases).to.deep.equal([])
      const reconstructed = await engine.reconstructElectionKey(setup.electionId)
      expect(bytesToHex(secp256k1.getPublicKey(reconstructed.secretKey, true))).to.equal(setup.y)
    })

    it('R2: with a malformed GroupCommitments column, release status and seeding do not throw and the release still works', async () => {
      const setup = await driveToRound4Minus1()
      let refused: unknown = null
      try {
        await publishForgedElectionKey(setup, setup.holders[0]!, { groupCommitments: 'not-json' })
      } catch (err) {
        refused = err
      }
      if (refused !== null) {
        await publishForgedElectionKey(setup, setup.holders[0]!, { groupCommitments: JSON.stringify(['not-a-point']) })
      }
      await runDkgToQuiescence(setup.holders, setup.electionId)

      const db = setup.auth.ctx.db
      const at = await releaseAt(db, setup.electionId)
      const p0 = setup.holders[0]!
      const tasks = new KeysTasksEngine(
        { hash: 'h'.repeat(16), name: 'Test Network', relays: [], primaryAuthorityDomainName: 'authority.example.com' },
        { db }, { vault: p0.vault, now: () => at + 1 }
      )
      await tasks.getKeysToRelease(true)
      await releaseThree(setup)
      const engine = new KeyReleaseEngine({ db }, { now: () => at + 1 })
      expect((await engine.getKeyReleaseStatus(setup.electionId)).phase).to.equal('reconstructable')
      const reconstructed = await engine.reconstructElectionKey(setup.electionId)
      expect(bytesToHex(secp256k1.getPublicKey(reconstructed.secretKey, true))).to.equal(setup.y)
    })

    it('R3: a signed release row carrying a wrong share is rejected share-invalid against the transcript commitments', async () => {
      const setup = await driveToRound4Minus1()
      await publishForgedElectionKey(setup, setup.holders[0]!, { groupCommitments: junkCommitments(setup.commitments) })
      await runDkgToQuiescence(setup.holders, setup.electionId)

      const db = setup.auth.ctx.db
      const at = await releaseAt(db, setup.electionId)
      const x = setup.holders[3]!
      const identifier = dkgIdentifierForUser(x.userId)
      const wrongShare = bytesToHex(secp256k1.utils.randomSecretKey())
      const releasedAt = new Date(at + 1).toISOString()
      const digestRow = await db
        .prepare("select Digest('KeyholderShareRelease', :electionId, :revision, :userId, :identifier, :signingShare, :releasedAt) as d")
        .get({ electionId: setup.electionId, revision: setup.revision, userId: x.userId, identifier, signingShare: wrongShare, releasedAt })
      const signature = await x.signer.sign(digestToBytes(digestRow!.d as string))
      await db.exec(
        `insert into KeyholderShareRelease (ElectionId, ElectionRevision, UserId, Identifier, SigningShare, ReleasedAt, SignerKey, Signature)
         values (:electionId, :revision, :userId, :identifier, :signingShare, :releasedAt, :signerKey, :signature)`,
        { electionId: setup.electionId, revision: setup.revision, userId: x.userId, identifier, signingShare: wrongShare, releasedAt, signerKey: signature.signerKey, signature: signature.signature }
      )
      const status = await new KeyReleaseEngine({ db }, { now: () => at + 1 }).getKeyReleaseStatus(setup.electionId)
      expect(status.rejectedReleases.find((r) => r.userId === x.userId)?.reason).to.equal('share-invalid')
    })
  })
})
