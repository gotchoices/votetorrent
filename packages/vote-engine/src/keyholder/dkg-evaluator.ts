// src/keyholder/dkg-evaluator.ts — the pure, deterministic DKG transcript
// evaluator and action planner (62-17: D-14, D-16, D-19, D-26). No DB, no
// `node:`, no `Buffer`, no `console`. Every node (including a replica that
// only READS rows, 62-24's receiver) runs this SAME function over the SAME
// signed-row snapshot and reaches the SAME verdict — that determinism is the
// whole point: nobody's local clock, local order-of-arrival or local retry
// count may influence a disqualification or an abort.
//
// Imports only from `../crypto/dkg.js`, `./dkg-payloads.js`,
// `@votetorrent/vote-core` types and `@noble/hashes/utils.js`.
//
// ---------------------------------------------------------------------------
// Numbered rules (Task 3's security review cites these by number)
// ---------------------------------------------------------------------------
//
//  1. Rows with `signatureValid` false are dropped into `invalidRows` and
//     never attributed to anyone — a replica can forge a row's CONTENT but
//     not its signature, so an invalid-signature row is simply noise.
//  2. Attempts 1..DKG_MAX_ATTEMPTS are processed in order, carrying
//     `cumulativeDisqualified` forward from earlier attempts.
//     `effectiveLive = liveRoster` minus `cumulativeDisqualified`,
//     intersected with users that have a visible `KeyholderDkgBinding`
//     (D-26) — a live keyholder with no binding cannot receive an encrypted
//     share, so it is never a DKG participant.
//  3. An attempt's roster is the DECLARED union of its senders' own R0
//     `roster` claims, restricted to rows from senders IN `effectiveLive`
//     (rows from any other sender — e.g. a stale prior-attempt loser — are
//     ignored outright, never even reaching the roster-rule check below).
//  4. A round is evaluated only once EVERY `effectiveLive` member has a
//     valid-signature row for it (the "boundary" — so every node computes
//     the same verdict regardless of arrival order). Round 0 faults:
//     payload null, or a declared `threshold` different from the snapshot's
//     (`malformed-round0`). Round 1: identifier, commitment length, the R0
//     commit, and the proof of knowledge (verified against a disposable
//     per-attempt observer package via `verifyRound1Package`, exactly the
//     trick `dkg.ts` itself documents). Round 2: structure
//     (`malformed-round2`). Round 3: complaint verdicts, via
//     `verifyComplaintEvidence` against the dealer's R1 package and the
//     dealer's own R2 entry addressed to the complainant. Round 4: the
//     `ResultKey`/payload must equal `deriveGroupCommitments` over the
//     roster's R1 packages (`round4-mismatch`).
//  5. A fault aborts the attempt with reason `faults` (or
//     `unresolved-complaint` when every round-3 complaint resolved
//     `unresolved` and none disqualified anybody). Faults take precedence
//     over the roster rule below.
//  6. Roster rule (current attempt only — the lowest attempt not yet
//     aborted by its own rows): let `symdiff` be the symmetric difference
//     between the attempt's declared roster union and `effectiveLive`. Empty
//     `symdiff`: no roster issue. Every member of a non-empty `symdiff` has
//     a visible binding: `roster-changed` (abort). Any member of `symdiff`
//     has NO visible binding: `in-progress` with `waitingReason
//     'roster-mismatch'` (replication lag — not an abort). The wait NAMES
//     its cause in `awaitingUserIds`: each unbound id that is traced (a
//     Keyholder row is visible, or it signed a DKG row of its own), else the
//     keyholders whose round-0 roster declared it. Trade-off: a phantom id and
//     a binding that has not replicated yet are indistinguishable in one
//     snapshot, so the evaluator never disqualifies on this evidence. The
//     named declarer is a prompt for the officer remedy (revoke that
//     keyholder), which then yields a clean `roster-changed` abort; an honest
//     declarer stops being named as soon as the binding replicates, so
//     officers should wait before revoking (initial/G2 WR-02).
//  7. Gates (attempt 1 only, before any row is read): a null revision/
//     threshold gives `no-current-revision`; an empty `effectiveLive` gives
//     `no-keyholders`; a failing `assertDkgThreshold` gives
//     `threshold-out-of-range`; `pendingInviteCount > 0` gives
//     `pending-invites`.
//  8. After any abort: `|effectiveLive| < threshold` or `< 2` gives
//     `failed/threshold-unreachable`. Reaching the end of attempt
//     `DKG_MAX_ATTEMPTS` still aborted gives `failed/attempts-exhausted`.
//  9. Phase precedence: a consistent `ElectionKey` gives `complete`; an
//     inconsistent one gives `failed/election-key-mismatch`. Consistent means
//     signature-valid AND the agreed attempt's Y, derived GroupCommitments
//     (element-wise), the revision's threshold, and the agreed roster length
//     all equal the row's (V-2: Y alone let a live keyholder publish junk
//     commitments); a malformed column (`commitmentsWellFormed: false`) is a
//     mismatch. Then `failed`;
//     then `blocked`; then `not-started` (attempt 1, round 0, zero rows);
//     then `restarting` (current attempt > 1 and its round is 0); otherwise
//     `in-progress`.
//
// 10. Round opening time (62-139, user ruling 62-OPEN-ITEMS 8d: a per-round
//     deadline that FLAGS the silent keyholder; officers decide; no automatic
//     action). The evaluator never reads a clock: it returns `roundTiming`,
//     the round's signed timestamp CANDIDATES with their authors, identical on
//     every node for the same rows. `opening` = what says when the round
//     opened (round R > 0: the attempt's round R-1 rows; round 0 of attempt
//     > 1: every previous-attempt row; round 0 of attempt 1: the live
//     members' binding `boundAt`); `answers` = the current round's rows.
//     Only valid-signature rows with a timestamp count. The pure
//     `resolveRoundOpenedAt` (time is a PARAMETER, supplied by the status
//     read) picks one: entries dated beyond `now + maxFutureSkew` are ignored;
//     once any non-awaited keyholder has answered, the result is the EARLIER
//     of the earliest answer and the latest opening candidate (or the earliest
//     answer alone if none survives). The earliest answer is a CAP written by
//     keyholders who are not awaited: the flagged keyholder cannot move the
//     deadline later by future-dating its own rows, one future-dating answerer
//     cannot delay it while another honest answer exists, and the first
//     answer never moves the opening time later (the driver is pull-only, so a
//     round can sit open long before anyone answers). With no answer the
//     latest opening candidate is used. Residual: with no answer yet, a row
//     future-dated beyond the skew can delay the flag by at most one deadline
//     period, ending when anyone answers. SentAt/BoundAt are signer-claimed:
//     they feed ONLY an advisory flag, never a fault, abort or
//     disqualification, and a back-dating or slow-clock answerer can make the
//     flag fire early (T-62-139-02, accepted).
//
// `planDkgAction` priority: `none` when complete/failed/blocked or self is
// not a live, non-disqualified participant; `remove-disqualified` for any
// `cumulativeDisqualified` user still physically present in `liveRoster`;
// `publish` when `readyToPublish` and no `ElectionKey` exists yet;
// `post-round` for the current round when self is still in
// `awaitingUserIds`; otherwise `none`.

import {
  assertDkgThreshold,
  deriveGroupCommitments,
  dkgIdentifierForUser,
  dkgRound1,
  verifyComplaintEvidence,
  verifyRound1Commit,
  verifyRound1Package,
  type DkgContext,
  type DkgRound1Wire,
  type EncryptedShare
} from '../crypto/dkg.js'
import {
  parseRound0Payload,
  parseRound1Payload,
  parseRound2Payload,
  parseRound3Payload,
  parseRound4Payload
} from './dkg-payloads.js'
import {
  DKG_MAX_ATTEMPTS,
  type DkgAbortReason,
  type DkgAttemptSummary,
  type DkgDisqualification,
  type DkgFaultReason,
  type DkgPhase,
  type DkgRound,
  type ElectionKeyRecord
} from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Snapshot and evaluation shapes
// ---------------------------------------------------------------------------

export interface DkgMessageRow {
  attempt: number
  round: DkgRound
  senderUserId: string
  payload: string
  resultKey: string | null
  signatureValid: boolean
  /** The signed `SentAt` as stored (62-139 rule 10); absent in unstamped fixtures. */
  sentAt?: string
}

export interface DkgRevisionSnapshot {
  electionId: string
  revision: number | null
  threshold: number | null
  liveRoster: string[]
  bindings: Record<string, { dkgPublicKey: string, boundAt?: string }>
  pendingInviteCount: number
  messages: DkgMessageRow[]
  /**
   * `commitmentsWellFormed` is false when the row's GroupCommitments column did not parse as an array of valid
   * points (the record then carries `groupCommitments: []`). Rule 9 treats that as a mismatch.
   */
  electionKey: (ElectionKeyRecord & { signatureValid: boolean, commitmentsWellFormed: boolean }) | null
}

export interface DkgReadyToPublish {
  attempt: number
  jointPublicKey: string
  groupCommitments: string[]
  threshold: number
  participants: number
  roster: string[]
}

export interface DkgTimestampCandidate { userId: string, at: string }
export interface DkgRoundTiming { opening: DkgTimestampCandidate[], answers: DkgTimestampCandidate[] }

export interface DkgInvalidRow { attempt: number, round: number, senderUserId: string }

export interface DkgRevisionEvaluation {
  electionId: string
  revision: number | null
  threshold: number | null
  phase: DkgPhase
  blockedReason?: import('@votetorrent/vote-core').DkgBlockedReason
  waitingReason?: import('@votetorrent/vote-core').DkgWaitingReason
  failedReason?: import('@votetorrent/vote-core').DkgFailedReason
  currentAttempt: number | null
  currentRound: DkgRound | null
  roster: string[]
  awaitingUserIds: string[]
  attempts: DkgAttemptSummary[]
  disqualified: DkgDisqualification[]
  electionKey: ElectionKeyRecord | null
  invalidRows: DkgInvalidRow[]
  readyToPublish: DkgReadyToPublish | null
  cumulativeDisqualified: string[]
  /** The raw live `Keyholder` roster (unfiltered by binding or disqualification) — needed by `planDkgAction`'s `remove-disqualified` check. */
  liveRoster: string[]
  /** Rule 10: the current round's signed timestamp candidates; null unless the phase is not-started/in-progress/restarting. */
  roundTiming: DkgRoundTiming | null
}

export type DkgPlannedAction =
  | { kind: 'none' }
  | { kind: 'remove-disqualified', userIds: string[] }
  | { kind: 'post-round', attempt: number, round: DkgRound }
  | { kind: 'publish', attempt: number }

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function sortUnique (values: string[]): string[] {
  return [...new Set(values)].sort()
}

/**
 * Who a `roster-mismatch` wait is waiting on (initial/G2 WR-02). Sorted union
 * of (a) each unbound id that is TRACED (a visible Keyholder row, or any
 * valid-signature row it sent) — we wait for its binding — and (b) the
 * senders whose parsed round-0 roster declares an UNTRACED unbound id, so the
 * officers' revoke remedy has someone to point at. Pure; no clock.
 */
function rosterMismatchAwaiting (
  unboundIds: string[],
  r0Rows: DkgMessageRow[],
  parsedRosters: Record<string, string[]>,
  liveRoster: string[],
  validRows: DkgMessageRow[]
): string[] {
  const out: string[] = []
  for (const id of unboundIds) {
    const traced = liveRoster.includes(id) || validRows.some((r) => r.senderUserId === id)
    if (traced) {
      out.push(id)
      continue
    }
    for (const row of r0Rows) {
      if ((parsedRosters[row.senderUserId] ?? []).includes(id)) out.push(row.senderUserId)
    }
  }
  return sortUnique(out)
}

function byUserThenAt (a: DkgTimestampCandidate, b: DkgTimestampCandidate): number {
  if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1
  return a.at < b.at ? -1 : a.at > b.at ? 1 : 0
}

/** Rule 10: pure candidate collection for the current round (no clock). */
function collectRoundTiming (
  phase: DkgPhase,
  attempt: number | null,
  round: DkgRound | null,
  roster: string[],
  effectiveLive: string[],
  validRows: DkgMessageRow[],
  bindings: Record<string, { dkgPublicKey: string, boundAt?: string }>
): DkgRoundTiming | null {
  if (phase !== 'not-started' && phase !== 'in-progress' && phase !== 'restarting') return null
  if (attempt === null || round === null) return null
  const answerers = (attempt === 1 && round === 0) ? effectiveLive : roster
  const toCandidates = (rows: DkgMessageRow[]): DkgTimestampCandidate[] => rows
    .filter((r) => r.sentAt !== undefined)
    .map((r) => ({ userId: r.senderUserId, at: r.sentAt! }))
    .sort(byUserThenAt)
  const answers = toCandidates(validRows.filter((r) => r.attempt === attempt && r.round === round && answerers.includes(r.senderUserId)))
  let opening: DkgTimestampCandidate[]
  if (round > 0) {
    opening = toCandidates(validRows.filter((r) => r.attempt === attempt && r.round === round - 1 && roster.includes(r.senderUserId)))
  } else if (attempt > 1) {
    opening = toCandidates(validRows.filter((r) => r.attempt === attempt - 1))
  } else {
    opening = effectiveLive
      .filter((u) => bindings[u]?.boundAt !== undefined)
      .map((u) => ({ userId: u, at: bindings[u]!.boundAt! }))
      .sort(byUserThenAt)
  }
  return { opening, answers }
}

/**
 * Rule 10: pick the round's opening time. PURE: time is a parameter. See the header.
 */
export function resolveRoundOpenedAt (
  timing: DkgRoundTiming | null,
  awaitingUserIds: string[],
  nowMs: number,
  maxFutureSkewMs: number
): string | null {
  if (timing === null) return null
  const usable = (c: DkgTimestampCandidate): number | null => {
    const t = Date.parse(c.at)
    return Number.isNaN(t) || t > nowMs + maxFutureSkewMs ? null : t
  }
  let firstAnswer: { t: number, userId: string, at: string } | null = null
  for (const c of timing.answers) {
    if (awaitingUserIds.includes(c.userId)) continue
    const t = usable(c)
    if (t === null) continue
    if (firstAnswer === null || t < firstAnswer.t || (t === firstAnswer.t && c.userId < firstAnswer.userId)) firstAnswer = { t, userId: c.userId, at: c.at }
  }
  let lastOpening: { t: number, userId: string, at: string } | null = null
  for (const c of timing.opening) {
    const t = usable(c)
    if (t === null) continue
    if (lastOpening === null || t > lastOpening.t || (t === lastOpening.t && c.userId < lastOpening.userId)) lastOpening = { t, userId: c.userId, at: c.at }
  }
  if (firstAnswer !== null && lastOpening !== null) return lastOpening.t < firstAnswer.t ? lastOpening.at : firstAnswer.at
  if (firstAnswer !== null) return firstAnswer.at
  if (lastOpening !== null) return lastOpening.at
  return null
}

function symmetricDifference (a: string[], b: string[]): string[] {
  const setA = new Set(a)
  const setB = new Set(b)
  const out: string[] = []
  for (const v of a) if (!setB.has(v)) out.push(v)
  for (const v of b) if (!setA.has(v)) out.push(v)
  return sortUnique(out)
}

function sameStringArray (a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * A disposable per-evaluation observer package — used ONLY as the vehicle
 * `verifyRound1Package` needs to check an arbitrary round-1 package's own
 * internal self-consistency (its Feldman commitment plus its Schnorr proof
 * of knowledge). The observer's own identifier is namespaced with a `:`,
 * which can never collide with a UUID userId's derived identifier (UUIDs
 * never contain `:`), and its own secret is never persisted or reused across
 * evaluations — the verification OUTCOME depends only on the package being
 * checked, never on which observer package did the checking.
 */
function makeObserverSecret (k: number, n: number): ReturnType<typeof dkgRound1>['secret'] {
  return dkgRound1(dkgIdentifierForUser(':dkg-observer'), k, n).secret
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

export function evaluateDkgRevision (snapshot: DkgRevisionSnapshot): DkgRevisionEvaluation {
  const invalidRows: DkgInvalidRow[] = []
  const validRows: DkgMessageRow[] = []
  for (const row of snapshot.messages) {
    if (!row.signatureValid) {
      invalidRows.push({ attempt: row.attempt, round: row.round, senderUserId: row.senderUserId })
      continue
    }
    validRows.push(row)
  }

  const base = {
    electionId: snapshot.electionId,
    revision: snapshot.revision,
    threshold: snapshot.threshold,
    invalidRows,
    liveRoster: snapshot.liveRoster,
    electionKey: snapshot.electionKey === null
      ? null
      : {
          electionId: snapshot.electionKey.electionId,
          revision: snapshot.electionKey.revision,
          attempt: snapshot.electionKey.attempt,
          jointPublicKey: snapshot.electionKey.jointPublicKey,
          groupCommitments: snapshot.electionKey.groupCommitments,
          threshold: snapshot.electionKey.threshold,
          participants: snapshot.electionKey.participants,
          publishedAt: snapshot.electionKey.publishedAt,
          publisherUserId: snapshot.electionKey.publisherUserId
        }
  }

  // Rule 7: gates, attempt 1 only.
  if (snapshot.revision === null || snapshot.threshold === null) {
    return {
      ...base,
      phase: 'blocked', blockedReason: 'no-current-revision',
      currentAttempt: null, currentRound: null, roster: [], awaitingUserIds: [],
      attempts: [], disqualified: [], readyToPublish: null, cumulativeDisqualified: [], roundTiming: null
    }
  }
  const bindingIds = new Set(Object.keys(snapshot.bindings))
  const effectiveLiveAtt1 = snapshot.liveRoster.filter((u) => bindingIds.has(u))
  if (effectiveLiveAtt1.length === 0) {
    return {
      ...base,
      phase: 'blocked', blockedReason: 'no-keyholders',
      currentAttempt: null, currentRound: null, roster: [], awaitingUserIds: [],
      attempts: [], disqualified: [], readyToPublish: null, cumulativeDisqualified: [], roundTiming: null
    }
  }
  try {
    assertDkgThreshold(snapshot.threshold, effectiveLiveAtt1.length)
  } catch {
    return {
      ...base,
      phase: 'blocked', blockedReason: 'threshold-out-of-range',
      currentAttempt: null, currentRound: null, roster: [], awaitingUserIds: [],
      attempts: [], disqualified: [], readyToPublish: null, cumulativeDisqualified: [], roundTiming: null
    }
  }
  if (snapshot.pendingInviteCount > 0) {
    return {
      ...base,
      phase: 'blocked', blockedReason: 'pending-invites',
      currentAttempt: null, currentRound: null, roster: [], awaitingUserIds: [],
      attempts: [], disqualified: [], readyToPublish: null, cumulativeDisqualified: [], roundTiming: null
    }
  }

  const revision = snapshot.revision
  const threshold = snapshot.threshold
  const electionId = snapshot.electionId

  const attempts: DkgAttemptSummary[] = []
  const disqualifiedAll: DkgDisqualification[] = []
  let cumulativeDisqualified: string[] = []
  const attemptAgreedKey: Record<number, { jointPublicKey: string, groupCommitments: string[], roster: string[] }> = {}

  let phase: DkgPhase = 'not-started'
  let blockedReason: import('@votetorrent/vote-core').DkgBlockedReason | undefined
  let waitingReason: import('@votetorrent/vote-core').DkgWaitingReason | undefined
  let failedReason: import('@votetorrent/vote-core').DkgFailedReason | undefined
  let currentAttempt: number | null = null
  let currentRound: DkgRound | null = null
  let roster: string[] = []
  let awaitingUserIds: string[] = []
  let readyToPublish: DkgReadyToPublish | null = null
  let currentEffectiveLive: string[] = []

  attemptLoop:
  for (let attempt = 1; attempt <= DKG_MAX_ATTEMPTS; attempt++) {
    const effectiveLive = sortUnique(snapshot.liveRoster.filter((u) => bindingIds.has(u) && !cumulativeDisqualified.includes(u)))
    currentEffectiveLive = effectiveLive

    if (attempt > 1 && (effectiveLive.length < 2 || effectiveLive.length < threshold)) {
      phase = 'failed'
      failedReason = 'threshold-unreachable'
      currentAttempt = null
      currentRound = null
      roster = []
      awaitingUserIds = []
      break attemptLoop
    }

    const ctx: DkgContext = { electionId, revision, attempt }
    const attemptRows = validRows.filter((r) => r.attempt === attempt)
    const r0Rows = attemptRows.filter((r) => r.round === 0 && effectiveLive.includes(r.senderUserId))

    if (r0Rows.length === 0) {
      currentAttempt = attempt
      currentRound = 0
      roster = effectiveLive
      awaitingUserIds = effectiveLive
      phase = attempt === 1 ? 'not-started' : 'restarting'
      break attemptLoop
    }

    if (r0Rows.length < effectiveLive.length) {
      // Round 0 boundary not yet reached — still collecting.
      currentAttempt = attempt
      currentRound = 0
      roster = effectiveLive
      awaitingUserIds = sortUnique(effectiveLive.filter((u) => !r0Rows.some((r) => r.senderUserId === u)))
      phase = (attempt === 1 && r0Rows.length === 0) ? 'not-started' : (attempt > 1 ? 'restarting' : 'in-progress')
      break attemptLoop
    }

    // Round 0 boundary reached: parse every row, collect faults.
    const r0Parsed: Record<string, ReturnType<typeof parseRound0Payload>> = {}
    const r0Faults: DkgDisqualification[] = []
    for (const row of r0Rows) {
      const parsed = parseRound0Payload(row.payload)
      r0Parsed[row.senderUserId] = parsed
      if (parsed === null || parsed.threshold !== threshold) {
        r0Faults.push({ attempt, userId: row.senderUserId, reason: 'malformed-round0' })
      }
    }

    if (r0Faults.length > 0) {
      const newlyDisqualified = sortUnique(r0Faults.map((f) => f.userId))
      cumulativeDisqualified = sortUnique([...cumulativeDisqualified, ...newlyDisqualified])
      disqualifiedAll.push(...r0Faults)
      attempts.push({ attempt, roster: effectiveLive, outcome: 'aborted', round: 0, abortReason: 'faults', disqualified: r0Faults, unresolvedComplaints: 0 })
      if (attempt === DKG_MAX_ATTEMPTS) {
        phase = 'failed'
        failedReason = 'attempts-exhausted'
        currentAttempt = null
        currentRound = null
        roster = []
        awaitingUserIds = []
        break attemptLoop
      }
      continue
    }

    // `attemptRoster` (= the declared union from round 0) is THE roster for
    // rounds 1-4, NOT `effectiveLive`. Rule 5 ("faults take precedence over
    // the roster rule") means a genuine protocol fault — discoverable only
    // by evaluating rounds 1-4 — must get its chance to explain an attempt's
    // outcome before a roster mismatch is ever reported. This also makes
    // re-evaluation stable after a disqualified dealer's OWN later removal:
    // `effectiveLive` for attempt 1 (recomputed from the CURRENT, post-
    // removal `liveRoster`) would otherwise retroactively "lose" a dealer
    // who legitimately posted every row of the very attempt that got them
    // disqualified — the schema's `SenderIsBoundKeyholder` CHECK already
    // proved every sender was live and bound AT SEND TIME, so trusting
    // `attemptRoster` for the rest of this attempt is sound. The symmetric
    // difference against `effectiveLive` is still checked — just only once
    // rounds 1-4 fail to produce a fault-based explanation (an attempt
    // that stalls waiting for a since-revoked member, or one that reaches
    // round 4 cleanly but a current-roster member was never declared).
    const declaredRosterUnion = sortUnique(r0Rows.flatMap((row) => r0Parsed[row.senderUserId]!.roster))
    const attemptRoster = declaredRosterUnion
    const n = attemptRoster.length

    // Rebuild the R0-commit lookup from EVERY valid round-0 row for this
    // attempt whose sender is in `attemptRoster` — NOT from `r0Rows` (which
    // is `effectiveLive`-gated, and `effectiveLive` can shrink mid
    // re-evaluation once this very attempt's own `remove-disqualified`
    // action has run, e.g. while an `advanceDkg` call's internal loop is
    // still mid-flight). Without this, a legitimately-disqualified sender's
    // OWN round-0 row would drop out of the lookup on the NEXT evaluation,
    // making `verifyRound1Commit` throw on a `undefined` commit hex and
    // misreport every OTHER sender's real fault as a spurious
    // `commit-mismatch` on whoever the lookup gap landed on.
    const r0CommitBySender: Record<string, string> = {}
    for (const row of validRows) {
      if (row.attempt !== attempt || row.round !== 0 || !attemptRoster.includes(row.senderUserId)) continue
      const parsed = parseRound0Payload(row.payload)
      if (parsed !== null) r0CommitBySender[row.senderUserId] = parsed.commit
    }

    const rosterFallback = (): 'none' | 'waiting' | 'roster-changed' => {
      const symdiff = symmetricDifference(attemptRoster, effectiveLive)
      if (symdiff.length === 0) return 'none'
      return symdiff.every((u) => bindingIds.has(u)) ? 'roster-changed' : 'waiting'
    }

    /** Pushes an aborted-attempt summary, applies the cap, and returns `true` if the caller should `break` (cap reached) or `false` to `continue` to the next attempt. */
    const recordAbort = (round: DkgRound, abortReason: DkgAbortReason, disqualified: DkgDisqualification[], unresolvedComplaints = 0): boolean => {
      if (disqualified.length > 0) {
        const newlyDisqualified = sortUnique(disqualified.map((f) => f.userId))
        cumulativeDisqualified = sortUnique([...cumulativeDisqualified, ...newlyDisqualified])
        disqualifiedAll.push(...disqualified)
      }
      attempts.push({ attempt, roster: attemptRoster, outcome: 'aborted', round, abortReason, disqualified, unresolvedComplaints })
      if (attempt === DKG_MAX_ATTEMPTS) {
        phase = 'failed'
        failedReason = 'attempts-exhausted'
        currentAttempt = null
        currentRound = null
        roster = []
        awaitingUserIds = []
        return true
      }
      return false
    }

    /** For a stalled round whose fallback is 'none' or 'waiting' (NOT 'roster-changed' — the caller checks that separately, since it needs `continue` rather than `break`). Sets the collecting/waiting status fields for the caller's immediate `break`. */
    const reportCollecting = (round: DkgRound, posted: DkgMessageRow[], fb: 'none' | 'waiting'): void => {
      currentAttempt = attempt
      currentRound = round
      roster = attemptRoster
      if (fb === 'waiting') {
        const unbound = symmetricDifference(attemptRoster, effectiveLive).filter((u) => !bindingIds.has(u))
        const parsedRosters: Record<string, string[]> = {}
        for (const row of r0Rows) parsedRosters[row.senderUserId] = r0Parsed[row.senderUserId]!.roster
        awaitingUserIds = rosterMismatchAwaiting(unbound, r0Rows, parsedRosters, snapshot.liveRoster, validRows)
        waitingReason = 'roster-mismatch'
      } else {
        awaitingUserIds = sortUnique(attemptRoster.filter((u) => !posted.some((r) => r.senderUserId === u)))
      }
      phase = 'in-progress'
    }

    // --------------------------- Round 1 ---------------------------
    const r1Rows = attemptRows.filter((r) => r.round === 1 && attemptRoster.includes(r.senderUserId))
    if (r1Rows.length < attemptRoster.length) {
      const fb = rosterFallback()
      if (fb === 'roster-changed') {
        if (recordAbort(1, 'roster-changed', [])) break attemptLoop
        continue attemptLoop
      }
      reportCollecting(1, r1Rows, fb)
      break attemptLoop
    }

    const observerSecret = makeObserverSecret(threshold, n)
    const r1Parsed: Record<string, DkgRound1Wire> = {}
    const r1Faults: DkgDisqualification[] = []
    for (const row of r1Rows) {
      const parsed = parseRound1Payload(row.payload)
      let faultReason: DkgFaultReason | null = null
      if (parsed === null) {
        faultReason = 'invalid-round1'
      } else if (parsed.identifier !== dkgIdentifierForUser(row.senderUserId)) {
        faultReason = 'invalid-round1'
      } else if (parsed.commitment.length !== threshold) {
        faultReason = 'invalid-round1'
      } else if (!verifyRound1Commit(ctx, parsed, r0CommitBySender[row.senderUserId]!)) {
        faultReason = 'commit-mismatch'
      } else if (!verifyRound1Package(observerSecret, parsed)) {
        faultReason = 'invalid-round1'
      }
      if (faultReason !== null) {
        r1Faults.push({ attempt, userId: row.senderUserId, reason: faultReason })
      } else {
        r1Parsed[row.senderUserId] = parsed!
      }
    }

    if (r1Faults.length > 0) {
      if (recordAbort(1, 'faults', r1Faults)) break attemptLoop
      continue
    }

    // --------------------------- Round 2 ---------------------------
    const r2Rows = attemptRows.filter((r) => r.round === 2 && attemptRoster.includes(r.senderUserId))
    if (r2Rows.length < attemptRoster.length) {
      const fb = rosterFallback()
      if (fb === 'roster-changed') {
        if (recordAbort(2, 'roster-changed', [])) break attemptLoop
        continue attemptLoop
      }
      reportCollecting(2, r2Rows, fb)
      break attemptLoop
    }

    const r2Parsed: Record<string, EncryptedShare[]> = {}
    const r2Faults: DkgDisqualification[] = []
    for (const row of r2Rows) {
      const parsed = parseRound2Payload(row.payload)
      const expectedDealer = dkgIdentifierForUser(row.senderUserId)
      const expectedRecipients = sortUnique(attemptRoster.filter((u) => u !== row.senderUserId).map((u) => dkgIdentifierForUser(u)))
      let ok = parsed !== null && parsed.length === expectedRecipients.length
      if (ok && parsed !== null) {
        if (parsed[0]!.dealer !== expectedDealer) ok = false
        const recipients = sortUnique(parsed.map((e) => e.recipient))
        if (!sameStringArray(recipients, expectedRecipients)) ok = false
      }
      if (!ok) {
        r2Faults.push({ attempt, userId: row.senderUserId, reason: 'malformed-round2' })
      } else {
        r2Parsed[row.senderUserId] = parsed!
      }
    }

    if (r2Faults.length > 0) {
      if (recordAbort(2, 'faults', r2Faults)) break attemptLoop
      continue
    }

    // --------------------------- Round 3 ---------------------------
    const r3Rows = attemptRows.filter((r) => r.round === 3 && attemptRoster.includes(r.senderUserId))
    if (r3Rows.length < attemptRoster.length) {
      const fb = rosterFallback()
      if (fb === 'roster-changed') {
        if (recordAbort(3, 'roster-changed', [])) break attemptLoop
        continue attemptLoop
      }
      reportCollecting(3, r3Rows, fb)
      break attemptLoop
    }

    const r3Disqualified: DkgDisqualification[] = []
    let unresolvedCount = 0
    for (const row of r3Rows) {
      const parsed = parseRound3Payload(row.payload)
      if (parsed === null || parsed.kind === 'ack') continue
      for (const evidence of parsed.evidence) {
        const complainant = row.senderUserId
        const complainantIdentifier = dkgIdentifierForUser(complainant)
        if (evidence.recipient !== complainantIdentifier) {
          r3Disqualified.push({ attempt, userId: complainant, reason: 'malformed-complaint' })
          continue
        }
        const dealerUserId = Object.keys(r1Parsed).find((u) => dkgIdentifierForUser(u) === evidence.dealer)
        const dealerR1 = dealerUserId !== undefined ? r1Parsed[dealerUserId] : undefined
        const dealerR2 = dealerUserId !== undefined ? r2Parsed[dealerUserId] : undefined
        const encEntry = dealerR2?.find((e) => e.recipient === complainantIdentifier)
        if (dealerUserId === undefined || dealerR1 === undefined || encEntry === undefined) {
          r3Disqualified.push({ attempt, userId: complainant, reason: 'malformed-complaint' })
          continue
        }
        const verdict = verifyComplaintEvidence(ctx, threshold, n, encEntry, dealerR1, evidence)
        if (verdict.verdict === 'dealer-fault') {
          r3Disqualified.push({
            attempt, userId: dealerUserId,
            reason: verdict.reason === 'undecryptable' ? 'undecryptable-share' : 'invalid-share',
            complainantUserId: complainant
          })
        } else if (verdict.verdict === 'complainant-fault') {
          r3Disqualified.push({
            attempt, userId: complainant,
            reason: verdict.reason === 'malformed-evidence' ? 'malformed-complaint' : 'false-complaint'
          })
        } else {
          unresolvedCount++
        }
      }
    }

    if (r3Disqualified.length > 0 || unresolvedCount > 0) {
      const abortReason: DkgAbortReason = r3Disqualified.length > 0 ? 'faults' : 'unresolved-complaint'
      if (recordAbort(3, abortReason, r3Disqualified, unresolvedCount)) break attemptLoop
      continue
    }

    // --------------------------- Round 4 ---------------------------
    const r4Rows = attemptRows.filter((r) => r.round === 4 && attemptRoster.includes(r.senderUserId))
    if (r4Rows.length < attemptRoster.length) {
      const fb = rosterFallback()
      if (fb === 'roster-changed') {
        if (recordAbort(4, 'roster-changed', [])) break attemptLoop
        continue attemptLoop
      }
      reportCollecting(4, r4Rows, fb)
      break attemptLoop
    }

    const orderedR1 = attemptRoster.map((u) => r1Parsed[u]!)
    const derived = deriveGroupCommitments(orderedR1)
    const derivedY = derived[0]!

    const r4Faults: DkgDisqualification[] = []
    for (const row of r4Rows) {
      const parsed = parseRound4Payload(row.payload)
      const ok = parsed !== null && row.resultKey === derivedY && parsed.groupPublicKey === derivedY && sameStringArray(parsed.groupCommitments, derived)
      if (!ok) r4Faults.push({ attempt, userId: row.senderUserId, reason: 'round4-mismatch' })
    }

    if (r4Faults.length > 0) {
      if (recordAbort(4, 'faults', r4Faults)) break attemptLoop
      continue
    }

    // Every round-4 row is clean. Apply the roster fallback ONE more time —
    // an attempt that reaches here with a current-roster mismatch (e.g. a
    // same-attempt officer revoke that happened to land after round 4 was
    // already fully posted) is reported as roster-changed/waiting rather
    // than silently agreeing on a roster the CURRENT Keyholder table no
    // longer reflects.
    const finalFallback = rosterFallback()
    if (finalFallback === 'roster-changed') {
      if (recordAbort(4, 'roster-changed', [])) break attemptLoop
      continue
    }
    if (finalFallback === 'waiting') {
      currentAttempt = attempt
      currentRound = 4
      roster = attemptRoster
      awaitingUserIds = []
      phase = 'in-progress'
      waitingReason = 'roster-mismatch'
      break attemptLoop
    }

    // Agreed.
    attempts.push({ attempt, roster: attemptRoster, outcome: 'agreed', round: 4, disqualified: [], unresolvedComplaints: 0 })
    attemptAgreedKey[attempt] = { jointPublicKey: derivedY, groupCommitments: derived, roster: attemptRoster }
    currentAttempt = attempt
    currentRound = 4
    roster = attemptRoster
    awaitingUserIds = []
    phase = 'in-progress'
    readyToPublish = { attempt, jointPublicKey: derivedY, groupCommitments: derived, threshold, participants: attemptRoster.length, roster: attemptRoster }
    break attemptLoop
  }

  // Rule 9: ElectionKey consistency takes final precedence.
  let electionKeyConsistent: boolean | null = null
  if (snapshot.electionKey !== null) {
    const agreed = attemptAgreedKey[snapshot.electionKey.attempt]
    const ek = snapshot.electionKey
    electionKeyConsistent = ek.signatureValid && agreed !== undefined && agreed.jointPublicKey === ek.jointPublicKey &&
      ek.commitmentsWellFormed && sameStringArray(agreed.groupCommitments, ek.groupCommitments) &&
      ek.threshold === snapshot.threshold && ek.participants === agreed.roster.length
    if (electionKeyConsistent) {
      phase = 'complete'
      failedReason = undefined
      blockedReason = undefined
      waitingReason = undefined
    } else {
      phase = 'failed'
      failedReason = 'election-key-mismatch'
    }
  }

  return {
    ...base,
    phase,
    blockedReason,
    waitingReason,
    failedReason,
    currentAttempt,
    currentRound,
    roster,
    awaitingUserIds,
    attempts,
    disqualified: disqualifiedAll,
    readyToPublish,
    cumulativeDisqualified,
    roundTiming: collectRoundTiming(phase, currentAttempt, currentRound, roster, currentEffectiveLive, validRows, snapshot.bindings)
  }
}

export function planDkgAction (evaluation: DkgRevisionEvaluation, selfUserId: string): DkgPlannedAction {
  if (evaluation.phase === 'complete' || evaluation.phase === 'failed' || evaluation.phase === 'blocked') {
    return { kind: 'none' }
  }
  const isParticipant = evaluation.roster.includes(selfUserId)
  const isDisqualified = evaluation.cumulativeDisqualified.includes(selfUserId)
  if (!isParticipant || isDisqualified) {
    return { kind: 'none' }
  }
  const stillPresent = evaluation.cumulativeDisqualified.filter((u) => evaluation.liveRoster.includes(u))
  if (stillPresent.length > 0) {
    return { kind: 'remove-disqualified', userIds: stillPresent }
  }
  if (evaluation.readyToPublish !== null && evaluation.electionKey === null) {
    return { kind: 'publish', attempt: evaluation.readyToPublish.attempt }
  }
  if (evaluation.currentAttempt !== null && evaluation.currentRound !== null && evaluation.awaitingUserIds.includes(selfUserId)) {
    return { kind: 'post-round', attempt: evaluation.currentAttempt, round: evaluation.currentRound }
  }
  return { kind: 'none' }
}
