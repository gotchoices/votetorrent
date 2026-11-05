/**
 * dkg-status-rotation.spec.ts (62-42, WR-02 regression)
 *
 * keyholder-dkg-engine's snapshot reads required every KeyholderDkgMessage /
 * ElectionKey signing key to be in the CURRENT UserKey table, so one routine
 * key rotation after the DKG made getDkgStatus read failed /
 * election-key-mismatch and verifyDkgTranscript report
 * electionKeyConsistent false, while key release (62-39) read 'releasing'.
 * These real-engine cases rotate a key through UserEngine.revokeKey and pin:
 *   - DS1 is the no-rotation control,
 *   - DS2 / DS3 status and audit stay healthy after a participant's /
 *     the publisher's rotation, and agree with key release,
 *   - DS4a / DS4b writes stay closed: a revoked key can neither raw-insert a
 *     KeyholderDkgMessage (schema) nor advance the DKG (engine),
 *   - DS5 (62-48, IN-04) a MID-DKG rotation (after round 0, before any
 *     ElectionKey) followed by continuing with the NEW key still completes
 *     with a consistent transcript spanning both keys.
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { releasingKeysAt } from '../src/key-release/release-window.js'
import { KeyReleaseEngine } from '../src/key-release/key-release-engine.js'
import { KeyholderDkgError } from '../src/keyholder/dkg-vault.js'
import { UserEngine } from '../src/user/user-engine.js'
import { digestToBytes } from '../src/utils.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import {
  postSignedDkgMessage, runDkgToQuiescence, seedDkgElection,
  type DkgTestParticipant, type SeedDkgElectionResult
} from './fixtures/dkg-keyholders.js'

interface Setup {
  seeded: SeedDkgElectionResult
  db: Database
  electionId: string
  at: number
  publisher: DkgTestParticipant
  nonPublishers: DkgTestParticipant[]
  participants: DkgTestParticipant[]
}

async function setup (): Promise<Setup> {
  const seeded = await seedDkgElection({ keyholders: ['Alice', 'Bob', 'Carol'], threshold: 2 })
  const { auth, electionId, participants } = seeded
  const db = auth.ctx.db
  await runDkgToQuiescence(participants, electionId)
  const ek = await db.prepare('select PublisherUserId from ElectionKey where ElectionId = :electionId').get({ electionId })
  if (!ek) throw new Error('setup: DKG published no ElectionKey')
  const tl = await db.prepare('select Timeline from ElectionRevision where ElectionId = :electionId').get({ electionId })
  const at = releasingKeysAt(JSON.parse(tl!.Timeline as string) as Record<string, number>)
  if (at === null) throw new Error('setup: no releasingKeys entry')
  const publisherUserId = ek.PublisherUserId as string
  return {
    seeded, db, electionId, at, participants,
    publisher: participants.find((p) => p.userId === publisherUserId)!,
    nonPublishers: participants.filter((p) => p.userId !== publisherUserId)
  }
}

/** Verifier recipe: add a second key (signed by the current one), revoke the DKG key (signed by the new one). */
async function rotateAndRevoke (s: Setup, p: DkgTestParticipant): Promise<void> {
  const db = s.db
  const user = { id: p.userId, activeKeys: [{ key: p.signer.signingPublicKey, type: 'M', expiration: Date.now() + 86_400_000 }] }
  const ue = new UserEngine(user as never, s.seeded.auth.ctx)
  const second = randomTestKeyPair()
  await ue.addKey({ key: second.publicHex, type: 'M', expiration: Date.now() + 86_400_000 } as never, p.signer.sign)
  const d = await db.prepare('select Digest(:u, :k) as d').get({ u: p.userId, k: p.signer.signingPublicKey })
  const sig = secp256k1.sign(digestToBytes(d!.d as string), hexToBytes(second.privateHex))
  await ue.revokeKey(p.signer.signingPublicKey, { signature: bytesToHex(sig), signerKey: second.publicHex, signerUserId: '' })
  const left = await db.prepare('select count(*) as n from UserKey where UserId = :u and PubKey = :k').get({ u: p.userId, k: p.signer.signingPublicKey })
  expect(Number(left!.n), `${p.name} old key revoked`).to.equal(0)
}

async function expectHealthy (s: Setup): Promise<void> {
  for (const p of s.participants) {
    const status = await p.engine.getDkgStatus(s.electionId, p.userId)
    expect(status.phase, `${p.name} dkg phase`).to.equal('complete')
    expect((status as { failedReason?: string }).failedReason, `${p.name} failedReason`).to.equal(undefined)
  }
  const verdict = await s.participants[0]!.engine.verifyDkgTranscript(s.electionId)
  expect(verdict.electionKeyConsistent, 'electionKeyConsistent').to.equal(true)
  expect(verdict.invalidRows, 'invalidRows').to.deep.equal([])
}

async function countMessages (s: Setup, userId?: string): Promise<number> {
  const row = userId === undefined
    ? await s.db.prepare('select count(*) as n from KeyholderDkgMessage where ElectionId = :e').get({ e: s.electionId })
    : await s.db.prepare('select count(*) as n from KeyholderDkgMessage where ElectionId = :e and SenderUserId = :u and Attempt = 2').get({ e: s.electionId, u: userId })
  return Number(row!.n)
}

interface MidRunSetup {
  seeded: SeedDkgElectionResult
  db: Database
  electionId: string
  participants: DkgTestParticipant[]
}

async function setupMidRun (): Promise<MidRunSetup> {
  const seeded = await seedDkgElection({ keyholders: ['Alice', 'Bob', 'Carol'], threshold: 2 })
  const { auth, electionId, participants } = seeded
  const db = auth.ctx.db
  const count = async (): Promise<number> => {
    const r = await db.prepare('select count(*) as n from KeyholderDkgMessage where ElectionId = :e').get({ e: electionId })
    return Number(r!.n)
  }
  await runDkgToQuiescence(participants, electionId, { stopWhen: async () => (await count()) >= 3 })
  const ek = await db.prepare('select 1 as x from ElectionKey where ElectionId = :e').get({ e: electionId })
  expect(ek, 'no ElectionKey yet at rotation time').to.equal(undefined)
  return { seeded, db, electionId, participants }
}

/** Rotate p's DKG key (add fresh, revoke old) and swap p.signer to the fresh key. Returns the fresh key pair. */
async function rotateMidRun (s: MidRunSetup, p: DkgTestParticipant): Promise<{ publicHex: string, privateHex: string }> {
  const db = s.db
  const user = { id: p.userId, activeKeys: [{ key: p.signer.signingPublicKey, type: 'M', expiration: Date.now() + 86_400_000 }] }
  const ue = new UserEngine(user as never, s.seeded.auth.ctx)
  const fresh = randomTestKeyPair()
  await ue.addKey({ key: fresh.publicHex, type: 'M', expiration: Date.now() + 86_400_000 } as never, p.signer.sign)
  const d = await db.prepare('select Digest(:u, :k) as d').get({ u: p.userId, k: p.signer.signingPublicKey })
  const sig = secp256k1.sign(digestToBytes(d!.d as string), hexToBytes(fresh.privateHex))
  await ue.revokeKey(p.signer.signingPublicKey, { signature: bytesToHex(sig), signerKey: fresh.publicHex, signerUserId: '' })
  const left = await db.prepare('select count(*) as n from UserKey where UserId = :u and PubKey = :k').get({ u: p.userId, k: p.signer.signingPublicKey })
  expect(Number(left!.n), `${p.name} old key revoked`).to.equal(0)
  p.signer = {
    userId: p.userId,
    signingPublicKey: fresh.publicHex,
    sign: async (digest: Uint8Array) => ({
      signature: bytesToHex(secp256k1.sign(digest, hexToBytes(fresh.privateHex))),
      signerKey: fresh.publicHex,
      signerUserId: ''
    })
  }
  return fresh
}

describe('DKG status survives keyholder key rotation (62-42, WR-02)', function () {
  this.timeout(240_000)

  it('DS1 control: no rotation, status complete and transcript consistent', async () => {
    const s = await setup()
    await expectHealthy(s)
  })

  it('DS2: a non-publisher participant rotating its DKG key leaves status complete and agrees with release', async () => {
    const s = await setup()
    await rotateAndRevoke(s, s.nonPublishers[0]!)
    await expectHealthy(s)
    const kr = await new KeyReleaseEngine({ db: s.db }, { now: () => s.at + 1 }).getKeyReleaseStatus(s.electionId)
    expect(kr.phase).to.equal('releasing')
  })

  it('DS3: the ElectionKey publisher rotating its DKG key leaves status complete and agrees with release', async () => {
    const s = await setup()
    await rotateAndRevoke(s, s.publisher)
    await expectHealthy(s)
    const kr = await new KeyReleaseEngine({ db: s.db }, { now: () => s.at + 1 }).getKeyReleaseStatus(s.electionId)
    expect(kr.phase).to.equal('releasing')
  })

  it('DS4a: the schema still refuses a raw KeyholderDkgMessage signed by a revoked key (SenderKeyIsUsers)', async () => {
    const s = await setup()
    const p = s.nonPublishers[0]!
    await rotateAndRevoke(s, p)
    let refused: unknown = null
    try {
      await postSignedDkgMessage(s.db, p, {
        electionId: s.electionId, revision: s.seeded.revision, attempt: 2, dkgRound: 0, payload: 'aa'.repeat(16), resultKey: null
      })
    } catch (err) {
      refused = err
    }
    expect(refused, 'raw insert refused').to.not.equal(null)
    expect(String((refused as Error).message)).to.match(/SenderKeyIsUsers/)
    expect(await countMessages(s, p.userId)).to.equal(0)
  })

  it('DS4b: advanceDkg with a revoked key fails signer-key-mismatch and writes no row', async () => {
    const s = await setup()
    const p = s.nonPublishers[0]!
    await rotateAndRevoke(s, p)
    const before = await countMessages(s)
    let err: unknown = null
    try {
      await p.engine.advanceDkg(s.electionId, p.signer)
    } catch (e) {
      err = e
    }
    expect(err).to.be.instanceOf(KeyholderDkgError)
    expect((err as KeyholderDkgError).code).to.equal('signer-key-mismatch')
    expect(await countMessages(s)).to.equal(before)
  })

  it('DS5: a participant rotating its DKG key mid-run (after round 0, before any ElectionKey) still completes with a consistent transcript (IN-04)', async function () {
    this.timeout(600_000)
    const s = await setupMidRun()
    const p = s.participants[0]!
    const oldKey = p.signer.signingPublicKey
    const fresh = await rotateMidRun(s, p)
    await runDkgToQuiescence(s.participants, s.electionId)

    for (const q of s.participants) {
      const status = await q.engine.getDkgStatus(s.electionId, q.userId)
      expect(status.phase, `${q.name} dkg phase`).to.equal('complete')
      expect((status as { failedReason?: string }).failedReason, `${q.name} failedReason`).to.equal(undefined)
    }
    const verdict = await s.participants[1]!.engine.verifyDkgTranscript(s.electionId)
    expect(verdict.electionKeyConsistent, 'electionKeyConsistent').to.equal(true)
    expect(verdict.invalidRows, 'invalidRows').to.deep.equal([])

    // Non-vacuity: the transcript really spans the rotation.
    const keyed = async (k: string): Promise<number> => {
      const r = await s.db.prepare('select count(*) as n from KeyholderDkgMessage where ElectionId = :e and SenderUserId = :u and SenderKey = :k')
        .get({ e: s.electionId, u: p.userId, k })
      return Number(r!.n)
    }
    expect(await keyed(oldKey), 'rows signed by the OLD key').to.be.greaterThan(0)
    expect(await keyed(fresh.publicHex), 'rows signed by the FRESH key').to.be.greaterThan(0)
  })
})
