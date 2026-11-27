// block-tree.ts — R5 (D-50, D-51): the Merkle tree over one election revision's committed VoteBlock rows.
//
// Role:
//   - A pure, deterministic function from the committed VoteBlock rows of one (election, revision) to a
//     tree whose root anyone can recompute to the same value, whatever order the rows arrive in. It also
//     yields inclusion proofs (for the Voter's slice check, R6) and the full node table (for the tally
//     tree, R8).
//
// Format contract (third parties must be able to reproduce this byte for byte):
//   - Leaf data: canonicalJson([ElectionId, ElectionRevision, BallotId, Id, Cid, EntryCount, TemplateDigest,
//     voterListDigest]), with both integers as plain numbers, TemplateDigest exactly as stored, and
//     voterListDigest = hex(sha256(utf8(VoterRegistrantIds))) over the stored JSON text. The root so binds the
//     block's frozen voter list and its template column, which no other hash covers (the Cid covers only the
//     ciphertext). The list enters as a digest because the leaf data is published inside the tally tree and
//     must not carry registrant ids.
//   - Leaf hash: sha256(0x00 || utf8(leafData)).  Node hash: sha256(0x01 || leftHash || rightHash).
//   - Leaf order: ascending by the UTF-8 bytes of Cid (a shorter prefix sorts first), then by the UTF-8 bytes of
//     leafData. A Cid must be a base32 CID ('b' then a-z, 2-7), and two leaves of one Cid never have equal
//     leafData (exact duplicates collapse), so that order is total.
//   - Shape: RFC 6962. A range of width n > 1 splits at the largest power of two strictly below n; a lone
//     node is carried up and NEVER duplicated.
//   - Empty set: the root is sha256(utf8('vt-block-tree/1/empty')). One leaf: the root is its own hash.
//   - Final gate: a FINAL root is produced only once nowMs >= timeline.hashingVotes.
//
// Row policy (WR-06, TOLERANT, shared with R7 through selectBlockRows): one bad row never refuses the tree.
//   - A row that is not shaped like a block is set aside as `malformed-row` in `rejected`.
//   - Rows that share an Id but not a Cid are separate blocks, each with its own leaf (T-65-05-03). R7 judges
//     each one on its own consent rows, so a forged row reusing an honest Id cannot take the honest leaf.
//   - Rows that share a Cid (T-65-05-03). The R5 root is final at hashingVotes, before the key release, so which
//     voter list the ciphertext really holds cannot be decided here. Each row of a shared Cid is first checked for
//     AUTHENTICATION: its Cid is the digest of its own Ciphertext (blockCidOf), its voter list is a canonical JSON
//     array as long as EntryCount, its TemplateDigest is the template digest of its ballot, and every listed
//     registrant has a VoteBlockVoter row naming this Cid that judgeBlockVoters authenticates (consent signature
//     over consentDigest, Registrant and Association, CR-02). These are exactly R7's no-key block checks other than
//     the cross-block one. Then:
//       - EVERY authenticated row is kept as a leaf of its own; an exact duplicate (equal leafData) collapses to
//         one. R7 decides after the release: at most one of them matches the payload, and R7 counts this
//         ciphertext's entries once (BlockFinding.shadowedBy).
//       - The rows that are not authenticated go to `rejected` as `duplicate-block`, so junk cannot add leaves
//         under an honest Cid.
//       - When no row of the Cid is authenticated, one row is kept: a Cid that matches its own Ciphertext first,
//         then the lowest UTF-8 bytes of canonicalJson([Cid, Id, BallotId, EntryCount, TemplateDigest,
//         VoterRegistrantIds, Ciphertext]). R7 finds it invalid anyway.
//     Authentication runs only for a Cid that more than one row names, so a tree with no collision checks no
//     signature.
//   - The authorization (voter rows, registrants, associations, timeline, ballots) is a REQUIRED input, so the
//     root is a function of public data every party passes identically. A malformed one refuses the tree as
//     `malformed-input`; a hostile item inside its row lists authorizes nothing.
//   - Only a row of another election or revision refuses the whole tree (`mixed-election`, `mixed-revision`):
//     that is a caller error (rows are selected per election revision), and R7 refuses it the same way.
//
// Rules:
//   - Results are typed unions; nothing here reports failure by throwing.
//   - Pure: no clock (nowMs is a parameter), no randomness, no Node-only globals, no logging. Imports are
//     limited to the noble hash helpers, @optimystic/quereus-plugin-crypto (the digest framing and P-256 verify
//     that verifySigP256 itself calls), ../voting/canonical.js and ../voting/vote-entries.js, all already inside
//     the browser entry allowlist (D-52).

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { digestFields, resolveHasher, resolveOutputEncoder, verify as verifySignature } from '@optimystic/quereus-plugin-crypto'
import { canonicalJson } from '../voting/canonical.js'
import { ballotTemplateDigest, type TemplateBallot } from '../voting/vote-entries.js'

export const BLOCK_TREE_DOMAIN = 'vt-block-tree/1' as const

/** Root of the empty set (no committed blocks). */
export const BLOCK_TREE_EMPTY_ROOT: string = bytesToHex(sha256(utf8ToBytes(`${BLOCK_TREE_DOMAIN}/empty`)))

/** Structural subset of a VoteBlock row; other columns are ignored. */
export interface BlockTreeRow {
  /** optional here: used only to rank rows that share a Cid (blockCidOf); a row without it never authenticates */
  Ciphertext?: string
  Cid: string
  Id: string
  ElectionId: string
  ElectionRevision: number | bigint
  BallotId: string
  EntryCount: number | bigint
  TemplateDigest: string
  /** the stored JSON text of the sorted registrant ids; the leaf binds its sha256 (voterListDigest) */
  VoterRegistrantIds: string
}

export interface BlockTreeScope { electionId: string, electionRevision: number }

export interface BlockTreeLeaf {
  /** Position after canonical ordering. */
  index: number
  cid: string
  blockId: string
  ballotId: string
  /** Normalised safe integer. */
  entryCount: number
  leafData: string
  hash: string
}

export interface BlockTreeNode {
  /** Position in BlockTree.nodes (post-order: children before parent). */
  index: number
  hash: string
  /** Leaf index range [lo, hi); a leaf node has hi - lo === 1. */
  range: readonly [number, number]
  left?: number
  right?: number
}

/** side = where the SIBLING sits relative to the running hash. */
export interface BlockProofStep { side: 'left' | 'right', hash: string }

export interface BlockInclusionProof {
  leafIndex: number
  treeSize: number
  /** Leaf-to-root order. */
  path: readonly BlockProofStep[]
}

/** `ambiguous-block`: the Cid names more than one leaf (T-65-05-03) and no leaf hash was given to choose one. */
export type BlockProofResult = { ok: true, proof: BlockInclusionProof } | { ok: false, reason: 'unknown-block' | 'ambiguous-block' }

export interface BlockTree {
  electionId: string
  electionRevision: number
  root: string
  size: number
  /** Ascending by UTF-8 bytes of Cid, then of leafData (a Cid may name several authenticated leaves). */
  leaves: readonly BlockTreeLeaf[]
  /** 2*size-1 entries, root last; empty when size === 0. */
  nodes: readonly BlockTreeNode[]
  /** rows set aside (WR-06), ascending by UTF-8 bytes of cid then detail; they have no leaf */
  rejected: readonly BlockTreeRejection[]
  /** The proof of the leaf with this Cid; `leafHash` picks one when the Cid names several leaves. */
  proofFor: (cid: string, leafHash?: string) => BlockProofResult
}

export type BlockTreeRejectReason = 'malformed-row' | 'duplicate-block'

/** A row that has no leaf. No position: the result does not depend on input order. */
export interface BlockTreeRejection {
  /** the row's Cid when it is a string, else '' */
  cid: string
  reason: BlockTreeRejectReason
  detail: string
}

/** The rows selectBlockRows keeps (in leaf order: Cid, then leafData) and sets aside; `row` is the caller's own object. */
export type BlockRowSelection<R> =
  | { ok: true, accepted: readonly R[], rejected: ReadonlyArray<BlockTreeRejection & { row: unknown }> }
  | { ok: false, reason: BlockTreeRefusal, detail: string }

/**
 * Whole-tree refusals: `malformed-row` only when `rows` is not an array, `malformed-input` when the authorization
 * is not readable. `duplicate-block` is kept for type compatibility and no longer returned.
 */
export type BlockTreeRefusal = 'malformed-row' | 'malformed-input' | 'duplicate-block' | 'mixed-election' | 'mixed-revision'
export type BlockTreeResult = { ok: true, tree: BlockTree } | { ok: false, reason: BlockTreeRefusal, detail: string }
export type InclusionCheck = { ok: true } | { ok: false, reason: 'malformed-proof' | 'root-mismatch' }

/** Structural; an Election.timeline fits. */
export interface BlockTreeTimeline { accruingVotes: number, hashingVotes: number }

export type BlockTreeStatus =
  | { ok: true, final: true }
  | { ok: false, reason: 'accruing-not-ended', finalAtMs: number }
  | { ok: false, reason: 'timeline-invalid' | 'clock-invalid' }

export type FinalBlockTreeResult =
  | { ok: true, final: true, tree: BlockTree }
  | { ok: false, reason: 'accruing-not-ended', finalAtMs: number, provisional: BlockTree }
  | { ok: false, reason: 'timeline-invalid' | 'clock-invalid' }
  | { ok: false, reason: BlockTreeRefusal, detail: string }

const HEX64 = /^[0-9a-f]{64}$/

/**
 * IN-05: a VoteBlock Cid is a CIDv1 in multibase base32 (prefix 'b', RFC 4648 lowercase alphabet, no
 * padding), the form `cid(Digest(Ciphertext))` produces. Only this character set is accepted, so the UTF-8
 * byte order of leaves is a total order: distinct strings never encode to equal bytes (a lone surrogate
 * would encode to U+FFFD).
 */
const BASE32_CID = /^b[a-z2-7]+$/

/** Is `cid` shaped like a base32 CIDv1 string (character set only)? */
export function isBase32Cid (cid: unknown): cid is string {
  return typeof cid === 'string' && BASE32_CID.test(cid)
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

/** Largest power of two strictly below n (n >= 2). */
function splitPoint (n: number): number {
  let k = 1
  while (k * 2 < n) k *= 2
  return k
}

/**
 * The A6 format contract: the exact string a block's leaf hash is taken over. Both integers are
 * normalised to plain numbers first, because a Quereus row read may surface a bigint and JSON cannot
 * carry one. The voter list enters as voterListDigest, never as registrant ids.
 */
export function blockLeafData (row: BlockTreeRow): string {
  return canonicalJson([
    row.ElectionId, Number(row.ElectionRevision), row.BallotId, row.Id, row.Cid, Number(row.EntryCount),
    row.TemplateDigest, voterListDigest(row.VoterRegistrantIds)
  ])
}

/** hex(sha256(utf8(VoterRegistrantIds))): the leaf's commitment to the stored voter list text. */
export function voterListDigest (voterRegistrantIds: string): string {
  return bytesToHex(sha256(utf8ToBytes(voterRegistrantIds)))
}

/** hex(sha256(0x00 || utf8(leafData))). */
export function blockLeafHash (leafData: string): string {
  return bytesToHex(sha256(concatBytes(Uint8Array.of(0x00), utf8ToBytes(leafData))))
}

/** hex(sha256(0x01 || left || right)). */
export function blockNodeHash (leftHex: string, rightHex: string): string {
  return bytesToHex(sha256(concatBytes(Uint8Array.of(0x01), hexToBytes(leftHex), hexToBytes(rightHex))))
}

function intField (value: unknown, min: number): number | undefined {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return undefined
    value = Number(value)
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return undefined
  return value
}

interface NormalRow { cid: string, id: string, ballotId: string, entryCount: number, templateDigest: string, voterRegistrantIds: string }

type RowCheck =
  | { ok: true, row: NormalRow }
  | { ok: false, reason: 'malformed-row', detail: string }
  | { ok: false, reason: 'mixed-election' | 'mixed-revision', detail: string }

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lowercase, no padding. */
function base32Lower (bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/**
 * The Cid a VoteBlock row must carry for this ciphertext: the noble-only twin of SQL `cid(Digest(Ciphertext))`
 * and of pool-block's poolBlockCid (block-tree.spec pins the parity). Digest frames one text field as
 * [0x01 format][0x03 text tag][varint length][UTF-8 bytes] and hashes it with SHA-256; `cid` then hashes those
 * 32 bytes again and wraps them as CIDv1 (0x01), codec raw (0x55), multihash sha2-256 (0x12, 0x20), printed in
 * multibase base32 ('b'). Never throws for a string.
 */
export function blockCidOf (ciphertext: string): string {
  const text = utf8ToBytes(ciphertext)
  const header: number[] = [0x01, 0x03]
  let n = text.length
  while (n >= 128) { header.push((n & 127) | 128); n = Math.floor(n / 128) }
  header.push(n)
  const digest = sha256(concatBytes(Uint8Array.from(header), text))
  return `b${base32Lower(concatBytes(Uint8Array.of(0x01, 0x55, 0x12, 0x20), sha256(digest)))}`
}

/** Scope first (so a foreign row refuses even when it is also malformed, as in R7), then shape. */
function normaliseRow (raw: unknown, position: number, scope: BlockTreeScope): RowCheck {
  const bad = (detail: string): RowCheck => ({ ok: false, reason: 'malformed-row', detail })
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad('the row is not an object')
  const r = raw as Record<string, unknown>
  if (typeof r.ElectionId === 'string' && r.ElectionId !== scope.electionId) {
    return { ok: false, reason: 'mixed-election', detail: `row ${position}: ElectionId ${r.ElectionId} is not ${scope.electionId}` }
  }
  const scopeRevision = intField(r.ElectionRevision, 0)
  if (scopeRevision !== undefined && scopeRevision !== scope.electionRevision) {
    return { ok: false, reason: 'mixed-revision', detail: `row ${position}: ElectionRevision ${scopeRevision} is not ${scope.electionRevision}` }
  }
  for (const field of ['Cid', 'Id', 'ElectionId', 'BallotId']) {
    if (typeof r[field] !== 'string' || r[field] === '') return bad(`${field} must be a non-empty string`)
  }
  for (const field of ['TemplateDigest', 'VoterRegistrantIds']) {
    if (typeof r[field] !== 'string') return bad(`${field} must be a string`)
  }
  if (!isBase32Cid(r.Cid)) return bad('Cid must be a base32 CID (b followed by a-z and 2-7)')
  const revision = intField(r.ElectionRevision, 0)
  if (revision === undefined) return bad('ElectionRevision must be a non-negative safe integer')
  const entryCount = intField(r.EntryCount, 1)
  if (entryCount === undefined) return bad('EntryCount must be a safe integer >= 1')
  return {
    ok: true,
    row: {
      cid: r.Cid as string, id: r.Id as string, ballotId: r.BallotId as string, entryCount,
      templateDigest: r.TemplateDigest as string, voterRegistrantIds: r.VoterRegistrantIds as string
    }
  }
}

/** A stable text key of an unreadable or malformed row, safe for bigint and odd values; only orders rejections. */
function looseKey (row: unknown): string {
  if (row === null || typeof row !== 'object') return `<${row === null ? 'null' : typeof row}>`
  try {
    return Object.keys(row).sort().map(k => {
      const v = (row as Record<string, unknown>)[k]
      return `${k}=${typeof v === 'string' ? JSON.stringify(v) : `${typeof v}:${String(v)}`}`
    }).join('|')
  } catch {
    return '<unreadable>'
  }
}

// ---- T-65-05-03: consent authentication, shared by R5 (selection) and R7 (findings) ----

/** A VoteBlockVoter row (structural; other columns are ignored). */
export interface BlockVoterRow {
  ElectionId: string
  BallotId: string
  RegistrantId: string
  BlockCid: string
  BlockId: string
  ElectionRevision: number | bigint
  DeviceKey: string
  Signature: string
}

/** A Registrant row (CR-02); other columns are ignored. Expiration is the stored ISO datetime ending in Z. */
export interface BlockRegistrantRow { Id: string, Status: string, Expiration: string }

/** An Association row (CR-02); other columns are ignored. */
export interface BlockAssociationRow { RegistrantId: string, DeviceKey: string, Expiration: string }

/** Structural; an Election.timeline fits. votingStarts (epoch ms) is the reference time of the authorization check. */
export interface BlockAuthorizationTimeline { votingStarts: number }

/**
 * T-65-05-03: the public rows a block row is authenticated against, the same ones R7 reads. Required by
 * selectBlockRows, buildBlockTree and finalBlockTree, so the root never depends on an optional input.
 */
export interface BlockAuthorization {
  voterRows: readonly BlockVoterRow[]
  registrants: readonly BlockRegistrantRow[]
  associations: readonly BlockAssociationRow[]
  timeline: BlockAuthorizationTimeline
  /** the revision's ballot templates; a block's TemplateDigest must be ballotTemplateDigest(ballot, revision) */
  ballots: readonly TemplateBallot[]
}

/** The block columns a consent signature binds. */
export interface BlockConsentScope { Cid: string, Id: string, ElectionId: string, ElectionRevision: number, BallotId: string }

/** CR-02, VoterAssociated: who is registered and which device keys are associated, at the reference time. */
export interface BlockAuthorizer {
  registered: (registrantId: string) => boolean
  associated: (registrantId: string, deviceKey: string) => boolean
}

export type BlockVoterProblemCode = 'voter-row-mismatch' | 'consent-signature-invalid' | 'voter-not-registered' | 'device-key-not-associated'

export interface BlockVoterProblem { code: BlockVoterProblemCode, detail: string }

/** One registrant's representative voter row for a block, and what is wrong with it ([] = authenticated). */
export interface BlockVoterRepresentative { registrantId: string, row: Readonly<Record<string, unknown>>, problems: readonly BlockVoterProblem[] }

/** A voter row naming the block that is not a representative (R7 reports it as `voter-row-forged`). */
export interface BlockVoterExtra { row: Readonly<Record<string, unknown>>, reason: 'no-registrant' | 'unlisted' | 'second-row' }

export interface BlockVoterJudgement {
  /** one per registrant with a row naming the block (listed ones only when the list is readable), by registrant id */
  representatives: readonly BlockVoterRepresentative[]
  /** rows without a RegistrantId or for an unlisted registrant (in row order), then second rows */
  extras: readonly BlockVoterExtra[]
  /** registrants whose representative row has no problem */
  authenticated: ReadonlySet<string>
}

const consentHasher = resolveHasher('sha256')
const consentEncode = resolveOutputEncoder('base64url')

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The digest a voter's device key signs: VoteBlockVoter.SignatureValid's input, Digest('VoteBlockVoter',
 * ElectionId, ElectionRevision, BallotId, BlockCid, BlockId, RegistrantId, DeviceKey) in base64url. The
 * browser-entry twin of pool-block's consentDigest (block-tree.spec FX-7 pins the parity).
 */
export function blockConsentDigest (block: BlockConsentScope, registrantId: string, deviceKey: string): string {
  return digestFields(
    ['VoteBlockVoter', block.ElectionId, block.ElectionRevision, block.BallotId, block.Cid, block.Id, registrantId, deviceKey],
    consentHasher, consentEncode
  ) as string
}

/**
 * P-256 compact low-S hex signature by a compressed hex key over a base64url digest: the same call
 * verifySigP256 makes, without its database module (block-tree.spec FX-7 pins the parity). Never throws.
 */
export function verifyBlockConsent (digest: string, signature: unknown, deviceKey: unknown): boolean {
  if (typeof digest !== 'string' || digest === '' || typeof signature !== 'string' || signature === '' ||
    typeof deviceKey !== 'string' || deviceKey === '') return false
  try {
    return verifySignature(digest, signature, deviceKey, 'p256', 'base64url', 'hex', 'hex')
  } catch {
    return false
  }
}

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/** Epoch ms of a stored ISO datetime ending in Z (the schema's ExpirationValid form), or null. Sub-ms digits are dropped. */
function isoMs (value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_Z.test(value)) return null
  const dot = value.indexOf('.')
  const text = dot === -1 ? value : `${value.slice(0, Math.min(dot + 4, value.length - 1))}Z`
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

/**
 * CR-02: VoterAssociated over the caller's rows. registered(r): a Registrant r with Status 'a' and Expiration
 * later than `at`. associated(r, key): an Association (r, key) with Expiration later than `at`. Unreadable rows
 * authorize nothing. Never throws for arrays.
 */
export function blockAuthorizer (registrants: readonly unknown[], associations: readonly unknown[], at: number): BlockAuthorizer {
  const active = new Set<string>()
  for (const r of registrants) {
    if (!isRec(r) || typeof r.Id !== 'string' || r.Status !== 'a') continue
    const exp = isoMs(r.Expiration)
    if (exp !== null && exp > at) active.add(r.Id)
  }
  const keys = new Map<string, Set<string>>()
  for (const a of associations) {
    if (!isRec(a) || typeof a.RegistrantId !== 'string' || typeof a.DeviceKey !== 'string') continue
    const exp = isoMs(a.Expiration)
    if (exp === null || exp <= at) continue
    const g = keys.get(a.RegistrantId)
    if (g === undefined) keys.set(a.RegistrantId, new Set([a.DeviceKey]))
    else g.add(a.DeviceKey)
  }
  return {
    registered: (r) => active.has(r),
    associated: (r, key) => keys.get(r)?.has(key) === true
  }
}

/** What is wrong with one voter row for one block and registrant: CR-02's rule. [] means authenticated. */
function voterRowProblems (block: BlockConsentScope, v: Rec, reg: string, authorizer: BlockAuthorizer): BlockVoterProblem[] {
  const out: BlockVoterProblem[] = []
  if (v.ElectionId !== block.ElectionId || intField(v.ElectionRevision, 0) !== block.ElectionRevision || v.BallotId !== block.BallotId || v.BlockId !== block.Id) {
    out.push({ code: 'voter-row-mismatch', detail: 'a voter row disagrees with its block on election, revision, ballot or block id' })
  }
  let signed = false
  try {
    signed = typeof v.DeviceKey === 'string' && verifyBlockConsent(blockConsentDigest(block, reg, v.DeviceKey), v.Signature, v.DeviceKey)
  } catch { signed = false }
  if (!signed) out.push({ code: 'consent-signature-invalid', detail: 'the consent signature does not verify over the consent digest' })
  if (!authorizer.registered(reg)) {
    out.push({ code: 'voter-not-registered', detail: 'no active registrant with this id expires after the voting start' })
  }
  if (typeof v.DeviceKey !== 'string' || !authorizer.associated(reg, v.DeviceKey)) {
    out.push({ code: 'device-key-not-associated', detail: 'no association of this registrant and device key expires after the voting start' })
  }
  return out
}

/**
 * CR-02 + CR-03: judge the voter rows that name one block (BlockCid = block.Cid). The single definition of an
 * authenticated voter, used by R5 to choose among rows that share a Cid and by R7 for its findings, so the two
 * cannot disagree. Rows are grouped per registrant; the representative is a row with no problem if there is one,
 * else the fewest problems, then the lowest row key. A row with no RegistrantId, or (when `list` is readable) for a
 * registrant the block does not list, is an extra, as is every second row. Pure; never throws.
 */
export function judgeBlockVoters (block: BlockConsentScope, list: readonly string[] | null, rowsNamingBlock: readonly unknown[], authorizer: BlockAuthorizer): BlockVoterJudgement {
  return judgeWith(block, list, rowsNamingBlock, authorizer, null)
}

/** Per voter row, the problems already computed for a (BallotId, Id) of one Cid: candidates sharing a Cid reuse them. */
type ProblemCache = Map<Rec, Map<string, BlockVoterProblem[]>>

function judgeWith (block: BlockConsentScope, list: readonly string[] | null, rowsNamingBlock: readonly unknown[], authorizer: BlockAuthorizer, cache: ProblemCache | null): BlockVoterJudgement {
  const problemsOf = (v: Rec, reg: string): BlockVoterProblem[] => {
    if (cache === null) return voterRowProblems(block, v, reg, authorizer)
    const key = `${block.BallotId}\u0000${block.Id}`
    let byKey = cache.get(v)
    if (byKey === undefined) { byKey = new Map(); cache.set(v, byKey) }
    let got = byKey.get(key)
    if (got === undefined) { got = voterRowProblems(block, v, reg, authorizer); byKey.set(key, got) }
    return got
  }
  const regOf = (v: Rec): string => (typeof v.RegistrantId === 'string' ? v.RegistrantId : '')
  const mine = rowsNamingBlock.filter(isRec).sort((a, b) => byCodeUnits(regOf(a), regOf(b)) || byCodeUnits(looseKey(a), looseKey(b)))
  const listed = new Set(list ?? [])
  const extras: BlockVoterExtra[] = []
  const byReg = new Map<string, Array<{ v: Rec, problems: BlockVoterProblem[] }>>()
  for (const v of mine) {
    const reg = regOf(v)
    if (reg === '' || (list !== null && !listed.has(reg))) {
      extras.push({ row: v, reason: reg === '' ? 'no-registrant' : 'unlisted' })
      continue
    }
    const entry = { v, problems: problemsOf(v, reg) }
    const g = byReg.get(reg)
    if (g === undefined) byReg.set(reg, [entry])
    else g.push(entry)
  }
  const representatives: BlockVoterRepresentative[] = []
  const authenticated = new Set<string>()
  for (const reg of [...byReg.keys()].sort(byCodeUnits)) {
    const ranked = [...byReg.get(reg)!].sort((a, b) => (a.problems.length - b.problems.length) || byCodeUnits(looseKey(a.v), looseKey(b.v)))
    const rep = ranked[0]!
    representatives.push({ registrantId: reg, row: rep.v, problems: rep.problems })
    if (rep.problems.length === 0) authenticated.add(reg)
    for (const other of ranked.slice(1)) extras.push({ row: other.v, reason: 'second-row' })
  }
  return { representatives, extras, authenticated }
}

/** The voter list when it is a JSON array of non-empty strings in strictly ascending order (R7's canonical list), else null. */
function canonicalVoterList (text: string): string[] | null {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (!Array.isArray(parsed) || !parsed.every((x): x is string => typeof x === 'string' && x.length > 0)) return null
  for (let i = 1; i < parsed.length; i++) if (byCodeUnits(parsed[i - 1] as string, parsed[i] as string) >= 0) return null
  return parsed as string[]
}

interface AuthContext { voterByCid: Map<string, unknown[]>, authorizer: BlockAuthorizer, templateDigests: Map<string, string> }

/** Read the required authorization, with the refusal rules R7 applies to the same fields. */
function authContext (auth: unknown, revision: number): { ok: true, ctx: AuthContext } | { ok: false, detail: string } {
  const bad = (detail: string): { ok: false, detail: string } => ({ ok: false, detail: `authorization: ${detail}` })
  if (!isRec(auth)) return bad('the authorization is not an object')
  if (!Array.isArray(auth.voterRows)) return bad('voterRows is not an array')
  if (!Array.isArray(auth.registrants)) return bad('registrants is not an array')
  if (!Array.isArray(auth.associations)) return bad('associations is not an array')
  const tl = auth.timeline
  if (!isRec(tl) || typeof tl.votingStarts !== 'number' || !Number.isFinite(tl.votingStarts)) return bad('timeline needs a finite votingStarts (epoch ms)')
  if (!Array.isArray(auth.ballots)) return bad('ballots is not an array')
  const templateDigests = new Map<string, string>()
  for (const b of auth.ballots as unknown[]) {
    if (!isRec(b) || typeof b.id !== 'string' || !Array.isArray(b.questions)) return bad('a ballot is not readable')
    if (templateDigests.has(b.id)) return bad('two ballots share one id')
    try {
      templateDigests.set(b.id, ballotTemplateDigest(b as unknown as TemplateBallot, revision))
    } catch {
      return bad('a ballot template digest cannot be computed')
    }
  }
  const voterByCid = new Map<string, unknown[]>()
  for (const v of auth.voterRows as unknown[]) {
    if (!isRec(v) || typeof v.BlockCid !== 'string') continue
    const g = voterByCid.get(v.BlockCid)
    if (g === undefined) voterByCid.set(v.BlockCid, [v])
    else g.push(v)
  }
  return {
    ok: true,
    ctx: { voterByCid, authorizer: blockAuthorizer(auth.registrants as unknown[], auth.associations as unknown[], tl.votingStarts), templateDigests }
  }
}

interface Candidate {
  raw: unknown
  row: NormalRow
  cidOk: boolean
  rank: string
  /** blockLeafData of the row: the secondary leaf order, and equal for exact duplicates */
  leafData: string
  /** T-65-05-03: set only for a Cid that more than one row names */
  authenticated: boolean
}

/** T-65-05-03: is this row one R7 finds no no-key block finding on (the cross-block check aside)? */
function authenticate (c: Candidate, scope: BlockTreeScope, ctx: AuthContext, cache: ProblemCache): void {
  c.authenticated = false
  if (!c.cidOk) return
  const list = canonicalVoterList(c.row.voterRegistrantIds)
  if (list === null || list.length !== c.row.entryCount) return
  const template = ctx.templateDigests.get(c.row.ballotId)
  if (template === undefined || template !== c.row.templateDigest) return
  const block: BlockConsentScope = { Cid: c.row.cid, Id: c.row.id, ElectionId: scope.electionId, ElectionRevision: scope.electionRevision, BallotId: c.row.ballotId }
  const judged = judgeWith(block, list, ctx.voterByCid.get(c.row.cid) ?? [], ctx.authorizer, cache)
  c.authenticated = list.every(reg => judged.authenticated.has(reg))
}

/** R5 leaf order: ascending UTF-8 bytes of Cid, then of leafData (distinct for distinct leaves of one Cid). */
function byLeafOrder (a: { cid: string, leafData: string }, b: { cid: string, leafData: string }): number {
  return compareUtf8(a.cid, b.cid) || compareUtf8(a.leafData, b.leafData)
}

/**
 * WR-06 + T-65-05-03: the row policy shared by R5 and R7. Keeps every well-formed row with a Cid of its own, and for
 * a shared Cid every authenticated row (or one row when none is), in leaf order (Cid, then leafData); returns every
 * other row in `rejected` with a typed reason. R7 keeps this order, so its blocks are R5's leaves one for one. Refuses only a non-array `rows` (`malformed-row`), an unreadable authorization (`malformed-input`) and a
 * row of another election or revision. The outcome does not depend on input order. Never throws.
 */
export function selectBlockRows<R> (rows: readonly R[], scope: BlockTreeScope, authorization: BlockAuthorization): BlockRowSelection<R> {
  if (!Array.isArray(rows)) return { ok: false, reason: 'malformed-row', detail: 'rows must be an array' }
  const auth = authContext(authorization, scope.electionRevision)
  if (!auth.ok) return { ok: false, reason: 'malformed-input', detail: auth.detail }
  const candidates: Candidate[] = []
  const rejected: Array<BlockTreeRejection & { row: unknown, key: string }> = []
  for (let i = 0; i < rows.length; i++) {
    const raw: unknown = rows[i]
    const checked = normaliseRow(raw, i, scope)
    if (!checked.ok) {
      if (checked.reason !== 'malformed-row') return checked
      const cid = raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>).Cid === 'string' ? (raw as Record<string, unknown>).Cid as string : ''
      rejected.push({ cid, reason: 'malformed-row', detail: checked.detail, row: raw, key: looseKey(raw) })
      continue
    }
    const ct = (raw as Record<string, unknown>).Ciphertext
    const row = checked.row
    const cidOk = typeof ct === 'string' && blockCidOf(ct) === row.cid
    const rank = canonicalJson([row.cid, row.id, row.ballotId, row.entryCount, row.templateDigest, row.voterRegistrantIds, typeof ct === 'string' ? ct : null])
    const leafData = blockLeafData({
      Cid: row.cid, Id: row.id, ElectionId: scope.electionId, ElectionRevision: scope.electionRevision, BallotId: row.ballotId,
      EntryCount: row.entryCount, TemplateDigest: row.templateDigest, VoterRegistrantIds: row.voterRegistrantIds
    })
    candidates.push({ raw, row, cidOk, rank, leafData, authenticated: false })
  }
  // UTF-8 bytes first; code units break the tie two distinct lone surrogates would leave, so the order is total
  const byRank = (a: string, b: string): number => compareUtf8(a, b) || (a < b ? -1 : a > b ? 1 : 0)
  const byCid = new Map<string, Candidate[]>()
  for (const c of candidates) {
    const g = byCid.get(c.row.cid)
    if (g === undefined) byCid.set(c.row.cid, [c])
    else g.push(c)
  }
  const fallback = (a: Candidate, b: Candidate): number => (a.cidOk === b.cidOk ? 0 : a.cidOk ? -1 : 1) || byRank(a.rank, b.rank)
  const kept: Candidate[] = []
  const setAside = (c: Candidate): void => {
    rejected.push({ cid: c.row.cid, reason: 'duplicate-block', detail: `Cid ${c.row.cid} is already taken by a preferred row`, row: c.raw, key: c.rank })
  }
  for (const group of byCid.values()) {
    if (group.length === 1) { kept.push(group[0]!); continue }
    const cache: ProblemCache = new Map()
    for (const c of group) authenticate(c, scope, auth.ctx, cache)
    const authenticated = group.filter(c => c.authenticated)
    if (authenticated.length === 0) {
      // none authenticates: one deterministic row, which R7 finds invalid anyway
      group.sort(fallback)
      kept.push(group[0]!)
      group.slice(1).forEach(setAside)
      continue
    }
    // every authenticated row is a leaf of its own; R7 decides after the release which one the ciphertext holds.
    // An exact duplicate (same leafData) collapses to one; unauthenticated rows of the Cid are set aside.
    authenticated.sort((a, b) => compareUtf8(a.leafData, b.leafData) || byRank(a.rank, b.rank))
    for (let i = 0; i < authenticated.length; i++) {
      const c = authenticated[i]!
      if (i > 0 && authenticated[i - 1]!.leafData === c.leafData) setAside(c)
      else kept.push(c)
    }
    for (const c of group) if (!c.authenticated) setAside(c)
  }
  kept.sort((a, b) => byLeafOrder({ cid: a.row.cid, leafData: a.leafData }, { cid: b.row.cid, leafData: b.leafData }))
  rejected.sort((a, b) => byRank(a.cid, b.cid) || byRank(a.detail, b.detail) || byRank(a.key, b.key))
  return {
    ok: true,
    accepted: kept.map(c => c.raw as R),
    rejected: rejected.map(({ cid, reason, detail, row }) => ({ cid, reason, detail, row }))
  }
}

/**
 * Build the block tree for one election revision. The rows may arrive in any order; the result does not
 * depend on it. Rows are selected by selectBlockRows (WR-06, T-65-05-03): malformed rows and the unauthenticated
 * rows of a shared Cid are set aside in `tree.rejected`, and the tree is built over the rest (a shared Cid keeps every
 * authenticated row as its own leaf).
 * `authorization` is required: every party passes the same public rows, so every party gets the same root.
 * Only rows from another election or revision, a non-array input or an unreadable authorization refuse the tree.
 */
export function buildBlockTree (rows: readonly BlockTreeRow[], scope: BlockTreeScope, authorization: BlockAuthorization): BlockTreeResult {
  const selected = selectBlockRows(rows, scope, authorization)
  if (!selected.ok) return selected
  const normal: NormalRow[] = []
  for (let i = 0; i < selected.accepted.length; i++) {
    const checked = normaliseRow(selected.accepted[i], i, scope)
    if (checked.ok) normal.push(checked.row)
  }
  const rejected: BlockTreeRejection[] = selected.rejected.map(({ cid, reason, detail }) => ({ cid, reason, detail }))

  const leaves: BlockTreeLeaf[] = normal.map((row, index) => {
    const leafData = blockLeafData({
      Cid: row.cid, Id: row.id, ElectionId: scope.electionId, ElectionRevision: scope.electionRevision, BallotId: row.ballotId,
      EntryCount: row.entryCount, TemplateDigest: row.templateDigest, VoterRegistrantIds: row.voterRegistrantIds
    })
    return { index, cid: row.cid, blockId: row.id, ballotId: row.ballotId, entryCount: row.entryCount, leafData, hash: blockLeafHash(leafData) }
  })

  const nodes: BlockTreeNode[] = []
  const nodeAt = new Map<string, number>()
  const buildRange = (lo: number, hi: number): number => {
    let entry: BlockTreeNode
    if (hi - lo === 1) {
      entry = { index: nodes.length, hash: leaves[lo]!.hash, range: [lo, hi] }
    } else {
      const k = splitPoint(hi - lo)
      const left = buildRange(lo, lo + k)
      const right = buildRange(lo + k, hi)
      entry = { index: nodes.length, hash: blockNodeHash(nodes[left]!.hash, nodes[right]!.hash), range: [lo, hi], left, right }
    }
    nodes.push(entry)
    nodeAt.set(`${lo}:${hi}`, entry.index)
    return entry.index
  }
  if (leaves.length > 0) buildRange(0, leaves.length)

  const size = leaves.length
  const root = size === 0 ? BLOCK_TREE_EMPTY_ROOT : nodes[nodes.length - 1]!.hash
  const leafIndexesOf = new Map<string, number[]>()
  for (const l of leaves) {
    const g = leafIndexesOf.get(l.cid)
    if (g === undefined) leafIndexesOf.set(l.cid, [l.index])
    else g.push(l.index)
  }

  const proofFor = (cid: string, leafHash?: string): BlockProofResult => {
    const all = leafIndexesOf.get(cid) ?? []
    const matching = leafHash === undefined ? all : all.filter(i => leaves[i]!.hash === leafHash)
    if (matching.length === 0) return { ok: false, reason: 'unknown-block' }
    if (matching.length > 1) return { ok: false, reason: 'ambiguous-block' }
    const leafIndex = matching[0]!
    const rootDown: BlockProofStep[] = []
    let lo = 0
    let hi = size
    while (hi - lo > 1) {
      const k = splitPoint(hi - lo)
      const mid = lo + k
      if (leafIndex < mid) {
        rootDown.push({ side: 'right', hash: nodes[nodeAt.get(`${mid}:${hi}`)!]!.hash })
        hi = mid
      } else {
        rootDown.push({ side: 'left', hash: nodes[nodeAt.get(`${lo}:${mid}`)!]!.hash })
        lo = mid
      }
    }
    return { ok: true, proof: { leafIndex, treeSize: size, path: rootDown.reverse() } }
  }

  return { ok: true, tree: { electionId: scope.electionId, electionRevision: scope.electionRevision, root, size, leaves, nodes, rejected, proofFor } }
}

/** Sibling sides, leaf-to-root, that a leaf at `index` in a tree of `size` leaves must have. */
function expectedSides (index: number, size: number): Array<'left' | 'right'> {
  const rootDown: Array<'left' | 'right'> = []
  let lo = 0
  let hi = size
  while (hi - lo > 1) {
    const mid = lo + splitPoint(hi - lo)
    if (index < mid) { rootDown.push('right'); hi = mid } else { rootDown.push('left'); lo = mid }
  }
  return rootDown.reverse()
}

/**
 * Check an inclusion proof against a root. Position and tree size are bound: the side sequence is derived
 * from (leafIndex, treeSize) and must match the path exactly, so an internal node cannot pose as a leaf.
 * The caller recomputes `leafHash` from its own row (blockLeafHash(blockLeafData(row))), never from the proof.
 * Never throws.
 */
export function verifyInclusion (leafHash: string, proof: BlockInclusionProof, root: string): InclusionCheck {
  const malformed: InclusionCheck = { ok: false, reason: 'malformed-proof' }
  if (typeof leafHash !== 'string' || !HEX64.test(leafHash)) return malformed
  if (typeof root !== 'string' || !HEX64.test(root)) return malformed
  if (proof === null || typeof proof !== 'object') return malformed
  const { leafIndex, treeSize, path } = proof
  if (!Number.isSafeInteger(leafIndex) || !Number.isSafeInteger(treeSize)) return malformed
  if (leafIndex < 0 || leafIndex >= treeSize) return malformed
  if (!Array.isArray(path)) return malformed
  const sides = expectedSides(leafIndex, treeSize)
  if (path.length !== sides.length) return malformed
  for (let i = 0; i < path.length; i++) {
    const step = path[i] as BlockProofStep | null | undefined
    if (step === null || step === undefined || typeof step !== 'object') return malformed
    if (step.side !== sides[i]) return malformed
    if (typeof step.hash !== 'string' || !HEX64.test(step.hash)) return malformed
  }
  let h = leafHash
  for (const step of path) {
    h = step.side === 'left' ? blockNodeHash(step.hash, h) : blockNodeHash(h, step.hash)
  }
  return h === root ? { ok: true } : { ok: false, reason: 'root-mismatch' }
}

/**
 * D-51: the accruing period is [accruingVotes, hashingVotes), so it ends at hashingVotes (research A5). A
 * FINAL root is allowed only once nowMs >= hashingVotes. This is a computation gate and NOT a security
 * boundary: the caller chooses nowMs (spike 101 signal 2).
 */
export function blockTreeStatus (timeline: BlockTreeTimeline, nowMs: number): BlockTreeStatus {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return { ok: false, reason: 'clock-invalid' }
  if (timeline === null || typeof timeline !== 'object') return { ok: false, reason: 'timeline-invalid' }
  const { accruingVotes, hashingVotes } = timeline
  if (typeof accruingVotes !== 'number' || typeof hashingVotes !== 'number' ||
    !Number.isFinite(accruingVotes) || !Number.isFinite(hashingVotes) || hashingVotes < accruingVotes) {
    return { ok: false, reason: 'timeline-invalid' }
  }
  if (nowMs < hashingVotes) return { ok: false, reason: 'accruing-not-ended', finalAtMs: hashingVotes }
  return { ok: true, final: true }
}

/**
 * The tree, labelled final or provisional by blockTreeStatus. Before the end of the accruing period the
 * refusal still carries the provisional tree. Who stores or publishes the root is out of scope (D-51).
 */
export function finalBlockTree (
  rows: readonly BlockTreeRow[], scope: BlockTreeScope, authorization: BlockAuthorization, timeline: BlockTreeTimeline, nowMs: number
): FinalBlockTreeResult {
  const status = blockTreeStatus(timeline, nowMs)
  if (!status.ok && (status.reason === 'timeline-invalid' || status.reason === 'clock-invalid')) return status
  const built = buildBlockTree(rows, scope, authorization)
  if (!built.ok) return built
  if (!status.ok && status.reason === 'accruing-not-ended') {
    return { ok: false, reason: 'accruing-not-ended', finalAtMs: status.finalAtMs, provisional: built.tree }
  }
  return { ok: true, final: true, tree: built.tree }
}
