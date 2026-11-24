// results.json (the rig's driver-results.json, reduced to the keys CLI-06 needs plus per-step windows),
// the summary rule and the exit code. results.json is written once (wx, 0600) and holds no free text:
// every string is a grammar-checked token or name, an ISO date, or a key value the run already masked.

import { writeFileSync } from 'node:fs'
import { EXIT, type ExitCode } from '../cli/exit-codes.js'

/** The rig's 13 duration names, in rig order. */
export const DURATION_KEYS = Object.freeze([
  'reopenMs',
  'intakeMs',
  'ballotMs',
  'electionMs',
  'acceptMs',
  'dkgMs',
  'hvJoinMs',
  'associatedMs',
  'associatedWaitMs',
  'poolMs',
  'releaseMs',
  'decryptMs',
  'voterResultsMs'
] as const)
export type DurationKey = (typeof DURATION_KEYS)[number]

export const RESULTS_TOOL = 'vt-run'

/** The top-level keys of results.json, in order. `wall` follows only when the instruments plan fills it. */
export const RESULTS_KEYS = Object.freeze(['tool', 'summary', 'legs', 'durations', 'steps', 'secretScan', 'keys', 'startedAt', 'endedAt'] as const)

/** Key names every run carries in results.json.keys; the leg bodies fill the values. */
export const HANDOFF_KEYS = Object.freeze({
  network: 'HANDOFF-NETWORK',
  election: 'HANDOFF-ELECTION',
  tokenFiles: 'HANDOFF-TOKEN-FILES'
} as const)

export const TOKEN_RE = /^[a-z0-9][a-z0-9-]*$/
const STEP_NAME_RE = /^[a-z0-9][a-z0-9/-]*$/
const SUMMARY_RE = /^(PASS|FAIL [a-z0-9][a-z0-9-]* [a-z0-9][a-z0-9-]*)$/
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/

export type LegStatusValue = 'PASS' | 'FAIL' | 'VOID'
export type InScriptD14 = 'OFF' | 'CLEAN' | 'HIT'

export interface LegStatus {
  leg: string
  status: LegStatusValue
  /** '' on PASS. */
  token: string
  inScriptD14: InScriptD14
  reason: string
  checks: string[]
}

export interface StepWindow {
  name: string
  startMs: number
  endMs: number
}

export interface SecretScanCounts {
  whole: number
  windows: number
  files: number
}

export interface ResultsInput {
  summary: string
  legs: readonly LegStatus[]
  durations: Readonly<Record<string, number>>
  steps: readonly StepWindow[]
  secretScan: SecretScanCounts
  keys: Readonly<Record<string, string>>
  startedAt: string
  endedAt: string
  wall?: Record<string, unknown>
}

export interface RunResultsLeg {
  leg: string
  status: LegStatusValue
  token: string
  inScriptD14: InScriptD14
  reason: string
}

export interface RunResults {
  tool: typeof RESULTS_TOOL
  summary: string
  legs: RunResultsLeg[]
  durations: Record<string, number>
  steps: StepWindow[]
  secretScan: SecretScanCounts
  keys: Record<string, string>
  startedAt: string
  endedAt: string
  wall?: Record<string, unknown>
}

const bad = (what: string): never => {
  throw new TypeError(`results: ${what}`)
}
const int = (v: unknown, what: string): number => (typeof v === 'number' && Number.isInteger(v) ? v : bad(what))

export function buildResults (input: ResultsInput): RunResults {
  if (!SUMMARY_RE.test(input.summary)) bad('summary')
  const legs: RunResultsLeg[] = input.legs.map((l) => {
    if (!TOKEN_RE.test(l.leg)) bad('leg')
    if (l.status !== 'PASS' && l.status !== 'FAIL' && l.status !== 'VOID') bad('status')
    if (l.token !== '' && !TOKEN_RE.test(l.token)) bad('token')
    if (l.inScriptD14 !== 'OFF' && l.inScriptD14 !== 'CLEAN' && l.inScriptD14 !== 'HIT') bad('inScriptD14')
    if (!TOKEN_RE.test(l.reason)) bad('reason')
    return { leg: l.leg, status: l.status, token: l.token, inScriptD14: l.inScriptD14, reason: l.reason }
  })
  const durations: Record<string, number> = {}
  for (const k of DURATION_KEYS) {
    const v = input.durations[k]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) bad('duration')
    durations[k] = Math.round(v)
  }
  for (const k of Object.keys(input.durations)) if (!(DURATION_KEYS as readonly string[]).includes(k)) bad('duration-key')
  const steps: StepWindow[] = input.steps.map((s) => {
    if (!STEP_NAME_RE.test(s.name)) bad('step-name')
    return { name: s.name, startMs: int(s.startMs, 'step-start'), endMs: int(s.endMs, 'step-end') }
  })
  const secretScan: SecretScanCounts = {
    whole: int(input.secretScan.whole, 'scan-whole'),
    windows: int(input.secretScan.windows, 'scan-windows'),
    files: int(input.secretScan.files, 'scan-files')
  }
  const keys: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.keys)) {
    if (typeof v !== 'string') bad('key-value')
    keys[k] = v
  }
  for (const name of Object.values(HANDOFF_KEYS)) keys[name] ??= ''
  if (!ISO_RE.test(input.startedAt)) bad('startedAt')
  if (!ISO_RE.test(input.endedAt)) bad('endedAt')
  const out: RunResults = {
    tool: RESULTS_TOOL,
    summary: input.summary,
    legs,
    durations,
    steps,
    secretScan,
    keys,
    startedAt: input.startedAt,
    endedAt: input.endedAt
  }
  if (input.wall !== undefined) out.wall = input.wall
  return out
}

export class ResultsExistError extends Error {
  readonly code = 'results-exist' as const

  constructor () {
    super('results: results-exist')
    this.name = 'ResultsExistError'
  }
}

/** Writes once: an existing file is never overwritten (ResultsExistError). */
export function writeResults (path: string, obj: RunResults): void {
  try {
    writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ResultsExistError()
    throw e
  }
}

export interface SummaryInput {
  statuses: readonly LegStatus[]
  planLength: number
  scan: SecretScanCounts
  /** A failure of the run itself (crash, results-write) when no leg failed. */
  driverToken?: string
}

/**
 * The rig's rule: the first non-PASS leg names the summary; a secret-scan hit on an otherwise clean run is
 * `FAIL <last leg or driver> secret-leak`; PASS needs every planned leg passed and a non-empty plan.
 */
export function summaryLine (input: SummaryInput): string {
  const nonPass = input.statuses.find((s) => s.status !== 'PASS')
  if (nonPass !== undefined) return `FAIL ${nonPass.leg} ${nonPass.token}`
  if (input.driverToken !== undefined) return `FAIL driver ${input.driverToken}`
  if (input.scan.whole !== 0 || input.scan.windows !== 0) return `FAIL ${input.statuses.at(-1)?.leg ?? 'driver'} secret-leak`
  if (input.statuses.length === input.planLength && input.planLength > 0) return 'PASS'
  return 'FAIL driver no-result'
}

export function exitCodeFor (summary: string): ExitCode {
  return summary === 'PASS' ? EXIT.PASS : EXIT.FAIL
}
