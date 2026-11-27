// src/key-release/key-release-evaluator.ts — the pure, deterministic D-14/
// D-17 release evaluator (62-20). No DB, no `node:`, no `Buffer`, no
// `console`. Deep-path only — never barrel-exported (`index.ts` stays at
// `hasEnteredReleasingKeys`/`releasingKeysAt`/the block-payload functions;
// this evaluator is internal to `key-release-engine.ts`).
//
// Imports only from `../crypto/dkg.js`, `./release-window.js` and
// `@votetorrent/vote-core` types. Every node (including a replica that only
// READS rows, 62-24's receiver) runs this SAME function over the SAME
// signed-row snapshot and reaches the SAME verdict.
//
// ---------------------------------------------------------------------------
// Numbered rules (Task 3's security review cites these by number)
// ---------------------------------------------------------------------------
//
//  1. A row with `signatureValid` false is `signature-invalid`.
//  2. A user outside `r4ParticipantUserIds` is `not-a-participant`.
//  3. `identifier !== dkgIdentifierForUser(userId)` is `identifier-mismatch`.
//  4. `validateReleasedShare(k, n, groupCommitments, { identifier,
//     signingShare })` false is `share-invalid`.
//  5. Rules 1-4 apply IN ORDER; only the first failing reason per row is
//     recorded (a row that fails both the signature AND the share check is
//     `signature-invalid`, never `share-invalid`).
//  6. At most one row per userId reaches the evaluator in production (the
//     schema's primary key enforces this). If the snapshot nonetheless
//     carries duplicates for one userId, the row with the
//     lexicographically smallest `releasedAt` wins and NO rejection entry
//     is recorded for the dropped duplicate(s) — this is a defensive
//     dedup, not a new rejection reason.
//  7. `k = electionKey.threshold` and `n = electionKey.participants` are
//     used ONLY after the consistency checks below pass — never the
//     snapshot's raw roster size.
//  8. Phase precedence: `no-current-revision`, then `no-election-key`, then
//     `election-key-inconsistent`, then `reconstructable` (releasedCount
//     `>=` k — public shares are public whatever the clock says, so this
//     overrides the window check), then `before-release-window`, then
//     `releasing`.
//
// All list-valued fields (`awaitingUserIds`, `rejectedReleases`,
// `acceptedReleases`/`releasedUserIds`) are sorted by `userId`, and the
// whole function is order-independent in `snapshot.releases` — shuffling
// that array never changes the result (rule 6's dedup and the final sort
// both key on `userId`/`releasedAt`, never on array position).

import { dkgIdentifierForUser, validateReleasedShare } from '../crypto/dkg.js'
import { hasEnteredReleasingKeys, releasingKeysAt } from './release-window.js'
import type {
  ElectionKeyRecord,
  KeyReleasePhase,
  KeyReleaseRejection,
  KeyReleaseStatus,
  KeyShareReleaseRecord
} from '@votetorrent/vote-core'

export interface KeyReleaseRow {
  userId: string
  identifier: string
  signingShare: string
  releasedAt: string
  signerKey: string
  signatureValid: boolean
}

export interface KeyReleaseSnapshot {
  electionId: string
  revision: number | null
  isCurrentRevision: boolean
  keyholderThreshold: number | null
  timeline: unknown
  now: number
  electionKey: (ElectionKeyRecord & { signatureValid: boolean }) | null
  /** Live Keyholder rows whose R4 for `electionKey.attempt` carries `ResultKey = electionKey.jointPublicKey`. */
  r4ParticipantUserIds: string[]
  /**
   * The group commitments DERIVED FROM THE TRANSCRIPT (the attempt's signature-valid round-1 packages of the
   * round-4 participants), or `null` when they cannot be derived (a gap, an unparseable package, a derive error).
   * Key release validates every share against THIS, never against the published ElectionKey commitments column: the published
   * column is advisory (any live keyholder writes it once, the DKG status reports a mismatch), and D-17
   * reconstruction depends only on the transcript.
   */
  transcriptCommitments: string[] | null
  releases: KeyReleaseRow[]
}

export interface KeyReleaseEvaluation {
  status: Omit<KeyReleaseStatus, 'self'>
  acceptedReleases: KeyShareReleaseRecord[]
}

function byUserIdAsc<T extends { userId: string }> (a: T, b: T): number {
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0
}

export function evaluateKeyRelease (snapshot: KeyReleaseSnapshot): KeyReleaseEvaluation {
  const { electionId, revision, isCurrentRevision, keyholderThreshold, timeline, now, electionKey, r4ParticipantUserIds, transcriptCommitments, releases } = snapshot

  const base = {
    electionId,
    revision,
    releasingKeysAt: releasingKeysAt(timeline),
    hasEnteredReleasingKeys: hasEnteredReleasingKeys(timeline, now)
  }
  const empty = {
    threshold: null as number | null,
    participants: null as number | null,
    releasedCount: 0,
    releasedUserIds: [] as string[],
    awaitingUserIds: [] as string[],
    rejectedReleases: [] as KeyReleaseRejection[]
  }

  // Rule 8, gate 1: no current revision.
  if (revision === null) {
    return { status: { ...base, ...empty, phase: 'no-current-revision', electionKey: null }, acceptedReleases: [] }
  }

  // Rule 8, gate 2: no election key, or one whose signature does not verify.
  if (electionKey === null || !electionKey.signatureValid) {
    return { status: { ...base, ...empty, phase: 'no-election-key', electionKey: null }, acceptedReleases: [] }
  }

  // electionKey is non-null and signature-valid from here on; strip the
  // evaluator-only `signatureValid` field before it ever reaches the status.
  const { signatureValid: _signatureValid, ...electionKeyClean } = electionKey

  // Rule 8, gate 3: consistency. The threshold check is skipped for a
  // non-current revision (rule 7's note) — participants and commitments
  // still apply regardless.
  const thresholdMatches = !isCurrentRevision || electionKey.threshold === keyholderThreshold
  const participantsMatch = electionKey.participants === r4ParticipantUserIds.length
  const commitmentsMatch = transcriptCommitments !== null && transcriptCommitments[0] === electionKey.jointPublicKey
  if (!thresholdMatches || !participantsMatch || !commitmentsMatch || transcriptCommitments === null) {
    return { status: { ...base, ...empty, phase: 'election-key-inconsistent', electionKey: electionKeyClean }, acceptedReleases: [] }
  }

  const k = electionKey.threshold
  const n = electionKey.participants

  // Rule 6: dedup to at most one row per userId (smallest releasedAt wins).
  const byUser = new Map<string, KeyReleaseRow>()
  for (const row of releases) {
    const existing = byUser.get(row.userId)
    if (existing === undefined || row.releasedAt < existing.releasedAt) {
      byUser.set(row.userId, row)
    }
  }
  const dedupedRows = Array.from(byUser.values()).sort(byUserIdAsc)

  // Rules 1-5: filter and classify, first failing reason wins.
  const accepted: KeyShareReleaseRecord[] = []
  const rejected: KeyReleaseRejection[] = []
  for (const row of dedupedRows) {
    if (!row.signatureValid) {
      rejected.push({ userId: row.userId, reason: 'signature-invalid' })
      continue
    }
    if (!r4ParticipantUserIds.includes(row.userId)) {
      rejected.push({ userId: row.userId, reason: 'not-a-participant' })
      continue
    }
    if (row.identifier !== dkgIdentifierForUser(row.userId)) {
      rejected.push({ userId: row.userId, reason: 'identifier-mismatch' })
      continue
    }
    if (!validateReleasedShare(k, n, transcriptCommitments, { identifier: row.identifier, signingShare: row.signingShare })) {
      rejected.push({ userId: row.userId, reason: 'share-invalid' })
      continue
    }
    accepted.push({
      electionId,
      revision,
      userId: row.userId,
      identifier: row.identifier,
      signingShare: row.signingShare,
      releasedAt: row.releasedAt,
      signerKey: row.signerKey
    })
  }
  accepted.sort(byUserIdAsc)
  rejected.sort(byUserIdAsc)

  const releasedUserIds = accepted.map((r) => r.userId)
  const releasedCount = releasedUserIds.length
  const awaitingUserIds = r4ParticipantUserIds.filter((u) => !releasedUserIds.includes(u)).sort()

  // Rule 8, gates 4-6: reconstructable overrides the window check.
  let phase: KeyReleasePhase
  if (releasedCount >= k) {
    phase = 'reconstructable'
  } else if (!base.hasEnteredReleasingKeys) {
    phase = 'before-release-window'
  } else {
    phase = 'releasing'
  }

  return {
    status: {
      ...base,
      phase,
      threshold: k,
      participants: n,
      releasedCount,
      releasedUserIds,
      awaitingUserIds,
      rejectedReleases: rejected,
      electionKey: electionKeyClean
    },
    acceptedReleases: accepted
  }
}
