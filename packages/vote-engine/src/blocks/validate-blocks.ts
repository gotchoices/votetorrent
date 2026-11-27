// validate-blocks.ts — R7 (D-70, D-71): comprehensive validation of every committed VoteBlock of one election
// revision (65-07).
//
// Role:
//   - doc/election.md "Validation", comprehensive level: anyone can recompute that every block is well formed,
//     that every voter consented, and that every vote is a legal answer to its ballot.
//
// Two phases:
//   - No key: Cid re-derived from the ciphertext, the registrant list canonical and as long as EntryCount, the
//     template digest, an AUTHENTICATED VoteBlockVoter row for every listed registrant (consent signature
//     verifies, the registrant is registered and the device key is associated, CR-02), and a registrant in at
//     most one block per ballot. Every block is then `not-decryptable-yet`, which is a status of its own and not
//     a failure.
//
// Authorization (CR-02): the signatures alone are self-certifying (a key from the same untrusted row). Each
// voter row is therefore checked against the caller's Registrant and Association rows with the rule of the
// schema's VoterAssociated CHECK: an Association (RegistrantId, DeviceKey) whose Expiration is later than the
// reference time, joined to a Registrant whose Status is 'a' and whose Expiration is later than the reference
// time. The schema compares with the writer's clock at insert (context.now), which a validator cannot see; the
// insert had to fall in [votingStarts, accruingVotes), so the reference time is the timeline's votingStarts,
// the weakest bound every honest insert met. The Status and the Association rows are read as the caller
// supplies them: a registrant revoked, or an association deleted, after voting fails the check.
//
// Attribution (CR-03): a finding lands on a block only when the evidence is authenticated for that block.
// Rows are grouped per (block, registrant); the representative of a listed registrant is a row with no problem
// if there is one, else the row with the fewest problems, then the lowest row key. Its problems are block-level
// findings. Every other row naming the block (a second row, a row for an unlisted registrant, a row with no
// RegistrantId) is the report-level finding `voter-row-forged` and never touches the block. A registrant counts
// for `registrant-in-two-blocks` only in blocks where its representative row is authenticated. The grouping, the
// per-row rule and the authorization index are R5's judgeBlockVoters and blockAuthorizer (T-65-05-03), so R5's
// choice among rows sharing a Cid and R7's findings use one definition of an authenticated voter.
//   - After key release (a caller-held secret): every block is opened with openCommittedBlock, the payload is
//     checked (id, count, the shared checkPoolPayloadShape, every voter entry), and every vote is opened and
//     judged against its ballot template by validateVoteEntryAgainstBallot (D-71). Valid votes carry their
//     VoteEntry for the R8 tally; invalid votes are counted apart.
//
// Why decryptElectionBlocks is not called: it zero-fills the reconstructed secret before the per-vote layer can
// be opened. Research option A: the CALLER holds the secret, and the block layer is opened by the same
// openElectionBlock primitive through openCommittedBlock.
//
// Secret rule: the secret is checked against the joint key before anything opens. The function works on a
// private copy and zero-fills it in a finally block. The caller's array is never modified and never retained,
// and the report holds no byte array.
//
// Row policy (WR-06, T-65-05-03): the block rows are selected by R5's selectBlockRows with the same voter rows,
// registrants, associations, timeline and ballots, so R7 judges exactly the rows R5 makes leaves of, in R5's leaf
// order (Cid, then leafData). A malformed row and an unauthenticated row of a shared Cid are report-level findings
// (`malformed-row`, `duplicate-block`) and are not blocks of the report; they never touch another block. Rows that
// share only an Id are separate blocks, each judged on its own consent rows.
//
// Shared Cid (T-65-05-03): R5 keeps every authenticated row of a Cid as a leaf, because before the release nothing
// shows which voter list the ciphertext holds. After the release each leaf is checked against the payload
// (checkPoolPayloadShape: voter-count-mismatch, voter-list-mismatch; payload-count-mismatch; id-mismatch), so at
// most one leaf of a Cid is valid; two valid leaves would be the hard inconsistency `cid-in-two-valid-blocks` on
// both. Leaves of one Cid are ONE block for `registrant-in-two-blocks`, so a forged leaf listing honest voters never
// invalidates the honest leaf. One leaf per Cid counts the ciphertext's entries (the valid one, else one not
// decryptable yet, else an invalid one; then the most attested entries; then leaf order); the others carry
// `shadowedBy` and count nothing (attestedEntries 0, no undecryptable entries), so R8 never counts one ciphertext
// twice.
//
// Rules: the report is deterministic for any input order and the function never reports failure by raising an
// error; every primitive that can fail on hostile input is wrapped and mapped to a typed finding. Pure for
// Hermes and the browser: noble-backed relative imports only, no Node-only globals, no logging, no clock, no
// randomness.

import { utf8ToBytes } from '@noble/hashes/utils.js'
import { validateVoteEntryAgainstBallot, type AnswerCheckBallot, type FindingSeverity } from './answer-checks.js'
import {
  blockAuthorizer, blockLeafData, blockLeafHash, judgeBlockVoters, selectBlockRows,
  type BlockAuthorization, type BlockConsentScope, type BlockTreeRow
} from './block-tree.js'
import { checkElectionSecret, openCommittedBlock } from './open-committed-block.js'
import { checkPoolPayloadShape, poolBlockCid, poolBlockId } from '../pool/pool-block.js'
import { canonicalJson } from '../voting/canonical.js'
import { ballotTemplateDigest, voterEntryDigest, VOTER_ENTRY_KEYS, type VoteEntry } from '../voting/vote-entries.js'
import { verifySigP256 } from '../database/initialize.js'

export const VALIDATION_CODES = Object.freeze([
  // block, no key needed ('malformed-row' is also block-level for a kept row with no Ciphertext text)
  'malformed-row', 'duplicate-block', 'cid-mismatch', 'voter-list-malformed', 'voter-list-not-canonical',
  'entry-count-mismatch', 'unknown-ballot', 'template-mismatch', 'voter-row-mismatch',
  'voter-row-missing', 'consent-signature-invalid', 'voter-not-registered', 'device-key-not-associated',
  'registrant-in-two-blocks',
  // report level (not tied to a validated block); 'malformed-row' and 'duplicate-block' also land here for
  // rows the R5 selection set aside
  'voter-row-without-block', 'voter-row-forged',
  // block, after release ('cid-in-two-valid-blocks': two leaves of one Cid both pass every check, T-65-05-03;
  // unreachable by construction, a hard inconsistency that excludes both rather than counting twice)
  'block-does-not-open', 'id-mismatch', 'payload-count-mismatch', 'cid-in-two-valid-blocks',
  'not-a-payload', 'counts-differ', 'voter-count-mismatch', 'not-canonical-order', 'duplicate-vote', 'duplicate-voter',
  'voter-list-mismatch', 'voter-entry-scope-mismatch',
  'voter-entry-malformed', 'voter-entry-signature-invalid', 'voter-entry-ballot-missing', 'voter-entry-device-key-mismatch',
  // per vote, after release ('vote-not-canonical' is info: IN-07)
  'vote-does-not-open', 'vote-not-json', 'vote-not-canonical',
  // per vote, the answer-checks codes, repeated literally so the union stays closed and greppable
  'malformed-ballot', 'malformed-entry', 'wrong-election', 'wrong-revision', 'wrong-ballot', 'template-digest-mismatch',
  'bad-nonce', 'answers-not-sorted', 'duplicate-question', 'unknown-question', 'empty-answer', 'unknown-option',
  'duplicate-option', 'options-not-sorted', 'too-many-options', 'below-minimum',
  'blank-required', 'unsupported-question-type'
] as const)

export type ValidationCode = typeof VALIDATION_CODES[number]

/** Severity 'info' exactly for these; every other code is 'error'. */
export const VALIDATION_INFO_CODES = Object.freeze(['voter-row-without-block', 'vote-not-canonical', 'blank-required', 'unsupported-question-type'] as const)

export interface ValidationFinding {
  /** '' only for a row whose Cid is not a string */
  blockCid: string
  code: ValidationCode
  severity: FindingSeverity
  detail: string
  /** index into the opened payload.votes (payload order) */
  voteIndex?: number
  registrantId?: string
  questionCode?: string
  optionCode?: string
}

export type VoteVerdict =
  | { index: number, status: 'valid', entry: VoteEntry }
  | { index: number, status: 'invalid', codes: readonly ValidationCode[] }

export interface BlockFinding {
  /** '' where the row field is unreadable */
  blockCid: string
  /** the R5 leaf hash of this block's row: names the leaf, also when several leaves share a Cid (T-65-05-03) */
  leafHash: string
  /**
   * T-65-05-03: null when this block counts its ciphertext's entries; else the leafHash of the block of the same
   * Cid that does (the valid one if any). A shadowed block counts nothing: attestedEntries 0, and no undecryptable
   * entries, so one ciphertext's entries are never counted twice.
   */
  shadowedBy: string | null
  blockId: string
  ballotId: string
  /** null before release or when the block did not open */
  payloadVersion: 1 | 2 | null
  /** invalid iff any 'error' finding WITHOUT a voteIndex */
  status: 'valid' | 'invalid' | 'not-decryptable-yet'
  /** normalised EntryCount, 0 when unreadable */
  declaredEntries: number
  /**
   * WR-04: min(declaredEntries, listed voters, listed voters with an authenticated voter row). The volume an
   * excluded block may count: what the evidence supports, never the attacker-declared EntryCount alone.
   */
  attestedEntries: number
  /** [] before release or when the block did not open */
  votes: readonly VoteVerdict[]
  /** every finding of this block, block-level and per-vote */
  findings: readonly ValidationFinding[]
}

/**
 * WR-05: valid + invalid + excluded + undecryptable = entries, and after the release these match R8's root
 * (votes, invalid, excluded) summed over the ballots.
 */
export interface ValidationTotals {
  /** BlockFinding count = the R5 leaf count (rows set aside are report-level findings, not blocks) */
  blocks: number
  /** per block: payload.votes.length for a valid block, attestedEntries for an invalid one, declaredEntries for one not decryptable yet (0 for a shadowed block) */
  entries: number
  /** valid votes of valid blocks only */
  valid: number
  /** invalid votes of valid blocks only */
  invalid: number
  /** attestedEntries of every block whose status is 'invalid' (R8 excludes these blocks, D-82) */
  excluded: number
  /** declaredEntries of every 'not-decryptable-yet' block that is not shadowed (before the release) */
  undecryptable: number
}

export interface ValidationBlockRow {
  Cid: string
  Id: string
  ElectionId: string
  ElectionRevision: number | bigint
  BallotId: string
  TemplateDigest: string
  EntryCount: number | bigint
  VoterRegistrantIds: string
  Ciphertext: string
}

export interface ValidationVoterRow {
  ElectionId: string
  BallotId: string
  RegistrantId: string
  BlockCid: string
  BlockId: string
  ElectionRevision: number | bigint
  DeviceKey: string
  Signature: string
}

/** Caller-held secret (for example KeyReleaseEngine.reconstructElectionKey). The caller zero-fills its own array. */
export interface ValidationRelease {
  secretKey: Uint8Array
  jointPublicKey: string
}

/** A Registrant row (CR-02); other columns are ignored. Expiration is the stored ISO datetime ending in Z. */
export interface ValidationRegistrantRow { Id: string, Status: string, Expiration: string }

/** An Association row (CR-02); other columns are ignored. */
export interface ValidationAssociationRow { RegistrantId: string, DeviceKey: string, Expiration: string }

/** Structural; an Election.timeline fits. votingStarts (epoch ms) is the reference time of the authorization check. */
export interface ValidationTimeline { votingStarts: number }

export interface ValidateElectionBlocksInput {
  scope: { electionId: string, electionRevision: number }
  rows: readonly ValidationBlockRow[]
  voterRows: readonly ValidationVoterRow[]
  /** the revision's ballot templates, keyed by id */
  ballots: readonly AnswerCheckBallot[]
  /** CR-02: the registrants the voter rows name (a row that is not readable authorizes nothing) */
  registrants: readonly ValidationRegistrantRow[]
  /** CR-02: the device associations of those registrants */
  associations: readonly ValidationAssociationRow[]
  /** CR-02: the revision timeline; expirations must be later than votingStarts */
  timeline: ValidationTimeline
  release?: ValidationRelease | null
}

export type ValidationRefusal = 'malformed-input' | 'mixed-election' | 'mixed-revision' | 'invalid-secret' | 'secret-mismatch'

export type ElectionValidationResult =
  | {
    ok: true
    electionId: string
    electionRevision: number
    released: boolean
    /** R5 leaf order: ascending by UTF-8 bytes of Cid, then of leafData */
    blocks: readonly BlockFinding[]
    /** report-level only: rows set aside by the R5 selection, then voter-row-without-block */
    findings: readonly ValidationFinding[]
    totals: ValidationTotals
  }
  | { ok: false, reason: ValidationRefusal, detail: string }

type Rec = Record<string, unknown>

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function byBytes (a: string, b: string): number {
  const x = utf8ToBytes(a)
  const y = utf8ToBytes(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) {
    const d = x[i]! - y[i]!
    if (d !== 0) return d
  }
  return x.length - y.length
}

const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)

function normaliseInt (value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  return null
}

/** A stable text key of one row, safe for bigint and odd values; used only to order and tie-break. */
function rowKey (row: unknown): string {
  if (!isRec(row)) return `<${typeof row}>`
  try {
    return Object.keys(row).sort(byString).map(k => {
      const v = row[k]
      return `${k}=${typeof v === 'string' ? JSON.stringify(v) : `${typeof v}:${String(v)}`}`
    }).join('|')
  } catch {
    return '<unreadable>'
  }
}

function sameKeys (obj: Rec, expected: readonly string[]): boolean {
  const keys = Object.keys(obj).sort(byString)
  return keys.length === expected.length && keys.every((k, i) => k === expected[i])
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** Why a decrypted voter record is not shaped like a VoterEntry, or null when it is. */
function voterRecordProblem (r: unknown): string | null {
  if (!isRec(r)) return 'the voter entry is not an object'
  if (!sameKeys(r, VOTER_ENTRY_KEYS)) return 'the voter entry does not have exactly the voter entry fields'
  if (r.v !== 1) return 'the voter entry version is not 1'
  for (const k of ['electionId', 'registrantId', 'privateCid', 'deviceKey', 'signature'] as const) {
    if (!isStr(r[k])) return `the voter entry field ${k} is not a string`
  }
  if (typeof r.electionRevision !== 'number' || !Number.isSafeInteger(r.electionRevision)) return 'the voter entry electionRevision is not a safe integer'
  if (r.publicCid !== null && !isStr(r.publicCid)) return 'the voter entry publicCid is neither a string nor null'
  if (r.attestationCid !== null && !isStr(r.attestationCid)) return 'the voter entry attestationCid is neither a string nor null'
  if (!Array.isArray(r.ballots)) return 'the voter entry ballots is not an array'
  for (const b of r.ballots) {
    if (!isRec(b) || !sameKeys(b, ['ballotId', 'templateDigest']) || !isStr(b.ballotId) || !isStr(b.templateDigest)) {
      return 'a voter entry ballot is not a ballotId and templateDigest pair'
    }
  }
  return null
}

interface Work {
  row: Rec | null
  cid: string
  key: string
  fs: ValidationFinding[]
  id: string
  ballotId: string
  declared: number
  ended: boolean
  list: string[] | null
  /** CR-03: listed registrants whose representative voter row is authenticated */
  authenticated: Set<string>
  ready: boolean
  /** the row has Ciphertext text, so the block can be opened after the release */
  openable: boolean
  payloadVersion: 1 | 2 | null
  opened: boolean
  votes: VoteVerdict[]
  entries: number
  revision: number
  /** R5 leaf hash of the row */
  leafHash: string
  /** CR-03 representative device key per registrant (per block: leaves of one Cid may differ) */
  keyOf: Map<string, string>
}

function refuse (reason: ValidationRefusal, detail: string): ElectionValidationResult {
  return { ok: false, reason, detail }
}

/** Validate every committed block of one election revision. Pure; never raises. */
export function validateElectionBlocks (input: ValidateElectionBlocksInput): ElectionValidationResult {
  let secret: Uint8Array | null = null
  try {
    return validateInner(input, (s) => { secret = s })
  } catch {
    return refuse('malformed-input', 'the validation input could not be read')
  } finally {
    if (secret !== null) (secret as Uint8Array).fill(0)
  }
}

function validateInner (input: ValidateElectionBlocksInput, keepSecret: (s: Uint8Array) => void): ElectionValidationResult {
  if (!isRec(input)) return refuse('malformed-input', 'the input is not an object')
  const scopeIn = input.scope as unknown
  if (!isRec(scopeIn) || !isNonEmpty(scopeIn.electionId) || normaliseInt(scopeIn.electionRevision) === null || typeof scopeIn.electionRevision !== 'number') {
    return refuse('malformed-input', 'scope needs a non-empty electionId and a non-negative integer electionRevision')
  }
  const electionId = scopeIn.electionId
  const revision = scopeIn.electionRevision
  if (!Array.isArray(input.rows)) return refuse('malformed-input', 'rows is not an array')
  if (!Array.isArray(input.voterRows)) return refuse('malformed-input', 'voterRows is not an array')
  if (!Array.isArray(input.ballots)) return refuse('malformed-input', 'ballots is not an array')
  if (!Array.isArray(input.registrants)) return refuse('malformed-input', 'registrants is not an array')
  if (!Array.isArray(input.associations)) return refuse('malformed-input', 'associations is not an array')
  const tl = input.timeline as unknown
  if (!isRec(tl) || typeof tl.votingStarts !== 'number' || !Number.isFinite(tl.votingStarts)) {
    return refuse('malformed-input', 'timeline needs a finite votingStarts (epoch ms)')
  }
  const authorization = blockAuthorizer(input.registrants as unknown[], input.associations as unknown[], tl.votingStarts)
  const ballotsById = new Map<string, { ballot: AnswerCheckBallot, digest: string }>()
  for (const b of input.ballots as unknown[]) {
    if (!isRec(b) || !isStr(b.id) || !Array.isArray(b.questions)) return refuse('malformed-input', 'a ballot is not readable')
    if (ballotsById.has(b.id)) return refuse('malformed-input', 'two ballots share one id')
    try {
      ballotsById.set(b.id, { ballot: b as unknown as AnswerCheckBallot, digest: ballotTemplateDigest(b as never, revision) })
    } catch {
      return refuse('malformed-input', 'a ballot template digest cannot be computed')
    }
  }
  const rel = input.release as unknown
  if (rel !== undefined && rel !== null && (!isRec(rel) || !(rel.secretKey instanceof Uint8Array) || !isStr(rel.jointPublicKey))) {
    return refuse('malformed-input', 'release needs a secretKey byte array and a jointPublicKey string')
  }

  // scope: rows of another election or revision refuse the whole report
  for (const row of input.rows as unknown[]) {
    if (!isRec(row)) continue
    if (isStr(row.ElectionId) && row.ElectionId !== electionId) return refuse('mixed-election', 'a block row belongs to another election')
    const rr = normaliseInt(row.ElectionRevision)
    if (rr !== null && rr !== revision) return refuse('mixed-revision', 'a block row belongs to another election revision')
  }

  // release: check the secret first, then work on a private copy
  const electionKey = { electionId, revision, jointPublicKey: isRec(rel) ? (rel.jointPublicKey as string) : '' }
  let secret: Uint8Array | null = null
  if (isRec(rel)) {
    const ok = checkElectionSecret(rel.secretKey as Uint8Array, electionKey)
    if (!ok.ok) return refuse(ok.reason, ok.detail)
    secret = Uint8Array.from(rel.secretKey as Uint8Array)
    keepSecret(secret)
  }

  // WR-06, T-65-05-03: the same rows R5 makes leaves of, chosen with the same public inputs; the rest are
  // report-level findings
  const selection = selectBlockRows(input.rows as unknown[], { electionId, electionRevision: revision }, {
    voterRows: input.voterRows, registrants: input.registrants, associations: input.associations, timeline: tl, ballots: input.ballots
  } as unknown as BlockAuthorization)
  if (!selection.ok) {
    return selection.reason === 'mixed-election' || selection.reason === 'mixed-revision'
      ? refuse(selection.reason, selection.detail)
      : refuse('malformed-input', selection.detail)
  }
  const works: Work[] = selection.accepted.map(row => newWork(row as Rec, (row as Rec).Cid as string))
  const setAside: ValidationFinding[] = selection.rejected.map(r => ({
    blockCid: r.cid,
    code: r.reason,
    severity: 'error' as const,
    detail: `a block row was set aside: ${r.detail}`
  }))

  // voter rows by BlockCid
  const voterByCid = new Map<string, Rec[]>()
  const voterRowList: Rec[] = []
  for (const v of input.voterRows as unknown[]) {
    if (!isRec(v)) continue
    voterRowList.push(v)
    const bc = isStr(v.BlockCid) ? v.BlockCid : ''
    const g = voterByCid.get(bc)
    if (g === undefined) voterByCid.set(bc, [v])
    else g.push(v)
  }
  const regOf = (v: Rec): string => (isStr(v.RegistrantId) ? v.RegistrantId : '')
  const voterOrder = (a: Rec, b: Rec): number => byString(regOf(a), regOf(b)) || byString(rowKey(a), rowKey(b))
  const forged: ValidationFinding[] = []
  const forgedFinding = (blockCid: string, v: Rec, detail: string): ValidationFinding => ({
    blockCid, code: 'voter-row-forged', severity: 'error', detail, ...(regOf(v) !== '' ? { registrantId: regOf(v) } : {})
  })

  const add = (w: Work, code: ValidationCode, detail: string, extra: { voteIndex?: number, registrantId?: string, questionCode?: string, optionCode?: string } = {}): void => {
    const severity: FindingSeverity = (VALIDATION_INFO_CODES as readonly string[]).includes(code) ? 'info' : 'error'
    w.fs.push({ blockCid: w.cid, code, severity, detail, ...extra })
  }

  // no-key checks, per block
  for (const w of works) {
    const row = w.row
    if (row === null) {
      add(w, 'malformed-row', 'the block row is not an object')
      w.ended = true
      continue
    }
    if (isStr(row.Id)) w.id = row.Id
    if (isStr(row.BallotId)) w.ballotId = row.BallotId
    const count = normaliseInt(row.EntryCount)
    w.declared = count ?? 0
    const rev = normaliseInt(row.ElectionRevision)
    if (!isNonEmpty(row.Cid) || !isNonEmpty(row.Id) || !isNonEmpty(row.BallotId) || !isStr(row.ElectionId) ||
      !isStr(row.TemplateDigest) || !isStr(row.VoterRegistrantIds) || count === null || count < 1 || rev === null) {
      add(w, 'malformed-row', 'the block row is missing a column or holds an unreadable value')
      w.ended = true
      continue
    }
    w.id = row.Id
    w.ballotId = row.BallotId
    w.revision = rev
    w.ready = true
    // R5 keeps a row without Ciphertext text (it only ranks by it); such a block cannot be checked or opened,
    // but its voter list and voter rows are still read, so its attested volume is known (WR-04, WR-05)
    if (!isStr(row.Ciphertext)) {
      add(w, 'malformed-row', 'the block row has no Ciphertext text')
    } else {
      w.openable = true
      try {
        if (poolBlockCid(row.Ciphertext) !== row.Cid) add(w, 'cid-mismatch', 'the Cid is not the digest of the ciphertext')
      } catch {
        add(w, 'cid-mismatch', 'the Cid cannot be derived from the ciphertext')
      }
    }
    let list: string[] | null = null
    try {
      const parsed: unknown = JSON.parse(row.VoterRegistrantIds)
      if (Array.isArray(parsed) && parsed.every(isNonEmpty)) list = parsed as string[]
    } catch { /* unreadable list */ }
    w.list = list
    if (list === null) {
      add(w, 'voter-list-malformed', 'the voter list is not a JSON array of registrant ids')
    } else {
      if (!list.every((x, i) => i === 0 || byString(list![i - 1]!, x) < 0)) add(w, 'voter-list-not-canonical', 'the voter list is not in ascending order')
      if (count !== list.length) add(w, 'entry-count-mismatch', `EntryCount ${count} differs from the ${list.length} listed voters`)
    }
    const known = ballotsById.get(row.BallotId)
    if (known === undefined) add(w, 'unknown-ballot', 'no ballot template matches the block BallotId')
    else if (row.TemplateDigest !== known.digest) add(w, 'template-mismatch', 'the block TemplateDigest is not the ballot template digest')

    // consent rows of this block (CR-02, CR-03): R5's judge, so the two agree on who is authenticated
    const keyOf = w.keyOf
    const consentScope: BlockConsentScope = { Cid: row.Cid as string, Id: row.Id, ElectionId: row.ElectionId, ElectionRevision: rev, BallotId: row.BallotId }
    const judged = judgeBlockVoters(consentScope, list, voterByCid.get(w.cid) ?? [], authorization)
    for (const x of judged.extras) {
      forged.push(forgedFinding(w.cid, x.row as Rec, x.reason === 'no-registrant'
        ? 'a voter row naming this block has no RegistrantId'
        : x.reason === 'unlisted'
          ? 'a voter row names a registrant this block does not list'
          : 'a second voter row for a registrant of this block; the block keeps the row that verifies'))
    }
    const byReg = new Set<string>()
    for (const rep of judged.representatives) {
      byReg.add(rep.registrantId)
      for (const p of rep.problems) add(w, p.code, p.detail, { registrantId: rep.registrantId })
      if (rep.problems.length === 0) w.authenticated.add(rep.registrantId)
      if (isStr(rep.row.DeviceKey)) keyOf.set(rep.registrantId, rep.row.DeviceKey)
    }
    if (list !== null) {
      for (const reg of [...list].sort(byString)) {
        if (!byReg.has(reg)) add(w, 'voter-row-missing', 'a listed registrant has no voter row', { registrantId: reg })
      }
    }
  }

  // cross-block: a registrant in two blocks of one ballot. Leaves that share a Cid are ONE block here (T-65-05-03):
  // they are claims about one ciphertext, so an honest voter listed by a forged leaf of its own Cid is not double voting
  const placed = new Map<string, Map<string, Set<string>>>()
  // CR-03: only registrants whose voter row in that block is authenticated
  for (const w of works) {
    if (!w.ready || w.list === null) continue
    let byReg = placed.get(w.ballotId)
    if (byReg === undefined) { byReg = new Map(); placed.set(w.ballotId, byReg) }
    for (const reg of w.authenticated) {
      const g = byReg.get(reg)
      if (g === undefined) byReg.set(reg, new Set([w.cid]))
      else g.add(w.cid)
    }
  }
  for (const w of works) {
    if (!w.ready || w.list === null) continue
    for (const reg of [...w.authenticated].sort(byString)) {
      const g = placed.get(w.ballotId)?.get(reg)
      if (g === undefined || g.size < 2) continue
      const others = [...g].filter(c => c !== w.cid).sort(byBytes)
      add(w, 'registrant-in-two-blocks', `the registrant is also listed in block ${others.join(', ')}`, { registrantId: reg })
    }
  }

  // after release: open and judge
  if (secret !== null) {
    for (const w of works) {
      if (!w.ready || !w.openable || w.row === null) continue
      const row = w.row
      const known = ballotsById.get(w.ballotId)
      const res = openCommittedBlock({
        Cid: w.cid, Id: w.id, ElectionId: row.ElectionId as string, ElectionRevision: w.revision,
        BallotId: w.ballotId, Ciphertext: row.Ciphertext as string
      }, secret, electionKey)
      if (!res.ok) {
        add(w, 'block-does-not-open', `${res.reason}: ${res.detail}`)
        continue
      }
      w.opened = true
      w.payloadVersion = res.payloadVersion
      const payload = res.payload
      w.entries = payload.votes.length
      try {
        if (poolBlockId(payload) !== w.id) add(w, 'id-mismatch', 'the block Id is not the digest of the payload')
      } catch {
        add(w, 'id-mismatch', 'the block Id cannot be derived from the payload')
      }
      if (payload.votes.length !== w.declared) add(w, 'payload-count-mismatch', `the payload holds ${payload.votes.length} votes; EntryCount is ${w.declared}`)
      let shapeOk = false
      try {
        const shape = checkPoolPayloadShape(payload, w.list ?? [], { electionId, revision })
        if (shape.ok) shapeOk = true
        else add(w, shape.code, shape.reason)
      } catch {
        add(w, 'not-a-payload', 'the payload cannot be checked for its shape')
      }
      if (shapeOk && payload.v === 1) {
        const seenVotes = new Set<string>()
        let repeated = false
        for (const vote of payload.votes) {
          try {
            const text = canonicalJson(vote)
            if (seenVotes.has(text)) repeated = true
            seenVotes.add(text)
          } catch { /* an unreadable clear vote is reported by its own verdict */ }
        }
        if (repeated) add(w, 'duplicate-vote', 'a clear vote appears twice')
      }
      const keyOf = w.keyOf
      for (const r of payload.voterRecords as unknown[]) {
        const problem = voterRecordProblem(r)
        if (problem !== null) {
          add(w, 'voter-entry-malformed', problem, isRec(r) && isStr(r.registrantId) ? { registrantId: r.registrantId } : {})
          continue
        }
        const rec = r as unknown as { registrantId: string, deviceKey: string, signature: string, ballots: Array<{ ballotId: string, templateDigest: string }> }
        let signed = false
        try {
          signed = verifySigP256(voterEntryDigest(r as never), rec.signature, rec.deviceKey)
        } catch { signed = false }
        if (!signed) add(w, 'voter-entry-signature-invalid', 'the voter entry signature does not verify', { registrantId: rec.registrantId })
        if (!rec.ballots.some(b => b.ballotId === w.ballotId && b.templateDigest === (row.TemplateDigest as string))) {
          add(w, 'voter-entry-ballot-missing', 'the voter entry does not list this ballot and template', { registrantId: rec.registrantId })
        }
        const rowKeyHex = keyOf.get(rec.registrantId)
        if (rowKeyHex !== undefined && rowKeyHex !== rec.deviceKey) {
          add(w, 'voter-entry-device-key-mismatch', 'the voter entry device key differs from the consent row device key', { registrantId: rec.registrantId })
        }
      }
      for (const ov of res.votes) {
        if (!ov.ok) {
          add(w, ov.reason, ov.detail, { voteIndex: ov.index })
          w.votes.push({ index: ov.index, status: 'invalid', codes: [ov.reason] })
          continue
        }
        if (!ov.canonical) {
          // IN-07: the vote still counts; the non-canonical text is a client fingerprint inside the block (D-23)
          add(w, 'vote-not-canonical', 'the decrypted vote text is not the canonical JSON of its entry', { voteIndex: ov.index })
        }
        if (known === undefined) {
          add(w, 'unknown-ballot', 'no ballot template matches the block BallotId', { voteIndex: ov.index })
          w.votes.push({ index: ov.index, status: 'invalid', codes: ['unknown-ballot'] })
          continue
        }
        let verdict: ReturnType<typeof validateVoteEntryAgainstBallot>
        try {
          verdict = validateVoteEntryAgainstBallot(ov.entry, known.ballot, { electionId, electionRevision: revision, ballotId: w.ballotId, templateDigest: known.digest })
        } catch {
          verdict = { valid: false, findings: [{ code: 'malformed-entry', severity: 'error', detail: 'the vote entry cannot be checked' }] }
        }
        const errorCodes: ValidationCode[] = []
        for (const f of verdict.findings) {
          add(w, f.code, f.detail, {
            voteIndex: ov.index,
            ...(f.questionCode !== undefined ? { questionCode: f.questionCode } : {}),
            ...(f.optionCode !== undefined ? { optionCode: f.optionCode } : {})
          })
          if (f.severity === 'error') errorCodes.push(f.code)
        }
        w.votes.push(verdict.valid ? { index: ov.index, status: 'valid', entry: verdict.entry } : { index: ov.index, status: 'invalid', codes: errorCodes })
      }
    }
  }

  // report, in R5 leaf order (selectBlockRows returns the kept rows in it)
  const released = secret !== null
  const ordered = works
  const blockLevelError = (w: Work): boolean => w.fs.some(f => f.severity === 'error' && f.voteIndex === undefined)
  const groups = new Map<string, Work[]>()
  for (const w of ordered) {
    const g = groups.get(w.cid)
    if (g === undefined) groups.set(w.cid, [w])
    else g.push(w)
  }
  // T-65-05-03: at most one leaf of a Cid may be valid. Two can only pass together if the payload matched two leaves,
  // which the leaf data rules out; if it ever happens, both are excluded rather than counted twice
  if (released) {
    for (const g of groups.values()) {
      const valid = g.filter(w => !blockLevelError(w))
      if (valid.length < 2) continue
      for (const w of valid) {
        const others = valid.filter(o => o !== w).map(o => o.leafHash).sort(byString)
        add(w, 'cid-in-two-valid-blocks', `another leaf of this Cid also passes every check (leaf ${others.join(', ')})`)
      }
    }
  }
  const statusOf = (w: Work): BlockFinding['status'] => (blockLevelError(w) ? 'invalid' : released ? 'valid' : 'not-decryptable-yet')
  const attestedOf = (w: Work): number => Math.min(w.declared, w.list === null ? 0 : w.list.length, w.authenticated.size)
  // T-65-05-03: one leaf per Cid counts the ciphertext's entries: the valid one, else one not decryptable yet, else an
  // invalid one; then the most attested entries; then leaf order. The others are shadowed and count nothing
  const counting = new Map<string, Work>()
  const statusRank = { valid: 0, 'not-decryptable-yet': 1, invalid: 2 } as const
  for (const [cid, g] of groups) {
    let best = g[0]!
    for (const w of g.slice(1)) {
      const d = (statusRank[statusOf(w)] - statusRank[statusOf(best)]) || (attestedOf(best) - attestedOf(w))
      if (d < 0) best = w
    }
    counting.set(cid, best)
  }
  const blocks: BlockFinding[] = ordered.map(w => {
    const counter = counting.get(w.cid)!
    const shadowedBy = counter === w ? null : counter.leafHash
    return {
      blockCid: w.cid,
      leafHash: w.leafHash,
      shadowedBy,
      blockId: w.id,
      ballotId: w.ballotId,
      payloadVersion: w.payloadVersion,
      status: statusOf(w),
      declaredEntries: w.declared,
      attestedEntries: shadowedBy === null ? attestedOf(w) : 0,
      votes: w.votes,
      findings: w.fs
    }
  })
  const totals: ValidationTotals = { blocks: blocks.length, entries: 0, valid: 0, invalid: 0, excluded: 0, undecryptable: 0 }
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    const w = ordered[i]!
    if (b.status === 'invalid') {
      totals.entries += b.attestedEntries
      totals.excluded += b.attestedEntries
    } else if (b.status === 'valid') {
      totals.entries += w.entries
      for (const v of w.votes) {
        if (v.status === 'valid') totals.valid++
        else totals.invalid++
      }
    } else if (b.shadowedBy === null) {
      totals.entries += b.declaredEntries
      totals.undecryptable += b.declaredEntries
    }
  }
  const known = new Set(works.map(w => w.cid))
  const orphans: ValidationFinding[] = []
  for (const v of [...voterRowList].sort((a, b) => byBytes(isStr(a.BlockCid) ? a.BlockCid : '', isStr(b.BlockCid) ? b.BlockCid : '') || voterOrder(a, b))) {
    const bc = isStr(v.BlockCid) ? v.BlockCid : ''
    if (known.has(bc)) continue
    if (v.ElectionId !== electionId || normaliseInt(v.ElectionRevision) !== revision) continue
    orphans.push({
      blockCid: bc,
      code: 'voter-row-without-block',
      severity: 'info',
      detail: 'a voter row names a block that has no row',
      ...(regOf(v) !== '' ? { registrantId: regOf(v) } : {})
    })
  }
  forged.sort((a, b) => byBytes(a.blockCid, b.blockCid) || byString(a.registrantId ?? '', b.registrantId ?? '') || byString(a.detail, b.detail))
  return { ok: true, electionId, electionRevision: revision, released, blocks, findings: [...setAside, ...forged, ...orphans], totals }
}

function newWork (row: Rec | null, cid: string): Work {
  return {
    row, cid, key: rowKey(row), fs: [], id: '', ballotId: '', declared: 0, ended: false, list: null, authenticated: new Set(), ready: false, openable: false,
    payloadVersion: null, opened: false, votes: [], entries: 0, revision: 0, leafHash: leafHashOf(row), keyOf: new Map()
  }
}

/** The R5 leaf hash of a kept row (selectBlockRows keeps only rows R5 can hash); '' if it cannot be computed. */
function leafHashOf (row: Rec | null): string {
  if (row === null) return ''
  try {
    return blockLeafHash(blockLeafData(row as unknown as BlockTreeRow))
  } catch {
    return ''
  }
}
