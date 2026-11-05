// open-committed-block.ts — the shared R6-R8 opener for one committed VoteBlock row (65-06).
//
// Role:
//   - After the key release, opens one committed VoteBlock row: the block layer with openElectionBlock
//     and, for a v:2 payload, every per-vote layer with openVoteEntries. The R6 slice checks, the R7
//     validation and the R8 tally all open blocks through this one function.
//
// Caller-held secret rule:
//   - The caller obtains the election secret (for example from KeyReleaseEngine.reconstructElectionKey)
//     and zero-fills it after use. This module checks it against the joint public key first, never
//     copies it, never stores it, and never zero-fills it. No returned object holds or closes over it.
//
// Rules:
//   - Results are typed unions; the module reports every failure as a value and never throws. Each call
//     that can throw on hostile input is wrapped and mapped to a typed reason.
//   - Pure for Hermes and the browser: noble-backed relative imports only, no Node-only globals, no
//     logging, no clock, no randomness.

import type { ElectionBlockPayload, ElectionKeyRecord } from '@votetorrent/vote-core'
import { openElectionBlock, openVoteEntries } from '../key-release/election-block.js'
import { encryptionPublicKeyFromSecret } from '../crypto/index.js'
import { canonicalJson } from '../voting/canonical.js'

export type ElectionKeyLike = Pick<ElectionKeyRecord, 'electionId' | 'revision' | 'jointPublicKey'>

/** Structural subset of a VoteBlock row; extra columns are ignored. */
export interface CommittedBlockRow {
  Cid: string
  Id: string
  ElectionId: string
  ElectionRevision: number | bigint
  BallotId: string
  Ciphertext: string
}

export type ElectionSecretCheck =
  | { ok: true }
  | { ok: false, reason: 'invalid-secret' | 'secret-mismatch', detail: string }

export type OpenedBlockVote =
  | {
    ok: true
    index: number
    entry: unknown
    /** canonicalJson(entry) */
    entryJson: string
    /**
     * IN-07: v:2 only, whether the decrypted text was already canonicalJson(entry). A Voter encrypts the canonical
     * form; any other text is a client fingerprint inside a block (D-23 unlinkability). Always true for v:1.
     */
    canonical: boolean
  }
  | { ok: false, index: number, reason: 'vote-does-not-open' | 'vote-not-json', detail: string }

export type OpenCommittedBlockFailure =
  | 'malformed-row' | 'scope-mismatch' | 'invalid-secret' | 'secret-mismatch'
  | 'invalid-argument' | 'malformed-ciphertext' | 'unsupported-version' | 'authentication-failed' | 'malformed-payload'

export type OpenCommittedBlockResult =
  | {
    ok: true
    blockCid: string
    blockId: string
    ballotId: string
    payloadVersion: 1 | 2
    payload: ElectionBlockPayload
    votes: readonly OpenedBlockVote[]
  }
  | { ok: false, blockCid: string, reason: OpenCommittedBlockFailure, detail: string }

function normaliseRevision (value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  return null
}

/** Is `secretKey` a valid scalar whose public key is exactly the election's joint public key? */
export function checkElectionSecret (secretKey: Uint8Array, electionKey: ElectionKeyLike): ElectionSecretCheck {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) {
    return { ok: false, reason: 'invalid-secret', detail: 'the election secret must be a 32-byte Uint8Array' }
  }
  let derived: string
  try {
    derived = encryptionPublicKeyFromSecret(secretKey)
  } catch {
    return { ok: false, reason: 'invalid-secret', detail: 'the election secret is not a valid secp256k1 scalar' }
  }
  if (electionKey === null || typeof electionKey !== 'object' || typeof electionKey.jointPublicKey !== 'string') {
    return { ok: false, reason: 'secret-mismatch', detail: 'the election joint public key is unreadable' }
  }
  if (derived !== electionKey.jointPublicKey.toLowerCase()) {
    return { ok: false, reason: 'secret-mismatch', detail: 'the election secret does not match the joint public key' }
  }
  return { ok: true }
}

function nonEmpty (v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function openVotes (row: CommittedBlockRow, secretKey: Uint8Array, electionKey: ElectionKeyLike, payload: ElectionBlockPayload): OpenedBlockVote[] {
  const out: OpenedBlockVote[] = []
  if (payload.v === 2) {
    const opened = openVoteEntries(secretKey, electionKey, row.BallotId, payload)
    opened.forEach((o, index) => {
      if (!o.ok) {
        out.push({ ok: false, index, reason: 'vote-does-not-open', detail: `${o.reason}: ${o.detail}` })
        return
      }
      let entry: unknown
      try {
        entry = JSON.parse(o.voteEntryJson)
      } catch (error) {
        out.push({ ok: false, index, reason: 'vote-not-json', detail: `a decrypted vote is not JSON: ${error instanceof Error ? error.message : 'unreadable'}` })
        return
      }
      let entryJson: string
      try {
        entryJson = canonicalJson(entry)
      } catch (error) {
        out.push({ ok: false, index, reason: 'vote-not-json', detail: `a decrypted vote has no canonical JSON form: ${error instanceof Error ? error.message : 'unreadable'}` })
        return
      }
      out.push({ ok: true, index, entry, entryJson, canonical: entryJson === o.voteEntryJson })
    })
    return out
  }
  payload.votes.forEach((entry, index) => {
    try {
      out.push({ ok: true, index, entry, entryJson: canonicalJson(entry), canonical: true })
    } catch (error) {
      out.push({ ok: false, index, reason: 'vote-not-json', detail: `a clear vote has no canonical JSON form: ${error instanceof Error ? error.message : 'unreadable'}` })
    }
  })
  return out
}

/** Open one committed block with a caller-held secret. Never throws. */
export function openCommittedBlock (row: CommittedBlockRow, secretKey: Uint8Array, electionKey: ElectionKeyLike): OpenCommittedBlockResult {
  const blockCid = row !== null && typeof row === 'object' && typeof row.Cid === 'string' ? row.Cid : ''
  const fail = (reason: OpenCommittedBlockFailure, detail: string): OpenCommittedBlockResult => ({ ok: false, blockCid, reason, detail })
  if (row === null || typeof row !== 'object') return fail('malformed-row', 'the block row is not an object')
  if (!nonEmpty(row.Cid)) return fail('malformed-row', 'the block row has no Cid')
  if (!nonEmpty(row.Id)) return fail('malformed-row', 'the block row has no Id')
  if (!nonEmpty(row.BallotId)) return fail('malformed-row', 'the block row has no BallotId')
  if (typeof row.ElectionId !== 'string') return fail('malformed-row', 'the block row has no ElectionId')
  if (typeof row.Ciphertext !== 'string') return fail('malformed-row', 'the block row has no Ciphertext')
  const revision = normaliseRevision(row.ElectionRevision)
  if (revision === null) return fail('malformed-row', 'the block row ElectionRevision is not a non-negative safe integer')
  if (electionKey === null || typeof electionKey !== 'object') return fail('scope-mismatch', 'the election key is unreadable')
  if (row.ElectionId !== electionKey.electionId || revision !== electionKey.revision) {
    return fail('scope-mismatch', 'the block row belongs to another election or revision')
  }
  const secret = checkElectionSecret(secretKey, electionKey)
  if (!secret.ok) return fail(secret.reason, secret.detail)
  const opened = openElectionBlock(secretKey, electionKey, { blockId: row.Id, ciphertext: row.Ciphertext })
  if (!opened.ok) {
    const reason: OpenCommittedBlockFailure = opened.reason === 'not-reconstructable' ? 'invalid-argument' : opened.reason
    return fail(reason, opened.detail)
  }
  const payload = opened.payload
  return {
    ok: true,
    blockCid: row.Cid,
    blockId: row.Id,
    ballotId: row.BallotId,
    payloadVersion: payload.v,
    payload,
    votes: openVotes(row, secretKey, electionKey, payload)
  }
}
