/**
 * vote-record-ports.ts: the vote record, marker, guard, write-reason, unavailable-reason and reveal
 * types the shared vote casting and sending name, plus the two ports through which the shared
 * `castVote` reaches the platform's record store and record vault (phase 67 plan 22).
 *
 * The record types are copied member for member from the Voter's `engines/vote-record-vault.ts`,
 * `engines/vote-record-store.ts` and `engines/vote-receipt.ts`, and are pinned EXACTLY equal to them
 * by `apps/VoteTorrentVoter/src/engines/__tests__/vote-workflows-parity.test.ts`. The store and the
 * vault themselves stay on the platform side (they reach the device's storage and the native wrap
 * provider); only their surfaces are named here.
 *
 * Type-only: this file emits nothing.
 */
import type { SecretWrapPrompt, WrappedSecret } from '../platform/secret-wrap.js'

export interface VoteRecordAnswer {
  questionCode: string
  optionCodes: string[]
}

export interface VoteRecordVoteEntry {
  v: 1
  electionId: string
  electionRevision: number
  ballotId: string
  templateDigest: string
  answers: VoteRecordAnswer[]
  nonce: string
}

export interface VoteRecordVoterEntry {
  v: 1
  electionId: string
  electionRevision: number
  registrantId: string
  privateCid: string
  publicCid: string | null
  deviceKey: string
  attestationCid: string | null
  ballots: Array<{ ballotId: string; templateDigest: string }>
  signature: string
}

export interface VoteRecord {
  v: 1
  electionId: string
  electionRevision: number
  savedAt: string
  votes: VoteRecordVoteEntry[]
  voter: VoteRecordVoterEntry
}

export interface VoteRecordEnvelope {
  v: 1
  wrappedKey: WrappedSecret
  /** Standard base64, 12 bytes. */
  iv: string
  /** Standard base64, includes the 16-byte GCM tag. */
  ct: string
}

export type VoteRecordUnavailableReason =
  | 'canceled'
  | 'biometric-unavailable'
  | 'key-invalidated'
  | 'no-wrap-key'
  | 'policy-mismatch'
  | 'tag-mismatch'
  | 'malformed'
  | 'native-error'

export interface VoteMarker {
  v: 1
  electionId: string
  electionRevision: number
  ballotIds: string[]
  savedAt: string
  status: 'saved-not-sent'
}

export type VoteStoreWriteReason = 'already-saved' | 'unreadable' | 'invalid-input' | 'storage-failed'

export type VoteGuardResult = 'ok' | 'already-saved' | 'stale'

/** The result of opening a sealed record (the Voter's `VoteReceiptReveal`, under a platform-neutral name). */
export type VoteRecordReveal =
  | { kind: 'ok'; record: VoteRecord }
  | { kind: 'canceled' }
  | { kind: 'biometric-unavailable' }
  | { kind: 'unreadable' }
  | { kind: 'failed' }

/**
 * The platform's vote record store, as the shared `castVote` sees it. A plain-function object: every
 * member is called without `this`. The store is the ONLY writer of vote state (the sealed envelope and
 * its marker); `guard` reads the saved state for an election, `buildVoteMarker` derives the marker
 * from a record, `writeVoteRecord` commits envelope and marker together, and `VoteStoreWriteError` is
 * the class whose `reason` classifies a refused write (`instanceof` is the test castVote applies).
 */
export interface VoteRecordStorePort {
  guard(electionId: string, currentRevision: number): Promise<VoteGuardResult>
  buildVoteMarker(record: VoteRecord): VoteMarker
  writeVoteRecord(envelope: VoteRecordEnvelope, marker: VoteMarker): Promise<void>
  VoteStoreWriteError: abstract new (...args: never[]) => Error & { readonly reason: VoteStoreWriteReason }
}

/**
 * The platform's vote record vault, as the shared `castVote` sees it. A plain-function object: every
 * member is called without `this`. The vault performs NO persistence: `sealVoteRecord` wraps the
 * record under a prompt-gated key and returns the envelope to its caller, and plaintext is returned
 * to no one but that caller. `VoteRecordUnavailableError` is the class whose `reason` classifies a
 * failed seal (`instanceof` is the test castVote applies).
 */
export interface VoteRecordVaultPort {
  sealVoteRecord(record: VoteRecord, options: { prompt: SecretWrapPrompt }): Promise<VoteRecordEnvelope>
  VoteRecordUnavailableError: abstract new (...args: never[]) => Error & { readonly reason: VoteRecordUnavailableReason }
}
