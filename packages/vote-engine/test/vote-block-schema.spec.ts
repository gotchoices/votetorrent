/**
 * vote-block-schema.spec.ts — the VoteBlock / VoteBlockVoter tables (votetorrent.qsql, "Vote blocks").
 *
 * Drives the raw schema, the way a block former will: one transaction inserts the block row and
 * every voter row. The election is real: a 2-of-3 keyholder DKG publishes ElectionKey, the
 * registrants and their P-256 device associations go through the real vrg ceremonies, and the
 * ciphertext comes from the shipped `encryptElectionBlock`. Each refusal names the CHECK it expects
 * and is paired with an accepted block that differs only in the attacked field.
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { ElectionBlockPayload, Signature } from '@votetorrent/vote-core'
import { encryptElectionBlock } from '../src/key-release/election-block.js'
import { seedRegistrantAssociation } from '../src/dev/seed-registrant-association.js'
import { nowCanonicalDatetime } from '../src/utils.js'
import { runDkgToQuiescence, seedDkgElection } from './fixtures/dkg-keyholders.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'
import { seedBallot, testKeyPairFor, type TestAuthorityContext, type TestElectionContext } from './fixtures/test-context.js'

interface Voter { registrantId: string, deviceKey: string, priv: Uint8Array }

interface BlockRow {
  cid: string
  id: string
  electionId: string
  electionRevision: number
  ballotId: string
  templateDigest: string
  entryCount: number
  voterRegistrantIds: string
  ciphertext: string
}

interface VoterRow {
  electionId: string
  ballotId: string
  registrantId: string
  blockCid: string
  blockId: string
  electionRevision: number
  deviceKey: string
  signature: string
}

const TEMPLATE_DIGEST = 'template-digest-placeholder'

/** secp256k1 sign callback for the authority officer (the vrg ceremonies). */
function officerSigner (userId: string): (digest: Uint8Array) => Promise<Signature> {
  const { privateHex, publicHex } = testKeyPairFor(userId)
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => ({
    signerUserId: userId,
    signerKey: publicHex,
    signature: bytesToHex(secp256k1.sign(digest, privBytes))
  })
}

async function scalar (db: Database, sql: string, params: Record<string, unknown>): Promise<string> {
  const row = await db.prepare(sql).get(params)
  const v = row?.v
  if (typeof v !== 'string') throw new Error(`scalar: ${sql} returned ${String(v)}`)
  return v
}

describe('VoteBlock / VoteBlockVoter schema', function () {
  this.timeout(180_000)

  let db: Database
  let electionId: string
  let revision: number
  let ballotId: string
  let jointPublicKey: string
  let votingStartsMs: number
  let accruingVotesMs: number
  let inWindowMs: number
  const voters: Voter[] = []
  let blockSeq = 0

  before(async function () {
    const elec = await seedDkgElection({ keyholders: ['vb-kh-1', 'vb-kh-2', 'vb-kh-3'], threshold: 2 })
    await runDkgToQuiescence(elec.participants, elec.electionId)
    const auth: TestAuthorityContext = elec.auth
    db = auth.ctx.db
    electionId = elec.electionId
    revision = elec.revision
    ;({ ballotId } = await seedBallot(auth as unknown as TestElectionContext, 'vb-ballot-1'))

    const keyRow = await db.prepare('select JointPublicKey from ElectionKey where ElectionId = :electionId and ElectionRevision = :revision')
      .get({ electionId, revision })
    if (!keyRow) throw new Error('before: no ElectionKey published')
    jointPublicKey = keyRow.JointPublicKey as string

    const timelineRow = await db.prepare('select Timeline from ElectionRevision where ElectionId = :electionId').get({ electionId })
    const timeline = JSON.parse(timelineRow!.Timeline as string) as Record<string, number>
    votingStartsMs = timeline.votingStarts!
    accruingVotesMs = timeline.accruingVotes!
    inWindowMs = votingStartsMs + 1

    const sign = officerSigner(auth.user.id)
    for (let i = 0; i < 6; i++) {
      const { privBytes, pubHex } = makeP256TestKey()
      const registrantId = `vb-registrant-${Date.now()}-${i}`
      await seedRegistrantAssociation(auth.ctx, auth.authority.id, { id: registrantId }, pubHex, sign)
      voters.push({ registrantId, deviceKey: pubHex, priv: privBytes })
    }
  })

  /** Encrypt a block for `members` and sign each member's participation. `tweak` edits rows before signing. */
  async function formBlock (
    members: Voter[],
    tweak: { block?: Partial<BlockRow>, voter?: (row: VoterRow, i: number) => Partial<VoterRow>, signer?: (i: number) => Uint8Array } = {}
  ): Promise<{ block: BlockRow, voterRows: VoterRow[] }> {
    blockSeq += 1
    const payload: ElectionBlockPayload = {
      v: 1,
      votes: members.map((_, i) => ({ v: 1, ballotId, answers: [{ questionCode: 'q1', optionCodes: ['a'] }], nonce: `${blockSeq}-${i}`.padStart(64, '0') })),
      voterRecords: members.map(m => ({ v: 1, registrantId: m.registrantId, deviceKey: m.deviceKey }))
    }
    const id = await scalar(db, "select Digest('VoteBlockRecords', :p) as v", { p: JSON.stringify(payload) })
    const ciphertext = JSON.stringify(encryptElectionBlock({ electionId, revision, jointPublicKey }, id, payload))
    const cid = await scalar(db, 'select cid(Digest(:ct)) as v', { ct: ciphertext })
    const block: BlockRow = {
      cid,
      id,
      electionId,
      electionRevision: revision,
      ballotId,
      templateDigest: TEMPLATE_DIGEST,
      entryCount: members.length,
      voterRegistrantIds: JSON.stringify(members.map(m => m.registrantId).sort()),
      ciphertext,
      ...tweak.block
    }
    const voterRows: VoterRow[] = []
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!
      const base: VoterRow = {
        electionId: block.electionId,
        ballotId: block.ballotId,
        registrantId: m.registrantId,
        blockCid: block.cid,
        blockId: block.id,
        electionRevision: block.electionRevision,
        deviceKey: m.deviceKey,
        signature: ''
      }
      const row = { ...base, ...tweak.voter?.(base, i) }
      const digest = await scalar(
        db,
        "select Digest('VoteBlockVoter', :e, :r, :b, :c, :i, :reg, :dk) as v",
        { e: row.electionId, r: row.electionRevision, b: row.ballotId, c: row.blockCid, i: row.blockId, reg: row.registrantId, dk: row.deviceKey }
      )
      row.signature = signDigestP256(digest, tweak.signer?.(i) ?? m.priv)
      voterRows.push(row)
    }
    return { block, voterRows }
  }

  /** The block former's write: one transaction, block row first, then every voter row. */
  async function commitBlock (block: BlockRow, voterRows: VoterRow[], nowMs: number = inWindowMs): Promise<void> {
    await db.exec('BEGIN')
    try {
      await db.exec(
        `insert into VoteBlock (Cid, Id, ElectionId, ElectionRevision, BallotId, TemplateDigest, EntryCount, VoterRegistrantIds, Ciphertext)
         with context NowMs = :nowMs
         values (:cid, :id, :electionId, :electionRevision, :ballotId, :templateDigest, :entryCount, :voterRegistrantIds, :ciphertext)`,
        { ...block, nowMs }
      )
      for (const v of voterRows) {
        await db.exec(
          `insert into VoteBlockVoter (ElectionId, BallotId, RegistrantId, BlockCid, BlockId, ElectionRevision, DeviceKey, Signature)
           with context now = :now
           values (:electionId, :ballotId, :registrantId, :blockCid, :blockId, :electionRevision, :deviceKey, :signature)`,
          { ...v, now: nowCanonicalDatetime() }
        )
      }
      await db.exec('COMMIT')
    } catch (err) {
      await db.exec('ROLLBACK')
      throw err
    }
  }

  async function expectRefused (p: Promise<unknown>, constraint: string): Promise<void> {
    let caught: unknown
    try { await p } catch (err) { caught = err }
    expect(caught, `expected a refusal naming ${constraint}`).to.be.instanceOf(Error)
    expect((caught as Error).message).to.include(constraint)
  }

  async function blockExists (cid: string): Promise<boolean> {
    return (await db.prepare('select 1 as x from VoteBlock where Cid = :cid').get({ cid })) !== undefined
  }

  async function votedIn (registrantId: string): Promise<string | undefined> {
    const row = await db.prepare('select BlockCid from VoteBlockVoter where ElectionId = :electionId and BallotId = :ballotId and RegistrantId = :registrantId')
      .get({ electionId, ballotId, registrantId })
    return row?.BlockCid as string | undefined
  }

  // Ordered: the accepted block claims voters[0..2]; refusal cases use voters[3..5], which stay
  // unvoted because every refused transaction rolls back.

  it('accepts a block whose voters all sign it, and records each voter against that block', async () => {
    const { block, voterRows } = await formBlock(voters.slice(0, 3))
    await commitBlock(block, voterRows)
    expect(await blockExists(block.cid)).to.equal(true)
    for (const v of voters.slice(0, 3)) expect(await votedIn(v.registrantId)).to.equal(block.cid)
  })

  it('refuses a second vote on the same ballot, and the whole block rolls back with it', async () => {
    const { block, voterRows } = await formBlock([voters[3]!, voters[0]!])
    await expectRefused(commitBlock(block, voterRows), 'UNIQUE')
    expect(await blockExists(block.cid)).to.equal(false)
    expect(await votedIn(voters[3]!.registrantId)).to.equal(undefined)
  })

  it('refuses a block that does not carry a voter row for every entry', async () => {
    const { block, voterRows } = await formBlock(voters.slice(3, 5))
    await expectRefused(commitBlock(block, voterRows.slice(0, 1)), 'VotersMatchEntries')
    expect(await blockExists(block.cid)).to.equal(false)
  })

  it('refuses a voter row signed by a key other than the associated device key', async () => {
    const other = makeP256TestKey()
    const { block, voterRows } = await formBlock(voters.slice(3, 5), { signer: i => (i === 1 ? other.privBytes : voters[3 + i]!.priv) })
    await expectRefused(commitBlock(block, voterRows), 'SignatureValid')
  })

  it('refuses a correctly signed voter row whose device key has no association', async () => {
    const stranger = makeP256TestKey()
    const { block, voterRows } = await formBlock(voters.slice(3, 5), {
      voter: (_row, i) => (i === 1 ? { deviceKey: stranger.pubHex } : {}),
      signer: i => (i === 1 ? stranger.privBytes : voters[3]!.priv)
    })
    await expectRefused(commitBlock(block, voterRows), 'VoterAssociated')
  })

  it('refuses a voter row that is not on the block\'s frozen voter list', async () => {
    const { block, voterRows } = await formBlock(voters.slice(3, 5), {
      block: { voterRegistrantIds: JSON.stringify([voters[3]!.registrantId, voters[5]!.registrantId].sort()) }
    })
    await expectRefused(commitBlock(block, voterRows), 'BlockMatches')
  })

  it('refuses a voter list whose length differs from the entry count', async () => {
    const { block, voterRows } = await formBlock(voters.slice(3, 5), { block: { voterRegistrantIds: JSON.stringify([voters[3]!.registrantId]) } })
    await expectRefused(commitBlock(block, voterRows), 'VoterListValid')
  })

  it('refuses a voter row whose BlockId differs from the block it names', async () => {
    const { block, voterRows } = await formBlock(voters.slice(3, 5), { voter: (_row, i) => (i === 0 ? { blockId: 'not-the-block-id' } : {}) })
    await expectRefused(commitBlock(block, voterRows), 'BlockMatches')
  })

  it('refuses a block before votingStarts and at accruingVotes, and accepts the last millisecond before it', async () => {
    const early = await formBlock(voters.slice(3, 5))
    await expectRefused(commitBlock(early.block, early.voterRows, votingStartsMs - 1), 'WithinVotingWindow')
    const late = await formBlock(voters.slice(3, 5))
    await expectRefused(commitBlock(late.block, late.voterRows, accruingVotesMs), 'WithinVotingWindow')
    const edge = await formBlock(voters.slice(3, 4))
    await commitBlock(edge.block, edge.voterRows, accruingVotesMs - 1)
    expect(await votedIn(voters[3]!.registrantId)).to.equal(edge.block.cid)
  })

  it('refuses a block for a revision that is not the current one', async () => {
    const { block, voterRows } = await formBlock(voters.slice(4, 6), { block: { electionRevision: revision + 1 } })
    await expectRefused(commitBlock(block, voterRows), 'CurrentRevision')
  })

  it('refuses a Cid that is not the content address of the ciphertext', async () => {
    const other = await formBlock(voters.slice(4, 6))
    const { block, voterRows } = await formBlock(voters.slice(4, 6), { block: { cid: other.block.cid } })
    await expectRefused(commitBlock(block, voterRows), 'CidValid')
  })

  it('refuses a payload that is not a vt-block-1 ciphertext', async () => {
    const plaintext = JSON.stringify({ v: 1, votes: [], voterRecords: [] })
    const cid = await scalar(db, 'select cid(Digest(:ct)) as v', { ct: plaintext })
    const { block, voterRows } = await formBlock(voters.slice(4, 6), { block: { ciphertext: plaintext, cid } })
    await expectRefused(commitBlock(block, voterRows), 'CiphertextFormat')
  })

  it('refuses an empty block id, a non-integer entry count and an empty block', async () => {
    const noId = await formBlock(voters.slice(4, 6), { block: { id: '' } })
    await expectRefused(commitBlock(noId.block, noId.voterRows), 'IdPresent')
    const fractional = await formBlock(voters.slice(4, 6), { block: { entryCount: 1.5 } })
    await expectRefused(commitBlock(fractional.block, fractional.voterRows), 'IntegersValid')
    const empty = await formBlock([], { block: { entryCount: 0, voterRegistrantIds: '[]' } })
    await expectRefused(commitBlock(empty.block, empty.voterRows), 'EntryCountValid')
    const textRevision = await formBlock(voters.slice(4, 6), { voter: () => ({ electionRevision: String(revision) as unknown as number }) })
    await expectRefused(commitBlock(textRevision.block, textRevision.voterRows), 'ElectionRevisionValid')
  })

  it('refuses a ballot that does not belong to the election', async () => {
    const { block, voterRows } = await formBlock(voters.slice(4, 6), { block: { ballotId: 'vb-ballot-not-in-election' } })
    await expectRefused(commitBlock(block, voterRows), 'BallotInElection')
  })

  it('refuses a block for an election whose joint key is not published yet', async () => {
    // Keyholders accept but the DKG never runs, so this election has a current revision and a
    // ballot but no ElectionKey. Its own network, so its own registrant and association.
    const unkeyed = await seedDkgElection({ keyholders: ['vb-kh-u1', 'vb-kh-u2'], threshold: 2 })
    const udb = unkeyed.auth.ctx.db
    const { ballotId: uBallotId } = await seedBallot(unkeyed.auth as unknown as TestElectionContext, 'vb-ballot-unkeyed')
    const { privBytes, pubHex } = makeP256TestKey()
    const registrantId = `vb-registrant-unkeyed-${Date.now()}`
    await seedRegistrantAssociation(unkeyed.auth.ctx, unkeyed.auth.authority.id, { id: registrantId }, pubHex, officerSigner(unkeyed.auth.user.id))
    const timelineRow = await udb.prepare('select Timeline from ElectionRevision where ElectionId = :id').get({ id: unkeyed.electionId })
    const nowMs = (JSON.parse(timelineRow!.Timeline as string) as Record<string, number>).votingStarts! + 1
    // Any well-formed vt-block-1 object will do: no key exists to encrypt to, which is the point.
    const ciphertext = JSON.stringify(encryptElectionBlock({ electionId: unkeyed.electionId, revision: unkeyed.revision, jointPublicKey }, 'x', { v: 1, votes: [{}], voterRecords: [{}] }))
    const cid = await scalar(udb, 'select cid(Digest(:ct)) as v', { ct: ciphertext })
    const digest = await scalar(udb, "select Digest('VoteBlockVoter', :e, :r, :b, :c, :i, :reg, :dk) as v",
      { e: unkeyed.electionId, r: unkeyed.revision, b: uBallotId, c: cid, i: 'x', reg: registrantId, dk: pubHex })
    await udb.exec('BEGIN')
    const write = (async () => {
      await udb.exec(
        `insert into VoteBlock (Cid, Id, ElectionId, ElectionRevision, BallotId, TemplateDigest, EntryCount, VoterRegistrantIds, Ciphertext)
         with context NowMs = :nowMs
         values (:cid, 'x', :e, :r, :b, :t, 1, :ids, :ct)`,
        { cid, e: unkeyed.electionId, r: unkeyed.revision, b: uBallotId, t: TEMPLATE_DIGEST, ids: JSON.stringify([registrantId]), ct: ciphertext, nowMs }
      )
      await udb.exec(
        `insert into VoteBlockVoter (ElectionId, BallotId, RegistrantId, BlockCid, BlockId, ElectionRevision, DeviceKey, Signature)
         with context now = :now
         values (:e, :b, :reg, :cid, 'x', :r, :dk, :sig)`,
        { e: unkeyed.electionId, b: uBallotId, reg: registrantId, cid, r: unkeyed.revision, dk: pubHex, sig: signDigestP256(digest, privBytes), now: nowCanonicalDatetime() }
      )
      await udb.exec('COMMIT')
    })()
    await expectRefused(write.catch(async (err) => { await udb.exec('ROLLBACK'); throw err }), 'ElectionKeyPublished')
  })

  it('refuses updates and deletes of committed rows', async () => {
    const cid = (await votedIn(voters[0]!.registrantId))!
    await expectRefused(db.exec('update VoteBlock set EntryCount = 2 where Cid = :cid', { cid }), 'NoUpdate')
    await expectRefused(db.exec('delete from VoteBlock where Cid = :cid', { cid }), 'NoDelete')
    await expectRefused(
      db.exec('update VoteBlockVoter set BlockCid = :cid where RegistrantId = :r', { cid, r: voters[0]!.registrantId }),
      'NoUpdate'
    )
    await expectRefused(db.exec('delete from VoteBlockVoter where RegistrantId = :r', { r: voters[0]!.registrantId }), 'NoDelete')
  })

  it('leaves voters[4] and voters[5] unvoted after every refused block', async () => {
    expect(await votedIn(voters[4]!.registrantId)).to.equal(undefined)
    expect(await votedIn(voters[5]!.registrantId)).to.equal(undefined)
    const blocks = await db.prepare('select count(*) as c from VoteBlock where ElectionId = :electionId').get({ electionId })
    expect(blocks?.c).to.equal(2)
  })
})
