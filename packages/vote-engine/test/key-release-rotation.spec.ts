/**
 * key-release-rotation.spec.ts (62-39, CR-02 / V-2 regression)
 *
 * 62-34 made release-time reads re-require every signing key to be in the
 * CURRENT UserKey table, so one keyholder's routine key rotation (or the
 * publisher's) made the election key unrecoverable for everyone. These real
 * engine cases rotate a key through UserEngine.revokeKey and pin that:
 *   - release stays open and the key reconstructs to the published Y (KR2-KR4),
 *   - writes stay closed: a revoked key can neither release through the
 *     engine (KR5b) nor raw-insert a KeyholderShareRelease (KR5a),
 *   - KR1 is the no-rotation control.
 * Every reconstruction is compared against Y, never an outcome-only check.
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { dkgIdentifierForUser } from '../src/crypto/dkg.js'
import { releasingKeysAt } from '../src/key-release/release-window.js'
import { KeyReleaseEngine, KeyReleaseError } from '../src/key-release/key-release-engine.js'
import { UserEngine } from '../src/user/user-engine.js'
import { digestToBytes } from '../src/utils.js'
import { randomTestKeyPair, type TestKeyPair } from './fixtures/keys.js'
import { runDkgToQuiescence, seedDkgElection, type DkgTestParticipant, type SeedDkgElectionResult } from './fixtures/dkg-keyholders.js'

interface Setup {
  seeded: SeedDkgElectionResult
  db: Database
  electionId: string
  y: string
  publisherUserId: string
  at: number
  nonPublishers: DkgTestParticipant[]
  publisher: DkgTestParticipant
}

async function setup (): Promise<Setup> {
  const seeded = await seedDkgElection({ keyholders: ['Alice', 'Bob', 'Carol'], threshold: 2 })
  const { auth, electionId, participants } = seeded
  const db = auth.ctx.db
  await runDkgToQuiescence(participants, electionId)
  const ek = await db.prepare('select JointPublicKey, PublisherUserId from ElectionKey where ElectionId = :electionId').get({ electionId })
  if (!ek) throw new Error('setup: DKG published no ElectionKey')
  const tl = await db.prepare('select Timeline from ElectionRevision where ElectionId = :electionId').get({ electionId })
  const at = releasingKeysAt(JSON.parse(tl!.Timeline as string) as Record<string, number>)
  if (at === null) throw new Error('setup: no releasingKeys entry')
  const publisherUserId = ek.PublisherUserId as string
  const publisher = participants.find((p) => p.userId === publisherUserId)!
  return {
    seeded, db, electionId, y: ek.JointPublicKey as string, publisherUserId, at, publisher,
    nonPublishers: participants.filter((p) => p.userId !== publisherUserId)
  }
}

/** Verifier recipe: add a second key (signed by the current one), revoke the DKG key (signed by the new one). */
async function rotateAndRevoke (s: Setup, p: DkgTestParticipant): Promise<TestKeyPair> {
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
  return second
}

function engineFor (s: Setup, p?: DkgTestParticipant): KeyReleaseEngine {
  return new KeyReleaseEngine({ db: s.db }, { vault: p?.vault, now: () => s.at + 1 })
}

async function releaseOk (s: Setup, p: DkgTestParticipant): Promise<void> {
  const out = await engineFor(s, p).releaseKeyShare(s.electionId, p.signer)
  expect(out.outcome, `${p.name} release`).to.equal('released')
}

async function expectReconstructsToY (s: Setup): Promise<void> {
  const engine = engineFor(s)
  const status = await engine.getKeyReleaseStatus(s.electionId)
  expect(status.phase).to.equal('reconstructable')
  expect(status.rejectedReleases).to.deep.equal([])
  const reconstructed = await engine.reconstructElectionKey(s.electionId)
  expect(bytesToHex(secp256k1.getPublicKey(reconstructed.secretKey, true))).to.equal(s.y)
}

describe('key release survives keyholder key rotation (62-39, CR-02)', function () {
  this.timeout(240_000)

  it('KR1 control: no rotation, two holders release and the key reconstructs to Y', async () => {
    const s = await setup()
    expect((await engineFor(s).getKeyReleaseStatus(s.electionId)).phase).to.equal('releasing')
    await releaseOk(s, s.nonPublishers[0]!)
    await releaseOk(s, s.nonPublishers[1]!)
    await expectReconstructsToY(s)
  })

  it('KR2: a non-publisher participant rotating its DKG key does not block release', async () => {
    const s = await setup()
    await rotateAndRevoke(s, s.nonPublishers[0]!)
    expect((await engineFor(s).getKeyReleaseStatus(s.electionId)).phase).to.equal('releasing')
    await releaseOk(s, s.nonPublishers[1]!)
    await releaseOk(s, s.publisher)
    await expectReconstructsToY(s)
  })

  it('KR3: a holder that released and then rotated away its signing key still counts toward k', async () => {
    const s = await setup()
    const rotating = s.nonPublishers[0]!
    await releaseOk(s, rotating)
    await rotateAndRevoke(s, rotating)
    await releaseOk(s, s.nonPublishers[1]!)
    await expectReconstructsToY(s)
  })

  it('KR4: the ElectionKey publisher rotating does not block seeding or release', async () => {
    const s = await setup()
    await rotateAndRevoke(s, s.publisher)
    expect((await engineFor(s).getKeyReleaseStatus(s.electionId)).phase).to.equal('releasing')
    const holder = s.nonPublishers[0]!
    const seeded = await engineFor(s, holder).seedReleaseKeyTasks()
    expect(seeded.seeded.map((t) => t.userId)).to.include(holder.userId)
    await releaseOk(s, s.nonPublishers[0]!)
    await releaseOk(s, s.nonPublishers[1]!)
    await expectReconstructsToY(s)
  })

  it('KR5a: the schema still refuses a raw KeyholderShareRelease signed by a revoked key', async () => {
    const s = await setup()
    const p = s.nonPublishers[0]!
    await rotateAndRevoke(s, p)
    const identifier = dkgIdentifierForUser(p.userId)
    const signingShare = 'ab'.repeat(32)
    const releasedAt = new Date(s.at + 1).toISOString()
    const d = await s.db
      .prepare("select Digest('KeyholderShareRelease', :electionId, :revision, :userId, :identifier, :signingShare, :releasedAt) as d")
      .get({ electionId: s.electionId, revision: s.seeded.revision, userId: p.userId, identifier, signingShare, releasedAt })
    const signature = await p.signer.sign(digestToBytes(d!.d as string))
    let refused: unknown = null
    try {
      await s.db.exec(
        `insert into KeyholderShareRelease (ElectionId, ElectionRevision, UserId, Identifier, SigningShare, ReleasedAt, SignerKey, Signature)
         values (:electionId, :revision, :userId, :identifier, :signingShare, :releasedAt, :signerKey, :signature)`,
        { electionId: s.electionId, revision: s.seeded.revision, userId: p.userId, identifier, signingShare, releasedAt, signerKey: signature.signerKey, signature: signature.signature }
      )
    } catch (err) {
      refused = err
    }
    expect(refused, 'raw insert refused').to.not.equal(null)
    expect(String((refused as Error).message)).to.match(/SignerIsUser/)
    const row = await s.db.prepare('select 1 as x from KeyholderShareRelease where ElectionId = :e and UserId = :u').get({ e: s.electionId, u: p.userId })
    expect(row).to.equal(undefined)
  })

  it('KR5b: releaseKeyShare with a revoked key fails signer-key-mismatch and writes no row', async () => {
    const s = await setup()
    const p = s.nonPublishers[0]!
    await rotateAndRevoke(s, p)
    let err: unknown = null
    try {
      await engineFor(s, p).releaseKeyShare(s.electionId, p.signer)
    } catch (e) {
      err = e
    }
    expect(err).to.be.instanceOf(KeyReleaseError)
    expect((err as KeyReleaseError).code).to.equal('signer-key-mismatch')
    const row = await s.db.prepare('select 1 as x from KeyholderShareRelease where ElectionId = :e and UserId = :u').get({ e: s.electionId, u: p.userId })
    expect(row).to.equal(undefined)
  })

  it('KR6 (IN-04): a rotated holder releases with its NEW key and the key reconstructs to Y', async () => {
    const s = await setup()
    const p = s.nonPublishers[0]!
    const fresh = await rotateAndRevoke(s, p)
    const newSigner = {
      userId: p.userId,
      signingPublicKey: fresh.publicHex,
      sign: async (digest: Uint8Array) => ({
        signature: bytesToHex(secp256k1.sign(digest, hexToBytes(fresh.privateHex))),
        signerKey: fresh.publicHex,
        signerUserId: ''
      })
    }
    const out = await engineFor(s, p).releaseKeyShare(s.electionId, newSigner)
    expect(out.outcome, `${p.name} release with new key`).to.equal('released')
    await releaseOk(s, s.nonPublishers[1]!)
    await expectReconstructsToY(s)
  })
})
