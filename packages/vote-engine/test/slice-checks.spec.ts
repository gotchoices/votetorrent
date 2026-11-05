/**
 * slice-checks.spec.ts — 65-06: the shared committed-block opener (OCB) and the R6 voter slice checks (SC).
 *
 * Built over the 65-05 committed-row fixture. The fixture is never edited; tampered variants are
 * shallow copies made inside each test.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { checkElectionSecret, openCommittedBlock, type CommittedBlockRow } from '../src/blocks/open-committed-block.js'
import { sliceChecks, SLICE_CHECK_IDS, type SliceAuthorization, type SliceCheckReport, type SliceBlockRow, type SliceVoterRow } from '../src/blocks/slice-checks.js'
import { buildBlockTree, type BlockAuthorization } from '../src/blocks/block-tree.js'
import { consentDigest, formPoolBlock, poolBlockCid } from '../src/pool/pool-block.js'
import { encryptElectionBlock, encryptVoteEntry } from '../src/key-release/election-block.js'
import { serializeBlockCiphertext } from '../src/crypto/index.js'
import { canonicalJson } from '../src/voting/canonical.js'
import { buildVoteEntry, makeVoteNonce, type VoteEntry, type VoterEntry } from '../src/voting/vote-entries.js'
import {
  FIXTURE_ELECTION_ID,
  FIXTURE_REVISION,
  makeCommittedElection,
  makeFixtureVoter,
  seededShuffle,
  signVoterEntry,
  type CommittedFixtureSet,
  type FixtureReceipt
} from './fixtures/pool-blocks.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'

/** T-65-05-03: R5's authorization besides the voter rows (set in the SC before hook from the fixture). */
let AUTH: SliceAuthorization
const AUTH_FOR = (voterRows: readonly unknown[]): BlockAuthorization => ({ ...AUTH, voterRows: voterRows as BlockAuthorization['voterRows'] })

function containsBytes (value: unknown, seen = new Set<unknown>()): boolean {
  if (value instanceof Uint8Array) return true
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  return Object.values(value as Record<string, unknown>).some(v => containsBytes(v, seen))
}

describe('open-committed-block (65-06: shared R6-R8 opener)', function () {
  this.timeout(30_000)
  let set: CommittedFixtureSet
  before(() => {
    set = makeCommittedElection({ ballotIds: ['ballot-a'], blocks: [{ size: 3 }, { size: 3, payloadVersion: 1 }] })
  })

  it('OCB-1 opens a v:2 block and every per-vote layer', () => {
    const b = set.blocks[0]!
    const r = openCommittedBlock(b.row, set.election.electionSecret, set.election.electionKey)
    expect(r.ok).to.equal(true)
    if (!r.ok) return
    expect(r.payloadVersion).to.equal(2)
    expect(r.blockCid).to.equal(b.row.Cid)
    expect(r.blockId).to.equal(b.row.Id)
    expect(r.ballotId).to.equal(b.row.BallotId)
    expect(canonicalJson(r.payload)).to.equal(canonicalJson(b.payload))
    expect(r.votes).to.have.length(3)
    r.votes.forEach((v, i) => {
      expect(v.ok).to.equal(true)
      expect(v.index).to.equal(i)
    })
    const got = r.votes.map(v => (v.ok ? v.entryJson : '')).sort()
    const want = b.voters.map(v => canonicalJson(v.voteEntry)).sort()
    expect(got).to.deep.equal(want)
  })

  it('OCB-2 opens a v:1 block of clear votes', () => {
    const b = set.blocks[1]!
    const r = openCommittedBlock(b.row, set.election.electionSecret, set.election.electionKey)
    expect(r.ok).to.equal(true)
    if (!r.ok) return
    expect(r.payloadVersion).to.equal(1)
    expect(r.votes).to.have.length(3)
    for (const v of r.votes) {
      expect(v.ok).to.equal(true)
      if (v.ok) expect(v.entryJson).to.equal(canonicalJson(v.entry))
    }
    const got = r.votes.map(v => (v.ok ? v.entryJson : '')).sort()
    expect(got).to.deep.equal(b.voters.map(v => canonicalJson(v.voteEntry)).sort())
  })

  it('OCB-3 checks the secret against the joint key and never throws', () => {
    const { electionSecret, electionKey } = set.election
    const row = set.blocks[0]!.row
    expect(checkElectionSecret(electionSecret, electionKey)).to.deep.equal({ ok: true })
    const wrong = secp256k1.utils.randomSecretKey()
    const mismatch = checkElectionSecret(wrong, electionKey)
    expect(mismatch.ok).to.equal(false)
    if (!mismatch.ok) expect(mismatch.reason).to.equal('secret-mismatch')
    for (const bad of [new Uint8Array(32), new Uint8Array(31)]) {
      const c = checkElectionSecret(bad, electionKey)
      expect(c.ok).to.equal(false)
      if (!c.ok) expect(c.reason).to.equal('invalid-secret')
      const o = openCommittedBlock(row, bad, electionKey)
      expect(o.ok).to.equal(false)
      if (!o.ok) {
        expect(o.reason).to.equal('invalid-secret')
        expect(o.blockCid).to.equal(row.Cid)
      }
    }
    const o2 = openCommittedBlock(row, wrong, electionKey)
    expect(o2.ok).to.equal(false)
    if (!o2.ok) expect(o2.reason).to.equal('secret-mismatch')
  })

  it('OCB-4 refuses malformed and out-of-scope rows with typed reasons', () => {
    const { electionSecret, electionKey } = set.election
    const row = set.blocks[0]!.row
    const reason = (r: unknown): string => {
      const o = openCommittedBlock(r as CommittedBlockRow, electionSecret, electionKey)
      return o.ok ? 'ok' : o.reason
    }
    expect(reason({ ...row, ElectionId: 'other' })).to.equal('scope-mismatch')
    expect(reason({ ...row, ElectionRevision: FIXTURE_REVISION + 1 })).to.equal('scope-mismatch')
    expect(reason({ ...row, ElectionRevision: BigInt(FIXTURE_REVISION + 5) })).to.equal('scope-mismatch')
    expect(reason({ ...row, ElectionRevision: BigInt(FIXTURE_REVISION) })).to.equal('ok')
    expect(reason(null)).to.equal('malformed-row')
    expect(reason({ ...row, Cid: '' })).to.equal('malformed-row')
    expect(reason({ ...row, Id: '' })).to.equal('malformed-row')
    expect(reason({ ...row, BallotId: '' })).to.equal('malformed-row')
    expect(reason({ ...row, Ciphertext: 5 })).to.equal('malformed-row')
    expect(reason({ ...row, Ciphertext: '{}' })).to.equal('malformed-ciphertext')
    expect(reason({ ...row, Ciphertext: set.blocks[1]!.row.Ciphertext })).to.equal('authentication-failed')
  })

  it('OCB-5 reports per-vote failures individually', () => {
    const { electionKey, electionSecret, ballots } = set.election
    const ballot = ballots[0]!
    const ballotId = ballot.poolBallot.ballotId
    const good = makeFixtureVoter(set.election, ballot, 0)
    const w = makeFixtureVoter(set.election, ballot, 1)
    const n = makeFixtureVoter(set.election, ballot, 2)
    w.contribution = { ...w.contribution, voteCiphertext: encryptVoteEntry(electionKey, 'another-ballot', w.voteJson) }
    n.contribution = { ...n.contribution, voteCiphertext: encryptVoteEntry(electionKey, ballotId, 'not json {') }
    const formed = formPoolBlock([good.contribution, w.contribution, n.contribution], ballot.poolBallot)
    const row: CommittedBlockRow = {
      Cid: formed.cid, Id: formed.blockId, ElectionId: electionKey.electionId, ElectionRevision: electionKey.revision,
      BallotId: ballotId, Ciphertext: formed.ciphertext
    }
    const r = openCommittedBlock(row, electionSecret, electionKey)
    expect(r.ok).to.equal(true)
    if (!r.ok) return
    const kinds = r.votes.map(v => (v.ok ? 'ok' : v.reason)).sort()
    expect(kinds).to.deep.equal(['ok', 'vote-does-not-open', 'vote-not-json'])
    for (const v of r.votes) if (!v.ok) expect(v.detail).to.be.a('string').with.length.greaterThan(0)
  })

  it('OCB-6 neither retains nor zeroes the caller secret, and returns no bytes', () => {
    const secret = set.election.electionSecret
    const copy = new Uint8Array(secret)
    const r = openCommittedBlock(set.blocks[0]!.row, secret, set.election.electionKey)
    expect(Array.from(secret)).to.deep.equal(Array.from(copy))
    expect(containsBytes(r)).to.equal(false)
  })

  it('OCB-7 is deterministic', () => {
    const a = openCommittedBlock(set.blocks[0]!.row, set.election.electionSecret, set.election.electionKey)
    const b = openCommittedBlock(set.blocks[0]!.row, set.election.electionSecret, set.election.electionKey)
    expect(a).to.deep.equal(b)
  })
})


const randomNonce = (): string => makeVoteNonce(globalThis.crypto.getRandomValues(new Uint8Array(32)))

describe('slice-checks (65-06: R6, D-60, D-61, D-13)', function () {
  this.timeout(60_000)
  let set: CommittedFixtureSet
  let scope: { electionId: string, electionRevision: number }
  let rows: SliceBlockRow[]
  let voterRows: SliceVoterRow[]
  let root: string
  let anchor: { root: string }
  let release: { secretKey: Uint8Array, jointPublicKey: string }

  before(() => {
    set = makeCommittedElection({
      ballotIds: ['ballot-a', 'ballot-b'],
      blocks: [{ size: 3 }, { size: 4 }, { ballotIndex: 1, size: 3 }, { size: 3, payloadVersion: 1 }]
    })
    scope = { electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION }
    rows = set.rows
    voterRows = set.voterRows
    AUTH = { ...set.authorization, ballots: set.election.ballots.map(b => b.template) }
    const tree = buildBlockTree(set.rows, scope, AUTH_FOR(voterRows))
    if (!tree.ok) throw new Error('fixture tree refused')
    root = tree.tree.root
    anchor = { root }
    release = { secretKey: set.election.electionSecret, jointPublicKey: set.election.electionKey.jointPublicKey }
  })

  const ok = (r: SliceCheckReport): Extract<SliceCheckReport, { ok: true }> => {
    expect(r.ok, JSON.stringify(r)).to.equal(true)
    return r as Extract<SliceCheckReport, { ok: true }>
  }
  const chk = (r: SliceCheckReport, ballotIdx: number, id: typeof SLICE_CHECK_IDS[number]) => {
    const c = ok(r).ballots[ballotIdx]!.checks.find(x => x.check === id)!
    expect(c).to.not.equal(undefined)
    return c
  }
  const failReason = (c: ReturnType<typeof chk>): string => (c.status === 'fail' ? c.reason : `<${c.status}>`)
  const mine = (receiptIdx: number) => {
    const receipt = set.receipts[receiptIdx]!
    const regId = receipt.voter.registrantId
    return {
      receipt,
      myVoterRow: set.voterRows.find(v => v.RegistrantId === regId)!,
      myBlockRow: set.rows.find(r => r.Cid === set.voterRows.find(v => v.RegistrantId === regId)!.BlockCid)!
    }
  }
  const replaceRow = (orig: SliceBlockRow, next: SliceBlockRow): SliceBlockRow[] => rows.map(r => (r === orig ? next : r))
  const replaceVoterRow = (orig: SliceVoterRow, next: SliceVoterRow): SliceVoterRow[] => voterRows.map(r => (r === orig ? next : r))
  const unsignedOf = (e: VoterEntry) => { const { signature: _s, ...rest } = e; return rest }

  it('SC-1 pre-release happy path: my-vote is pending, the rest pass with what remains after release', () => {
    set.receipts.forEach(receipt => {
      const r = ok(sliceChecks(receipt, rows, voterRows, anchor, undefined, AUTH))
      expect(r.released).to.equal(false)
      expect(r.ballots).to.have.length(1)
      const b = r.ballots[0]!
      const row = mine(set.receipts.indexOf(receipt))
      expect(b.blockCid).to.equal(row.myVoterRow.BlockCid)
      expect(b.checks.map(c => c.check)).to.deep.equal([...SLICE_CHECK_IDS])
      expect(b.checks[0]).to.deep.equal({ check: 'my-vote', status: 'pending-key-release' })
      expect(b.checks[1]).to.deep.equal({ check: 'my-voter-entry', status: 'pass', pendingAfterRelease: ['voter-entry-in-payload'] })
      expect(b.checks[2]).to.deep.equal({ check: 'block-hash', status: 'pass', pendingAfterRelease: ['block-id'] })
      expect(b.checks[3]).to.deep.equal({ check: 'under-root', status: 'pass', pendingAfterRelease: [] })
      expect(b.verdict).to.equal('incomplete')
      expect(r.totals.pass + r.totals.fail + r.totals.pending + r.totals.notApplicable).to.equal(4)
    })
  })

  it('SC-2 post-release happy path: every check passes outright (v:2 and v:1, both ballots)', () => {
    set.receipts.forEach(receipt => {
      const r = ok(sliceChecks(receipt, rows, voterRows, anchor, release, AUTH))
      expect(r.released).to.equal(true)
      const b = r.ballots[0]!
      for (const c of b.checks) {
        expect(c.status).to.equal('pass')
        if (c.status === 'pass') expect(c.pendingAfterRelease).to.deep.equal([])
      }
      expect(b.verdict).to.equal('pass')
    })
  })

  it('SC-3 a tampered receipt vote fails post-release; pre-release it stays pending (Pitfall 6)', () => {
    const { receipt } = mine(0)
    const vote = receipt.votes[0]!
    const altered: VoteEntry[] = [
      { ...vote, nonce: randomNonce() },
      { ...vote, answers: vote.answers.map((a, i) => (i === 0 ? { ...a, optionCodes: ['c'] } : a)) }
    ]
    for (const v of altered) {
      const rc: FixtureReceipt = { ...receipt, votes: [v] }
      const post = sliceChecks(rc, rows, voterRows, anchor, release, AUTH)
      expect(failReason(chk(post, 0, 'my-vote'))).to.equal('vote-missing-or-altered')
      expect(chk(post, 0, 'my-voter-entry').status).to.equal('pass')
      expect(chk(post, 0, 'block-hash').status).to.equal('pass')
      expect(chk(post, 0, 'under-root').status).to.equal('pass')
      expect(ok(post).ballots[0]!.verdict).to.equal('fail')
      expect(chk(sliceChecks(rc, rows, voterRows, anchor, undefined, AUTH), 0, 'my-vote').status).to.equal('pending-key-release')
    }
  })

  it('SC-4 a tampered receipt voter entry never passes', () => {
    const { receipt } = mine(0)
    const unsigned = unsignedOf(receipt.voter)
    const voterPriv = set.blocks[0]!.voters[0]!.priv
    const unsignedAlter: FixtureReceipt = { ...receipt, voter: { ...receipt.voter, privateCid: 'private-altered' } }
    expect(failReason(chk(sliceChecks(unsignedAlter, rows, voterRows, anchor, undefined, AUTH), 0, 'my-voter-entry'))).to.equal('voter-entry-signature-invalid')
    expect(failReason(chk(sliceChecks(unsignedAlter, rows, voterRows, anchor, release, AUTH), 0, 'my-voter-entry'))).to.equal('voter-entry-signature-invalid')
    const resigned: FixtureReceipt = { ...receipt, voter: signVoterEntry({ ...unsigned, privateCid: 'private-altered' }, voterPriv) }
    expect(chk(sliceChecks(resigned, rows, voterRows, anchor, undefined, AUTH), 0, 'my-voter-entry').status).to.equal('pass')
    expect(failReason(chk(sliceChecks(resigned, rows, voterRows, anchor, release, AUTH), 0, 'my-voter-entry'))).to.equal('voter-entry-missing-or-altered')
    const noBallot: FixtureReceipt = { ...receipt, voter: signVoterEntry({ ...unsigned, ballots: [] }, voterPriv) }
    expect(failReason(chk(sliceChecks(noBallot, rows, voterRows, anchor, undefined, AUTH), 0, 'my-voter-entry'))).to.equal('ballot-not-in-voter-entry')
  })

  it('SC-5 D-13 revisit: another device vote under my registrant fails before and after release', () => {
    const block = set.blocks[0]!
    const y = block.voters[0]!
    const key = makeP256TestKey()
    const vote = buildVoteEntry({
      ballot: block.ballot.template, electionRevision: FIXTURE_REVISION, selections: { q1: ['a'], q2: ['x'] }, nonce: randomNonce()
    })
    const voter = signVoterEntry({ ...unsignedOf(y.voterEntry), deviceKey: key.pubHex }, key.privBytes)
    const rc: FixtureReceipt = { electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION, votes: [vote], voter }
    const pre = sliceChecks(rc, rows, voterRows, anchor, undefined, AUTH)
    expect(failReason(chk(pre, 0, 'my-voter-entry'))).to.equal('device-key-mismatch')
    expect(chk(pre, 0, 'my-vote').status).to.equal('pending-key-release')
    expect(chk(pre, 0, 'block-hash').status).to.equal('pass')
    expect(ok(pre).ballots[0]!.verdict).to.equal('fail')
    const post = sliceChecks(rc, rows, voterRows, anchor, release, AUTH)
    expect(failReason(chk(post, 0, 'my-vote'))).to.equal('vote-missing-or-altered')
    expect(failReason(chk(post, 0, 'my-voter-entry'))).to.equal('device-key-mismatch')
    expect(ok(post).ballots[0]!.verdict).to.equal('fail')
  })

  describe('SC-6 wrong or tampered rows', () => {
    const run = (r: SliceBlockRow[], v: SliceVoterRow[], withRelease = false) =>
      sliceChecks(mine(0).receipt, r, v, anchor, withRelease ? release : null, AUTH)

    it('(i) no voter row for my registrant', () => {
      const m = mine(0)
      const r = run(rows, voterRows.filter(v => v !== m.myVoterRow))
      expect(failReason(chk(r, 0, 'my-voter-entry'))).to.equal('not-recorded')
      for (const id of ['my-vote', 'block-hash', 'under-root'] as const) {
        expect(chk(r, 0, id)).to.deep.equal({ check: id, status: 'not-applicable', reason: 'no-block' })
      }
      expect(ok(r).ballots[0]!.blockCid).to.equal(null)
    })
    it('(ii) two voter rows for my registrant and ballot', () => {
      const m = mine(0)
      expect(failReason(chk(run(rows, [...voterRows, { ...m.myVoterRow }]), 0, 'my-voter-entry'))).to.equal('ambiguous-record')
    })
    it('(iii) my voter row names no block row', () => {
      const m = mine(0)
      const r = run(rows, replaceVoterRow(m.myVoterRow, { ...m.myVoterRow, BlockCid: 'nowhere' }))
      expect(failReason(chk(r, 0, 'my-voter-entry'))).to.equal('block-row-missing')
      expect(chk(r, 0, 'block-hash').status).to.equal('not-applicable')
    })
    it('(iv) my voter row BlockId changed', () => {
      const m = mine(0)
      expect(failReason(chk(run(rows, replaceVoterRow(m.myVoterRow, { ...m.myVoterRow, BlockId: 'other-id' })), 0, 'my-voter-entry'))).to.equal('block-id-mismatch')
    })
    it('(v) my block row TemplateDigest changed', () => {
      const m = mine(0)
      expect(failReason(chk(run(replaceRow(m.myBlockRow, { ...m.myBlockRow, TemplateDigest: 'other-template' }), voterRows), 0, 'my-voter-entry'))).to.equal('template-mismatch')
    })
    it('(vi) voter list without me, or not JSON', () => {
      const m = mine(0)
      const others = JSON.stringify((JSON.parse(m.myBlockRow.VoterRegistrantIds) as string[]).filter(x => x !== m.receipt.voter.registrantId))
      expect(failReason(chk(run(replaceRow(m.myBlockRow, { ...m.myBlockRow, VoterRegistrantIds: others }), voterRows), 0, 'my-voter-entry'))).to.equal('not-in-voter-list')
      expect(failReason(chk(run(replaceRow(m.myBlockRow, { ...m.myBlockRow, VoterRegistrantIds: 'not json' }), voterRows), 0, 'my-voter-entry'))).to.equal('voter-list-malformed')
    })
    it('(vii) one flipped signature character', () => {
      const m = mine(0)
      const sig = m.myVoterRow.Signature
      const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0')
      expect(failReason(chk(run(rows, replaceVoterRow(m.myVoterRow, { ...m.myVoterRow, Signature: flipped })), 0, 'my-voter-entry'))).to.equal('consent-signature-invalid')
    })
    it('(viii) my block ciphertext swapped for another block', () => {
      const m = mine(0)
      const swapped = replaceRow(m.myBlockRow, { ...m.myBlockRow, Ciphertext: set.blocks[1]!.row.Ciphertext })
      const pre = run(swapped, voterRows)
      expect(failReason(chk(pre, 0, 'block-hash'))).to.equal('cid-mismatch')
      const post = run(swapped, voterRows, true)
      expect(failReason(chk(post, 0, 'my-vote'))).to.equal('block-does-not-open')
      // the Cid check runs first, so the more precise cid-mismatch is what block-hash keeps reporting
      expect(failReason(chk(post, 0, 'block-hash'))).to.equal('cid-mismatch')
      expect(ok(post).ballots[0]!.verdict).to.equal('fail')
    })
    it('(ix) block row for another ballot; voter row of another revision', () => {
      const m = mine(0)
      expect(failReason(chk(run(replaceRow(m.myBlockRow, { ...m.myBlockRow, BallotId: 'ballot-b' }), voterRows), 0, 'my-voter-entry'))).to.equal('scope-mismatch')
      expect(failReason(chk(run(rows, replaceVoterRow(m.myVoterRow, { ...m.myVoterRow, ElectionRevision: FIXTURE_REVISION + 1 })), 0, 'my-voter-entry'))).to.equal('not-recorded')
    })
  })

  it('SC-7 id-mismatch is visible only after release', () => {
    const block = set.blocks[0]!
    const badId = 'wrong-id-0'
    const ct = serializeBlockCiphertext(encryptElectionBlock(set.election.electionKey, badId, block.payload))
    const cid = poolBlockCid(ct)
    const newRow: SliceBlockRow = { ...block.row, Cid: cid, Id: badId, Ciphertext: ct }
    const newVoterRows: SliceVoterRow[] = block.voters.map(v => ({
      ElectionId: FIXTURE_ELECTION_ID,
      BallotId: block.row.BallotId,
      RegistrantId: v.voterEntry.registrantId,
      BlockCid: cid,
      BlockId: badId,
      ElectionRevision: FIXTURE_REVISION,
      DeviceKey: v.pubHex,
      Signature: signDigestP256(consentDigest({ cid, blockId: badId }, block.ballot.poolBallot, v.voterEntry.registrantId, v.pubHex), v.priv)
    }))
    const rows2 = rows.map(r => (r === block.row ? newRow : r))
    const voterRows2 = [...voterRows.filter(v => v.BlockCid !== block.row.Cid), ...newVoterRows]
    const t = buildBlockTree(rows2, scope, AUTH_FOR(voterRows2))
    if (!t.ok) throw new Error('tree refused')
    const a2 = { root: t.tree.root }
    const rc = set.receipts[0]!
    const pre = sliceChecks(rc, rows2, voterRows2, a2, undefined, AUTH)
    expect(chk(pre, 0, 'block-hash')).to.deep.equal({ check: 'block-hash', status: 'pass', pendingAfterRelease: ['block-id'] })
    const post = sliceChecks(rc, rows2, voterRows2, a2, release, AUTH)
    expect(failReason(chk(post, 0, 'block-hash'))).to.equal('id-mismatch')
    expect(chk(post, 0, 'my-vote').status).to.equal('pass')
    expect(chk(post, 0, 'my-voter-entry').status).to.equal('pass')
  })

  describe('SC-8 under-root', () => {
    it('no anchor is not-applicable and the verdict stays incomplete', () => {
      for (const a of [undefined, null]) {
        const r = sliceChecks(set.receipts[0]!, rows, voterRows, a, release, AUTH)
        expect(chk(r, 0, 'under-root')).to.deep.equal({ check: 'under-root', status: 'not-applicable', reason: 'no-root' })
        expect(ok(r).ballots[0]!.verdict).to.equal('incomplete')
      }
    })
    it('another root fails not-under-root', () => {
      const other = buildBlockTree(rows.slice(1), scope, AUTH_FOR(voterRows))
      if (!other.ok) throw new Error('refused')
      expect(failReason(chk(sliceChecks(set.receipts[0]!, rows, voterRows, { root: other.tree.root }, undefined, AUTH), 0, 'under-root'))).to.equal('not-under-root')
    })
    it('a publisher proof works with only my block row; without it the lone-row tree fails', () => {
      const m = mine(0)
      const full = buildBlockTree(rows, scope, AUTH_FOR(voterRows))
      if (!full.ok) throw new Error('refused')
      const proof = full.tree.proofFor(m.myBlockRow.Cid)
      if (!proof.ok) throw new Error('no proof')
      expect(chk(sliceChecks(m.receipt, [m.myBlockRow], voterRows, { root, proof: proof.proof }, undefined, AUTH), 0, 'under-root').status).to.equal('pass')
      expect(failReason(chk(sliceChecks(m.receipt, [m.myBlockRow], voterRows, { root }, undefined, AUTH), 0, 'under-root'))).to.equal('not-under-root')
      const flipped = { ...proof.proof, path: proof.proof.path.map((s, i) => (i === 0 ? { ...s, side: s.side === 'left' ? 'right' as const : 'left' as const } : s)) }
      expect(failReason(chk(sliceChecks(m.receipt, [m.myBlockRow], voterRows, { root, proof: flipped }, undefined, AUTH), 0, 'under-root'))).to.equal('malformed-proof')
    })
    it('a duplicate or malformed row of another block no longer refuses the tree (WR-06); rows of another election are ignored', () => {
      const dup = [...rows, { ...set.blocks[1]!.row }, { ...set.blocks[1]!.row, Cid: 'NOT-BASE32' }, null]
      const r = chk(sliceChecks(set.receipts[0]!, dup as SliceBlockRow[], voterRows, anchor, undefined, AUTH), 0, 'under-root')
      expect(r.status).to.equal('pass')
      const foreign = [...rows, { ...set.blocks[1]!.row, ElectionId: 'another-election', Cid: 'foreign-cid' }]
      expect(chk(sliceChecks(set.receipts[0]!, foreign, voterRows, anchor, undefined, AUTH), 0, 'under-root').status).to.equal('pass')
    })
  })

  it('SC-13 (T-65-05-03) the rows-built tree needs R5\'s authorization and resolves a forged Cid collision by consent', () => {
    const rc = set.receipts[0]!
    // no authorization: the tree is never built; without a proof under-root is not-applicable, with one it is checked alone
    for (const a of [undefined, null]) {
      const r = sliceChecks(rc, rows, voterRows, anchor, release, a)
      expect(chk(r, 0, 'under-root')).to.deep.equal({ check: 'under-root', status: 'not-applicable', reason: 'no-authorization' })
      expect(ok(r).ballots[0]!.verdict).to.equal('incomplete')
      const full = buildBlockTree(rows, scope, AUTH_FOR(voterRows))
      if (!full.ok) throw new Error('refused')
      const proof = full.tree.proofFor(mine(0).myBlockRow.Cid)
      if (!proof.ok) throw new Error('no proof')
      expect(chk(sliceChecks(rc, rows, voterRows, { root, proof: proof.proof }, release, a), 0, 'under-root').status).to.equal('pass')
    }
    // a forged row that copies another block's ciphertext under a lower Id and a stranger list: the authenticated
    // block keeps its leaf, so the rows still build the published root and my block is under it
    const other = set.blocks[1]!.row
    const forged = { ...other, Id: '!forged', VoterRegistrantIds: '["x-1","x-2","x-3","x-4"]' }
    for (const order of [[forged, ...rows], [...rows, forged]]) {
      const r = sliceChecks(rc, order as SliceBlockRow[], voterRows, anchor, release, AUTH)
      expect(chk(r, 0, 'under-root').status).to.equal('pass')
    }
    // an unreadable authorization refuses the tree, typed
    expect(failReason(chk(sliceChecks(rc, rows, voterRows, anchor, release, { ...AUTH, ballots: 'x' } as never), 0, 'under-root'))).to.equal('tree-refused')
  })

  it('SC-14 (T-65-05-03) several block rows with my Cid are each judged; the best result stands, in any order', () => {
    const m = mine(0)
    // an exact copy of my block row used to be ambiguous-record; it is now the same leaf twice and passes
    for (const order of [[...rows, { ...m.myBlockRow }], [{ ...m.myBlockRow }, ...rows]]) {
      const r = ok(sliceChecks(m.receipt, order, voterRows, anchor, release, AUTH))
      expect(r.ballots[0]!.verdict, JSON.stringify(r.ballots[0]!.checks)).to.equal('pass')
    }
    // a copy with a list that is not the payload's fails my-voter-entry on its own, and loses to my real row
    const others = JSON.parse(m.myBlockRow.VoterRegistrantIds).filter((x: string) => x !== m.receipt.voter.registrantId)
    const wrongList = { ...m.myBlockRow, VoterRegistrantIds: JSON.stringify([...others, m.receipt.voter.registrantId, 'zz-extra'].sort()), EntryCount: others.length + 2 }
    const alone = sliceChecks(m.receipt, rows.map(r => (r === m.myBlockRow ? wrongList : r)), voterRows, anchor, release, AUTH)
    expect(failReason(chk(alone, 0, 'my-voter-entry'))).to.equal('voter-list-mismatch')
    for (const order of [[wrongList, ...rows], [...rows, wrongList]]) {
      expect(ok(sliceChecks(m.receipt, order, voterRows, anchor, release, AUTH)).ballots[0]!.verdict).to.equal('pass')
    }
  })

  it('SC-9 a wrong or invalid secret is refused at the top level; the caller secret is left alone', () => {
    const jointPublicKey = release.jointPublicKey
    const wrong = sliceChecks(set.receipts[0]!, rows, voterRows, anchor, { secretKey: secp256k1.utils.randomSecretKey(), jointPublicKey }, AUTH)
    expect(wrong.ok).to.equal(false)
    if (!wrong.ok) expect(wrong.reason).to.equal('secret-mismatch')
    const zero = sliceChecks(set.receipts[0]!, rows, voterRows, anchor, { secretKey: new Uint8Array(32), jointPublicKey }, AUTH)
    expect(zero.ok).to.equal(false)
    if (!zero.ok) expect(zero.reason).to.equal('invalid-secret')
    const copy = new Uint8Array(release.secretKey)
    const good = sliceChecks(set.receipts[0]!, rows, voterRows, anchor, release, AUTH)
    expect(Array.from(release.secretKey)).to.deep.equal(Array.from(copy))
    expect(containsBytes(good)).to.equal(false)
  })

  it('SC-10 malformed input never throws', () => {
    const rc = set.receipts[0]!
    const refusal = (r: unknown, rs: unknown = rows, vs: unknown = voterRows): string => {
      const out = sliceChecks(r as FixtureReceipt, rs as SliceBlockRow[], vs as SliceVoterRow[], anchor, release, AUTH)
      return out.ok ? 'ok' : out.reason
    }
    const v0 = rc.votes[0]!
    expect(refusal(null)).to.equal('malformed-receipt')
    expect(refusal({ ...rc, votes: 'x' })).to.equal('malformed-receipt')
    expect(refusal({ ...rc, votes: [] })).to.equal('malformed-receipt')
    expect(refusal({ ...rc, votes: [v0, v0] })).to.equal('malformed-receipt')
    expect(refusal({ ...rc, votes: [{ ...v0, electionId: 'other' }] })).to.equal('malformed-receipt')
    const { registrantId: _r, ...noReg } = rc.voter
    expect(refusal({ ...rc, voter: noReg })).to.equal('malformed-receipt')
    expect(refusal({ ...rc, voter: { ...rc.voter, ballots: 'x' } })).to.equal('malformed-receipt')
    expect(refusal(rc, 'x')).to.equal('malformed-rows')
    expect(refusal(rc, rows, null)).to.equal('malformed-rows')
    expect(refusal(rc, [null, ...rows], [undefined, ...voterRows])).to.equal('ok')
    const m = mine(0)
    const big = sliceChecks(
      rc,
      replaceRow(m.myBlockRow, { ...m.myBlockRow, ElectionRevision: BigInt(FIXTURE_REVISION) }),
      replaceVoterRow(m.myVoterRow, { ...m.myVoterRow, ElectionRevision: BigInt(FIXTURE_REVISION) }),
      anchor,
      release
    , AUTH)
    expect(big).to.deep.equal(sliceChecks(rc, rows, voterRows, anchor, release, AUTH))
  })

  it('SC-11 a multi-ballot receipt reports per ballot, in receipt order', () => {
    const base = mine(0).receipt
    const voteB = buildVoteEntry({
      ballot: set.election.ballots[1]!.template, electionRevision: FIXTURE_REVISION, selections: { q1: ['a'], q2: ['x'] }, nonce: randomNonce()
    })
    const rc: FixtureReceipt = { ...base, votes: [base.votes[0]!, voteB] }
    const r = ok(sliceChecks(rc, rows, voterRows, anchor, release, AUTH))
    expect(r.ballots.map(b => b.ballotId)).to.deep.equal(['ballot-a', 'ballot-b'])
    expect(r.ballots[0]!.verdict).to.equal('pass')
    expect(failReason(r.ballots[1]!.checks[1]! as ReturnType<typeof chk>)).to.equal('not-recorded')
    expect(r.ballots[1]!.checks.slice(2).map(c => c.status)).to.deep.equal(['not-applicable', 'not-applicable'])
    expect(r.totals).to.deep.equal({ pass: 4, fail: 1, pending: 0, notApplicable: 3 })
  })

  it('SC-12 is deterministic and order independent', () => {
    const rc = set.receipts[5]!
    const a = sliceChecks(rc, rows, voterRows, anchor, release, AUTH)
    const b = sliceChecks(rc, rows, voterRows, anchor, release, AUTH)
    const c = sliceChecks(rc, seededShuffle(rows, 7), seededShuffle(voterRows, 11), anchor, release, AUTH)
    expect(b).to.deep.equal(a)
    expect(c).to.deep.equal(a)
    expect(ok(a).ballots[0]!.checks.map(x => x.check)).to.deep.equal([...SLICE_CHECK_IDS])
  })
})
