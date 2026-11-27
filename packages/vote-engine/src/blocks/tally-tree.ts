// tally-tree.ts — R8 (D-80, D-81): the tally tree over one election revision's committed VoteBlocks (65-08).
//
// Role:
//   - doc/election.md "Election tallied": "a tally tree, corresponding to the Merkle tree of hashes of the
//     blocks, but including a histogram of results at each level". Every node of the R5 block tree has a
//     tally node. A leaf holds the histogram of ONE block's valid decrypted answers. A parent holds the
//     canonical sum of its two children. The root histogram is the raw outcome.
//
// Format contract (third parties must be able to reproduce this byte for byte):
//   - Leaf tally hash (IN-02): sha256(0x04 || merkleLeafHash || utf8(canonicalJson({ disposition, excludedFor,
//     histogram }))), so the disposition and the exclusion reasons are bound.
//   - Parent tally hash (IN-02): sha256(0x03 || merkleNodeHash || leftTallyHash || rightTallyHash ||
//     utf8(canonicalJson(histogram))). Each parent commits to its children's tally hashes, so the root binds every
//     leaf's histogram, disposition and excludedFor: none can be rewritten without changing the root.
//   - Every hash enters as its 32 raw bytes, the same way R5 concatenates child hashes. R5 uses 0x00 (leaf) and
//     0x01 (node); 0x02 is left unused on purpose, so a tally hash can never pose as a merkle hash.
//   - Histogram: { ballots: { [ballotId]: { votes, invalid, excluded, questions, unsupported } } }, only ballots
//     present in the subtree. `valid` = votes - invalid - excluded is derived and never stored. A `select`
//     question is { answered, options }: `answered` is the number of valid votes that answered it, and
//     `options` has EVERY template option code, zero-initialised, with the number of valid votes choosing it.
//     A blank is (valid - answered), derived. `answered` exists because a multi-select question
//     (optionRange.max > 1) cannot recover it from the option counts.
//   - Empty set: size 0, no nodes, root = tallyNodeHash(BLOCK_TREE_EMPTY_ROOT, { ballots: {} }), which is
//     sha256(0x03 || emptyRoot || utf8('{"ballots":{}}')).
//   - The tally is plain JSON data. It carries counts and public block columns only: no vote entry, nonce,
//     registrant id or key, and nothing that is not JSON.
//
// D-81: a VoteAnswer holds a sorted, de-duplicated option set, so only `select` questions (type absent, null or
// 'select', by answer-checks' questionType, IN-03) can be histogrammed faithfully. Every other question type
// (rank, score, text, unknown) is reported under `unsupported` with the number of valid votes that answered it,
// and never under `questions`.
//
// BLOCK-LEVEL POLICY (D-82). A block whose R7 status is 'invalid' is NOT tallied. That status means some error
// finding has no voteIndex: Cid or Id mismatch, the block does not open, a payload shape or count error, a
// consent or voter-entry signature failure, an unknown ballot or template mismatch, a voter-row defect, or a
// registrant in two blocks. Its leaf still exists, because the tally tree mirrors every R5 leaf: that keeps the
// R5 root unchanged and every branch checkable. Its R7 attestedEntries counts in `votes` and in `excluded`
// (WR-04): min(EntryCount, listed voters, listed voters with an authenticated voter row). An invalid block is
// untrusted, so its declared EntryCount alone (up to 2^53 - 1) must not inflate the excluded volume.
// Its option counts are zero, and the leaf lists the block-level error codes in `excludedFor`.
// ONE CIPHERTEXT, ONE COUNT (T-65-05-03). R5 may keep several authenticated leaves for one Cid. R7 marks all but one
// of them `shadowedBy` with attestedEntries 0, so they are excluded leaves with 0 votes. tallyTreeFrom refuses a
// report where two findings of one Cid count entries, and verifyTallyTree fails a tally where two leaves of one Cid
// have votes, so the same entries are never in votes or excluded twice.
// Why: a block-level error means R7 could not show that the block holds what was committed, that its voters
// consented to it, or that its votes belong to it alone. Counting its votes would let a hostile writer or
// replica inject, or count twice, votes that no valid consent backs. Dropping them silently would hide them.
// Counting them as `excluded` keeps votes = valid + invalid + excluded exact at every node, and puts the
// excluded volume in the published outcome, where the spec's discrepancy margin can use it. A tallied leaf's
// `votes` equals the EntryCount its leafData commits to; an excluded leaf's is at most that. Every sum is checked
// to stay a safe integer; otherwise the tally is refused (`count-overflow`) rather than emitted unverifiable. Per-vote errors inside an otherwise valid block (D-71) only move that vote to
// `invalid`. Info findings never exclude anything.
//
// Out of scope (D-80, spec "Q:" items): signing tally nodes, TSA timestamps, storage or caching, write-in or
// free-text normalisation, and the completion notification. R8 is not time-gated and never reads a clock.
//
// The election secret: R8 never reads it. buildTallyTree hands the release straight to validateElectionBlocks,
// which checks it, copies it and zero-fills the copy.
//
// Rules: results are typed unions and nothing here reports failure by raising an error. Histograms are built
// from Maps and materialised with Object.fromEntries, and every read is an own-property read, because question
// and option codes are template strings that may spell `__proto__` or `constructor`. Pure for Hermes and the
// browser-adjacent engine: noble-backed relative imports only, no Node-only globals, no logging, no clock, no
// randomness.

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { BLOCK_TREE_EMPTY_ROOT, blockLeafHash, blockNodeHash, buildBlockTree, type BlockAuthorization, type BlockTree } from './block-tree.js'
import {
  VALIDATION_CODES, validateElectionBlocks, type ElectionValidationResult, type ValidationAssociationRow, type ValidationBlockRow,
  type ValidationCode, type ValidationRegistrantRow, type ValidationRelease, type ValidationTimeline, type ValidationVoterRow
} from './validate-blocks.js'
import { questionType, type AnswerCheckBallot } from './answer-checks.js'
import { canonicalJson } from '../voting/canonical.js'

export const TALLY_TREE_DOMAIN = 'vt-tally-tree/1' as const

const TALLY_PREFIX = 0x03
const TALLY_LEAF_PREFIX = 0x04

/** One `select` question. Blank = (ballot valid) - answered: derived, never stored. */
export interface TallyQuestionCounts {
  /** valid votes that answered this question */
  answered: number
  /** EVERY template option code, zero-initialised; valid votes choosing it */
  options: Record<string, number>
}

export interface TallyBallotCounts {
  /** tallied leaves: their EntryCount; excluded leaves: their R7 attestedEntries (WR-04) */
  votes: number
  /** per-vote invalid (D-71) inside tallied blocks */
  invalid: number
  /** entries of blocks excluded at block level */
  excluded: number
  /** select questions only; {} if the template is unknown */
  questions: Record<string, TallyQuestionCounts>
  /** D-81: every non-select question code, zero-initialised; valid votes that answered it */
  unsupported: Record<string, number>
}

export interface TallyHistogram { ballots: Record<string, TallyBallotCounts> }

export type TallyLeafDisposition = 'tallied' | 'excluded'

export interface TallyLeaf {
  /** = R5 leaf index */
  index: number
  blockCid: string
  ballotId: string
  entryCount: number
  /** = R5 blockLeafData (public block columns only) */
  leafData: string
  disposition: TallyLeafDisposition
  /** [] when tallied; else the block's error codes WITHOUT voteIndex, sorted by byString, unique */
  excludedFor: readonly ValidationCode[]
}

export interface TallyNode {
  /** identical to BlockTree.nodes[index] */
  index: number
  range: readonly [number, number]
  left?: number
  right?: number
  /** = BlockTree.nodes[index].hash (R5, unchanged) */
  merkleHash: string
  /** leaf: one ballot; parent: addHistograms(left, right) */
  histogram: TallyHistogram
  /** leaf: tallyLeafHash(merkleHash, histogram, disposition, excludedFor); parent: tallyParentHash(merkleHash, left.hash, right.hash, histogram) */
  hash: string
}

/** Plain JSON data: no functions, no Uint8Array, no vote entries, nonces or registrant ids. Survives a JSON round trip. */
export interface TallyTree {
  format: 'vt-tally-tree/1'
  electionId: string
  electionRevision: number
  /** the R5 root (BLOCK_TREE_EMPTY_ROOT when size 0) */
  blockRoot: string
  /** last node's hash; size 0: tallyNodeHash(BLOCK_TREE_EMPTY_ROOT, { ballots: {} }) */
  root: string
  size: number
  /** the root histogram: the raw outcome */
  histogram: TallyHistogram
  /** R5 leaf order (ascending UTF-8 bytes of Cid, then of leafData) */
  leaves: readonly TallyLeaf[]
  /** R5 node order (post-order, root last); [] when size 0 */
  nodes: readonly TallyNode[]
}

export type TallyTreeRefusal =
  | 'malformed-input' | 'not-released' | 'inconsistent-inputs' | 'count-overflow'
  | 'malformed-row' | 'duplicate-block' | 'mixed-election' | 'mixed-revision'
  | 'invalid-secret' | 'secret-mismatch'

export type ReleasedValidation = Extract<ElectionValidationResult, { ok: true }>

export type TallyTreeResult = { ok: true, tally: TallyTree } | { ok: false, reason: TallyTreeRefusal, detail: string }

type Rec = Record<string, unknown>

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const own = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key)

const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)

const isHex64 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** A plain object whose keys are the Map's keys sorted by byString; own data properties, `__proto__` included. */
function sortedRecord<V> (map: Map<string, V>): Record<string, V> {
  return Object.fromEntries([...map.entries()].sort((a, b) => byString(a[0], b[0])))
}

/** hex(sha256(0x03 || hexToBytes(merkleHash) || utf8(canonicalJson(histogram)))). Precondition: 64 lowercase hex, well-formed histogram. */
export function tallyNodeHash (merkleHash: string, histogram: TallyHistogram): string {
  return bytesToHex(sha256(concatBytes(Uint8Array.of(TALLY_PREFIX), hexToBytes(merkleHash), utf8ToBytes(canonicalJson(histogram)))))
}

/** IN-02: hex(sha256(0x04 || merkleHash || utf8(canonicalJson({ disposition, excludedFor, histogram })))). */
export function tallyLeafHash (merkleHash: string, histogram: TallyHistogram, disposition: TallyLeafDisposition, excludedFor: readonly ValidationCode[]): string {
  return bytesToHex(sha256(concatBytes(
    Uint8Array.of(TALLY_LEAF_PREFIX), hexToBytes(merkleHash), utf8ToBytes(canonicalJson({ disposition, excludedFor: [...excludedFor], histogram }))
  )))
}

/** IN-02: hex(sha256(0x03 || merkleHash || leftTallyHash || rightTallyHash || utf8(canonicalJson(histogram)))). */
export function tallyParentHash (merkleHash: string, leftHash: string, rightHash: string, histogram: TallyHistogram): string {
  return bytesToHex(sha256(concatBytes(
    Uint8Array.of(TALLY_PREFIX), hexToBytes(merkleHash), hexToBytes(leftHash), hexToBytes(rightHash), utf8ToBytes(canonicalJson(histogram))
  )))
}

function sumRecords (a: Record<string, number> | undefined, b: Record<string, number> | undefined): Record<string, number> {
  const out = new Map<string, number>()
  for (const side of [a, b]) {
    if (side === undefined) continue
    for (const k of Object.keys(side)) out.set(k, (out.get(k) ?? 0) + (own(side, k) ? side[k]! : 0))
  }
  return sortedRecord(out)
}

function mergeBallot (x: TallyBallotCounts | undefined, y: TallyBallotCounts | undefined): TallyBallotCounts {
  const questions = new Map<string, TallyQuestionCounts>()
  const codes = new Set<string>([...Object.keys(x?.questions ?? {}), ...Object.keys(y?.questions ?? {})])
  for (const code of codes) {
    const qx = x !== undefined && own(x.questions, code) ? x.questions[code] : undefined
    const qy = y !== undefined && own(y.questions, code) ? y.questions[code] : undefined
    questions.set(code, { answered: (qx?.answered ?? 0) + (qy?.answered ?? 0), options: sumRecords(qx?.options, qy?.options) })
  }
  return {
    excluded: (x?.excluded ?? 0) + (y?.excluded ?? 0),
    invalid: (x?.invalid ?? 0) + (y?.invalid ?? 0),
    questions: sortedRecord(questions),
    unsupported: sumRecords(x?.unsupported, y?.unsupported),
    votes: (x?.votes ?? 0) + (y?.votes ?? 0)
  }
}

/** Canonical elementwise sum; key union; fresh objects (never aliases or mutates its inputs). Precondition: well-formed histograms. */
export function addHistograms (a: TallyHistogram, b: TallyHistogram): TallyHistogram {
  const ballots = new Map<string, TallyBallotCounts>()
  const ids = new Set<string>([...Object.keys(a.ballots), ...Object.keys(b.ballots)])
  for (const id of ids) {
    ballots.set(id, mergeBallot(own(a.ballots, id) ? a.ballots[id] : undefined, own(b.ballots, id) ? b.ballots[id] : undefined))
  }
  return { ballots: sortedRecord(ballots) }
}

interface WorkQuestion { answered: number, options: Map<string, number> }
interface WorkBallot {
  votes: number
  invalid: number
  excluded: number
  questions: Map<string, WorkQuestion>
  unsupported: Map<string, number>
}

type Refusal = { ok: false, reason: TallyTreeRefusal, detail: string }
const refuse = (reason: TallyTreeRefusal, detail: string): Refusal => ({ ok: false, reason, detail })

/** Zero counts; with a template, every select question and option, and every other question code. */
function ballotSkeleton (ballot: AnswerCheckBallot | undefined): WorkBallot {
  const w: WorkBallot = { votes: 0, invalid: 0, excluded: 0, questions: new Map(), unsupported: new Map() }
  if (ballot === undefined) return w
  for (const q of ballot.questions) {
    if (w.questions.has(q.code) || w.unsupported.has(q.code)) continue
    if (questionType(q) === 'select') {
      const options = new Map<string, number>()
      for (const o of q.options) options.set(o.code, 0)
      w.questions.set(q.code, { answered: 0, options })
    } else {
      w.unsupported.set(q.code, 0)
    }
  }
  return w
}

function materialise (w: WorkBallot): TallyBallotCounts {
  const questions = new Map<string, TallyQuestionCounts>()
  for (const [code, q] of w.questions) questions.set(code, { answered: q.answered, options: sortedRecord(q.options) })
  return { excluded: w.excluded, invalid: w.invalid, questions: sortedRecord(questions), unsupported: sortedRecord(w.unsupported), votes: w.votes }
}

function checkBallots (ballots: unknown): { ok: true, byId: Map<string, AnswerCheckBallot> } | Refusal {
  if (!Array.isArray(ballots)) return refuse('malformed-input', 'ballots must be an array')
  const byId = new Map<string, AnswerCheckBallot>()
  for (let i = 0; i < ballots.length; i++) {
    const b: unknown = ballots[i]
    if (!isRec(b)) return refuse('malformed-input', `ballot ${i}: not an object`)
    if (typeof b.id !== 'string') return refuse('malformed-input', `ballot ${i}: id must be a string`)
    if (byId.has(b.id)) return refuse('malformed-input', `ballot ${b.id} appears twice`)
    if (!Array.isArray(b.questions)) return refuse('malformed-input', `ballot ${b.id}: questions must be an array`)
    for (const q of b.questions as unknown[]) {
      if (!isRec(q) || typeof q.code !== 'string') return refuse('malformed-input', `ballot ${b.id}: a question has no string code`)
      if (questionType(q) === null) return refuse('malformed-input', `ballot ${b.id}: question ${q.code} has a type that is neither a string nor absent`)
      if (!Array.isArray(q.options)) return refuse('malformed-input', `ballot ${b.id}: question ${q.code} options must be an array`)
      for (const o of q.options as unknown[]) {
        if (!isRec(o) || typeof o.code !== 'string') return refuse('malformed-input', `ballot ${b.id}: question ${q.code} has an option without a string code`)
      }
    }
    byId.set(b.id, b as unknown as AnswerCheckBallot)
  }
  return { ok: true, byId }
}

/** Counts one valid, canonical entry into the ballot. Returns a detail string when the entry cannot be placed. */
function countEntry (w: WorkBallot, entry: unknown): string | null {
  if (!isRec(entry) || !Array.isArray(entry.answers)) return 'a valid vote has no answers array'
  for (const a of entry.answers as unknown[]) {
    if (!isRec(a) || typeof a.questionCode !== 'string' || !Array.isArray(a.optionCodes)) return 'a valid vote has a malformed answer'
    for (const o of a.optionCodes as unknown[]) if (typeof o !== 'string') return 'a valid vote has a non-string option code'
    const q = w.questions.get(a.questionCode)
    if (q !== undefined) {
      q.answered++
      for (const o of a.optionCodes as string[]) {
        const n = q.options.get(o)
        if (n === undefined) return `a valid vote names option ${o} that question ${a.questionCode} lacks`
        q.options.set(o, n + 1)
      }
    } else if (w.unsupported.has(a.questionCode)) {
      w.unsupported.set(a.questionCode, w.unsupported.get(a.questionCode)! + 1)
    } else {
      return `a valid vote names question ${a.questionCode} that the template lacks`
    }
  }
  return null
}

function leafHistogram (leafBallotId: string, entryCount: number, finding: Rec, ballotsById: Map<string, AnswerCheckBallot>):
{ ok: true, counts: TallyBallotCounts, disposition: TallyLeafDisposition, excludedFor: ValidationCode[] } | Refusal {
  const template = ballotsById.get(leafBallotId)
  const w = ballotSkeleton(template)
  w.votes = entryCount
  if (finding.status === 'invalid') {
    const attested = finding.attestedEntries
    if (!isCount(attested) || attested > entryCount) {
      return refuse('inconsistent-inputs', `block ${String(finding.blockCid)}: attestedEntries must be a count no larger than the entry count`)
    }
    w.votes = attested
    w.excluded = attested
    const codes = new Set<string>()
    if (Array.isArray(finding.findings)) {
      for (const f of finding.findings as unknown[]) {
        if (isRec(f) && f.severity === 'error' && f.voteIndex === undefined && typeof f.code === 'string') codes.add(f.code)
      }
    }
    return { ok: true, counts: materialise(w), disposition: 'excluded', excludedFor: [...codes].sort(byString) as ValidationCode[] }
  }
  if (finding.status !== 'valid') return refuse('inconsistent-inputs', `block ${String(finding.blockCid)} is ${String(finding.status)}, not released`)
  if (!Array.isArray(finding.votes) || finding.votes.length !== entryCount) {
    return refuse('inconsistent-inputs', `block ${String(finding.blockCid)}: ${Array.isArray(finding.votes) ? finding.votes.length : 'no'} verdicts for ${entryCount} entries`)
  }
  for (const v of finding.votes as unknown[]) {
    if (!isRec(v)) return refuse('inconsistent-inputs', `block ${String(finding.blockCid)}: a verdict is not an object`)
    if (v.status === 'invalid') { w.invalid++; continue }
    if (v.status !== 'valid') return refuse('inconsistent-inputs', `block ${String(finding.blockCid)}: unknown verdict status`)
    if (template === undefined) return refuse('inconsistent-inputs', `block ${String(finding.blockCid)}: valid votes on ballot ${leafBallotId} that has no template`)
    const bad = countEntry(w, v.entry)
    if (bad !== null) return refuse('inconsistent-inputs', `block ${String(finding.blockCid)}: ${bad}`)
  }
  return { ok: true, counts: materialise(w), disposition: 'tallied', excludedFor: [] }
}

/** Builds the tally from an R5 tree and a RELEASED R7 report (no second decryption). */
export function tallyTreeFrom (tree: BlockTree, validation: ElectionValidationResult, ballots: readonly AnswerCheckBallot[]): TallyTreeResult {
  const t: unknown = tree
  const v: unknown = validation
  if (!isRec(t) || !Array.isArray(t.leaves) || !Array.isArray(t.nodes)) return refuse('malformed-input', 'tree must be an object with leaves and nodes arrays')
  if (!isRec(v) || v.ok !== true || !Array.isArray(v.blocks)) return refuse('malformed-input', 'validation must be an ok report with a blocks array')
  const checked = checkBallots(ballots)
  if (!checked.ok) return checked
  if (v.released !== true) return refuse('not-released', 'the report was produced without the election key')
  if (v.electionId !== t.electionId || v.electionRevision !== t.electionRevision) {
    return refuse('inconsistent-inputs', 'the report and the tree are for different elections or revisions')
  }
  const leaves = t.leaves as unknown[]
  const nodes = t.nodes as unknown[]
  if (nodes.length !== (leaves.length === 0 ? 0 : 2 * leaves.length - 1)) return refuse('malformed-input', 'tree nodes do not fit its leaves')
  if (typeof t.electionId !== 'string' || !Number.isSafeInteger(t.electionRevision) || !isHex64(t.root)) {
    return refuse('malformed-input', 'tree scope or root is malformed')
  }

  // WR-07: the tree must hash to itself before any of its hashes is used
  const treeProblem = treeSelfProblem(t, leaves, nodes)
  if (treeProblem !== null) return refuse('inconsistent-inputs', treeProblem)

  // T-65-05-03: a Cid may name several leaves, so findings are matched to leaves by the leaf hash
  const findings = new Map<string, Rec>()
  for (const f of v.blocks as unknown[]) {
    if (!isRec(f) || typeof f.blockCid !== 'string') return refuse('inconsistent-inputs', 'a block finding has no Cid')
    if (typeof f.leafHash !== 'string') return refuse('inconsistent-inputs', `block ${f.blockCid}: the finding has no leaf hash`)
    if (findings.has(f.leafHash)) return refuse('inconsistent-inputs', `two findings for leaf ${f.leafHash}`)
    findings.set(f.leafHash, f)
  }
  // WR-07: the report covers exactly the tree's blocks, so no finding is silently dropped from the tally
  if (findings.size !== leaves.length) {
    return refuse('inconsistent-inputs', `the report has ${findings.size} blocks; the tree has ${leaves.length} leaves`)
  }
  const leafHashes = new Set(leaves.map(l => (l as Rec).hash))
  for (const [hash, f] of findings) {
    if (!leafHashes.has(hash)) return refuse('inconsistent-inputs', `the report's block ${String(f.blockCid)} is not a leaf of the tree`)
  }
  // T-65-05-03: one ciphertext is counted once. Per Cid, at most one finding is valid, and at most one finding
  // counts entries (a valid one, or an invalid one with attestedEntries > 0)
  const countersByCid = new Map<string, number>()
  for (const f of findings.values()) {
    const counts = f.status === 'valid' || (f.status === 'invalid' && isCount(f.attestedEntries) && f.attestedEntries > 0)
    if (!counts) continue
    const n = (countersByCid.get(f.blockCid as string) ?? 0) + 1
    if (n > 1) return refuse('inconsistent-inputs', `block ${String(f.blockCid)}: two leaves of this Cid count its entries`)
    countersByCid.set(f.blockCid as string, n)
  }

  const outLeaves: TallyLeaf[] = []
  const leafHist: TallyHistogram[] = []
  for (let i = 0; i < leaves.length; i++) {
    const l: unknown = leaves[i]
    if (!isRec(l) || typeof l.cid !== 'string' || typeof l.ballotId !== 'string' || typeof l.leafData !== 'string' || !isCount(l.entryCount)) {
      return refuse('malformed-input', `tree leaf ${i} is malformed`)
    }
    const finding = typeof l.hash === 'string' ? findings.get(l.hash) : undefined
    if (finding === undefined) return refuse('inconsistent-inputs', `no finding for leaf ${i} (Cid ${l.cid})`)
    if (finding.blockCid !== l.cid || finding.ballotId !== l.ballotId || finding.blockId !== l.blockId || finding.declaredEntries !== l.entryCount) {
      return refuse('inconsistent-inputs', `block ${l.cid}: the report's ballot, block id or entry count differs from the tree leaf`)
    }
    const h = leafHistogram(l.ballotId, l.entryCount, finding, checked.byId)
    if (!h.ok) return h
    leafHist.push({ ballots: Object.fromEntries([[l.ballotId, h.counts]]) })
    outLeaves.push({
      index: i, blockCid: l.cid, ballotId: l.ballotId, entryCount: l.entryCount, leafData: l.leafData,
      disposition: h.disposition, excludedFor: h.excludedFor
    })
  }

  const outNodes: TallyNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    const n: unknown = nodes[i]
    if (!isRec(n) || !Array.isArray(n.range) || n.range.length !== 2 || !isHex64(n.hash)) return refuse('malformed-input', `tree node ${i} is malformed`)
    const lo = n.range[0] as unknown
    const hi = n.range[1] as unknown
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) return refuse('malformed-input', `tree node ${i} has a malformed range`)
    let histogram: TallyHistogram
    const entry: TallyNode = { index: i, range: [lo as number, hi as number], merkleHash: n.hash, histogram: { ballots: {} }, hash: '' }
    if ((hi as number) - (lo as number) === 1) {
      const h = leafHist[lo as number]
      if (h === undefined) return refuse('malformed-input', `tree node ${i} names a leaf that does not exist`)
      histogram = addHistograms(h, { ballots: {} })
    } else {
      const left = n.left as unknown
      const right = n.right as unknown
      if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || (left as number) < 0 || (right as number) < 0 || (left as number) >= i || (right as number) >= i) {
        return refuse('malformed-input', `tree node ${i} has malformed children`)
      }
      histogram = addHistograms(outNodes[left as number]!.histogram, outNodes[right as number]!.histogram)
      if (!isWellFormedHistogram(histogram)) return refuse('count-overflow', `tree node ${i}: a count is no longer a safe integer`)
      entry.left = left as number
      entry.right = right as number
    }
    entry.histogram = histogram
    if (entry.left === undefined) {
      const leaf = outLeaves[lo as number]!
      entry.hash = tallyLeafHash(n.hash, histogram, leaf.disposition, leaf.excludedFor)
    } else {
      entry.hash = tallyParentHash(n.hash, outNodes[entry.left]!.hash, outNodes[entry.right!]!.hash, histogram)
    }
    outNodes.push(entry)
  }

  const size = leaves.length
  const blockRoot = size === 0 ? BLOCK_TREE_EMPTY_ROOT : outNodes[outNodes.length - 1]!.merkleHash
  const histogram: TallyHistogram = size === 0 ? { ballots: {} } : addHistograms(outNodes[outNodes.length - 1]!.histogram, { ballots: {} })
  const root = size === 0 ? tallyNodeHash(BLOCK_TREE_EMPTY_ROOT, { ballots: {} }) : outNodes[outNodes.length - 1]!.hash
  return {
    ok: true,
    tally: {
      format: TALLY_TREE_DOMAIN,
      electionId: t.electionId,
      electionRevision: t.electionRevision as number,
      blockRoot,
      root,
      size,
      histogram,
      leaves: outLeaves,
      nodes: outNodes
    }
  }
}

/**
 * WR-07: why an R5 tree is not one buildBlockTree could have produced, or null. Checks the leaf order and
 * indexes, each leaf's fields against its leafData, the node shape, every leaf hash recomputed from leafData,
 * every internal hash recomputed from its children, and the root. A caller-supplied tree is trusted for nothing.
 */
function treeSelfProblem (t: Rec, leaves: unknown[], nodes: unknown[]): string | null {
  for (let i = 0; i < leaves.length; i++) {
    const l: unknown = leaves[i]
    if (!isRec(l) || l.index !== i || typeof l.cid !== 'string' || typeof l.blockId !== 'string' || typeof l.ballotId !== 'string' ||
      typeof l.leafData !== 'string' || !isCount(l.entryCount) || typeof l.hash !== 'string') {
      return `tree leaf ${i} is malformed`
    }
    const prev = i > 0 ? leaves[i - 1] as Rec : null
    if (prev !== null && (compareUtf8(prev.cid as string, l.cid) || compareUtf8(prev.leafData as string, l.leafData)) >= 0) {
      return `tree leaf ${i} is not after leaf ${i - 1} in leaf order (Cid, then leafData)`
    }
    let parsed: unknown
    try { parsed = JSON.parse(l.leafData) } catch { return `tree leaf ${i}: leafData is not JSON` }
    if (!Array.isArray(parsed) || parsed.length !== 8 || canonicalJson(parsed) !== l.leafData) return `tree leaf ${i}: leafData is not the canonical leaf tuple`
    const [electionId, electionRevision, ballotId, blockId, cid, entryCount] = parsed as unknown[]
    if (electionId !== t.electionId || electionRevision !== t.electionRevision || ballotId !== l.ballotId || blockId !== l.blockId ||
      cid !== l.cid || entryCount !== l.entryCount) {
      return `tree leaf ${i}: the leaf fields differ from its leafData`
    }
    if (l.hash !== blockLeafHash(l.leafData)) return `tree leaf ${i}: the hash is not the leaf hash of its leafData`
  }
  const shape = expectedShape(leaves.length)
  for (let i = 0; i < nodes.length; i++) {
    const n: unknown = nodes[i]
    const want = shape[i]!
    if (!isRec(n) || !Array.isArray(n.range) || n.range.length !== 2 || !isHex64(n.hash)) return `tree node ${i} is malformed`
    if (n.index !== i || n.range[0] !== want.range[0] || n.range[1] !== want.range[1] || n.left !== want.left || n.right !== want.right) {
      return `tree node ${i} is not where the block tree puts it`
    }
    const expected = want.left === undefined
      ? (leaves[want.range[0]] as Rec).hash
      : blockNodeHash((nodes[want.left] as Rec).hash as string, (nodes[want.right!] as Rec).hash as string)
    if (n.hash !== expected) return `tree node ${i}: the hash is not recomputable from its ${want.left === undefined ? 'leaf' : 'children'}`
  }
  const root = nodes.length === 0 ? BLOCK_TREE_EMPTY_ROOT : (nodes[nodes.length - 1] as Rec).hash
  if (t.root !== root) return 'the tree root is not its last node hash'
  return null
}

export interface TallyTreeInput {
  scope: { electionId: string, electionRevision: number }
  rows: readonly ValidationBlockRow[]
  voterRows: readonly ValidationVoterRow[]
  ballots: readonly AnswerCheckBallot[]
  /** CR-02: passed straight to validateElectionBlocks; with voterRows, associations, timeline and ballots also R5's authorization (T-65-05-03) */
  registrants: readonly ValidationRegistrantRow[]
  associations: readonly ValidationAssociationRow[]
  timeline: ValidationTimeline
  /** null or undefined gives 'not-released' */
  release: ValidationRelease | null | undefined
}

export type BuildTallyTreeResult =
  | { ok: true, tally: TallyTree, blockTree: BlockTree, validation: ReleasedValidation }
  | { ok: false, reason: TallyTreeRefusal, detail: string }

/**
 * buildBlockTree + validateElectionBlocks + tallyTreeFrom. R5 runs first, so mixed-scope rows are refused before any
 * decryption; malformed and duplicate rows are set aside by both R5 and R7 (WR-06), both with the same authorization
 * inputs (T-65-05-03), and the rest is tallied. The release goes only to validateElectionBlocks, which checks the
 * secret, copies it and zero-fills the copy; R8 never reads it. A caller who already holds an R7 report should
 * call tallyTreeFrom, to avoid decrypting twice.
 */
export function buildTallyTree (input: TallyTreeInput): BuildTallyTreeResult {
  if (!isRec(input) || !isRec(input.scope)) return refuse('malformed-input', 'input must be an object with a scope')
  if (input.release === undefined || input.release === null) return refuse('not-released', 'the election key has not been released')
  // T-65-05-03: R5 authenticates rows that share a Cid with the very inputs R7 judges, so its leaves are R7's blocks
  const built = buildBlockTree(input.rows, input.scope, {
    voterRows: input.voterRows, registrants: input.registrants, associations: input.associations, timeline: input.timeline,
    ballots: input.ballots
  } as unknown as BlockAuthorization)
  if (!built.ok) return refuse(built.reason, built.detail)
  const validation = validateElectionBlocks({
    scope: input.scope,
    rows: input.rows,
    voterRows: input.voterRows,
    ballots: input.ballots,
    registrants: input.registrants,
    associations: input.associations,
    timeline: input.timeline,
    release: input.release
  })
  if (!validation.ok) return refuse(validation.reason, validation.detail)
  const tallied = tallyTreeFrom(built.tree, validation, input.ballots)
  if (!tallied.ok) return tallied
  return { ok: true, tally: tallied.tally, blockTree: built.tree, validation }
}

export type TallyVerifyFailure =
  | 'malformed-tally' | 'shape-mismatch' | 'leaf-mismatch' | 'merkle-hash-mismatch'
  | 'histogram-mismatch' | 'tally-hash-mismatch' | 'root-mismatch'

export type TallyVerifyResult =
  | { ok: true }
  | { ok: false, reason: TallyVerifyFailure, detail: string, nodeIndex?: number, leafIndex?: number }

type VerifyFailure = Extract<TallyVerifyResult, { ok: false }>

function vfail (reason: TallyVerifyFailure, detail: string, where: { nodeIndex?: number, leafIndex?: number } = {}): VerifyFailure {
  return { ok: false, reason, detail, ...where }
}

/** Largest power of two strictly below n (n >= 2), the R5 split rule. */
function splitPoint (n: number): number {
  let k = 1
  while (k * 2 < n) k *= 2
  return k
}

function compareUtf8 (a: string, b: string): number {
  const x = utf8ToBytes(a)
  const y = utf8ToBytes(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) {
    const d = x[i]! - y[i]!
    if (d !== 0) return d
  }
  return x.length - y.length
}

/** The post-order node list R5 produces for `size` leaves. */
function expectedShape (size: number): Array<{ range: [number, number], left?: number, right?: number }> {
  const out: Array<{ range: [number, number], left?: number, right?: number }> = []
  const build = (lo: number, hi: number): number => {
    let entry: { range: [number, number], left?: number, right?: number }
    if (hi - lo === 1) {
      entry = { range: [lo, hi] }
    } else {
      const k = splitPoint(hi - lo)
      const left = build(lo, lo + k)
      const right = build(lo + k, hi)
      entry = { range: [lo, hi], left, right }
    }
    out.push(entry)
    return out.length - 1
  }
  if (size > 0) build(0, size)
  return out
}

function exactKeys (o: Rec, keys: readonly string[]): boolean {
  const have = Object.keys(o).sort(byString)
  return have.length === keys.length && keys.every((k, i) => have[i] === k)
}

const get = (o: Rec, k: string): unknown => (own(o, k) ? o[k] : undefined)

function isCountMap (v: unknown): v is Record<string, number> {
  return isRec(v) && Object.keys(v).every(k => isCount(get(v, k)))
}

function isWellFormedBallot (b: unknown): b is TallyBallotCounts {
  if (!isRec(b) || !exactKeys(b, ['excluded', 'invalid', 'questions', 'unsupported', 'votes'])) return false
  if (!isCount(b.votes) || !isCount(b.invalid) || !isCount(b.excluded)) return false
  if (!isCountMap(b.unsupported) || !isRec(b.questions)) return false
  return Object.keys(b.questions).every(code => {
    const q = get(b.questions as Rec, code)
    return isRec(q) && exactKeys(q, ['answered', 'options']) && isCount(q.answered) && isCountMap(q.options)
  })
}

function isWellFormedHistogram (h: unknown): h is TallyHistogram {
  if (!isRec(h) || !exactKeys(h, ['ballots']) || !isRec(h.ballots)) return false
  return Object.keys(h.ballots).every(id => isWellFormedBallot(get(h.ballots as Rec, id)))
}

/** Why a leaf histogram is not one a block of this size and disposition could have produced; null when fine. */
function leafBoundProblem (h: TallyHistogram, leaf: TallyLeaf): string | null {
  const ids = Object.keys(h.ballots)
  if (ids.length !== 1 || ids[0] !== leaf.ballotId) return 'a leaf histogram must hold exactly its own ballot'
  const b = get(h.ballots, leaf.ballotId) as TallyBallotCounts
  if (leaf.disposition === 'tallied' ? b.votes !== leaf.entryCount : b.votes > leaf.entryCount) {
    return leaf.disposition === 'tallied' ? 'leaf votes differ from the committed entry count' : 'excluded votes exceed the committed entry count'
  }
  if (b.invalid + b.excluded > b.votes) return 'invalid and excluded exceed the votes'
  const valid = b.votes - b.invalid - b.excluded
  const counts: Array<[string, number, number]> = []
  for (const code of Object.keys(b.unsupported)) counts.push([`unsupported ${code}`, get(b.unsupported, code) as number, valid])
  for (const code of Object.keys(b.questions)) {
    const q = get(b.questions, code) as TallyQuestionCounts
    counts.push([`question ${code} answered`, q.answered, valid])
    for (const o of Object.keys(q.options)) counts.push([`question ${code} option ${o}`, get(q.options, o) as number, q.answered])
  }
  for (const [what, n, bound] of counts) if (n > bound) return `${what} exceeds its bound`
  if (leaf.disposition === 'tallied') {
    if (b.excluded !== 0) return 'a tallied leaf cannot have excluded entries'
  } else {
    if (b.excluded !== b.votes || b.invalid !== 0) return 'an excluded leaf must exclude every entry'
    if (counts.some(([, n]) => n !== 0)) return 'an excluded leaf must hold no counts'
  }
  return null
}

function checkTallyFormat (tally: unknown): VerifyFailure | null {
  const bad = (detail: string): VerifyFailure => vfail('malformed-tally', detail)
  if (!isRec(tally)) return bad('the tally is not an object')
  if (tally.format !== TALLY_TREE_DOMAIN) return bad('unknown tally format')
  if (typeof tally.electionId !== 'string' || tally.electionId === '') return bad('electionId must be a non-empty string')
  if (!isCount(tally.electionRevision)) return bad('electionRevision must be a non-negative safe integer')
  if (!isHex64(tally.blockRoot) || !isHex64(tally.root)) return bad('blockRoot and root must be 64 lowercase hex characters')
  if (!isCount(tally.size)) return bad('size must be a non-negative safe integer')
  if (!Array.isArray(tally.leaves) || tally.leaves.length !== tally.size) return bad('leaves must be an array of length size')
  if (!Array.isArray(tally.nodes) || tally.nodes.length !== (tally.size === 0 ? 0 : 2 * tally.size - 1)) return bad('nodes must be an array of length 2*size-1')
  if (!isWellFormedHistogram(tally.histogram)) return bad('the root histogram is malformed')
  for (let i = 0; i < tally.leaves.length; i++) {
    const l: unknown = tally.leaves[i]
    if (!isRec(l)) return bad(`leaf ${i} is not an object`)
    if (!Number.isSafeInteger(l.index)) return bad(`leaf ${i}: index must be an integer`)
    if (typeof l.blockCid !== 'string' || typeof l.ballotId !== 'string' || typeof l.leafData !== 'string') return bad(`leaf ${i}: blockCid, ballotId and leafData must be strings`)
    if (!isCount(l.entryCount) || l.entryCount < 1) return bad(`leaf ${i}: entryCount must be a safe integer >= 1`)
    if (l.disposition !== 'tallied' && l.disposition !== 'excluded') return bad(`leaf ${i}: unknown disposition`)
    if (!Array.isArray(l.excludedFor) || !l.excludedFor.every(c => typeof c === 'string' && (VALIDATION_CODES as readonly string[]).includes(c))) {
      return bad(`leaf ${i}: excludedFor must hold validation codes`)
    }
  }
  for (let i = 0; i < tally.nodes.length; i++) {
    const n: unknown = tally.nodes[i]
    if (!isRec(n)) return bad(`node ${i} is not an object`)
    if (!Number.isSafeInteger(n.index)) return bad(`node ${i}: index must be an integer`)
    if (!Array.isArray(n.range) || n.range.length !== 2 || !Number.isSafeInteger(n.range[0]) || !Number.isSafeInteger(n.range[1])) return bad(`node ${i}: range must be two integers`)
    if (n.left !== undefined && !Number.isSafeInteger(n.left)) return bad(`node ${i}: left must be an integer`)
    if (n.right !== undefined && !Number.isSafeInteger(n.right)) return bad(`node ${i}: right must be an integer`)
    if (!isHex64(n.merkleHash) || !isHex64(n.hash)) return bad(`node ${i}: merkleHash and hash must be 64 lowercase hex characters`)
    if (!isWellFormedHistogram(n.histogram)) return bad(`node ${i}: histogram is malformed`)
  }
  return null
}

/**
 * Recomputes every node of an untrusted tally and reports the first failure with its index. Order: format
 * (before any hashing), shape (leaf order, node order, ranges and children as R5 builds them), leaf data and
 * disposition rules, then per node in index order the R5 merkle hash, the histogram (a leaf's own bounds, a
 * parent's sum of its children) and the 0x03 tally hash, and last the root. Never throws.
 *
 * What a pass proves: every histogram, every merkle hash and every tally hash is consistent and the branch
 * from each leaf to the root holds, which is doc/election.md "Validate every Tally and Merkle tree node". What
 * it does NOT prove: that the leaf histograms match the decrypted blocks. That needs the released key, and the
 * check is buildTallyTree over the rows and a comparison of the roots.
 */
export function verifyTallyTree (tally: unknown): TallyVerifyResult {
  try {
    return verifyChecked(tally)
  } catch {
    return vfail('malformed-tally', 'the tally could not be read')
  }
}

function verifyChecked (input: unknown): TallyVerifyResult {
  const format = checkTallyFormat(input)
  if (format !== null) return format
  const tally = input as unknown as TallyTree
  const leaves = tally.leaves
  const nodes = tally.nodes

  // shape
  for (let i = 0; i < leaves.length; i++) {
    if (leaves[i]!.index !== i) return vfail('shape-mismatch', `leaf ${i} carries index ${leaves[i]!.index}`, { leafIndex: i })
    if (i > 0 && (compareUtf8(leaves[i - 1]!.blockCid, leaves[i]!.blockCid) || compareUtf8(leaves[i - 1]!.leafData, leaves[i]!.leafData)) >= 0) {
      return vfail('shape-mismatch', `leaf ${i} is not after leaf ${i - 1} in leaf order (Cid, then leafData)`, { leafIndex: i })
    }
  }
  const shape = expectedShape(leaves.length)
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    const want = shape[i]!
    if (n.index !== i || n.range[0] !== want.range[0] || n.range[1] !== want.range[1] || n.left !== want.left || n.right !== want.right) {
      return vfail('shape-mismatch', `node ${i} is not where the block tree puts it`, { nodeIndex: i })
    }
  }

  // leaf data and disposition rules
  for (let i = 0; i < leaves.length; i++) {
    const l = leaves[i]!
    const bad = (detail: string): VerifyFailure => vfail('leaf-mismatch', `leaf ${i}: ${detail}`, { leafIndex: i })
    let parsed: unknown
    try { parsed = JSON.parse(l.leafData) } catch { return bad('leafData is not JSON') }
    if (!Array.isArray(parsed) || parsed.length !== 8 || canonicalJson(parsed) !== l.leafData) return bad('leafData is not the canonical leaf tuple')
    const [electionId, electionRevision, ballotId, , cid, entryCount] = parsed as unknown[]
    if (electionId !== tally.electionId || electionRevision !== tally.electionRevision) return bad('leafData names another election or revision')
    if (ballotId !== l.ballotId || cid !== l.blockCid || entryCount !== l.entryCount) return bad('leafData differs from the leaf fields')
    if (l.disposition === 'tallied' ? l.excludedFor.length !== 0 : l.excludedFor.length === 0) return bad('excludedFor does not fit the disposition')
    if (!l.excludedFor.every((c, k) => k === 0 || byString(l.excludedFor[k - 1]!, c) < 0)) return bad('excludedFor is not sorted and unique')
  }

  // nodes
  const countingLeafOf = new Map<string, number>()
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    if (n.range[1] - n.range[0] === 1) {
      const leaf = leaves[n.range[0]]!
      // T-65-05-03: one ciphertext is counted once; of the leaves sharing a Cid, at most one has votes
      const counts = own(n.histogram.ballots, leaf.ballotId) ? n.histogram.ballots[leaf.ballotId]! : null
      if (counts !== null && counts.votes > 0) {
        const other = countingLeafOf.get(leaf.blockCid)
        if (other !== undefined) {
          return vfail('histogram-mismatch', `leaf node ${i}: leaf ${other} of the same Cid already counts its entries`, { nodeIndex: i, leafIndex: n.range[0] })
        }
        countingLeafOf.set(leaf.blockCid, n.range[0])
      }
      if (n.merkleHash !== blockLeafHash(leaf.leafData)) return vfail('merkle-hash-mismatch', `leaf node ${i}: merkle hash is not the leaf hash`, { nodeIndex: i })
      const problem = leafBoundProblem(n.histogram, leaf)
      if (problem !== null) return vfail('histogram-mismatch', `leaf node ${i}: ${problem}`, { nodeIndex: i })
    } else {
      const left = nodes[n.left!]!
      const right = nodes[n.right!]!
      if (n.merkleHash !== blockNodeHash(left.merkleHash, right.merkleHash)) return vfail('merkle-hash-mismatch', `node ${i}: merkle hash is not the hash of its children`, { nodeIndex: i })
      if (canonicalJson(n.histogram) !== canonicalJson(addHistograms(left.histogram, right.histogram))) {
        return vfail('histogram-mismatch', `node ${i}: histogram is not the sum of its children`, { nodeIndex: i })
      }
    }
    const leaf = n.range[1] - n.range[0] === 1 ? leaves[n.range[0]]! : null
    const want = leaf !== null
      ? tallyLeafHash(n.merkleHash, n.histogram, leaf.disposition, leaf.excludedFor)
      : tallyParentHash(n.merkleHash, nodes[n.left!]!.hash, nodes[n.right!]!.hash, n.histogram)
    if (n.hash !== want) return vfail('tally-hash-mismatch', `node ${i}: hash is not the tally hash`, { nodeIndex: i })
  }

  // root
  if (nodes.length === 0) {
    if (tally.blockRoot !== BLOCK_TREE_EMPTY_ROOT) return vfail('root-mismatch', 'blockRoot is not the empty root')
    if (canonicalJson(tally.histogram) !== canonicalJson({ ballots: {} })) return vfail('root-mismatch', 'the empty tally must have an empty histogram')
    if (tally.root !== tallyNodeHash(BLOCK_TREE_EMPTY_ROOT, { ballots: {} })) return vfail('root-mismatch', 'root is not the empty tally hash')
    return { ok: true }
  }
  const last = nodes[nodes.length - 1]!
  if (tally.blockRoot !== last.merkleHash) return vfail('root-mismatch', 'blockRoot is not the last node merkle hash')
  if (tally.root !== last.hash) return vfail('root-mismatch', 'root is not the last node hash')
  if (canonicalJson(tally.histogram) !== canonicalJson(last.histogram)) return vfail('root-mismatch', 'the root histogram is not the last node histogram')
  return { ok: true }
}
