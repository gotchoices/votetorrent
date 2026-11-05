// pool-block.ts — the block a pool forms, the checks each member runs before it signs, and the
// one-transaction commit (spikes 101 + 102). Pure TS except `commitPoolBlock`, which writes SQL.
//
// The block's payload is `v: 2`: every vote entry was encrypted to the election key Y by its own
// voter BEFORE it joined the pool (`encryptVoteEntry`), so the former handles only ciphertexts.
// Each member signs only after it has checked, against the former's disclosed randomness, that
// the stored ciphertext really is the payload it was shown and that its own vote ciphertext and
// voter entry are in it unaltered. The schema checks the rest at commit (VoteBlock /
// VoteBlockVoter CHECKs: block id/cid shape, voter list frozen, one vote per registrant per
// ballot, the signature over Digest('VoteBlockVoter', …), the voting window, the association).

import type { Database, SqlValue } from '@quereus/quereus'
import type { ElectionBlockPayload, ElectionKeyRecord } from '@votetorrent/vote-core'
import { cid, digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'
import { serializeBlockCiphertext } from '../crypto/index.js'
import { fromBase64url } from './pool-codec.js'
import {
  encryptPoolBlock,
  reencryptElectionBlock,
  type DisclosedBlockRandomness
} from '../key-release/election-block.js'
import { canonicalJson, sortByCanonicalBytes } from '../voting/canonical.js'
import type { VoterEntry } from '../voting/vote-entries.js'

const hasher = resolveHasher('sha256')
const encode = resolveOutputEncoder('base64url')

/** What one voter brings to a pool: its sealed vote and its signed voter entry. */
export interface PoolContribution {
  /** the member's libp2p peer id (where pool messages reach it) */
  member: string
  /** `encryptVoteEntry(...)` output: a BlockCiphertext JSON string sealed to Y */
  voteCiphertext: string
  voterEntry: VoterEntry
}

/** The fixed facts every member of one pool agrees on before it joins. */
export interface PoolBallot {
  electionKey: Pick<ElectionKeyRecord, 'electionId' | 'revision' | 'jointPublicKey'>
  ballotId: string
  /** ballotTemplateDigest(ballot, revision): stored on VoteBlock.TemplateDigest */
  templateDigest: string
}

export interface FormedPoolBlock {
  blockId: string
  cid: string
  /** the exact VoteBlock.Ciphertext text */
  ciphertext: string
  payload: ElectionBlockPayload
  randomness: DisclosedBlockRandomness
  /** sorted, = VoteBlock.VoterRegistrantIds */
  registrantIds: string[]
  templateDigest: string
}

export interface ConsentSignature {
  registrantId: string
  deviceKey: string
  /** P-256 compact low-S hex over {@link consentDigest} */
  signature: string
}

/** Pool topic: one per election revision, ballot and template, so only interchangeable votes pool. */
export function poolTopic (ballot: PoolBallot): string {
  return `vt-pool/1/${ballot.electionKey.electionId}/${ballot.electionKey.revision}/${ballot.ballotId}/${ballot.templateDigest}`
}

/** VoteBlock.Id: Digest('VoteBlockRecords', <payload JSON>), base64url (the spike-102 convention). */
export function poolBlockId (payload: ElectionBlockPayload): string {
  const json = JSON.stringify({ v: payload.v, votes: payload.votes, voterRecords: payload.voterRecords })
  return digestFields(['VoteBlockRecords', json], hasher, encode) as string
}

/** VoteBlock.Cid: the JS twin of SQL `cid(Digest(Ciphertext))`. */
export function poolBlockCid (ciphertext: string): string {
  const digest = digestFields([ciphertext], hasher, encode) as string
  const bytes = fromBase64url(digest)
  if (bytes === null) throw new Error('poolBlockCid: digest is not base64url')
  return cid(bytes)
}

/** The digest a member's device key signs: VoteBlockVoter.SignatureValid's exact input. */
export function consentDigest (block: Pick<FormedPoolBlock, 'cid' | 'blockId'>, ballot: PoolBallot, registrantId: string, deviceKey: string): string {
  return digestFields(
    ['VoteBlockVoter', ballot.electionKey.electionId, ballot.electionKey.revision, ballot.ballotId, block.cid, block.blockId, registrantId, deviceKey],
    hasher, encode
  ) as string
}

/**
 * Form the block from a pool's contributions. Both arrays are sorted by their own canonical bytes
 * (D-28): a block in pool order would link each vote to its voter by position after decryption.
 * Refuses a pool that names one registrant twice.
 */
export function formPoolBlock (contributions: readonly PoolContribution[], ballot: PoolBallot): FormedPoolBlock {
  const registrantIds = contributions.map(c => c.voterEntry.registrantId)
  if (new Set(registrantIds).size !== registrantIds.length) throw new Error('formPoolBlock: a registrant appears twice in the pool')
  if (new Set(contributions.map(c => c.voteCiphertext)).size !== contributions.length) throw new Error('formPoolBlock: a vote ciphertext appears twice in the pool')
  const payload: ElectionBlockPayload = {
    v: 2,
    votes: sortByCanonicalBytes(contributions.map(c => c.voteCiphertext)),
    voterRecords: sortByCanonicalBytes(contributions.map(c => c.voterEntry))
  }
  const blockId = poolBlockId(payload)
  const { ciphertext, randomness } = encryptPoolBlock(ballot.electionKey, blockId, payload)
  const text = serializeBlockCiphertext(ciphertext)
  return {
    blockId,
    cid: poolBlockCid(text),
    ciphertext: text,
    payload,
    randomness,
    registrantIds: [...registrantIds].sort(),
    templateDigest: ballot.templateDigest
  }
}

export type PoolBlockCheck = { ok: true } | { ok: false, reason: string }

const sameOrder = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((x, i) => canonicalJson(x) === canonicalJson(b[i]))

export type PoolPayloadShapeCode =
  | 'not-a-payload' | 'counts-differ' | 'voter-count-mismatch' | 'not-canonical-order'
  | 'duplicate-vote' | 'duplicate-voter' | 'voter-list-mismatch' | 'voter-entry-scope-mismatch'

export type PoolPayloadShapeCheck =
  | { ok: true }
  | { ok: false, code: PoolPayloadShapeCode, stage: 'structure' | 'records', reason: string }

/**
 * Payload structure + record checks shared by checkFormedPoolBlock (member side) and R7 (validator
 * side). Accepts v:1 and v:2 payloads (no version check; checkFormedPoolBlock keeps its own v:2
 * check). `reason` is the legacy checkFormedPoolBlock string. `scope` adds the voter-entry
 * election/revision check. May throw only where the legacy code did (a non-JSON value inside the
 * arrays); R7 wraps the call.
 */
export function checkPoolPayloadShape (
  payload: ElectionBlockPayload, registrantIds: readonly string[], scope?: { electionId: string, revision: number }
): PoolPayloadShapeCheck {
  const p = payload
  const fail = (code: PoolPayloadShapeCode, stage: 'structure' | 'records', reason: string): PoolPayloadShapeCheck => ({ ok: false, code, stage, reason })
  if (p === null || typeof p !== 'object' || !Array.isArray(p.votes) || !Array.isArray(p.voterRecords)) {
    return fail('not-a-payload', 'structure', 'the block is not a pool block')
  }
  if (p.votes.length !== p.voterRecords.length) return fail('counts-differ', 'structure', 'vote and voter counts differ')
  if (p.votes.length !== registrantIds.length) return fail('voter-count-mismatch', 'structure', 'the voter list does not match the entries')
  if (!sameOrder(p.votes, sortByCanonicalBytes(p.votes)) || !sameOrder(p.voterRecords, sortByCanonicalBytes(p.voterRecords))) {
    return fail('not-canonical-order', 'structure', 'the entries are not in canonical order')
  }
  if (new Set(p.votes as string[]).size !== p.votes.length) return fail('duplicate-vote', 'records', 'a vote appears twice')
  const ids = (p.voterRecords as VoterEntry[]).map(r => r?.registrantId)
  if (new Set(ids).size !== ids.length) return fail('duplicate-voter', 'records', 'a voter appears twice')
  if (canonicalJson([...ids].sort()) !== canonicalJson(registrantIds)) return fail('voter-list-mismatch', 'records', 'the voter list does not match the entries')
  if (scope !== undefined) {
    for (const r of p.voterRecords as VoterEntry[]) {
      if (r?.electionId !== scope.electionId || r?.electionRevision !== scope.revision) {
        return fail('voter-entry-scope-mismatch', 'records', 'a voter entry is for another election or revision')
      }
    }
  }
  return { ok: true }
}

/**
 * What a member checks before it signs a formed block. Every refusal names its reason (the former
 * relays it to the pool); a member never signs a block that fails any of these.
 */
export function checkFormedPoolBlock (block: FormedPoolBlock, mine: PoolContribution, ballot: PoolBallot): PoolBlockCheck {
  const p = block.payload
  if (p?.v !== 2 || !Array.isArray(p.votes) || !Array.isArray(p.voterRecords)) return { ok: false, reason: 'the block is not a pool block' }
  if (block.templateDigest !== ballot.templateDigest) return { ok: false, reason: 'the block names another ballot template' }
  // The shared shape is computed once. Its structure failures are reported before the member's own
  // entry checks and its record failures after them: exactly the legacy first-failure order.
  const shape = checkPoolPayloadShape(p, block.registrantIds, { electionId: ballot.electionKey.electionId, revision: ballot.electionKey.revision })
  if (!shape.ok && shape.stage === 'structure') return { ok: false, reason: shape.reason }
  if (p.votes.filter(v => v === mine.voteCiphertext).length !== 1) return { ok: false, reason: 'my vote is missing or altered' }
  const myEntry = canonicalJson(mine.voterEntry)
  if (p.voterRecords.filter(r => canonicalJson(r) === myEntry).length !== 1) return { ok: false, reason: 'my voter entry is missing or altered' }
  if (!shape.ok) return { ok: false, reason: shape.reason }
  if (poolBlockId(p) !== block.blockId) return { ok: false, reason: 'the block id is not the digest of the payload' }
  let rederived: string
  try {
    rederived = serializeBlockCiphertext(reencryptElectionBlock(ballot.electionKey, block.blockId, p, block.randomness))
  } catch {
    return { ok: false, reason: 'the disclosed randomness is unusable' }
  }
  if (rederived !== block.ciphertext) return { ok: false, reason: 'the ciphertext does not encrypt the shown payload' }
  if (poolBlockCid(block.ciphertext) !== block.cid) return { ok: false, reason: 'the cid does not match the ciphertext' }
  return { ok: true }
}

/**
 * Write the block and every member's VoteBlockVoter row in ONE transaction (spike 101: the block's
 * VotersMatchEntries CHECK runs at COMMIT, so a block without all its voters cannot land, and a
 * voter already in another block fails the whole transaction). `nowMs` is the writer's clock: the
 * WithinVotingWindow CHECK trusts it (spike 101 finding).
 */
export async function commitPoolBlock (
  db: Database,
  block: FormedPoolBlock,
  ballot: PoolBallot,
  signatures: readonly ConsentSignature[],
  clock: { nowMs: number, now: string }
): Promise<PoolCommitResult> {
  if (signatures.length !== block.registrantIds.length) return { ok: false, reason: 'not every member signed' }
  await db.exec('BEGIN')
  try {
    await db.exec(
      `insert into VoteBlock (Cid, Id, ElectionId, ElectionRevision, BallotId, TemplateDigest, EntryCount, VoterRegistrantIds, Ciphertext)
       with context NowMs = :nowMs values (:cid, :id, :e, :r, :b, :t, :n, :ids, :ct)`,
      {
        cid: block.cid, id: block.blockId, e: ballot.electionKey.electionId, r: ballot.electionKey.revision, b: ballot.ballotId,
        t: block.templateDigest, n: block.registrantIds.length, ids: JSON.stringify(block.registrantIds), ct: block.ciphertext, nowMs: clock.nowMs
      } as never
    )
    for (const s of signatures) {
      await db.exec(
        `insert into VoteBlockVoter (ElectionId, BallotId, RegistrantId, BlockCid, BlockId, ElectionRevision, DeviceKey, Signature)
         with context now = :now values (:e, :b, :reg, :c, :i, :r, :dk, :sig)`,
        {
          e: ballot.electionKey.electionId, b: ballot.ballotId, reg: s.registrantId, c: block.cid, i: block.blockId,
          r: ballot.electionKey.revision, dk: s.deviceKey, sig: s.signature, now: clock.now
        } as never
      )
    }
    await db.exec('COMMIT')
    return { ok: true }
  } catch (err) {
    try { await db.exec('ROLLBACK') } catch { /* the failed commit already rolled back */ }
    const reason = err instanceof Error ? err.message : String(err)
    if (classifyCommitFailure(reason) !== 'duplicate-voter') return { ok: false, reason }
    // Name who collided: one point lookup per registrant (no IN list), after ROLLBACK so the read
    // sees committed rows only. Each lookup has three outcomes (WR-03): a row of ANOTHER block (that
    // voter already voted), a row of THIS block (the distributed commit landed but threw: that voter
    // is in this very block), or unknown (no row yet, or the lookup threw).
    const duplicateRegistrants: string[] = []
    const unknown: string[] = []
    for (const registrantId of block.registrantIds) {
      try {
        const row = await firstRow(
          db,
          'select BlockCid from VoteBlockVoter where ElectionId = :e and BallotId = :b and RegistrantId = :reg',
          { e: ballot.electionKey.electionId, b: ballot.ballotId, reg: registrantId }
        )
        if (typeof row?.BlockCid !== 'string') unknown.push(registrantId)
        else if (row.BlockCid !== block.cid) duplicateRegistrants.push(registrantId)
        // else: this block's own row, never a duplicate
      } catch {
        unknown.push(registrantId)
      }
    }
    // The error text may name the colliding key; it is believed only for registrants the lookups
    // could not place, never over positive evidence that the row is this block's.
    if (duplicateRegistrants.length === 0) duplicateRegistrants.push(...registrantsNamedInCommitError(reason, unknown))
    return { ok: false, reason, duplicateRegistrants }
  }
}

async function firstRow (db: Database, sql: string, params: Record<string, SqlValue>): Promise<Record<string, SqlValue> | undefined> {
  for await (const row of db.eval(sql, params)) return row as Record<string, SqlValue>
  return undefined
}

/** `duplicateRegistrants` is present only when the failure classified as 'duplicate-voter'. */
export type PoolCommitResult = { ok: true } | { ok: false, reason: string, duplicateRegistrants?: string[] }

/**
 * A commit error caused by a voter who already has a VoteBlockVoter row: the local UNIQUE failure
 * or the distributed "key ... is already taken" (both shapes recorded by spike 101).
 */
export function classifyCommitFailure (message: string): 'duplicate-voter' | 'other' {
  if (/UNIQUE constraint failed: VoteBlockVoter\./.test(message)) return 'duplicate-voter'
  if (/Tree collection [^\s]*\/VoteBlockVoter: key .* is already taken/.test(message)) return 'duplicate-voter'
  return 'other'
}

/**
 * The registrants of `registrantIds` that the error text names as a key component, framed exactly
 * as `\u0002<id>\u0000` (as 6-character escape text, or as the literal control characters). Exact
 * framing keeps `b-reg-1` from matching inside `b-reg-15`; no pattern is built from the id.
 */
export function registrantsNamedInCommitError (message: string, registrantIds: readonly string[]): string[] {
  const out: string[] = []
  for (const id of registrantIds) {
    if (out.includes(id)) continue
    if (message.includes('\\u0002' + id + '\\u0000') || message.includes('\u0002' + id + '\u0000')) out.push(id)
  }
  return out
}
