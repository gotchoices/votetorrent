// The crash recorder: `uncaughtException`, `unhandledRejection` and every thrown verb append one JSON
// line to a 0600 `crash.jsonl` (port of peer driver's recorders onto the 67-12 error view). A record
// is `{ at, where, name, code?, message, chain }`: redacted first, the message cut to 200 chars, the
// cause chain at most 6 names, never a stack trace. The file is capped at `maxRecords`. The process
// handlers keep the daemon running (as hr5 did) and print only a sanitised name.

import { appendFileSync, chmodSync } from 'node:fs'
import { ctlErrorView } from '../ctl/error-view.js'

export interface ErrorRecorderOptions {
  file: string
  redactor: (s: string) => string
  maxRecords?: number
  now?: () => number
}

export interface LateProcess extends NodeJS.EventEmitter {
  stdout: { write(s: string): unknown }
}

export interface ErrorRecorder {
  record(where: string, err: unknown): void
  /** Records written so far (never above maxRecords). */
  readonly count: number
  installProcessHandlers(proc?: LateProcess): void
}

const DEFAULT_MAX_RECORDS = 1000
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

function safeName(err: unknown): string {
  const name = (err as { name?: unknown } | null | undefined)?.name
  return typeof name === 'string' && NAME_RE.test(name) ? name : 'Error'
}

export function createErrorRecorder(opts: ErrorRecorderOptions): ErrorRecorder {
  const { file, redactor } = opts
  const maxRecords = opts.maxRecords ?? DEFAULT_MAX_RECORDS
  const now = opts.now ?? Date.now
  let count = 0
  let modeSet = false
  const record = (where: string, err: unknown): void => {
    if (count >= maxRecords) return
    try {
      const view = ctlErrorView(err, redactor)
      const line = JSON.stringify({ at: new Date(now()).toISOString(), where: redactor(where), ...view }) + '\n'
      appendFileSync(file, line, { mode: 0o600 })
      if (!modeSet) {
        chmodSync(file, 0o600)
        modeSet = true
      }
      count++
    } catch {
      // a recorder failure never surfaces: the daemon keeps running and the reply is unchanged
    }
  }
  return {
    record,
    get count() {
      return count
    },
    installProcessHandlers(proc: LateProcess = process as unknown as LateProcess) {
      proc.on('uncaughtException', (e: unknown) => {
        record('uncaught', e)
        proc.stdout.write(`VT-DAEMON-LATE kind=uncaught name=${safeName(e)}\n`)
      })
      proc.on('unhandledRejection', (e: unknown) => {
        record('unhandled', e)
        proc.stdout.write(`VT-DAEMON-LATE kind=unhandled name=${safeName(e)}\n`)
      })
    }
  }
}
