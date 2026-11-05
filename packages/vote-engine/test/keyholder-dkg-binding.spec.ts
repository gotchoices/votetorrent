/**
 * keyholder-dkg-binding.spec.ts — 62-02 Task 2 (+ Task 3's D-26 lockstep describe block).
 *
 * Schema-level proof of `KeyholderDkgBinding` (D-26): a keyholder-signed binding carrying the
 * keyholder's DKG public material, checked entirely in the schema. Every case here writes the
 * Keyholder+binding pair in ONE transaction (surviving Task 3's `Keyholder.InsertValid` flip,
 * per `keyholder-schema-probes.spec.ts` Probe 1's proven shape) — the shared helpers below mint a
 * real, signed accept through the same raw-SQL shape Probe 1 proved COMMITs.
 *
 * Task 3 appends a second top-level `describe` exercising `InvitationEngine.respondToInvite`'s
 * atomic lockstep accept (D-21 provisioning) — see the bottom of this file.
 */

import { expect } from 'chai'
import { ConstraintError } from '@quereus/quereus'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { KeyholderInvite, Signature } from '@votetorrent/vote-core'
import { ElectionsEngine, peekNextElectionTid } from '../src/elections/elections-engine.js'
import { InvitationEngine } from '../src/invite/invitation-engine.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { digestToBytes, nowCanonicalDatetime, toCanonicalDatetime } from '../src/utils.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  makeTestSignCallback,
  makeElectionInit,
  signTestDigest,
} from './fixtures/test-context.js'
import { makeKeyholderProvisioning } from './fixtures/keyholder-provisioning.js'
import type { EngineContext } from '../src/types.js'
import { inviteeContext, invitePrivateForSlot, mintInviteKeyPair } from './fixtures/invite-keys.js'

// ---------------------------------------------------------------------------
// Shared helpers (duplicated, not shared with keyholder-dkg-schema.spec.ts, per plan)
// ---------------------------------------------------------------------------

function makeKeyholderInvite (name: string, overrides?: Partial<KeyholderInvite>): KeyholderInvite {
  return {
    name,
    type: 'k',
    expiration: new Date(Date.now() + 3_600_000).toISOString(),
    inviteKey: mintInviteKeyPair().inviteKey,
    inviteSignature: '',
    ...overrides,
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

/** Create an election whose ElectionRevision.KeyholderThreshold = `threshold` (default 1). */
async function seedElectionWithThreshold (threshold = 1): Promise<SeededElection> {
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
  curve: 'secp256k1' | 'p256'
}

/**
 * Invite + mint InviteResult/User/UserKey for a fresh keyholder identity. Deliberately mints NO
 * Keyholder row and NO binding — 62-02 Task 3 flips `Keyholder.InsertValid` to require a binding
 * in the SAME transaction (Probe 1's proven shape), so every test below inserts the Keyholder +
 * KeyholderDkgBinding pair together via `insertKeyholderAndBinding`.
 */
async function inviteAndMintKeyholder (
  seeded: SeededElection,
  name: string,
  opts: { curve?: 'secp256k1' | 'p256' } = {}
): Promise<TestKeyholder> {
  const curve = opts.curve ?? 'secp256k1'
  await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite(name), seeded.electionId, makeTestSignCallback(seeded.auth.user))
  const slot = await keyholderSlotCid(seeded.auth.ctx, name)
  const userId = crypto.randomUUID()
  let privateHex: string, publicHex: string
  if (curve === 'p256') {
    const priv = p256.utils.randomSecretKey()
    privateHex = bytesToHex(priv)
    publicHex = bytesToHex(p256.getPublicKey(priv))
  } else {
    const pair = randomTestKeyPair()
    privateHex = pair.privateHex
    publicHex = pair.publicHex
  }
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
       values (:userId, :keyType, :pubKey, :expiration)`,
      { userId, keyType: curve === 'p256' ? 'P' : 'M', pubKey: publicHex, expiration: toCanonicalDatetime(Date.now() + 365 * 86_400_000), now: nowCanonicalDatetime() }
    )
    await ctx.db.exec('COMMIT')
  } catch (err) {
    await ctx.db.exec('ROLLBACK')
    throw err
  }
  return { userId, publicHex, privateHex, slotCid: slot.cid, curve }
}

interface BindingOverrides {
  electionId?: string
  revision?: number
  userId?: string
  inviteSlotCid?: string
  dkgPublicKey?: string
  boundAt?: string
  signerKey?: string
  signOverride?: (digestHex: string) => string
  /** Omit the Keyholder insert from the transaction (tests KeyholderExists). */
  skipKeyholder?: boolean
  /** Omit the KeyholderDkgBinding insert from the transaction (tests Keyholder's own InsertValid). */
  skipBinding?: boolean
}

function signWithCurve (curve: 'secp256k1' | 'p256', privateHex: string, digest: Uint8Array): string {
  if (curve === 'p256') return bytesToHex(p256.sign(digest, hexToBytes(privateHex)))
  return bytesToHex(secp256k1.sign(digest, hexToBytes(privateHex)))
}

/**
 * Insert the Keyholder + KeyholderDkgBinding pair in ONE transaction (62-02 Task 3: D-26's proven
 * shape, keyholder-schema-probes.spec.ts Probe 1). The binding digest is computed in SQL and
 * self-signed with `kh`'s own key unless overridden. `skipKeyholder`/`skipBinding` isolate each
 * half's own CHECKs.
 */
async function insertKeyholderAndBinding (ctx: EngineContext, seeded: SeededElection, kh: TestKeyholder, overrides: BindingOverrides = {}): Promise<void> {
  const electionId = overrides.electionId ?? seeded.electionId
  const revision = overrides.revision ?? 0
  const userId = overrides.userId ?? kh.userId
  const inviteSlotCid = overrides.inviteSlotCid ?? kh.slotCid
  const dkgPublicKey = overrides.dkgPublicKey ?? randomTestKeyPair().publicHex
  const boundAt = overrides.boundAt ?? (nowCanonicalDatetime() + 'Z')
  const signerKey = overrides.signerKey ?? kh.publicHex
  const tid = await allocateTid(ctx.db, 'user')

  await ctx.db.exec('BEGIN')
  try {
    if (!overrides.skipKeyholder) {
      await ctx.db.exec(
        `insert into Keyholder (ElectionId, ElectionRevision, UserId)
         with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
         values (:electionId, :revision, :userId)`,
        { electionId, revision, userId: kh.userId }
      )
    }
    if (!overrides.skipBinding) {
      const digestRow = await ctx.db
        .prepare("select Digest('KeyholderDkgBinding', :electionId, :revision, :userId, :inviteSlotCid, :dkgPublicKey, :boundAt) as d")
        .get({ electionId, revision, userId, inviteSlotCid, dkgPublicKey, boundAt })
      if (!digestRow || digestRow.d == null) throw new Error('insertKeyholderAndBinding: Digest() returned null')
      const digestHex = digestRow.d as string
      const signature = overrides.signOverride
        ? overrides.signOverride(digestHex)
        : signWithCurve(kh.curve, kh.privateHex, digestToBytes(digestHex))

      await ctx.db.exec(
        `insert into KeyholderDkgBinding (ElectionId, ElectionRevision, UserId, InviteSlotCid, DkgPublicKey, BoundAt, SignerKey, Signature)
         values (:electionId, :revision, :userId, :inviteSlotCid, :dkgPublicKey, :boundAt, :signerKey, :signature)`,
        { electionId, revision, userId, inviteSlotCid, dkgPublicKey, boundAt, signerKey, signature }
      )
    }
    await ctx.db.exec('COMMIT')
  } catch (err) {
    await ctx.db.exec('ROLLBACK')
    throw err
  }
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

async function bindingCount (ctx: EngineContext, electionId: string, revision: number, userId: string): Promise<number> {
  const row = await ctx.db
    .prepare('select count(*) as c from KeyholderDkgBinding where ElectionId = :electionId and ElectionRevision = :revision and UserId = :userId')
    .get({ electionId, revision, userId })
  return Number(row?.c ?? 0)
}

// ═══════════════════════════════════════════════════════════════════════════
// Task 2: schema-level KeyholderDkgBinding proofs
// ═══════════════════════════════════════════════════════════════════════════

describe('KeyholderDkgBinding (D-26) — schema proofs', () => {
  it('a binding signed (secp256k1) by the keyholder user\'s own UserKey inserts and reads back', async () => {
    const seeded = await seedElectionWithThreshold()
    const kh = await inviteAndMintKeyholder(seeded, 'Alice Keyholder')
    await insertKeyholderAndBinding(seeded.auth.ctx, seeded, kh)
    expect(await bindingCount(seeded.auth.ctx, seeded.electionId, 0, kh.userId)).to.equal(1)
  })

  it('a P-256 (Type \'P\') self-signed binding also inserts', async () => {
    const seeded = await seedElectionWithThreshold()
    const kh = await inviteAndMintKeyholder(seeded, 'Bob Keyholder', { curve: 'p256' })
    await insertKeyholderAndBinding(seeded.auth.ctx, seeded, kh)
    expect(await bindingCount(seeded.auth.ctx, seeded.electionId, 0, kh.userId)).to.equal(1)
  })

  it('a signature over a DIFFERENT digest throws (SignatureValid)', async () => {
    const seeded = await seedElectionWithThreshold()
    const kh = await inviteAndMintKeyholder(seeded, 'Carol Keyholder')
    await expectRejected(
      insertKeyholderAndBinding(seeded.auth.ctx, seeded, kh, { signOverride: () => signWithCurve(kh.curve, kh.privateHex, digestToBytes((nowCanonicalDatetime() + 'Z').repeat(1) && 'a'.repeat(43))) }),
      'SignatureValid'
    )
  })

  it('SignerKey belonging to the INVITING OFFICER (not the keyholder) throws SignerIsUser', async () => {
    const seeded = await seedElectionWithThreshold()
    const kh = await inviteAndMintKeyholder(seeded, 'Dave Keyholder')
    const officerKey = seeded.auth.user.activeKeys[0]!.key
    await expectRejected(
      // The signature must itself be VALID (really signed by the officer's own registered key) so
      // SignatureValid does not fire first — the only thing wrong is that the officer's key is not
      // registered to the KEYHOLDER's UserId.
      insertKeyholderAndBinding(seeded.auth.ctx, seeded, kh, {
        signerKey: officerKey,
        signOverride: (digestHex) => signTestDigest(seeded.auth.user, digestHex).signature
      }),
      'SignerIsUser'
    )
  })

  it('a DkgPublicKey of 64 chars throws DkgPublicKeyFormat', async () => {
    const seeded = await seedElectionWithThreshold()
    const kh = await inviteAndMintKeyholder(seeded, 'Eve Keyholder')
    await expectRejected(insertKeyholderAndBinding(seeded.auth.ctx, seeded, kh, { dkgPublicKey: '02'.repeat(32) }), 'DkgPublicKeyFormat')
  })

  it('a DkgPublicKey starting \'04\' (uncompressed) throws DkgPublicKeyFormat', async () => {
    const seeded = await seedElectionWithThreshold()
    const kh = await inviteAndMintKeyholder(seeded, 'Frank Keyholder')
    await expectRejected(insertKeyholderAndBinding(seeded.auth.ctx, seeded, kh, { dkgPublicKey: '04' + 'a'.repeat(64) }), 'DkgPublicKeyFormat')
  })

  it('a non-Z BoundAt throws BoundAtValid', async () => {
    const seeded = await seedElectionWithThreshold()
    const kh = await inviteAndMintKeyholder(seeded, 'Grace Keyholder')
    await expectRejected(insertKeyholderAndBinding(seeded.auth.ctx, seeded, kh, { boundAt: nowCanonicalDatetime() }), 'BoundAtValid')
  })

  it('an InviteSlotCid naming a Type \'of\' slot (not \'k\') throws InviteAccepted', async () => {
    const seeded = await seedElectionWithThreshold()
    const kh = await inviteAndMintKeyholder(seeded, 'Henry Keyholder')
    // Create a real officer InviteSlot to use as the WRONG-type anchor.
    await seeded.auth.ctx.db.exec(
      `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce, ElectionId)
       with context Tid = 999999, now = :now, IsSignatureValid = true, IsInsertValid = true
       values (cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)), :type, :name, :expiration, :inviteKey, :inviteSignature, :nonce, null)`,
      { expiration: new Date(Date.now() + 3_600_000).toISOString(), inviteKey: 'b'.repeat(66), inviteSignature: '', name: 'wrong-type-slot', nonce: crypto.randomUUID(), type: 'of', now: nowCanonicalDatetime() }
    )
    const ofSlot = await seeded.auth.ctx.db.prepare("select Cid from InviteSlot where Name = 'wrong-type-slot'").get()
    await expectRejected(insertKeyholderAndBinding(seeded.auth.ctx, seeded, kh, { inviteSlotCid: ofSlot!.Cid as string }), 'InviteAccepted')
  })

  it('a slot for a DIFFERENT election throws InviteAccepted', async () => {
    const seededA = await seedElectionWithThreshold()
    const khA = await inviteAndMintKeyholder(seededA, 'Irene Keyholder')
    const seededB = await seedElectionWithThreshold()
    const khB = await inviteAndMintKeyholder(seededB, 'Irene Keyholder')
    // Use khB's own slot (a different election) as the InviteSlotCid for khA's binding attempt.
    await expectRejected(
      insertKeyholderAndBinding(seededA.auth.ctx, seededA, khA, { inviteSlotCid: khB.slotCid }),
      'InviteAccepted'
    )
  })

  it('a DECLINED InviteResult throws InviteAccepted', async () => {
    const seeded = await seedElectionWithThreshold()
    await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite('Jack Keyholder'), seeded.electionId, makeTestSignCallback(seeded.auth.user))
    const slot = await keyholderSlotCid(seeded.auth.ctx, 'Jack Keyholder')
    const invitationEngine = new InvitationEngine(inviteeContext(seeded.auth.ctx))
    await invitationEngine.respondToInvite(slot.cid, false, await invitePrivateForSlot(seeded.auth.ctx, slot.cid))
    const { publicHex, privateHex } = randomTestKeyPair()
    const fakeKh: TestKeyholder = { userId: crypto.randomUUID(), publicHex, privateHex, slotCid: slot.cid, curve: 'secp256k1' }
    // No Keyholder/UserKey exist for fakeKh; expect InviteAccepted to fire first regardless.
    await expectRejected(insertKeyholderAndBinding(seeded.auth.ctx, seeded, fakeKh, { skipKeyholder: true }), 'InviteAccepted')
  })

  it('InvokedId of ANOTHER user (not this binding\'s UserId) throws InviteAccepted', async () => {
    const seeded = await seedElectionWithThreshold()
    const khA = await inviteAndMintKeyholder(seeded, 'Kyle Keyholder')
    const khB = await inviteAndMintKeyholder(seeded, 'Laura Keyholder')
    // Bind khA's slot (InvokedId = khA.userId) but claim it is khB's binding.
    await expectRejected(insertKeyholderAndBinding(seeded.auth.ctx, seeded, khB, { inviteSlotCid: khA.slotCid }), 'InviteAccepted')
  })

  it('a binding whose Keyholder row is ABSENT is refused (live KeyholderExists)', async () => {
    const seeded = await seedElectionWithThreshold()
    const kh = await inviteAndMintKeyholder(seeded, 'Mallory Keyholder')
    await expectRejected(insertKeyholderAndBinding(seeded.auth.ctx, seeded, kh, { skipKeyholder: true }), 'KeyholderExists')
  })

  it('(Task 3) a Keyholder insert WITHOUT a binding in the same transaction throws InsertValid and leaves no row', async () => {
    const seeded = await seedElectionWithThreshold()
    const kh = await inviteAndMintKeyholder(seeded, 'Quentin Keyholder')
    await expectRejected(insertKeyholderAndBinding(seeded.auth.ctx, seeded, kh, { skipBinding: true }), 'InsertValid')
    const row = await seeded.auth.ctx.db.prepare('select UserId from Keyholder where UserId = :id').get({ id: kh.userId })
    expect(row, 'no Keyholder row survives the rolled-back transaction').to.be.undefined
  })

  it('(Task 3) Keyholder + binding pair commits; the pre-existing null-context requirement still holds (Keyholder with SigningNonce bound throws)', async () => {
    const seeded = await seedElectionWithThreshold()
    const kh = await inviteAndMintKeyholder(seeded, 'Romeo Keyholder')
    let caught: unknown
    try {
      await seeded.auth.ctx.db.exec('BEGIN')
      await seeded.auth.ctx.db.exec(
        `insert into Keyholder (ElectionId, ElectionRevision, UserId)
         with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = 1
         values (:electionId, 0, :userId)`,
        { electionId: seeded.electionId, userId: kh.userId, nonce: 'not-null-nonce' }
      )
      await seeded.auth.ctx.db.exec('COMMIT')
    } catch (err) {
      caught = err
      await seeded.auth.ctx.db.exec('ROLLBACK')
    }
    expect(caught, 'a bound SigningNonce must still reject, binding or no binding').to.not.equal(undefined)
    expect((caught as Error).message).to.include('InsertValid')
  })

  it('a second binding for the same (ElectionId, ElectionRevision, UserId) throws (primary key)', async () => {
    const seeded = await seedElectionWithThreshold()
    const kh = await inviteAndMintKeyholder(seeded, 'Nina Keyholder')
    await insertKeyholderAndBinding(seeded.auth.ctx, seeded, kh)
    await expectRejected(insertKeyholderAndBinding(seeded.auth.ctx, seeded, kh, { skipKeyholder: true }), '')
    expect(await bindingCount(seeded.auth.ctx, seeded.electionId, 0, kh.userId)).to.equal(1)
  })

  it('UPDATE throws NoUpdate', async () => {
    const seeded = await seedElectionWithThreshold()
    const kh = await inviteAndMintKeyholder(seeded, 'Oscar Keyholder')
    await insertKeyholderAndBinding(seeded.auth.ctx, seeded, kh)
    let caught: unknown
    try {
      await seeded.auth.ctx.db.exec(
        "update KeyholderDkgBinding set BoundAt = :boundAt where UserId = :userId",
        { boundAt: nowCanonicalDatetime() + 'Z', userId: kh.userId }
      )
    } catch (err) {
      caught = err
    }
    expect(caught, 'UPDATE must throw NoUpdate').to.not.equal(undefined)
    expect(caught).to.be.instanceOf(ConstraintError)
  })

  it('DELETE throws NoDelete', async () => {
    const seeded = await seedElectionWithThreshold()
    const kh = await inviteAndMintKeyholder(seeded, 'Peggy Keyholder')
    await insertKeyholderAndBinding(seeded.auth.ctx, seeded, kh)
    let caught: unknown
    try {
      await seeded.auth.ctx.db.exec('delete from KeyholderDkgBinding where UserId = :userId', { userId: kh.userId })
    } catch (err) {
      caught = err
    }
    expect(caught, 'DELETE must throw NoDelete').to.not.equal(undefined)
    expect(caught).to.be.instanceOf(ConstraintError)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Task 3: D-26 lockstep — InvitationEngine.respondToInvite's atomic keyholder accept
// ═══════════════════════════════════════════════════════════════════════════

describe('D-26 lockstep: respondToInvite (Task 3)', () => {
  it('a keyholder accept WITH provisioning writes exactly one InviteResult/User/UserKey/Keyholder/KeyholderDkgBinding', async () => {
    const seeded = await seedElectionWithThreshold()
    await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite('Quinn Keyholder'), seeded.electionId, makeTestSignCallback(seeded.auth.user))
    const slot = await keyholderSlotCid(seeded.auth.ctx, 'Quinn Keyholder')
    const provisioning = makeKeyholderProvisioning()
    const invitationEngine = new InvitationEngine(inviteeContext(seeded.auth.ctx))
    await invitationEngine.respondToInvite(slot.cid, true, await invitePrivateForSlot(seeded.auth.ctx, slot.cid), undefined, undefined, provisioning)

    const irRow = await seeded.auth.ctx.db.prepare('select InvokedId from InviteResult where SlotCid = :cid').get({ cid: slot.cid })
    const userId = irRow!.InvokedId as string
    expect(userId, 'the minted user id must differ from the inviting officer').to.not.equal(seeded.auth.user.id)

    const userCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from User where Id = :id').get({ id: userId }))!.c as number
    const keyCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from UserKey where UserId = :id').get({ id: userId }))!.c as number
    const khCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from Keyholder where UserId = :id').get({ id: userId }))!.c as number
    const bindingRow = await seeded.auth.ctx.db.prepare('select DkgPublicKey, SignerKey from KeyholderDkgBinding where UserId = :id').get({ id: userId })
    expect(userCount).to.equal(1)
    expect(keyCount).to.equal(1)
    expect(khCount).to.equal(1)
    expect(bindingRow, 'exactly one binding row').to.not.be.undefined
    expect(bindingRow!.DkgPublicKey).to.equal(provisioning.dkgPublicKey)
    expect(bindingRow!.SignerKey).to.equal(provisioning.signingKey.key)
    expect(provisioning.signingKey.key, 'the provisioned signing key must differ from every officer UserKey (D-21)').to.not.equal(seeded.auth.user.activeKeys[0]!.key)
  })

  it('a keyholder accept WITHOUT provisioning rejects (mentions "keyholder signing key") and writes nothing', async () => {
    const seeded = await seedElectionWithThreshold()
    await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite('Randy Keyholder'), seeded.electionId, makeTestSignCallback(seeded.auth.user))
    const slot = await keyholderSlotCid(seeded.auth.ctx, 'Randy Keyholder')
    const invitationEngine = new InvitationEngine(inviteeContext(seeded.auth.ctx))
    let caught: unknown
    try {
      await invitationEngine.respondToInvite(slot.cid, true, await invitePrivateForSlot(seeded.auth.ctx, slot.cid))
    } catch (err) {
      caught = err
    }
    expect((caught as Error)?.message, 'must mention keyholder signing key').to.include('keyholder signing key')
    const irCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from InviteResult where SlotCid = :cid').get({ cid: slot.cid }))!.c as number
    expect(irCount, 'no InviteResult row written').to.equal(0)
  })

  it('provisioning whose sign() returns a signerKey DIFFERENT from signingKey.key rejects and writes nothing', async () => {
    const seeded = await seedElectionWithThreshold()
    await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite('Steve Keyholder'), seeded.electionId, makeTestSignCallback(seeded.auth.user))
    const slot = await keyholderSlotCid(seeded.auth.ctx, 'Steve Keyholder')
    const provisioning = makeKeyholderProvisioning()
    const tampered = { ...provisioning, sign: async (digest: Uint8Array): Promise<Signature> => {
      const real = await provisioning.sign(digest)
      return { ...real, signerKey: randomTestKeyPair().publicHex }
    } }
    const invitationEngine = new InvitationEngine(inviteeContext(seeded.auth.ctx))
    // WR-R2-03: the fixture lookup runs OUTSIDE the try, so its own failure is never counted as the refusal.
    const invitePrivate = await invitePrivateForSlot(seeded.auth.ctx, slot.cid)
    let caught: unknown
    try {
      await invitationEngine.respondToInvite(slot.cid, true, invitePrivate, undefined, undefined, tampered)
    } catch (err) {
      caught = err
    }
    expect(caught, 'a signerKey mismatch must reject').to.not.equal(undefined)
    expect(String((caught as Error)?.message), 'refused by the signerKey check, not by an earlier refusal').to.match(/does not match keyholder\.signingKey\.key/)
    const irCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from InviteResult where SlotCid = :cid').get({ cid: slot.cid }))!.c as number
    expect(irCount, 'no InviteResult row written').to.equal(0)
  })

  it('a malformed dkgPublicKey (64 chars) rejects before any write', async () => {
    const seeded = await seedElectionWithThreshold()
    await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite('Tina Keyholder'), seeded.electionId, makeTestSignCallback(seeded.auth.user))
    const slot = await keyholderSlotCid(seeded.auth.ctx, 'Tina Keyholder')
    const provisioning = { ...makeKeyholderProvisioning(), dkgPublicKey: '02'.repeat(32) }
    const invitationEngine = new InvitationEngine(inviteeContext(seeded.auth.ctx))
    const invitePrivate = await invitePrivateForSlot(seeded.auth.ctx, slot.cid)
    let caught: unknown
    try {
      await invitationEngine.respondToInvite(slot.cid, true, invitePrivate, undefined, undefined, provisioning)
    } catch (err) {
      caught = err
    }
    expect(caught, 'a malformed dkgPublicKey must reject').to.not.equal(undefined)
    expect(String((caught as Error)?.message), 'refused by the dkgPublicKey format check').to.match(/dkgPublicKey must be a 66-char/)
    const irCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from InviteResult where SlotCid = :cid').get({ cid: slot.cid }))!.c as number
    expect(irCount, 'no InviteResult row written').to.equal(0)
  })

  it('atomicity: an accept whose User insert fails (invokedId = officer id, PK collision) leaves ZERO InviteResult rows and no Keyholder row for the officer', async () => {
    const seeded = await seedElectionWithThreshold()
    await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite('Uma Keyholder'), seeded.electionId, makeTestSignCallback(seeded.auth.user))
    const slot = await keyholderSlotCid(seeded.auth.ctx, 'Uma Keyholder')
    const provisioning = makeKeyholderProvisioning()
    const invitationEngine = new InvitationEngine(inviteeContext(seeded.auth.ctx))
    const invitePrivate = await invitePrivateForSlot(seeded.auth.ctx, slot.cid)
    let caught: unknown
    try {
      await invitationEngine.respondToInvite(slot.cid, true, invitePrivate, undefined, seeded.auth.user.id, provisioning)
    } catch (err) {
      caught = err
    }
    expect(caught, 'reusing the officer id as invokedId must reject').to.not.equal(undefined)
    // The refusal must come from the User insert INSIDE the transaction (after the InviteResult
    // insert), or this test does not exercise atomicity at all.
    expect(String((caught as Error)?.message), 'refused by the User primary key inside the transaction').to.match(/UNIQUE constraint failed: User PK/)
    const irCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from InviteResult where SlotCid = :cid').get({ cid: slot.cid }))!.c as number
    expect(irCount, 'the old non-atomic orphan is gone -- zero InviteResult rows for this slot').to.equal(0)
    const khCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from Keyholder where UserId = :id').get({ id: seeded.auth.user.id }))!.c as number
    expect(khCount, 'no Keyholder row for the officer').to.equal(0)
  })

  it('decline is unchanged (no provisioning argument, no transaction change)', async () => {
    const seeded = await seedElectionWithThreshold()
    await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite('Victor Keyholder'), seeded.electionId, makeTestSignCallback(seeded.auth.user))
    const slot = await keyholderSlotCid(seeded.auth.ctx, 'Victor Keyholder')
    const invitationEngine = new InvitationEngine(inviteeContext(seeded.auth.ctx))
    await invitationEngine.respondToInvite(slot.cid, false, await invitePrivateForSlot(seeded.auth.ctx, slot.cid))
    const irRow = await seeded.auth.ctx.db.prepare('select IsAccepted from InviteResult where SlotCid = :cid').get({ cid: slot.cid })
    expect(irRow, 'a decline still writes InviteResult').to.not.be.undefined
  })

  it('a second accept of the same slot is refused invite-already-answered (live-head check, before any write) and writes nothing new', async () => {
    const seeded = await seedElectionWithThreshold()
    await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite('Wendy Keyholder'), seeded.electionId, makeTestSignCallback(seeded.auth.user))
    const slot = await keyholderSlotCid(seeded.auth.ctx, 'Wendy Keyholder')
    const invitationEngine = new InvitationEngine(inviteeContext(seeded.auth.ctx))
    await invitationEngine.respondToInvite(slot.cid, true, await invitePrivateForSlot(seeded.auth.ctx, slot.cid), undefined, undefined, makeKeyholderProvisioning())
    const countBefore = (await seeded.auth.ctx.db.prepare('select count(*) as c from User').get())!.c as number
    const invitePrivate = await invitePrivateForSlot(seeded.auth.ctx, slot.cid)
    let caught: unknown
    try {
      await invitationEngine.respondToInvite(slot.cid, true, invitePrivate, undefined, undefined, makeKeyholderProvisioning())
    } catch (err) {
      caught = err
    }
    expect(caught, 'a second accept of the same slot must reject').to.not.equal(undefined)
    // Since 62-102 the live-head check refuses before any write; the InviteResult PK is never reached.
    expect((caught as { code?: unknown })?.code, 'refused as already answered').to.equal('invite-already-answered')
    const countAfter = (await seeded.auth.ctx.db.prepare('select count(*) as c from User').get())!.c as number
    expect(countAfter, 'no new User row from the rejected second accept').to.equal(countBefore)
  })
})
