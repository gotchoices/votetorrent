// The CLI short election timeline, built by the lean rig's rule (the retired lean rig's main driver
// 722-734: votingStarts = T + lead, accruingVotes = votingStarts + window, then +60 s steps to closed;
// registrationEnds = ballotsFinal = votingStarts - 60 s; date = closed; revisionDeadline =
// ballotDeadline = votingStarts) and checked against the Voter app's OWN timeline rule through the
// shared `deriveTimeline` (the rig's gate E0t, lines 735-737: no conflict other than MISSING_EVENT).
// The Voter rule is reached through @votetorrent/workflows/voter only; the web lifecycle package it
// wraps ships no type declarations and is never imported here.
//
// One deliberate deviation from the rig: T is rounded UP to a whole second, because
// Election.BallotDeadline is second-precision (RESEARCH Pitfall 11), so every instant is second-aligned.
// The defaults (600000 / 480000) are the profile that ran; 90000 / 60000 are the floors the short
// loopback timeline may try, flagged `belowProvenDefaults` in the result.

import { ElectionEvent } from '@votetorrent/vote-core'
import { deriveTimeline } from '@votetorrent/workflows/voter'

export const DEFAULT_LEAD_MS = 600000
export const DEFAULT_WINDOW_MS = 480000
export const MIN_LEAD_MS = 90000
export const MIN_WINDOW_MS = 60000
export const MAX_LEAD_MS = 30 * 86400000
export const MAX_WINDOW_MS = 7 * 86400000

const DIGITS_RE = /^\d{1,12}$/
const STEP_MS = 60000

export type TimelineArgsCode = 'lead-invalid' | 'window-invalid' | 'lead-too-short' | 'window-too-short'

export type ParsedTimelineArgs =
  | { ok: true, leadMs: number, windowMs: number, belowProvenDefaults: boolean }
  | { ok: false, code: TimelineArgsCode }

function parseOne(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  invalid: TimelineArgsCode,
  short: TimelineArgsCode
): { ok: true, ms: number } | { ok: false, code: TimelineArgsCode } {
  if (value === undefined) return { ok: true, ms: fallback }
  if (typeof value !== 'string' || !DIGITS_RE.test(value)) return { ok: false, code: invalid }
  const ms = Number(value)
  if (ms > max) return { ok: false, code: invalid }
  if (ms < min) return { ok: false, code: short }
  return { ok: true, ms }
}

/** `--lead-ms` / `--window-ms` as the ctl hands them (strings), or undefined for the defaults. */
export function parseTimelineArgs(args: { leadMs?: unknown, windowMs?: unknown }): ParsedTimelineArgs {
  const lead = parseOne(args.leadMs, DEFAULT_LEAD_MS, MIN_LEAD_MS, MAX_LEAD_MS, 'lead-invalid', 'lead-too-short')
  if (!lead.ok) return lead
  const window = parseOne(args.windowMs, DEFAULT_WINDOW_MS, MIN_WINDOW_MS, MAX_WINDOW_MS, 'window-invalid', 'window-too-short')
  if (!window.ok) return window
  return {
    ok: true,
    leadMs: lead.ms,
    windowMs: window.ms,
    belowProvenDefaults: lead.ms < DEFAULT_LEAD_MS || window.ms < DEFAULT_WINDOW_MS
  }
}

export interface CliTimeline {
  /** `now` rounded up to a whole second: the instant every offset derives from. */
  T: number
  timeline: Record<ElectionEvent, number>
  votingStarts: number
  date: number
  revisionDeadline: number
  ballotDeadline: number
}

/** The rig's offsets over a second-aligned T. */
export function buildCliTimeline(input: { now: number, leadMs: number, windowMs: number }): CliTimeline {
  const T = Math.ceil(input.now / 1000) * 1000
  const votingStarts = T + input.leadMs
  const accruing = votingStarts + input.windowMs
  const timeline: Record<ElectionEvent, number> = {
    [ElectionEvent.registrationEnds]: votingStarts - STEP_MS,
    [ElectionEvent.ballotsFinal]: votingStarts - STEP_MS,
    [ElectionEvent.votingStarts]: votingStarts,
    [ElectionEvent.accruingVotes]: accruing,
    [ElectionEvent.hashingVotes]: accruing + STEP_MS,
    [ElectionEvent.releasingKeys]: accruing + 2 * STEP_MS,
    [ElectionEvent.tallyingStarts]: accruing + 3 * STEP_MS,
    [ElectionEvent.validation]: accruing + 4 * STEP_MS,
    [ElectionEvent.certificationStarts]: accruing + 5 * STEP_MS,
    [ElectionEvent.closed]: accruing + 6 * STEP_MS
  }
  return {
    T,
    timeline,
    votingStarts,
    date: timeline[ElectionEvent.closed],
    revisionDeadline: votingStarts,
    ballotDeadline: votingStarts
  }
}

const TOLERATED_CONFLICT = 'MISSING_EVENT'

/**
 * The Voter's own rule over the shared `deriveTimeline`: the sorted, de-duplicated conflict CODES
 * other than MISSING_EVENT. Never the conflict detail (detail strings carry instants).
 */
export function checkVoterTimelineRules(input: { timeline: Record<string, number>, date: number, ballotDeadline: number, now: number }): string[] {
  const view = deriveTimeline({
    timeline: input.timeline,
    now: input.now,
    election: { date: input.date, ballotDeadline: input.ballotDeadline }
  })
  const codes = new Set<string>()
  for (const c of view.conflicts) if (c.code !== TOLERATED_CONFLICT) codes.add(String(c.code))
  return [...codes].sort()
}
