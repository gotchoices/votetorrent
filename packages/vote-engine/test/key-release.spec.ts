/**
 * key-release.spec.ts (62-20, Task 2)
 *
 * Scenarios A-M: pull-and-seed task creation (D-20), signed share
 * publication (D-17), k-of-n public reconstruction (D-14) and D-18 block
 * decryption, all over one real Quereus DB on top of 62-17's 3-of-5 DKG
 * (`seedDkgElection` + `runDkgToQuiescence`).
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { NetworkReference } from '@votetorrent/vote-core'
import type { EngineContext } from '../src/types.js'
import { KeysTasksEngine } from '../src/tasks/keys-tasks-engine.js'
import { KeyReleaseEngine, KeyReleaseError, releaseKeyTaskId } from '../src/key-release/key-release-engine.js'
import { releasingKeysAt } from '../src/key-release/release-window.js'
import { encryptElectionBlock } from '../src/key-release/election-block.js'
import { InMemoryTestKeyVault, KeyVaultError, keyholderDkgShareAlias } from '../src/crypto/vault.js'
import { digestToBytes } from '../src/utils.js'
import { bumpElectionRevision } from './fixtures/test-context.js'
import {
  inviteAndAcceptKeyholder,
  runDkgToQuiescence,
  seedDkgElection,
  type DkgTestParticipant
} from './fixtures/dkg-keyholders.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeNetworkRef (): NetworkReference {
  return {
    hash: 'h'.repeat(16),
    name: 'Test Network',
    relays: ['/dns4/relay.example.com/tcp/443/wss'],
    primaryAuthorityDomainName: 'authority.example.com'
  }
}

/** A bare device-local EngineContext — no `user`, so KeysTasksEngine/KeyReleaseEngine rely entirely on the vault for local-keyholder detection (own-device-only, D-20). */
function deviceCtx (db: Database): EngineContext {
  return { db }
}

async function releaseWindow (db: Database, electionId: string): Promise<number> {
  const row = await db.prepare('select Timeline from ElectionRevision where ElectionId = :electionId').get({ electionId })
  if (!row) throw new Error('releaseWindow: no ElectionRevision')
  const timeline = JSON.parse(row.Timeline as string) as Record<string, number>
  const at = releasingKeysAt(timeline)
  if (at === null) throw new Error('releaseWindow: releasingKeys not set on this fixture')
  return at
}

async function countReleaseTasks (db: Database): Promise<number> {
  const row = await db.prepare("select count(*) as c from Task where Type = 'release-key'").get({})
  return (row?.c as number | undefined) ?? 0
}

async function countReleases (db: Database, electionId: string): Promise<number> {
  const row = await db.prepare('select count(*) as c from KeyholderShareRelease where ElectionId = :electionId').get({ electionId })
  return (row?.c as number | undefined) ?? 0
}

/** Raw-handle injection of a SIGNED but potentially bogus release row — used only to simulate misbehavior (scenario G). */
async function postSignedRelease (db: Database, participant: DkgTestParticipant, params: {
  electionId: string, revision: number, identifier: string, signingShare: string, releasedAt: string
}): Promise<void> {
  const { electionId, revision, identifier, signingShare, releasedAt } = params
  const digestRow = await db
    .prepare("select Digest('KeyholderShareRelease', :electionId, :revision, :userId, :identifier, :signingShare, :releasedAt) as d")
    .get({ electionId, revision, userId: participant.userId, identifier, signingShare, releasedAt })
  if (!digestRow || digestRow.d == null) throw new Error('postSignedRelease: Digest() returned null')
  const signature = await participant.signer.sign(digestToBytes(digestRow.d as string))
  await db.exec(
    `insert into KeyholderShareRelease (ElectionId, ElectionRevision, UserId, Identifier, SigningShare, ReleasedAt, SignerKey, Signature)
     values (:electionId, :revision, :userId, :identifier, :signingShare, :releasedAt, :signerKey, :signature)`,
    { electionId, revision, userId: participant.userId, identifier, signingShare, releasedAt, signerKey: signature.signerKey, signature: signature.signature }
  )
}

function expectNoHexLeak (message: string): void {
  expect(/[0-9a-f]{64}/i.test(message), `message leaked a 64-hex run: ${message}`).to.equal(false)
}

async function expectThrows (fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error('expectThrows: function did not throw')
}

// ---------------------------------------------------------------------------
// A — seeding timing and ownership (D-20)
// ---------------------------------------------------------------------------

describe('key-release: A — seeding timing and ownership (D-20)', function () {
  this.timeout(180000)

  let elec: Awaited<ReturnType<typeof seedDkgElection>>
  let at: number

  before(async function () {
    this.timeout(180000)
    elec = await seedDkgElection({ keyholders: ['kh-a1', 'kh-a2', 'kh-a3', 'kh-a4', 'kh-a5'], threshold: 3 })
    await runDkgToQuiescence(elec.participants, elec.electionId)
    at = await releaseWindow(elec.auth.ctx.db, elec.electionId)
  })

  it('A: after accept and a complete DKG, no release-key Task exists yet', async () => {
    expect(await countReleaseTasks(elec.auth.ctx.db)).to.equal(0)
  })

  it('A: every participant reading before the window opens seeds nothing', async () => {
    const db = elec.auth.ctx.db
    for (const p of elec.participants) {
      const engine = new KeysTasksEngine(makeNetworkRef(), deviceCtx(db), { vault: p.vault, now: () => at - 1 })
      expect(await engine.getKeysToRelease(true)).to.deep.equal([])
    }
    expect(await countReleaseTasks(db)).to.equal(0)
  })

  it('A: at the window, one participant seeds exactly one own-device task with the deterministic Id', async () => {
    const db = elec.auth.ctx.db
    const p1 = elec.participants[0]!
    const engine = new KeysTasksEngine(makeNetworkRef(), deviceCtx(db), { vault: p1.vault, now: () => at })
    const tasks = await engine.getKeysToRelease(true)
    expect(tasks).to.have.length(1)
    expect(tasks[0]!.userId).to.equal(p1.userId)
    expect(tasks[0]!.election.current.revision).to.equal(elec.revision)
    const expectedId = releaseKeyTaskId(elec.electionId, elec.revision, p1.userId)
    const row = await db.prepare('select Id from Task where UserId = :userId').get({ userId: p1.userId })
    expect(row!.Id).to.equal(expectedId)
    expect(await countReleaseTasks(db)).to.equal(1)
  })

  it('A: after all five read, the count is 5 — own device only, never all 5 from one read', async () => {
    const db = elec.auth.ctx.db
    for (const p of elec.participants.slice(1)) {
      const engine = new KeysTasksEngine(makeNetworkRef(), deviceCtx(db), { vault: p.vault, now: () => at })
      await engine.getKeysToRelease(true)
    }
    expect(await countReleaseTasks(db)).to.equal(5)
  })

  it('A: idempotent under repeated and concurrent reads; seeding never prompts (authPromptCount delta 0)', async () => {
    const db = elec.auth.ctx.db
    for (const p of elec.participants) {
      const before = p.vault.authPromptCount
      const engine = new KeysTasksEngine(makeNetworkRef(), deviceCtx(db), { vault: p.vault, now: () => at })
      await engine.getKeysToRelease(true)
      await engine.getKeysToRelease(true)
      await engine.getKeysToRelease(true)
      await Promise.all([engine.getKeysToRelease(true), engine.getKeysToRelease(true)])
      expect(p.vault.authPromptCount - before).to.equal(0)
    }
    expect(await countReleaseTasks(db)).to.equal(5)
  })
})

// ---------------------------------------------------------------------------
// B — no ElectionKey means no task (D-20)
// ---------------------------------------------------------------------------

describe('key-release: B — no ElectionKey means no task', function () {
  this.timeout(180000)

  it('B: DKG stopped before publication seeds no task; status reports no-election-key', async function () {
    this.timeout(180000)
    const elec = await seedDkgElection({ keyholders: ['kh-b1', 'kh-b2', 'kh-b3', 'kh-b4', 'kh-b5'], threshold: 3 })
    // Hold one participant out entirely — the round-0 boundary (every live
    // member's row) can never be reached, so the DKG stalls with no
    // ElectionKey ever published, and runDkgToQuiescence returns cleanly
    // once a full pass makes no progress.
    await runDkgToQuiescence(elec.participants, elec.electionId, { skip: [elec.participants[4]!.userId] })

    const ekRow = await elec.auth.ctx.db.prepare('select 1 as x from ElectionKey where ElectionId = :id').get({ id: elec.electionId })
    expect(ekRow).to.equal(undefined)

    const at = await releaseWindow(elec.auth.ctx.db, elec.electionId)
    const p1 = elec.participants[0]!
    const tasksEngine = new KeysTasksEngine(makeNetworkRef(), deviceCtx(elec.auth.ctx.db), { vault: p1.vault, now: () => at + 1 })
    expect(await tasksEngine.getKeysToRelease(true)).to.deep.equal([])

    const releaseEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db), { vault: p1.vault, now: () => at + 1 })
    const status = await releaseEngine.getKeyReleaseStatus(elec.electionId)
    expect(status.phase).to.equal('no-election-key')
  })
})

// ---------------------------------------------------------------------------
// C, D, E, F — release, k-of-n reconstruction, anyone reconstructs, blocks
// ---------------------------------------------------------------------------

describe('key-release: C/D/E/F — release, k-of-n, anyone reconstructs, block decryption', function () {
  this.timeout(180000)

  let elec: Awaited<ReturnType<typeof seedDkgElection>>
  let at: number
  let ciphertext: unknown

  const payload = {
    v: 1 as const,
    votes: [{ ballot: 'b1', choice: 1 }, { ballot: 'b2', choice: 2 }],
    voterRecords: [{ registrantId: 'r-1' }, { registrantId: 'r-2' }]
  }

  before(async function () {
    this.timeout(180000)
    elec = await seedDkgElection({ keyholders: ['kh-c1', 'kh-c2', 'kh-c3', 'kh-c4', 'kh-c5'], threshold: 3 })
    await runDkgToQuiescence(elec.participants, elec.electionId)
    at = await releaseWindow(elec.auth.ctx.db, elec.electionId)

    // F prerequisite: encrypt a block under Y BEFORE any release exists.
    const ekRow = await elec.auth.ctx.db
      .prepare('select JointPublicKey from ElectionKey where ElectionId = :id').get({ id: elec.electionId })
    const electionKeyForBlock = { electionId: elec.electionId, revision: elec.revision, jointPublicKey: ekRow!.JointPublicKey as string }
    ciphertext = encryptElectionBlock(electionKeyForBlock, 'block-1', payload)
  })

  function engineFor (p: DkgTestParticipant): KeysTasksEngine {
    return new KeysTasksEngine(makeNetworkRef(), deviceCtx(elec.auth.ctx.db), { vault: p.vault, now: () => at })
  }

  it('C: completing a release task publishes exactly one commitment-checked signed share, and marks the Task complete', async () => {
    const p1 = elec.participants[0]!
    const engine = engineFor(p1)
    const [task] = await engine.getKeysToRelease(true)
    expect(task).to.not.equal(undefined)
    await engine.completeKeyRelease(task!, p1.signer)

    const row = await elec.auth.ctx.db
      .prepare('select Identifier, SigningShare from KeyholderShareRelease where ElectionId = :id and UserId = :userId')
      .get({ id: elec.electionId, userId: p1.userId })
    expect(row).to.not.equal(undefined)

    const releaseEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db))
    const shares = await releaseEngine.getReleasedShares(elec.electionId)
    const mine = shares.find((s) => s.userId === p1.userId)!
    expect(mine.identifier).to.equal(row!.Identifier)

    const taskRow = await elec.auth.ctx.db.prepare('select IsCompleted from Task where UserId = :userId').get({ userId: p1.userId })
    expect(taskRow!.IsCompleted).to.equal(1)
    expect(await engine.getKeysToRelease(true)).to.deep.equal([])
    const completed = await engine.getKeysToRelease(false)
    expect(completed).to.have.length(1)
  })

  it('C: a second completeKeyRelease writes no second row and reads no vault (authPromptCount unchanged)', async () => {
    const p1 = elec.participants[0]!
    const before = p1.vault.authPromptCount
    const engine = engineFor(p1)
    const [task] = await engine.getKeysToRelease(false)
    await engine.completeKeyRelease(task!, p1.signer)
    expect(await countReleases(elec.auth.ctx.db, elec.electionId)).to.equal(1)
    expect(p1.vault.authPromptCount - before).to.equal(0)
  })

  it('C: a later pending read does NOT re-seed the completed task', async () => {
    const p1 = elec.participants[0]!
    const engine = engineFor(p1)
    expect(await engine.getKeysToRelease(true)).to.deep.equal([])
    expect(await countReleaseTasks(elec.auth.ctx.db)).to.equal(1)
  })

  it('D: after 2 releases, status is releasing and reconstructElectionKey rejects insufficient-shares', async () => {
    const p2 = elec.participants[1]!
    const engine = engineFor(p2)
    const [task] = await engine.getKeysToRelease(true)
    await engine.completeKeyRelease(task!, p2.signer)
    expect(await countReleases(elec.auth.ctx.db, elec.electionId)).to.equal(2)

    const releaseEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db), { now: () => at })
    const status = await releaseEngine.getKeyReleaseStatus(elec.electionId)
    expect(status.phase).to.equal('releasing')
    expect(status.releasedCount).to.equal(2)

    const err = await expectThrows(() => releaseEngine.reconstructElectionKey(elec.electionId))
    expect(err).to.be.instanceOf(KeyReleaseError)
    expect((err as KeyReleaseError).code).to.equal('insufficient-shares')
  })

  it('F: with 2 releases, decryptElectionBlocks returns not-reconstructable', async () => {
    const releaseEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db))
    const results = await releaseEngine.decryptElectionBlocks(elec.electionId, [{ blockId: 'block-1', ciphertext }])
    expect(results).to.have.length(1)
    expect(results[0]!.ok).to.equal(false)
    if (!results[0]!.ok) expect(results[0]!.reason).to.equal('not-reconstructable')
  })

  it('D: after the 3rd release, status is reconstructable and the reconstructed key\'s public point matches JointPublicKey', async () => {
    const p3 = elec.participants[2]!
    const engine = engineFor(p3)
    const [task] = await engine.getKeysToRelease(true)
    await engine.completeKeyRelease(task!, p3.signer)

    const releaseEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db))
    const status = await releaseEngine.getKeyReleaseStatus(elec.electionId)
    expect(status.phase).to.equal('reconstructable')

    const reconstructed = await releaseEngine.reconstructElectionKey(elec.electionId)
    const derivedPub = bytesToHex(secp256k1.getPublicKey(reconstructed.secretKey, true))
    expect(derivedPub).to.equal(reconstructed.jointPublicKey)
  })

  it('E: anyone reconstructs — no user, no vault, same jointPublicKey and secretKey bytes', async () => {
    const anonymousEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db))
    const r1 = await anonymousEngine.reconstructElectionKey(elec.electionId)
    const r2 = await anonymousEngine.reconstructElectionKey(elec.electionId)
    expect(r1.jointPublicKey).to.equal(r2.jointPublicKey)
    expect(bytesToHex(r1.secretKey)).to.deep.equal(bytesToHex(r2.secretKey))
  })

  it('F: after 3 releases, decryptElectionBlocks returns ok:true with deep-equal votes and voterRecords', async () => {
    const releaseEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db))
    const results = await releaseEngine.decryptElectionBlocks(elec.electionId, [{ blockId: 'block-1', ciphertext }])
    expect(results[0]!.ok).to.equal(true)
    if (results[0]!.ok) {
      expect(results[0]!.payload).to.deep.equal(payload)
    }
  })

  it('F: the same ciphertext submitted as block-2 returns authentication-failed, while the other block in the same call still succeeds', async () => {
    const releaseEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db))
    const results = await releaseEngine.decryptElectionBlocks(elec.electionId, [
      { blockId: 'block-2', ciphertext },
      { blockId: 'block-1', ciphertext }
    ])
    expect(results[0]!.ok).to.equal(false)
    if (!results[0]!.ok) expect(results[0]!.reason).to.equal('authentication-failed')
    expect(results[1]!.ok).to.equal(true)
  })

  it('D: with all 5 released, reconstruction still uses exactly k=3 (usedUserIds length 3)', async () => {
    for (const p of [elec.participants[3]!, elec.participants[4]!]) {
      const engine = engineFor(p)
      const [task] = await engine.getKeysToRelease(true)
      await engine.completeKeyRelease(task!, p.signer)
    }
    expect(await countReleases(elec.auth.ctx.db, elec.electionId)).to.equal(5)

    const releaseEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db))
    const reconstructed = await releaseEngine.reconstructElectionKey(elec.electionId)
    expect(reconstructed.usedUserIds).to.have.length(3)
  })

  it('D: a second, fresh election releasing participants 3, 4 and 5 also reconstructs (any k-subset)', async function () {
    this.timeout(180000)
    const elec2 = await seedDkgElection({ keyholders: ['kh-d1', 'kh-d2', 'kh-d3', 'kh-d4', 'kh-d5'], threshold: 3 })
    await runDkgToQuiescence(elec2.participants, elec2.electionId)
    const at2 = await releaseWindow(elec2.auth.ctx.db, elec2.electionId)
    for (const p of [elec2.participants[2]!, elec2.participants[3]!, elec2.participants[4]!]) {
      const engine = new KeysTasksEngine(makeNetworkRef(), deviceCtx(elec2.auth.ctx.db), { vault: p.vault, now: () => at2 })
      const [task] = await engine.getKeysToRelease(true)
      await engine.completeKeyRelease(task!, p.signer)
    }
    const releaseEngine = new KeyReleaseEngine(deviceCtx(elec2.auth.ctx.db))
    const reconstructed = await releaseEngine.reconstructElectionKey(elec2.electionId)
    const derivedPub = bytesToHex(secp256k1.getPublicKey(reconstructed.secretKey, true))
    expect(derivedPub).to.equal(reconstructed.jointPublicKey)
  })
})

// ---------------------------------------------------------------------------
// G — bogus shares are filtered (D-17)
// ---------------------------------------------------------------------------

describe('key-release: G — bogus shares are filtered', function () {
  this.timeout(180000)

  let elec: Awaited<ReturnType<typeof seedDkgElection>>
  let at: number

  before(async function () {
    this.timeout(180000)
    elec = await seedDkgElection({ keyholders: ['kh-g1', 'kh-g2', 'kh-g3', 'kh-g4', 'kh-g5'], threshold: 3 })
    await runDkgToQuiescence(elec.participants, elec.electionId)
    at = await releaseWindow(elec.auth.ctx.db, elec.electionId)
  })

  async function honestRelease (p: DkgTestParticipant): Promise<void> {
    const engine = new KeysTasksEngine(makeNetworkRef(), deviceCtx(elec.auth.ctx.db), { vault: p.vault, now: () => at })
    const [task] = await engine.getKeysToRelease(true)
    await engine.completeKeyRelease(task!, p.signer)
  }

  it('G: a raw-inserted bogus share (a different valid scalar) is listed as share-invalid and not counted', async () => {
    const x = elec.participants[4]!
    const identifierRow = await elec.auth.ctx.db
      .prepare('select Identifier from KeyholderDkgMessage where ElectionId = :id and SenderUserId = :userId and DkgRound = 4')
      .get({ id: elec.electionId, userId: x.userId })
      .catch(() => undefined)
    // Identifier for X is deterministic (dkgIdentifierForUser); pull it from a sibling's
    // already-accepted release structure instead of recomputing — simplest is to read
    // from the DKG's own ElectionKey.GroupCommitments/Round-4 result is not directly the
    // identifier, so reuse the release-engine's own X-free status after one honest release
    // to read what X's expected identifier format looks like is unnecessary: validateReleasedShare
    // only needs ANY syntactically valid identifier/share pair that is wrong for X.
    const ekRow = await elec.auth.ctx.db.prepare('select GroupCommitments from ElectionKey where ElectionId = :id').get({ id: elec.electionId })
    const groupCommitments = JSON.parse(ekRow!.GroupCommitments as string) as string[]
    const bogusIdentifier = groupCommitments[0]!.slice(2) // 64-hex, syntactically valid, NOT x's real identifier
    const bogusShare = '07'.repeat(32)
    await postSignedRelease(elec.auth.ctx.db, x, {
      electionId: elec.electionId, revision: elec.revision, identifier: bogusIdentifier, signingShare: bogusShare, releasedAt: new Date().toISOString()
    })

    const releaseEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db))
    const status = await releaseEngine.getKeyReleaseStatus(elec.electionId)
    const rejection = status.rejectedReleases.find((r) => r.userId === x.userId)
    expect(rejection).to.not.equal(undefined)
    expect(status.releasedUserIds).to.not.include(x.userId)
  })

  it('G: 2 honest releases plus the bogus X row still gives insufficient-shares', async () => {
    await honestRelease(elec.participants[0]!)
    await honestRelease(elec.participants[1]!)
    const releaseEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db))
    const err = await expectThrows(() => releaseEngine.reconstructElectionKey(elec.electionId))
    expect((err as KeyReleaseError).code).to.equal('insufficient-shares')
  })

  it('G: 3 honest releases plus the bogus X row reconstructs, with X rejected and excluded from usedUserIds', async () => {
    await honestRelease(elec.participants[2]!)
    const releaseEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db))
    const reconstructed = await releaseEngine.reconstructElectionKey(elec.electionId)
    expect(reconstructed.usedUserIds).to.not.include(elec.participants[4]!.userId)
    expect(reconstructed.rejectedReleases.map((r) => r.userId)).to.include(elec.participants[4]!.userId)
  })
})

// ---------------------------------------------------------------------------
// H, I — early release refused, signer checks
// ---------------------------------------------------------------------------

describe('key-release: H/I — early release refused and signer checks', function () {
  this.timeout(180000)

  let elec: Awaited<ReturnType<typeof seedDkgElection>>
  let at: number

  before(async function () {
    this.timeout(180000)
    elec = await seedDkgElection({ keyholders: ['kh-h1', 'kh-h2', 'kh-h3', 'kh-h4', 'kh-h5'], threshold: 3 })
    await runDkgToQuiescence(elec.participants, elec.electionId)
    at = await releaseWindow(elec.auth.ctx.db, elec.electionId)
  })

  it('H: releaseKeyShare before the window rejects release-window-not-open, writes no row, and reads no vault', async () => {
    const p1 = elec.participants[0]!
    const before = p1.vault.authPromptCount
    const engine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db), { vault: p1.vault, now: () => at - 1 })
    const err = await expectThrows(() => engine.releaseKeyShare(elec.electionId, p1.signer))
    expect(err).to.be.instanceOf(KeyReleaseError)
    expect((err as KeyReleaseError).code).to.equal('release-window-not-open')
    expect(await countReleases(elec.auth.ctx.db, elec.electionId)).to.equal(0)
    expect(p1.vault.authPromptCount - before).to.equal(0)
  })

  it('I: a signer whose userId is not an R4 participant gives not-a-participant', async function () {
    this.timeout(60000)
    const outsider = await inviteAndAcceptKeyholder(elec.auth, elec.electionEngine, elec.electionId, 'kh-h-outsider')
    const engine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db), { vault: outsider.vault, now: () => at })
    const err = await expectThrows(() => engine.releaseKeyShare(elec.electionId, outsider.signer))
    expect((err as KeyReleaseError).code).to.equal('not-a-participant')
    expect(await countReleases(elec.auth.ctx.db, elec.electionId)).to.equal(0)
  })

  it('I: a signingPublicKey that is not a UserKey of the userId gives signer-key-mismatch', async () => {
    const p2 = elec.participants[1]!
    const badSigner = { ...p2.signer, signingPublicKey: '02' + '11'.repeat(32) }
    const engine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db), { vault: p2.vault, now: () => at })
    const err = await expectThrows(() => engine.releaseKeyShare(elec.electionId, badSigner))
    expect((err as KeyReleaseError).code).to.equal('signer-key-mismatch')
    expect(await countReleases(elec.auth.ctx.db, elec.electionId)).to.equal(0)
  })

  it('I: a sign() returning another key gives signature-mismatch', async () => {
    const p3 = elec.participants[2]!
    const badSigner = { ...p3.signer, sign: async (digest: Uint8Array) => ({ ...(await p3.signer.sign(digest)), signerKey: '03' + '22'.repeat(32) }) }
    const engine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db), { vault: p3.vault, now: () => at })
    const err = await expectThrows(() => engine.releaseKeyShare(elec.electionId, badSigner))
    expect((err as KeyReleaseError).code).to.equal('signature-mismatch')
    expect(await countReleases(elec.auth.ctx.db, elec.electionId)).to.equal(0)
  })
})

// ---------------------------------------------------------------------------
// J — fail-closed completion
// ---------------------------------------------------------------------------

describe('key-release: J — fail-closed completion', function () {
  this.timeout(180000)

  let elec: Awaited<ReturnType<typeof seedDkgElection>>
  let at: number

  before(async function () {
    this.timeout(180000)
    elec = await seedDkgElection({ keyholders: ['kh-j1', 'kh-j2', 'kh-j3', 'kh-j4', 'kh-j5'], threshold: 3 })
    await runDkgToQuiescence(elec.participants, elec.electionId)
    at = await releaseWindow(elec.auth.ctx.db, elec.electionId)
  })

  it('J: completeKeyRelease(task) with no signer rejects signer-required; the Task stays IsCompleted 0 and no row exists', async () => {
    const p1 = elec.participants[0]!
    const engine = new KeysTasksEngine(makeNetworkRef(), deviceCtx(elec.auth.ctx.db), { vault: p1.vault, now: () => at })
    const [task] = await engine.getKeysToRelease(true)
    const err = await expectThrows(() => engine.completeKeyRelease(task!))
    expect(err).to.be.instanceOf(KeyReleaseError)
    expect((err as KeyReleaseError).code).to.equal('signer-required')
    const taskRow = await elec.auth.ctx.db.prepare('select IsCompleted from Task where UserId = :userId').get({ userId: p1.userId })
    expect(taskRow!.IsCompleted).to.equal(0)
    expect(await countReleases(elec.auth.ctx.db, elec.electionId)).to.equal(0)
  })

  it('J: a signer for a different keyholder rejects signer-task-mismatch', async () => {
    const p1 = elec.participants[0]!
    const p2 = elec.participants[1]!
    const engine = new KeysTasksEngine(makeNetworkRef(), deviceCtx(elec.auth.ctx.db), { vault: p1.vault, now: () => at })
    const [task] = await engine.getKeysToRelease(true)
    const err = await expectThrows(() => engine.completeKeyRelease(task!, p2.signer))
    expect((err as KeyReleaseError).code).to.equal('signer-task-mismatch')
    expect(await countReleases(elec.auth.ctx.db, elec.electionId)).to.equal(0)
  })
})

// ---------------------------------------------------------------------------
// K — vault failures
// ---------------------------------------------------------------------------

describe('key-release: K — vault failures', function () {
  this.timeout(180000)

  let elec: Awaited<ReturnType<typeof seedDkgElection>>
  let at: number

  before(async function () {
    this.timeout(180000)
    elec = await seedDkgElection({ keyholders: ['kh-k1', 'kh-k2', 'kh-k3', 'kh-k4', 'kh-k5'], threshold: 3 })
    await runDkgToQuiescence(elec.participants, elec.electionId)
    at = await releaseWindow(elec.auth.ctx.db, elec.electionId)
  })

  it('K: a vault that denies authorization rejects KeyVaultError auth-denied, writes no row, leaves the Task incomplete', async () => {
    const p1 = elec.participants[0]!
    const denyingVault = new InMemoryTestKeyVault({ authorize: () => false })
    const alias = keyholderDkgShareAlias(elec.electionId, elec.revision, p1.userId)
    const realBytes = await p1.vault.getSecret(alias)
    await denyingVault.putSecret(alias, realBytes!, { requireUserAuth: true })

    const engine = new KeysTasksEngine(makeNetworkRef(), deviceCtx(elec.auth.ctx.db), { vault: denyingVault, now: () => at })
    const [task] = await engine.getKeysToRelease(true)
    const err = await expectThrows(() => engine.completeKeyRelease(task!, p1.signer))
    expect(err).to.be.instanceOf(KeyVaultError)
    expect((err as KeyVaultError).code).to.equal('auth-denied')
    const taskRow = await elec.auth.ctx.db.prepare('select IsCompleted from Task where UserId = :userId').get({ userId: p1.userId })
    expect(taskRow!.IsCompleted).to.equal(0)
    expect(await countReleases(elec.auth.ctx.db, elec.electionId)).to.equal(0)
  })

  it('K: a missing share (deleted from the vault) rejects share-missing', async () => {
    const p2 = elec.participants[1]!
    const alias = keyholderDkgShareAlias(elec.electionId, elec.revision, p2.userId)
    await p2.vault.deleteSecret(alias)
    const engine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db), { vault: p2.vault, now: () => at })
    const err = await expectThrows(() => engine.releaseKeyShare(elec.electionId, p2.signer))
    expect((err as KeyReleaseError).code).to.equal('share-missing')
  })

  it('K: a KeyReleaseEngine with no vault configured rejects vault-unavailable', async () => {
    const p3 = elec.participants[2]!
    const engine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db), { now: () => at })
    const err = await expectThrows(() => engine.releaseKeyShare(elec.electionId, p3.signer))
    expect((err as KeyReleaseError).code).to.equal('vault-unavailable')
  })

  // ---------------------------------------------------------------------------
  // L — no secret in any error message from D, G, H, I, J, K
  // ---------------------------------------------------------------------------

  it('L: no KeyReleaseError/KeyVaultError message from any refusal path contains a 64-hex run', async () => {
    const p4 = elec.participants[3]!
    const messages: string[] = []

    const noVaultEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db), { now: () => at })
    messages.push(((await expectThrows(() => noVaultEngine.releaseKeyShare(elec.electionId, p4.signer))) as Error).message)

    const earlyEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db), { vault: p4.vault, now: () => at - 1 })
    messages.push(((await expectThrows(() => earlyEngine.releaseKeyShare(elec.electionId, p4.signer))) as Error).message)

    const outsiderSigner = { ...p4.signer, userId: 'not-a-real-participant' }
    const outsiderEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db), { vault: p4.vault, now: () => at })
    messages.push(((await expectThrows(() => outsiderEngine.releaseKeyShare(elec.electionId, outsiderSigner))) as Error).message)

    const reconstructEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db))
    messages.push(((await expectThrows(() => reconstructEngine.reconstructElectionKey(elec.electionId))) as Error).message)

    for (const message of messages) expectNoHexLeak(message)
  })
})

// ---------------------------------------------------------------------------
// M — revision pin
// ---------------------------------------------------------------------------

describe('key-release: M — revision pin', function () {
  this.timeout(180000)

  it('M: after a revision bump, getKeyReleaseStatus reports the new revision with phase no-election-key, and the old task\'s completion rejects revision-not-current', async function () {
    this.timeout(180000)
    const elec = await seedDkgElection({ keyholders: ['kh-m1', 'kh-m2', 'kh-m3', 'kh-m4', 'kh-m5'], threshold: 3 })
    await runDkgToQuiescence(elec.participants, elec.electionId)
    const at = await releaseWindow(elec.auth.ctx.db, elec.electionId)

    const p1 = elec.participants[0]!
    const tasksEngine = new KeysTasksEngine(makeNetworkRef(), deviceCtx(elec.auth.ctx.db), { vault: p1.vault, now: () => at })
    const [oldTask] = await tasksEngine.getKeysToRelease(true)
    expect(oldTask).to.not.equal(undefined)

    const newRevision = await bumpElectionRevision({ ...elec.auth, electionsEngine: elec.electionsEngine, electionEngine: elec.electionEngine })
    expect(newRevision).to.equal(elec.revision + 1)

    const releaseEngine = new KeyReleaseEngine(deviceCtx(elec.auth.ctx.db))
    const status = await releaseEngine.getKeyReleaseStatus(elec.electionId)
    expect(status.revision).to.equal(newRevision)
    expect(status.phase).to.equal('no-election-key')

    const err = await expectThrows(() => tasksEngine.completeKeyRelease(oldTask!, p1.signer))
    expect(err).to.be.instanceOf(KeyReleaseError)
    expect((err as KeyReleaseError).code).to.equal('revision-not-current')
    expect(await countReleases(elec.auth.ctx.db, elec.electionId)).to.equal(0)
  })
})
