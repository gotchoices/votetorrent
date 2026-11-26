// Error-view classifier, hidden/thrown/late wall counters and the D-14 reading. Ported from the rig
// (the retired lean rig's main driver 100-160). The three error-name literals are assembled from
// fragments so this file never trips a wall grep, and no error text is ever re-emitted.

export type WallPath = 'hidden' | 'thrown' | 'late'

export const WALL_PATHS: readonly WallPath[] = Object.freeze(['hidden', 'thrown', 'late'])

export interface WallSig {
  superMajority: number
  tornAction: number
  invalidDataLength: number
  transferLimit: number
}

export interface WallSnapshot {
  paths: Record<WallPath, WallSig>
}

export interface ProbeSnapshot {
  installed: boolean
  calls: number
  maxBytes: number
  oversized: number
}

export interface D14Reading {
  inScriptD14: string
  reason: string
}

/** The ctl error view and crash.jsonl records share this shape. */
export interface ErrorViewLike {
  name?: unknown
  code?: unknown
  message?: unknown
  chain?: unknown
}

const SM_RE = /Failed to get super-majority: (\d+\/\d+) approvals/g
const TORN = 'Torn' + 'Action' + 'Error'
const IDL = 'InvalidData' + 'LengthError'
const TLE = 'TransferLimit' + 'Error'
const NAME_RE = /^[A-Za-z0-9]{1,60}$/

function zero (): WallSig {
  return { superMajority: 0, tornAction: 0, invalidDataLength: 0, transferLimit: 0 }
}

function zeroPaths (): Record<WallPath, WallSig> {
  return { hidden: zero(), thrown: zero(), late: zero() }
}

/** Counts super-majority messages and the three wall error names over `name` plus every `chain` entry. */
export function classifyErrorView (view: ErrorViewLike | null | undefined): WallSig {
  const out = zero()
  if (view === null || typeof view !== 'object') return out
  const names: string[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string' && NAME_RE.test(v) && !names.includes(v) && names.length < 12) names.push(v)
  }
  push(view.name)
  if (Array.isArray(view.chain)) for (const entry of view.chain) push(entry)
  const msg = typeof view.message === 'string' ? view.message : ''
  const matches = msg.match(SM_RE)
  if (matches !== null) out.superMajority += matches.length
  for (const name of names) {
    if (name === TORN) out.tornAction++
    else if (name === IDL) out.invalidDataLength++
    else if (name === TLE) out.transferLimit++
  }
  return out
}

function addSig (into: WallSig, sig: WallSig): void {
  into.superMajority += sig.superMajority
  into.tornAction += sig.tornAction
  into.invalidDataLength += sig.invalidDataLength
  into.transferLimit += sig.transferLimit
}

function copySig (sig: WallSig): WallSig {
  return { superMajority: sig.superMajority, tornAction: sig.tornAction, invalidDataLength: sig.invalidDataLength, transferLimit: sig.transferLimit }
}

function totalOf (sig: WallSig): number {
  return sig.superMajority + sig.tornAction + sig.invalidDataLength + sig.transferLimit
}

export interface WallCounters {
  record (path: WallPath, view: ErrorViewLike | null | undefined): void
  snapshot (): WallSnapshot
  delta (before: WallSnapshot, after: WallSnapshot): Record<WallPath, WallSig>
}

export function createWallCounters (): WallCounters {
  const counts = zeroPaths()
  return {
    record (path, view) {
      if (!WALL_PATHS.includes(path)) throw new TypeError('wall: bad-path')
      addSig(counts[path], classifyErrorView(view))
    },
    snapshot () {
      return { paths: { hidden: copySig(counts.hidden), thrown: copySig(counts.thrown), late: copySig(counts.late) } }
    },
    delta (before, after) {
      const out = zeroPaths()
      for (const path of WALL_PATHS) {
        out[path] = {
          superMajority: after.paths[path].superMajority - before.paths[path].superMajority,
          tornAction: after.paths[path].tornAction - before.paths[path].tornAction,
          invalidDataLength: after.paths[path].invalidDataLength - before.paths[path].invalidDataLength,
          transferLimit: after.paths[path].transferLimit - before.paths[path].transferLimit
        }
      }
      return out
    }
  }
}

export interface D14VerdictInput {
  before: WallSnapshot
  after: WallSnapshot
  probeBefore: ProbeSnapshot
  probeAfter: ProbeSnapshot
  probeInstalled: boolean
}

export function d14Verdict (input: D14VerdictInput): D14Reading {
  if (!input.probeInstalled) return { inScriptD14: 'INSTRUMENT', reason: 'probe-not-installed' }
  const wall = createWallCounters().delta(input.before, input.after)
  const oversizedDelta = input.probeAfter.oversized - input.probeBefore.oversized
  for (const path of WALL_PATHS) {
    const sig = wall[path]
    if (sig.superMajority > 0) return { inScriptD14: 'HIT', reason: 'superMajority' }
    if (sig.tornAction > 0) return { inScriptD14: 'HIT', reason: 'tornAction' }
    if (sig.invalidDataLength > 0) return { inScriptD14: 'HIT', reason: 'invalidDataLength' }
    if (sig.transferLimit > 0) return { inScriptD14: 'HIT', reason: 'transferLimit' }
  }
  if (oversizedDelta > 0) return { inScriptD14: 'HIT', reason: 'oversized' }
  return { inScriptD14: 'CLEAN', reason: 'no-wall-signal' }
}

/** Total signal count, used by the wall assembly and the classify writer. */
export function wallTotal (sig: WallSig): number {
  return totalOf(sig)
}
