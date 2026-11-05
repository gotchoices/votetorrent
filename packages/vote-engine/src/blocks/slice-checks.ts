// slice-checks.ts — R6 (D-60, D-61): a voter checks its own slice of the committed blocks (65-06).
//
// Role:
//   - doc/election.md "Validation", slice level: from the saved receipt (its plaintext vote entries with
//     nonces, plus its signed voter entry), the replicated VoteBlock and VoteBlockVoter rows, an optional
//     root and an optional caller-held election secret, return per ballot four typed results.
//
// The four checks (D-60 a-d):
//   - my-vote (a): after the key release, my canonical vote entry, nonce included, is found exactly once
//     among the opened votes of the block recorded for my registrant and ballot. Before the release it is
//     pending-key-release, never pass or fail: the receipt holds the plaintext entry and its nonce but NO
//     ciphertext (research Pitfall 6; the Voter encrypts afresh on every attempt), so nothing can be
//     compared until the block opens.
//   - my-voter-entry (b): the VoteBlockVoter row for (election, ballot, registrant) names a block whose Id
//     matches, whose registrant list holds me once, whose consent signature verifies, and whose device key
//     is the receipt's; my own voter-entry signature verifies; after the release my voter entry is in the
//     payload exactly once and the block's voter list is the payload's list of voters.
//   - Several rows may share my Cid (T-65-05-03: R5 keeps every authenticated row as a leaf, for example the honest
//     block and a forged one that lists me plus a colluding registrant). Each is judged, and the best result is
//     reported: fewest failures, then fewest checks short of a plain pass, then leaf order. Before the release
//     both may pass (nothing shows yet which list the ciphertext holds); after it only the honest leaf can.
//   - block-hash (c): the Cid is the digest of the ciphertext with no key; after the release the Id is the
//     digest of the payload too.
//   - under-root (d): the leaf hash is recomputed from MY block row (never taken from a proof) and verified
//     against the caller's root, using a supplied publisher proof or a tree built from the supplied rows.
//     Who publishes the root is out of scope (D-51). A proof's treeSize is trusted for nothing beyond
//     verifyInclusion: when the rows build a tree whose root is the caller's root, the proof must agree
//     with that tree's own size and position. Building a tree needs R5's authorization (T-65-05-03: the
//     registrants, associations, timeline and ballots, with the voterRows given here), because R5 resolves a
//     shared Cid by consent; without it the tree is never built: under-root is `not-applicable`
//     (`no-authorization`) when there is no proof, and a proof is checked by verifyInclusion alone.
//
// D-13 revisit: after the release, a block recorded under my registrant that does not hold my own vote
// entry (another device's vote, or an altered one) fails my-vote; before the release a different device
// key on the VoteBlockVoter row already fails my-voter-entry.
//
// Caller-held secret: via openCommittedBlock. The caller obtains the secret and zero-fills it after the
// call; this module checks it against the joint key and never copies, stores, returns or clears it.
//
// D-61: engine-only. The Voter port is a named export added by 65-09; no screen, copy or i18n lives here.
//
// Rules: results are typed unions and nothing here reports failure by throwing; every primitive that can
// throw on hostile input is wrapped. Pure for Hermes and the browser: no Node-only globals, no logging, no
// clock, no randomness.

import {
  blockLeafData, blockLeafHash, buildBlockTree, verifyInclusion,
  type BlockAuthorization, type BlockInclusionProof, type BlockTree, type BlockTreeRow
} from './block-tree.js'
import { checkElectionSecret, openCommittedBlock, type OpenCommittedBlockResult } from './open-committed-block.js'
import { consentDigest, poolBlockCid, poolBlockId, type PoolBallot } from '../pool/pool-block.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { canonicalJson } from '../voting/canonical.js'
import { voterEntryDigest, type VoteEntry, type VoterEntry } from '../voting/vote-entries.js'
import { verifySigP256 } from '../database/initialize.js'

export const SLICE_CHECK_IDS = Object.freeze(['my-vote', 'my-voter-entry', 'block-hash', 'under-root'] as const)
export type SliceCheckId = typeof SLICE_CHECK_IDS[number]
export type SliceCheckStatus = 'pass' | 'fail' | 'pending-key-release' | 'not-applicable'

/** Structural receipt: the Voter's VoteRecord and the fixture's FixtureReceipt both fit. Extra fields are ignored. */
export interface SliceReceipt {
  electionId: string
  electionRevision: number
  votes: readonly VoteEntry[]
  voter: VoterEntry
}

export interface SliceBlockRow extends BlockTreeRow {
  TemplateDigest: string
  VoterRegistrantIds: string
  Ciphertext: string
}

export interface SliceVoterRow {
  ElectionId: string
  BallotId: string
  RegistrantId: string
  BlockCid: string
  BlockId: string
  ElectionRevision: number | bigint
  DeviceKey: string
  Signature: string
}

/** The root to check against (from whoever publishes it; out of scope, D-51) and optionally the publisher's proof. */
export interface SliceTreeAnchor { root: string, proof?: BlockInclusionProof }

/** Caller-held secret (for example from KeyReleaseEngine.reconstructElectionKey). The caller zero-fills it after the call. */
export interface SliceRelease { secretKey: Uint8Array, jointPublicKey: string }

/**
 * T-65-05-03: what R5 needs besides the voter rows to build the tree from the rows (registrants, associations,
 * the revision timeline and its ballot templates). The same public rows every party passes to R5.
 */
export type SliceAuthorization = Omit<BlockAuthorization, 'voterRows'>

export type SlicePendingPart = 'voter-entry-in-payload' | 'block-id'

export type SliceFailReason =
  | 'not-recorded' | 'ambiguous-record' | 'block-row-missing' | 'scope-mismatch' | 'block-id-mismatch'
  | 'template-mismatch' | 'device-key-mismatch' | 'voter-list-malformed' | 'not-in-voter-list'
  | 'consent-signature-invalid' | 'voter-entry-signature-invalid' | 'ballot-not-in-voter-entry'
  | 'voter-entry-missing-or-altered' | 'voter-list-mismatch'
  | 'vote-missing-or-altered' | 'vote-duplicated'
  | 'block-does-not-open'
  | 'cid-mismatch' | 'id-mismatch'
  | 'not-under-root' | 'malformed-proof' | 'tree-refused' | 'malformed-row'

export type SliceNotApplicableReason = 'no-block' | 'no-root' | 'no-authorization'

export type SliceCheckResult =
  | { check: SliceCheckId, status: 'pass', pendingAfterRelease: readonly SlicePendingPart[] }
  | { check: SliceCheckId, status: 'fail', reason: SliceFailReason, detail: string }
  | { check: SliceCheckId, status: 'pending-key-release' }
  | { check: SliceCheckId, status: 'not-applicable', reason: SliceNotApplicableReason }

export interface SliceBallotReport {
  ballotId: string
  /** The located block, null when not located. */
  blockCid: string | null
  /** fail: any fail; pass: all four pass with empty pendingAfterRelease; else incomplete. */
  verdict: 'pass' | 'fail' | 'incomplete'
  /** Always 4, in SLICE_CHECK_IDS order. */
  checks: readonly SliceCheckResult[]
}

export type SliceCheckRefusal = 'malformed-receipt' | 'malformed-rows' | 'invalid-secret' | 'secret-mismatch'

export type SliceCheckReport =
  | {
    ok: true
    electionId: string
    electionRevision: number
    released: boolean
    /** One per receipt vote, in receipt order. */
    ballots: readonly SliceBallotReport[]
    totals: { pass: number, fail: number, pending: number, notApplicable: number }
  }
  | { ok: false, reason: SliceCheckRefusal, detail: string }

function normaliseRevision (value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  return null
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

const pass = (check: SliceCheckId, pendingAfterRelease: readonly SlicePendingPart[]): SliceCheckResult => ({ check, status: 'pass', pendingAfterRelease })
const fail = (check: SliceCheckId, reason: SliceFailReason, detail: string): SliceCheckResult => ({ check, status: 'fail', reason, detail })
const notApplicable = (check: SliceCheckId, reason: SliceNotApplicableReason): SliceCheckResult => ({ check, status: 'not-applicable', reason })

function refuse (reason: SliceCheckRefusal, detail: string): SliceCheckReport {
  return { ok: false, reason, detail }
}

function validateReceipt (receipt: unknown): string | null {
  if (!isObject(receipt)) return 'the receipt is not an object'
  if (!nonEmpty(receipt.electionId)) return 'the receipt has no electionId'
  if (normaliseRevision(receipt.electionRevision) === null || typeof receipt.electionRevision !== 'number') return 'the receipt electionRevision is not a non-negative safe integer'
  if (!Array.isArray(receipt.votes) || receipt.votes.length === 0) return 'the receipt holds no votes'
  const seen = new Set<string>()
  for (const vote of receipt.votes as unknown[]) {
    if (!isObject(vote)) return 'a receipt vote is not an object'
    if (!nonEmpty(vote.ballotId)) return 'a receipt vote has no ballotId'
    if (vote.electionId !== receipt.electionId) return 'a receipt vote belongs to another election'
    if (vote.electionRevision !== receipt.electionRevision) return 'a receipt vote belongs to another revision'
    if (seen.has(vote.ballotId)) return 'a ballotId repeats in the receipt votes'
    seen.add(vote.ballotId)
  }
  const voter = receipt.voter
  if (!isObject(voter)) return 'the receipt voter entry is not an object'
  if (!nonEmpty(voter.registrantId)) return 'the receipt voter entry has no registrantId'
  if (!nonEmpty(voter.deviceKey)) return 'the receipt voter entry has no deviceKey'
  if (!nonEmpty(voter.signature)) return 'the receipt voter entry has no signature'
  if (voter.electionId !== receipt.electionId) return 'the receipt voter entry belongs to another election'
  if (!Array.isArray(voter.ballots)) return 'the receipt voter entry ballots is not an array'
  return null
}

function inScope<T extends { ElectionId: unknown, ElectionRevision: unknown }> (items: readonly unknown[], electionId: string, revision: number): T[] {
  const out: T[] = []
  for (const item of items) {
    if (!isObject(item)) continue
    if (item.ElectionId !== electionId) continue
    if (normaliseRevision(item.ElectionRevision) !== revision) continue
    out.push(item as unknown as T)
  }
  return out
}

type LocateResult =
  | { found: false, result: SliceCheckResult }
  | { found: true, voterRow: SliceVoterRow, blocks: SliceBlockRow[] }

function locate (ballotId: string, registrantId: string, voterRows: readonly SliceVoterRow[], allRows: readonly unknown[]): LocateResult {
  const mineRows = voterRows.filter(v => v.BallotId === ballotId && v.RegistrantId === registrantId)
  if (mineRows.length === 0) return { found: false, result: fail('my-voter-entry', 'not-recorded', 'no VoteBlockVoter row records this registrant for this ballot') }
  if (mineRows.length > 1) return { found: false, result: fail('my-voter-entry', 'ambiguous-record', 'more than one VoteBlockVoter row records this registrant for this ballot') }
  const voterRow = mineRows[0]!
  const blocks = allRows.filter((r): r is SliceBlockRow => isObject(r) && r.Cid === voterRow.BlockCid)
  if (blocks.length === 0) return { found: false, result: fail('my-voter-entry', 'block-row-missing', 'the VoteBlockVoter row names a block that is not among the rows') }
  // T-65-05-03: several rows may share the Cid (R5 keeps every authenticated one as a leaf); the caller judges each
  return { found: true, voterRow, blocks }
}

/** UTF-8 byte order (R5's leaf order); code units would order astral characters differently. */
function compareBytes (a: string, b: string): number {
  const x = utf8ToBytes(a)
  const y = utf8ToBytes(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return x.length - y.length
}

function countCanonical (list: readonly unknown[], wanted: string): number {
  let n = 0
  for (const item of list) {
    try {
      if (canonicalJson(item) === wanted) n++
    } catch {
      // an entry that cannot be canonicalised cannot be mine
    }
  }
  return n
}

function describeOpenFailure (opened: Extract<OpenCommittedBlockResult, { ok: false }>): string {
  return `${opened.reason}: ${opened.detail}`
}

/**
 * The root to check against, my voter slice, and (when released) the opened block: four typed results per ballot.
 * `authorization` is needed only to build the tree from `rows` for under-root (T-65-05-03).
 */
export function sliceChecks (
  receipt: SliceReceipt,
  rows: readonly SliceBlockRow[],
  voterRows: readonly SliceVoterRow[],
  anchor?: SliceTreeAnchor | null,
  release?: SliceRelease | null,
  authorization?: SliceAuthorization | null
): SliceCheckReport {
  const receiptProblem = validateReceipt(receipt)
  if (receiptProblem !== null) return refuse('malformed-receipt', receiptProblem)
  if (!Array.isArray(rows)) return refuse('malformed-rows', 'rows is not an array')
  if (!Array.isArray(voterRows)) return refuse('malformed-rows', 'voterRows is not an array')

  const electionId = receipt.electionId
  const revision = receipt.electionRevision
  const voter = receipt.voter

  let released = false
  let jointPublicKey = ''
  if (release !== undefined && release !== null) {
    jointPublicKey = isObject(release) && typeof release.jointPublicKey === 'string' ? release.jointPublicKey : ''
    const secret = checkElectionSecret(isObject(release) ? release.secretKey : (undefined as unknown as Uint8Array), { electionId, revision, jointPublicKey })
    if (!secret.ok) return refuse(secret.reason, secret.detail)
    released = true
  }
  const electionKey = { electionId, revision, jointPublicKey }

  const scopedRows = inScope<SliceBlockRow>(rows, electionId, revision)
  const scopedVoterRows = inScope<SliceVoterRow>(voterRows, electionId, revision)

  // T-65-05-03: R5 needs the authorization; without one the tree is never built (null)
  let treeMemo: ReturnType<typeof buildBlockTree> | null = null
  const treeOverRows = (): ReturnType<typeof buildBlockTree> | null => {
    if (authorization === undefined || authorization === null) return null
    if (treeMemo === null) {
      treeMemo = buildBlockTree(scopedRows, { electionId, electionRevision: revision }, { ...authorization, voterRows } as unknown as BlockAuthorization)
    }
    return treeMemo
  }

  const underRoot = (block: SliceBlockRow): SliceCheckResult => {
    if (anchor === undefined || anchor === null || !isObject(anchor) || typeof anchor.root !== 'string') return notApplicable('under-root', 'no-root')
    let leafHash: string
    try {
      leafHash = blockLeafHash(blockLeafData(block))
    } catch (error) {
      return fail('under-root', 'malformed-row', `my block row cannot be hashed: ${error instanceof Error ? error.message : 'unreadable'}`)
    }
    const verdict = (check: ReturnType<typeof verifyInclusion>): SliceCheckResult => {
      if (check.ok) return pass('under-root', [])
      return check.reason === 'malformed-proof'
        ? fail('under-root', 'malformed-proof', 'the inclusion proof is malformed for this leaf')
        : fail('under-root', 'not-under-root', 'the block is not under the given root')
    }
    if (anchor.proof !== undefined) {
      // The proof's treeSize is trusted for nothing beyond verifyInclusion. When the rows build the very tree
      // the root names, the proof must agree with that tree's own size and position.
      const built = treeOverRows()
      if (built !== null && built.ok && built.tree.root === anchor.root) {
        const tree: BlockTree = built.tree
        const leaf = tree.leaves.find(l => l.hash === leafHash)
        if (leaf !== undefined && (anchor.proof.treeSize !== tree.size || anchor.proof.leafIndex !== leaf.index)) {
          return fail('under-root', 'malformed-proof', 'the proof disagrees with the tree built from the rows')
        }
      }
      return verdict(verifyInclusion(leafHash, anchor.proof, anchor.root))
    }
    const built = treeOverRows()
    if (built === null) return notApplicable('under-root', 'no-authorization')
    if (!built.ok) return fail('under-root', 'tree-refused', `${built.reason}: ${built.detail}`)
    const proof = built.tree.proofFor(block.Cid, leafHash)
    if (!proof.ok) return fail('under-root', 'not-under-root', 'the block is not among the rows the tree covers')
    return verdict(verifyInclusion(leafHash, proof.proof, anchor.root))
  }

  const ballots: SliceBallotReport[] = []
  for (const vote of receipt.votes) {
    const ballotId = vote.ballotId
    const located = locate(ballotId, voter.registrantId, scopedVoterRows, rows)
    let checks: SliceCheckResult[]
    let blockCid: string | null = null
    if (!located.found) {
      checks = [
        notApplicable('my-vote', 'no-block'),
        located.result,
        notApplicable('block-hash', 'no-block'),
        notApplicable('under-root', 'no-block')
      ]
    } else {
      const { voterRow, blocks } = located
      blockCid = voterRow.BlockCid
      const evaluate = (block: SliceBlockRow): SliceCheckResult[] => {
        let opened: OpenCommittedBlockResult | null = null
        if (released && release !== undefined && release !== null) {
          opened = openCommittedBlock(block, release.secretKey, electionKey)
        }

        // my-voter-entry (b): first failure wins
        let voterEntryResult: SliceCheckResult | null = null
        const bad = (reason: SliceFailReason, detail: string): void => {
          if (voterEntryResult === null) voterEntryResult = fail('my-voter-entry', reason, detail)
        }
        if (block.ElectionId !== electionId || normaliseRevision(block.ElectionRevision) !== revision || block.BallotId !== ballotId) {
          bad('scope-mismatch', 'the block row belongs to another election, revision or ballot')
        } else if (block.Id !== voterRow.BlockId) {
          bad('block-id-mismatch', 'the VoteBlockVoter row names another block Id than the block row holds')
        } else if (block.TemplateDigest !== vote.templateDigest) {
          bad('template-mismatch', 'the block row carries another ballot template digest than my vote')
        } else if (voterRow.DeviceKey !== voter.deviceKey) {
          bad('device-key-mismatch', 'the recorded device key is not the key this receipt was signed with')
        } else {
          let list: unknown
          let listOk = true
          try {
            list = JSON.parse(block.VoterRegistrantIds)
          } catch {
            listOk = false
          }
          if (!listOk || !Array.isArray(list) || !list.every(x => typeof x === 'string')) {
            bad('voter-list-malformed', 'the block voter list is not a JSON array of strings')
          } else if ((list as string[]).filter(x => x === voter.registrantId).length !== 1) {
            bad('not-in-voter-list', 'my registrant does not appear exactly once in the block voter list')
          } else {
            let consentOk = false
            try {
              // consentDigest reads only electionId, revision and ballotId of the pool ballot
              const poolBallot: PoolBallot = { electionKey: { electionId, revision, jointPublicKey }, ballotId, templateDigest: block.TemplateDigest }
              consentOk = verifySigP256(
                consentDigest({ cid: block.Cid, blockId: block.Id }, poolBallot, voter.registrantId, voterRow.DeviceKey),
                voterRow.Signature,
                voterRow.DeviceKey
              )
            } catch {
              consentOk = false
            }
            if (!consentOk) {
              bad('consent-signature-invalid', 'the recorded consent signature does not verify')
            } else if (!voter.ballots.some(b => isObject(b) && b.ballotId === ballotId && b.templateDigest === vote.templateDigest)) {
              bad('ballot-not-in-voter-entry', 'my voter entry does not list this ballot with this template')
            } else {
              let entryOk = false
              try {
                entryOk = verifySigP256(voterEntryDigest(voter), voter.signature, voter.deviceKey)
              } catch {
                entryOk = false
              }
              if (!entryOk) {
                bad('voter-entry-signature-invalid', 'my voter entry signature does not verify')
              } else if (opened !== null) {
                if (!opened.ok) {
                  bad('block-does-not-open', describeOpenFailure(opened))
                } else {
                  let mineVoter: string | null = null
                  try {
                    mineVoter = canonicalJson(voter)
                  } catch {
                    mineVoter = null
                  }
                  if (mineVoter === null || countCanonical(opened.payload.voterRecords, mineVoter) !== 1) {
                    bad('voter-entry-missing-or-altered', 'my voter entry is not in the block payload exactly once')
                  } else {
                    // T-65-05-03: the row's voter list must be the payload's voters, or the row is not the leaf
                    // that counts this ciphertext (R7: voter-count-mismatch, voter-list-mismatch)
                    let payloadList: string | null = null
                    try {
                      payloadList = canonicalJson((opened.payload.voterRecords as Array<{ registrantId?: unknown }>).map(r => r?.registrantId).sort())
                    } catch {
                      payloadList = null
                    }
                    if (payloadList === null || payloadList !== canonicalJson(list)) {
                      bad('voter-list-mismatch', 'the block voter list is not the list of voters in the payload')
                    }
                  }
                }
              }
            }
          }
        }
        const myVoterEntry: SliceCheckResult = voterEntryResult ?? pass('my-voter-entry', released ? [] : ['voter-entry-in-payload'])

        // my-vote (a)
        let myVote: SliceCheckResult
        if (opened === null) {
          myVote = { check: 'my-vote', status: 'pending-key-release' }
        } else if (!opened.ok) {
          myVote = fail('my-vote', 'block-does-not-open', describeOpenFailure(opened))
        } else {
          let wanted: string | null = null
          try {
            wanted = canonicalJson(vote)
          } catch {
            wanted = null
          }
          const unopened = opened.votes.filter(v => !v.ok).length
          const matches = wanted === null ? 0 : opened.votes.filter(v => v.ok && v.entryJson === wanted).length
          if (matches === 1) myVote = pass('my-vote', [])
          else if (matches === 0) {
            myVote = fail('my-vote', 'vote-missing-or-altered', `my vote entry is not among the opened votes (${unopened} did not open); this also covers another device's vote under my registrant`)
          } else myVote = fail('my-vote', 'vote-duplicated', 'my vote entry appears more than once among the opened votes')
        }

        // block-hash (c)
        let blockHash: SliceCheckResult
        let cidOk = false
        try {
          cidOk = poolBlockCid(block.Ciphertext) === block.Cid
        } catch {
          cidOk = false
        }
        if (!cidOk) {
          blockHash = fail('block-hash', 'cid-mismatch', 'the block Cid is not the digest of its ciphertext')
        } else if (opened === null) {
          blockHash = pass('block-hash', ['block-id'])
        } else if (!opened.ok) {
          blockHash = fail('block-hash', 'block-does-not-open', describeOpenFailure(opened))
        } else {
          let idOk = false
          try {
            idOk = poolBlockId(opened.payload) === block.Id
          } catch {
            idOk = false
          }
          blockHash = idOk ? pass('block-hash', []) : fail('block-hash', 'id-mismatch', 'the block Id is not the digest of its payload')
        }

        return [myVote, myVoterEntry, blockHash, underRoot(block)]
      }
      // T-65-05-03: with one row this is the old path. With several rows of the Cid (an honest leaf and a forged one
      // that also lists me), each is judged and the best result stands: fewest failures, then fewest checks short of
      // a plain pass, then leaf order. After the release only the row whose voter list is the payload's can pass
      // my-voter-entry, so the honest leaf is the one reported.
      if (blocks.length === 1) {
        checks = evaluate(blocks[0]!)
      } else {
        const short = (cs: SliceCheckResult[]): [number, number] => [
          cs.filter(c => c.status === 'fail').length,
          cs.filter(c => !(c.status === 'pass' && c.pendingAfterRelease.length === 0)).length
        ]
        const leafKey = (b: SliceBlockRow): string => { try { return blockLeafData(b) } catch { return '' } }
        const judged = blocks.map(b => ({ checks: evaluate(b), key: leafKey(b) }))
        judged.sort((a, b) => {
          const [fa, na] = short(a.checks)
          const [fb, nb] = short(b.checks)
          return (fa - fb) || (na - nb) || compareBytes(a.key, b.key)
        })
        checks = judged[0]!.checks
      }
    }
    const anyFail = checks.some(c => c.status === 'fail')
    const allPass = checks.every(c => c.status === 'pass' && c.pendingAfterRelease.length === 0)
    ballots.push({ ballotId, blockCid, verdict: anyFail ? 'fail' : allPass ? 'pass' : 'incomplete', checks })
  }

  const totals = { pass: 0, fail: 0, pending: 0, notApplicable: 0 }
  for (const b of ballots) {
    for (const c of b.checks) {
      if (c.status === 'pass') totals.pass++
      else if (c.status === 'fail') totals.fail++
      else if (c.status === 'pending-key-release') totals.pending++
      else totals.notApplicable++
    }
  }
  return { ok: true, electionId, electionRevision: revision, released, ballots, totals }
}
