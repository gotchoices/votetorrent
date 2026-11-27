/**
 * tally-tree.spec.ts — R8 (D-80, D-81): the tally tree that mirrors the R5 block Merkle tree with a histogram at
 * every node. Part 1 uses synthetic inputs only (no crypto).
 */

import { expect } from 'chai'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { BLOCK_TREE_EMPTY_ROOT, blockCidOf, blockLeafData, blockLeafHash, buildBlockTree, type BlockAuthorization } from '../src/blocks/block-tree.js'
import { TALLY_TREE_DOMAIN, addHistograms, buildTallyTree, tallyNodeHash, tallyTreeFrom, verifyTallyTree } from '../src/blocks/tally-tree.js'
import { validateElectionBlocks } from '../src/blocks/validate-blocks.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { buildVoteEntry, makeVoteNonce } from '../src/voting/vote-entries.js'
import { canonicalJson } from '../src/voting/canonical.js'
import {
  FIXTURE_ELECTION_ID,
  FIXTURE_REVISION,
  fixtureAuthorization,
  makeCommittedBlock,
  makeCommittedElection,
  makeFixtureElection,
  makeFixtureTemplate,
  makeFixtureVoter,
  seededShuffle
} from './fixtures/pool-blocks.js'

/** T-65-05-03: the synthetic rows never share a Cid, so an empty authorization builds their tree. */
const NOAUTH: BlockAuthorization = { voterRows: [], registrants: [], associations: [], timeline: { votingStarts: 0 }, ballots: [] }

// ---- independent reference (never uses the module's helpers) ----

const refTallyHash = (merkleHex: string, hist: unknown, prefix = 0x03): string =>
  bytesToHex(sha256(concatBytes(Uint8Array.of(prefix), hexToBytes(merkleHex), utf8ToBytes(canonicalJson(hist)))))

/** IN-02 leaf: 0x04 || merkle || canonicalJson({ disposition, excludedFor, histogram }). */
const refLeafTallyHash = (merkleHex: string, hist: unknown, disposition: string, excludedFor: string[]): string =>
  bytesToHex(sha256(concatBytes(Uint8Array.of(0x04), hexToBytes(merkleHex), utf8ToBytes(canonicalJson({ disposition, excludedFor, histogram: hist })))))

/** IN-02 parent: 0x03 || merkle || leftTally || rightTally || canonicalJson(histogram). */
const refParentTallyHash = (merkleHex: string, left: string, right: string, hist: unknown): string =>
  bytesToHex(sha256(concatBytes(Uint8Array.of(0x03), hexToBytes(merkleHex), hexToBytes(left), hexToBytes(right), utf8ToBytes(canonicalJson(hist)))))

/** The reference tally hash of node i of a tally, from its own fields and its children's hashes. */
function refNodeHash (t: any, i: number): string {
  const n = t.nodes[i]
  if (n.left === undefined) {
    const l = t.leaves[n.range[0]]
    return refLeafTallyHash(n.merkleHash, n.histogram, l.disposition, l.excludedFor)
  }
  return refParentTallyHash(n.merkleHash, t.nodes[n.left].hash, t.nodes[n.right].hash, n.histogram)
}

const hasOwn = (o: any, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

function refSumRec (a: any, b: any): any {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  const out: any = {}
  for (const k of [...keys].sort()) {
    Object.defineProperty(out, k, {
      value: (a && hasOwn(a, k) ? a[k] : 0) + (b && hasOwn(b, k) ? b[k] : 0), enumerable: true, writable: true, configurable: true
    })
  }
  return out
}

function refAddBallot (x: any, y: any): any {
  const qs = new Set([...Object.keys(x?.questions ?? {}), ...Object.keys(y?.questions ?? {})])
  const questions: any = {}
  for (const q of [...qs].sort()) {
    const qx = x && hasOwn(x.questions, q) ? x.questions[q] : undefined
    const qy = y && hasOwn(y.questions, q) ? y.questions[q] : undefined
    Object.defineProperty(questions, q, {
      value: { answered: (qx?.answered ?? 0) + (qy?.answered ?? 0), options: refSumRec(qx?.options, qy?.options) },
      enumerable: true, writable: true, configurable: true
    })
  }
  return {
    votes: (x?.votes ?? 0) + (y?.votes ?? 0),
    invalid: (x?.invalid ?? 0) + (y?.invalid ?? 0),
    excluded: (x?.excluded ?? 0) + (y?.excluded ?? 0),
    questions,
    unsupported: refSumRec(x?.unsupported, y?.unsupported)
  }
}

function refAdd (a: any, b: any): any {
  const ids = new Set([...Object.keys(a.ballots), ...Object.keys(b.ballots)])
  const ballots: any = {}
  for (const id of [...ids].sort()) {
    Object.defineProperty(ballots, id, {
      value: refAddBallot(hasOwn(a.ballots, id) ? a.ballots[id] : undefined, hasOwn(b.ballots, id) ? b.ballots[id] : undefined),
      enumerable: true, writable: true, configurable: true
    })
  }
  return { ballots }
}

/** A tallied leaf's counts straight from the template and the verdicts. */
function refLeafCounts (template: any, verdicts: any[]): any {
  const questions: any = {}
  const unsupported: any = {}
  for (const q of template.questions) {
    if (q.type === undefined || q.type === 'select') {
      const options: any = {}
      for (const o of q.options) options[o.code] = 0
      questions[q.code] = { answered: 0, options }
    } else unsupported[q.code] = 0
  }
  let invalid = 0
  for (const v of verdicts) {
    if (v.status === 'invalid') { invalid++; continue }
    for (const a of v.entry.answers) {
      if (hasOwn(questions, a.questionCode)) {
        questions[a.questionCode].answered++
        for (const o of a.optionCodes) questions[a.questionCode].options[o]++
      } else unsupported[a.questionCode]++
    }
  }
  return { votes: verdicts.length, invalid, excluded: 0, questions, unsupported }
}

// ---- synthetic builders ----

const scope = { electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION }

const row = (cid: string, ballotId: string, entryCount: number): any => ({
  Cid: cid, Id: `id-${cid}`, ElectionId: FIXTURE_ELECTION_ID, ElectionRevision: FIXTURE_REVISION, BallotId: ballotId,
  TemplateDigest: 'td', EntryCount: entryCount, VoterRegistrantIds: '[]', Ciphertext: 'x'
})

const entryOf = (ballotId: string, answers: Array<[string, string[]]>): any => ({
  v: 1, electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION, ballotId, templateDigest: 'td',
  answers: answers.map(([questionCode, optionCodes]) => ({ questionCode, optionCodes })), nonce: '0'.repeat(64)
})

function verdictsFor (ballotId: string, blockNo: number, n: number): any[] {
  const out: any[] = []
  for (let j = 0; j < n; j++) {
    if (j === n - 1 && blockNo % 2 === 0) { out.push({ index: j, status: 'invalid', codes: ['unknown-option'] }); continue }
    const answers: Array<[string, string[]]> = [
      ['q1', [['a', 'b', 'c'][(blockNo + j) % 3]!]],
      ['q2', (blockNo + j) % 2 === 0 ? ['x'] : ['x', 'y']]
    ]
    if (j % 2 === 0) answers.push(['q3', ['r1']])
    out.push({ index: j, status: 'valid', entry: entryOf(ballotId, answers) })
  }
  return out
}

const blockFinding = (r: any, over: any = {}): any => ({
  blockCid: r.Cid, leafHash: blockLeafHash(blockLeafData(r)), shadowedBy: null, blockId: r.Id, ballotId: r.BallotId, payloadVersion: 2,
  status: 'valid', declaredEntries: r.EntryCount, attestedEntries: r.EntryCount, votes: [], findings: [], ...over
})

const report = (blocks: any[], over: any = {}): any => ({
  ok: true, electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION, released: true, blocks, findings: [],
  totals: { blocks: blocks.length, entries: 0, valid: 0, invalid: 0, undecryptable: 0 }, ...over
})

const templates = (): any[] => [makeFixtureTemplate('ballot-a'), makeFixtureTemplate('ballot-b')]

/** 5 rows over 2 ballots (entry counts 3,4,3,3,5) with a released finding per Cid. */
function syntheticSet (over: { invalidBlock?: number } = {}): any {
  const spec: Array<[string, string, number]> = [['bca', 'ballot-a', 3], ['bcb', 'ballot-a', 4], ['bcc', 'ballot-b', 3], ['bcd', 'ballot-a', 3], ['bce', 'ballot-b', 5]]
  const rows = spec.map(([cid, b, n]) => row(cid, b, n))
  const blocks = rows.map((r, i) => {
    if (i === over.invalidBlock) {
      return blockFinding(r, {
        status: 'invalid',
        votes: verdictsFor(r.BallotId, i, r.EntryCount),
        findings: [
          { blockCid: r.Cid, code: 'consent-signature-invalid', severity: 'error', detail: 'x' },
          { blockCid: r.Cid, code: 'cid-mismatch', severity: 'error', detail: 'x' },
          { blockCid: r.Cid, code: 'cid-mismatch', severity: 'error', detail: 'again' },
          { blockCid: r.Cid, code: 'blank-required', severity: 'info', detail: 'x', voteIndex: 0 },
          { blockCid: r.Cid, code: 'below-minimum', severity: 'error', detail: 'x', voteIndex: 1 }
        ]
      })
    }
    return blockFinding(r, { votes: verdictsFor(r.BallotId, i, r.EntryCount) })
  })
  const built = buildBlockTree(rows, scope, NOAUTH)
  if (!built.ok) throw new Error('fixture tree failed')
  return { rows, tree: built.tree, validation: report(blocks), blocks }
}

const freeze = <T>(v: T): T => {
  if (v !== null && typeof v === 'object') { Object.freeze(v); for (const k of Object.keys(v)) freeze((v as any)[k]) }
  return v
}

describe('tally histograms (65-08: R8, D-80, D-81)', function () {
  this.timeout(60_000)

  const H = { ballots: { 'ballot-a': { excluded: 0, invalid: 1, questions: { q1: { answered: 2, options: { a: 1, b: 1, c: 0 } } }, unsupported: { q3: 1 }, votes: 3 } } }
  // Derived once from refTallyHash('ab'.repeat(32), H) (independent noble computation).
  const PINNED = '35399850ce4f9225355b3a3bcc38381953726c462d12f4f14b804a0355f61499'

  it('TH-1 hash: prefix 0x03 over the raw merkle bytes and the canonical histogram', () => {
    const m = 'ab'.repeat(32)
    expect(TALLY_TREE_DOMAIN).to.equal('vt-tally-tree/1')
    expect(tallyNodeHash(m, H as any)).to.equal(PINNED)
    expect(refTallyHash(m, H)).to.equal(PINNED)
    expect(refTallyHash(m, H, 0x01)).to.not.equal(PINNED)
    const noMerkle = bytesToHex(sha256(concatBytes(Uint8Array.of(0x03), utf8ToBytes(canonicalJson(H)))))
    expect(noMerkle).to.not.equal(PINNED)
    // the same histogram printed with non-canonical key order hashes differently if JSON.stringify were used
    const shuffled = { ballots: { 'ballot-a': { votes: 3, unsupported: { q3: 1 }, questions: { q1: { options: { c: 0, b: 1, a: 1 }, answered: 2 } }, invalid: 1, excluded: 0 } } }
    const viaStringify = bytesToHex(sha256(concatBytes(Uint8Array.of(0x03), hexToBytes(m), utf8ToBytes(JSON.stringify(shuffled)))))
    expect(viaStringify).to.not.equal(PINNED)
    expect(tallyNodeHash(m, shuffled as any)).to.equal(PINNED)
  })

  it('TH-2 addHistograms: identity, commutative, associative, union, fresh, canonical key order', () => {
    const e = { ballots: {} }
    const ha: any = { ballots: { A: { votes: 3, invalid: 1, excluded: 0, questions: { q1: { answered: 2, options: { a: 1, b: 1 } } }, unsupported: { q3: 1 } } } }
    const hb: any = { ballots: { A: { votes: 2, invalid: 0, excluded: 2, questions: { q1: { answered: 0, options: { b: 0, c: 0 } }, q2: { answered: 0, options: { x: 0 } } }, unsupported: { q4: 0 } }, B: { votes: 4, invalid: 0, excluded: 0, questions: {}, unsupported: {} } } }
    const hc: any = { ballots: { B: { votes: 1, invalid: 1, excluded: 0, questions: { q1: { answered: 0, options: { a: 0 } } }, unsupported: { q3: 0 } } } }
    expect(canonicalJson(addHistograms(e as any, ha))).to.equal(canonicalJson(ha))
    expect(canonicalJson(addHistograms(ha, e as any))).to.equal(canonicalJson(ha))
    expect(canonicalJson(addHistograms(ha, hb))).to.equal(canonicalJson(addHistograms(hb, ha)))
    expect(canonicalJson(addHistograms(addHistograms(ha, hb), hc))).to.equal(canonicalJson(addHistograms(ha, addHistograms(hb, hc))))
    const sum: any = addHistograms(ha, hb)
    expect(canonicalJson(sum)).to.equal(canonicalJson(refAdd(ha, hb)))
    expect(sum.ballots.A.votes).to.equal(5)
    expect(sum.ballots.A.excluded).to.equal(2)
    expect(sum.ballots.A.questions.q1.options).to.deep.equal({ a: 1, b: 1, c: 0 })
    expect(Object.keys(sum.ballots.A.questions)).to.deep.equal(['q1', 'q2'])
    expect(sum.ballots.A.unsupported).to.deep.equal({ q3: 1, q4: 0 })
    expect(Object.keys(sum.ballots)).to.deep.equal(['A', 'B'])
    // frozen inputs stay unchanged; mutating the result does not reach either input
    const fa = freeze(structuredClone(ha))
    const fb = freeze(structuredClone(hb))
    const r1: any = addHistograms(fa, fb)
    r1.ballots.B.votes = 99
    r1.ballots.A.questions.q1.options.a = 99
    expect(canonicalJson(fa)).to.equal(canonicalJson(ha))
    expect(canonicalJson(fb)).to.equal(canonicalJson(hb))
    const solo: any = addHistograms(fa, e as any)
    expect(solo.ballots.A).to.not.equal(fa.ballots.A)
    // Object.keys order equals the sorted order at every level (integer-like keys are listed first by the
    // engine whatever the insertion order; that exception is documented and not asserted)
    const isInt = (k: string): boolean => /^(0|[1-9]\d*)$/.test(k)
    const checkOrder = (o: any): void => {
      if (o === null || typeof o !== 'object') return
      const ks = Object.keys(o).filter(k => !isInt(k))
      expect(ks).to.deep.equal([...ks].sort())
      for (const k of Object.keys(o)) checkOrder(o[k])
    }
    checkOrder(sum)
  })

  it('TH-3 tallyTreeFrom: every leaf and every parent', () => {
    const { tree, validation, blocks } = syntheticSet()
    const ballots = templates()
    const r = tallyTreeFrom(tree, validation, ballots)
    expect(r.ok).to.equal(true)
    if (!r.ok) return
    const t: any = r.tally
    expect(t.format).to.equal('vt-tally-tree/1')
    expect(t.electionId).to.equal(FIXTURE_ELECTION_ID)
    expect(t.size).to.equal(5)
    expect(t.nodes.length).to.equal(9)
    expect(t.blockRoot).to.equal(tree.root)
    const tmpl = (id: string): any => ballots.find(b => b.id === id)
    t.nodes.forEach((n: any, i: number) => {
      const rn: any = tree.nodes[i]
      expect(n.index).to.equal(rn.index)
      expect(n.range).to.deep.equal(rn.range)
      expect(n.left).to.equal(rn.left)
      expect(n.right).to.equal(rn.right)
      expect(n.merkleHash).to.equal(rn.hash)
      expect(n.hash).to.equal(refNodeHash(t, i))
      if (rn.range[1] - rn.range[0] === 1) {
        const leaf: any = tree.leaves[rn.range[0]]
        const f = blocks[tree.leaves.findIndex((l: any) => l.cid === leaf.cid)]
        expect(Object.keys(n.histogram.ballots)).to.deep.equal([leaf.ballotId])
        const mine = n.histogram.ballots[leaf.ballotId]
        expect(mine.votes).to.equal(leaf.entryCount)
        expect(mine.excluded).to.equal(0)
        expect(mine.invalid).to.equal(f.votes.filter((v: any) => v.status === 'invalid').length)
        expect(canonicalJson(mine)).to.equal(canonicalJson(refLeafCounts(tmpl(leaf.ballotId), f.votes)))
        expect(Object.keys(mine.questions)).to.deep.equal(['q1', 'q2'])
        expect(mine.questions.q1.options).to.have.all.keys('a', 'b', 'c')
        expect(mine.unsupported).to.have.all.keys('q3')
      } else {
        expect(canonicalJson(n.histogram)).to.equal(canonicalJson(refAdd(t.nodes[rn.left].histogram, t.nodes[rn.right].histogram)))
      }
    })
    t.leaves.forEach((l: any, i: number) => {
      expect(l.index).to.equal(i)
      expect(l.disposition).to.equal('tallied')
      expect(l.excludedFor).to.deep.equal([])
      expect(l.leafData).to.equal(tree.leaves[i]!.leafData)
    })
    expect(canonicalJson(t.histogram)).to.equal(canonicalJson(t.nodes[8].histogram))
    expect(t.root).to.equal(t.nodes[8].hash)
    // q3 (rank) is only ever under unsupported
    for (const n of t.nodes) for (const b of Object.values<any>(n.histogram.ballots)) expect(b.questions).to.not.have.property('q3')
    // the totals line up: valid votes that answered q3 = ceil(valid/2) per block
    const root = t.histogram.ballots
    expect(root['ballot-a'].votes + root['ballot-b'].votes).to.equal(18)
  })

  it('TH-4 an R7-invalid block is excluded, not tallied', () => {
    const { tree, validation } = syntheticSet({ invalidBlock: 2 })
    const r = tallyTreeFrom(tree, validation, templates())
    expect(r.ok).to.equal(true)
    if (!r.ok) return
    const t: any = r.tally
    expect(t.leaves[2].disposition).to.equal('excluded')
    expect(t.leaves[2].excludedFor).to.deep.equal(['cid-mismatch', 'consent-signature-invalid'])
    for (const i of [0, 1, 3, 4]) {
      expect(t.leaves[i].disposition).to.equal('tallied')
      expect(t.leaves[i].excludedFor).to.deep.equal([])
    }
    const leafNode = t.nodes.find((n: any) => n.range[0] === 2 && n.range[1] === 3)
    const mine = leafNode.histogram.ballots['ballot-b']
    expect(mine.votes).to.equal(3)
    expect(mine.excluded).to.equal(3)
    expect(mine.invalid).to.equal(0)
    for (const q of Object.values<any>(mine.questions)) {
      expect(q.answered).to.equal(0)
      for (const c of Object.values<any>(q.options)) expect(c).to.equal(0)
    }
    for (const c of Object.values<any>(mine.unsupported)) expect(c).to.equal(0)
    // ballot-b's other block is unaffected
    const other = t.nodes.find((n: any) => n.range[0] === 4 && n.range[1] === 5).histogram.ballots['ballot-b']
    expect(other.excluded).to.equal(0)
    // votes = valid + invalid + excluded at the root, valid counted by the spec itself
    const rb = t.histogram.ballots['ballot-b']
    expect(rb.votes).to.equal(8)
    expect(rb.excluded).to.equal(3)
    const validB = 5 - rb.invalid
    expect(rb.votes).to.equal(validB + rb.invalid + rb.excluded)
  })

  it('TH-5 refusals, none throwing', () => {
    const base = (): any => syntheticSet()
    const go = (tree: any, validation: any, ballots: any = templates()): any => tallyTreeFrom(tree, validation, ballots)
    const reason = (r: any): string => (r.ok ? 'ok' : r.reason)
    let s = base()
    expect(reason(go(s.tree, { ...s.validation, ok: false, reason: 'secret-mismatch', detail: 'x' }))).to.equal('malformed-input')
    expect(reason(go(s.tree, { ...s.validation, released: false }))).to.equal('not-released')
    expect(reason(go(s.tree, { ...s.validation, electionId: 'other' }))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, { ...s.validation, electionRevision: 9 }))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, { ...s.validation, blocks: s.validation.blocks.slice(1) }))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, { ...s.validation, blocks: [...s.validation.blocks, s.validation.blocks[0]] }))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, { ...s.validation, blocks: s.validation.blocks.map((b: any, i: number) => (i === 1 ? { ...b, status: 'not-decryptable-yet', votes: [] } : b)) }))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, { ...s.validation, blocks: s.validation.blocks.map((b: any, i: number) => (i === 1 ? { ...b, votes: b.votes.slice(1) } : b)) }))).to.equal('inconsistent-inputs')
    const withEntry = (mut: (e: any) => void): any => ({
      ...s.validation,
      blocks: s.validation.blocks.map((b: any, i: number) => {
        if (i !== 0) return b
        const votes = structuredClone(b.votes)
        const v = votes.find((x: any) => x.status === 'valid')
        mut(v.entry)
        return { ...b, votes }
      })
    })
    expect(reason(go(s.tree, withEntry(e => { e.answers[0].questionCode = 'q9' })))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, withEntry(e => { e.answers[0].optionCodes = ['zz'] })))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, withEntry(e => { e.answers = 'x' })))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, s.validation, [makeFixtureTemplate('ballot-a')]))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, s.validation, 'x'))).to.equal('malformed-input')
    expect(reason(go(s.tree, s.validation, [{ ...templates()[0], questions: 'x' }, templates()[1]]))).to.equal('malformed-input')
    expect(reason(go(s.tree, s.validation, [{ ...templates()[0], questions: [{ title: 't', options: [] }] }, templates()[1]]))).to.equal('malformed-input')
    expect(reason(go(s.tree, s.validation, [{ ...templates()[0], questions: [{ code: 'q', title: 't', options: [{ title: 'x' }] }] }, templates()[1]]))).to.equal('malformed-input')
    expect(reason(go(s.tree, s.validation, [templates()[0], templates()[0]]))).to.equal('malformed-input')
    expect(reason(go(null, s.validation))).to.equal('malformed-input')
    expect(reason(go({ leaves: [] }, s.validation))).to.equal('malformed-input')
    expect(reason(go(s.tree, null))).to.equal('malformed-input')
    expect(reason(go(s.tree, 5))).to.equal('malformed-input')
    s = base()
    expect(reason(go(s.tree, s.validation))).to.equal('ok')
  })

  it('TH-7 (WR-04) excluded leaves count attestedEntries; a sum past 2^53 - 1 is refused, never emitted', () => {
    const invalid = (r: any, attested: unknown): any => blockFinding(r, {
      status: 'invalid', attestedEntries: attested, findings: [{ blockCid: r.Cid, code: 'consent-signature-invalid', severity: 'error', detail: 'x' }]
    })
    const big = [row('bca', 'ballot-a', Number.MAX_SAFE_INTEGER), row('bcb', 'ballot-a', Number.MAX_SAFE_INTEGER)]
    const built = buildBlockTree(big, scope, NOAUTH)
    if (!built.ok) throw new Error('tree')
    const few: any = tallyTreeFrom(built.tree, report(big.map(r => invalid(r, 2))), templates())
    expect(few.ok, JSON.stringify(few)).to.equal(true)
    expect(few.tally.histogram.ballots['ballot-a']).to.include({ votes: 4, excluded: 4 })
    expect(verifyTallyTree(few.tally)).to.deep.equal({ ok: true })
    const over: any = tallyTreeFrom(built.tree, report(big.map(r => invalid(r, Number.MAX_SAFE_INTEGER))), templates())
    expect(over).to.deep.include({ ok: false, reason: 'count-overflow' })
    for (const bad of [undefined, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 2]) {
      const one = [row('bca', 'ballot-a', 3)]
      const t = buildBlockTree(one, scope, NOAUTH)
      if (!t.ok) throw new Error('tree')
      expect(tallyTreeFrom(t.tree, report([invalid(one[0], bad === Number.MAX_SAFE_INTEGER + 2 ? 4 : bad)]), templates()), String(bad)).to.deep.include({ ok: false, reason: 'inconsistent-inputs' })
    }
  })

  it('TH-8 (WR-07) the report must match the tree, and the tree must hash to itself', () => {
    const s = syntheticSet()
    const reason = (tree: any, validation: any): string => { const r: any = tallyTreeFrom(tree, validation, templates()); return r.ok ? 'ok' : r.reason }
    const tree = (): any => ({ ...s.tree, leaves: s.tree.leaves.map((l: any) => ({ ...l })), nodes: s.tree.nodes.map((n: any) => ({ ...n })) })
    const withBlock = (i: number, over: any): any => ({ ...s.validation, blocks: s.validation.blocks.map((b: any, j: number) => (j === i ? { ...b, ...over } : b)) })
    expect(reason(s.tree, s.validation)).to.equal('ok')
    // a report with a block the tree does not have (and one fewer it does), or one block more
    expect(reason(s.tree, withBlock(0, { blockCid: 'bforeign' }))).to.equal('inconsistent-inputs')
    expect(reason(s.tree, { ...s.validation, blocks: [...s.validation.blocks, blockFinding(row('bzz', 'ballot-a', 3))] })).to.equal('inconsistent-inputs')
    expect(reason(s.tree, withBlock(1, { ballotId: 'ballot-b' }))).to.equal('inconsistent-inputs')
    expect(reason(s.tree, withBlock(1, { declaredEntries: 99 }))).to.equal('inconsistent-inputs')
    expect(reason(s.tree, withBlock(1, { blockId: 'id-other' }))).to.equal('inconsistent-inputs')
    // T-65-05-03: findings are matched by leaf hash; a missing, foreign or repeated one is refused
    expect(reason(s.tree, withBlock(1, { leafHash: undefined }))).to.equal('inconsistent-inputs')
    expect(reason(s.tree, withBlock(1, { leafHash: 'ab'.repeat(32) }))).to.equal('inconsistent-inputs')
    expect(reason(s.tree, withBlock(1, { leafHash: s.validation.blocks[0].leafHash }))).to.equal('inconsistent-inputs')
    const flip = (h: string): string => (h[0] === 'a' ? 'b' : 'a') + h.slice(1)
    const t1 = tree(); t1.nodes[0].hash = flip(t1.nodes[0].hash)
    expect(reason(t1, s.validation)).to.equal('inconsistent-inputs')
    const t2 = tree(); t2.nodes[t2.nodes.length - 1].hash = flip(t2.nodes[t2.nodes.length - 1].hash); t2.root = t2.nodes[t2.nodes.length - 1].hash
    expect(reason(t2, s.validation)).to.equal('inconsistent-inputs')
    const t3 = tree(); t3.root = flip(t3.root)
    expect(reason(t3, s.validation)).to.equal('inconsistent-inputs')
    const t4 = tree(); t4.leaves[2].entryCount = 9
    expect(reason(t4, withBlock(2, { declaredEntries: 9 }))).to.equal('inconsistent-inputs')
    const t5 = tree(); t5.nodes[2] = { ...t5.nodes[2], range: [0, 3] }
    expect(reason(t5, s.validation)).to.equal('inconsistent-inputs')
    // a stale tree from other rows does not tally against this report
    const stale = buildBlockTree([row('bca', 'ballot-a', 3), row('bcb', 'ballot-a', 4)], scope, NOAUTH)
    if (!stale.ok) throw new Error('tree')
    expect(reason(stale.tree, s.validation)).to.equal('inconsistent-inputs')
  })

  it('TH-9 (IN-03) R8 reads a question type exactly as R7 does', () => {
    const s = syntheticSet()
    const withQ1Type = (type: unknown): any[] => templates().map((t: any) => ({ ...t, questions: t.questions.map((q: any) => (q.code === 'q1' ? { ...q, type } : q)) }))
    const r: any = tallyTreeFrom(s.tree, s.validation, withQ1Type(null))
    expect(r.ok, JSON.stringify(r)).to.equal(true)
    const plain: any = tallyTreeFrom(s.tree, s.validation, templates())
    expect(canonicalJson(r.tally.histogram)).to.equal(canonicalJson(plain.tally.histogram))
    expect(r.tally.histogram.ballots['ballot-a'].questions).to.have.property('q1')
    for (const type of [5, true, {}]) {
      expect(tallyTreeFrom(s.tree, s.validation, withQ1Type(type)), JSON.stringify(type)).to.deep.include({ ok: false, reason: 'malformed-input' })
    }
  })

  it('TH-6 hostile codes and the empty tree', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort()
    const template: any = makeFixtureTemplate('ballot-a', {
      questions: [{
        code: 'hasOwnProperty', title: 't', type: 'select', optionRange: { min: 1, max: 4 },
        options: ['__proto__', 'constructor', 'toString', '1'].map(code => ({ code, title: code }))
      }, { code: '__proto__', title: 'u', type: 'rank', options: [{ code: 'r', title: 'r' }] }]
    })
    const rows = [row('bca', 'ballot-a', 3)]
    const built = buildBlockTree(rows, scope, NOAUTH)
    if (!built.ok) throw new Error('tree')
    const votes = [
      { index: 0, status: 'valid', entry: entryOf('ballot-a', [['__proto__', ['r']], ['hasOwnProperty', ['1', '__proto__', 'constructor', 'toString']]]) },
      { index: 1, status: 'valid', entry: entryOf('ballot-a', [['hasOwnProperty', ['toString']]]) },
      { index: 2, status: 'valid', entry: entryOf('ballot-a', [['hasOwnProperty', ['__proto__']]]) }
    ]
    const r: any = tallyTreeFrom(built.tree, report([blockFinding(rows[0], { votes })]), [template])
    expect(r.ok).to.equal(true)
    const leaf = r.tally.nodes[0].histogram.ballots['ballot-a']
    const qd = Object.getOwnPropertyDescriptor(leaf.questions, 'hasOwnProperty')!.value
    expect(qd.answered).to.equal(3)
    const opt = (k: string): number => Object.getOwnPropertyDescriptor(qd.options, k)!.value
    expect(opt('1')).to.equal(1)
    expect(opt('__proto__')).to.equal(2)
    expect(opt('constructor')).to.equal(1)
    expect(opt('toString')).to.equal(2)
    expect(Object.getOwnPropertyDescriptor(leaf.unsupported, '__proto__')!.value).to.equal(1)
    expect(Object.getPrototypeOf(qd.options)).to.equal(Object.prototype)
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).to.deep.equal(before)
    expect(({} as any).polluted).to.equal(undefined)
    expect(canonicalJson(JSON.parse(JSON.stringify(r.tally)))).to.equal(canonicalJson(r.tally))

    const empty = buildBlockTree([], scope, NOAUTH)
    if (!empty.ok) throw new Error('empty')
    const er: any = tallyTreeFrom(empty.tree, report([]), templates())
    expect(er.ok).to.equal(true)
    expect(er.tally.size).to.equal(0)
    expect(er.tally.nodes).to.deep.equal([])
    expect(er.tally.leaves).to.deep.equal([])
    expect(er.tally.histogram).to.deep.equal({ ballots: {} })
    expect(er.tally.blockRoot).to.equal(BLOCK_TREE_EMPTY_ROOT)
    expect(er.tally.root).to.equal(refTallyHash(BLOCK_TREE_EMPTY_ROOT, { ballots: {} }))
  })
})

// ---- Part 2: committed fixture blocks ----

/** The spec's own count, straight from each fixture block's voters and the template. Never calls the module. */
function naiveTally (blocks: any[], ballots: any[], excludedCids: Set<string> | Map<string, number> = new Set(), invalidEntries: Set<any> = new Set()): any {
  const out: any = {}
  for (const b of blocks) {
    const id = b.row.BallotId
    const template = ballots.find(t => t.id === id)
    if (!hasOwn(out, id)) {
      const questions: any = {}
      const unsupported: any = {}
      for (const q of template.questions) {
        if (q.type === undefined || q.type === 'select') {
          const options: any = {}
          for (const o of q.options) options[o.code] = 0
          questions[q.code] = { answered: 0, options }
        } else unsupported[q.code] = 0
      }
      out[id] = { votes: 0, invalid: 0, excluded: 0, questions, unsupported }
    }
    const acc = out[id]
    if (excludedCids.has(b.row.Cid)) {
      // WR-04: an excluded block counts its attested entries (a Map gives them; a Set means all of them)
      const n = excludedCids instanceof Map ? excludedCids.get(b.row.Cid)! : b.row.EntryCount
      acc.votes += n
      acc.excluded += n
      continue
    }
    acc.votes += b.row.EntryCount
    for (const v of b.voters) {
      if (invalidEntries.has(v.voteEntry)) { acc.invalid++; continue }
      for (const a of v.voteEntry.answers) {
        if (hasOwn(acc.questions, a.questionCode)) {
          acc.questions[a.questionCode].answered++
          for (const o of a.optionCodes) acc.questions[a.questionCode].options[o]++
        } else acc.unsupported[a.questionCode]++
      }
    }
  }
  return { ballots: out }
}

function walk (v: unknown, visit: (x: unknown) => void): void {
  visit(v)
  if (v !== null && typeof v === 'object') for (const k of Object.keys(v)) walk((v as any)[k], visit)
}

describe('tally tree over committed blocks (65-08: R8, D-80, D-81, D-71)', function () {
  this.timeout(60_000)

  let set: ReturnType<typeof makeCommittedElection>
  let ballots: any[]
  let release: { secretKey: Uint8Array, jointPublicKey: string }
  const input = (over: Record<string, unknown> = {}): any => ({
    scope, rows: set.rows, voterRows: set.voterRows, ballots, ...set.authorization, release, ...over
  })

  before(() => {
    set = makeCommittedElection({ ballotIds: ['ballot-a', 'ballot-b'], blocks: [{ size: 3 }, { size: 4 }, { ballotIndex: 1, size: 3 }, { size: 3, payloadVersion: 1 }] })
    ballots = set.election.ballots.map(b => b.template)
    release = { secretKey: set.election.electionSecret, jointPublicKey: set.election.electionKey.jointPublicKey }
  })

  /** votes = valid + invalid + excluded at every node, valid taken from the spec's own count at the root. */
  function checkInvariants (tally: any, expected: any): void {
    for (const n of tally.nodes) {
      const [lo, hi] = n.range
      const sums: any = {}
      for (let i = lo; i < hi; i++) {
        const l = tally.leaves[i]
        const leafNode = tally.nodes.find((x: any) => x.range[0] === i && x.range[1] === i + 1)
        const counted = l.disposition === 'tallied' ? l.entryCount : leafNode.histogram.ballots[l.ballotId].votes
        if (l.disposition !== 'tallied') expect(counted).to.be.at.most(l.entryCount)
        sums[l.ballotId] = (sums[l.ballotId] ?? 0) + counted
      }
      expect(Object.keys(n.histogram.ballots).sort()).to.deep.equal(Object.keys(sums).sort())
      for (const [id, b] of Object.entries<any>(n.histogram.ballots)) {
        expect(b.votes).to.equal(sums[id])
        const valid = b.votes - b.invalid - b.excluded
        expect(valid).to.be.at.least(0)
        expect(b.votes).to.equal(valid + b.invalid + b.excluded)
        for (const q of Object.values<any>(b.questions)) {
          expect(q.answered).to.be.at.most(valid)
          for (const c of Object.values<any>(q.options)) expect(c).to.be.at.most(q.answered)
        }
      }
    }
    expect(canonicalJson(tally.histogram)).to.equal(canonicalJson(expected))
  }

  it('TB-1 composition with R5 and R7', () => {
    const auth = { voterRows: set.voterRows, ...set.authorization, ballots }
    const rootBefore = (() => { const b = buildBlockTree(set.rows, scope, auth); if (!b.ok) throw new Error('b'); return b.tree })()
    const r: any = buildTallyTree(input())
    expect(r.ok, JSON.stringify(r)).to.equal(true)
    const rootAfter: any = (buildBlockTree(set.rows, scope, auth) as any).tree
    expect(r.tally.blockRoot).to.equal(rootBefore.root)
    expect(r.tally.blockRoot).to.equal(rootAfter.root)
    expect(r.blockTree.root).to.equal(r.tally.blockRoot)
    r.tally.nodes.forEach((n: any, i: number) => expect(n.merkleHash).to.equal(rootBefore.nodes[i]!.hash))
    expect(r.validation).to.deep.equal(validateElectionBlocks(input()))
    const expected = naiveTally(set.blocks, ballots)
    checkInvariants(r.tally, expected)
    const total = Object.values<any>(r.tally.histogram.ballots).reduce((a, b) => a + b.votes, 0)
    expect(total).to.equal(13)
    expect(total).to.equal(r.validation.totals.entries)
    for (const l of r.tally.leaves) expect(l.disposition).to.equal('tallied')
    expect(r.tally.histogram.ballots['ballot-b'].votes).to.equal(3)
    const v1 = set.blocks[3]!
    const leafNode = r.tally.nodes.find((n: any) => n.range[1] - n.range[0] === 1 && r.tally.leaves[n.range[0]].blockCid === v1.row.Cid)
    expect(canonicalJson(leafNode.histogram)).to.equal(canonicalJson(naiveTally([v1], ballots)))
    const last = r.tally.nodes.length - 1
    expect(r.tally.root).to.equal(refParentTallyHash(rootBefore.root, r.tally.nodes[r.tally.nodes[last].left].hash, r.tally.nodes[r.tally.nodes[last].right].hash, r.tally.histogram))
  })

  it('TB-2 per-vote invalid votes (D-71 via R7) are counted apart', () => {
    const e = makeFixtureElection({ ballotIds: ['ballot-a'] })
    const ballot = e.ballots[0]!
    const nonce = (): string => makeVoteNonce(globalThis.crypto.getRandomValues(new Uint8Array(32)))
    const base: any = buildVoteEntry({ ballot: ballot.template, electionRevision: FIXTURE_REVISION, selections: { q1: ['a'], q2: ['x'] }, nonce: nonce() })
    const tooMany = { ...base, nonce: nonce(), answers: [{ questionCode: 'q1', optionCodes: ['a', 'b'] }, { questionCode: 'q2', optionCodes: ['x'] }] }
    const unknown = { ...base, nonce: nonce(), answers: [{ questionCode: 'q1', optionCodes: ['zz'] }, { questionCode: 'q2', optionCodes: ['x'] }] }
    const voters = [
      makeFixtureVoter(e, ballot, 0, { selections: { q1: ['a'], q2: ['x', 'y'] } }),
      makeFixtureVoter(e, ballot, 1, { selections: { q1: ['c'], q2: ['y'] } }),
      makeFixtureVoter(e, ballot, 2, { voteEntry: tooMany }),
      makeFixtureVoter(e, ballot, 3, { voteEntry: unknown })
    ]
    const fx = makeCommittedBlock(e, ballot, voters)
    const inp = { scope, rows: [fx.row], voterRows: fx.voterRows, ballots: [ballot.template], ...fixtureAuthorization(voters), release: { secretKey: e.electionSecret, jointPublicKey: e.electionKey.jointPublicKey } }
    const r: any = buildTallyTree(inp as any)
    expect(r.ok, JSON.stringify(r)).to.equal(true)
    const leaf = r.tally.nodes[0].histogram.ballots['ballot-a']
    expect(r.tally.leaves[0].disposition).to.equal('tallied')
    expect(leaf.votes).to.equal(4)
    expect(leaf.invalid).to.equal(2)
    expect(leaf.excluded).to.equal(0)
    expect(canonicalJson(r.tally.histogram)).to.equal(canonicalJson(naiveTally([fx], [ballot.template], new Set(), new Set([tooMany, unknown]))))
    expect(r.validation.totals.valid).to.equal(2)
    expect(r.validation.totals.valid).to.equal(leaf.votes - leaf.invalid - leaf.excluded)
  })

  it('TB-3 D-81: non-select questions are only ever under unsupported', () => {
    const sel = (i: number): Record<string, string[]> => ({
      q1: ['a'], q2: ['x'], ...(i % 3 === 0 ? {} : i % 2 === 1 ? { q3: ['r1'] } : { q3: ['r1', 'r2'] })
    })
    const s = makeCommittedElection({ ballotIds: ['ballot-a'], blocks: [{ size: 3, selections: sel }, { size: 3, selections: sel }] })
    const bt = s.election.ballots.map(b => b.template)
    const r: any = buildTallyTree({ scope, rows: s.rows, voterRows: s.voterRows, ballots: bt, ...s.authorization, release: { secretKey: s.election.electionSecret, jointPublicKey: s.election.electionKey.jointPublicKey } } as any)
    expect(r.ok, JSON.stringify(r)).to.equal(true)
    const root = r.tally.histogram.ballots['ballot-a']
    expect(root.unsupported).to.deep.equal({ q3: 4 })
    expect(root.questions).to.not.have.property('q3')
    expect(Object.keys(root.questions)).to.deep.equal(['q1', 'q2'])
    for (const n of r.tally.nodes) expect(n.histogram.ballots['ballot-a'].questions).to.not.have.property('q3')

    const tpl: any = makeFixtureTemplate('ballot-a', {
      questions: [
        { code: 'q1', title: 'one', type: 'select', optionRange: { min: 1, max: 1 }, options: [{ code: 'a', title: 'A' }, { code: 'b', title: 'B' }] },
        { code: 'q4', title: 'four', type: 'score', optionRange: { min: 1, max: 1 }, options: [{ code: 's1', title: 'S1' }, { code: 's2', title: 'S2' }] },
        { code: 'q5', title: 'five', type: 'text', options: [] }
      ]
    })
    const e = makeFixtureElection({ templates: [tpl] })
    const ballot = e.ballots[0]!
    const voters = [
      makeFixtureVoter(e, ballot, 0, { selections: { q1: ['a'], q4: ['s1'] } }),
      makeFixtureVoter(e, ballot, 1, { selections: { q1: ['b'], q4: ['s2'] } }),
      makeFixtureVoter(e, ballot, 2, { selections: { q1: ['a'] } })
    ]
    const fx = makeCommittedBlock(e, ballot, voters)
    const r2: any = buildTallyTree({ scope, rows: [fx.row], voterRows: fx.voterRows, ballots: [tpl], ...fixtureAuthorization(voters), release: { secretKey: e.electionSecret, jointPublicKey: e.electionKey.jointPublicKey } } as any)
    expect(r2.ok, JSON.stringify(r2)).to.equal(true)
    const h = r2.tally.histogram.ballots['ballot-a']
    expect(h.unsupported).to.deep.equal({ q4: 2, q5: 0 })
    expect(Object.keys(h.questions)).to.deep.equal(['q1'])
    expect(h.questions.q1).to.deep.equal({ answered: 3, options: { a: 2, b: 1 } })
  })

  describe('TB-4 block-level policy', () => {
    const flip = (hex: string): string => (hex[0] === '0' ? '1' : '0') + hex.slice(1)

    it('TB-4a a failed consent signature excludes its block', () => {
      const victim = set.blocks[1]!
      const target = victim.voterRows[2]!
      const voterRows = set.voterRows.map(v => (v === target ? { ...v, Signature: flip(v.Signature) } : v))
      const r: any = buildTallyTree(input({ voterRows }))
      expect(r.ok, JSON.stringify(r)).to.equal(true)
      r.tally.leaves.forEach((l: any) => {
        if (l.blockCid === victim.row.Cid) {
          expect(l.disposition).to.equal('excluded')
          expect(l.excludedFor).to.include('consent-signature-invalid')
        } else expect(l.disposition).to.equal('tallied')
      })
      // WR-04: 3 of the 4 listed voters still carry authenticated consent, so 3 entries are excluded
      expect(r.validation.blocks.find((b: any) => b.blockCid === victim.row.Cid).attestedEntries).to.equal(3)
      const expected = naiveTally(set.blocks, ballots, new Map([[victim.row.Cid, 3]]))
      checkInvariants(r.tally, expected)
      expect(r.tally.histogram.ballots['ballot-a'].excluded).to.equal(3)
      expect(r.tally.histogram.ballots['ballot-a'].votes).to.equal(3 + 3 + 3)
      // WR-05: R7's totals are R8's root, summed over the ballots
      const root = Object.values<any>(r.tally.histogram.ballots)
      const sum = (k: string): number => root.reduce((a, b) => a + b[k], 0)
      expect(r.validation.totals).to.include({ entries: sum('votes'), invalid: sum('invalid'), excluded: sum('excluded'), undecryptable: 0 })
      expect(r.validation.totals.valid).to.equal(sum('votes') - sum('invalid') - sum('excluded'))
    })

    it('TB-4b a missing voter row excludes its block', () => {
      const victim = set.blocks[0]!
      const voterRows = set.voterRows.filter(v => v !== victim.voterRows[1])
      const r: any = buildTallyTree(input({ voterRows }))
      expect(r.ok, JSON.stringify(r)).to.equal(true)
      const leaf = r.tally.leaves.find((l: any) => l.blockCid === victim.row.Cid)
      expect(leaf.disposition).to.equal('excluded')
      expect(leaf.excludedFor).to.include('voter-row-missing')
      checkInvariants(r.tally, naiveTally(set.blocks, ballots, new Map([[victim.row.Cid, 2]])))
    })

    it('TB-4c a registrant in two blocks excludes both', () => {
      const e = makeFixtureElection({ ballotIds: ['ballot-a'] })
      const ballot = e.ballots[0]!
      const vs = [0, 1, 2, 3, 4].map(i => makeFixtureVoter(e, ballot, i))
      const A = makeCommittedBlock(e, ballot, [vs[0]!, vs[1]!, vs[2]!])
      const B = makeCommittedBlock(e, ballot, [vs[0]!, vs[3]!, vs[4]!])
      const r: any = buildTallyTree({
        scope, rows: [A.row, B.row], voterRows: [...A.voterRows, ...B.voterRows], ballots: [ballot.template], ...fixtureAuthorization(vs),
        release: { secretKey: e.electionSecret, jointPublicKey: e.electionKey.jointPublicKey }
      } as any)
      expect(r.ok, JSON.stringify(r)).to.equal(true)
      for (const l of r.tally.leaves) {
        expect(l.disposition).to.equal('excluded')
        expect(l.excludedFor).to.include('registrant-in-two-blocks')
      }
      checkInvariants(r.tally, naiveTally([A, B], [ballot.template], new Set([A.row.Cid, B.row.Cid])))
      const root = r.tally.histogram.ballots['ballot-a']
      expect(root.votes).to.equal(6)
      expect(root.excluded).to.equal(6)
    })
  })

  it('TB-4d (CR-02, CR-03) a forged block is excluded and never displaces the honest block it names', () => {
    const honest = set.blocks[0]!
    const victim = honest.voters[0]!
    const ballot = set.election.ballots[0]!
    // B' lists the victim with a stranger key, and two unregistered strangers who sign their own consent
    const strangers = [makeFixtureVoter(set.election, ballot, 300), makeFixtureVoter(set.election, ballot, 301)]
    const forged = makeCommittedBlock(set.election, ballot, [{ ...victim, pubHex: strangers[0]!.pubHex, priv: strangers[0]!.priv } as any, ...strangers])
    const flip = (hex: string): string => (hex[0] === '0' ? '1' : '0') + hex.slice(1)
    const extra = { ...honest.voterRows[1]!, Signature: flip(honest.voterRows[1]!.Signature) }
    const r: any = buildTallyTree(input({ rows: [...set.rows, forged.row], voterRows: [...set.voterRows, ...forged.voterRows, extra] }))
    expect(r.ok, JSON.stringify(r)).to.equal(true)
    const leafOf = (cid: string): any => r.tally.leaves.find((l: any) => l.blockCid === cid)
    expect(leafOf(honest.row.Cid).disposition).to.equal('tallied')
    expect(leafOf(forged.row.Cid).disposition).to.equal('excluded')
    expect(leafOf(forged.row.Cid).excludedFor).to.include.members(['device-key-not-associated', 'voter-not-registered'])
    expect(leafOf(forged.row.Cid).excludedFor).to.not.include('registrant-in-two-blocks')
    for (const b of set.blocks) expect(leafOf(b.row.Cid).disposition).to.equal('tallied')
    expect(r.validation.findings.map((f: any) => f.code)).to.deep.equal(['voter-row-forged'])
    // WR-04: no voter of the forged block is authenticated, so it excludes nothing
    expect(r.tally.nodes.find((n: any) => n.range[1] - n.range[0] === 1 && r.tally.leaves[n.range[0]].blockCid === forged.row.Cid).histogram.ballots['ballot-a']).to.include({ votes: 0, excluded: 0 })
    const clean = naiveTally(set.blocks, ballots)
    const got = r.tally.histogram.ballots['ballot-a']
    expect(got.questions).to.deep.equal(clean.ballots['ballot-a'].questions)
  })

  it('TB-4e (WR-04) a hostile EntryCount cannot inflate the excluded volume or break the verifier', () => {
    const ballot = set.election.ballots[0]!
    const strangers = [0, 1, 2].map(i => makeFixtureVoter(set.election, ballot, 400 + i))
    const huge = makeCommittedBlock(set.election, ballot, strangers)
    const rows = [...set.rows, { ...huge.row, EntryCount: Number.MAX_SAFE_INTEGER }, { ...huge.row, Cid: 'bhugecopy', EntryCount: Number.MAX_SAFE_INTEGER }]
    const r: any = buildTallyTree(input({ rows, voterRows: [...set.voterRows, ...huge.voterRows] }))
    expect(r.ok, JSON.stringify(r)).to.equal(true)
    expect(r.tally.histogram.ballots['ballot-a'].excluded).to.equal(0)
    expect(verifyTallyTree(r.tally)).to.deep.equal({ ok: true })
    expect(verifyTallyTree(JSON.parse(JSON.stringify(r.tally)))).to.deep.equal({ ok: true })
  })

  it('TB-5 determinism for any input order and for bigint columns', () => {
    const a: any = buildTallyTree(input())
    const b: any = buildTallyTree(input())
    expect(canonicalJson(a.tally)).to.equal(canonicalJson(b.tally))
    for (const seed of [1, 2, 3]) {
      const r: any = buildTallyTree(input({
        rows: seededShuffle(set.rows, seed), voterRows: seededShuffle(set.voterRows, seed), ballots: seededShuffle(ballots, seed)
      }))
      expect(canonicalJson(r.tally), `seed ${seed}`).to.equal(canonicalJson(a.tally))
    }
    const big: any = buildTallyTree(input({
      rows: set.rows.map(r => ({ ...r, ElectionRevision: BigInt(r.ElectionRevision), EntryCount: BigInt(r.EntryCount) })),
      voterRows: set.voterRows.map(v => ({ ...v, ElectionRevision: BigInt(v.ElectionRevision) }))
    }))
    expect(big.ok, JSON.stringify(big)).to.equal(true)
    expect(canonicalJson(big.tally)).to.equal(canonicalJson(a.tally))
  })

  it('TB-6 refusals, secret handling and privacy', () => {
    const reason = (x: any): string => (x.ok ? 'ok' : x.reason)
    expect(reason(buildTallyTree(input({ release: undefined })))).to.equal('not-released')
    expect(reason(buildTallyTree(input({ release: null })))).to.equal('not-released')
    const wrong = { secretKey: secp256k1.utils.randomSecretKey(), jointPublicKey: release.jointPublicKey }
    expect(reason(buildTallyTree(input({ release: wrong })))).to.equal('secret-mismatch')
    // WR-06: a duplicate or malformed row is set aside, so the tally still exists and equals the clean one
    const clean: any = buildTallyTree(input())
    const noisy: any = buildTallyTree(input({ rows: [...set.rows, set.rows[0], null, { ...set.rows[1]!, Cid: 'NOT-BASE32' }] }))
    expect(noisy.ok, JSON.stringify(noisy)).to.equal(true)
    expect(noisy.tally.root).to.equal(clean.tally.root)
    expect(noisy.blockTree.rejected.map((x: any) => x.reason)).to.deep.equal(['malformed-row', 'malformed-row', 'duplicate-block'])
    expect(noisy.validation.findings.map((f: any) => f.code)).to.deep.equal(['malformed-row', 'malformed-row', 'duplicate-block'])
    // T-65-05-03: a row reusing an honest Id under its own Cid is its own leaf, excluded with no attested volume;
    // the honest block is tallied, so the outcome equals the clean one
    const sameId = { ...set.rows[0]!, Cid: blockCidOf('forged text'), Ciphertext: 'forged text' }
    const shared: any = buildTallyTree(input({ rows: [sameId, ...set.rows] }))
    expect(shared.ok, JSON.stringify(shared).slice(0, 300)).to.equal(true)
    expect(shared.tally.size).to.equal(clean.tally.size + 1)
    expect(shared.tally.histogram).to.deep.equal(clean.tally.histogram)
    const forgedLeaf = shared.tally.leaves.find((l: any) => l.blockCid === sameId.Cid)
    expect(forgedLeaf.disposition).to.equal('excluded')
    expect(shared.tally.leaves.find((l: any) => l.blockCid === set.rows[0]!.Cid).disposition).to.equal('tallied')
    expect(verifyTallyTree(shared.tally).ok).to.equal(true)
    // the authorization is R5's input too: an unreadable one is refused before any decryption
    expect(reason(buildTallyTree(input({ timeline: undefined })))).to.equal('malformed-input')
    expect(reason(buildTallyTree(input({ ballots: 'x' })))).to.equal('malformed-input')
    expect(reason(buildTallyTree(input({ rows: [...set.rows, { ...set.rows[0]!, Cid: 'bzz', Id: 'zz', ElectionId: 'other' }] })))).to.equal('mixed-election')
    expect(reason(buildTallyTree(input({ rows: 'x' })))).to.equal('malformed-row')
    expect(reason(buildTallyTree(null as any))).to.equal('malformed-input')
    expect(reason(buildTallyTree({ scope: 5 } as any))).to.equal('malformed-input')

    const before = Uint8Array.from(release.secretKey)
    const r: any = buildTallyTree(input())
    expect(r.ok).to.equal(true)
    expect(Array.from(release.secretKey)).to.deep.equal(Array.from(before))
    walk(r.tally, x => {
      expect(x instanceof Uint8Array).to.equal(false)
      expect(typeof x).to.not.equal('function')
    })
    const text = canonicalJson(r.tally)
    for (const b of set.blocks) {
      for (const v of b.voters) {
        expect(text).to.not.include(v.voteEntry.nonce)
        expect(text).to.not.include(v.voterEntry.registrantId)
        expect(text).to.not.include(v.pubHex)
      }
    }
  })
})

// ---- Part 3: verifyTallyTree ----
//
// What verification proves: every histogram, merkle hash and tally hash in the document is consistent and the
// branch from each leaf to the root holds. It does NOT prove faithfulness to the decrypted blocks: a tally built
// from tampered inputs (a flipped consent signature, TB-4a) verifies on its own. Faithfulness is checked by
// recomputing with buildTallyTree over the rows and comparing roots (TV-5).

describe('verify tally tree (65-08: R8, comprehensive validation of tally nodes)', function () {
  this.timeout(60_000)

  let set: ReturnType<typeof makeCommittedElection>
  let ballots: any[]
  let release: { secretKey: Uint8Array, jointPublicKey: string }
  let good: any
  let excludedTally: any
  let single: any
  let empty: any
  const flip = (hex: string): string => (hex[0] === '0' ? '1' : '0') + hex.slice(1)
  const input = (over: Record<string, unknown> = {}): any => ({ scope, rows: set.rows, voterRows: set.voterRows, ballots, ...set.authorization, release, ...over })
  const clone = <T>(x: T): T => structuredClone(x)
  const fails = (t: unknown, reason: string, where: { nodeIndex?: number, leafIndex?: number } = {}): void => {
    const r: any = verifyTallyTree(t)
    expect(r.ok, JSON.stringify(r)).to.equal(false)
    expect(r.reason, r.detail).to.equal(reason)
    if (where.nodeIndex !== undefined) expect(r.nodeIndex).to.equal(where.nodeIndex)
    if (where.leafIndex !== undefined) expect(r.leafIndex).to.equal(where.leafIndex)
  }
  const rehash = (t: any, ...idx: number[]): any => {
    for (const i of idx) t.nodes[i].hash = refNodeHash(t, i)
    return t
  }
  const parentOf = (t: any, i: number): number => t.nodes.findIndex((n: any) => n.left === i || n.right === i)
  const ballotOf = (t: any, i: number): any => Object.values<any>(t.nodes[i].histogram.ballots)[0]
  const firstOption = (b: any): [string, string] => {
    const q = Object.keys(b.questions)[0]!
    return [q, Object.keys(b.questions[q].options).find(o => b.questions[q].options[o] >= 1)!]
  }

  before(() => {
    set = makeCommittedElection({ ballotIds: ['ballot-a', 'ballot-b'], blocks: [{ size: 3 }, { size: 4 }, { ballotIndex: 1, size: 3 }, { size: 3, payloadVersion: 1 }] })
    ballots = set.election.ballots.map(b => b.template)
    release = { secretKey: set.election.electionSecret, jointPublicKey: set.election.electionKey.jointPublicKey }
    good = (buildTallyTree(input()) as any).tally
    const victim = set.blocks[1]!.voterRows[2]!
    excludedTally = (buildTallyTree(input({ voterRows: set.voterRows.map(v => (v === victim ? { ...v, Signature: flip(v.Signature) } : v)) })) as any).tally
    const one = makeCommittedElection({ ballotIds: ['ballot-a'], blocks: [{ size: 3 }] })
    single = (buildTallyTree({
      scope, rows: one.rows, voterRows: one.voterRows, ballots: one.election.ballots.map(b => b.template), ...one.authorization,
      release: { secretKey: one.election.electionSecret, jointPublicKey: one.election.electionKey.jointPublicKey }
    } as any) as any).tally
    empty = (buildTallyTree(input({ rows: [], voterRows: [] })) as any).tally
  })

  it('TV-1 good tallies verify, as built and after a JSON round trip', () => {
    for (const [name, t] of [['good', good], ['excluded', excludedTally], ['single', single], ['empty', empty]] as Array<[string, any]>) {
      expect(t, name).to.be.an('object')
      expect(verifyTallyTree(t), name).to.deep.equal({ ok: true })
      expect(verifyTallyTree(JSON.parse(JSON.stringify(t))), `${name} json`).to.deep.equal({ ok: true })
    }
    expect(good.nodes.length).to.equal(7)
    expect(single.nodes.length).to.equal(1)
    expect(empty.size).to.equal(0)
    expect(excludedTally.leaves.some((l: any) => l.disposition === 'excluded')).to.equal(true)
  })

  describe('TV-2 tamper, exact reason and index', () => {
    it('a flipped leaf node hash', () => {
      const t = clone(good)
      t.nodes[0].hash = flip(t.nodes[0].hash)
      fails(t, 'tally-hash-mismatch', { nodeIndex: 0 })
    })

    it('leaf-bound edits are caught at the leaf', () => {
      const t = clone(good)
      const b = ballotOf(t, 0)
      const [q, o] = firstOption(b)
      b.questions[q].answered += 1
      b.questions[q].options[o] += 1
      rehash(t, 0)
      fails(t, 'histogram-mismatch', { nodeIndex: 0 })
      const u = clone(good)
      const ub = ballotOf(u, 0)
      const [uq, uo] = firstOption(ub)
      ub.questions[uq].options[uo] = ub.questions[uq].answered + 1
      rehash(u, 0)
      fails(u, 'histogram-mismatch', { nodeIndex: 0 })
    })

    it('parent-sum cases', () => {
      const t = clone(good)
      const b = ballotOf(t, 0)
      const [q, o] = firstOption(b)
      b.questions[q].options[o] -= 1
      rehash(t, 0)
      fails(t, 'histogram-mismatch', { nodeIndex: parentOf(t, 0) })
      expect(parentOf(t, 0)).to.equal(2)
      const u = clone(good)
      const ub = Object.values<any>(u.nodes[2].histogram.ballots)[0]
      ub.questions.q1.options.a += 1
      rehash(u, 2)
      fails(u, 'histogram-mismatch', { nodeIndex: 2 })
    })

    it('merkle hash, leaf data and relabelled disposition', () => {
      const t = clone(good)
      t.nodes[2].merkleHash = flip(t.nodes[2].merkleHash)
      fails(t, 'merkle-hash-mismatch', { nodeIndex: 2 })
      const u = clone(good)
      u.nodes[0].merkleHash = flip(u.nodes[0].merkleHash)
      fails(u, 'merkle-hash-mismatch', { nodeIndex: 0 })
      const v = clone(good)
      const parsed = JSON.parse(v.leaves[1].leafData)
      parsed[2] = 'ballot-z'
      v.leaves[1].leafData = canonicalJson(parsed)
      fails(v, 'leaf-mismatch', { leafIndex: 1 })
      const x = clone(excludedTally)
      const li = x.leaves.findIndex((l: any) => l.disposition === 'excluded')
      x.leaves[li].disposition = 'tallied'
      x.leaves[li].excludedFor = []
      const leafNode = x.nodes.findIndex((n: any) => n.range[1] - n.range[0] === 1 && n.range[0] === li)
      fails(x, 'histogram-mismatch', { nodeIndex: leafNode })
    })

    it('root fields', () => {
      const t = clone(good)
      t.root = flip(t.root)
      fails(t, 'root-mismatch')
      const u = clone(good)
      Object.values<any>(u.histogram.ballots)[0].votes += 1
      fails(u, 'root-mismatch')
      const v = clone(good)
      v.blockRoot = flip(v.blockRoot)
      fails(v, 'root-mismatch')
      const w = clone(good)
      const last = w.nodes.length - 1
      Object.values<any>(w.nodes[last].histogram.ballots)[0].votes += 1
      w.histogram = clone(w.nodes[last].histogram)
      rehash(w, ...w.nodes.map((_: any, i: number) => i))
      w.root = w.nodes[last].hash
      fails(w, 'histogram-mismatch', { nodeIndex: last })
    })
  })

  it('TV-2b (IN-02) excludedFor and disposition are bound into the leaf hash and through it into the root', () => {
    const li = excludedTally.leaves.findIndex((l: any) => l.disposition === 'excluded')
    const leafNode = excludedTally.nodes.findIndex((n: any) => n.range[1] - n.range[0] === 1 && n.range[0] === li)
    // rewriting the reasons alone breaks the leaf hash
    const t = clone(excludedTally)
    t.leaves[li].excludedFor = ['cid-mismatch']
    fails(t, 'tally-hash-mismatch', { nodeIndex: leafNode })
    // rewriting the reasons and rehashing that leaf breaks its parent, whose hash commits to the child hash
    const u = clone(excludedTally)
    u.leaves[li].excludedFor = ['cid-mismatch']
    rehash(u, leafNode)
    fails(u, 'tally-hash-mismatch', { nodeIndex: parentOf(u, leafNode) })
    // rehashing the whole path is a different root
    const w = clone(excludedTally)
    w.leaves[li].excludedFor = ['cid-mismatch']
    rehash(w, ...w.nodes.map((_: any, i: number) => i))
    w.root = w.nodes[w.nodes.length - 1].hash
    expect(verifyTallyTree(w)).to.deep.equal({ ok: true })
    expect(w.root).to.not.equal(excludedTally.root)
    // excludedFor must be sorted and unique, so its hash input is canonical
    const v = clone(excludedTally)
    v.leaves[li].excludedFor = [...v.leaves[li].excludedFor, ...v.leaves[li].excludedFor]
    fails(v, 'leaf-mismatch', { leafIndex: li })
  })

  it('TV-3 malformed tallies are typed and never throw', () => {
    const edit = (f: (t: any) => void): any => { const t = clone(good); f(t); return t }
    const cases: Array<[string, unknown]> = [
      ['null', null], ['array', []], ['empty object', {}], ['string', 'x'],
      ['format', edit(t => { t.format = 'vt-tally-tree/2' })],
      ['uppercase root', edit(t => { t.root = t.root.toUpperCase() })],
      ['short blockRoot', edit(t => { t.blockRoot = t.blockRoot.slice(1) })],
      ['negative count', edit(t => { ballotOf(t, 0).votes = -1 })],
      ['fractional count', edit(t => { ballotOf(t, 0).invalid = 0.5 })],
      ['string count', edit(t => { ballotOf(t, 0).excluded = '0' })],
      ['extra ballot key', edit(t => { ballotOf(t, 0).extra = 1 })],
      ['extra question key', edit(t => { const b = ballotOf(t, 0); b.questions.q1.extra = 1 })],
      ['missing unsupported', edit(t => { delete ballotOf(t, 0).unsupported })],
      ['extra histogram key', edit(t => { t.histogram.extra = {} })],
      ['nodes too few', edit(t => { t.nodes.pop() })],
      ['leaves too few', edit(t => { t.leaves.pop() })],
      ['size off', edit(t => { t.size = 3 })],
      ['last leaf dropped, size decremented', edit(t => { t.leaves.pop(); t.size -= 1 })],
      ['junk nodes', edit(t => { t.nodes = Array.from({ length: 10_000 }, () => ({})) })],
      ['junk nodes on empty', edit(t => { t.size = 0; t.leaves = []; t.nodes = Array.from({ length: 10_000 }, () => ({})) })],
      ['excludedFor code', edit(t => { t.leaves[0].excludedFor = ['not-a-code'] })],
      ['entryCount 0', edit(t => { t.leaves[0].entryCount = 0 })],
      ['bad disposition', edit(t => { t.leaves[0].disposition = 'maybe' })],
      ['node hash not hex', edit(t => { t.nodes[3].hash = 'zz' })],
      ['range not array', edit(t => { t.nodes[3].range = 'x' })],
      ['revision', edit(t => { t.electionRevision = -1 })],
      ['empty election id', edit(t => { t.electionId = '' })]
    ]
    for (const [name, t] of cases) {
      const r: any = verifyTallyTree(t)
      expect(r, name).to.deep.include({ ok: false, reason: 'malformed-tally' })
      expect(r.detail, name).to.be.a('string')
    }
  })

  it('TV-4 shape', () => {
    const t = clone(good)
    ;[t.leaves[0], t.leaves[1]] = [t.leaves[1], t.leaves[0]]
    t.leaves[0].index = 0
    t.leaves[1].index = 1
    for (const k of ['merkleHash', 'histogram', 'hash']) [t.nodes[0][k], t.nodes[1][k]] = [t.nodes[1][k], t.nodes[0][k]]
    fails(t, 'shape-mismatch')
    const r = clone(good)
    r.nodes[2].range = [0, 3]
    fails(r, 'shape-mismatch', { nodeIndex: 2 })
    const l = clone(good)
    l.nodes[2].left = 1
    fails(l, 'shape-mismatch', { nodeIndex: 2 })
    const i = clone(good)
    i.leaves[2].index = 5
    fails(i, 'shape-mismatch', { leafIndex: 2 })
    const n = clone(good)
    n.nodes[3].index = 4
    fails(n, 'shape-mismatch', { nodeIndex: 3 })
  })

  it('TV-5 recomputation from the rows is the faithfulness check', () => {
    const shuffled: any = buildTallyTree(input({ rows: seededShuffle(set.rows, 7), voterRows: seededShuffle(set.voterRows, 7), ballots: seededShuffle(ballots, 7) }))
    expect(shuffled.tally.root).to.equal(good.root)
    expect(verifyTallyTree(shuffled.tally)).to.deep.equal({ ok: true })
    // The tampered-input tally is internally consistent, so it verifies, but it is a different outcome.
    expect(excludedTally.root).to.not.equal(good.root)
    expect(canonicalJson(excludedTally.histogram)).to.not.equal(canonicalJson(good.histogram))
    expect(verifyTallyTree(excludedTally)).to.deep.equal({ ok: true })
    expect(excludedTally.blockRoot).to.equal(good.blockRoot)
  })
})
