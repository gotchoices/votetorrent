// A port of tools/lean-rig/lib/classify.mjs parseLog + classifyRun over rig-shaped wall leg logs.
//
// Deviation (recorded in 67-31-SUMMARY.md and here): the phase-64 PINS / MAIN_EVENT_MIN stack gate is
// NOT ported, because those pins name a superseded stack. `classifyRun` records `rec.stack` but never
// refuses a run for a different version. classifyBatch, makeOrder, the CLI and CLASSIFY_MUTATE are not
// ported: vt has no batch run. A second deviation: a `vt` leg (shape `vt`) has no spike-106 join
// precondition (its legs are election legs, not the two-node join shapes), so that gate is skipped.

export const WALL_LEG_SCHEMA = 'vt64-wall-leg/1'

export interface ClassifyResult {
  cls: string
  why: string
  notes: string[]
}

export interface WallLegResult {
  dryConfig?: unknown
  stack?: unknown
  setupError?: unknown
  stage?: unknown
  instrument?: { probeInstalled?: unknown, probeCalls?: unknown }
  preconditions?: Record<string, unknown>
  shape?: unknown
  join?: { ok?: unknown, reason?: unknown, ms?: unknown } | null
  join1?: { ok?: unknown } | null
  timedOut?: unknown
  oversizedTotal?: unknown
  hiddenOpenFailuresTotal?: unknown
  wallSignals?: Record<string, Partial<WallSigLike> | undefined>
  otherSignals?: Record<string, unknown>
  stall?: { over2000?: unknown, maxMs?: unknown }
}

interface WallSigLike {
  superMajority?: unknown
  superMajorityRatios?: unknown
  tornAction?: unknown
  tornReasons?: unknown
  invalidDataLength?: unknown
}

function num (v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str (v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function bool (v: unknown): boolean {
  return v === true
}

export function parseLog (text: string): { start: Record<string, unknown> | null, results: Array<Record<string, unknown>> } {
  let start: Record<string, unknown> | null = null
  const results: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    let m = /^LEG-START (\{.*\})$/.exec(line)
    if (m !== null && start === null) {
      try {
        start = JSON.parse(m[1]!) as Record<string, unknown>
      } catch {
        // ignore a torn start line
      }
      continue
    }
    m = /^RESULT (\{.*\})$/.exec(line)
    if (m !== null) {
      try {
        results.push(JSON.parse(m[1]!) as Record<string, unknown>)
      } catch {
        // ignore a torn result line
      }
    }
  }
  return { start, results }
}

function wallIn (r: WallLegResult, part: 'hidden' | 'thrown' | 'late'): boolean {
  const s = r.wallSignals?.[part]
  if (s === undefined) return false
  return num(s.superMajority) > 0 || num(s.tornAction) > 0 || num(s.invalidDataLength) > 0
}

function sumSig (r: WallLegResult, key: 'superMajority' | 'tornAction' | 'invalidDataLength'): number {
  const w = r.wallSignals ?? {}
  let n = 0
  for (const part of ['hidden', 'thrown', 'late'] as const) n += num(w[part]?.[key])
  return n
}

/** Classify one run's log text. `rec` is the optional batch.json run record. */
export function classifyRun (text: string, rec: Record<string, unknown> = {}): ClassifyResult {
  const { start, results } = parseLog(text)
  const notes: string[] = []
  if (results.length === 0) {
    if (rec.quiet === 'not-quiet') return { cls: 'VOID-run (host-not-quiet)', why: 'host not quiet', notes }
    if (start !== null) return { cls: 'HIT', why: 'leg started and never reported a RESULT (killed or crashed mid-flow)', notes }
    return { cls: 'VOID-run (instrument-never-started)', why: 'no LEG-START and no RESULT', notes }
  }
  if (results.length > 1) notes.push('multiple RESULT lines')
  const r = results[0] as WallLegResult
  const voidRun = (why: string, detail: string): ClassifyResult => ({ cls: `VOID-run (${why})`, why: detail, notes })
  if (bool(r.dryConfig)) return voidRun('dry-config', 'dry config run')

  const oversized = num(r.oversizedTotal)
  const hiddenCount = num(r.hiddenOpenFailuresTotal)
  const hiddenWall = wallIn(r, 'hidden')
  const thrownWall = wallIn(r, 'thrown')
  const lateWall = wallIn(r, 'late')
  const wallEvidence = oversized > 0 || hiddenWall || thrownWall || lateWall
  const superMajority = sumSig(r, 'superMajority')

  if (!wallEvidence) {
    if (bool(r.setupError) && (r.stage === 'boot' || r.stage === 'genesis')) return voidRun('setup-error', `setup error at stage ${str(r.stage)}`)
    const instrument = r.instrument ?? {}
    if (instrument.probeInstalled === false || num(instrument.probeCalls) === 0) return voidRun('instrument-detached', 'size probe saw no cluster send')
    const pre = r.preconditions ?? {}
    const bad = r.shape === 'vt' ? false : r.shape === 'l1' ? (pre.vAuthorizedBeforeFound !== true || num(pre.aConnectionsAtFound) < 1) : pre.memberBeforeStrand !== true
    if (bad) return voidRun('precondition-not-met', `precondition not met for ${str(r.shape)}`)
  }

  const joinOk = r.join?.ok === true
  if (r.shape === 'l3') {
    const shown = oversized >= 1 && (hiddenCount >= 1 || !joinOk) && superMajority >= 1
    if (shown) return { cls: 'CONTROL WALL SHOWN', why: `oversized ${oversized}, hidden ${hiddenCount}, super-majority ${superMajority}`, notes }
    return { cls: 'CONTROL NO WALL', why: `oversized ${oversized}, hidden ${hiddenCount}, super-majority ${superMajority}, join ok ${joinOk}`, notes }
  }

  if (r.stall !== undefined && num(r.stall.over2000) > 0) notes.push(`stall over 2 s x${num(r.stall.over2000)} (max ${num(r.stall.maxMs)} ms)`)
  if (bool(r.timedOut)) notes.push(`timed out at stage ${str(r.stage)}`)
  const o = r.otherSignals ?? {}
  const others = ['missingBlock', 'peersUnreachable', 'claimedElsewhere', 'cohortUnreachable', 'deadConnection'].filter((k) => num(o[k]) > 0)
  if (others.length > 0) notes.push(`other signals: ${others.join(',')}`)

  const join1Bad = r.shape === 'l1' && r.join1?.ok !== true
  if (!joinOk || join1Bad || bool(r.timedOut) || thrownWall || lateWall) {
    const why = bool(r.timedOut) ? `timed out at stage ${str(r.stage)}`
      : r.join == null ? `no join outcome (stage ${str(r.stage)})`
        : !joinOk ? `join not ok: ${str(r.join?.reason)}`
          : join1Bad ? 'first join (join1) not ok'
            : 'thrown or late wall signal'
    return { cls: 'HIT', why, notes }
  }
  if (hiddenCount > 0 || oversized > 0 || hiddenWall) {
    if (hiddenWall && oversized === 0) notes.push('super-majority without oversized (possible unanswered-cohort flake; still a hit under D-14 as amended)')
    return { cls: 'MASKED HIT', why: `join ok but hidden open ${hiddenCount}, oversized ${oversized}${hiddenWall ? ', hidden wall signal' : ''}`, notes }
  }
  return { cls: 'CLEAN', why: `join ok ${num(r.join?.ms)} ms, no failed open, no oversized send`, notes }
}
