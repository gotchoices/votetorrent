// `vt <role> start` argument validation. Every refusal is a StartArgsError whose message is its code
// alone: an argument may be a path under $HOME or a party id, and nothing from argv is echoed. The
// layout rule `<run>/<party>/<label>/` is enforced here (the state basename is the label, its parent's
// basename is the party), and the party/posture rules come from ./posture.js. No I/O beyond a
// realpath of the state dir's deepest existing ancestor (the in-repo refusal); nothing is created.
//
// Start-path module: node built-ins and relative imports only (no package specifier), because the
// daemon env must be applied before any engine package loads.

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import type { Role } from '../ctl/protocol.js'
import { StartArgsError, assertStartPosture, startPostureOf, type StartPosture } from './posture.js'

export { StartArgsError }

export type StartArgsCode =
  | 'state-missing'
  | 'state-relative'
  | 'state-in-repo'
  | 'label-shape'
  | 'layout-party'
  | 'party-missing'
  | 'party-shape'
  | 'party-reserved'
  | 'production-party'
  | 'relay-missing'
  | 'colocate-shape'
  | 'colocate-duplicate'
  | 'colocate-primary'
  | 'colocate-label'
  | 'colocate-voter'
  | 'posture-role'
  | 'posture-shape'
  | 'max-peers-shape'
  | 'max-peers'
  | 'relay-ready-ms'
  | 'boot-timeout-ms'
  | 'max-runtime-ms'
  | 'unknown-flag'

export interface StartOptions {
  role: Role
  /** The `--state` basename. */
  label: string
  partyId: string
  /** The resolved `--state` dir: `<run>/<party>/<label>`. */
  peerDir: string
  partyDir: string
  runRoot: string
  repoRoot: string
  relayEnvPath: string
  colocate: string[] | null
  /** Every peer this process serves, the primary LAST (so its ctl.port is the last file written). */
  labels: Array<{ label: string, role: Role }>
  acceptTokenAttestations: boolean
  posture: StartPosture
  instruments: boolean
  maxPeers: number
  relayReadyMs: number
  bootTimeoutMs: number
  maxRuntimeMs: number
}

export interface StartArgsEnv {
  totalmem: () => number
  /** The repo root (trailing separator optional): a state dir inside it is refused. */
  repoRoot: string
  defaultMaxPeers: (totalmem: number) => number
}

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'state',
  'relay',
  'party',
  'colocate',
  'instruments',
  'acceptTokenAttestations',
  'maxPeers',
  'relayReadyMs',
  'bootTimeoutMs',
  'maxRuntimeMs'
])

export const LABEL_RE = /^[a-z][a-z0-9-]{0,31}$/
export const PARTY_RE = /^[a-z0-9][a-z0-9-]{2,62}$/
const KH_LABEL_RE = /^kh-[a-z0-9][a-z0-9-]*$/

export const DEFAULT_RELAY_READY_MS = 90_000
export const DEFAULT_BOOT_TIMEOUT_MS = 300_000
export const DEFAULT_MAX_RUNTIME_MS = 14_400_000

function deepestExistingAncestor(path: string): string {
  let cur = path
  for (;;) {
    if (existsSync(cur)) return cur
    const parent = dirname(cur)
    if (parent === cur) return cur
    cur = parent
  }
}

function insideRepo(path: string, repoRoot: string): boolean {
  const root = resolve(repoRoot)
  let real: string
  try {
    real = realpathSync(deepestExistingAncestor(path))
  } catch {
    real = deepestExistingAncestor(path)
  }
  let realRoot = root
  try {
    realRoot = realpathSync(root)
  } catch {
    // the root does not exist: nothing can be inside it
  }
  return real === realRoot || real.startsWith(realRoot + sep)
}

function integer(value: unknown, min: number, max: number, code: StartArgsCode): number {
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || !/^\d{1,12}$/.test(text)) throw new StartArgsError(code)
  const n = Number(text)
  if (!Number.isInteger(n) || n < min || n > max) throw new StartArgsError(code)
  return n
}

export function parseStartArgs(role: Role, args: Record<string, unknown>, env: StartArgsEnv): StartOptions {
  for (const key of Object.keys(args)) if (!KNOWN_KEYS.has(key)) throw new StartArgsError('unknown-flag')

  // state
  const state = args.state
  if (typeof state !== 'string' || state.length === 0) throw new StartArgsError('state-missing')
  if (!isAbsolute(state)) throw new StartArgsError('state-relative')
  const peerDir = resolve(state)
  if (insideRepo(peerDir, env.repoRoot)) throw new StartArgsError('state-in-repo')
  const label = basename(peerDir)
  if (!LABEL_RE.test(label)) throw new StartArgsError('label-shape')

  // party
  const party = args.party
  if (typeof party !== 'string' || party.length === 0) throw new StartArgsError('party-missing')
  if (!PARTY_RE.test(party)) throw new StartArgsError('party-shape')
  const partyDir = dirname(peerDir)
  if (basename(partyDir) !== party) throw new StartArgsError('layout-party')

  // relay
  const relay = args.relay
  if (typeof relay !== 'string' || relay.length === 0 || !isAbsolute(relay)) throw new StartArgsError('relay-missing')

  // colocate
  let colocate: string[] | null = null
  if (args.colocate !== undefined) {
    if (role === 'voter') throw new StartArgsError('colocate-voter')
    if (typeof args.colocate !== 'string') throw new StartArgsError('colocate-shape')
    const entries = args.colocate.split(',')
    if (entries.length < 2 || entries.some((e) => !LABEL_RE.test(e))) throw new StartArgsError('colocate-shape')
    if (new Set(entries).size !== entries.length) throw new StartArgsError('colocate-duplicate')
    if (!entries.includes(label)) throw new StartArgsError('colocate-primary')
    for (const e of entries) if (e !== label && e !== 'officer' && !KH_LABEL_RE.test(e)) throw new StartArgsError('colocate-label')
    colocate = entries
  }
  const labels: Array<{ label: string, role: Role }> = []
  for (const e of colocate ?? []) if (e !== label) labels.push({ label: e, role: e === 'officer' ? 'officer' : 'keyholder' })
  labels.push({ label, role })

  // posture (shape, role, reserved party, 67-20)
  const postureArgs: Record<string, unknown> = {}
  if (args.acceptTokenAttestations !== undefined) postureArgs.acceptTokenAttestations = args.acceptTokenAttestations
  assertStartPosture({ role, partyId: party, args: postureArgs })
  const posture = startPostureOf(postureArgs)
  const acceptTokenAttestations = postureArgs.acceptTokenAttestations === true

  if (args.instruments !== undefined && args.instruments !== true) throw new StartArgsError('unknown-flag')
  const instruments = args.instruments === true

  // numeric bounds
  const maxPeers = args.maxPeers === undefined ? env.defaultMaxPeers(env.totalmem()) : integer(args.maxPeers, 1, 9999, 'max-peers-shape')
  if (labels.length > maxPeers) throw new StartArgsError('max-peers')
  const relayReadyMs = args.relayReadyMs === undefined ? DEFAULT_RELAY_READY_MS : integer(args.relayReadyMs, 1000, 90_000, 'relay-ready-ms')
  const bootTimeoutMs = args.bootTimeoutMs === undefined ? DEFAULT_BOOT_TIMEOUT_MS : integer(args.bootTimeoutMs, 30_000, 900_000, 'boot-timeout-ms')
  const maxRuntimeMs = args.maxRuntimeMs === undefined ? DEFAULT_MAX_RUNTIME_MS : integer(args.maxRuntimeMs, 60_000, 86_400_000, 'max-runtime-ms')

  return {
    role,
    label,
    partyId: party,
    peerDir,
    partyDir,
    runRoot: dirname(partyDir),
    repoRoot: resolve(env.repoRoot),
    relayEnvPath: resolve(relay),
    colocate,
    labels,
    acceptTokenAttestations,
    posture,
    instruments,
    maxPeers,
    relayReadyMs,
    bootTimeoutMs,
    maxRuntimeMs
  }
}
