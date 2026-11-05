/**
 * keyholder-dkg-schema.spec.ts — 62-02 Task 2.
 *
 * Schema-level proof of `KeyholderDkgMessage` (D-19), `ElectionKey` (D-13, D-16) and
 * `KeyholderShareRelease` (D-13, D-17). Uses real `@noble/curves` keys for every signer (never
 * `src/crypto/dkg.ts` — schema tests stay independent of 62-05's DKG implementation), and seeds
 * three bound keyholders (ElectionRevision.KeyholderThreshold = 2) through the SAME
 * Probe-1-proven one-transaction accept shape `keyholder-dkg-binding.spec.ts` uses.
 */

import { expect } from 'chai'
import { ConstraintError } from '@quereus/quereus'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { KeyholderInvite, Signature } from '@votetorrent/vote-core'
import { ElectionsEngine, peekNextElectionTid } from '../src/elections/elections-engine.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { digestToBytes, nowCanonicalDatetime, toCanonicalDatetime } from '../src/utils.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  makeTestSignCallback,
  makeElectionInit,
} from './fixtures/test-context.js'
import type { EngineContext } from '../src/types.js'

// ---------------------------------------------------------------------------
// Shared helpers (duplicated, not shared with keyholder-dkg-binding.spec.ts, per plan)
// ---------------------------------------------------------------------------

function makeKeyholderInvite (name: string): KeyholderInvite {
  return {
    name,
    type: 'k',
    expiration: new Date(Date.now() + 3_600_000).toISOString(),
    inviteKey: 'k'.repeat(66),
    inviteSignature: '',
  }
}

async function keyholderSlotCid (ctx: EngineContext, name: string): Promise<{ cid: string, inviteSignature: string }> {
  const row = await ctx.db.prepare("select Cid, InviteSignature from InviteSlot where Type = 'k' and Name = :name").get({ name })
  if (!row) throw new Error(`keyholderSlotCid: no InviteSlot found for name=${name}`)
  return { cid: row.Cid as string, inviteSignature: (row.InviteSignature as string | null) ?? '' }
}

interface SeededElection {
  auth: Awaited<ReturnType<typeof addTestAuthority>>
  electionEngine: Awaited<ReturnType<typeof addTestElection>>['electionEngine']
  electionId: string
}

async function seedElectionWithThreshold (threshold: number): Promise<SeededElection> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const electionsEngine = new ElectionsEngine(auth.ctx)
  const init = makeElectionInit({ authorityId: auth.authority.id })
  init.revision.keyholderThreshold = threshold
  const { election: e } = init
  const pastRevTimestamp = Date.now() - 1000
  const electionFields = {
    id: e.id, authorityId: e.authorityId, title: e.title, date: e.date,
    revisionDeadline: e.revisionDeadline, ballotDeadline: e.ballotDeadline, type: e.type,
  }
  const sign = makeTestSignCallback(auth.user)
  const signingNonce = await electionsEngine.seedElectionSigning(electionFields, sign)
  const revTid = (await peekNextElectionTid(auth.ctx.db)) + 1
  const revisionSigningNonce = await (electionsEngine as unknown as {
    seedElectionRevisionSigning(
      electionId: string, authorityId: string,
      revision: { revision: number, revisionTimestamp: number, tags: string[], instructions: string, timeline: Record<string, number>, keyholderThreshold: number },
      tid: number, sign: (digest: Uint8Array) => Promise<Signature>,
    ): Promise<string>
  }).seedElectionRevisionSigning(
    e.id, e.authorityId,
    {
      revision: 0, revisionTimestamp: pastRevTimestamp, tags: init.revision.tags, instructions: init.revision.instructions,
      timeline: init.revision.timeline as Record<string, number>, keyholderThreshold: threshold,
    },
    revTid, sign
  )
  const initWithPastTs = { ...init, revision: { ...init.revision, revisionTimestamp: pastRevTimestamp } }
  await electionsEngine.createElection(initWithPastTs, { signingNonce, revisionSigningNonce })
  const electionEngine = await electionsEngine.openElection(e.id)
  return { auth, electionEngine, electionId: e.id }
}

interface TestKeyholder {
  userId: string
  publicHex: string
  privateHex: string
  slotCid: string
}

/** Invite, mint User+UserKey+Keyholder+KeyholderDkgBinding for a fresh keyholder in ONE transaction. */
async function inviteAndBindKeyholder (seeded: SeededElection, name: string): Promise<TestKeyholder> {
  await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite(name), seeded.electionId, makeTestSignCallback(seeded.auth.user))
  const slot = await keyholderSlotCid(seeded.auth.ctx, name)
  const userId = crypto.randomUUID()
  const { privateHex, publicHex } = randomTestKeyPair()
  const dkgPublicKey = randomTestKeyPair().publicHex
  const boundAt = nowCanonicalDatetime() + 'Z'
  const ctx = seeded.auth.ctx
  const tid = await allocateTid(ctx.db, 'user')

  await ctx.db.exec('BEGIN')
  try {
    await ctx.db.exec(
      `insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
       with context IsSigningValid = true, IsSignatureValid = true
       values (:slotCid, true, :slotCid, 'test-sig', :invokedId)`,
      { slotCid: slot.cid, invokedId: userId }
    )
    await ctx.db.exec(
      `insert into User (Id, Name, ImageRef)
       with context SigningNonce = null, InviteSlotCid = :slotCid, InviteSignature = :inviteSig, Tid = ${tid}
       values (:userId, :userName, null)`,
      { slotCid: slot.cid, inviteSig: slot.inviteSignature, userId, userName: name }
    )
    await ctx.db.exec(
      `insert into UserKey (UserId, Type, PubKey, Expiration)
       with context UserKey = null, Signature = null, Tid = ${tid}, now = :now, IsSignatureValid = true
       values (:userId, 'M', :pubKey, :expiration)`,
      { userId, pubKey: publicHex, expiration: toCanonicalDatetime(Date.now() + 365 * 86_400_000), now: nowCanonicalDatetime() }
    )
    await ctx.db.exec(
      `insert into Keyholder (ElectionId, ElectionRevision, UserId)
       with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
       values (:electionId, 0, :userId)`,
      { electionId: seeded.electionId, userId }
    )
    const digestRow = await ctx.db
      .prepare("select Digest('KeyholderDkgBinding', :electionId, 0, :userId, :slotCid, :dkgPublicKey, :boundAt) as d")
      .get({ electionId: seeded.electionId, userId, slotCid: slot.cid, dkgPublicKey, boundAt })
    const sig = bytesToHex(secp256k1.sign(digestToBytes(digestRow!.d as string), hexToBytes(privateHex)))
    await ctx.db.exec(
      `insert into KeyholderDkgBinding (ElectionId, ElectionRevision, UserId, InviteSlotCid, DkgPublicKey, BoundAt, SignerKey, Signature)
       values (:electionId, 0, :userId, :slotCid, :dkgPublicKey, :boundAt, :signerKey, :signature)`,
      { electionId: seeded.electionId, userId, slotCid: slot.cid, dkgPublicKey, boundAt, signerKey: publicHex, signature: sig }
    )
    await ctx.db.exec('COMMIT')
  } catch (err) {
    await ctx.db.exec('ROLLBACK')
    throw err
  }
  return { userId, publicHex, privateHex, slotCid: slot.cid }
}

/** Seed `count` bound keyholders on an election whose KeyholderThreshold = `threshold`. */
async function seedKeyholders (threshold: number, count: number): Promise<{ seeded: SeededElection, keyholders: TestKeyholder[] }> {
  const seeded = await seedElectionWithThreshold(threshold)
  const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'].slice(0, count)
  const keyholders: TestKeyholder[] = []
  for (const name of names) {
    keyholders.push(await inviteAndBindKeyholder(seeded, `${name} Keyholder`))
  }
  return { seeded, keyholders }
}

function signWith (privateHex: string, digest: Uint8Array): string {
  return bytesToHex(secp256k1.sign(digest, hexToBytes(privateHex)))
}

async function expectRejected (p: Promise<unknown>, checkName: string): Promise<void> {
  let caught: unknown
  try {
    await p
  } catch (err) {
    caught = err
  }
  expect(caught, `must throw, naming ${checkName}`).to.not.equal(undefined)
  expect(caught).to.be.instanceOf(Error)
  expect((caught as Error).message, `error must name ${checkName}`).to.include(checkName)
}

// ═══════════════════════════════════════════════════════════════════════════
// KeyholderDkgMessage (D-19)
// ═══════════════════════════════════════════════════════════════════════════

interface MessageOverrides {
  electionId?: string
  attempt?: number
  dkgRound?: number
  senderUserId?: string
  payload?: string
  resultKey?: string | null
  sentAt?: string
  senderKey?: string
  signOverride?: (digestHex: string) => string
}

async function insertDkgMessage (ctx: EngineContext, seeded: SeededElection, kh: TestKeyholder, overrides: MessageOverrides = {}): Promise<void> {
  const electionId = overrides.electionId ?? seeded.electionId
  const revision = 0
  const attempt = overrides.attempt ?? 1
  const dkgRound = overrides.dkgRound ?? 0
  const senderUserId = overrides.senderUserId ?? kh.userId
  const payload = overrides.payload ?? JSON.stringify({ commit: 'c'.repeat(8) })
  const resultKey = overrides.resultKey === undefined ? (dkgRound === 4 ? randomTestKeyPair().publicHex : null) : overrides.resultKey
  const sentAt = overrides.sentAt ?? (nowCanonicalDatetime() + 'Z')
  const senderKey = overrides.senderKey ?? kh.publicHex

  const digestRow = await ctx.db
    .prepare("select Digest('KeyholderDkgMessage', :electionId, :revision, :attempt, :dkgRound, :senderUserId, :payload, :resultKey, :sentAt) as d")
    .get({ electionId, revision, attempt, dkgRound, senderUserId, payload, resultKey, sentAt })
  if (!digestRow || digestRow.d == null) throw new Error('insertDkgMessage: Digest() returned null')
  const signature = overrides.signOverride ? overrides.signOverride(digestRow.d as string) : signWith(kh.privateHex, digestToBytes(digestRow.d as string))

  await ctx.db.exec(
    `insert into KeyholderDkgMessage (ElectionId, ElectionRevision, Attempt, DkgRound, SenderUserId, Payload, ResultKey, SentAt, SenderKey, Signature)
     values (:electionId, :revision, :attempt, :dkgRound, :senderUserId, :payload, :resultKey, :sentAt, :senderKey, :signature)`,
    { electionId, revision, attempt, dkgRound, senderUserId, payload, resultKey, sentAt, senderKey, signature }
  )
}

describe('KeyholderDkgMessage (D-19) — schema proofs', () => {
  it('rounds 0-3 with ResultKey null insert from a bound keyholder', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 1)
    for (let round = 0; round <= 3; round++) {
      await insertDkgMessage(seeded.auth.ctx, seeded, keyholders[0]!, { dkgRound: round })
    }
    const count = (await seeded.auth.ctx.db.prepare('select count(*) as c from KeyholderDkgMessage').get())!.c as number
    expect(count).to.equal(4)
  })

  it('a DkgRound 4 row with a valid 66-char ResultKey inserts', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 1)
    await insertDkgMessage(seeded.auth.ctx, seeded, keyholders[0]!, { dkgRound: 4 })
    const count = (await seeded.auth.ctx.db.prepare('select count(*) as c from KeyholderDkgMessage where DkgRound = 4').get())!.c as number
    expect(count).to.equal(1)
  })

  it('DkgRound 4 WITHOUT a ResultKey throws ResultKeyShape', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 1)
    await expectRejected(insertDkgMessage(seeded.auth.ctx, seeded, keyholders[0]!, { dkgRound: 4, resultKey: null }), 'ResultKeyShape')
  })

  it('DkgRound 2 WITH a ResultKey throws ResultKeyShape', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 1)
    await expectRejected(insertDkgMessage(seeded.auth.ctx, seeded, keyholders[0]!, { dkgRound: 2, resultKey: randomTestKeyPair().publicHex }), 'ResultKeyShape')
  })

  it('DkgRound 5 throws DkgRoundValid', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 1)
    await expectRejected(insertDkgMessage(seeded.auth.ctx, seeded, keyholders[0]!, { dkgRound: 5, resultKey: null }), 'DkgRoundValid')
  })

  it('Attempt 0 throws AttemptValid', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 1)
    await expectRejected(insertDkgMessage(seeded.auth.ctx, seeded, keyholders[0]!, { attempt: 0 }), 'AttemptValid')
  })

  it('Attempt 4 throws AttemptValid', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 1)
    await expectRejected(insertDkgMessage(seeded.auth.ctx, seeded, keyholders[0]!, { attempt: 4 }), 'AttemptValid')
  })

  it('a sender with NO Keyholder row throws SenderIsBoundKeyholder', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 1)
    const { privateHex, publicHex } = randomTestKeyPair()
    const outsider: TestKeyholder = { userId: crypto.randomUUID(), publicHex, privateHex, slotCid: keyholders[0]!.slotCid }
    await expectRejected(insertDkgMessage(seeded.auth.ctx, seeded, outsider), 'SenderIsBoundKeyholder')
  })

  it('SenderKey belonging to ANOTHER user throws SenderKeyIsUsers', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 2)
    // The signature must itself be VALID (signed by keyholders[1]'s real key) so SignatureValid
    // does not fire first — the only thing wrong is that keyholders[1]'s key is not registered to
    // SenderUserId=keyholders[0].
    await expectRejected(
      insertDkgMessage(seeded.auth.ctx, seeded, keyholders[0]!, {
        senderKey: keyholders[1]!.publicHex,
        signOverride: (digestHex) => signWith(keyholders[1]!.privateHex, digestToBytes(digestHex))
      }),
      'SenderKeyIsUsers'
    )
  })

  it('a tampered Payload (signed over a different payload) throws SignatureValid', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 1)
    const kh = keyholders[0]!
    // Sign over the digest of a DIFFERENT payload than the one actually inserted.
    const wrongDigestRow = await seeded.auth.ctx.db
      .prepare("select Digest('KeyholderDkgMessage', :electionId, 0, 1, 0, :senderUserId, :payload, null, :sentAt) as d")
      .get({ electionId: seeded.electionId, senderUserId: kh.userId, payload: JSON.stringify({ tampered: true }), sentAt: nowCanonicalDatetime() + 'Z' })
    await expectRejected(
      insertDkgMessage(seeded.auth.ctx, seeded, kh, { signOverride: () => signWith(kh.privateHex, digestToBytes(wrongDigestRow!.d as string)) }),
      'SignatureValid'
    )
  })

  it('a duplicate (Attempt, DkgRound, SenderUserId) throws (primary key)', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 1)
    await insertDkgMessage(seeded.auth.ctx, seeded, keyholders[0]!, { dkgRound: 1 })
    await expectRejected(insertDkgMessage(seeded.auth.ctx, seeded, keyholders[0]!, { dkgRound: 1 }), '')
  })

  it('UPDATE and DELETE both throw', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 1)
    await insertDkgMessage(seeded.auth.ctx, seeded, keyholders[0]!, { dkgRound: 1 })
    let updateErr: unknown, deleteErr: unknown
    try { await seeded.auth.ctx.db.exec("update KeyholderDkgMessage set Payload = '{}' where SenderUserId = :id", { id: keyholders[0]!.userId }) } catch (e) { updateErr = e }
    try { await seeded.auth.ctx.db.exec('delete from KeyholderDkgMessage where SenderUserId = :id', { id: keyholders[0]!.userId }) } catch (e) { deleteErr = e }
    expect(updateErr).to.be.instanceOf(ConstraintError)
    expect(deleteErr).to.be.instanceOf(ConstraintError)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ElectionKey (D-13, D-16)
// ═══════════════════════════════════════════════════════════════════════════

async function insertElectionKeyRow (
  ctx: EngineContext,
  seeded: SeededElection,
  publisher: TestKeyholder,
  jointPublicKey: string,
  overrides: { threshold?: number, participants?: number, attempt?: number, publishedAt?: string, publisherUserId?: string, publisherKey?: string, groupCommitments?: string } = {}
): Promise<void> {
  const electionId = seeded.electionId
  const revision = 0
  const attempt = overrides.attempt ?? 1
  const threshold = overrides.threshold ?? 2
  const participants = overrides.participants ?? 3
  const publishedAt = overrides.publishedAt ?? (nowCanonicalDatetime() + 'Z')
  const publisherUserId = overrides.publisherUserId ?? publisher.userId
  const publisherKey = overrides.publisherKey ?? publisher.publicHex
  const groupCommitments = overrides.groupCommitments ?? JSON.stringify([jointPublicKey, randomTestKeyPair().publicHex])

  const digestRow = await ctx.db
    .prepare("select Digest('ElectionKey', :electionId, :revision, :attempt, :jointPublicKey, :groupCommitments, :threshold, :participants, :publishedAt, :publisherUserId) as d")
    .get({ electionId, revision, attempt, jointPublicKey, groupCommitments, threshold, participants, publishedAt, publisherUserId })
  if (!digestRow || digestRow.d == null) throw new Error('insertElectionKeyRow: Digest() returned null')
  const signature = signWith(publisher.privateHex, digestToBytes(digestRow.d as string))

  await ctx.db.exec(
    `insert into ElectionKey (ElectionId, ElectionRevision, Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId, PublisherKey, Signature)
     values (:electionId, :revision, :attempt, :jointPublicKey, :groupCommitments, :threshold, :participants, :publishedAt, :publisherUserId, :publisherKey, :signature)`,
    { electionId, revision, attempt, jointPublicKey, groupCommitments, threshold, participants, publishedAt, publisherUserId, publisherKey, signature }
  )
}

describe('ElectionKey (D-13, D-16) — schema proofs', () => {
  it('after all three keyholders\' Round-4 messages agree on Y, a key with Participants=3/Threshold=2 inserts and reads back', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 3)
    const jointKey = randomTestKeyPair().publicHex
    for (const kh of keyholders) {
      await insertDkgMessage(seeded.auth.ctx, seeded, kh, { dkgRound: 4, resultKey: jointKey })
    }
    await insertElectionKeyRow(seeded.auth.ctx, seeded, keyholders[0]!, jointKey)
    const row = await seeded.auth.ctx.db.prepare('select JointPublicKey from ElectionKey where ElectionId = :id').get({ id: seeded.electionId })
    expect(row!.JointPublicKey).to.equal(jointKey)
  })

  it('with only two of three Round-4 rows, throws AllKeyholdersAgree', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 3)
    const jointKey = randomTestKeyPair().publicHex
    await insertDkgMessage(seeded.auth.ctx, seeded, keyholders[0]!, { dkgRound: 4, resultKey: jointKey })
    await insertDkgMessage(seeded.auth.ctx, seeded, keyholders[1]!, { dkgRound: 4, resultKey: jointKey })
    await expectRejected(insertElectionKeyRow(seeded.auth.ctx, seeded, keyholders[0]!, jointKey), 'AllKeyholdersAgree')
  })

  it('an ORPHANED dissenting Round-4 row (sender later revoked, raw DELETE — T-62-02-13) throws NoDissent even though AllKeyholdersAgree is satisfied by the 3 CURRENT participants', async () => {
    // Seed 4 keyholders. The 4th submits a DISSENTING Round-4 message, then is revoked via a raw
    // DELETE (Keyholder carries no `check on delete` yet — pre-existing, T-62-02-13). The 3
    // REMAINING keyholders then all agree on `jointKey`. ParticipantsAreKeyholders and
    // AllKeyholdersAgree both resolve against the CURRENT (3-member) Keyholder set and are
    // satisfied — isolating NoDissent, which inspects EVERY Round-4 row for the attempt
    // regardless of current Keyholder membership, as the only failing CHECK. This is exactly the
    // 62-17 consequence `<interfaces>` records: a disqualified dealer's message still blocks
    // publication until it is gone.
    const { seeded, keyholders } = await seedKeyholders(2, 4)
    const jointKey = randomTestKeyPair().publicHex
    const dissentKey = randomTestKeyPair().publicHex
    const dissenter = keyholders[3]!
    await insertDkgMessage(seeded.auth.ctx, seeded, dissenter, { dkgRound: 4, resultKey: dissentKey })
    // Only Keyholder can be deleted (pre-existing gap, T-62-02-13) -- KeyholderDkgBinding and
    // KeyholderDkgMessage are BOTH insert-only (NoDelete), so the dissenter's binding and message
    // rows stay behind as orphans exactly as the 62-17 consequence note describes.
    await seeded.auth.ctx.db.exec('delete from Keyholder where UserId = :id', { id: dissenter.userId })

    await insertDkgMessage(seeded.auth.ctx, seeded, keyholders[0]!, { dkgRound: 4, resultKey: jointKey })
    await insertDkgMessage(seeded.auth.ctx, seeded, keyholders[1]!, { dkgRound: 4, resultKey: jointKey })
    await insertDkgMessage(seeded.auth.ctx, seeded, keyholders[2]!, { dkgRound: 4, resultKey: jointKey })

    const participants = (await seeded.auth.ctx.db.prepare('select count(*) as c from Keyholder where ElectionId = :id').get({ id: seeded.electionId }))!.c as number
    expect(participants, 'the current Keyholder set is back down to 3 after the raw revoke').to.equal(3)

    await expectRejected(insertElectionKeyRow(seeded.auth.ctx, seeded, keyholders[0]!, jointKey, { participants: 3 }), 'NoDissent')
  })

  it('Threshold 1 throws ThresholdBounds (D-16: k=1 lets one keyholder decrypt alone)', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 3)
    const jointKey = randomTestKeyPair().publicHex
    for (const kh of keyholders) await insertDkgMessage(seeded.auth.ctx, seeded, kh, { dkgRound: 4, resultKey: jointKey })
    await expectRejected(insertElectionKeyRow(seeded.auth.ctx, seeded, keyholders[0]!, jointKey, { threshold: 1 }), 'ThresholdBounds')
  })

  it('Threshold 3 when the revision says 2 throws ThresholdMatchesRevision', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 3)
    const jointKey = randomTestKeyPair().publicHex
    for (const kh of keyholders) await insertDkgMessage(seeded.auth.ctx, seeded, kh, { dkgRound: 4, resultKey: jointKey })
    await expectRejected(insertElectionKeyRow(seeded.auth.ctx, seeded, keyholders[0]!, jointKey, { threshold: 3 }), 'ThresholdMatchesRevision')
  })

  it('Participants 2 (not the real Keyholder count of 3) throws ParticipantsAreKeyholders', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 3)
    const jointKey = randomTestKeyPair().publicHex
    for (const kh of keyholders) await insertDkgMessage(seeded.auth.ctx, seeded, kh, { dkgRound: 4, resultKey: jointKey })
    await expectRejected(insertElectionKeyRow(seeded.auth.ctx, seeded, keyholders[0]!, jointKey, { participants: 2 }), 'ParticipantsAreKeyholders')
  })

  it('a publisher with NO Round-4 row (not a participant) throws PublisherIsParticipant', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 3)
    const jointKey = randomTestKeyPair().publicHex
    for (const kh of keyholders) await insertDkgMessage(seeded.auth.ctx, seeded, kh, { dkgRound: 4, resultKey: jointKey })
    const { privateHex, publicHex } = randomTestKeyPair()
    const outsider: TestKeyholder = { userId: crypto.randomUUID(), publicHex, privateHex, slotCid: keyholders[0]!.slotCid }
    await expectRejected(insertElectionKeyRow(seeded.auth.ctx, seeded, outsider, jointKey), 'PublisherIsParticipant')
  })

  it('Round-4 rows only under Attempt 1, a key claiming Attempt 2 throws AllKeyholdersAgree', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 3)
    const jointKey = randomTestKeyPair().publicHex
    for (const kh of keyholders) await insertDkgMessage(seeded.auth.ctx, seeded, kh, { dkgRound: 4, resultKey: jointKey, attempt: 1 })
    await expectRejected(insertElectionKeyRow(seeded.auth.ctx, seeded, keyholders[0]!, jointKey, { attempt: 2 }), 'AllKeyholdersAgree')
  })

  it('a second ElectionKey for the same revision throws (write-once primary key)', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 3)
    const jointKey = randomTestKeyPair().publicHex
    for (const kh of keyholders) await insertDkgMessage(seeded.auth.ctx, seeded, kh, { dkgRound: 4, resultKey: jointKey })
    await insertElectionKeyRow(seeded.auth.ctx, seeded, keyholders[0]!, jointKey)
    await expectRejected(insertElectionKeyRow(seeded.auth.ctx, seeded, keyholders[0]!, jointKey), '')
  })

  it('UPDATE and DELETE both throw', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 3)
    const jointKey = randomTestKeyPair().publicHex
    for (const kh of keyholders) await insertDkgMessage(seeded.auth.ctx, seeded, kh, { dkgRound: 4, resultKey: jointKey })
    await insertElectionKeyRow(seeded.auth.ctx, seeded, keyholders[0]!, jointKey)
    let updateErr: unknown, deleteErr: unknown
    try { await seeded.auth.ctx.db.exec("update ElectionKey set Threshold = 2 where ElectionId = :id", { id: seeded.electionId }) } catch (e) { updateErr = e }
    try { await seeded.auth.ctx.db.exec('delete from ElectionKey where ElectionId = :id', { id: seeded.electionId }) } catch (e) { deleteErr = e }
    expect(updateErr).to.be.instanceOf(ConstraintError)
    expect(deleteErr).to.be.instanceOf(ConstraintError)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// KeyholderShareRelease (D-13, D-17)
// ═══════════════════════════════════════════════════════════════════════════

async function insertShareRelease (
  ctx: EngineContext,
  seeded: SeededElection,
  kh: TestKeyholder,
  overrides: { identifier?: string, signingShare?: string, releasedAt?: string, userId?: string, signerKey?: string, signOverride?: (digestHex: string) => string } = {}
): Promise<void> {
  const electionId = seeded.electionId
  const revision = 0
  const userId = overrides.userId ?? kh.userId
  const identifier = overrides.identifier ?? 'd'.repeat(64)
  const signingShare = overrides.signingShare ?? 'e'.repeat(64)
  const releasedAt = overrides.releasedAt ?? (nowCanonicalDatetime() + 'Z')
  const signerKey = overrides.signerKey ?? kh.publicHex

  const digestRow = await ctx.db
    .prepare("select Digest('KeyholderShareRelease', :electionId, :revision, :userId, :identifier, :signingShare, :releasedAt) as d")
    .get({ electionId, revision, userId, identifier, signingShare, releasedAt })
  if (!digestRow || digestRow.d == null) throw new Error('insertShareRelease: Digest() returned null')
  const signature = overrides.signOverride ? overrides.signOverride(digestRow.d as string) : signWith(kh.privateHex, digestToBytes(digestRow.d as string))

  await ctx.db.exec(
    `insert into KeyholderShareRelease (ElectionId, ElectionRevision, UserId, Identifier, SigningShare, ReleasedAt, SignerKey, Signature)
     values (:electionId, :revision, :userId, :identifier, :signingShare, :releasedAt, :signerKey, :signature)`,
    { electionId, revision, userId, identifier, signingShare, releasedAt, signerKey, signature }
  )
}

describe('KeyholderShareRelease (D-13, D-17) — schema proofs', () => {
  async function seedWithPublishedKey (): Promise<{ seeded: SeededElection, keyholders: TestKeyholder[], jointKey: string }> {
    const { seeded, keyholders } = await seedKeyholders(2, 3)
    const jointKey = randomTestKeyPair().publicHex
    for (const kh of keyholders) await insertDkgMessage(seeded.auth.ctx, seeded, kh, { dkgRound: 4, resultKey: jointKey })
    await insertElectionKeyRow(seeded.auth.ctx, seeded, keyholders[0]!, jointKey)
    return { seeded, keyholders, jointKey }
  }

  it('after ElectionKey exists, a participant\'s signed release (64-char Identifier/SigningShare) inserts', async () => {
    const { seeded, keyholders } = await seedWithPublishedKey()
    await insertShareRelease(seeded.auth.ctx, seeded, keyholders[0]!)
    const count = (await seeded.auth.ctx.db.prepare('select count(*) as c from KeyholderShareRelease').get())!.c as number
    expect(count).to.equal(1)
  })

  it('a release BEFORE any ElectionKey throws ReleaserParticipated', async () => {
    const { seeded, keyholders } = await seedKeyholders(2, 3)
    await expectRejected(insertShareRelease(seeded.auth.ctx, seeded, keyholders[0]!), 'ReleaserParticipated')
  })

  it('a release by a user with NO agreeing Round-4 row throws ReleaserParticipated', async () => {
    const { seeded, keyholders } = await seedWithPublishedKey()
    const { privateHex, publicHex } = randomTestKeyPair()
    const outsider: TestKeyholder = { userId: crypto.randomUUID(), publicHex, privateHex, slotCid: keyholders[0]!.slotCid }
    await expectRejected(insertShareRelease(seeded.auth.ctx, seeded, outsider), 'ReleaserParticipated')
  })

  it('a 66-char SigningShare throws SigningShareFormat', async () => {
    const { seeded, keyholders } = await seedWithPublishedKey()
    await expectRejected(insertShareRelease(seeded.auth.ctx, seeded, keyholders[0]!, { signingShare: '02'.repeat(33) }), 'SigningShareFormat')
  })

  it('a release signed by ANOTHER user\'s key throws SignerIsUser', async () => {
    const { seeded, keyholders } = await seedWithPublishedKey()
    await expectRejected(
      insertShareRelease(seeded.auth.ctx, seeded, keyholders[0]!, {
        signerKey: keyholders[1]!.publicHex,
        signOverride: (digestHex) => signWith(keyholders[1]!.privateHex, digestToBytes(digestHex))
      }),
      'SignerIsUser'
    )
  })

  it('a second release by the SAME user throws (primary key)', async () => {
    const { seeded, keyholders } = await seedWithPublishedKey()
    await insertShareRelease(seeded.auth.ctx, seeded, keyholders[0]!)
    await expectRejected(insertShareRelease(seeded.auth.ctx, seeded, keyholders[0]!), '')
  })

  it('UPDATE and DELETE both throw', async () => {
    const { seeded, keyholders } = await seedWithPublishedKey()
    await insertShareRelease(seeded.auth.ctx, seeded, keyholders[0]!)
    let updateErr: unknown, deleteErr: unknown
    try { await seeded.auth.ctx.db.exec('update KeyholderShareRelease set SigningShare = :share where UserId = :id', { share: 'f'.repeat(64), id: keyholders[0]!.userId }) } catch (e) { updateErr = e }
    try { await seeded.auth.ctx.db.exec('delete from KeyholderShareRelease where UserId = :id', { id: keyholders[0]!.userId }) } catch (e) { deleteErr = e }
    expect(updateErr).to.be.instanceOf(ConstraintError)
    expect(deleteErr).to.be.instanceOf(ConstraintError)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// No private-key-shaped column anywhere in the four tables (D-16)
// ═══════════════════════════════════════════════════════════════════════════

describe('D-16: no column in the four keyholder tables can hold a full private key', () => {
  it('none of KeyholderDkgBinding/KeyholderDkgMessage/ElectionKey/KeyholderShareRelease declares a column matching /Private|Secret|Scalar/i', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const qsqlPath = path.resolve(import.meta.dirname, '../../vote-core/schema/votetorrent.qsql')
    const qsql = fs.readFileSync(qsqlPath, 'utf8')
    const tables = ['KeyholderDkgBinding', 'KeyholderDkgMessage', 'ElectionKey', 'KeyholderShareRelease']
    for (const table of tables) {
      const startIdx = qsql.indexOf(`table ${table} (`)
      expect(startIdx, `table ${table} must exist in the qsql`).to.be.greaterThan(-1)
      const endIdx = qsql.indexOf('\n\t);', startIdx)
      const body = qsql.slice(startIdx, endIdx)
      expect(/\b\w*(Private|Secret|Scalar)\w*\s+text/i.test(body), `table ${table} must not declare a Private/Secret/Scalar column`).to.equal(false)
    }
  })
})
