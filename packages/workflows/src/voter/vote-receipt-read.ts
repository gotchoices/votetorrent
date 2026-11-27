/**
 * vote-receipt-read.ts - the receipt's reveal workflow (Phase 63 plan 12; D-11, D-13, D-15, D-18,
 * D-21, D-22). Moved verbatim from the read half of `apps/VoteTorrentVoter/src/engines/vote-receipt.ts`
 * (phase 67 plan 30); that path is now a binding that builds the reader over its store and vault, and
 * keeps the presentation helpers (nonce grouping, ballot rows, the election read).
 *
 * Status and loss facts come from the 63-08 marker with no keystore call. Choices and nonces come
 * only from the vault's open, which prompts for a fingerprint, and only when the decrypted record
 * matches the stored marker (WR-02). Storage is reached ONLY through the injected store's `readVoteMarker`
 * and `readSavedVote` (gate K1). This module never writes, deletes or
 * regenerates anything, and it caches nothing at module level. No logging.
 */

import type { SecretWrapPrompt } from '../platform/secret-wrap.js'
import type { SavedVoteRead, VoteMarkerClassification } from './vote-record-store.js'
import type { VoteMarker, VoteRecord, VoteRecordEnvelope, VoteRecordReveal, VoteRecordUnavailableReason } from './vote-record-ports.js'

const NONCE_RE = /^[0-9a-f]{64}$/

export type VoteReceiptLoad =
  | { kind: 'none' }
  | { kind: 'unreadable' }
  | { kind: 'saved' | 'stale', marker: VoteMarker, envelope: VoteRecordEnvelope, revisionKnown: boolean }

/** The store and vault calls the reader makes, plus the reason reader for a failed open. */
export interface VoteReceiptReaderDeps {
  readVoteMarker(electionId: string): Promise<VoteMarkerClassification>
  readSavedVote(electionId: string, currentRevision: number): Promise<SavedVoteRead>
  voteRecordMatchesMarker(record: VoteRecord, marker: VoteMarker): boolean
  openVoteRecord(electionId: string, envelope: VoteRecordEnvelope, options: { prompt: SecretWrapPrompt }): Promise<VoteRecord>
  /** The closed unavailable reason of a failed open, or null when the error is not the vault's. */
  unavailableReasonOf(err: unknown): VoteRecordUnavailableReason | null
}

export interface VoteReceiptReader {
  loadVoteReceipt(electionId: string, currentRevision: number | null): Promise<VoteReceiptLoad>
  revealVoteReceipt(electionId: string, envelope: VoteRecordEnvelope, prompt: SecretWrapPrompt): Promise<VoteRecordReveal>
}

const REVEAL_BY_REASON: Record<VoteRecordUnavailableReason, VoteRecordReveal['kind']> = {
  canceled: 'canceled',
  'biometric-unavailable': 'biometric-unavailable',
  'key-invalidated': 'unreadable',
  'no-wrap-key': 'unreadable',
  'policy-mismatch': 'unreadable',
  'tag-mismatch': 'unreadable',
  malformed: 'unreadable',
  'native-error': 'failed'
}

/** A fresh reader over the injected store and vault calls; it holds nothing. */
export function createVoteReceiptReader (deps: VoteReceiptReaderDeps): VoteReceiptReader {
  if (
    deps === null ||
    typeof deps !== 'object' ||
    typeof deps.readVoteMarker !== 'function' ||
    typeof deps.readSavedVote !== 'function' ||
    typeof deps.voteRecordMatchesMarker !== 'function' ||
    typeof deps.openVoteRecord !== 'function' ||
    typeof deps.unavailableReasonOf !== 'function'
  ) {
    throw new TypeError('vote receipt reader deps are required')
  }

  /** Marker-driven state: no keystore call, no prompt (D-13). */
  async function loadVoteReceipt (electionId: string, currentRevision: number | null): Promise<VoteReceiptLoad> {
    let revision: number
    let revisionKnown: boolean
    if (currentRevision === null) {
      const cls = await deps.readVoteMarker(electionId)
      if (cls.kind === 'absent') return { kind: 'none' }
      if (cls.kind === 'unreadable') return { kind: 'unreadable' }
      revision = cls.marker.electionRevision
      revisionKnown = false
    } else {
      revision = currentRevision
      revisionKnown = true
    }
    const read = await deps.readSavedVote(electionId, revision)
    if (read.state === 'none') return { kind: 'none' }
    if (read.state === 'unreadable') return { kind: 'unreadable' }
    // A missing or undecryptable record is reported, never silently re-enabled.
    if (read.envelopeState !== 'ok' || read.marker === null || read.envelope === null) return { kind: 'unreadable' }
    return { kind: read.state, marker: read.marker, envelope: read.envelope, revisionKnown }
  }

  /**
   * The one place choices and nonces are decrypted. Never rejects and never logs.
   *
   * WR-02: the record is shown only if it is the one the stored marker commits. The marker is read
   * fresh before the prompt (absent or unreadable: `unreadable`, no prompt), and the decrypted record
   * must match it (`voteRecordMatchesMarker`: election, revision, save time, ballot ids). A record a
   * failed save left under an older marker is therefore `unreadable`, never revealed.
   */
  async function revealVoteReceipt (
    electionId: string,
    envelope: VoteRecordEnvelope,
    prompt: SecretWrapPrompt
  ): Promise<VoteRecordReveal> {
    try {
      const stored = await deps.readVoteMarker(electionId)
      if (stored.kind !== 'ok') return { kind: 'unreadable' }
      const record = await deps.openVoteRecord(electionId, envelope, { prompt })
      if (
        record.electionId !== electionId ||
        !deps.voteRecordMatchesMarker(record, stored.marker) ||
        !record.votes.every((v) => NONCE_RE.test(v.nonce))
      ) {
        return { kind: 'unreadable' }
      }
      return { kind: 'ok', record }
    } catch (err) {
      const reason = deps.unavailableReasonOf(err)
      if (reason !== null) {
        const kind = REVEAL_BY_REASON[reason]
        if (kind === 'canceled' || kind === 'biometric-unavailable' || kind === 'unreadable' || kind === 'failed') {
          return { kind }
        }
      }
      return { kind: 'failed' }
    }
  }

  return { loadVoteReceipt, revealVoteReceipt }
}
