// The leg harness, ported from the lean rig's leg(): need/check with hard and soft tokens, a masked crash
// token, VOID on an existing leg dir, per-leg `leg.log` and `leg-status.json` written once, a step
// window per leg and per named step, and `delegate`, the ONLY path that prints the phone hand-off lines
// (through the output's leanWait/leanGo/leanNote). The core measures no D14 wall signal, so inScriptD14
// reads OFF rather than claiming CLEAN.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { ApproveLine, RunOutput } from './output.js'
import { DURATION_KEYS, TOKEN_RE, type LegStatus, type StepWindow } from './results.js'

export { TOKEN_RE }

/** Outcome checks later legs do not depend on: recorded, and the run goes on. */
export const SOFT_TOKENS: ReadonlySet<string> = Object.freeze(
  new Set(['officer-loop', 'join-outcome', 'cid-disagree', 'entry-hash', 'block', 'pre-release', 'needle-control', 'voter-results'])
)

/** Tokens the orchestrator itself raises. */
export const RUN_TOKENS = Object.freeze([
  'leg-unwired',
  'leg-dir-exists',
  'daemon-boot',
  'daemon-timeout',
  'daemon-unreachable',
  'delegate-timeout',
  'secret-leak',
  'alarm',
  'interrupted',
  'results-write',
  'no-result',
  'crash',
  'bad-token'
] as const)

export class LegFail extends Error {
  readonly kind: 'FAIL' | 'VOID'
  readonly token: string

  constructor (kind: 'FAIL' | 'VOID', token: string) {
    super(token)
    this.name = 'LegFail'
    this.kind = kind
    this.token = token
  }
}

export interface DelegateOptions {
  timeoutMs: number
  pollMs?: number
  note?: string
}

export interface LegCtx {
  readonly dir: string
  readonly name: string
  check (id: string, text: string, pass: boolean, detail?: unknown): boolean
  need (token: string, id: string, text: string, pass: boolean, detail?: unknown): void
  step<T> (stepName: string, fn: () => Promise<T>): Promise<T>
  duration (key: string, ms: number): void
  delegate (stepName: string, opts: DelegateOptions): Promise<{ ok: boolean, waitedMs: number }>
  approve (a: ApproveLine): void
}

export type LegBody = (L: LegCtx) => Promise<void>

export interface LegRunnerOptions {
  evDir: string
  /** Where `flag-<step>` files appear for delegated steps. */
  flagsDir: string
  out: RunOutput
  mask: (s: string) => string
  nowMs?: () => number
  perfNow?: () => number
  /** Resolves with `alarm` or `interrupted`: the running leg ends with that token. */
  abort: Promise<string>
}

export interface LegRunner {
  runLeg (name: string, body: LegBody): Promise<LegStatus>
  readonly statuses: LegStatus[]
  readonly steps: StepWindow[]
  readonly durations: Record<string, number>
  firstNonPass (): LegStatus | null
  /** The abort reason once it has fired, else null. */
  aborted (): string | null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const ERROR_NAME_RE = /[^A-Za-z0-9_.-]/g
const CRASH_MESSAGE_CHARS = 200

function errorName (e: unknown): string {
  const n = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined
  const clean = typeof n === 'string' ? n.replace(ERROR_NAME_RE, '') : ''
  return clean.length > 0 ? clean : 'Error'
}

function errorMessage (e: unknown): string {
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message
  try {
    return String(e)
  } catch {
    return 'unprintable'
  }
}

export function createLegRunner (opts: LegRunnerOptions): LegRunner {
  const nowMs = opts.nowMs ?? Date.now
  const perfNow = opts.perfNow ?? ((): number => performance.now())
  const { out, mask } = opts
  const statuses: LegStatus[] = []
  const steps: StepWindow[] = []
  const durations: Record<string, number> = {}
  let abortReason: string | null = null
  void opts.abort.then((reason) => {
    abortReason = TOKEN_RE.test(reason) ? reason : 'bad-token'
  })

  const tokenOrBad = (t: string): string => (TOKEN_RE.test(t) ? t : 'bad-token')
  const detailText = (detail: unknown): string => {
    if (detail === undefined) return ''
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
    return `  - ${text ?? ''}`
  }

  async function runLeg (name: string, body: LegBody): Promise<LegStatus> {
    if (!TOKEN_RE.test(name)) throw new TypeError('leg: bad-name')
    const dir = join(opts.evDir, name)
    const legStartMs = nowMs()
    const finish = (status: LegStatus): LegStatus => {
      statuses.push(status)
      out.say('LEG', `${name} ${status.status}${status.token ? ' ' + status.token : ''}`)
      return status
    }
    if (existsSync(dir)) {
      return finish({ leg: name, status: 'VOID', token: 'leg-dir-exists', inScriptD14: 'OFF', reason: 'instruments-off', checks: [] })
    }
    mkdirSync(dir, { mode: 0o700 })
    const legLog = join(dir, 'leg.log')
    writeFileSync(legLog, 'LEG-START ' + JSON.stringify({ schema: 'vt-run-leg/1', leg: name }) + '\n', { flag: 'wx', mode: 0o600 })
    const t0 = perfNow()
    let open = true
    const w = (s: string): void => {
      if (!open) return
      appendFileSync(legLog, mask(s) + '\n')
    }
    const checks: string[] = []
    let firstFail: string | null = null
    out.say('LEG', `${name} start`)

    const L: LegCtx = {
      dir,
      name,
      check (id, text, pass, detail) {
        // a body still running after an abort closed the leg records nothing more
        if (!open) return pass
        const d = detailText(detail)
        w(`[${String(Math.round(perfNow() - t0)).padStart(7)}ms] ${pass ? 'PASS' : 'FAIL'} ${id} ${text}${d}`)
        out.say(pass ? 'PASS' : 'FAIL', `${name} ${id} ${text}${d}`)
        checks.push(id)
        return pass
      },
      need (token, id, text, pass, detail) {
        const t = tokenOrBad(token)
        const ok = L.check(id, text, pass, detail)
        if (ok) return
        firstFail ??= t
        if (!SOFT_TOKENS.has(t)) throw new LegFail('FAIL', t)
        out.say('SOFT-FAIL', `${name} ${id} recorded, continuing`)
      },
      async step (stepName, fn) {
        if (!TOKEN_RE.test(stepName)) throw new LegFail('FAIL', 'bad-token')
        const startMs = nowMs()
        try {
          return await fn()
        } finally {
          steps.push({ name: `${name}/${stepName}`, startMs, endMs: nowMs() })
        }
      },
      duration (key, ms) {
        if (!(DURATION_KEYS as readonly string[]).includes(key)) throw new LegFail('FAIL', 'bad-token')
        durations[key] = Math.round(ms)
      },
      async delegate (stepName, d) {
        if (!TOKEN_RE.test(stepName)) throw new LegFail('FAIL', 'bad-token')
        const pollMs = d.pollMs ?? 1000
        if (d.note !== undefined) out.leanNote(d.note)
        out.leanWait(stepName)
        const flag = join(opts.flagsDir, `flag-${stepName}`)
        const started = performance.now()
        let ok = false
        for (;;) {
          if (existsSync(flag)) {
            ok = true
            break
          }
          if (performance.now() - started >= d.timeoutMs || abortReason !== null) break
          await sleep(pollMs)
        }
        const waitedMs = Math.round(performance.now() - started)
        out.leanGo(stepName, ok, waitedMs)
        return { ok, waitedMs }
      },
      approve (a) {
        out.approve(a)
      }
    }

    let status: LegStatus['status'] = 'PASS'
    let token = ''
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const settle = (fn: () => void): void => {
          if (settled) return
          settled = true
          fn()
        }
        if (abortReason !== null) {
          settle(() => reject(new LegFail('FAIL', abortReason as string)))
          return
        }
        Promise.resolve()
          .then(() => body(L))
          .then(() => settle(resolve), (e) => settle(() => reject(e)))
        void opts.abort.then((reason) => settle(() => reject(new LegFail('FAIL', tokenOrBad(reason)))))
      })
    } catch (e) {
      if (e instanceof LegFail) {
        status = e.kind
        token = e.token
      } else {
        status = 'FAIL'
        token = 'crash-' + name.replace(/[^a-z0-9]+/g, '-')
        const msg = mask(errorMessage(e).replace(/[\x00-\x1f\x7f]+/g, ' ')).slice(0, CRASH_MESSAGE_CHARS)
        w(`crash ${errorName(e)} ${msg}`)
        out.say('CRASH', `${name} ${errorName(e)} ${msg}`)
      }
    }
    if (status === 'PASS' && firstFail !== null) {
      status = 'FAIL'
      token = firstFail
    }
    w('RESULT ' + JSON.stringify({ schema: 'vt-run-leg/1', leg: name, status, token, totalMs: Math.round(perfNow() - t0) }))
    open = false
    const st: LegStatus = { leg: name, status, token, inScriptD14: 'OFF', reason: 'instruments-off', checks }
    writeFileSync(
      join(dir, 'leg-status.json'),
      JSON.stringify({ status, token, inScriptD14: st.inScriptD14, reason: st.reason, checks }) + '\n',
      { flag: 'wx', mode: 0o600 }
    )
    steps.push({ name, startMs: legStartMs, endMs: nowMs() })
    return finish(st)
  }

  return {
    runLeg,
    statuses,
    steps,
    durations,
    firstNonPass: () => statuses.find((s) => s.status !== 'PASS') ?? null,
    aborted: () => abortReason
  }
}
