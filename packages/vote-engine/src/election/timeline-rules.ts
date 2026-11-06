/**
 * timeline-rules.ts -- the engine-side check that an election timeline is one
 * the Voter will accept (todo 2026-10-29-engine-timeline-validation).
 *
 * The schema stores `ElectionRevision.Timeline` / `ProposedElectionRevision.Timeline`
 * as unchecked JSON (`-- TODO: constrain Timeline` in votetorrent.qsql). A schema
 * constraint has to wait for the next schema version: changing CHECK text on an
 * existing table stops existing networks from opening (Optimystic#36). Until then
 * the engine refuses, on every write path, a timeline the Voter's `deriveTimeline`
 * would treat as blocking: the Voter shows "election unavailable" for it and
 * refuses to cast a vote. On 2026-10-29 such a timeline cost a two-hour phone run
 * at its last step.
 *
 * WHY A SECOND COPY OF THE RULES. The Voter and the public page read the rules
 * from `@votetorrent/ui-web/lifecycle-core` (packages/ui-web/src/lifecycle/
 * timeline-core.js). vote-engine cannot import ui-web: ui-web already depends on
 * vote-engine, so the import would be a workspace cycle. Moving timeline-core.js
 * into a zero-dependency package (the todo's option B) touches the Voter's Metro
 * bundle-provenance proof, which can only be re-proven on a phone. So the rules
 * are restated here, and `packages/ui-web/test/timeline-rules-parity.test.mjs`
 * runs both implementations over the same generated timelines and fails on any
 * disagreement. If you change one, change the other in the same commit.
 *
 * Mirrors, with the same names and semantics:
 *   ELECTION_EVENT_ORDER, STRICT_CHAIN, PREPARATION, normalizeInstant,
 *   parseTimeline's five conflict rules, and the Voter's blocking set
 *   (`INDETERMINATE_CONFLICT_CODES` in apps/VoteTorrentVoter/src/timeline/
 *   derive-timeline.ts). `MISSING_EVENT` is reported but is not blocking: the
 *   Voter degrades a missing event per row, never the whole election.
 */

import type { BuilderError } from '@votetorrent/vote-core'

/** The ten timeline events, in schema order. Same list as timeline-core.js `ELECTION_EVENT_ORDER`. */
export const TIMELINE_EVENT_ORDER: readonly string[] = Object.freeze([
  'registrationEnds',
  'ballotsFinal',
  'votingStarts',
  'accruingVotes',
  'hashingVotes',
  'releasingKeys',
  'tallyingStarts',
  'validation',
  'certificationStarts',
  'closed'
])

/** Post-voting events that must not go backwards. Same list as timeline-core.js `STRICT_CHAIN`. */
export const TIMELINE_STRICT_CHAIN: readonly string[] = Object.freeze([
  'votingStarts',
  'accruingVotes',
  'hashingVotes',
  'releasingKeys',
  'tallyingStarts',
  'validation',
  'certificationStarts',
  'closed'
])

/** Preparation events: each must be at or before votingStarts, in either order. Same as `PREPARATION`. */
export const TIMELINE_PREPARATION: readonly string[] = Object.freeze(['registrationEnds', 'ballotsFinal'])

export type TimelineConflictCode =
  | 'MISSING_EVENT'
  | 'UNPARSEABLE'
  | 'OUT_OF_ORDER'
  | 'BALLOTS_FINAL_AFTER_DEADLINE'
  | 'EVENT_AFTER_ELECTION_DATE'
  | 'CLOSED_BEFORE_ELECTION_DATE'

/** The conflicts the Voter treats as blocking (derive-timeline.ts `INDETERMINATE_CONFLICT_CODES`). */
export const BLOCKING_TIMELINE_CONFLICT_CODES: ReadonlySet<TimelineConflictCode> = new Set<TimelineConflictCode>([
  'UNPARSEABLE',
  'OUT_OF_ORDER',
  'BALLOTS_FINAL_AFTER_DEADLINE',
  'EVENT_AFTER_ELECTION_DATE',
  'CLOSED_BEFORE_ELECTION_DATE'
])

export interface TimelineConflict {
  code: TimelineConflictCode
  /** The timeline event the conflict is about. */
  event: string
  /** Machine diagnostic with raw values. Never user-facing copy. */
  detail: string
}

/** The schema-enforced election dates the timeline is cross-checked against. Either may be absent. */
export interface TimelineCrossCheck {
  date?: unknown
  ballotDeadline?: unknown
}

const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
const DAY_MS = 86_400_000

/** One raw timeline value to epoch ms, or null. Same as timeline-core.js `normalizeInstant` (canonical form is UTC). */
export function normalizeTimelineInstant (raw: unknown): number | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const ms = CANONICAL_RE.test(trimmed) ? Date.parse(trimmed + 'Z') : Date.parse(trimmed)
  return Number.isFinite(ms) ? ms : null
}

function iso (ms: number | null | undefined): string {
  return ms === null || ms === undefined ? '(none)' : new Date(ms).toISOString().slice(0, 19) + 'Z'
}

function startOfUtcDay (ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/**
 * Every conflict in `timeline`, blocking or not, in the same order timeline-core.js
 * `parseTimeline` reports them. Never throws. Accepts an object or a JSON string.
 */
export function findTimelineConflicts (timeline: unknown, election: TimelineCrossCheck = {}): TimelineConflict[] {
  const conflicts: TimelineConflict[] = []
  const at: Record<string, number | null> = {}

  let blob: Record<string, unknown>
  if (typeof timeline === 'string') {
    try {
      const parsed: unknown = JSON.parse(timeline)
      blob = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    } catch {
      blob = {}
    }
  } else {
    blob = timeline !== null && typeof timeline === 'object' ? timeline as Record<string, unknown> : {}
  }

  for (const event of TIMELINE_EVENT_ORDER) {
    const raw = blob[event]
    const ms = normalizeTimelineInstant(raw)
    at[event] = ms
    if (ms === null) {
      const missing = raw === undefined || raw === null
      conflicts.push({
        code: missing ? 'MISSING_EVENT' : 'UNPARSEABLE',
        event,
        detail: missing ? `${event} is absent from Timeline` : `${event} = ${JSON.stringify(raw)} is not a usable instant`
      })
    }
  }

  let prevEvent: string | null = null
  for (const event of TIMELINE_STRICT_CHAIN) {
    const eventMs = at[event] ?? null
    if (eventMs === null) continue
    const prevMs: number | null = prevEvent !== null ? at[prevEvent] ?? null : null
    if (prevEvent !== null && prevMs !== null && eventMs < prevMs) {
      conflicts.push({ code: 'OUT_OF_ORDER', event, detail: `${event} (${iso(eventMs)}) precedes ${prevEvent} (${iso(prevMs)})` })
    }
    prevEvent = event
  }
  const votingStarts = at.votingStarts ?? null
  for (const event of TIMELINE_PREPARATION) {
    const eventMs = at[event] ?? null
    if (eventMs === null || votingStarts === null) continue
    if (eventMs > votingStarts) {
      conflicts.push({ code: 'OUT_OF_ORDER', event, detail: `${event} (${iso(eventMs)}) falls after votingStarts (${iso(votingStarts)})` })
    }
  }

  const ballotDeadline = normalizeTimelineInstant(election.ballotDeadline)
  const electionDate = normalizeTimelineInstant(election.date)
  const ballotsFinal = at.ballotsFinal ?? null

  if (ballotDeadline !== null && ballotsFinal !== null && ballotsFinal > ballotDeadline) {
    conflicts.push({
      code: 'BALLOTS_FINAL_AFTER_DEADLINE',
      event: 'ballotsFinal',
      detail: `ballotsFinal (${iso(ballotsFinal)}) falls after Election.BallotDeadline (${iso(ballotDeadline)})`
    })
  }

  if (electionDate !== null) {
    // Election.Date is a day (authorities set midnight): conflict only past the end of that day.
    const dayEnd = startOfUtcDay(electionDate) + DAY_MS
    for (const event of ['registrationEnds', 'ballotsFinal', 'votingStarts']) {
      const eventMs = at[event] ?? null
      if (eventMs !== null && eventMs >= dayEnd) {
        conflicts.push({
          code: 'EVENT_AFTER_ELECTION_DATE',
          event,
          detail: `${event} (${iso(eventMs)}) falls after the end of election day (Election.Date ${iso(electionDate)})`
        })
      }
    }
    const closed = at.closed ?? null
    if (closed !== null && closed < electionDate) {
      conflicts.push({ code: 'CLOSED_BEFORE_ELECTION_DATE', event: 'closed', detail: `closed (${iso(closed)}) precedes Election.Date (${iso(electionDate)})` })
    }
  }

  return conflicts
}

/** Only the conflicts that would make the Voter refuse the election. */
export function findBlockingTimelineConflicts (timeline: unknown, election: TimelineCrossCheck = {}): TimelineConflict[] {
  return findTimelineConflicts(timeline, election).filter(c => BLOCKING_TIMELINE_CONFLICT_CODES.has(c.code))
}

/** Thrown, before any write, when a timeline would make the Voter refuse the election. `code` is `'timeline-invalid'`. */
export class TimelineInvalidError extends Error {
  readonly code = 'timeline-invalid' as const
  constructor (readonly method: string, readonly conflicts: readonly TimelineConflict[]) {
    super(
      `${method}: the election timeline would make voters' apps refuse this election: ` +
      conflicts.map(c => `${c.code}(${c.event})`).join(', ') +
      ` -- ${conflicts.map(c => c.detail).join('; ')}`
    )
    this.name = 'TimelineInvalidError'
  }
}

/** Throws {@link TimelineInvalidError} when `timeline` has any blocking conflict. */
export function assertTimelineAcceptable (timeline: unknown, election: TimelineCrossCheck, method: string): void {
  const blocking = findBlockingTimelineConflicts(timeline, election)
  if (blocking.length > 0) throw new TimelineInvalidError(method, blocking)
}

/**
 * The blocking conflicts as builder errors, for the create/adjust election builders, so a
 * screen that calls `build()` before signing refuses the timeline before any biometric prompt.
 * Strict-chain order problems the builder already reported as `TIMELINE_ORDER` at the same path
 * are not reported twice. Codes: `TIMELINE_ORDER`, `TIMELINE_PREPARATION_AFTER_VOTING`,
 * `TIMELINE_BALLOTS_FINAL_AFTER_DEADLINE`, `TIMELINE_AFTER_ELECTION_DAY`,
 * `TIMELINE_CLOSED_BEFORE_ELECTION_DATE`, `TIMELINE_UNPARSEABLE`.
 */
export function timelineBuilderErrors (
  timeline: unknown,
  election: TimelineCrossCheck,
  alreadyReported: readonly BuilderError[] = []
): BuilderError[] {
  const reported = new Set(alreadyReported.map(e => `${e.code}|${e.path}`))
  const errors: BuilderError[] = []
  for (const c of findBlockingTimelineConflicts(timeline, election)) {
    const path = `revision.timeline.${c.event}`
    let code: string
    switch (c.code) {
      case 'OUT_OF_ORDER':
        code = TIMELINE_PREPARATION.includes(c.event) ? 'TIMELINE_PREPARATION_AFTER_VOTING' : 'TIMELINE_ORDER'
        break
      case 'BALLOTS_FINAL_AFTER_DEADLINE': code = 'TIMELINE_BALLOTS_FINAL_AFTER_DEADLINE'; break
      case 'EVENT_AFTER_ELECTION_DATE': code = 'TIMELINE_AFTER_ELECTION_DAY'; break
      case 'CLOSED_BEFORE_ELECTION_DATE': code = 'TIMELINE_CLOSED_BEFORE_ELECTION_DATE'; break
      default: code = 'TIMELINE_UNPARSEABLE'
    }
    if (reported.has(`${code}|${path}`)) continue
    reported.add(`${code}|${path}`)
    errors.push({ path, code, message: c.detail, kind: 'cross-field' })
  }
  return errors
}
