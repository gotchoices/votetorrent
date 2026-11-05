/**
 * block-tree.spec.ts — 65-05: the R5 block Merkle tree (D-50, D-51).
 *
 * Synthetic rows only for the tree shape: with no Cid collision the selection never authenticates a row,
 * so those rows need no crypto and an empty authorization (NOAUTH). The T-65-05-03 section builds real
 * committed rows from the shared fixture. The spec carries its own independent reference (refLeaf,
 * refNode, refRoot) so expected values never come from the module's own hash helpers.
 */

import { expect } from 'chai'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  BLOCK_TREE_DOMAIN,
  BLOCK_TREE_EMPTY_ROOT,
  blockAuthorizer,
  blockCidOf,
  blockConsentDigest,
  blockLeafData,
  blockLeafHash,
  isBase32Cid,
  selectBlockRows,
  blockNodeHash,
  blockTreeStatus,
  buildBlockTree,
  buildTallyTree,
  finalBlockTree,
  judgeBlockVoters,
  validateElectionBlocks,
  verifyBlockConsent,
  verifyInclusion,
  verifyTallyTree,
  tallyTreeFrom,
  tallyLeafHash,
  tallyParentHash,
  addHistograms,
  sliceChecks,
  type BlockAuthorization,
  type BlockInclusionProof,
  type BlockTree,
  type BlockTreeRow
} from '../src/blocks/index.js'
import { canonicalJson } from '../src/voting/canonical.js'
import { verifySigP256 } from '../src/database/initialize.js'
import { consentDigest, poolBlockCid, poolBlockId } from '../src/pool/index.js'
import { encryptElectionBlock, openElectionBlock, openVoteEntries } from '../src/key-release/index.js'
import { serializeBlockCiphertext } from '../src/crypto/index.js'
import { ballotTemplateDigest, voterEntryDigest, type VoterEntryUnsigned } from '../src/voting/index.js'
import {
  FIXTURE_ELECTION_ID,
  FIXTURE_REVISION,
  fixtureAuthorization,
  makeCommittedBlock,
  makeCommittedElection,
  makeFixtureElection,
  makeFixtureVoter,
  seededShuffle,
  type CommittedFixtureSet
} from './fixtures/pool-blocks.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'

const EID = 'election-bt-1'
const SCOPE = { electionId: EID, electionRevision: 1 }
/** T-65-05-03: the authorization is a required input; an empty one authenticates nothing. */
const NOAUTH: BlockAuthorization = { voterRows: [], registrants: [], associations: [], timeline: { votingStarts: 0 }, ballots: [] }
/** The authorization of a whole fixture set: its voter rows, registrants, associations, timeline and ballots. */
const authOfSet = (set: CommittedFixtureSet): BlockAuthorization => ({
  voterRows: set.voterRows, ...set.authorization, ballots: set.election.ballots.map(b => b.template)
})

function row (cid: string, overrides: Partial<Record<keyof BlockTreeRow, unknown>> = {}): BlockTreeRow {
  return {
    Cid: cid,
    Id: `id-${cid}`,
    ElectionId: EID,
    ElectionRevision: 1,
    BallotId: 'ballot-a',
    EntryCount: 3,
    TemplateDigest: 'template-digest-a',
    VoterRegistrantIds: '["r1","r2","r3"]',
    ...overrides
  } as BlockTreeRow
}

/** A base32 Cid-shaped name (IN-05: 'b' then [a-z2-7]); digits 0-9 map to letters a-j. */
const b32 = (i: number): string => `bcid${String(i).padStart(3, '0').replace(/[0-9]/g, d => 'abcdefghij'[Number(d)]!)}`

function rows (n: number): BlockTreeRow[] {
  return Array.from({ length: n }, (_, i) => row(b32(i), { EntryCount: 3 + i }))
}

// ---- independent reference ----
function cmpUtf8 (a: string, b: string): number {
  const x = utf8ToBytes(a); const y = utf8ToBytes(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return x.length - y.length
}
const refLeaf = (r: BlockTreeRow): Uint8Array => sha256(concatBytes(Uint8Array.of(0), utf8ToBytes(
  canonicalJson([r.ElectionId, Number(r.ElectionRevision), r.BallotId, r.Id, r.Cid, Number(r.EntryCount),
    r.TemplateDigest, bytesToHex(sha256(utf8ToBytes(r.VoterRegistrantIds)))]))))
const refNode = (l: Uint8Array, r: Uint8Array): Uint8Array => sha256(concatBytes(Uint8Array.of(1), l, r))
function refMth (leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 1) return leaves[0]!
  let k = 1
  while (k * 2 < leaves.length) k *= 2
  return refNode(refMth(leaves.slice(0, k)), refMth(leaves.slice(k)))
}
function refRoot (rs: readonly BlockTreeRow[]): string {
  if (rs.length === 0) return bytesToHex(sha256(utf8ToBytes('vt-block-tree/1/empty')))
  const sorted = [...rs].sort((a, b) => cmpUtf8(a.Cid, b.Cid))
  return bytesToHex(refMth(sorted.map(refLeaf)))
}

function build (rs: readonly BlockTreeRow[]): BlockTree {
  const r = buildBlockTree(rs, SCOPE, NOAUTH)
  if (!r.ok) throw new Error(`build refused: ${r.reason} ${r.detail}`)
  return r.tree
}

describe('block-tree (65-05: R5, D-50, D-51)', () => {
  it('BT-1 empty set: defined root, no nodes, unknown block', () => {
    const t = build([])
    expect(t.size).to.equal(0)
    expect(t.nodes).to.have.length(0)
    expect(t.root).to.equal(bytesToHex(sha256(utf8ToBytes('vt-block-tree/1/empty'))))
    expect(t.root).to.equal(BLOCK_TREE_EMPTY_ROOT)
    expect(BLOCK_TREE_DOMAIN).to.equal('vt-block-tree/1')
    expect(t.proofFor('x')).to.deep.equal({ ok: false, reason: 'unknown-block' })
  })

  it('BT-2 single leaf: root is the leaf hash and the proof is empty', () => {
    const r = row('bonly')
    const t = build([r])
    expect(t.root).to.equal(bytesToHex(refLeaf(r)))
    const p = t.proofFor('bonly')
    expect(p.ok).to.equal(true)
    if (p.ok) {
      expect(p.proof.path).to.have.length(0)
      expect(verifyInclusion(t.leaves[0]!.hash, p.proof, t.root)).to.deep.equal({ ok: true })
    }
  })

  for (const n of [2, 3, 4, 5, 7, 8, 9]) {
    it(`BT-3 size ${n}: root matches the reference, proofs verify, node table is consistent`, () => {
      const rs = rows(n)
      const t = build(rs)
      expect(t.root).to.equal(refRoot(rs))
      expect(t.size).to.equal(n)
      for (const leaf of t.leaves) {
        const p = t.proofFor(leaf.cid)
        expect(p.ok).to.equal(true)
        if (p.ok) expect(verifyInclusion(leaf.hash, p.proof, t.root)).to.deep.equal({ ok: true })
      }
      expect(t.nodes).to.have.length(2 * n - 1)
      expect(t.nodes[t.nodes.length - 1]!.hash).to.equal(t.root)
      let leafNo = 0
      t.nodes.forEach((node, i) => {
        expect(node.index).to.equal(i)
        if (node.left === undefined) {
          expect(node.range[1] - node.range[0]).to.equal(1)
          expect(node.range[0]).to.equal(leafNo++)
          expect(node.hash).to.equal(t.leaves[node.range[0]]!.hash)
        } else {
          expect(node.left).to.be.lessThan(i)
          expect(node.right!).to.be.lessThan(i)
          expect(node.hash).to.equal(blockNodeHash(t.nodes[node.left]!.hash, t.nodes[node.right!]!.hash))
        }
      })
      expect(leafNo).to.equal(n)
    })
  }

  it('BT-4 known-answer vector (literal derived from refRoot, not from buildBlockTree)', () => {
    const rs = [row('bcida', { EntryCount: 3 }), row('bcidb', { EntryCount: 4, BallotId: 'ballot-b' }), row('bcidc', { EntryCount: 5 })]
    // Derived once from refRoot over these three rows.
    const KAT = '166290c3235661a64a245a66b6fc694c9e0715fa4a890698f671a22f83a3fd2e'
    expect(refRoot(rs)).to.equal(KAT)
    expect(build(rs).root).to.equal(KAT)
  })

  it('BT-5 an odd node is carried up, never duplicated', () => {
    const rs = rows(3)
    const t = build(rs)
    const [l0, l1, l2] = t.leaves.map(l => l.hash)
    expect(t.root).to.equal(blockNodeHash(blockNodeHash(l0!, l1!), l2!))
    expect(t.root).to.not.equal(blockNodeHash(blockNodeHash(l0!, l1!), blockNodeHash(l2!, l2!)))
  })

  it('BT-6 domain separation and position binding', () => {
    const t = build(rows(4))
    const leaf = t.leaves[0]!
    expect(leaf.hash).to.not.equal(bytesToHex(sha256(utf8ToBytes(leaf.leafData))))
    expect(blockLeafHash(leaf.leafData)).to.equal(leaf.hash)
    expect(blockLeafData(rows(4)[0]!)).to.equal(leaf.leafData)
    // an internal node posing as a leaf with a shortened path
    const inner = t.nodes[t.nodes.length - 2]! // right child of the root for size 4
    const p = t.proofFor(t.leaves[2]!.cid)
    expect(p.ok).to.equal(true)
    if (p.ok) {
      const forged: BlockInclusionProof = { leafIndex: p.proof.leafIndex, treeSize: p.proof.treeSize, path: p.proof.path.slice(1) }
      expect(verifyInclusion(inner.hash, forged, t.root)).to.deep.equal({ ok: false, reason: 'malformed-proof' })
    }
  })

  it('BT-7 any arrival order gives the same root, leaf order and node hashes', () => {
    const rs = rows(7)
    const base = build(rs)
    for (const seed of [1, 2, 3]) {
      const t = build(seededShuffle(rs, seed))
      expect(t.root).to.equal(base.root)
      expect(t.leaves.map(l => l.cid)).to.deep.equal(base.leaves.map(l => l.cid))
      expect(t.nodes.map(n => n.hash)).to.deep.equal(base.nodes.map(n => n.hash))
    }
  })

  it('BT-8 leaves order by the bytes of the base32 Cid; a shorter prefix sorts first', () => {
    const t = build([row('bza'), row('b2z'), row('bz')])
    expect(t.leaves.map(l => l.cid)).to.deep.equal(['b2z', 'bz', 'bza'])
    expect(t.root).to.equal(refRoot([row('bza'), row('b2z'), row('bz')]))
  })

  it('BT-8b (IN-05) a Cid outside the base32 CID alphabet is malformed, so leaf order is total', () => {
    // two distinct lone surrogates both encode to U+FFFD and would compare equal byte-wise
    for (const cid of ['a\u{1F600}', 'b\uD800', 'b\uDC00', 'bA', 'bcid-a', 'b', 'Bcida', 'bcid1', 'bcid8', 'bcid=', ' bcida']) {
      const r = buildBlockTree([row(cid)], SCOPE, NOAUTH)
      if (!r.ok) throw new Error(`refused ${JSON.stringify(cid)}`)
      expect(r.tree.size, JSON.stringify(cid)).to.equal(0)
      expect(r.tree.rejected[0]!.reason).to.equal('malformed-row')
      expect(r.tree.rejected[0]!.detail).to.contain('Cid')
    }
    expect(buildBlockTree([row('bafkreiabc234567')], SCOPE, NOAUTH).ok).to.equal(true)
  })

  it('BT-9 tamper: changed leaf fields change the root; bad proofs return typed results and never throw', () => {
    const rs = rows(5)
    const base = build(rs)
    const mutate = (field: string, value: unknown): string => {
      const copy = rs.map((r, i) => i === 2 ? { ...r, [field]: value } as BlockTreeRow : r)
      return build(copy).root
    }
    expect(mutate('EntryCount', 99)).to.not.equal(base.root)
    expect(mutate('BallotId', 'ballot-z')).to.not.equal(base.root)
    expect(mutate('Id', 'id-changed')).to.not.equal(base.root)
    expect(mutate('Cid', 'bcidchanged')).to.not.equal(base.root)
    // IN-08: the frozen voter list and the template column are bound too
    expect(mutate('TemplateDigest', 'template-digest-z')).to.not.equal(base.root)
    expect(mutate('VoterRegistrantIds', '["r1","r2","r9"]')).to.not.equal(base.root)
    const revCopy = rs.map((r, i) => i === 2 ? { ...r, ElectionRevision: 2 } : r)
    const revTree = buildBlockTree(revCopy, { electionId: EID, electionRevision: 2 }, NOAUTH)
    // other rows are revision 1 so the scope refuses; the leaf data itself carries the revision
    expect(revTree.ok).to.equal(false)
    expect(blockLeafData(row('bc'))).to.not.equal(blockLeafData(row('bc', { ElectionRevision: 2 })))

    const leaf = base.leaves[3]!
    const pr = base.proofFor(leaf.cid)
    if (!pr.ok) throw new Error('proof expected')
    const proof = pr.proof
    expect(verifyInclusion(leaf.hash, proof, base.root)).to.deep.equal({ ok: true })

    const flip = (h: string): string => (h[0] === 'a' ? 'b' : 'a') + h.slice(1)
    const flipped: BlockInclusionProof = { ...proof, path: proof.path.map((s, i) => i === 0 ? { ...s, hash: flip(s.hash) } : s) }
    expect(verifyInclusion(leaf.hash, flipped, base.root)).to.deep.equal({ ok: false, reason: 'root-mismatch' })
    const other = build(rows(6))
    expect(verifyInclusion(leaf.hash, proof, other.root)).to.deep.equal({ ok: false, reason: 'root-mismatch' })

    const malformed = (p: unknown, leafHash = leaf.hash, root = base.root): unknown => verifyInclusion(leafHash, p as BlockInclusionProof, root)
    const bad = { ok: false, reason: 'malformed-proof' }
    expect(malformed({ ...proof, path: proof.path.map((s, i) => i === 0 ? { ...s, side: s.side === 'left' ? 'right' : 'left' } : s) })).to.deep.equal(bad)
    expect(malformed({ ...proof, leafIndex: proof.leafIndex === 0 ? 1 : proof.leafIndex - 1 })).to.deep.equal(bad)
    expect(malformed({ ...proof, treeSize: proof.treeSize - 1 })).to.deep.equal(bad)
    expect(malformed({ ...proof, treeSize: 0 })).to.deep.equal(bad)
    expect(malformed({ ...proof, path: proof.path.slice(1) })).to.deep.equal(bad)
    expect(malformed({ ...proof, path: [...proof.path, proof.path[0]] })).to.deep.equal(bad)
    expect(malformed({ ...proof, path: proof.path.map((s, i) => i === 0 ? { ...s, hash: 'zz' + s.hash.slice(2) } : s) })).to.deep.equal(bad)
    expect(malformed({ ...proof, path: proof.path.map((s, i) => i === 0 ? { ...s, hash: s.hash.toUpperCase() } : s) })).to.deep.equal(bad)
    expect(malformed(proof, leaf.hash.toUpperCase())).to.deep.equal(bad)
    expect(malformed(proof, leaf.hash, 'nothex')).to.deep.equal(bad)
    expect(malformed(null)).to.deep.equal(bad)
    expect(malformed({ leafIndex: 1.5, treeSize: 5, path: [] })).to.deep.equal(bad)
    expect(malformed({ leafIndex: 0, treeSize: 5, path: 'x' })).to.deep.equal(bad)
  })

  it('BT-10 typed refusals, bigint acceptance, never a throw', () => {
    const refusal = (input: unknown): { reason: string, detail: string } => {
      const r = buildBlockTree(input as BlockTreeRow[], SCOPE, NOAUTH)
      if (r.ok) throw new Error('expected refusal')
      return r
    }
    expect(refusal([row('ba'), row('bb', { ElectionId: 'elsewhere' })]).reason).to.equal('mixed-election')
    // a foreign row refuses even when it is also malformed (the same rule R7 applies)
    expect(refusal([row('ba'), row('bb', { ElectionId: 'elsewhere', EntryCount: 0 })]).reason).to.equal('mixed-election')
    expect(refusal([row('ba'), row('bb', { ElectionRevision: 2 })]).reason).to.equal('mixed-revision')
    // WR-06: a malformed row is set aside in tree.rejected and never refuses the tree
    const rejected = (bad: unknown): { reason: string, detail: string, cid: string } => {
      const r = buildBlockTree([row('bz'), bad] as BlockTreeRow[], SCOPE, NOAUTH)
      if (!r.ok) throw new Error(`expected a tree, got ${r.reason}`)
      expect(r.tree.size).to.equal(1)
      expect(r.tree.root).to.equal(build([row('bz')]).root)
      expect(r.tree.rejected).to.have.length(1)
      return r.tree.rejected[0]!
    }
    for (const field of ['Cid', 'Id', 'ElectionId', 'BallotId']) {
      const missing = rejected(row('ba', { [field]: undefined }))
      expect(missing.reason).to.equal('malformed-row')
      expect(missing.detail).to.contain(field)
      // an empty ElectionId is a string that is not the scope, so it is a foreign row (R7's rule too)
      if (field === 'ElectionId') expect(refusal([row('ba', { [field]: '' })]).reason).to.equal('mixed-election')
      else expect(rejected(row('ba', { [field]: '' })).reason).to.equal('malformed-row')
    }
    for (const field of ['TemplateDigest', 'VoterRegistrantIds']) {
      const missing = rejected(row('ba', { [field]: undefined }))
      expect(missing.reason).to.equal('malformed-row')
      expect(missing.detail).to.contain(field)
      expect(rejected(row('ba', { [field]: 7 })).reason).to.equal('malformed-row')
    }
    expect(rejected(row('ba', { EntryCount: 0 })).detail).to.contain('EntryCount')
    expect(rejected(row('ba', { EntryCount: 0 })).cid).to.equal('ba')
    expect(rejected(row('ba', { ElectionRevision: 1.5 })).detail).to.contain('ElectionRevision')
    expect(rejected(row('ba', { ElectionRevision: -1 })).reason).to.equal('malformed-row')
    expect(rejected(row('ba', { EntryCount: Number.MAX_SAFE_INTEGER + 1 })).reason).to.equal('malformed-row')
    expect(rejected(row('ba', { EntryCount: BigInt(Number.MAX_SAFE_INTEGER) + 1n })).reason).to.equal('malformed-row')
    expect(rejected(null)).to.deep.equal({ cid: '', reason: 'malformed-row', detail: 'the row is not an object' })
    expect(refusal('nope').reason).to.equal('malformed-row')

    const withBig = [row('ba', { ElectionRevision: 1n, EntryCount: 3n }), row('bb')]
    const withNum = [row('ba'), row('bb')]
    expect(build(withBig).root).to.equal(build(withNum).root)
  })

  it('BT-11 the accruing gate (D-51): nowMs is a parameter; provisional before hashingVotes', () => {
    const tl = { accruingVotes: 1000, hashingVotes: 2000 }
    expect(blockTreeStatus(tl, 1999)).to.deep.equal({ ok: false, reason: 'accruing-not-ended', finalAtMs: 2000 })
    expect(blockTreeStatus(tl, 2000)).to.deep.equal({ ok: true, final: true })
    expect(blockTreeStatus(tl, 5000)).to.deep.equal({ ok: true, final: true })
    expect(blockTreeStatus(tl, NaN)).to.deep.equal({ ok: false, reason: 'clock-invalid' })
    expect(blockTreeStatus(tl, Infinity)).to.deep.equal({ ok: false, reason: 'clock-invalid' })
    expect(blockTreeStatus({ accruingVotes: 2000, hashingVotes: 1000 }, 3000)).to.deep.equal({ ok: false, reason: 'timeline-invalid' })
    expect(blockTreeStatus({ accruingVotes: NaN, hashingVotes: 1000 }, 3000)).to.deep.equal({ ok: false, reason: 'timeline-invalid' })
    expect(blockTreeStatus({ accruingVotes: 1000 } as never, 3000)).to.deep.equal({ ok: false, reason: 'timeline-invalid' })

    const rs = rows(4)
    const early = finalBlockTree(rs, SCOPE, NOAUTH, tl, 1500)
    expect(early.ok).to.equal(false)
    if (!early.ok && early.reason === 'accruing-not-ended') {
      expect(early.finalAtMs).to.equal(2000)
      expect(early.provisional.root).to.equal(build(rs).root)
    } else throw new Error('expected accruing-not-ended')
    const late = finalBlockTree(rs, SCOPE, NOAUTH, tl, 2000)
    expect(late.ok).to.equal(true)
    if (late.ok) { expect(late.final).to.equal(true); expect(late.tree.root).to.equal(build(rs).root) }
    const doubled = finalBlockTree([row('ba'), row('ba')], SCOPE, NOAUTH, tl, 1500)
    if (!doubled.ok && doubled.reason === 'accruing-not-ended') {
      expect(doubled.provisional.size).to.equal(1)
      expect(doubled.provisional.rejected.map(r => r.reason)).to.deep.equal(['duplicate-block'])
    } else throw new Error('expected accruing-not-ended')
    expect(finalBlockTree([row('ba'), row('bb', { ElectionRevision: 2 })], SCOPE, NOAUTH, tl, 2500)).to.include({ ok: false, reason: 'mixed-revision' })
  })
})

describe('block-tree row policy (WR-06: tolerant, shared with R7)', () => {
  const tree = (rs: unknown[]): BlockTree => {
    const r = buildBlockTree(rs as BlockTreeRow[], SCOPE, NOAUTH)
    if (!r.ok) throw new Error(`refused: ${r.reason} ${r.detail}`)
    return r.tree
  }

  it('WR6-1 an identical copy collapses to one leaf and is reported once', () => {
    const t = tree([row('ba'), row('bb'), { ...row('ba') }])
    expect(t.leaves.map(l => l.cid)).to.deep.equal(['ba', 'bb'])
    expect(t.root).to.equal(build([row('ba'), row('bb')]).root)
    expect(t.rejected).to.deep.equal([{ cid: 'ba', reason: 'duplicate-block', detail: 'Cid ba is already taken by a preferred row' }])
  })

  it('WR6-2 a shared Cid keeps the row whose Cid is the digest of its own Ciphertext, in any order', () => {
    const ct = '{"v":1,"alg":"vt-block-1","ct":"honest"}'
    const cid = blockCidOf(ct)
    expect(cid).to.equal(poolBlockCid(ct))
    const honest = row(cid, { Id: 'id-zzz-honest', Ciphertext: ct })
    // the forged row sorts first by bytes ('id-aaa' < 'id-zzz') but its Ciphertext does not hash to the Cid
    const forged = row(cid, { Id: 'id-aaa-forged', Ciphertext: 'garbage' })
    for (const order of [[honest, forged], [forged, honest]]) {
      const t = tree(order)
      expect(t.leaves).to.have.length(1)
      expect(t.leaves[0]!.blockId).to.equal('id-zzz-honest')
      expect(t.rejected).to.have.length(1)
      expect(t.rejected[0]).to.include({ cid, reason: 'duplicate-block' })
    }
  })

  it('WR6-3 a shared Cid keeps the lowest canonical bytes when none authenticates; a shared Id with distinct Cids is two leaves (T-65-05-03)', () => {
    const a = row('ba', { Id: 'id-1', EntryCount: 3 })
    const b = row('ba', { Id: 'id-1', EntryCount: 4 })
    for (const seed of [1, 2, 3]) {
      const t = tree(seededShuffle([a, b, row('bc')], seed))
      expect(t.leaves.map(l => [l.cid, l.entryCount])).to.deep.equal([['ba', 3], ['bc', 3]])
    }
    // only an exact Cid collision is a duplicate: rows sharing an Id are separate blocks, and R7 judges each
    const x = row('bx', { Id: 'same' })
    const y = row('by', { Id: 'same' })
    const t1 = tree([y, x])
    const t2 = tree([x, y])
    expect(t1.leaves.map(l => [l.cid, l.blockId])).to.deep.equal([['bx', 'same'], ['by', 'same']])
    expect(t1.root).to.equal(t2.root)
    expect(t1.root).to.equal(refRoot([x, y]))
    expect(t1.rejected).to.deep.equal([])
  })

  it('WR6-4 malformed and duplicate rows never refuse the tree; the root is the root of the kept rows', () => {
    const good = rows(5)
    // T-65-05-03: a row reusing another row's Id under its own Cid is kept as its own leaf
    const sameId = row('bzz', { Id: good[0]!.Id })
    const hostile = [...good, null, 'x', row('BAD'), { ...good[1]! }, sameId]
    for (const seed of [1, 2, 3]) {
      const t = tree(seededShuffle(hostile, seed))
      expect(t.root).to.equal(build([...good, sameId]).root)
      expect(t.rejected.map(r => r.reason)).to.deep.equal(['malformed-row', 'malformed-row', 'malformed-row', 'duplicate-block'])
    }
    const sel = selectBlockRows(hostile, SCOPE, NOAUTH)
    if (!sel.ok) throw new Error('refused')
    expect(sel.accepted).to.have.length(6)
    for (const r of sel.accepted) expect([...good, sameId]).to.include(r)
    expect(sel.rejected).to.have.length(4)
    expect(selectBlockRows('nope' as never, SCOPE, NOAUTH)).to.include({ ok: false, reason: 'malformed-row' })
  })

  it('WR6-5 (T-65-05-03) the authorization is required and checked; a malformed one refuses with malformed-input', () => {
    const reason = (auth: unknown): string => {
      const r = buildBlockTree([row('ba')], SCOPE, auth as BlockAuthorization)
      return r.ok ? 'ok' : r.reason
    }
    expect(reason(NOAUTH)).to.equal('ok')
    for (const bad of [
      undefined, null, 'x', [],
      { ...NOAUTH, voterRows: 'x' }, { ...NOAUTH, registrants: undefined }, { ...NOAUTH, associations: {} },
      { ...NOAUTH, timeline: undefined }, { ...NOAUTH, timeline: { votingStarts: NaN } }, { ...NOAUTH, timeline: { votingStarts: '0' } },
      { ...NOAUTH, ballots: undefined }, { ...NOAUTH, ballots: [null] }, { ...NOAUTH, ballots: [{ id: 'b' }] },
      { ...NOAUTH, ballots: [{ id: 'b', questions: [] }, { id: 'b', questions: [] }] }
    ]) {
      expect(reason(bad), JSON.stringify(bad) ?? 'undefined').to.equal('malformed-input')
    }
    // a hostile item inside the row lists authorizes nothing and never refuses
    expect(reason({ ...NOAUTH, voterRows: [null, 5, 'x'], registrants: [null], associations: [7] })).to.equal('ok')
    const tl = { accruingVotes: 1000, hashingVotes: 2000 }
    expect(finalBlockTree([row('ba')], SCOPE, undefined as never, tl, 2500)).to.include({ ok: false, reason: 'malformed-input' })
  })
})

describe('block-tree authenticated selection (T-65-05-03: the WR-06 residual, superset case included)', function () {
  this.timeout(120_000)

  const e = makeFixtureElection({ ballotIds: ['ballot-a'] })
  const ballot = e.ballots[0]!
  const vs = [0, 1, 2, 3, 4, 5].map(i => makeFixtureVoter(e, ballot, i))
  // H: the honest block under attack; O: another honest block of the same ballot
  const H = makeCommittedBlock(e, ballot, [vs[0]!, vs[1]!, vs[2]!])
  const O = makeCommittedBlock(e, ballot, [vs[3]!, vs[4]!, vs[5]!])
  const scope = { electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION }
  const ballots = [ballot.template]
  const release = { secretKey: e.electionSecret, jointPublicKey: e.electionKey.jointPublicKey }
  const honestRows = [H.row, O.row]
  const honestVoterRows = [...H.voterRows, ...O.voterRows]

  /** An attacker that holds a registered and associated device key of its own. */
  const attackers = [0, 1, 2].map(i => {
    const k = makeP256TestKey()
    return { registrantId: `attacker-${i}`, pubHex: k.pubHex, priv: k.privBytes }
  })
  const authorization = (voterRows: readonly unknown[]): BlockAuthorization => {
    const base = fixtureAuthorization(vs)
    return {
      voterRows: voterRows as BlockAuthorization['voterRows'],
      registrants: [...base.registrants, ...attackers.map(a => ({ Id: a.registrantId, Status: 'a', Expiration: '2030-01-01T00:00:00.000Z' }))],
      associations: [...base.associations, ...attackers.map(a => ({ RegistrantId: a.registrantId, DeviceKey: a.pubHex, Expiration: '2030-01-01T00:00:00.000Z' }))],
      timeline: base.timeline,
      ballots
    }
  }
  /** A real consent row by an attacker key for (cid, blockId). */
  const consentRow = (a: typeof attackers[number], cid: string, blockId: string): Record<string, unknown> => ({
    ElectionId: FIXTURE_ELECTION_ID, BallotId: ballot.poolBallot.ballotId, RegistrantId: a.registrantId, BlockCid: cid, BlockId: blockId,
    ElectionRevision: FIXTURE_REVISION, DeviceKey: a.pubHex,
    Signature: signDigestP256(consentDigest({ cid, blockId }, ballot.poolBallot, a.registrantId, a.pubHex), a.priv)
  })

  /** R5, R7 (before and after release) and R8 over the same public inputs. */
  function judge (rows: readonly unknown[], voterRows: readonly unknown[]): { tree: BlockTree, pre: any, post: any, tally: any } {
    const auth = authorization(voterRows)
    const built = buildBlockTree(rows as BlockTreeRow[], scope, auth)
    if (!built.ok) throw new Error(`R5 refused: ${built.reason} ${built.detail}`)
    const r7 = (withRelease: boolean): any => validateElectionBlocks({
      scope, rows: rows as never, voterRows: voterRows as never, ballots: ballots as never,
      registrants: auth.registrants, associations: auth.associations, timeline: auth.timeline, release: withRelease ? release : null
    })
    const pre = r7(false)
    const post = r7(true)
    expect(pre.ok && post.ok, JSON.stringify([pre, post]).slice(0, 400)).to.equal(true)
    const tally: any = buildTallyTree({
      scope, rows: rows as never, voterRows: voterRows as never, ballots: ballots as never,
      registrants: auth.registrants, associations: auth.associations, timeline: auth.timeline, release
    })
    expect(tally.ok, JSON.stringify(tally).slice(0, 400)).to.equal(true)
    // R7 and R8 judge exactly the R5 leaves, in leaf order, one finding per leaf hash
    for (const report of [pre, post]) {
      expect(report.blocks.map((b: any) => [b.blockCid, b.blockId, b.leafHash])).to.deep.equal(built.tree.leaves.map(l => [l.cid, l.blockId, l.hash]))
    }
    expect(tally.blockTree.root).to.equal(built.tree.root)
    expect(verifyTallyTree(tally.tally)).to.deep.equal({ ok: true })
    // trap (b): per Cid, one leaf counts the ciphertext; the R7 totals and the R8 root agree
    for (const report of [pre, post]) {
      const t = report.totals
      expect(t.valid + t.invalid + t.excluded + t.undecryptable).to.equal(t.entries)
      const counters = new Map<string, number>()
      for (const b of report.blocks) {
        if (b.shadowedBy !== null) { expect(b.attestedEntries).to.equal(0); expect(b.status).to.not.equal('valid'); continue }
        counters.set(b.blockCid, (counters.get(b.blockCid) ?? 0) + 1)
      }
      for (const n of counters.values()) expect(n).to.equal(1)
    }
    const root = tally.tally.histogram.ballots['ballot-a']
    expect([root.votes - root.invalid - root.excluded, root.invalid, root.excluded]).to.deep.equal([post.totals.valid, post.totals.invalid, post.totals.excluded])
    return { tree: built.tree, pre, post, tally }
  }
  const clean = (() => {
    let memo: ReturnType<typeof judge> | null = null
    return () => (memo ??= judge(honestRows, honestVoterRows))
  })()
  const hLeaf = blockLeafHash(blockLeafData(H.row))
  const byLeaf = (report: any, leafHash: string): any => report.blocks.find((b: any) => b.leafHash === leafHash)
  const leafOf = (row: Record<string, unknown>): string => blockLeafHash(blockLeafData(row as unknown as BlockTreeRow))
  const cmpBytes = (a: string, b: string): number => cmpUtf8(a, b)

  /**
   * H keeps its own leaf and its votes: no finding before the release (trap (a): a forged leaf of its Cid that lists
   * its voters is not a second block), valid and counting after it, every other leaf of its Cid shadowed by it with
   * nothing counted, and the outcome equal to the clean one.
   */
  function expectHonestKept (j: ReturnType<typeof judge>): void {
    const leaf = j.tree.leaves.find(l => l.hash === hLeaf)!
    expect(leaf.blockId).to.equal(H.row.Id)
    expect(leaf.leafData).to.equal(blockLeafData(H.row))
    expect(byLeaf(j.pre, hLeaf)).to.include({ status: 'not-decryptable-yet' })
    expect(byLeaf(j.pre, hLeaf).findings).to.deep.equal([])
    expect(byLeaf(j.post, hLeaf)).to.include({ status: 'valid', shadowedBy: null })
    expect(byLeaf(j.post, hLeaf).votes.every((v: any) => v.status === 'valid')).to.equal(true)
    for (const b of j.post.blocks.filter((x: any) => x.blockCid === H.row.Cid && x.leafHash !== hLeaf)) {
      expect(b).to.include({ status: 'invalid', shadowedBy: hLeaf, attestedEntries: 0 })
    }
    expect(j.post.totals).to.include({ valid: 6, invalid: 0, excluded: 0, undecryptable: 0, entries: 6 })
    expect(j.tally.tally.histogram).to.deep.equal(clean().tally.tally.histogram)
    const tallied = j.tally.tally.leaves.filter((l: any) => l.disposition === 'tallied').map((l: any) => l.leafData)
    expect(tallied.sort()).to.deep.equal([blockLeafData(H.row), blockLeafData(O.row)].sort())
  }

  it('TA-0 the clean election: two leaves, both valid, six votes tallied', () => {
    const c = clean()
    expect(c.tree.size).to.equal(2)
    expect(c.tree.rejected).to.deep.equal([])
    expect(c.post.blocks.map((b: any) => b.status)).to.deep.equal(['valid', 'valid'])
    expect(c.post.blocks.map((b: any) => b.shadowedBy)).to.deep.equal([null, null])
    expect(c.tally.tally.histogram.ballots['ballot-a'].votes).to.equal(6)
  })

  it('TA-1 (a) a forged row that copies the honest ciphertext under another Id never displaces the honest block', () => {
    expect(cmpBytes('!forged', H.row.Id)).to.be.lessThan(0)
    // unauthenticated (its voters have no consent rows): set aside, the tree is the clean one
    const strangers = { ...H.row, Id: '!forged', VoterRegistrantIds: '["x-1","x-2"]', EntryCount: 2 }
    const j1 = judge([strangers, ...honestRows], honestVoterRows)
    expectHonestKept(j1)
    expect(j1.tree.root).to.equal(clean().tree.root)
    expect(j1.tree.rejected).to.deep.equal([{ cid: H.row.Cid, reason: 'duplicate-block', detail: `Cid ${H.row.Cid} is already taken by a preferred row` }])
    expect(j1.tally.tally.root).to.equal(clean().tally.tally.root)
    // authenticated by two registered attacker keys: a leaf of its own, which cannot open under its Id after release
    const owned = { ...H.row, Id: '!forged', VoterRegistrantIds: JSON.stringify([attackers[0]!.registrantId, attackers[1]!.registrantId]), EntryCount: 2 }
    const j2 = judge([owned, ...honestRows], [...honestVoterRows, consentRow(attackers[0]!, H.row.Cid, '!forged'), consentRow(attackers[1]!, H.row.Cid, '!forged')])
    expectHonestKept(j2)
    expect(j2.tree.size).to.equal(3)
    expect(j2.tree.rejected).to.deep.equal([])
    expect(byLeaf(j2.post, leafOf(owned)).findings.map((f: any) => f.code)).to.include('block-does-not-open')
  })

  it('TA-2 (b) a forged row that reuses the honest Id under its own self-consistent Cid is a second leaf; it is excluded and the honest block is tallied', () => {
    let ct = ''
    for (let i = 0; i < 64; i++) {
      ct = serializeBlockCiphertext(encryptElectionBlock(e.electionKey, H.row.Id, H.payload))
      if (cmpBytes(blockCidOf(ct), H.row.Cid) < 0) break
    }
    const reenc = { ...H.row, Cid: blockCidOf(ct), Ciphertext: ct }
    expect(cmpBytes(reenc.Cid, H.row.Cid)).to.be.lessThan(0)
    const garbageCt = 'garbage-ciphertext'
    const garbage = { ...H.row, Cid: blockCidOf(garbageCt), Ciphertext: garbageCt }
    for (const forged of [reenc, garbage]) {
      const j = judge([...honestRows, forged], honestVoterRows)
      expectHonestKept(j)
      expect(j.tree.size).to.equal(3)
      expect(j.tree.rejected).to.deep.equal([])
      const fPre = byLeaf(j.pre, leafOf(forged))
      expect(fPre.status).to.equal('invalid')
      expect(fPre.attestedEntries).to.equal(0)
      expect(fPre.findings.map((f: any) => f.code)).to.deep.equal(['voter-row-missing', 'voter-row-missing', 'voter-row-missing'])
      const fPost = byLeaf(j.post, leafOf(forged))
      expect(fPost.status).to.equal('invalid')
      if (forged === reenc) expect(fPost.findings.map((f: any) => f.code)).to.not.include('id-mismatch')
      const tallyLeaf = j.tally.tally.leaves.find((l: any) => l.blockCid === forged.Cid)
      expect(tallyLeaf).to.include({ disposition: 'excluded' })
      expect(tallyLeaf.excludedFor).to.include('voter-row-missing')
    }
  })

  it('TA-3 (c) a forged row with the same Cid and Id listing a SUBSET of the honest voters (real consents) is excluded after release', () => {
    const subset = JSON.parse(H.row.VoterRegistrantIds).slice(0, 2)
    const forged = { ...H.row, VoterRegistrantIds: JSON.stringify(subset), EntryCount: 2 }
    const j = judge([forged, ...honestRows], honestVoterRows)
    expectHonestKept(j)
    // authenticated (every listed voter consented to this Cid and Id): kept, then refuted by the payload
    expect(j.tree.size).to.equal(3)
    expect(byLeaf(j.post, leafOf(forged)).findings.map((f: any) => f.code)).to.include.members(['payload-count-mismatch', 'voter-count-mismatch'])
    // before the release H counts the ciphertext (more attested entries); the subset leaf is shadowed
    expect(byLeaf(j.pre, leafOf(forged))).to.include({ status: 'not-decryptable-yet', shadowedBy: hLeaf, attestedEntries: 0 })
    expect(j.pre.totals).to.include({ undecryptable: 6, entries: 6 })
  })

  it('TA-4 a forged row that differs only in TemplateDigest (not bound by consent) is set aside', () => {
    const forged = { ...H.row, TemplateDigest: '' }
    const j = judge([forged, ...honestRows], honestVoterRows)
    expectHonestKept(j)
    expect(j.tree.root).to.equal(clean().tree.root)
  })

  it('TA-5 (d) every forgery at once, in any order of rows and voter rows, gives one result', () => {
    const reencCt = serializeBlockCiphertext(encryptElectionBlock(e.electionKey, H.row.Id, H.payload))
    const superset = { ...H.row, VoterRegistrantIds: JSON.stringify([...JSON.parse(H.row.VoterRegistrantIds), attackers[2]!.registrantId].sort()), EntryCount: 4 }
    const forgedRows = [
      { ...H.row, Id: '!forged', VoterRegistrantIds: JSON.stringify([attackers[0]!.registrantId]), EntryCount: 1 },
      { ...H.row, Cid: blockCidOf(reencCt), Ciphertext: reencCt },
      { ...H.row, VoterRegistrantIds: JSON.stringify(JSON.parse(H.row.VoterRegistrantIds).slice(1)), EntryCount: 2 },
      superset,
      { ...H.row, TemplateDigest: '' },
      { ...H.row, Ciphertext: 'not the ciphertext' },
      { ...H.row }
    ]
    const rows = [...honestRows, ...forgedRows]
    const voterRows = [...honestVoterRows, consentRow(attackers[0]!, H.row.Cid, '!forged'), consentRow(attackers[2]!, H.row.Cid, H.row.Id)]
    const base = judge(rows, voterRows)
    expectHonestKept(base)
    // H, O, the re-encryption, and three authenticated forgeries of H's Cid ('!forged', subset, superset)
    expect(base.tree.size).to.equal(6)
    expect(base.tree.rejected.map(r => r.reason)).to.deep.equal(['duplicate-block', 'duplicate-block', 'duplicate-block'])
    for (const seed of [1, 2, 3, 4]) {
      const j = buildBlockTree(seededShuffle(rows, seed), scope, authorization(seededShuffle(voterRows, seed + 10)))
      if (!j.ok) throw new Error('refused')
      expect(j.tree.root).to.equal(base.tree.root)
      expect(j.tree.leaves.map(l => [l.cid, l.blockId, l.leafData])).to.deep.equal(base.tree.leaves.map(l => [l.cid, l.blockId, l.leafData]))
      expect(j.tree.rejected).to.deep.equal(base.tree.rejected)
      const v = validateElectionBlocks({
        ...authorization([]), scope, rows: seededShuffle(rows, seed + 30) as never, voterRows: seededShuffle(voterRows, seed + 40) as never,
        ballots: ballots as never, release
      } as never)
      expect(v).to.deep.equal(base.post)
    }
  })

  it('TA-6 (superset) a forged row adding a colluding registered key is a second leaf: excluded after release, the honest block counted once', () => {
    const listed = [...JSON.parse(H.row.VoterRegistrantIds), attackers[2]!.registrantId].sort()
    const forged = { ...H.row, VoterRegistrantIds: JSON.stringify(listed), EntryCount: 4 }
    const good = consentRow(attackers[2]!, H.row.Cid, H.row.Id)
    // without a consent that authenticates (none, a flipped signature, a key that is not associated) it is set aside
    const flipped = { ...good, Signature: ((good.Signature as string)[0] === '0' ? '1' : '0') + (good.Signature as string).slice(1) }
    const stranger = makeP256TestKey()
    const unassociated = { ...good, DeviceKey: stranger.pubHex, Signature: signDigestP256(consentDigest({ cid: H.row.Cid, blockId: H.row.Id }, ballot.poolBallot, attackers[2]!.registrantId, stranger.pubHex), stranger.privBytes) }
    for (const extra of [[], [flipped], [unassociated]]) {
      const j = judge([forged, ...honestRows], [...honestVoterRows, ...extra])
      expectHonestKept(j)
      expect(j.tree.root).to.equal(clean().tree.root)
    }
    // with one: both leaves are in the root, and the release decides
    const j = judge([forged, ...honestRows], [...honestVoterRows, good])
    expectHonestKept(j)
    expect(j.tree.size).to.equal(3)
    expect(j.tree.leaves.filter(l => l.cid === H.row.Cid).map(l => l.entryCount).sort()).to.deep.equal([3, 4])
    const f = byLeaf(j.post, leafOf(forged))
    expect(f.findings.map((x: any) => x.code)).to.include.members(['payload-count-mismatch', 'voter-count-mismatch'])
    expect(f).to.include({ status: 'invalid', shadowedBy: hLeaf, attestedEntries: 0 })
    // trap (a): before the release H keeps no finding although the forged leaf lists its voters
    expect(byLeaf(j.pre, hLeaf).findings).to.deep.equal([])
    expect(byLeaf(j.pre, leafOf(forged)).findings).to.deep.equal([])
    // before the release the leaf with more attested entries counts the ciphertext once (4, not 3 + 4)
    expect(byLeaf(j.pre, leafOf(forged))).to.include({ status: 'not-decryptable-yet', shadowedBy: null })
    expect(byLeaf(j.pre, hLeaf)).to.include({ shadowedBy: leafOf(forged) })
    expect(j.pre.totals).to.include({ undecryptable: 7, entries: 7 })
    // R8: the forged leaf is excluded with nothing counted
    const tl = j.tally.tally.leaves.find((l: any) => l.leafData === blockLeafData(forged as unknown as BlockTreeRow))
    expect(tl.disposition).to.equal('excluded')
    expect(j.tally.tally.histogram.ballots['ballot-a']).to.include({ votes: 6, excluded: 0 })
    // proofs name the leaf by hash once a Cid has two leaves; finalBlockTree reports both leaves
    expect(j.tree.proofFor(H.row.Cid)).to.deep.equal({ ok: false, reason: 'ambiguous-block' })
    for (const leaf of j.tree.leaves.filter(l => l.cid === H.row.Cid)) {
      const pr = j.tree.proofFor(H.row.Cid, leaf.hash)
      if (!pr.ok) throw new Error('proof')
      expect(verifyInclusion(leaf.hash, pr.proof, j.tree.root)).to.deep.equal({ ok: true })
    }
    const fin = finalBlockTree([forged, ...honestRows] as BlockTreeRow[], scope, authorization([...honestVoterRows, good]), { accruingVotes: 1, hashingVotes: 2 }, 3)
    expect(fin.ok && fin.tree.root).to.equal(j.tree.root)
  })

  it('TA-7 one shared consent judge: R5 authenticates exactly the registrants R7 attests', () => {
    const authorizer = blockAuthorizer(authorization([]).registrants, authorization([]).associations, authorization([]).timeline.votingStarts)
    const block = { Cid: H.row.Cid, Id: H.row.Id, ElectionId: H.row.ElectionId, ElectionRevision: H.row.ElectionRevision, BallotId: H.row.BallotId }
    const list = JSON.parse(H.row.VoterRegistrantIds) as string[]
    const judged = judgeBlockVoters(block, list, H.voterRows, authorizer)
    expect([...judged.authenticated].sort()).to.deep.equal(list)
    expect(judged.extras).to.deep.equal([])
    expect(byLeaf(clean().pre, hLeaf).attestedEntries).to.equal(judged.authenticated.size)
    const flipped = H.voterRows.map((v, i) => (i === 0 ? { ...v, Signature: (v.Signature[0] === '0' ? '1' : '0') + v.Signature.slice(1) } : v))
    const judged2 = judgeBlockVoters(block, list, flipped, authorizer)
    expect(judged2.authenticated.size).to.equal(2)
    expect(judged2.representatives.find(r => r.registrantId === flipped[0]!.RegistrantId)!.problems.map(p => p.code)).to.deep.equal(['consent-signature-invalid'])
  })

  it('TA-8 trap (c): R6 finds an honest voter\'s block when a superset leaf shares its Cid', () => {
    const listed = [...JSON.parse(H.row.VoterRegistrantIds), attackers[2]!.registrantId].sort()
    const forged = { ...H.row, VoterRegistrantIds: JSON.stringify(listed), EntryCount: 4 }
    const voterRows = [...honestVoterRows, consentRow(attackers[2]!, H.row.Cid, H.row.Id)]
    const auth = authorization(voterRows)
    const sliceAuth = { registrants: auth.registrants, associations: auth.associations, timeline: auth.timeline, ballots: auth.ballots }
    const t = buildBlockTree([forged, ...honestRows] as BlockTreeRow[], scope, auth)
    if (!t.ok) throw new Error('tree')
    for (const rows of [[forged, ...honestRows], [...honestRows, forged]]) {
      for (const v of H.voters) {
        const receipt = { electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION, votes: [v.voteEntry], voter: v.voterEntry }
        const pre: any = sliceChecks(receipt, rows as never, voterRows as never, { root: t.tree.root }, null, sliceAuth)
        expect(pre.ok).to.equal(true)
        expect(pre.ballots[0].checks.filter((c: any) => c.status === 'fail')).to.deep.equal([])
        expect(pre.ballots[0].blockCid).to.equal(H.row.Cid)
        const post: any = sliceChecks(receipt, rows as never, voterRows as never, { root: t.tree.root }, release, sliceAuth)
        expect(post.ballots[0].verdict, JSON.stringify(post.ballots[0].checks)).to.equal('pass')
      }
    }
    // the forged row alone is refuted after the release by the voter list check
    const v0 = H.voters[0]!
    const alone: any = sliceChecks({ electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION, votes: [v0.voteEntry], voter: v0.voterEntry },
      [forged, O.row] as never, voterRows as never, null, release, null)
    expect(alone.ballots[0].checks.find((c: any) => c.check === 'my-voter-entry')).to.include({ status: 'fail', reason: 'voter-list-mismatch' })
  })

  it('TA-9 trap (b): R8 and the verifier refuse a second count of one ciphertext', () => {
    const listed = [...JSON.parse(H.row.VoterRegistrantIds), attackers[2]!.registrantId].sort()
    const forged = { ...H.row, VoterRegistrantIds: JSON.stringify(listed), EntryCount: 4 }
    const j = judge([forged, ...honestRows], [...honestVoterRows, consentRow(attackers[2]!, H.row.Cid, H.row.Id)])
    // a report that lets the shadowed leaf count its attested entries is refused
    const doctored = { ...j.post, blocks: j.post.blocks.map((b: any) => (b.leafHash === leafOf(forged) ? { ...b, shadowedBy: null, attestedEntries: 4 } : b)) }
    expect(tallyTreeFrom(j.tree, doctored, ballots as never)).to.include({ ok: false, reason: 'inconsistent-inputs' })
    // a tally rehashed so the shadowed leaf carries votes fails verification
    const tally = structuredClone(j.tally.tally)
    const idx = tally.leaves.findIndex((l: any) => l.leafData === blockLeafData(forged as unknown as BlockTreeRow))
    const leafNode = tally.nodes.find((n: any) => n.range[0] === idx && n.range[1] === idx + 1)
    leafNode.histogram.ballots['ballot-a'].votes = 4
    leafNode.histogram.ballots['ballot-a'].excluded = 4
    for (const n of tally.nodes) {
      if (n.left === undefined) {
        const l = tally.leaves[n.range[0]]
        n.hash = tallyLeafHash(n.merkleHash, n.histogram, l.disposition, l.excludedFor)
      } else {
        n.histogram = addHistograms(tally.nodes[n.left].histogram, tally.nodes[n.right].histogram)
        n.hash = tallyParentHash(n.merkleHash, tally.nodes[n.left].hash, tally.nodes[n.right].hash, n.histogram)
      }
    }
    tally.root = tally.nodes[tally.nodes.length - 1].hash
    tally.histogram = tally.nodes[tally.nodes.length - 1].histogram
    const verdict: any = verifyTallyTree(tally)
    expect(verdict.ok).to.equal(false)
    expect(verdict.reason).to.equal('histogram-mismatch')
    expect(verdict.detail).to.contain('of the same Cid already counts')
  })
})

describe('pool-blocks fixture (65-05: shared R5-R8 rows)', () => {
  const set = makeCommittedElection({
    ballotIds: ['ballot-a', 'ballot-b'],
    blocks: [{ size: 3 }, { size: 4 }, { ballotIndex: 1, size: 3 }, { size: 3, payloadVersion: 1 }]
  })

  it('FX-1 rows are schema-shaped and self-consistent', () => {
    expect(set.blocks).to.have.length(4)
    for (const b of set.blocks) {
      const r = b.row
      expect(poolBlockCid(r.Ciphertext)).to.equal(r.Cid)
      expect(r.Id).to.equal(poolBlockId(b.payload))
      expect(r.EntryCount).to.equal(b.voters.length)
      expect(set.voterRows.filter(v => v.BlockCid === r.Cid)).to.have.length(r.EntryCount)
      expect(r.VoterRegistrantIds).to.equal(JSON.stringify(b.voters.map(v => v.voterEntry.registrantId).sort()))
      expect(r.TemplateDigest).to.equal(ballotTemplateDigest(b.ballot.template, FIXTURE_REVISION))
      expect(r.ElectionId).to.equal(FIXTURE_ELECTION_ID)
      expect(r.ElectionRevision).to.equal(FIXTURE_REVISION)
    }
    expect(set.blocks.map(b => b.payloadVersion)).to.deep.equal([2, 2, 2, 1])
    expect(set.rows).to.have.length(4)
    expect(set.voterRows).to.have.length(13)
    expect(set.receipts).to.have.length(13)
  })

  it('FX-2 consent and voter-entry signatures are real', () => {
    for (const b of set.blocks) {
      for (const vr of b.voterRows) {
        const digest = consentDigest({ cid: b.row.Cid, blockId: b.row.Id }, b.ballot.poolBallot, vr.RegistrantId, vr.DeviceKey)
        expect(verifySigP256(digest, vr.Signature, vr.DeviceKey)).to.equal(true)
      }
      for (const v of b.voters) {
        const { signature, ...unsigned } = v.voterEntry
        expect(verifySigP256(voterEntryDigest(unsigned as VoterEntryUnsigned), signature, v.voterEntry.deviceKey)).to.equal(true)
      }
    }
  })

  it('FX-3 blocks reopen after release; receipts carry the entries found in the block', () => {
    const key = set.election.electionKey
    for (const b of set.blocks) {
      const opened = openElectionBlock(set.election.electionSecret, key, { blockId: b.row.Id, ciphertext: b.row.Ciphertext })
      expect(opened.ok).to.equal(true)
      if (!opened.ok) continue
      const mine = set.receipts.filter(rc => b.voters.some(v => v.voterEntry === rc.voter))
      expect(mine).to.have.length(b.voters.length)
      expect(opened.payload.voterRecords.map(v => canonicalJson(v)).sort()).to.deep.equal(mine.map(rc => canonicalJson(rc.voter)).sort())
      const receiptVotes = mine.flatMap(rc => rc.votes.map(v => canonicalJson(v))).sort()
      if (b.payloadVersion === 2) {
        const plain = openVoteEntries(set.election.electionSecret, key, b.ballot.poolBallot.ballotId, opened.payload)
          .map(p => (p.ok ? canonicalJson(JSON.parse(p.voteEntryJson)) : 'FAILED')).sort()
        expect(plain).to.deep.equal(receiptVotes)
      } else {
        expect(opened.payload.votes.map(v => canonicalJson(v)).sort()).to.deep.equal(receiptVotes)
      }
    }
  })

  it('FX-4 a raw voteEntry is used as is; voterBallots are signed sorted by ballotId', () => {
    const election = makeFixtureElection({ ballotIds: ['ballot-a', 'ballot-b'] })
    const raw = { v: 1 as const, ballotId: 'ballot-a', answers: [{ questionCode: 'q1', optionCodes: ['nope'] }], nonce: 'ab'.repeat(32) }
    const v = makeFixtureVoter(election, election.ballots[0]!, 0, { voteEntry: raw as never, voterBallots: [election.ballots[1]!, election.ballots[0]!] })
    expect(v.voteEntry).to.equal(raw)
    expect(v.voteJson).to.equal(canonicalJson(raw))
    expect(v.voterEntry.ballots.map(b => b.ballotId)).to.deep.equal(['ballot-a', 'ballot-b'])
  })

  it('FX-6 blockCidOf is the noble-only twin of poolBlockCid', () => {
    for (const r of set.rows) expect(blockCidOf(r.Ciphertext)).to.equal(r.Cid)
    for (const text of ['', 'a', 'x'.repeat(127), 'x'.repeat(128), 'x'.repeat(20000), 'é\u{1F600}']) {
      expect(blockCidOf(text), `length ${text.length}`).to.equal(poolBlockCid(text))
      expect(isBase32Cid(blockCidOf(text))).to.equal(true)
    }
  })

  it('FX-7 (T-65-05-03) blockConsentDigest and verifyBlockConsent are the browser-entry twins of consentDigest and verifySigP256', () => {
    for (const b of set.blocks) {
      for (const vr of b.voterRows) {
        const scopeRow = { Cid: b.row.Cid, Id: b.row.Id, ElectionId: b.row.ElectionId, ElectionRevision: b.row.ElectionRevision, BallotId: b.row.BallotId }
        const digest = blockConsentDigest(scopeRow, vr.RegistrantId, vr.DeviceKey)
        expect(digest).to.equal(consentDigest({ cid: b.row.Cid, blockId: b.row.Id }, b.ballot.poolBallot, vr.RegistrantId, vr.DeviceKey))
        const flip = (h: string): string => (h[0] === '0' ? '1' : '0') + h.slice(1)
        const other = makeP256TestKey()
        const lowS = vr.Signature
        for (const [sig, key] of [
          [lowS, vr.DeviceKey], [flip(lowS), vr.DeviceKey], [lowS, other.pubHex], [lowS.toUpperCase(), vr.DeviceKey],
          [lowS, vr.DeviceKey.toUpperCase()], [lowS.slice(1), vr.DeviceKey], [lowS, vr.DeviceKey.slice(2)], ['', vr.DeviceKey],
          [lowS, ''], [`${lowS}00`, vr.DeviceKey], ['zz'.repeat(64), vr.DeviceKey]
        ] as Array<[string, string]>) {
          expect(verifyBlockConsent(digest, sig, key), `${sig.slice(0, 6)} ${key.slice(0, 6)}`).to.equal(verifySigP256(digest, sig, key))
        }
        expect(verifyBlockConsent(digest, lowS, vr.DeviceKey)).to.equal(true)
        expect(verifyBlockConsent('', lowS, vr.DeviceKey)).to.equal(verifySigP256('', lowS, vr.DeviceKey))
        expect(verifyBlockConsent(digest, 5 as never, vr.DeviceKey)).to.equal(false)
      }
    }
    // a bigint revision and odd text digest the same as consentDigest
    const odd = { Cid: 'bodd', Id: 'id é\u{1F600}', ElectionId: 'e', ElectionRevision: 0, BallotId: 'x'.repeat(300) }
    const ballotOdd = { electionKey: { electionId: 'e', revision: 0, jointPublicKey: '' }, ballotId: 'x'.repeat(300), templateDigest: '' }
    expect(blockConsentDigest(odd, 'r', 'k')).to.equal(consentDigest({ cid: 'bodd', blockId: odd.Id }, ballotOdd, 'r', 'k'))
  }).timeout(60_000) // ~300 P-256 verifies; slow under background QoS (taskpolicy -b)

  it('FX-5 seededShuffle is a deterministic permutation; shuffled rows give the same root', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7]
    expect(seededShuffle(xs, 3)).to.deep.equal(seededShuffle(xs, 3))
    expect([...seededShuffle(xs, 3)].sort()).to.deep.equal(xs)
    expect([1, 2, 3, 4, 5].some(s => JSON.stringify(seededShuffle(xs, s)) !== JSON.stringify(xs))).to.equal(true)
    const scope = { electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION }
    const ra = buildBlockTree(set.rows, scope, authOfSet(set))
    const rb = buildBlockTree(seededShuffle(set.rows, 4), scope, { ...authOfSet(set), voterRows: seededShuffle(set.voterRows, 5) })
    if (!ra.ok || !rb.ok) throw new Error('fixture rows refused')
    const a = ra.tree
    expect(rb.tree.root).to.equal(a.root)
    const cids = new Set(set.rows.map(r => r.Cid))
    expect(a.leaves.every(l => cids.has(l.cid))).to.equal(true)
  })
})
