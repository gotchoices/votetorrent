// vote-entries.ts — the vote entry / voter entry pair the Voter app builds on Submit
// (doc/election.md:96-111). Lifted from spike 096; pure and Hermes-safe, no network, no schema.
//
// Dependency-light on purpose: only the crypto plugin's `digestFields` (the JS twin of SQL
// `Digest()`, already bundled on Hermes) and @noble/hashes.
//
// Invariants this module exists to hold:
//   (1) D-23: A vote entry carries nothing that identifies the voter. Its only per-voter value is
//       a fresh random nonce. Two voters making the same choices produce entries that differ ONLY
//       by nonce.
//   (2) D-25: The voter's signature covers the voter entry and the ballot template digests, NEVER
//       the answers or the nonce. A signature over the vote would link vote to voter the moment
//       the block is decrypted.
//   (3) D-24: the template digest field order below is a contract the future vote schema must
//       reproduce.
//   (4) D-27 / D-16: the nonce is 32 CSPRNG bytes as 64 lowercase hex. Voter entropy is not
//       passed this phase, but the optional parameter stays so mixing can be added later without
//       a format change.

import { digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'

const hasher = resolveHasher('sha256')
const encode = resolveOutputEncoder('base64url')

export const VOTE_ENTRY_KEYS = ['answers', 'ballotId', 'electionId', 'electionRevision', 'nonce', 'templateDigest', 'v'] as const
export const VOTER_ENTRY_KEYS = [
  'attestationCid', 'ballots', 'deviceKey', 'electionId', 'electionRevision', 'privateCid', 'publicCid',
  'registrantId', 'signature', 'v'
] as const

export interface VoteAnswer {
  questionCode: string
  /** Sorted ascending, de-duplicated — never the order the voter tapped them in. */
  optionCodes: string[]
}

export interface VoteEntry {
  v: 1
  electionId: string
  electionRevision: number
  ballotId: string
  templateDigest: string
  /** Sorted by questionCode. */
  answers: VoteAnswer[]
  /** 64 lowercase hex chars (32 bytes). */
  nonce: string
}

export interface VoterEntryUnsigned {
  v: 1
  electionId: string
  electionRevision: number
  registrantId: string
  privateCid: string
  publicCid: string | null
  /** Association.DeviceKey — the hardware P-256 voting key (hex, compressed). */
  deviceKey: string
  attestationCid: string | null
  /** One per ballot voted, sorted by ballotId. */
  ballots: Array<{ ballotId: string, templateDigest: string }>
}

export interface VoterEntry extends VoterEntryUnsigned {
  /** P-256 compact low-S hex over `voterEntryDigest(entry)`. */
  signature: string
}

/**
 * The ballot fields a template digest binds. Mirrors the core `Ballot` + `Question` + `Option` models
 * structurally (the core package is deliberately not imported: it is not on the purity allowlist).
 */
export interface TemplateBallot {
  id: string
  electionId: string
  authorityId: string
  description: string
  districts: string[]
  questions: Array<{
    code: string
    title: string
    type?: string
    optionRange?: { min: number, max: number }
    dependsOn?: unknown
    options: Array<{ code: string, title: string, details?: string }>
  }>
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The ballot template a voter signs against. There is no Ballot CID column (Ballot.Id is random),
 * so the template identity is DERIVED: a Digest over the election revision plus the ballot's
 * content in a canonical order (questions by code, options by code). Any change a voter could
 * see — wording, an added/removed option, a changed vote-for limit — changes it.
 *
 * D-24 CONTRACT: the field order ['BallotTemplate', electionId, electionRevision, id, authorityId,
 * description, JSON.stringify(sorted districts), JSON.stringify(questions)] and the per-question
 * tuple [code, title, type ?? 'select', optionRange ? [min, max] : null, dependsOn ?? null,
 * options-by-code [code, title, details ?? null]] must be reproduced by the future vote schema.
 * `required` and `instructions` are deliberately not bound.
 */
export function ballotTemplateDigest (ballot: TemplateBallot, electionRevision: number): string {
  const questions = [...ballot.questions]
    .sort((a, b) => byString(a.code, b.code))
    .map(q => [
      q.code,
      q.title,
      q.type ?? 'select',
      q.optionRange ? [q.optionRange.min, q.optionRange.max] : null,
      q.dependsOn ?? null,
      [...q.options].sort((a, b) => byString(a.code, b.code)).map(o => [o.code, o.title, o.details ?? null])
    ])
  return digestFields(
    ['BallotTemplate', ballot.electionId, electionRevision, ballot.id, ballot.authorityId, ballot.description,
      JSON.stringify([...ballot.districts].sort(byString)), JSON.stringify(questions)],
    hasher, encode
  ) as string
}

/**
 * 32-byte vote nonce. `random` MUST come from a CSPRNG (crypto.getRandomValues). Optional
 * voter-supplied entropy is MIXED IN by hashing — it can only add unpredictability, never replace
 * the CSPRNG bytes, so a voter typing "aaaa" cannot weaken the nonce.
 */
export function makeVoteNonce (random: Uint8Array, voterEntropy?: string): string {
  if (random.length !== 32) throw new Error('makeVoteNonce: need exactly 32 CSPRNG bytes')
  if (voterEntropy === undefined || voterEntropy === '') return bytesToHex(random)
  return bytesToHex(sha256(concatBytes(utf8ToBytes('vt-vote-nonce-v1'), random, utf8ToBytes(voterEntropy))))
}

/** selections: questionCode -> chosen option codes, in any order. */
export function buildVoteEntry (args: {
  ballot: TemplateBallot
  electionRevision: number
  selections: Record<string, string[]>
  nonce: string
}): VoteEntry {
  const { ballot, electionRevision, selections, nonce } = args
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error('buildVoteEntry: nonce must be 64 lowercase hex')
  // Each question carries its option set and its cap: Math.max(1, optionRange.max), 1 when absent
  // (the model default of 1 and 1, and the Voter UI cap). optionRange.min is NOT checked here.
  const known = new Map(ballot.questions.map(q => [
    q.code,
    { allowed: new Set(q.options.map(o => o.code)), cap: Math.max(1, q.optionRange?.max ?? 1) }
  ]))
  const answers: VoteAnswer[] = []
  for (const questionCode of Object.keys(selections).sort(byString)) {
    const q = known.get(questionCode)
    if (!q) throw new Error(`buildVoteEntry: unknown question ${questionCode}`)
    const optionCodes = [...new Set(selections[questionCode])].sort(byString)
    for (const c of optionCodes) if (!q.allowed.has(c)) throw new Error(`buildVoteEntry: unknown option ${questionCode}/${c}`)
    if (optionCodes.length > q.cap) throw new Error(`buildVoteEntry: too many options ${questionCode}: ${optionCodes.length} > ${q.cap}`)
    // A blank has exactly ONE representation: absent. Two encodings of the same blank ([] vs
    // absent) would let an observer tell app versions apart inside a block (D-23 unlinkability).
    if (optionCodes.length === 0) continue
    answers.push({ questionCode, optionCodes })
  }
  return {
    v: 1,
    electionId: ballot.electionId,
    electionRevision,
    ballotId: ballot.id,
    templateDigest: ballotTemplateDigest(ballot, electionRevision),
    answers,
    nonce
  }
}

/** The digest the voter's hardware key signs. Answers and nonces are deliberately NOT inputs. */
export function voterEntryDigest (e: VoterEntryUnsigned): string {
  const ballots = [...e.ballots].sort((a, b) => byString(a.ballotId, b.ballotId)).map(b => [b.ballotId, b.templateDigest])
  return digestFields(
    ['VoterEntry', e.v, e.electionId, e.electionRevision, e.registrantId, e.privateCid, e.publicCid, e.deviceKey,
      e.attestationCid, JSON.stringify(ballots)],
    hasher, encode
  ) as string
}
