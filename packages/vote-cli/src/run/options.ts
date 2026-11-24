// `vt run election` argument parsing and validation. argv is untrusted: a word may be a code or the path
// to a secret, so every refusal is a RunUsageError whose message is the code alone and nothing from argv
// is ever echoed. The peer budget is NOT checked here: runElection refuses it, so it can print the VOID
// RESULT line.

import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { RelayEnvError, readRelayEnv } from '../relay/relay-env.js'

/** The repository root, from src/run/ and dist/run/ alike. */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

export type RunUsageCode =
  | 'bad-flag'
  | 'relay-missing'
  | 'relay-unreadable'
  | 'state-missing'
  | 'state-relative'
  | 'state-in-repo'
  | 'state-used'
  | 'party-missing'
  | 'party-shape'
  | 'party-production'
  | 'lead-ms'
  | 'window-ms'
  | 'marks-relative'
  | 'max-peers-shape'
  | 'keyholders'
  | 'keyholders-min'
  | 'voters'
  | 'colocate'
  | 'import-relative'
  | 'alarm-s'

export class RunUsageError extends Error {
  readonly code: RunUsageCode

  constructor (code: RunUsageCode) {
    super(code)
    this.name = 'RunUsageError'
    this.code = code
  }
}

export interface RunOptions {
  relayEnvPath: string
  relayMultiaddr: string
  stateDir: string
  party: string
  leadMs: number
  windowMs: number
  marksFile?: string
  /** undefined = defaultMaxPeers() at run time. */
  maxPeers?: number
  keyholders: number
  voters: number
  /** True when voters < 3: the reduced leg set (no pool, no tally). */
  reduced: boolean
  colocate?: string[]
  debug?: string
  importFile?: string
  cpuProf: boolean
  instruments: boolean
  alarmS: number
}

export const DEFAULT_LEAD_MS = 600000
export const DEFAULT_WINDOW_MS = 480000
export const DEFAULT_ALARM_S = 7200
export const DEFAULT_KEYHOLDERS = 2
export const DEFAULT_VOTERS = 3
export const MIN_KEYHOLDERS = 2
export const FULL_VOTERS = 3

const PARTY_RE = /^[a-z0-9][a-z0-9-]{2,62}$/
/** The apps' production party id and the loopback relay's own party: never a test run's party. */
const PRODUCTION_PARTIES: ReadonlySet<string> = new Set(['votetorrent', 'votetorrent-relay'])

function intOption (raw: string | undefined, code: RunUsageCode, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new RunUsageError(code)
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RunUsageError(code)
  return n
}

/** The realpath of the deepest existing ancestor of `p` (p itself when it exists). */
function existingAncestorRealpath (p: string): string {
  let cur = p
  for (;;) {
    if (existsSync(cur)) return realpathSync(cur)
    const parent = dirname(cur)
    if (parent === cur) return cur
    cur = parent
  }
}

function isInside (path: string, root: string): boolean {
  const r = root.endsWith(sep) ? root.slice(0, -1) : root
  return path === r || path.startsWith(r + sep)
}

/** The authority labels of a topology: colocation is only ever among these. */
export function authorityLabels (keyholders: number): string[] {
  return ['officer', 'kh-a', ...(keyholders >= 2 ? ['kh-b'] : [])]
}

/** officer, kh-a, kh-b, v1 .. v<voters>: every role identity holds its own CadreNode, colocated or not. */
export function peerLabels (opts: Pick<RunOptions, 'keyholders' | 'voters'>): string[] {
  const voters: string[] = []
  for (let i = 1; i <= opts.voters; i++) voters.push(`v${i}`)
  return [...authorityLabels(opts.keyholders), ...voters]
}

export function parseRunElectionArgs (argv: readonly string[]): RunOptions {
  let values: Record<string, string | boolean | undefined>
  try {
    const parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        relay: { type: 'string' },
        state: { type: 'string' },
        party: { type: 'string' },
        'lead-ms': { type: 'string' },
        'window-ms': { type: 'string' },
        'marks-file': { type: 'string' },
        'max-peers': { type: 'string' },
        keyholders: { type: 'string' },
        voters: { type: 'string' },
        colocate: { type: 'string' },
        debug: { type: 'string' },
        import: { type: 'string' },
        'cpu-prof': { type: 'boolean' },
        instruments: { type: 'boolean' },
        'alarm-s': { type: 'string' }
      }
    })
    values = parsed.values as Record<string, string | boolean | undefined>
  } catch {
    throw new RunUsageError('bad-flag')
  }
  const str = (name: string): string | undefined => {
    const v = values[name]
    return typeof v === 'string' ? v : undefined
  }

  // relay
  const relayEnvPath = str('relay')
  if (relayEnvPath === undefined) throw new RunUsageError('relay-missing')
  let relayMultiaddr: string
  try {
    if (!isAbsolute(relayEnvPath)) throw new RelayEnvError('missing')
    relayMultiaddr = readRelayEnv(relayEnvPath).multiaddr
  } catch {
    throw new RunUsageError('relay-unreadable')
  }

  // state
  const stateDir = str('state')
  if (stateDir === undefined) throw new RunUsageError('state-missing')
  if (!isAbsolute(stateDir)) throw new RunUsageError('state-relative')
  const anchored = existingAncestorRealpath(resolve(stateDir))
  const repoReal = existingAncestorRealpath(REPO_ROOT)
  if (isInside(anchored, repoReal) || isInside(resolve(stateDir), REPO_ROOT)) throw new RunUsageError('state-in-repo')
  if (existsSync(join(stateDir, 'ev'))) throw new RunUsageError('state-used')

  // party
  const party = str('party')
  if (party === undefined) throw new RunUsageError('party-missing')
  if (!PARTY_RE.test(party)) throw new RunUsageError('party-shape')
  if (PRODUCTION_PARTIES.has(party)) throw new RunUsageError('party-production')

  // numbers
  const leadMs = intOption(str('lead-ms'), 'lead-ms', 60000, Number.MAX_SAFE_INTEGER, DEFAULT_LEAD_MS)
  const windowMs = intOption(str('window-ms'), 'window-ms', 60000, Number.MAX_SAFE_INTEGER, DEFAULT_WINDOW_MS)
  const maxPeers = str('max-peers') === undefined ? undefined : intOption(str('max-peers'), 'max-peers-shape', 1, 9999, 0)
  const keyholdersRaw = str('keyholders')
  if (keyholdersRaw !== undefined && /^\d+$/.test(keyholdersRaw) && Number(keyholdersRaw) < MIN_KEYHOLDERS) throw new RunUsageError('keyholders-min')
  const keyholders = intOption(keyholdersRaw, 'keyholders', MIN_KEYHOLDERS, 2, DEFAULT_KEYHOLDERS)
  const voters = intOption(str('voters'), 'voters', 1, 9, DEFAULT_VOTERS)
  const alarmS = intOption(str('alarm-s'), 'alarm-s', 60, Number.MAX_SAFE_INTEGER, DEFAULT_ALARM_S)

  // files
  const marksFile = str('marks-file')
  if (marksFile !== undefined && !isAbsolute(marksFile)) throw new RunUsageError('marks-relative')
  const importFile = str('import')
  if (importFile !== undefined && !isAbsolute(importFile)) throw new RunUsageError('import-relative')

  // colocate
  let colocate: string[] | undefined
  const colocateRaw = str('colocate')
  if (colocateRaw !== undefined) {
    const labels = colocateRaw.split(',')
    const allowed = new Set(authorityLabels(keyholders))
    if (labels.length < 2 || new Set(labels).size !== labels.length || labels.some((l) => !allowed.has(l))) throw new RunUsageError('colocate')
    colocate = labels
  }

  const debug = str('debug')
  const opts: RunOptions = {
    relayEnvPath,
    relayMultiaddr,
    stateDir,
    party,
    leadMs,
    windowMs,
    keyholders,
    voters,
    reduced: voters < FULL_VOTERS,
    cpuProf: values['cpu-prof'] === true,
    instruments: values.instruments === true,
    alarmS
  }
  if (marksFile !== undefined) opts.marksFile = marksFile
  if (maxPeers !== undefined) opts.maxPeers = maxPeers
  if (colocate !== undefined) opts.colocate = colocate
  if (debug !== undefined && debug.length > 0) opts.debug = debug
  if (importFile !== undefined) opts.importFile = importFile
  return opts
}
