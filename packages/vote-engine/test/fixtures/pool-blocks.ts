/**
 * pool-blocks.ts — the shared committed-row fixture for the R5-R8 specs (65-05).
 *
 * Builds schema-shaped committed VoteBlock and VoteBlockVoter rows (v:2 pool blocks and v:1 clear-vote
 * blocks) from the pool primitives, with REAL consent and voter-entry P-256 signatures and receipt-shaped
 * entries that reopen after release. No DKG and no Database: the election secret is a plain secp256k1
 * scalar and Y is its public key.
 *
 * Ownership: 65-06, 65-07 and 65-08 do NOT own this file. They build tampered variants inside their own
 * specs (clone a row, change a field) and never edit this module.
 *
 * Real Voter encryption rule: the Voter encrypts canonicalJson(voteEntry) (vote-sending.ts), and so does
 * this fixture. The only randomness is CSPRNG keys, nonces and the registrant-id suffix.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { ElectionBlockPayload } from '@votetorrent/vote-core'
import { serializeBlockCiphertext } from '../../src/crypto/index.js'
import { encryptElectionBlock, encryptVoteEntry } from '../../src/key-release/index.js'
import {
  consentDigest,
  formPoolBlock,
  poolBlockCid,
  poolBlockId,
  poolIdentityFromRawKey,
  type FormedPoolBlock,
  type PoolBallot,
  type PoolContribution,
  type PoolIdentity
} from '../../src/pool/index.js'
import {
  ballotTemplateDigest,
  buildVoteEntry,
  canonicalJson,
  makeVoteNonce,
  sortByCanonicalBytes,
  voterEntryDigest,
  type TemplateBallot,
  type VoteEntry,
  type VoterEntry,
  type VoterEntryUnsigned
} from '../../src/voting/index.js'
import { makeP256TestKey, signDigestP256 } from './p256-signer.js'

export const FIXTURE_ELECTION_ID = 'election-blocks-1' as const
export const FIXTURE_REVISION = 1 as const
/** CR-02: the fixture timeline's votingStarts; every fixture registrant and association expires after it. */
export const FIXTURE_VOTING_STARTS = Date.parse('2026-06-01T00:00:00.000Z')
export const FIXTURE_EXPIRATION = '2030-01-01T00:00:00.000Z' as const

/** CR-02: the Registrant and Association rows that authorize the fixture voters (VoterAssociated). */
export interface FixtureAuthorization {
  registrants: Array<{ Id: string, Status: string, Expiration: string }>
  associations: Array<{ RegistrantId: string, DeviceKey: string, Expiration: string }>
  timeline: { votingStarts: number }
}

/** An active, unexpired registrant and an unexpired association of its device key, for every voter given. */
export function fixtureAuthorization (voters: ReadonlyArray<{ voterEntry: VoterEntry, pubHex: string }>): FixtureAuthorization {
  return {
    registrants: voters.map(v => ({ Id: v.voterEntry.registrantId, Status: 'a', Expiration: FIXTURE_EXPIRATION })),
    associations: voters.map(v => ({ RegistrantId: v.voterEntry.registrantId, DeviceKey: v.pubHex, Expiration: FIXTURE_EXPIRATION })),
    timeline: { votingStarts: FIXTURE_VOTING_STARTS }
  }
}

/** All 9 VoteBlock columns, as stored. */
export interface VoteBlockRow {
  Cid: string
  Id: string
  ElectionId: string
  ElectionRevision: number
  BallotId: string
  TemplateDigest: string
  EntryCount: number
  /** JSON of the sorted registrant ids */
  VoterRegistrantIds: string
  Ciphertext: string
}

/** All 8 VoteBlockVoter columns, as stored. */
export interface VoteBlockVoterRow {
  ElectionId: string
  BallotId: string
  RegistrantId: string
  BlockCid: string
  BlockId: string
  ElectionRevision: number
  DeviceKey: string
  Signature: string
}

export interface FixtureBallot { template: TemplateBallot, poolBallot: PoolBallot }

export interface FixtureElection {
  electionSecret: Uint8Array
  electionKey: PoolBallot['electionKey']
  ballots: FixtureBallot[]
}

export interface FixtureVoter {
  index: number
  identity: PoolIdentity
  priv: Uint8Array
  pubHex: string
  /** the plaintext entry (built by buildVoteEntry, or the caller's raw entry) */
  voteEntry: VoteEntry
  /** canonicalJson(voteEntry), exactly what was encrypted */
  voteJson: string
  voteCiphertext: string
  /** signature = signDigestP256(voterEntryDigest(unsigned), priv): REAL */
  voterEntry: VoterEntry
  contribution: PoolContribution
}

export interface FixtureReceipt { electionId: string, electionRevision: number, votes: VoteEntry[], voter: VoterEntry }

export interface CommittedFixtureBlock {
  payloadVersion: 1 | 2
  ballot: FixtureBallot
  voters: FixtureVoter[]
  payload: ElectionBlockPayload
  row: VoteBlockRow
  /** Signature = REAL consent signature */
  voterRows: VoteBlockVoterRow[]
  /** present for v:2 only */
  formed?: FormedPoolBlock
}

export interface CommittedFixtureSet {
  election: FixtureElection
  blocks: CommittedFixtureBlock[]
  rows: VoteBlockRow[]
  voterRows: VoteBlockVoterRow[]
  /** one receipt per voter */
  receipts: FixtureReceipt[]
  /** CR-02: authorizes every voter of every block */
  authorization: FixtureAuthorization
}

export function makeFixtureTemplate (ballotId: string, overrides: Partial<TemplateBallot> = {}): TemplateBallot {
  return {
    id: ballotId,
    electionId: FIXTURE_ELECTION_ID,
    authorityId: 'authority-blocks-1',
    description: `Fixture ballot ${ballotId}`,
    districts: ['d1'],
    questions: [
      {
        code: 'q1', title: 'Question one', type: 'select', optionRange: { min: 1, max: 1 },
        options: [{ code: 'a', title: 'Option A' }, { code: 'b', title: 'Option B' }, { code: 'c', title: 'Option C' }]
      },
      {
        code: 'q2', title: 'Question two', type: 'select', optionRange: { min: 1, max: 2 },
        options: [{ code: 'x', title: 'Option X' }, { code: 'y', title: 'Option Y' }, { code: 'z', title: 'Option Z' }]
      },
      {
        code: 'q3', title: 'Question three', type: 'rank', optionRange: { min: 1, max: 2 },
        options: [{ code: 'r1', title: 'Rank one' }, { code: 'r2', title: 'Rank two' }]
      }
    ],
    ...overrides
  }
}

export function makeFixtureElection (opts: { ballotIds?: string[], templates?: TemplateBallot[] } = {}): FixtureElection {
  const electionSecret = secp256k1.utils.randomSecretKey()
  const electionKey: PoolBallot['electionKey'] = {
    electionId: FIXTURE_ELECTION_ID,
    revision: FIXTURE_REVISION,
    jointPublicKey: bytesToHex(secp256k1.getPublicKey(electionSecret, true))
  }
  const templates = opts.templates ?? (opts.ballotIds ?? ['ballot-a']).map(id => makeFixtureTemplate(id))
  const ballots = templates.map((template): FixtureBallot => ({
    template,
    poolBallot: { electionKey, ballotId: template.id, templateDigest: ballotTemplateDigest(template, FIXTURE_REVISION) }
  }))
  return { electionSecret, electionKey, ballots }
}

export function signVoterEntry (unsigned: VoterEntryUnsigned, priv: Uint8Array): VoterEntry {
  return { ...unsigned, signature: signDigestP256(voterEntryDigest(unsigned), priv) }
}

export function makeFixtureVoter (election: FixtureElection, ballot: FixtureBallot, index: number, opts: {
  selections?: Record<string, string[]>
  voteEntry?: VoteEntry
  voterBallots?: FixtureBallot[]
} = {}): FixtureVoter {
  const identity = poolIdentityFromRawKey(ed25519.utils.randomSecretKey())
  const { privBytes: priv, pubHex } = makeP256TestKey()
  const ballotId = ballot.poolBallot.ballotId
  const voteEntry = opts.voteEntry ?? buildVoteEntry({
    ballot: ballot.template,
    electionRevision: FIXTURE_REVISION,
    selections: opts.selections ?? {
      q1: [['a', 'b', 'c'][index % 3]!],
      q2: index % 2 === 0 ? ['x'] : ['x', 'y']
    },
    nonce: makeVoteNonce(globalThis.crypto.getRandomValues(new Uint8Array(32)))
  })
  const voteJson = canonicalJson(voteEntry)
  const voteCiphertext = encryptVoteEntry(election.electionKey, ballotId, voteJson)
  const suffix = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(3)))
  const voterBallots = [...(opts.voterBallots ?? [ballot])]
    .sort((a, b) => (a.poolBallot.ballotId < b.poolBallot.ballotId ? -1 : a.poolBallot.ballotId > b.poolBallot.ballotId ? 1 : 0))
  const voterEntry = signVoterEntry({
    v: 1,
    electionId: FIXTURE_ELECTION_ID,
    electionRevision: FIXTURE_REVISION,
    registrantId: `registrant-${ballotId}-${index}-${suffix}`,
    privateCid: `private-${index}`,
    publicCid: null,
    deviceKey: pubHex,
    attestationCid: null,
    ballots: voterBallots.map(b => ({ ballotId: b.poolBallot.ballotId, templateDigest: b.poolBallot.templateDigest }))
  }, priv)
  return {
    index, identity, priv, pubHex, voteEntry, voteJson, voteCiphertext, voterEntry,
    contribution: { member: identity.peerId, voteCiphertext, voterEntry }
  }
}

export function makeCommittedBlock (election: FixtureElection, ballot: FixtureBallot, voters: readonly FixtureVoter[], opts: { payloadVersion?: 1 | 2 } = {}): CommittedFixtureBlock {
  const payloadVersion = opts.payloadVersion ?? 2
  const poolBallot = ballot.poolBallot
  let payload: ElectionBlockPayload
  let id: string
  let ciphertext: string
  let cid: string
  let formed: FormedPoolBlock | undefined
  if (payloadVersion === 2) {
    formed = formPoolBlock(voters.map(v => v.contribution), poolBallot)
    payload = formed.payload
    id = formed.blockId
    ciphertext = formed.ciphertext
    cid = formed.cid
  } else {
    payload = {
      v: 1,
      votes: sortByCanonicalBytes(voters.map(v => v.voteEntry)),
      voterRecords: sortByCanonicalBytes(voters.map(v => v.voterEntry))
    }
    id = poolBlockId(payload)
    ciphertext = serializeBlockCiphertext(encryptElectionBlock(election.electionKey, id, payload))
    cid = poolBlockCid(ciphertext)
  }
  const registrantIds = voters.map(v => v.voterEntry.registrantId).sort()
  const row: VoteBlockRow = {
    Cid: cid,
    Id: id,
    ElectionId: FIXTURE_ELECTION_ID,
    ElectionRevision: FIXTURE_REVISION,
    BallotId: poolBallot.ballotId,
    TemplateDigest: poolBallot.templateDigest,
    EntryCount: voters.length,
    VoterRegistrantIds: JSON.stringify(registrantIds),
    Ciphertext: ciphertext
  }
  const voterRows = voters.map((v): VoteBlockVoterRow => ({
    ElectionId: FIXTURE_ELECTION_ID,
    BallotId: poolBallot.ballotId,
    RegistrantId: v.voterEntry.registrantId,
    BlockCid: cid,
    BlockId: id,
    ElectionRevision: FIXTURE_REVISION,
    DeviceKey: v.pubHex,
    Signature: signDigestP256(consentDigest({ cid, blockId: id }, poolBallot, v.voterEntry.registrantId, v.pubHex), v.priv)
  }))
  return { payloadVersion, ballot, voters: [...voters], payload, row, voterRows, formed }
}

export function makeCommittedElection (opts: {
  ballotIds?: string[]
  blocks: Array<{
    ballotIndex?: number
    size: number
    payloadVersion?: 1 | 2
    selections?: (voterIndex: number) => Record<string, string[]>
  }>
}): CommittedFixtureSet {
  const election = makeFixtureElection({ ballotIds: opts.ballotIds })
  const blocks: CommittedFixtureBlock[] = []
  const receipts: FixtureReceipt[] = []
  let voterIndex = 0
  for (const spec of opts.blocks) {
    const ballot = election.ballots[spec.ballotIndex ?? 0]!
    const voters: FixtureVoter[] = []
    for (let i = 0; i < spec.size; i++) {
      const selections = spec.selections?.(voterIndex)
      voters.push(makeFixtureVoter(election, ballot, voterIndex, selections === undefined ? {} : { selections }))
      voterIndex++
    }
    blocks.push(makeCommittedBlock(election, ballot, voters, { payloadVersion: spec.payloadVersion }))
    for (const v of voters) {
      receipts.push({ electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION, votes: [v.voteEntry], voter: v.voterEntry })
    }
  }
  return {
    election,
    blocks,
    rows: blocks.map(b => b.row),
    voterRows: blocks.flatMap(b => b.voterRows),
    receipts,
    authorization: fixtureAuthorization(blocks.flatMap(b => b.voters))
  }
}

/** Deterministic Fisher-Yates over a copy, driven by mulberry32(seed). No Math.random. */
export function seededShuffle<T> (items: readonly T[], seed: number): T[] {
  const out = [...items]
  let s = seed >>> 0
  const next = (): number => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}
