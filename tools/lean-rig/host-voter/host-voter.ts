// host-voter.ts — ONE host voter standing in for a phone in the rehearsal (phase 64 plan 21, D-19).
//
// One process = one Voter-app peer. It composes the shipped vote-engine pieces in the order a phone runs them:
// join code from a scratch file -> Voter-shaped CadreNode on the relay -> product joinNetwork -> sealed registration
// request -> synthetic association (request, bounded recorded challenge poll, answer) -> wait for the 'a' decision ->
// signed vote entry and voter entry -> PoolAgent against members[0] of the invitation.
//
// REHEARSAL COMMAND (one process per host voter; 64-26..28 run two of them in the background, labels hv1 and hv2,
// after the run's founding and before the officer approves; cwd packages/vote-engine):
//
//   LOG=<abs>/hv1.log; JSON=<abs>/hv1.json
//   if [ -e "$LOG" ] || [ -e "$JSON" ]; then echo "REFUSE: hv1 exists (never overwrite, D-21)"; else
//     cd "$REPO/packages/vote-engine" && env -u NODE_OPTIONS FORCE_COLOR=0 TS_NODE_PROJECT=./tsconfig.test.json \
//       HV_LABEL=hv1 HV_CODE_FILE=<abs scratch code file> HV_RELAY=<RELAY_MULTIADDR from session.md> HV_RESULTS="$JSON" \
//       HV_VOTE_OUT=<abs scratch>/hv1-vote.json HV_CLOCK_OFFSET_MS=<host minus AVD ms, measured fresh> \
//       perl -e 'alarm 3900; exec @ARGV' node --import "$HV/clock-offset.mjs" --import ./register-ts-node.mjs \
//       --experimental-specifier-resolution=node "$HV/host-voter.ts" > "$LOG" 2>&1
//   fi
//   grep '^RESULT ' "$LOG" | tail -1; grep '^STAGE ' "$LOG" | tail -1; grep -cE '^\[ *[0-9]+ms\] FAIL ' "$LOG"
//
// Env knobs (closed set; anything else is ignored and listed in RESULT ignoredEnv by name only):
//   HV_RESULTS           required, absolute; neither it nor <it minus .json>.late.json may exist
//   HV_CODE_FILE         required (not in selfcheck): absolute scratch file, realpath outside the repo, not world-readable
//   HV_RELAY             required (not in selfcheck): the relay multiaddr (/ws/ or /wss/, and /p2p/); bootstrapNodes and relayAddrs
//   HV_LABEL             required: hv<N>
//   HV_PARTY_ID          default votetorrent (both apps' PARTY_ID)
//   HV_VOTE_OUT          absolute scratch path outside the repo, written wx, mode 0600: canonical vote entries (holds nonces)
//   HV_ELECTION_ID       default: the Voter's pickElectionId rule over getElections()
//   HV_REGISTRANT_FILE   absolute scratch JSON {firstName, lastName, details: [{name, value}]}
//   HV_SELECTIONS_FILE   absolute scratch JSON {questionCode: [optionCode]}; default option index (N-1) mod options
//   HV_SEND_GATE_FILE    when set: STAGE ready-to-send, then wait (bounded) for this file before pooling
//   HV_CLOCK_OFFSET_MS   integer, abs <= 600000, read by clock-offset.mjs; default 0 = no patch
//   HV_DECISION_WAIT_MS  default 900000, the host's own bound for each decision wait (NOT a challenge expiry)
//   HV_SYNC_WAIT_MS      default 180000, the bound for replicated reads (intake key, election, Association row)
//   HV_ADMISSION_TIMEOUT_MS  default unset (the product's 20000): joinNetwork's self-admission wait after a failed redeem (notes 19 E86, user yes)
//   HV_MAX_RUNTIME_MS    default 3600000, an internal deadline that writes results (FAIL runtime-budget) and exits
//   HV_STOP_AFTER        joined | associated | vote-built; the verdict is then PARTIAL unless HIT
//   HV_MODE              selfcheck: runs I1, the redact self-test and the synthetic-shape self-test; starts NO node
//
// Rules: no product edits; the 1 MiB cap is only READ by a size probe; nothing failed is re-submitted; secrets never
// logged; synthetic association only; never used in the hardware runs (D-06, D-14, D-15, D-19, D-21, D-23).
//
// Memory facts folded in: the pool decisions (per-vote encryption, the rendezvous, a minimum block of 3, a
// throwaway pool identity per ballot); the voter is a full cadre peer; the authority signs Registrant and Association
// records (the voter only stages requests and answers); no challenge expiry exists, so the waits are the host's own
// bounded polls; strandAddrRefreshMs 30000 because the empty-answer stamp otherwise waits 10 min; FRET 1.0.2 stops
// slowly and read-repair is lazy (polls, not single reads); the AVD clocks run behind the host (clock-offset.mjs).

import './mocha-shim.js'
import { readFileSync, writeFileSync, statSync, realpathSync, existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { p256 } from '@noble/curves/nist.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { NetworksEngine } from '../../../packages/vote-engine/src/networks/networks-engine.js'
import { decodeNetworkJoinCode } from '../../../packages/vote-engine/src/networks/join-code.js'
import { joinNetwork, type NetworkJoinStep } from '../../../packages/vote-engine/src/networks/network-join.js'
import { registerDbPlugins, declareViewsInMain, verifySigP256 } from '../../../packages/vote-engine/src/database/initialize.js'
import { NetworkEngine } from '../../../packages/vote-engine/src/network/network-engine.js'
import { ElectionsEngine } from '../../../packages/vote-engine/src/elections/elections-engine.js'
import { AssociationEngine } from '../../../packages/vote-engine/src/association/association-engine.js'
import { RegistrationEngine } from '../../../packages/vote-engine/src/registration/registration-engine.js'
import { P2pRegistrationTransport } from '../../../packages/vote-engine/src/registration/transport/p2p-registration-transport.js'
import { P2pAssociationTransport } from '../../../packages/vote-engine/src/association/transport/p2p-association-transport.js'
import { computeAssociationRequestDigest } from '../../../packages/vote-engine/src/association/transport/association-request-digest.js'
import { createIntakeSealer, intakeQueryPortFromStrandPort, readIntakePolicyFrom } from '../../../packages/vote-engine/src/intake/index.js'
import { checkVotingKey } from '../../../packages/vote-engine/src/voting/vote-signing.js'
import { makeVoteNonce, buildVoteEntry, voterEntryDigest } from '../../../packages/vote-engine/src/voting/vote-entries.js'
import { canonicalJson } from '../../../packages/vote-engine/src/voting/canonical.js'
import { encryptVoteEntry } from '../../../packages/vote-engine/src/key-release/election-block.js'
import { PoolAgent, createLibp2pRendezvousClient, createPoolIdentity, commitPoolBlock } from '../../../packages/vote-engine/src/pool/index.js'
import { digestToBytes } from '../../../packages/vote-engine/src/utils.js'
import { VOTETORRENT_SCHEMA_SQL } from '../../../packages/vote-engine/src/database/schema-sql.js'
import { makeP256TestKey, signDigestP256 } from '../../../packages/vote-engine/test/fixtures/p256-signer.js'
import { randomTestKeyPair } from '../../../packages/vote-engine/test/fixtures/keys.js'

// ---------------------------------------------------------------------------------------------
// Exports used by selftest.ts
// ---------------------------------------------------------------------------------------------
export const HOST_VOTER_SYNTHETIC_MARKER = 'vt64-host-voter-synthetic-not-hardware'
export const HOST_VOTER_STAGES: readonly string[] = [
  'started', 'joined', 'intake-ready', 'registration-staged', 'association-staged', 'challenge-received',
  'challenge-answered', 'associated', 'eligible', 'vote-built', 'voting-open', 'ready-to-send', 'pooling', 'committed'
]
export type HostVoterVerdict = 'COMMITTED' | 'PARTIAL' | 'FAIL' | 'HIT' | 'VOID' | 'SELFCHECK-PASS' | 'SELFCHECK-FAIL'

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

/**
 * A synthetic Android attestation. It mirrors the real producer's Android shape:
 * packages/attestation-native/src/real-attestation-producer.ts:549-565. It is NOT hardware-backed and carries no
 * X.509 chain: only the dev StubAttestationVerifier accepts it (it checks only the platform nonce).
 */
export function buildSyntheticAndroidAttestation (a: { nonce: string, deviceKey: string, deviceId: string, now: number }): any {
  return {
    publicKey: a.deviceKey,
    deviceId: a.deviceId,
    attestationTime: a.now,
    certificateChain: [b64(HOST_VOTER_SYNTHETIC_MARKER + ':throwaway')],
    platformDetails: {
      type: 'Android',
      safetyNetAttestation: HOST_VOTER_SYNTHETIC_MARKER,
      keystorePublicKey: a.deviceKey,
      nonce: a.nonce,
      deviceKeyCertificateChain: [b64(HOST_VOTER_SYNTHETIC_MARKER + ':voting-key')]
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The CLI body runs only when this file is the entry point
// ---------------------------------------------------------------------------------------------
const isMain = (() => {
  try { return process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url } catch { return false }
})()

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')
const CAP_BYTES = 1_048_576 // the cited protocol-limits value, hard-coded for comparison only
const T0 = performance.now()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------------------------
// Harness core: secrets registry, redaction, logging, checks, classifier, recorders
// ---------------------------------------------------------------------------------------------
const SECRETS = new Set<string>()
const WINDOWS = new Set<string>() // every 16-char window of a windowed secret
function secret (s: unknown, opts?: { windows?: boolean }): string {
  if (typeof s !== 'string') return String(s)
  if (s.length >= 8) SECRETS.add(s)
  if (opts?.windows === true && s.length >= 16) for (let i = 0; i + 16 <= s.length; i++) WINDOWS.add(s.slice(i, i + 16))
  return s
}
function redact (s: unknown): string {
  let out = String(s)
  for (const k of SECRETS) if (out.includes(k)) out = out.split(k).join('<secret>')
  if (WINDOWS.size > 0 && out.length >= 16) {
    const mask = new Uint8Array(out.length)
    let any = false
    for (let i = 0; i + 16 <= out.length; i++) {
      if (WINDOWS.has(out.slice(i, i + 16))) { any = true; mask.fill(1, i, i + 16) }
    }
    if (any) {
      let res = ''
      let inMask = false
      for (let i = 0; i < out.length; i++) {
        if (mask[i]) { if (!inMask) res += '<secret>'; inMask = true } else { inMask = false; res += out[i] }
      }
      out = res
    }
  }
  out = out.replace(/[0-9a-fA-F]{64}/g, '<hex64>')
  const home = process.env.HOME
  if (REPO_ROOT.length > 1) out = out.split(REPO_ROOT).join('$REPO')
  if (home !== undefined && home.length > 1) out = out.split(home).join('$HOME')
  return out
}
const SM_RE = /Failed to get super-majority: (\d+\/\d+) approvals/
/** When no wall signal was classified, a stray wall literal in text is neutralised so it can never read as a hit. */
function scrubWall (s: string): string {
  return s.replace(/Failed to get super-majority: (\d+\/\d+) approvals/g, 'sm-refusal $1').replace(/Torn[A]ctionError/g, 'torn-refusal')
}

const lines: string[] = []
function log (cat: string, msg: string): void {
  const t = Math.round(performance.now() - T0)
  const line = `[${String(t).padStart(6)}ms] ${cat.padEnd(8)} ${redact(msg)}`
  lines.push(line)
  console.log(line)
}
const results: Array<{ id: string, check: string, pass: boolean, detail?: string }> = []
function check (id: string, name: string, pass: boolean, detail?: unknown): boolean {
  const d = detail === undefined ? undefined : redact(typeof detail === 'string' ? detail : JSON.stringify(detail))
  results.push({ id, check: name, pass, ...(d !== undefined ? { detail: d } : {}) })
  log(pass ? 'PASS' : 'FAIL', `${id} ${name}${d ? `  — ${d}` : ''}`)
  return pass
}

const events: any[] = []
const lateErrors: any[] = []
const wall: { clusterRequests: number, maxRequestBytes: number, oversized: number, superMajority: number, torn: number, signals: Array<{ where: string, kind: string }> } =
  { clusterRequests: 0, maxRequestBytes: 0, oversized: 0, superMajority: 0, torn: 0, signals: [] }
let transferLimitErrors = 0
const pollErrors: { count: number, byWhere: Record<string, number>, signals: number } = { count: 0, byWhere: {}, signals: 0 }

interface Classified { signals: Array<'super-majority' | 'torn'>, names: string[], transferLimit: boolean }
/** Walks `cause` and `errors[]` breadth-first to depth 6 inclusive. Never branches on message text of other errors. */
function classify (err: unknown): Classified {
  const out: Classified = { signals: [], names: [], transferLimit: false }
  const queue: Array<{ e: unknown, d: number }> = [{ e: err, d: 0 }]
  const seen = new Set<unknown>()
  while (queue.length > 0) {
    const { e, d } = queue.shift()!
    if (e === null || e === undefined || d > 6) continue
    if (typeof e === 'object') {
      if (seen.has(e)) continue
      seen.add(e)
    }
    const o: any = e
    const name = typeof o?.name === 'string' ? o.name : ''
    const msg = typeof o?.message === 'string' ? o.message : (typeof e === 'string' ? e : '')
    if (name && /^[A-Za-z0-9]{1,60}$/.test(name) && !out.names.includes(name) && out.names.length < 12) out.names.push(name)
    if (SM_RE.test(msg)) out.signals.push('super-majority')
    if (name === 'Torn' + 'Action' + 'Error') out.signals.push('torn')
    if (name === 'TransferLimitError') out.transferLimit = true
    if (o?.cause !== undefined) queue.push({ e: o.cause, d: d + 1 })
    if (Array.isArray(o?.errors)) for (const x of o.errors) queue.push({ e: x, d: d + 1 })
  }
  return out
}
function safeMsg (err: unknown, cls: Classified): string {
  const raw = redact(typeof (err as any)?.message === 'string' ? (err as any).message : String(err)).slice(0, 200)
  return cls.signals.length > 0 ? raw : scrubWall(raw)
}
function noteSignals (where: string, cls: Classified): void {
  for (const s of cls.signals) {
    if (s === 'super-majority') wall.superMajority++
    else wall.torn++
    wall.signals.push({ where, kind: s })
  }
  if (cls.transferLimit) transferLimitErrors++
}
function recordError (where: string, err: unknown, path: 'write' | 'read' | 'late'): Classified {
  const cls = classify(err)
  if (events.length < 400) events.push({ t: Math.round(performance.now() - T0), where, path, signals: cls.signals, names: cls.names, msg: safeMsg(err, cls) })
  noteSignals(where, cls)
  return cls
}
/** The throw of a poll read is recorded in pollErrors, never swallowed (D-21). */
function recordPollError (where: string, err: unknown): void {
  const cls = classify(err)
  pollErrors.count++
  pollErrors.byWhere[where] = (pollErrors.byWhere[where] ?? 0) + 1
  if (cls.signals.length > 0) pollErrors.signals += cls.signals.length
  if (events.length < 400 && (pollErrors.byWhere[where] ?? 0) <= 3) events.push({ t: Math.round(performance.now() - T0), where, path: 'poll', signals: cls.signals, names: cls.names, msg: safeMsg(err, cls) })
  noteSignals(where, cls)
  log('POLLERR', `${where} ${cls.names.join('+')}`)
}
interface PollResult<T> { ok: boolean, value: T | undefined, polls: number, waitedMs: number }
/**
 * Bounded, recorded poll. The first read runs immediately. A throwing read is pushed to pollErrors (with its
 * classification) and polling continues to the deadline. Replaces the harness pollUntil, which swallows throws.
 */
async function boundedPoll<T> (where: string, read: () => Promise<T>, until: (v: T) => boolean, o: { timeoutMs: number, intervalMs: number }): Promise<PollResult<T>> {
  const start = Date.now()
  let polls = 0
  let last: T | undefined
  for (;;) {
    polls++
    try {
      last = await read()
      if (until(last)) return { ok: true, value: last, polls, waitedMs: Date.now() - start }
    } catch (e) {
      recordPollError(where, e)
    }
    if (Date.now() - start + o.intervalMs > o.timeoutMs) return { ok: false, value: last, polls, waitedMs: Date.now() - start }
    await sleep(o.intervalMs)
  }
}
const READ_NAME = /^(get|resolve|query|is|read|poll)/
/** A Proxy that records every throw or rejection of a function property and rethrows. Product behaviour is unchanged. */
function instrument<T extends object> (obj: T, label: string): T {
  return new Proxy(obj, {
    get (target: any, prop: string | symbol) {
      const v = target[prop]
      if (typeof v !== 'function' || typeof prop !== 'string') return v
      const path = READ_NAME.test(prop) ? 'read' : 'write'
      return (...args: unknown[]) => {
        try {
          const r = v.apply(target, args)
          if (r && typeof r.then === 'function') return r.catch((e: unknown) => { recordError(`${label}.${prop}`, e, path); throw e })
          return r
        } catch (e) {
          recordError(`${label}.${prop}`, e, path)
          throw e
        }
      }
    }
  })
}

function installLateHandlers (): void {
  const onLate = (e: unknown) => {
    const cls = classify(e)
    lateErrors.push({ t: Math.round(performance.now() - T0), signals: cls.signals, names: cls.names })
    noteSignals('late', cls)
  }
  process.on('uncaughtException', onLate)
  process.on('unhandledRejection', onLate)
}

let stallMaxMs = 0
let stallTimer: ReturnType<typeof setInterval> | undefined
function startStallMonitor (): void {
  let lastTick = performance.now()
  stallTimer = setInterval(() => {
    const now = performance.now()
    const drift = now - lastTick - 100
    lastTick = now
    if (drift > stallMaxMs) stallMaxMs = Math.round(drift)
    if (drift > 500) log('STALL', `event loop stalled ${Math.round(drift)}ms`)
  }, 100)
  stallTimer.unref()
}

// ---------------------------------------------------------------------------------------------
// I1 — the classifier self-test (synthetic chains are built from fragments and fed to classify() only)
// ---------------------------------------------------------------------------------------------
function classifierSelfTest (): boolean {
  const smMsg = 'Failed to get ' + 'super-' + 'majority: 1/3 approvals (needed 3, 0 rejections)'
  const sm = classify(new Error('outer', { cause: new Error('mid', { cause: new Error(smMsg) }) }))
  const tornErr = Object.assign(new Error('x'), { name: 'Torn' + 'Action' + 'Error' })
  const torn = classify(new AggregateError([tornErr], 'agg'))
  const plain = classify(new Error('plain failure'))
  let deep: Error = new Error(smMsg)
  for (let i = 0; i < 7; i++) deep = new Error('wrap' + i, { cause: deep })
  const depth7 = classify(deep)
  return sm.signals[0] === 'super-majority' && torn.signals[0] === 'torn' && plain.signals.length === 0 && depth7.signals.length === 0
}

// ---------------------------------------------------------------------------------------------
// State shared by the run and the writer
// ---------------------------------------------------------------------------------------------
const LABEL_RE = /^hv[1-9]$/
const env = process.env
const KNOWN_ENV = new Set(['HV_RESULTS', 'HV_CODE_FILE', 'HV_RELAY', 'HV_LABEL', 'HV_PARTY_ID', 'HV_VOTE_OUT', 'HV_ELECTION_ID', 'HV_REGISTRANT_FILE',
  'HV_SELECTIONS_FILE', 'HV_SEND_GATE_FILE', 'HV_CLOCK_OFFSET_MS', 'HV_DECISION_WAIT_MS', 'HV_SYNC_WAIT_MS', 'HV_ADMISSION_TIMEOUT_MS', 'HV_MAX_RUNTIME_MS', 'HV_STOP_AFTER', 'HV_MODE'])
const numEnv = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
const RESULTS_PATH = env.HV_RESULTS ?? ''
const LABEL = env.HV_LABEL ?? ''
const STOP_AFTER = env.HV_STOP_AFTER
const DECISION_WAIT_MS = numEnv(env.HV_DECISION_WAIT_MS, 900_000)
const SYNC_WAIT_MS = numEnv(env.HV_SYNC_WAIT_MS, 180_000)
const ADMISSION_TIMEOUT_MS = env.HV_ADMISSION_TIMEOUT_MS === undefined ? undefined : numEnv(env.HV_ADMISSION_TIMEOUT_MS, 20_000)
const MAX_RUNTIME_MS = numEnv(env.HV_MAX_RUNTIME_MS, 3_600_000)
const lateResultsPath = (p: string) => p.replace(/\.json$/, '') + '.late.json'

const stagesMs: Record<string, number> = {}
let lastStage = 'none'
function stage (token: string): void {
  stagesMs[token] = Math.round(performance.now() - T0)
  lastStage = token
  const line = `STAGE ${token}`
  lines.push(line)
  console.log(line)
}

const res: any = {
  code: { v: null, chars: null },
  join: { ok: false, ms: null, hiddenOpenFailures: 0, fingerprintMatch: false, factoryFounder: false },
  rendezvous: { source: 'members[0]', membersLength: null, peerTail: null },
  registration: { route: 'peer', staged: false, ms: null },
  association: { staged: false, challenge: null, answered: false, decision: null, attestation: 'synthetic-android', acceptableBy: 'dev-stub-verifier-only' },
  eligibility: { ok: false },
  vote: { ballots: 0, entrySha256: [] as string[], voteOutWritten: false },
  pool: { ballots: [] as any[] }
}
const instrumentRes = { I1: false, I2: false }
let failReason: string | null = null
let voidReason: string | null = null
let stoppedAfter: string | null = null
let committedAll = false
class HvStop extends Error { constructor (readonly why: string) { super(why) } }
const closedToken = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48)
function fail (reason: string): never { throw new HvStop(closedToken(reason)) }

function computeVerdict (): { verdict: HostVoterVerdict, reason?: string } {
  if (voidReason !== null) return { verdict: 'VOID', reason: voidReason }
  const lateSignals = lateErrors.some((l) => l.signals?.length > 0)
  if (wall.oversized > 0 || wall.superMajority > 0 || wall.torn > 0 || lateSignals || res.join.hiddenOpenFailures > 0) {
    return { verdict: 'HIT', reason: wall.oversized > 0 ? 'oversized' : (wall.superMajority > 0 ? 'super-majority' : (res.join.hiddenOpenFailures > 0 ? 'masked-hit' : 'torn-or-late-signal')) }
  }
  if (failReason !== null) return { verdict: 'FAIL', reason: failReason }
  if (stoppedAfter !== null) return { verdict: 'PARTIAL', reason: `stop-after-${stoppedAfter}` }
  if (committedAll && HOST_VOTER_STAGES.every((s) => stagesMs[s] !== undefined || (s === 'ready-to-send' && env.HV_SEND_GATE_FILE === undefined)) && res.pool.ballots.length > 0 && res.pool.ballots.every((b: any) => b.outcome === 'committed')) return { verdict: 'COMMITTED' }
  return { verdict: 'FAIL', reason: 'incomplete' }
}

function scanSecrets (extra: string): { whole: number, windows: number } {
  const hay = lines.join('\n') + '\n' + JSON.stringify({ events, lateErrors, wall, res, results }) + '\n' + extra
  let whole = 0
  let windows = 0
  for (const s of SECRETS) if (hay.includes(s)) whole++
  if (WINDOWS.size > 0) {
    for (let i = 0; i + 16 <= hay.length; i++) {
      if (WINDOWS.has(hay.slice(i, i + 16))) { windows++; i += 15 }
    }
  }
  return { whole, windows }
}

function buildResult (v: { verdict: HostVoterVerdict, reason?: string }, secretLeaks: number): any {
  const unknownEnv = Object.keys(env).filter((k) => k.startsWith('HV_') && !KNOWN_ENV.has(k)).sort()
  const clk = (globalThis as any).__hvClockOffset ?? { offsetMs: 0, applied: false }
  return {
    tool: 'host-voter', label: LABEL, verdict: v.verdict, ...(v.reason ? { reason: v.reason } : {}), stage: lastStage, stages: stagesMs,
    code: res.code, join: res.join, rendezvous: res.rendezvous, registration: res.registration, association: res.association,
    eligibility: res.eligibility, vote: res.vote, pool: res.pool,
    wall: { ...wall }, pollErrors, transferLimitErrors, lateErrors: { count: lateErrors.length, names: [...new Set(lateErrors.flatMap((l: any) => l.names ?? []))].slice(0, 12) },
    clock: { offsetMs: clk.offsetMs, applied: clk.applied }, stallMaxMs, secretLeaks, instrument: instrumentRes, ignoredEnv: unknownEnv,
    totalMs: Math.round(performance.now() - T0)
  }
}

// ---------------------------------------------------------------------------------------------
// The Voter's own glue, mirrored (never edited)
// ---------------------------------------------------------------------------------------------
function mapLocalStorage (store = new Map<string, unknown>()): any {
  return {
    async getItem (k: string) { return store.has(k) ? store.get(k) : undefined },
    async setItem (k: string, v: unknown) { store.set(k, v) },
    async removeItem (k: string) { store.delete(k) },
    async clear () { store.clear() }
  }
}
function mapSlot (disk: Map<string, string>, key: string): any {
  return { async load () { return disk.get(key) }, async save (text: string) { disk.set(key, text) } }
}
function scopedMemoryProvider (MemoryRawStorage: any) {
  const stores = new Map<string, any>()
  return (scope: string) => {
    let s = stores.get(scope)
    if (!s) { s = new MemoryRawStorage(); stores.set(scope, s) }
    return s
  }
}
const trailingPeer = (addr: string) => addr.split('/p2p/').pop() ?? ''
const sha12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)

// mirrors apps/VoteTorrentVoter/src/engines/strand-port-adapter.ts:39-58
function createVoterStrandPort (db: any): any {
  return {
    async query (sql: string, params: Record<string, unknown>): Promise<any[]> {
      const rows: any[] = []
      for await (const row of db.eval(sql, params)) rows.push(row)
      return rows
    },
    async mutate (sql: string, params: Record<string, unknown>): Promise<void> { await db.exec(sql, params) },
    async close (): Promise<void> {}
  }
}
// mirrors apps/VoteTorrentVoter/src/engines/strand-port-adapter.ts:75-94
function base64UrlDigestToBytes (value: unknown, site: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) throw new Error('host-voter: digest is not a 32-byte base64url value (' + site + ')')
  const bytes = digestToBytes(value)
  if (bytes.length !== 32) throw new Error('host-voter: digest is not a 32-byte base64url value (' + site + ')')
  return bytes
}
// mirrors apps/VoteTorrentVoter/src/engines/strand-port-adapter.ts:102-129
function createRegistrationRequestDigestFn (port: any): (init: any, requesterKey: string) => Promise<Uint8Array> {
  return async (init, requesterKey) => {
    const payload = JSON.stringify(init.payload)
    const payloadCidRows = await port.query('select Digest(:payload) as d', { payload })
    const payloadCid = payloadCidRows[0]?.d
    if (payloadCid == null) throw new Error('host-voter: Digest() returned null for Payload')
    const digestRows = await port.query('select Digest(:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d', {
      id: init.id, rowAuthorityId: init.authorityId, requesterKey, issuerType: init.issuerType ?? 'registrant', bridgeId: init.bridgeId ?? null, payloadCid, submittedAt: init.submittedAt
    })
    return base64UrlDigestToBytes(digestRows[0]?.d, 'registration-request')
  }
}
// mirrors apps/VoteTorrentVoter/src/engines/strand-port-adapter.ts:137-154
function createAssociationRequestDigestFn (port: any): (init: any, requesterKey: string) => Promise<Uint8Array> {
  return async (init, requesterKey) => {
    const rows = await port.query('select Digest(:id, :rowAuthorityId, :registrantId, :deviceKey, :electionId, :submittedAt) as d', {
      id: init.id, rowAuthorityId: init.authorityId, registrantId: init.registrantId, deviceKey: requesterKey, electionId: init.electionId ?? null, submittedAt: init.submittedAt
    })
    return base64UrlDigestToBytes(rows[0]?.d, 'association-request')
  }
}
// mirrors apps/VoteTorrentVoter/src/engines/strand-port-adapter.ts:162-177
function createAssociationAttestationDigestFn (port: any): (answer: any, requesterKey: string) => Promise<Uint8Array> {
  return async (answer) => {
    const rows = await port.query('select Digest(:requestId, :nonce, :attestationJson, :deviceHash) as d', {
      requestId: answer.requestId, nonce: answer.nonce, attestationJson: JSON.stringify(answer.attestation), deviceHash: answer.deviceHash ?? null
    })
    return base64UrlDigestToBytes(rows[0]?.d, 'association-attestation')
  }
}
// mirrors apps/VoteTorrentVoter/src/engines/election-read.ts:60-80 (D-02's election-identity rule)
function pickElectionId (summaries: Array<{ id: string, date: number }>, fallbackId: string | undefined): string | undefined {
  if (summaries.length === 0) return fallbackId
  if (summaries.length === 1) return summaries[0]!.id
  const nowMs = Date.now()
  let best: { id: string, date: number } | undefined
  let bestDiff = Number.POSITIVE_INFINITY
  for (const s of summaries) {
    const diff = Math.abs(s.date - nowMs)
    if (diff < bestDiff || (diff === bestDiff && best !== undefined && s.id < best.id)) { best = s; bestDiff = diff }
  }
  return best?.id
}
// mirrors apps/VoteTorrentVoter/src/engines/voter-network-join.ts:61-67
function invitationExpiresAtMs (invitation: any): number | null {
  const at = invitation?.invite?.expiresAt
  if (typeof at !== 'string' || at.length === 0) return null
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at}Z`)
  return Number.isFinite(ms) ? ms : null
}
// mirrors apps/VoteTorrentVoter/src/engines/voter-network-join.ts:40-59
async function isSelfAdmitted (node: any, verifyInvitationAdmission: any): Promise<boolean> {
  const store = node.getTrustedOwnerStore()
  const db = node.getControlDatabase()
  if (!store || !db) return false
  const selfId = node.peerId.toString()
  const self = (await db.queryCadrePeers()).find((row: any) => row.peerId === selfId)
  if (!self || !(self.vouchSig === null && self.vouchUsage != null)) return false
  const [usages, invites] = await Promise.all([db.queryCadreInviteUsages(), db.queryCadreInvites()])
  const usage = usages.find((u: any) => u.usageStampId === self.vouchUsage)
  const invite = usage === undefined ? undefined : invites.find((i: any) => i.key === usage.inviteKey)
  if (usage === undefined || invite === undefined) return false
  return verifyInvitationAdmission(node.partyId, self, usage, invite, (key: string) => store.has(key))
}
// mirrors apps/VoteTorrentVoter/src/engines/vote-casting.ts:381-382 and :388-397 (digest decode)
const voterEntryDigestBytes = (digest: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(digest)) throw new Error('digest is not 43 base64url characters')
  return digestToBytes(digest)
}

// ---------------------------------------------------------------------------------------------
// Start guards and the CLI
// ---------------------------------------------------------------------------------------------
function printVoid (reason: string, writeResults: boolean): never {
  voidReason = reason
  const result = buildResult({ verdict: 'VOID', reason }, 0)
  if (writeResults && RESULTS_PATH !== '' && !existsSync(RESULTS_PATH)) {
    try { writeFileSync(RESULTS_PATH, JSON.stringify(result, null, 2), { flag: 'wx' }) } catch { /* the RESULT line below still reports */ }
  }
  console.log('RESULT ' + redact(JSON.stringify(result)))
  console.log(`SUMMARY VOID ${lastStage}`)
  process.exit(0)
}

function runSelfcheck (): never {
  installLateHandlers()
  const i1 = classifierSelfTest()
  instrumentRes.I1 = i1
  check('I1', 'classifier self-test (depth-2 chain, aggregate, plain, depth-7 negative)', i1)
  // redact self-test: a registered 40-char secret and a 64-hex run are both masked
  const probeSecret = 'selfcheck-' + randomUUID() + '-zz'
  secret(probeSecret.slice(0, 40), { windows: true })
  const sample40 = probeSecret.slice(0, 40)
  const hex64 = 'ab'.repeat(32)
  const masked = redact(`x ${sample40} y ${hex64} z`)
  const redactOk = !masked.includes(sample40) && !masked.includes(hex64) && masked.includes('<secret>') && masked.includes('<hex64>')
  check('RS', 'redact masks a registered 40-char secret and a 64-hex run', redactOk)
  // the synthetic attestation has the real producer's Android shape
  const att = buildSyntheticAndroidAttestation({ nonce: 'selfcheck-nonce', deviceKey: '02' + 'ab'.repeat(32), deviceId: 'selfcheck-device', now: Date.now() })
  const pd = att.platformDetails
  const b64ok = (a: unknown) => Array.isArray(a) && a.length === 1 && typeof a[0] === 'string' && Buffer.from(a[0], 'base64').toString('utf8').startsWith(HOST_VOTER_SYNTHETIC_MARKER)
  const shapeOk = pd?.type === 'Android' && pd.nonce === 'selfcheck-nonce' && pd.safetyNetAttestation === HOST_VOTER_SYNTHETIC_MARKER && b64ok(att.certificateChain) && b64ok(pd.deviceKeyCertificateChain)
  check('SH', 'synthetic attestation shape (Android type, nonce echoed, marker present, base64 chains)', shapeOk)
  const ok = i1 && redactOk && shapeOk
  const verdict: HostVoterVerdict = ok ? 'SELFCHECK-PASS' : 'SELFCHECK-FAIL'
  const result = buildResult({ verdict }, 0)
  writeFileSync(RESULTS_PATH, JSON.stringify(result, null, 2), { flag: 'wx' })
  console.log('RESULT ' + redact(JSON.stringify(result)))
  console.log(`SUMMARY ${verdict} ${lastStage}`)
  process.exit(0)
}

async function main (): Promise<void> {
  // ---- start guards, all before any node starts
  if (RESULTS_PATH === '' || !RESULTS_PATH.startsWith('/')) printVoid('results-path-required', false)
  if (existsSync(RESULTS_PATH) || existsSync(lateResultsPath(RESULTS_PATH))) printVoid('results-path-exists', false)
  if (!LABEL_RE.test(LABEL)) printVoid('label-required', true)
  const clk = (globalThis as any).__hvClockOffset
  if (clk?.refused !== undefined) printVoid('clock-offset-out-of-range', true)
  if (env.HV_MODE === 'selfcheck') runSelfcheck()
  if (STOP_AFTER !== undefined && !['joined', 'associated', 'vote-built'].includes(STOP_AFTER)) printVoid('stop-after-unknown', true)

  const codeFile = env.HV_CODE_FILE ?? ''
  if (codeFile === '' || !codeFile.startsWith('/')) printVoid('code-file-missing', true)
  if (!existsSync(codeFile)) printVoid('code-file-missing', true)
  const codeReal = realpathSync(codeFile)
  const repoReal = realpathSync(REPO_ROOT)
  if (codeReal === repoReal || codeReal.startsWith(repoReal + '/')) printVoid('code-file-in-repo', true)
  if ((statSync(codeReal).mode & 0o004) !== 0) printVoid('code-file-world-readable', true)
  const RELAY = env.HV_RELAY ?? ''
  if (!/\/wss?\b/.test(RELAY) || !RELAY.includes('/p2p/')) printVoid('relay-required', true)
  const VOTE_OUT = env.HV_VOTE_OUT
  if (VOTE_OUT !== undefined) {
    if (!VOTE_OUT.startsWith('/')) printVoid('vote-out-not-absolute', true)
    const parentReal = realpathSync(VOTE_OUT.replace(/\/[^/]*$/, '') || '/')
    if (parentReal === repoReal || parentReal.startsWith(repoReal + '/')) printVoid('vote-out-in-repo', true)
    if (existsSync(VOTE_OUT)) printVoid('vote-out-exists', true)
  }

  installLateHandlers()
  startStallMonitor()
  const started: any[] = []
  let origSend: any
  let ClusterClient: any
  let finalized = false

  const finalize = async (): Promise<void> => {
    if (finalized) return
    finalized = true
    if (stallTimer !== undefined) clearInterval(stallTimer)
    if (ClusterClient !== undefined && origSend !== undefined) ClusterClient.prototype.send = origSend
    check('I0', 'the size probe saw at least 1 cluster request', wall.clusterRequests >= 1, { clusterRequests: wall.clusterRequests, maxRequestBytes: wall.maxRequestBytes, oversized: wall.oversized })
    const sc = scanSecrets('')
    check('S1', 'no registered secret appears whole, and no 16-char window of a windowed secret, in the run output', sc.whole === 0 && sc.windows === 0, { registered: SECRETS.size, whole: sc.whole, windows: sc.windows })
    const v = computeVerdict()
    const result = buildResult(v, sc.whole + sc.windows)
    writeFileSync(RESULTS_PATH, JSON.stringify(result, null, 2), { flag: 'wx' })
    console.log('RESULT ' + redact(JSON.stringify(result)))
    console.log(`SUMMARY ${v.verdict} ${lastStage}`)
    const lateBefore = lateErrors.length
    for (const n of started.slice().reverse()) {
      try { await Promise.race([n.stop(), sleep(10_000).then(() => { throw new Error('stop-timeout') })]) } catch { /* the late file records what follows */ }
    }
    const after = lateErrors.slice(lateBefore)
    try {
      writeFileSync(lateResultsPath(RESULTS_PATH), JSON.stringify({ lateErrorsAfterStop: { count: after.length, names: [...new Set(after.flatMap((l: any) => l.names ?? []))].slice(0, 12) } }), { flag: 'wx' })
    } catch { /* never rewrite */ }
  }

  const budgetTimer = setTimeout(() => {
    failReason = 'runtime-budget'
    void finalize().then(() => process.exit(0), () => process.exit(0))
  }, MAX_RUNTIME_MS)
  budgetTimer.unref()

  try {
    // ---- instruments (before any node)
    const cadre = await import('@serfab/cadre-core') as any
    const { CadreNode, decodeCadreInvitation, mergeSeedPeers, verifyInvitationAdmission, PersistentTrustedOwnerStore, PersistentBootstrapPeerStore } = cadre
    const dbP2p = await import('@optimystic/db-p2p') as any
    const MemoryRawStorage = dbP2p.MemoryRawStorage
    const { webSockets } = await import('@libp2p/websockets') as any
    const { circuitRelayTransport } = await import('@libp2p/circuit-relay-v2') as any
    const { generateKeyPair } = await import('@libp2p/crypto/keys') as any
    const { multiaddr } = await import('@multiformats/multiaddr') as any

    ClusterClient = dbP2p.ClusterClient
    origSend = ClusterClient.prototype.send
    const encoder = new TextEncoder()
    ClusterClient.prototype.send = async function (this: unknown, message: unknown, options: unknown) {
      try {
        const bytes = encoder.encode(JSON.stringify(message)).byteLength
        wall.clusterRequests++
        if (bytes > wall.maxRequestBytes) wall.maxRequestBytes = bytes
        if (bytes > CAP_BYTES) wall.oversized++
      } catch { /* a probe failure must never change product behaviour */ }
      return origSend.call(this, message, options)
    }
    instrumentRes.I1 = classifierSelfTest()
    check('I1', 'classifier self-test (depth-2 chain, aggregate, plain, depth-7 negative)', instrumentRes.I1)

    // ---- secrets and inputs
    const codeText = secret(readFileSync(codeReal, 'utf8').trim(), { windows: true })
    const decoded = decodeNetworkJoinCode(codeText)
    if (!decoded.ok) fail(`decode-${(decoded as any).reason ?? 'failed'}`)
    const code: any = (decoded as any).code
    res.code = { v: code.v, chars: codeText.length }
    secret(code.invitation, { windows: true })
    let invitation: any
    try { invitation = decodeCadreInvitation(code.invitation) } catch { fail('invitation-malformed') }
    secret(invitation?.invitePrivateKey, { windows: true })
    secret(invitation?.invite?.invitePrivateKey, { windows: true })

    const deviceUserPair = randomTestKeyPair()
    secret(deviceUserPair.privateHex, { windows: true })
    const devicePrivBytes = Uint8Array.from(Buffer.from(deviceUserPair.privateHex, 'hex'))
    // mirrors packages/vote-engine/test/fixtures/harness-workflows.ts:571-579 (makeRequesterSigner)
    const deviceSign = async (digest: Uint8Array) => ({ signature: bytesToHex(secp256k1.sign(digest, devicePrivBytes)), signerKey: deviceUserPair.publicHex, signerUserId: '' })
    const p256Key = makeP256TestKey()
    const p256Priv = p256Key.privBytes
    const p256PubHex = p256Key.pubHex
    secret(bytesToHex(p256Priv), { windows: true })
    const deviceId = secret('hv-synthetic-' + randomUUID(), { windows: true })
    const p256Sign = async (bytes: Uint8Array) => ({ signature: bytesToHex(p256.sign(bytes, p256Priv)), signerKey: p256PubHex, signerUserId: '' })

    // ---- the Voter-shaped node
    // mirrors apps/VoteTorrentVoter/src/providers/CadreNodeProvider.tsx:245-360
    const PARTY_ID = env.HV_PARTY_ID ?? 'votetorrent'
    const disk = new Map<string, string>()
    const local = new Map<string, unknown>()
    const nodeHolder: { current: any } = { current: null }
    const node = new CadreNode({
      privateKey: await generateKeyPair('Ed25519'),
      controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [RELAY] },
      trustedOwners: { store: await PersistentTrustedOwnerStore.open(mapSlot(disk, 'trustedOwners'), PARTY_ID) },
      bootstrapPeers: { store: await PersistentBootstrapPeerStore.open(mapSlot(disk, 'bootstrapPeers'), PARTY_ID) },
      profile: 'transaction',
      requireSignedSchemas: false,
      strandFilter: { mode: 'all' },
      storage: { provider: scopedMemoryProvider(MemoryRawStorage) },
      network: {
        controlCohort: { strandAddrRefreshMs: 30_000 },
        inviteAddressResolver: async () => (nodeHolder.current?.getMultiaddrs?.() ?? []).map((a: any) => a.toString()).filter((a: string) => a.includes('/p2p-circuit')),
        transports: [webSockets(), circuitRelayTransport({ reservationConcurrency: 1 })],
        relayAddrs: [RELAY],
        connectionGater: { denyDialMultiaddr: async () => false }
      },
      hibernation: { enabled: false }
    })
    nodeHolder.current = node
    await node.start()
    started.push(node)
    stage('started')
    log(LABEL, `started transaction ${node.peerId.toString().slice(-8)}`)

    // ---- join, mirrors apps/VoteTorrentVoter/src/engines/voter-network-join.ts:73-116
    const joinedSet = new Set<string>([code.networkHash])
    let hiddenOpenFailures = 0
    // mirrors apps/VoteTorrentVoter/src/engines/rn-db-factory.ts:163-214 (founder: !joined && !hasPeers; a joiner is always false)
    const factoryCache = new Map<string, Promise<any>>()
    const strandFactory = (async (strandId: string) => {
      let p = factoryCache.get(strandId)
      if (!p) {
        p = (async () => {
          const hasPeers = (node.getControlNode()?.getConnections().length ?? 0) > 0
          const founder = !joinedSet.has(strandId) && !hasPeers
          if (founder) res.join.factoryFounder = true
          await node.addStrand({
            strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null },
            sAppConfig: {
              id: 'org.votetorrent',
              version: '1.0.0',
              schema: VOTETORRENT_SCHEMA_SQL.replace(/^\s*declare\s+schema\s+\w+\s*\{/, '').replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '').trim(),
              latencyHint: 'interactive'
            },
            founder
          }).catch(async (e: any) => {
            if (!/AwaitingFirstSync/i.test(e?.name ?? '') && !/first sync/i.test(e?.message ?? '')) throw e
            await node.whenStrandWritable(strandId, { timeoutMs: 120_000 })
          })
          await node.whenStrandWritable(strandId, { timeoutMs: 120_000 })
          const db = node.getStrand(strandId).database.getDatabase()
          db.setSchemaPath(['App', 'main'])
          return db
        })()
        factoryCache.set(strandId, p)
        p.catch((e: unknown) => { hiddenOpenFailures++; res.join.hiddenOpenFailures = hiddenOpenFailures; recordError('joiner.openStrand', e, 'write'); if (factoryCache.get(strandId) === p) factoryCache.delete(strandId) })
      }
      return p
    }) as any
    const networksEngine = new NetworksEngine(mapLocalStorage(local), strandFactory)
    let members: string[] = []
    const steps: NetworkJoinStep[] = []
    const sJ = performance.now()
    const joined: any = await joinNetwork({
      node,
      networksEngine,
      user: undefined as any,
      code,
      decodeInvitation: (encoded: string) => { const inv = decodeCadreInvitation(encoded); members = Array.isArray(inv.members) ? [...inv.members] : []; return inv },
      invitationExpiresAtMs,
      ...(ADMISSION_TIMEOUT_MS === undefined ? {} : { admissionTimeoutMs: ADMISSION_TIMEOUT_MS }),
      isSelfAdmitted: () => isSelfAdmitted(node, verifyInvitationAdmission),
      afterFallbackAdmission: async () => {
        const controlNode = node.getControlNode()
        const memberIds = new Set(members.map(trailingPeer))
        for (const conn of controlNode?.getConnections() ?? []) if (memberIds.has(conn?.remotePeer?.toString())) await conn.close?.().catch(() => undefined)
        const selfId = node.peerId.toString()
        const seeds = (await node.getControlDatabase()?.querySeedPeers().catch(() => [])) ?? []
        if (controlNode) await mergeSeedPeers(controlNode, seeds.filter((p: any) => p.peerId !== selfId)).catch(() => undefined)
        await node.refreshMembershipGate('invitation-redeemed')
        await node.reconcileControlCohort().catch(() => undefined)
      },
      rememberBootstrap: async () => { local.set('voterJoinBootstrap', [...members]) },
      getPeerCount: () => node.getControlNode()?.getConnections().length ?? 0,
      onStep: (s: NetworkJoinStep) => { steps.push(s); log(LABEL, `join step ${s}`) }
    } as any)
    res.join.ms = Math.round(performance.now() - sJ)
    res.join.ok = joined.ok === true
    if (!joined.ok) {
      res.join.reason = closedToken(String(joined.reason))
      fail(`join-${joined.reason}`)
    }
    res.join.outcome = joined.outcome
    res.join.admittedVia = joined.admittedVia
    res.join.fingerprintMatch = joined.fingerprint === (decoded as any).fingerprint
    const hash: string = joined.networkRef.hash
    check('J1', 'the product joinNetwork joined (redeem, joinFromStrand, digest verified, opened)', true, { outcome: joined.outcome, admittedVia: joined.admittedVia, ms: res.join.ms, steps: steps.join('>') })
    check('J2', 'the fingerprint the voter sees equals the code\'s', res.join.fingerprintMatch)
    const ctx: any = networksEngine.getEstablishedContext(hash)
    await registerDbPlugins(ctx.db); await declareViewsInMain(ctx.db)
    // the rendezvous is members[0] of the invitation (vote-send-flow.ts:68 uses addrs[0] of the remembered members)
    res.rendezvous.membersLength = members.length
    res.rendezvous.peerTail = members.length > 0 ? trailingPeer(members[0]!).slice(-8) : null
    stage('joined')
    if (STOP_AFTER === 'joined') { stoppedAfter = 'joined'; throw new HvStop('stop-after') }
    if (members.length === 0) fail('no-rendezvous')

    // ---- registration, mirrors ConfirmationScreen.tsx:244-345
    const port = createVoterStrandPort(ctx.db)
    const reads = intakeQueryPortFromStrandPort(port)
    const intakeKey = await boundedPoll('intake-key', async () => Number((await port.query('select count(*) as n from UserEncryptionKey', {}))[0]?.n ?? 0), (n) => n > 0, { timeoutMs: SYNC_WAIT_MS, intervalMs: 2000 })
    if (!intakeKey.ok) fail('intake-key-timeout')
    stage('intake-ready')
    const networkEngine = instrument(new NetworkEngine(joined.networkRef, mapLocalStorage(local), ctx), 'network') as any
    const details: any = await networkEngine.getDetails()
    const authorityId: string = details.network.primaryAuthorityId
    let electionId = env.HV_ELECTION_ID
    const electionsEngine = instrument(new ElectionsEngine(ctx), 'elections') as any
    if (electionId === undefined) {
      const picked = await boundedPoll('election-list', () => electionsEngine.getElections(), (s: any[]) => s.length > 0, { timeoutMs: SYNC_WAIT_MS, intervalMs: 2000 })
      electionId = pickElectionId((picked.value ?? []) as any[], undefined)
    }
    if (electionId === undefined) fail('no-election')
    const policy: any = await readIntakePolicyFrom(reads, authorityId)
    if (policy?.restBridgeUrl != null) fail('rest-bridge-configured')

    const N = Number(LABEL.slice(2))
    const regFile = env.HV_REGISTRANT_FILE !== undefined ? JSON.parse(readFileSync(env.HV_REGISTRANT_FILE, 'utf8')) : null
    const IGNORED_EXPIRATION_PLACEHOLDER = new Date(0).toISOString() // mirrors ConfirmationScreen.tsx:118
    const registrantId = randomUUID()
    const privateDetails = regFile?.details ?? [{ name: 'email', value: `host-voter-${N}@example.invalid` }]
    const init: any = {
      electionId,
      registrant: { id: registrantId, authorityId, expiration: IGNORED_EXPIRATION_PLACEHOLDER },
      public: { firstName: regFile?.firstName ?? 'Host', lastName: regFile?.lastName ?? `Voter ${N}` },
      private: { expiration: IGNORED_EXPIRATION_PLACEHOLDER, details: privateDetails },
      selective: undefined
    }
    const registrationRequestInit: any = { id: registrantId, authorityId, payload: init, submittedAt: new Date().toISOString() }
    const associationEngine = instrument(new AssociationEngine(ctx), 'association') as any
    const registrationCode = secret(await associationEngine.deriveRegistrationCode(registrantId, deviceSign), { windows: true })
    const sealer = createIntakeSealer({ port: reads, authorityId })
    const openStrand = async () => port
    const sReg = performance.now()
    const registrationTransport = instrument(new P2pRegistrationTransport({ openStrand, computeDigest: createRegistrationRequestDigestFn(port), strandId: hash, sealer } as any), 'regTransport') as any
    await registrationTransport.submitRequest(registrationRequestInit, deviceUserPair.publicHex, deviceSign, { registrationCode })
    res.registration = { route: 'peer', staged: true, ms: Math.round(performance.now() - sReg) }
    stage('registration-staged')

    // ---- association, mirrors ConfirmationScreen.tsx:351-410
    const associationRequestInit: any = { id: randomUUID(), authorityId, registrantId, deviceKey: p256PubHex, electionId, submittedAt: new Date().toISOString() }
    // I2: the strand UDF digest equals the vote-engine TypeScript tuple, and the signature verifies against the P-256 key
    const udfDigest = await createAssociationRequestDigestFn(port)(associationRequestInit, p256PubHex)
    const tsDigest = computeAssociationRequestDigest(associationRequestInit, p256PubHex)
    const sigProbe = bytesToHex(p256.sign(udfDigest, p256Priv))
    instrumentRes.I2 = bytesToHex(udfDigest) === bytesToHex(digestToBytes(tsDigest)) && verifySigP256(tsDigest, sigProbe, p256PubHex)
    check('I2', 'the UDF association-request digest equals the TypeScript tuple and the P-256 signature verifies', instrumentRes.I2)
    if (!instrumentRes.I2) fail('instrument-digest-mismatch')
    const associationTransport = instrument(new P2pAssociationTransport({
      openStrand, computeDigest: createAssociationRequestDigestFn(port), computeAttestationDigest: createAssociationAttestationDigestFn(port), strandId: hash, sealer
    } as any), 'assocTransport') as any
    await associationTransport.submitRequest(associationRequestInit, p256PubHex, p256Sign)
    res.association.staged = true
    stage('association-staged')

    const statusOf = (notices: any[], requestId: string): any => {
      let found: any
      for (const n of notices) if (n.requestId === requestId) found = n
      return found
    }
    const challenge = await boundedPoll('challenge', () => associationTransport.pollDecisions(), (ns: any[]) => {
      const n = statusOf(ns, associationRequestInit.id)
      return n !== undefined && (n.status === 'c' || n.status === 'r' || n.status === 'a')
    }, { timeoutMs: DECISION_WAIT_MS, intervalMs: 2000 })
    const cNotice = challenge.ok ? statusOf(challenge.value as any[], associationRequestInit.id) : undefined
    res.association.challenge = { status: cNotice?.status ?? 'timeout', waitedMs: challenge.waitedMs, polls: challenge.polls }
    if (!challenge.ok) fail('challenge-timeout')
    if (cNotice.status === 'r') fail('association-rejected')
    const nonce = secret(cNotice.challengeNonce, { windows: true })
    if (typeof cNotice.challengeNonce !== 'string' || cNotice.challengeNonce === '') fail('challenge-without-nonce')
    stage('challenge-received')

    const answer: any = {
      requestId: associationRequestInit.id,
      nonce,
      attestation: buildSyntheticAndroidAttestation({ nonce, deviceKey: p256PubHex, deviceId, now: Date.now() })
    }
    for (const c of answer.attestation.certificateChain) secret(c, { windows: true })
    for (const c of answer.attestation.platformDetails.deviceKeyCertificateChain) secret(c, { windows: true })
    await associationTransport.submitAttestation(answer, p256PubHex, p256Sign)
    res.association.answered = true
    stage('challenge-answered')

    const decision = await boundedPoll('decision', () => associationTransport.pollDecisions(), (ns: any[]) => {
      const n = statusOf(ns, associationRequestInit.id)
      return n !== undefined && (n.status === 'a' || n.status === 'r')
    }, { timeoutMs: DECISION_WAIT_MS, intervalMs: 2000 })
    const dNotice = decision.ok ? statusOf(decision.value as any[], associationRequestInit.id) : undefined
    res.association.decision = { status: dNotice?.status ?? 'timeout', waitedMs: decision.waitedMs, polls: decision.polls }
    if (!decision.ok) fail('decision-timeout')
    if (dNotice.status === 'r') fail('association-rejected')

    // eligibility, mirrors apps/VoteTorrentVoter/src/engines/vote-casting.ts:234-290
    const registrationEngine = instrument(new RegistrationEngine(ctx), 'registration') as any
    const rowRes = await boundedPoll('association-row', async () => {
      const rows: any[] = await associationEngine.getAssociationsByDeviceKey(p256PubHex)
      if (rows.length === 0) return null
      const matches: any[] = []
      for (const row of rows) {
        const registrant = await registrationEngine.getRegistrant(row.registrantId)
        if (registrant !== undefined && registrant.status === 'a' && registrant.authorityId === authorityId) matches.push({ row, registrant })
      }
      return matches.length === 1 ? matches[0] : (matches.length > 1 ? 'ambiguous' : null)
    }, (m: any) => m !== null, { timeoutMs: SYNC_WAIT_MS, intervalMs: 2000 })
    stage('associated')
    const match: any = rowRes.value
    if (!rowRes.ok || match === 'ambiguous') { res.eligibility = { ok: false, reason: rowRes.ok ? 'registration-ambiguous' : 'not-registered' }; fail(res.eligibility.reason) }
    const vk = checkVotingKey(p256PubHex, match.row.deviceKey)
    if (!vk.ok) { res.eligibility = { ok: false, reason: (vk as any).reason }; fail(String((vk as any).reason)) }
    const compressedKey: string = (vk as any).compressedKey
    res.eligibility = { ok: true }
    stage('eligible')
    if (STOP_AFTER === 'associated') { stoppedAfter = 'associated'; throw new HvStop('stop-after') }

    // ---- vote, mirrors election-read.ts:294-338 and vote-casting.ts:406-460
    const electionEngine: any = await electionsEngine.openElection(electionId)
    const electionDetails: any = await electionEngine.getElectionDetails()
    const rawRevision: unknown = electionDetails.current.revision
    const revision = typeof rawRevision === 'bigint' ? Number(rawRevision) : rawRevision
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) fail('revision-unreadable')
    const summaries: any[] = await electionEngine.getBallots()
    const confirmedStates = await Promise.all(summaries.map((s: any) => electionEngine.getBallotConfirmationState(s.id)))
    const confirmed = summaries.filter((_s: any, i: number) => confirmedStates[i]?.confirmed === true)
    const ballots: any[] = (await Promise.all(confirmed.map(async (s: any) => (await electionEngine.getBallotDetails(s.id)).ballot))).sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (ballots.length === 0) fail('no-confirmed-ballot')
    const selectionsFile = env.HV_SELECTIONS_FILE !== undefined ? JSON.parse(readFileSync(env.HV_SELECTIONS_FILE, 'utf8')) : null
    const votes: any[] = ballots.map((ballot: any) => {
      const nonceHex = makeVoteNonce(globalThis.crypto.getRandomValues(new Uint8Array(32)))
      secret(nonceHex, { windows: true })
      const selections: Record<string, string[]> = {}
      const questions = [...ballot.questions].sort((a: any, b: any) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
      for (const q of questions) {
        selections[q.code] = selectionsFile?.[q.code] ?? [q.options[(N - 1) % q.options.length].code]
      }
      return buildVoteEntry({ ballot, electionRevision: revision, selections, nonce: nonceHex })
    })
    const unsigned = {
      v: 1 as const,
      electionId,
      electionRevision: revision,
      registrantId: match.registrant.id,
      privateCid: match.registrant.privateCid,
      publicCid: match.registrant.publicCid ?? null,
      deviceKey: compressedKey,
      attestationCid: match.row.attestationCid ?? null,
      ballots: votes.map((v: any) => ({ ballotId: v.ballotId, templateDigest: v.templateDigest }))
    }
    const digest = voterEntryDigest(unsigned as any)
    voterEntryDigestBytes(digest)
    const signature = signDigestP256(digest, p256Priv)
    if (!verifySigP256(digest, signature, compressedKey)) fail('signature-invalid')
    const voterEntry = { ...unsigned, signature }
    const voteJsons = votes.map((v: any) => secret(canonicalJson(v), { windows: true }))
    res.vote.ballots = votes.length
    res.vote.entrySha256 = voteJsons.map(sha12)
    if (VOTE_OUT !== undefined) {
      writeFileSync(VOTE_OUT, JSON.stringify(voteJsons), { flag: 'wx', mode: 0o600 })
      res.vote.voteOutWritten = true
    }
    stage('vote-built')
    if (STOP_AFTER === 'vote-built') { stoppedAfter = 'vote-built'; throw new HvStop('stop-after') }

    // ---- send
    // mirrors apps/VoteTorrentVoter/src/engines/vote-sending-port.ts:27-50
    // mirrors apps/VoteTorrentVoter/src/engines/vote-sending.ts:99-160
    const keyRow = await boundedPoll('election-key', async () => (await port.query('select JointPublicKey from ElectionKey where ElectionId = :e and ElectionRevision = :r', { e: electionId, r: revision }))[0]?.JointPublicKey, (k: unknown) => typeof k === 'string' && k.length > 0, { timeoutMs: SYNC_WAIT_MS, intervalMs: 2000 })
    if (!keyRow.ok) fail('election-key-missing')
    const jointPublicKey = keyRow.value as string
    const tl = JSON.parse(String((await port.query('select Timeline from ElectionRevision where ElectionId = :e and Revision = :r', { e: electionId, r: revision }))[0]?.Timeline))
    const votingStarts = tl.votingStarts
    const closesAt = tl.accruingVotes
    if (typeof votingStarts !== 'number' || typeof closesAt !== 'number') fail('window-unreadable')
    if (Date.now() >= closesAt) fail('voting-closed')
    const open = await boundedPoll('voting-open', async () => Date.now(), (n: number) => n >= votingStarts, { timeoutMs: Math.max(1000, closesAt - 60_000 - Date.now()), intervalMs: 1000 })
    if (!open.ok) fail('voting-window-never-opened')
    stage('voting-open')
    if (env.HV_SEND_GATE_FILE !== undefined) {
      stage('ready-to-send')
      const gate = await boundedPoll('send-gate', async () => existsSync(env.HV_SEND_GATE_FILE!), (b: boolean) => b, { timeoutMs: Math.max(1000, closesAt - 60_000 - Date.now()), intervalMs: 1000 })
      if (!gate.ok) fail('send-gate-timeout')
    }
    const rendezvousTarget = multiaddr(members[0]!)
    // consent prompts are serialized, as the Voter's serialize() does (vote-sending.ts:76-83)
    let tail: Promise<unknown> = Promise.resolve()
    const serialize = (fn: (d: string) => Promise<string>) => (d: string) => { const run = tail.then(() => fn(d)); tail = run.catch(() => undefined); return run }
    const signConsent = serialize(async (d: string) => signDigestP256(d, p256Priv))
    const canonicalSeconds = (ms: number) => new Date(ms).toISOString().slice(0, 19)
    stage('pooling')
    const outcomes = await Promise.all(votes.map(async (vote: any, i: number) => {
      const ballotId: string = vote.ballotId
      const pb: any = { electionKey: { electionId, revision, jointPublicKey }, ballotId, templateDigest: vote.templateDigest }
      const rec: any = { ballotPrefix: sha12(ballotId), outcome: 'failed', ms: 0, counts: {} }
      const sP = Date.now()
      const findRecordedVote = async () => ((await port.query('select BlockCid from VoteBlockVoter where ElectionId = :e and BallotId = :b and RegistrantId = :reg', { e: electionId, b: ballotId, reg: unsigned.registrantId }))[0]?.BlockCid as string | undefined) ?? null
      const already = await findRecordedVote().catch(() => null)
      if (already !== null) { rec.outcome = 'committed'; rec.cidPrefix = already.slice(0, 12); res.pool.ballots.push(rec); return rec }
      const identity = createPoolIdentity() // a NEW throwaway identity per ballot, never the node's peer id
      const contribution = { member: identity.peerId, voteCiphertext: encryptVoteEntry(pb.electionKey, ballotId, canonicalJson(vote)), voterEntry } as any
      const agent = new PoolAgent({
        identity,
        rendezvous: createLibp2pRendezvousClient(node.getControlNode(), rendezvousTarget),
        ballot: pb,
        contribution,
        signConsent,
        commit: async (block: any, signatures: any) => {
          const nowMs = Date.now()
          return await commitPoolBlock(ctx.db, block, pb, signatures, { nowMs, now: canonicalSeconds(nowMs) })
        },
        findRecordedVote,
        deadlineAt: closesAt,
        now: () => Date.now(),
        log: (event: string, detail?: Record<string, unknown>) => {
          if (event === 'tick-error') recordPollError(`pool.${i}`, new Error(String(detail?.message ?? 'tick-error')))
        }
      } as any)
      try {
        const outcome: any = await agent.run()
        rec.counts = { ...agent.counts }
        if (outcome.status === 'committed') { rec.outcome = 'committed'; rec.cidPrefix = String(outcome.cid).slice(0, 12) } else { rec.outcome = 'stopped'; rec.reason = closedToken(String(outcome.reason)) }
      } catch (e) {
        rec.outcome = 'failed'
        recordError(`pool.${i}.run`, e, 'write')
      }
      rec.ms = Date.now() - sP
      res.pool.ballots.push(rec)
      return rec
    }))
    if (outcomes.every((o: any) => o.outcome === 'committed')) {
      committedAll = true
      stage('committed')
    } else {
      fail('pool-not-committed')
    }
  } catch (e) {
    if (e instanceof HvStop) {
      if (e.why !== 'stop-after') failReason = e.why
    } else {
      check('H1', 'the runner completed without an unexpected throw', false, scrubWall(redact((e as Error)?.stack ?? String(e))).slice(0, 600))
      recordError('main', e, 'write')
      failReason = closedToken('unexpected-' + String((e as any)?.name ?? 'error'))
    }
  } finally {
    await finalize()
    process.exit(0)
  }
}

if (isMain) {
  await main()
}
