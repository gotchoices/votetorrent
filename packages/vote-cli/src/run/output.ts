// The one line writer of `vt run`. Every orchestrator line (stdout and ev/driver.log) is built here, in
// the lean rig's shapes so the profile tools (prof/netstats.mjs, prof/cpuslice2.mjs) keep parsing:
// `[<ms padded 7>ms] <CAT padded 8> <msg>`, `RUN-MARK <name> <epoch ms>`, `<KEY>: <value>`,
// `LEAN-WAIT/GO/NOTE`, `RESULT {json}` and a final `SUMMARY ...` after which nothing can be written.
// Every line passes through the run's masker before it leaves this module.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'

export const RUN_MARK_NAMES = Object.freeze(['p1-start', 'p1-end', 'p2-start', 'p2-end'] as const)
export type RunMarkName = (typeof RUN_MARK_NAMES)[number]

/** The orchestrator line grammar shared by the specs, the selfcheck and the results builder. */
export const LINE_GRAMMAR = Object.freeze({
  say: /^\[[ 0-9]{7,}ms\] [A-Z][A-Z0-9-]* +.+$/,
  runMark: /^RUN-MARK (p1-start|p1-end|p2-start|p2-end) \d{13}$/,
  approve: /^\[[ 0-9]{7,}ms\] APPROVE  registration \d+ readMs=\d+ decideMs=\d+ publishMs=\d+ publish=[a-z0-9:-]+$/,
  leanWait: /^LEAN-WAIT [a-z0-9][a-z0-9-]* at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
  leanGo: /^LEAN-GO [a-z0-9][a-z0-9-]* ok=(true|false) waitedMs=\d+$/,
  leanNote: /^LEAN-NOTE .+$/,
  key: /^[A-Z0-9][A-Z0-9-]*: .*$/,
  result: /^RESULT \{.*\}$/,
  summary: /^SUMMARY (PASS|FAIL [a-z0-9][a-z0-9-]* [a-z0-9][a-z0-9-]*)$/
})

// The wall literals are assembled from fragments so this file never reads as a wall hit itself.
const SM_RE = /Failed to get super-majority: (\d+\/\d+) approvals/g
const TORN = 'Torn' + 'Action' + 'Error'
const IDL = 'InvalidData' + 'LengthError'
const TLE = 'TransferLimit' + 'Error'

/** A stray wall literal in the orchestrator's OWN text is neutralised so it can never read as a hit. */
export function scrubWall (s: string): string {
  return s.replace(SM_RE, 'sm-refusal $1').split(TORN).join('torn-refusal').split(IDL).join('idl-refusal').split(TLE).join('tl-refusal')
}

export type RunOutputErrorCode = 'mark-repeat' | 'mark-name' | 'after-summary' | 'key-name' | 'marks-relative'

export class RunOutputError extends Error {
  readonly code: RunOutputErrorCode

  constructor (code: RunOutputErrorCode) {
    super(`run output: ${code}`)
    this.name = 'RunOutputError'
    this.code = code
  }
}

export interface ApproveLine {
  n: number
  readMs: number
  decideMs: number
  publishMs: number
  publish: string
}

export interface RunOutput {
  say (cat: string, msg: string): void
  runMark (name: RunMarkName): void
  hasMark (name: RunMarkName): boolean
  approve (a: ApproveLine): void
  leanWait (step: string): void
  leanGo (step: string, ok: boolean, waitedMs: number): void
  leanNote (text: string): void
  key (name: string, value: string): void
  keys (): Record<string, string>
  result (obj: Record<string, unknown>): void
  summary (text: string): void
  /** Milliseconds since the output was created (the rig's T0). */
  elapsedMs (): number
}

export interface RunOutputOptions {
  write: (line: string) => void
  mask: (s: string) => string
  marksFile?: string
  nowMs?: () => number
  perfNow?: () => number
}

const KEY_NAME_RE = /^[A-Z0-9][A-Z0-9-]*$/
const PUBLISH_KEEP_RE = /[^a-z0-9:-]/g

export function createRunOutput (opts: RunOutputOptions): RunOutput {
  if (opts.marksFile !== undefined && !isAbsolute(opts.marksFile)) throw new RunOutputError('marks-relative')
  const nowMs = opts.nowMs ?? Date.now
  const perfNow = opts.perfNow ?? ((): number => performance.now())
  const t0 = perfNow()
  const marks = new Set<RunMarkName>()
  const keys = new Map<string, string>()
  let closed = false

  const emit = (line: string): void => {
    if (closed) throw new RunOutputError('after-summary')
    opts.write(opts.mask(line))
  }
  const elapsedMs = (): number => Math.round(perfNow() - t0)
  const say = (cat: string, msg: string): void => {
    emit(`[${String(elapsedMs()).padStart(7)}ms] ${cat.padEnd(8)} ${msg}`)
  }

  return {
    say,
    elapsedMs,
    runMark (name) {
      if (!(RUN_MARK_NAMES as readonly string[]).includes(name)) throw new RunOutputError('mark-name')
      if (marks.has(name)) throw new RunOutputError('mark-repeat')
      if (closed) throw new RunOutputError('after-summary')
      marks.add(name)
      const line = `RUN-MARK ${name} ${nowMs()}`
      emit(line)
      if (opts.marksFile !== undefined) {
        mkdirSync(dirname(opts.marksFile), { recursive: true, mode: 0o700 })
        appendFileSync(opts.marksFile, line + '\n', { mode: 0o600, flag: 'a' })
      }
    },
    hasMark: (name) => marks.has(name),
    approve (a) {
      const publish = a.publish.replace(PUBLISH_KEEP_RE, '')
      say('APPROVE', `registration ${Math.round(a.n)} readMs=${Math.round(a.readMs)} decideMs=${Math.round(a.decideMs)} publishMs=${Math.round(a.publishMs)} publish=${publish}`)
    },
    leanWait (step) {
      emit(`LEAN-WAIT ${step} at=${new Date(nowMs()).toISOString()}`)
    },
    leanGo (step, ok, waitedMs) {
      emit(`LEAN-GO ${step} ok=${ok} waitedMs=${Math.round(waitedMs)}`)
    },
    leanNote (text) {
      emit(`LEAN-NOTE ${text}`)
    },
    key (name, value) {
      if (!KEY_NAME_RE.test(name)) throw new RunOutputError('key-name')
      if (keys.has(name)) return
      if (closed) throw new RunOutputError('after-summary')
      const masked = opts.mask(value)
      keys.set(name, masked)
      emit(`${name}: ${masked}`)
    },
    keys: () => Object.fromEntries(keys),
    result (obj) {
      emit('RESULT ' + JSON.stringify(obj))
    },
    summary (text) {
      emit(`SUMMARY ${text}`)
      closed = true
    }
  }
}
