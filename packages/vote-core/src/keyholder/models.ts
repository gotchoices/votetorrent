// src/keyholder/models.ts — the DKG key-loop contract types (62-17: D-13, D-14,
// D-16, D-19, D-25, D-26). Types only, no runtime imports beyond `Signature`.
//
// These names are LOCKED and consumed verbatim by 62-20 (key release and public
// reconstruction), 62-24 (two-node DKG legs) and 62-26 (Authority keyholder app
// and round driver) — see 62-17-PLAN.md `<interfaces>`.
//
// Private keys, shares and round secrets NEVER enter vote-core or vote-engine
// except as opaque vault bytes (D-16) — nothing in this file, or anywhere
// `src/keyholder/*` imports, assembles or stores a full private key.

import type { Signature } from '../common/index.js'

/** Mirrors the schema's `KeyholderDkgMessage.AttemptValid` bound (`Attempt` is 1..3). */
export const DKG_MAX_ATTEMPTS = 3

/**
 * Per-round deadline after which a DKG status read FLAGS the round's awaited keyholders to officers
 * (`KeyholderDkgStatus.overdueUserIds`). Advisory only: it never causes an automatic action, a fault, an abort or a
 * disqualification; officers decide. 24 h is the user's figure (62-OPEN-ITEMS 8d) and matches the keyholder
 * invitation default (user decision 9). APPROXIMATE: it rests on signer-claimed timestamps (a back-dating or
 * slow-clock answerer can make it fire early, T-62-139-02), so no consumer may present it as a guarantee of a full
 * 24 h of silence.
 */
export const DKG_ROUND_DEADLINE_MS = 24 * 60 * 60 * 1000

/** `KeyholderDkgMessage.DkgRound` (R0 commit .. R4 result). */
export type DkgRound = 0 | 1 | 2 | 3 | 4

/**
 * The lifecycle phase of a revision's DKG. `'failed'` is TERMINAL for the
 * revision — no further attempt is ever started once a revision reaches it
 * (either the 3-attempt cap was spent, or the live roster can never reach
 * `threshold` again).
 */
export type DkgPhase = 'not-started' | 'blocked' | 'in-progress' | 'restarting' | 'complete' | 'failed'

export type DkgBlockedReason = 'no-current-revision' | 'no-keyholders' | 'threshold-out-of-range' | 'pending-invites'
export type DkgWaitingReason = 'awaiting-participants' | 'roster-mismatch'
export type DkgFailedReason = 'attempts-exhausted' | 'threshold-unreachable' | 'election-key-mismatch'
export type DkgAbortReason = 'faults' | 'unresolved-complaint' | 'roster-changed'
export type DkgFaultReason =
  | 'malformed-round0' | 'commit-mismatch' | 'invalid-round1' | 'malformed-round2'
  | 'malformed-round3' | 'invalid-share' | 'undecryptable-share' | 'false-complaint' | 'malformed-complaint'
  | 'round4-mismatch'

export interface DkgDisqualification {
  attempt: number
  userId: string
  reason: DkgFaultReason
  complainantUserId?: string
}

export interface DkgAttemptSummary {
  attempt: number
  roster: string[]
  outcome: 'collecting' | 'aborted' | 'agreed'
  round: DkgRound
  abortReason?: DkgAbortReason
  disqualified: DkgDisqualification[]
  unresolvedComplaints: number
}

export interface ElectionKeyRecord {
  electionId: string
  revision: number
  attempt: number
  jointPublicKey: string
  groupCommitments: string[]
  threshold: number
  participants: number
  publishedAt: string
  publisherUserId: string
}

export interface KeyholderDkgSelfStatus {
  userId: string
  isParticipant: boolean
  isDisqualified: boolean
  hasShare: boolean
}

export interface KeyholderDkgStatus {
  electionId: string
  revision: number | null
  threshold: number | null
  phase: DkgPhase
  blockedReason?: DkgBlockedReason
  waitingReason?: DkgWaitingReason
  failedReason?: DkgFailedReason
  currentAttempt: number | null
  currentRound: DkgRound | null
  roster: string[]
  awaitingUserIds: string[]
  attempts: DkgAttemptSummary[]
  disqualified: DkgDisqualification[]
  electionKey: ElectionKeyRecord | null
  self?: KeyholderDkgSelfStatus
  /**
   * When the current round opened, by the evaluator's rule 10 (signed timestamps; the earliest answer caps the latest
   * opening candidate). null when no round is running or no usable timestamp exists.
   */
  roundOpenedAt?: string | null
  /**
   * Sorted. The awaited keyholders (`awaitingUserIds`) once the current round has been open for
   * `DKG_ROUND_DEADLINE_MS` at the status read; [] otherwise. Advisory flag only.
   */
  overdueUserIds?: string[]
  /**
   * Sorted user ids with a Keyholder row in the CURRENT revision, unfiltered by binding or disqualification.
   * UNDEFINED (never []) when no ElectionRevision row was read.
   */
  liveRoster?: string[]
  /**
   * Sorted user ids that have at least one Keyholder row for this election and EVERY one of those rows is in a
   * revision BEFORE the current one (a user with any row at or after the current revision is not listed).
   * UNDEFINED (never []) when no ElectionRevision row was read.
   *
   * KeyholderDkgEngine sets all four optional fields on every read that found an ElectionRevision row. They are
   * optional so hand-built status fixtures stay valid; a consumer treats undefined as unknown (no flag; fail closed
   * for any security decision, e.g. the one-seat check).
   */
  earlierRevisionUserIds?: string[]
}

export interface KeyholderDkgSigner {
  userId: string
  signingPublicKey: string
  sign: (digest: Uint8Array) => Promise<Signature>
}

export type DkgActionTaken =
  | 'removed-disqualified' | 'posted-round-0' | 'posted-round-1' | 'posted-round-2'
  | 'posted-round-3-ack' | 'posted-round-3-complaint' | 'posted-round-4' | 'published-election-key' | 'cleaned-vault'

export interface DkgAdvanceResult {
  actions: DkgActionTaken[]
  status: KeyholderDkgStatus
}

export interface DkgTranscriptVerdict {
  electionId: string
  revision: number
  rowCount: number
  invalidRows: Array<{ attempt: number, round: number, senderUserId: string }>
  electionKeyConsistent: boolean | null
  status: KeyholderDkgStatus
}

// ---------------------------------------------------------------------------
// Key release and public reconstruction (62-20: D-13, D-14, D-17, D-18, D-20)
// ---------------------------------------------------------------------------
//
// APPENDED by 62-20. None of 62-17's declarations above are modified. These
// names are LOCKED and consumed verbatim by 62-24 (two-node share-release
// legs) and 62-29 (KeyReleaseScreen, Voter `releasedCount`, web-data reads)
// — see 62-20-PLAN.md `<interfaces>`. `ElectionKeyRecord` and
// `KeyholderDkgSigner` above are reused as-is: the release signer is the
// SAME keyholder identity key the DKG used.

/**
 * `'before-release-window'`/`'releasing'` are mutually exclusive with
 * `'reconstructable'` only by COUNT — public shares are public whatever the
 * clock says, so k accepted releases make the phase `'reconstructable'` even
 * before `releasingKeys` (D-14 overrides D-20's window for counting, never
 * for seeding or for the honest `releaseKeyShare` path).
 */
export type KeyReleasePhase =
  | 'no-current-revision' | 'no-election-key' | 'election-key-inconsistent'
  | 'before-release-window' | 'releasing' | 'reconstructable'

export type KeyReleaseRejectionReason = 'signature-invalid' | 'not-a-participant' | 'identifier-mismatch' | 'share-invalid'

export interface KeyShareReleaseRecord {
  electionId: string
  revision: number
  userId: string
  /** `dkgIdentifierForUser(userId)`, 64-char lowercase hex. */
  identifier: string
  /** 64-char lowercase hex. PUBLIC once released (D-17) — never treated as a secret once this row exists. */
  signingShare: string
  /** ISO-Z text. */
  releasedAt: string
  signerKey: string
}

export interface KeyReleaseRejection {
  userId: string
  reason: KeyReleaseRejectionReason
}

export interface KeyReleaseSelfStatus {
  userId: string
  isParticipant: boolean
  hasReleased: boolean
  hasShare: boolean
}

export interface KeyReleaseStatus {
  electionId: string
  revision: number | null
  phase: KeyReleasePhase
  /** Epoch ms from `ElectionRevision.Timeline.releasingKeys`; null when unset (fail closed — never seed, never open the window). */
  releasingKeysAt: number | null
  hasEnteredReleasingKeys: boolean
  /** k (D-14): `ElectionKey.Threshold`, required to equal the current revision's `KeyholderThreshold`. */
  threshold: number | null
  /** n: the published participant count. */
  participants: number | null
  /** Counts ACCEPTED releases ONLY — these are what count toward k. */
  releasedCount: number
  /** Sorted by userId. */
  releasedUserIds: string[]
  /** R4 participants with no accepted release yet, sorted by userId. */
  awaitingUserIds: string[]
  /** Rows present but NOT counted toward k, sorted by userId. */
  rejectedReleases: KeyReleaseRejection[]
  electionKey: ElectionKeyRecord | null
  self?: KeyReleaseSelfStatus
}

export type KeyShareReleaseOutcome =
  | { outcome: 'released'; release: KeyShareReleaseRecord }
  | { outcome: 'already-released'; release: KeyShareReleaseRecord }

export interface ReconstructedElectionKey {
  electionId: string
  revision: number
  jointPublicKey: string
  /**
   * The reconstructed election secret key. Exists ONLY in the reconstructing
   * caller's own process memory, and only after k shares have been PUBLICLY
   * released — D-16 custody holds until release; D-17 governs what happens
   * after. This module never persists, vaults or logs it.
   */
  secretKey: Uint8Array
  threshold: number
  participants: number
  usedUserIds: string[]
  rejectedReleases: KeyReleaseRejection[]
}

/**
 * D-18: a block's payload ALWAYS carries both the votes AND the voter
 * records of that block — they are encrypted together under the joint key
 * Y. A payload missing either array is refused before encryption (see
 * `encryptElectionBlock` in vote-engine's `src/key-release/election-block.ts`),
 * so a block builder cannot leave voter records in clear by accident.
 *
 * `v: 1` carries each vote entry in clear inside the block. `v: 2` (pool-formed
 * blocks, spike 102) carries each vote entry ALREADY encrypted to Y on its own
 * (`votes` is an array of `BlockCiphertext` JSON strings), so the voter who
 * forms the block never sees a vote before the key release.
 */
export interface ElectionBlockPayload {
  v: 1 | 2
  votes: unknown[]
  voterRecords: unknown[]
}

/** `ciphertext` is a `BlockCiphertext` object (62-04) or its JSON string. */
export interface ElectionBlockInput {
  blockId: string
  ciphertext: unknown
}

export type ElectionBlockDecryptFailureReason =
  | 'not-reconstructable' | 'invalid-argument' | 'malformed-ciphertext'
  | 'unsupported-version' | 'authentication-failed' | 'malformed-payload'

export type ElectionBlockDecryptResult =
  | { ok: true; blockId: string; payload: ElectionBlockPayload }
  | { ok: false; blockId: string; reason: ElectionBlockDecryptFailureReason; detail: string }

export interface SeedReleaseKeyTasksResult {
  seeded: Array<{ taskId: string; userId: string; electionId: string; revision: number }>
  alreadySeeded: number
  failures: Array<{ userId: string; electionId: string; detail: string }>
}
