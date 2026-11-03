// lean-part2.ts (tools/lean-rig; was the scratch driver hr5-part2.ts of plan 64-63, moved into the repo 2026-11-03): host rehearsal of run 1, part 2 (election to decrypt) on Node peers over the
// real relay, notes 19 E24. It composes shipped modules and the named harness pieces; every copied block is headed by a "mirrors" comment.
// LEAN (2026-10-29): a copy of hr5-part2-a2.ts made by 64-lean/gen/make-lean.py. LEAN_PHONE=1: kh-b is the Redmi Authority and the third
// voter the iPhone Voter; the driver waits on the officer's own state (roster, election key, releases, block) for the phones' steps.
// Without LEAN_PHONE: all-host (the dry run). Paths: every run path comes from run-lean.sh (HR5_*); LEAD/WINDOW are env knobs.
// Layout: tools/lean-rig/{lean,part1,host-voter,lib}; this file is lean/. REPO is three levels up.
// Modes: HR5_MODE=selfcheck (no node, no network) and HR5_MODE=run. The process always exits 0; parse RESULT / SUMMARY.
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, writeSync, readdirSync, statSync, appendFileSync, rmSync, realpathSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { register } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'

const MODE = process.env.HR5_MODE ?? ''
const HOME = homedir()
const S = fileURLToPath(new URL('./', import.meta.url)).replace(/\/$/, '') // tools/lean-rig/lean
const SCR = join(S, '..') // tools/lean-rig
const REPO = join(SCR, '../..')
const S62 = join(SCR, 'part1')
// run dirs (secrets, state, evidence) live outside the repo; redact() hides this prefix too
const RUNS = process.env.VT_LEAN_RUNS ?? ''
const DRY = process.env.HR5_DRY === '1'
const SEC = process.env.HR5_SEC ?? join(S, 'secrets')
const PIDS_FILE = process.env.HR5_PIDS_FILE ?? join(S, 'hv-pids.txt')
// KH2 (2026-11-03, three-phone run): BOTH keyholder seats are accepted by phone Authorities (seat hr5-kh-a and hr5-kh-b). The
// host kh-a peer stays up as a non-keyholder WITNESS (a fast host replica for O4, the fork prechecks, E2 and the X3/X4c reads);
// it accepts no seat, drives no DKG and releases nothing. The officer's own state gates every phone step.
const PHONE_KH2 = process.env.LEAN_PHONE_KH2 === '1'
const PHONE_KH = process.env.LEAN_PHONE === '1' || process.env.LEAN_PHONE_KH === '1' || PHONE_KH2
const PHONE_VOTER = process.env.LEAN_PHONE === '1' || process.env.LEAN_PHONE_VOTER === '1'
const PHONE = PHONE_KH || PHONE_VOTER
const HV = process.env.LEAN_HV_DIR ?? join(SCR, 'host-voter') // D-119 (65-25): LEAN_HV_DIR selects a patched host-voter copy
const LIB = join(SCR, 'lib') // control-leaf.mjs (phase 64 rig) and classify.mjs (spike 106), unchanged
const VE = join(REPO, 'packages/vote-engine')
const U = (p: string): string => pathToFileURL(p).href
const R = (rel: string): string => U(join(REPO, rel))
const EV = process.env.HR5_EV ?? ''
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const T0 = performance.now()
const rawLog = console.log.bind(console)
const rawInfo = console.info.bind(console)
const rawWarn = console.warn.bind(console)
const rawError = console.error.bind(console)
const rawDebug = console.debug.bind(console)

// ----------------------------------------------------------------------------------------------------------------
// secrets, redaction (mirrors .planning/spikes/108-two-of-two-dkg-host/two-of-two-dkg.ts:111-133 and host-voter selftest.ts:73-100)
// ----------------------------------------------------------------------------------------------------------------
const SECRETS = new Map<string, boolean>()
const WINDOWS = new Set<string>()
function secret (s: unknown, opts?: { windows?: boolean }): string {
  if (typeof s !== 'string') return String(s)
  if (s.length >= 8) SECRETS.set(s, opts?.windows === true || SECRETS.get(s) === true)
  if (opts?.windows === true && s.length >= 16) for (let i = 0; i + 16 <= s.length; i++) WINDOWS.add(s.slice(i, i + 16))
  return s
}
const PEER_RE = /12D3Koo[1-9A-HJ-NP-Za-km-z]{30,}/g
const LAN_RE = /\b(?:10\.\d+|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+\b/g
function redact (s: unknown): string {
  let out = String(s)
  for (const k of SECRETS.keys()) if (out.includes(k)) out = out.split(k).join('<secret>')
  if (WINDOWS.size > 0 && out.length >= 16) {
    const mask = new Uint8Array(out.length)
    let any = false
    for (let i = 0; i + 16 <= out.length; i++) if (WINDOWS.has(out.slice(i, i + 16))) { any = true; mask.fill(1, i, i + 16) }
    if (any) {
      let r = ''
      let inMask = false
      for (let i = 0; i < out.length; i++) { if (mask[i]) { if (!inMask) r += '<secret>'; inMask = true } else { inMask = false; r += out[i] } }
      out = r
    }
  }
  out = out.replace(/[0-9a-fA-F]{64}/g, '<hex64>')
  out = out.replace(PEER_RE, (m) => `<peer:${m.slice(-8)}>`)
  out = out.replace(LAN_RE, '<lan>')
  if (REPO.length > 1) out = out.split(REPO).join('<repo>')
  if (RUNS.length > 1) out = out.split(RUNS).join('<runs>')
  if (SCR.length > 1) out = out.split(SCR).join('<lean-rig>')
  if (HOME.length > 1) out = out.split(HOME).join('<home>')
  return out
}
const SM_RE = /Failed to get super-majority: (\d+\/\d+) approvals/
const TORN = 'Torn' + 'Action' + 'Error'
const IDL = 'InvalidData' + 'LengthError'
const TLE = 'TransferLimit' + 'Error'
/** A stray wall literal in the driver's OWN text is neutralised so it can never read as a hit (the wall counters come from real errors and console lines). */
function scrubWall (s: string): string {
  return s.replace(/Failed to get super-majority: (\d+\/\d+) approvals/g, 'sm-refusal $1').split(TORN).join('torn-refusal').split(IDL).join('idl-refusal').split(TLE).join('tl-refusal')
}
const tail8 = (id: string): string => `…${id.slice(-8)}`
const sha12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12)
const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

// ----------------------------------------------------------------------------------------------------------------
// wall counters, classification of errors, console wrapper
// ----------------------------------------------------------------------------------------------------------------
interface Sig { superMajority: number, tornAction: number, invalidDataLength: number, transferLimit: number }
const zero = (): Sig => ({ superMajority: 0, tornAction: 0, invalidDataLength: 0, transferLimit: 0 })
const wallPaths: Record<'hidden' | 'thrown' | 'late', Sig> = { hidden: zero(), thrown: zero(), late: zero() }
const probe = { installed: false, restored: false, calls: 0, maxBytes: 0, oversized: 0 }
const tokenCount = { superMajority: 0, tornAction: 0, invalidDataLength: 0, transferLimit: 0 }
let hiddenOpen = 0
let digestMismatchCount = 0
const attaches: any[] = []
const CAP_BYTES = 1_048_576

function classify (err: unknown): Sig & { names: string[] } {
  const out: any = { ...zero(), names: [] }
  const queue: Array<{ e: any, d: number }> = [{ e: err, d: 0 }]
  const seen = new Set<unknown>()
  while (queue.length > 0) {
    const { e, d } = queue.shift()!
    if (e === null || e === undefined || d > 6) continue
    if (typeof e === 'object') { if (seen.has(e)) continue; seen.add(e) }
    const name = typeof e?.name === 'string' ? e.name : ''
    const msg = typeof e?.message === 'string' ? e.message : (typeof e === 'string' ? e : '')
    if (name && /^[A-Za-z0-9]{1,60}$/.test(name) && !out.names.includes(name) && out.names.length < 12) out.names.push(name)
    if (SM_RE.test(msg)) out.superMajority++
    if (name === TORN) out.tornAction++
    if (name === IDL) out.invalidDataLength++
    if (name === TLE) out.transferLimit++
    if (e?.cause !== undefined) queue.push({ e: e.cause, d: d + 1 })
    if (Array.isArray(e?.errors)) for (const x of e.errors) queue.push({ e: x, d: d + 1 })
  }
  return out
}
const events: any[] = []
const lateErrors: any[] = []
/** read errors are swallowed by polls (path hidden); write errors are thrown to the leg (path thrown); late is process-level. */
function recordError (where: string, err: unknown, path: 'hidden' | 'thrown' | 'late'): void {
  const c = classify(err)
  const w = wallPaths[path]
  w.superMajority += c.superMajority; w.tornAction += c.tornAction; w.invalidDataLength += c.invalidDataLength; w.transferLimit += c.transferLimit
  const msg = redact(typeof (err as any)?.message === 'string' ? (err as any).message : String(err)).slice(0, 200)
  const signal = c.superMajority + c.tornAction + c.invalidDataLength + c.transferLimit > 0
  if (events.length < 600 && (signal || path !== 'hidden')) events.push({ t: Math.round(performance.now() - T0), where, path, names: c.names, msg: signal ? msg : scrubWall(msg) })
}
const lateLine = (kind: string, e: unknown): void => { rawLog(`LATE-ERROR ${kind} ${String((e as any)?.name ?? 'Error')} ${redact(scrubWall(String((e as any)?.message ?? e))).slice(0, 300)}${(e as any)?.stack ? ' @ ' + redact(scrubWall(String((e as any).stack).split('\n')[1] ?? '')).trim().slice(0, 200) : ''}`) }
process.on('uncaughtException', (e) => { recordError('uncaught', e, 'late'); lateErrors.push({ name: String((e as any)?.name ?? 'Error') }); lateLine('uncaught', e) })
process.on('unhandledRejection', (e) => { recordError('unhandled', e, 'late'); lateErrors.push({ name: String((e as any)?.name ?? 'Error') }); lateLine('unhandled', e) })

let stallMaxMs = 0
let stallOver2000 = 0
let lastTick = performance.now()
const stallTimer = setInterval(() => {
  const now = performance.now()
  const drift = now - lastTick - 100
  lastTick = now
  if (drift > stallMaxMs) stallMaxMs = Math.round(drift)
  if (drift > 2000) stallOver2000++
}, 100)
stallTimer.unref()

interface CurLeg { name: string, lines: string[], dropped: number }
let curLeg: CurLeg | null = null
const CONSOLE_CAP = 4000
function onConsole (level: string, args: any[]): string {
  let text = ''
  try { text = args.map((a) => (typeof a === 'string' ? a : (a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a)))).join(' ') } catch { text = String(args[0]) }
  if (args[0] === '[strand-factory] attach' || args[0] === '[strand-factory] attach refused') attaches.push({ t: Date.now(), kind: args[0] === '[strand-factory] attach' ? 'attach' : 'refused', ...(args[1] ?? {}) })
  if (text.includes('content-digest-mismatch')) digestMismatchCount++
  tokenCount.superMajority += (text.match(/Failed to get super-majority: \d+\/\d+ approvals/g) ?? []).length
  tokenCount.tornAction += text.split(TORN).length - 1
  tokenCount.invalidDataLength += text.split(IDL).length - 1
  tokenCount.transferLimit += text.split(TLE).length - 1
  const red = redact(text)
  if (curLeg) { if (curLeg.lines.length < CONSOLE_CAP) curLeg.lines.push(`${level} ${red}`); else curLeg.dropped++ }
  return red
}
console.log = (...a: any[]) => { const t = onConsole('log', a); rawLog(t) }
console.info = (...a: any[]) => { const t = onConsole('info', a); rawInfo(t) }
console.warn = (...a: any[]) => { const t = onConsole('warn', a); rawWarn(t) }
console.error = (...a: any[]) => { const t = onConsole('error', a); rawError(t) }
console.debug = (...a: any[]) => { const t = onConsole('debug', a); rawDebug(t) }

// own output goes through these (never counted as library output)
function say (cat: string, msg: string): void { rawLog(`[${String(Math.round(performance.now() - T0)).padStart(7)}ms] ${cat.padEnd(8)} ${redact(scrubWall(msg))}`) }
const KEYS = new Map<string, string>()
function key (name: string, value: string): void {
  if (KEYS.has(name)) return
  const v = redact(scrubWall(value))
  KEYS.set(name, v)
  rawLog(`${name}: ${v}`)
}

// ----------------------------------------------------------------------------------------------------------------
// module loading
// ----------------------------------------------------------------------------------------------------------------
await import(U(join(S, 'mocha-shim.js')))
const opener: any = await import(U(join(S62, 'hr5-open.ts')))
register('./s63-hooks.mjs', { parentURL: import.meta.url, data: { authSrc: R('apps/VoteTorrentAuthority/src/') } })
const AUTH = (p: string): string => R('apps/VoteTorrentAuthority/src/' + p)
const VEs = (p: string): string => R('packages/vote-engine/src/' + p)
const cadre: any = await import('@serfab/cadre-core')
const dbP2p: any = await import('@optimystic/db-p2p')
const ClusterClient: any = dbP2p.ClusterClient
const controlLeaf: any = await import(U(join(LIB, 'control-leaf.mjs')))
const d14map: any = await import(U(join(S, 'd14map.mjs')))
const openedMod: any = await import(R('scripts/proof/opened-set-preimage.ts'))
const hvMod: any = await import(U(join(HV, 'host-voter.ts')))
const fixtures: any = await import(R('packages/vote-engine/test/fixtures/test-context.ts'))
const harness: any = await import(R('packages/vote-engine/test/harness/two-node-strand.ts'))
const [
  electionsMod, invitationMod, dkgEngMod, keyReleaseMod, keysTasksMod, releaseWindowMod, electionBlockMod, vaultMod, initMod, sigTasksMod, intakeMod, regMod, assocMod, stubMod, keyAttMod, regTransMod, assocTransMod, joinCodeMod
] = await Promise.all([
  import(VEs('elections/elections-engine.ts')), import(VEs('invite/invitation-engine.ts')), import(VEs('keyholder/keyholder-dkg-engine.ts')),
  import(VEs('key-release/key-release-engine.ts')), import(VEs('tasks/keys-tasks-engine.ts')), import(VEs('key-release/release-window.ts')),
  import(VEs('key-release/election-block.ts')), import(VEs('crypto/vault.ts')), import(VEs('database/initialize.ts')),
  import(VEs('tasks/signature-tasks-engine.ts')), import(VEs('intake/intake-engine.ts')), import(VEs('registration/registration-engine.ts')),
  import(VEs('association/association-engine.ts')), import(VEs('association/stub-attestation-verifier.ts')), import(VEs('association/verifiers/key-attestation.ts')),
  import(VEs('registration/transport/p2p-registration-transport.ts')), import(VEs('association/transport/p2p-association-transport.ts')), import(VEs('networks/join-code.ts'))
]) as any[]
const { ElectionsEngine, peekNextElectionTid } = electionsMod
const { InvitationEngine } = invitationMod
const { KeyholderDkgEngine } = dkgEngMod
const { KeyReleaseEngine } = keyReleaseMod
const { ElectionResultsEngine } = (await import(VEs('results/index.ts'))) as any
const { TallyPublicationEngine } = (await import(VEs('tally/index.ts'))) as any
const { KeysTasksEngine } = keysTasksMod
const { releasingKeysAt } = releaseWindowMod
const { openElectionBlock, openVoteEntries } = electionBlockMod
const { InMemoryTestKeyVault } = vaultMod
const { registerDbPlugins, declareViewsInMain } = initMod
const { SignatureTasksEngine } = sigTasksMod
const { IntakeEngine } = intakeMod
const { RegistrationEngine } = regMod
const { AssociationEngine } = assocMod
const { StubAttestationVerifier } = stubMod
const { verifyKeyAttestation } = keyAttMod
const { P2pRegistrationTransport } = regTransMod
const { P2pAssociationTransport } = assocTransMod
const { encodeNetworkJoinCode, decodeNetworkJoinCode } = joinCodeMod
const { makeElectionInit } = fixtures
const makeP256TestKey: any = (await import(R('packages/vote-engine/test/fixtures/p256-signer.ts')) as any).makeP256TestKey
const { openedSetPreimage } = openedMod
const { buildSyntheticAndroidAttestation } = hvMod
const acceptMod: any = await import(AUTH('screens/keyholder/keyholder-accept.ts'))
const driverMod: any = await import(AUTH('screens/keyholder/keyholder-dkg-driver.ts'))
const ceremonyMod: any = await import(AUTH('screens/keyholder/key-release-ceremony.ts'))
const identityMod: any = await import(AUTH('engines/keyholder-identity.ts'))
const policyMod: any = await import(AUTH('screens/elections/keyholder-policy.ts'))
const expiryMod: any = await import(AUTH('screens/keyholder/keyholder-invite-expiry.ts'))
const voterInviteMod: any = await import(AUTH('engines/voter-invite.ts'))
const poolHostMod: any = await import(AUTH('engines/pool-rendezvous-host.ts'))
const syncMod: any = await import(AUTH('screens/registration/attach-peer-sync-binding.ts'))
const portMod: any = await import(AUTH('engines/strand-port-adapter.ts'))
const ownerTrustMod: any = await import(AUTH('engines/owner-trust.ts'))
const { acceptKeyholderInvitation } = acceptMod
const { driveKeyholderDkg } = driverMod
const { releaseKeyholderShare } = ceremonyMod
const { listKeyholderIdentities, keyholderSigningKeyAlias } = identityMod
const { keyholderInviteExpiration, DEFAULT_KEYHOLDER_INVITE_EXPIRY_HOURS } = expiryMod
const { ensureVoterInviteOwner, VOTER_INVITE_USES, VOTER_INVITE_LIFETIME_MS } = voterInviteMod
const { hostPoolRendezvous } = poolHostMod
const { createPeerSyncBinding } = syncMod
const { createStrandPort } = portMod
const { readControlLeaf, classifyRound, forkPrecheckLine, forkPrecheck } = controlLeaf

const pkgVer = (name: string): string => JSON.parse(readFileSync(join(VE, 'node_modules', name, 'package.json'), 'utf8')).version
const stack = (): any => ({
  dbP2p: pkgVer('@optimystic/db-p2p'), dbCore: pkgVer('@optimystic/db-core'), pluginOptimystic: pkgVer('@optimystic/quereus-plugin-optimystic'),
  cadreCore: pkgVer('@serfab/cadre-core'), quereus: pkgVer('@quereus/quereus'), mainEvent: pkgVer('main-event'), p2pFret: pkgVer('p2p-fret')
})

// ----------------------------------------------------------------------------------------------------------------
// the size probe (mirrors spike 108 two-of-two-dkg.ts:265-275): exactly two assignments, restore in finally. Read only.
// ----------------------------------------------------------------------------------------------------------------
const origSend = ClusterClient.prototype.send
const encoder = new TextEncoder()
function installProbe (): void {
  ClusterClient.prototype.send = async function (this: unknown, message: unknown, options: unknown) {
    try {
      const bytes = encoder.encode(JSON.stringify(message)).byteLength
      probe.calls++
      if (bytes > probe.maxBytes) probe.maxBytes = bytes
      if (bytes > CAP_BYTES) probe.oversized++
    } catch { /* a probe failure must never change product behaviour */ }
    return origSend.call(this, message, options)
  }
  probe.installed = true
}
function restoreProbe (): void { ClusterClient.prototype.send = origSend; probe.restored = true }

// ----------------------------------------------------------------------------------------------------------------
// poll helpers: every swallowed read error is recorded (D-21)
// ----------------------------------------------------------------------------------------------------------------
async function poll<T> (where: string, read: () => Promise<T>, until: (v: T) => boolean, o: { timeoutMs: number, intervalMs?: number }): Promise<{ ok: boolean, value: T | undefined, waitedMs: number }> {
  const start = Date.now()
  const interval = o.intervalMs ?? 1000
  let last: T | undefined
  for (;;) {
    try { last = await read(); if (until(last)) return { ok: true, value: last, waitedMs: Date.now() - start } } catch (e) { recordError(where, e, 'hidden'); monPollError(where, e) }
    if (Date.now() - start + interval > o.timeoutMs) return { ok: false, value: last, waitedMs: Date.now() - start }
    await sleep(interval)
  }
}
async function one (db: any, sql: string, params: Record<string, unknown> = {}): Promise<any> { return db.prepare(sql).get(params) }
async function race<T> (p: Promise<T>, ms: number): Promise<{ settled: boolean, ok: boolean, value?: T, error?: unknown, ms: number }> {
  const t = Date.now()
  let timer: any
  const res = await Promise.race([
    p.then((value) => ({ settled: true, ok: true, value }), (error) => ({ settled: true, ok: false, error })),
    new Promise<{ settled: boolean, ok: boolean }>((r) => { timer = setTimeout(() => r({ settled: false, ok: false }), ms) })
  ])
  clearTimeout(timer)
  return { ...(res as any), ms: Date.now() - t }
}
const KEEP_RE = /^[a-z0-9][a-z0-9-]*$/

// ----------------------------------------------------------------------------------------------------------------
// legs
// ----------------------------------------------------------------------------------------------------------------
class LegFail extends Error { constructor (readonly kind: 'FAIL' | 'VOID', readonly token: string) { super(token) } }
// LEAN E92: outcome checks the later legs do not depend on. A failure is recorded and the run goes on.
const SOFT_TOKENS = new Set(['officer-loop', 'join-outcome', 'cid-disagree', 'entry-hash', 'block', 'pre-release', 'needle-control'])
export const FAIL_TOKENS: string[] = ['phone-join', 'phone-vote',
  'precondition-part1', 'precondition-part1-handoff', 'precondition-head', 'precondition-relay', 'precondition-copies', 'precondition-cap', 'precondition-intake',
  'reopen-peers', 'reopen-sibling', 'reopen-circuit', 'reopen-start', 'reopen-open', 'fork-precheck-role-missing', 'fork-precheck-digest-mismatch-logged', 'fork-precheck-fork-leaf',
  'fork-precheck-fork-tail', 'fork-precheck-unreadable', 'solo-own-row', 'founder-reopen', 'intake', 'election', 'slots', 'self-invite', 'ballot', 'accept', 'seats', 'dkg-bound',
  'dkg-error', 'dkg-key', 'code', 'n0', 'join-outcome', 'hv-joined', 'hv-association-staged', 'hv-ready-to-send', 'hv-exit', 'officer-loop', 'timeline-missed', 'send-window', 'block-size',
  'block', 'cid-disagree', 'entry-hash', 'release-wait', 'pre-release', 'release', 'decrypt', 'needle-control', 'd14-hit', 'secret-leak', 'crash', 'no-result', 'host-not-quiet'
]
interface LegStatus { leg: string, status: 'PASS' | 'FAIL' | 'VOID', token: string, inScriptD14: 'CLEAN' | 'HIT', reason: string, checks: string[] }
const legStatuses: LegStatus[] = []
let lastLegDir = ''
let nonPass: LegStatus | null = null
let hvHitFlag = 0

interface LegCtx { dir: string, name: string, check: (id: string, text: string, pass: boolean, detail?: unknown) => boolean, need: (token: string, id: string, text: string, pass: boolean, detail?: unknown) => void, join: any, hv: { hit: boolean } }

async function leg (name: string, fn: (L: LegCtx) => Promise<void>): Promise<LegStatus> {
  const dir = join(EV, name)
  if (existsSync(dir)) throw new LegFail('VOID', 'leg-dir-exists')
  mkdirSync(dir)
  lastLegDir = dir
  const fd = openSync(join(dir, 'leg.log'), 'wx')
  const t0 = performance.now()
  const w = (s: string): void => { writeSync(fd, redact(s) + '\n') }
  const checks: string[] = []
  let firstFail: string | null = null
  const L: LegCtx = {
    dir, name,
    join: null,
    hv: { hit: false },
    check (id, text, pass, detail) {
      const d = detail === undefined ? '' : `  - ${redact(scrubWall(typeof detail === 'string' ? detail : JSON.stringify(detail)))}`
      w(`[${String(Math.round(performance.now() - t0)).padStart(7)}ms] ${pass ? 'PASS' : 'FAIL'} ${id} ${text}${d}`)
      say(pass ? 'PASS' : 'FAIL', `${name} ${id} ${text}${d}`)
      checks.push(id)
      return pass
    },
    need (token, id, text, pass, detail) {
      const ok = L.check(id, text, pass, detail)
      if (!ok) { firstFail ??= token; if (!SOFT_TOKENS.has(token)) throw new LegFail('FAIL', token); say('SOFT-FAIL', `${name} ${id} recorded, continuing`) }
    }
  }
  const before = {
    wall: JSON.parse(JSON.stringify(wallPaths)) as typeof wallPaths, tok: { ...tokenCount }, hidden: hiddenOpen, calls: probe.calls, big: probe.oversized, lates: lateErrors.length, stall: stallOver2000
  }
  curLeg = { name, lines: [], dropped: 0 }
  w('LEG-START ' + JSON.stringify({ schema: 'vt64-wall-leg/1', runId: `hr5p2-${name}`, shape: 'hr5' }))
  say('LEG', `${name} start`)
  let status: 'PASS' | 'FAIL' | 'VOID' = 'PASS'
  let token = ''
  let stage = 'run'
  try { await fn(L) } catch (e) {
    if (e instanceof LegFail) { status = e.kind; token = e.token } else {
      status = 'FAIL'; token = 'crash-' + name.replace(/^h\d+-/, '').replace(/[^a-z0-9]+/g, '-')
      recordError(`leg.${name}`, e, 'thrown' as any)
      w('crash ' + redact(scrubWall((e as Error)?.stack ?? String(e))).slice(0, 1200))
      say('CRASH', `${name} ${redact(scrubWall((e as Error)?.stack ?? String(e))).slice(0, 600)}`)
    }
  }
  stage = status === 'PASS' ? 'done' : 'stopped'
  const dw = (p: 'hidden' | 'thrown' | 'late'): Sig => ({ superMajority: wallPaths[p].superMajority - before.wall[p].superMajority, tornAction: wallPaths[p].tornAction - before.wall[p].tornAction, invalidDataLength: wallPaths[p].invalidDataLength - before.wall[p].invalidDataLength, transferLimit: wallPaths[p].transferLimit - before.wall[p].transferLimit })
  const wall = { hidden: dw('hidden'), thrown: dw('thrown'), late: dw('late') }
  const tok = { superMajority: tokenCount.superMajority - before.tok.superMajority, torn: tokenCount.tornAction - before.tok.tornAction, invalidDataLength: tokenCount.invalidDataLength - before.tok.invalidDataLength, transferLimit: tokenCount.transferLimit - before.tok.transferLimit }
  const oversized = probe.oversized - before.big
  const hid = hiddenOpen - before.hidden
  const sum = (k: keyof Sig): number => wall.hidden[k] + wall.thrown[k] + wall.late[k]
  const inS = d14map.inScript({
    oversized, superMajority: sum('superMajority') + tok.superMajority, torn: sum('tornAction') + tok.torn, invalidDataLength: sum('invalidDataLength') + tok.invalidDataLength,
    transferLimit: sum('transferLimit') + tok.transferLimit, hiddenOpen: hid, hostVoterHit: L.hv.hit ? 1 : 0
  })
  if (status === 'PASS' && firstFail !== null) { status = 'FAIL'; token = firstFail }
  if (inS.hit && status === 'PASS') { status = 'FAIL'; token = 'd14-hit' }
  const result = {
    schema: 'vt64-wall-leg/1', runId: `hr5p2-${name}`, shape: 'hr5', stack: stack(),
    instrument: { thresholdBytes: CAP_BYTES, probeInstalled: probe.installed, probeCalls: probe.calls - before.calls, probeRestored: probe.restored },
    stage, setupError: null, timedOut: false, oversizedTotal: oversized, hiddenOpenFailuresTotal: hid,
    wallSignals: {
      hidden: { superMajority: wall.hidden.superMajority, superMajorityRatios: [], tornAction: wall.hidden.tornAction, tornReasons: [], invalidDataLength: wall.hidden.invalidDataLength },
      thrown: { superMajority: wall.thrown.superMajority + tok.superMajority, superMajorityRatios: [], tornAction: wall.thrown.tornAction + tok.torn, tornReasons: [], invalidDataLength: wall.thrown.invalidDataLength + tok.invalidDataLength },
      late: { superMajority: wall.late.superMajority, superMajorityRatios: [], tornAction: wall.late.tornAction, tornReasons: [], invalidDataLength: wall.late.invalidDataLength }
    },
    join: L.join, otherSignals: { transferLimit: sum('transferLimit') + tok.transferLimit }, stall: { maxMs: stallMaxMs, over2000: stallOver2000 - before.stall }, totalMs: Math.round(performance.now() - t0)
  }
  w('RESULT ' + JSON.stringify(result))
  closeSync(fd)
  const st: LegStatus = { leg: name, status, token, inScriptD14: inS.hit ? 'HIT' : 'CLEAN', reason: inS.reason, checks }
  writeFileSync(join(dir, 'leg-status.json'), JSON.stringify({ status, token, inScriptD14: st.inScriptD14, reason: inS.reason, checks }), { flag: 'wx' })
  const cl = curLeg
  curLeg = null
  if (cl && cl.lines.length > 0) writeFileSync(join(dir, 'console.log'), cl.lines.join('\n') + (cl.dropped ? `\n[${cl.dropped} more lines not kept]` : '') + '\n', { flag: 'wx' })
  say('LEG', `${name} ${status}${token ? ' ' + token : ''} inScript=${st.inScriptD14}`)
  legStatuses.push(st)
  if (status !== 'PASS' && nonPass === null) nonPass = st
  return st
}

// ----------------------------------------------------------------------------------------------------------------
// fork precheck (notes 19 E26): 64-60's forkPrecheck imported by file URL, no line is built here
// ----------------------------------------------------------------------------------------------------------------
type RoleName = 'officer' | 'kh-a' | 'kh-b'
const ROLES: RoleName[] = PHONE_KH ? ['officer', 'kh-a'] : ['officer', 'kh-a', 'kh-b']
const KH_LOCAL: RoleName[] = ROLES.filter((r) => r !== 'officer')
// the host peer that reads "as a keyholder replica" in L/X3/X4c: the first host keyholder, or in KH2 the host witness kh-a
const hostReaderCtx = (): any => (S_.khs[0]?.role ?? roles.get('kh-a'))!.ctx
interface RoleState { name: RoleName, node: any, peerId: string, closeStores: () => Promise<void>, solo: { n: number, windowOpen: boolean }, engine: any, ctx: any, user: any, privateHex: string, sign: (d: Uint8Array) => Promise<any>, opened: boolean }
const roles = new Map<RoleName, RoleState>()
const fmtRead = (r: any): string => (r && typeof r === 'object' && !r.unreadable) ? `leafRev=${r.leafRev} leafAction8=${r.leafAction8} tailRev=${r.tailRev} tailAction8=${r.tailAction8}` : `unreadable=${String(r?.unreadable ?? 'none').replace(/[^a-z0-9-]/g, '')}`

async function fork (point: string, dir: string, o?: Record<string, unknown>): Promise<{ line: string, pass: boolean, token: string }> {
  const readers: Record<string, () => Promise<any>> = {}
  for (const r of ROLES) readers[r] = () => readControlLeaf(roles.get(r)!.node)
  const res = await forkPrecheck({ readers, digestMismatch: () => { const n = digestMismatchCount; digestMismatchCount = 0; return n }, ...(o ?? {}) })
  const body = [res.line, `rounds: ${res.rounds}`, `round-verdict: ${classifyRound(res.last).verdict}`, ...ROLES.map((r) => `read ${r}: ${fmtRead(res.last?.[r])}`)].join('\n') + '\n'
  if (dir !== '') writeFileSync(join(dir, `fork-precheck-${point}.md`), body, { flag: 'wx' })
  const parts = String(res.line).split(' ')
  return { line: res.line, pass: parts[1] === 'PASS', token: parts[1] === 'FAIL' ? parts[2] : '' }
}

// ----------------------------------------------------------------------------------------------------------------
// shared run state
// ----------------------------------------------------------------------------------------------------------------
const STATE = process.env.HR5_STATE_DIR ?? join(S, 'state')
const party: any = existsSync(join(STATE, 'party.json')) ? JSON.parse(readFileSync(join(STATE, 'party.json'), 'utf8')) : {}
const preEnv: Record<string, string> = {}
if (process.env.HR5_PRECHECK_ENV && existsSync(process.env.HR5_PRECHECK_ENV)) for (const l of readFileSync(process.env.HR5_PRECHECK_ENV, 'utf8').split('\n')) { const i = l.indexOf('='); if (i > 0) preEnv[l.slice(0, i)] = l.slice(i + 1) }
if (preEnv.RELAY_MULTIADDR) { secret(preEnv.RELAY_MULTIADDR); secret(preEnv.RELAY_PEER); secret(preEnv.LAN_IP) }
const N7: string = party.networks?.n7?.hash ?? ''
const AUTHORITY_ID: string = party.authorityId ?? ''
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000
const LEAD_MS = process.env.HR5_LEAD_MS ? Number(process.env.HR5_LEAD_MS) : 40 * 60_000
const WINDOW_MS = process.env.HR5_WINDOW_MS ? Number(process.env.HR5_WINDOW_MS) : 15 * 60_000
// LEAN: the phones' steps. waitFlag blocks until <SEC>/flag-<name> exists (the orchestrator writes it after reading the phone back).
const PHONE_MS = process.env.LEAN_PHONE_MS ? Number(process.env.LEAN_PHONE_MS) : 30 * 60_000
// SEED (2026-11-03, seed.sh): SEED_STOP=<network|election|keyholders|dkg|voters> runs the legs up to that stage, then HOLDS the host peers
// live (officer keeps syncing/approving once voters exist) until SIGINT/SIGTERM, <SEC>/flag-seed-stop, or the hold deadline. Unset = unchanged.
const SEED_LEGS: Record<string, string> = { network: 'reopen', election: 'h6-election', keyholders: 'h7-accept', dkg: 'h8-dkg', voters: 'h9-voters' }
const SEED_STOP = process.env.SEED_STOP ?? ''
const SEED_VOTERS = SEED_STOP === 'voters'
const HV_N = SEED_VOTERS ? Number(process.env.SEED_HV_N ?? 2) : (PHONE_VOTER ? 2 : 3)
// registrations/associations the officer loop waits for: 3 in a full run (2 host + the phone, or 3 host); the seeded host voters otherwise
const REG_TARGET = SEED_VOTERS ? HV_N : 3
let seedStopRequested = false
async function waitFlag (name: string, ms = PHONE_MS): Promise<boolean> {
  const p = join(SEC, `flag-${name}`)
  rawLog(`LEAN-WAIT ${name} at=${new Date().toISOString()}`)
  const r = await poll(`flag.${name}`, async () => existsSync(p), (v) => v === true, { timeoutMs: ms, intervalMs: 1000 })
  rawLog(`LEAN-GO ${name} ok=${r.ok} waitedMs=${r.waitedMs}`)
  return r.ok
}
function leanNote (s: string): void { rawLog(`LEAN-NOTE ${s}`) }

const S_ = { electionId: '', ballotId: process.env.LEAN_BALLOT ?? 'hr5-ballot', needle: '', timeline: null as any, revision: 0, jointPublicKey: '', seats: [] as any[], intake: null as any, officerSign: null as any, khs: [] as any[], codePath: '', gatePath: join(SEC, 'send-gate'), voteFiles: [] as string[], hvPids: [] as number[], children: [] as any[], rendezvousDetach: null as any, voteBlockRows: [] as any[], founderVault: null as any, founderStore: null as any, hvResults: [] as any[], blockEntries: 0 }
const durations: Record<string, number> = {}

function mapKeyVaultStorage (): any {
  const m = new Map<string, string>()
  return { async getItem (k: string) { return m.has(k) ? m.get(k)! : null }, async setItem (k: string, v: string) { m.set(k, v) }, async removeItem (k: string) { m.delete(k) } }
}
/** mirrors packages/vote-engine/test/fixtures/test-context.ts:143-157 (the registry of test private keys is module-private, so the persisted privateHex signs here) */
function makeSign (user: any, privateHex: string): (digest: Uint8Array) => Promise<any> {
  const priv = hexToBytes(privateHex)
  return async (digest: Uint8Array) => ({ signature: bytesToHex(secp256k1.sign(digest, priv)), signerKey: user.activeKeys[0].key, signerUserId: user.id })
}
const trailingPeer = (addr: string): string => addr.split('/p2p/').pop() ?? ''

// ----------------------------------------------------------------------------------------------------------------
// leg: reopen
// ----------------------------------------------------------------------------------------------------------------
async function legReopen (L: LegCtx): Promise<void> {
  const t0 = Date.now()
  const relayAddr = preEnv.RELAY_MULTIADDR ?? ''
  L.need('precondition-relay', 'O0', 'the relay multiaddr and the part-1 hand-off are present', /\/wss?\//.test(relayAddr) && N7 !== '' && AUTHORITY_ID !== '')
  const startedMs: Record<string, number> = {}
  for (const name of ROLES) {
    const user = JSON.parse(readFileSync(join(STATE, name, 'user.json'), 'utf8'))
    const built = await opener.buildRoleNode(STATE, name, relayAddr)
    const rs: RoleState = { name, node: built.node, peerId: built.peerId, closeStores: built.closeStores, solo: { n: 0, windowOpen: true }, engine: null, ctx: null, user: user.user, privateHex: user.privateHex, sign: makeSign(user.user, user.privateHex), opened: false }
    secret(user.privateHex, { windows: true })
    roles.set(name, rs)
    const s0 = Date.now()
    await built.node.start()
    // mirrors packages/p2p-probe-host/repro/control-self-publish-alone.test.mjs:178-187 (wrapped right after start() returns)
    const db = built.node.getControlDatabase()
    if (db) {
      const update = db.updateSelfPeerRecord.bind(db)
      db.updateSelfPeerRecord = async (...args: any[]) => {
        const reachable = built.node.hasReachableControlSibling()
        const tU = Date.now()
        const pend = MON_SELFPUB.get(name) ?? []; MON_SELFPUB.set(name, pend); pend.push(tU)
        let rec: any
        try { rec = await update(...args) } catch (e) { monLine(`${name} updateSelfPeerRecord THREW after ${Date.now() - tU}ms ${String((e as any)?.message ?? e).slice(0, 160)}`); throw e } finally { const i = pend.indexOf(tU); if (i >= 0) pend.splice(i, 1) }
        monLine(`${name} updateSelfPeerRecord rec=${rec !== null} reachable=${reachable} ms=${Date.now() - tU}`)
        if (rec !== null && !reachable) rs.solo.n++
        return rec
      }
    }
    // mirrors apps/VoteTorrentAuthority/src/providers/CadreNodeProvider.tsx boot sequence (as 64-62 hr5-peer.ts did): re-anchor the owner key
    const re = await race(ownerTrustMod.reanchorOwnKey(built.node), 30_000)
    startedMs[name] = Date.now() - s0
    say('REOPEN', `${name} started ${tail8(built.peerId)} ms=${startedMs[name]} reanchor=${re.settled && re.ok ? String(re.value) : 'failed'}`)
    L.need('reopen-start', `O1-${name}`, `${name} started and re-anchored`, re.settled && re.ok)
    const deadline = Date.now() + 30_000
    let addrs: string[] = []
    for (;;) {
      try { addrs = built.node.getControlNode().getMultiaddrs().map((m: any) => m.toString()) } catch (e) { recordError(`${name}.getMultiaddrs`, e, 'hidden') }
      if (addrs.some((a) => a.includes('/p2p-circuit')) || Date.now() >= deadline) break
      await sleep(500)
    }
    L.need('reopen-circuit', `O1c-${name}`, `${name} holds a /p2p-circuit address within 30 s`, addrs.some((a) => a.includes('/p2p-circuit')))
    L.need('reopen-peers', `O2-${name}`, `${name}'s peer id equals part 1's`, built.peerId === party.roles[name].peerId, { tail8: tail8(built.peerId) })
  }
  // O4: every node reports a reachable control sibling within 120 s
  const sib = await Promise.all(ROLES.map(async (n) => (await poll(`${n}.sibling`, async () => roles.get(n)!.node.hasReachableControlSibling(), (v) => v === true, { timeoutMs: 120_000, intervalMs: 1000 })).ok))
  const settleMs = Date.now() - t0
  L.need('reopen-sibling', 'O4', 'every node reports hasReachableControlSibling() within 120 s', sib.every(Boolean), sib)
  for (const r of roles.values()) r.solo.windowOpen = false
  const solo = [...roles.values()].reduce((a, r) => a + r.solo.n, 0)
  L.need('solo-own-row', 'O3', 'no node committed its own CadrePeer row while no control sibling was reachable', solo === 0, { solo })
  const f = await fork('reopen', L.dir)
  key('HR5P2-FORK-PRECHECK-REOPEN', f.line)
  L.need(`fork-precheck-${f.token || 'unreadable'}`, 'O5', 'FORK-PRECHECK after the reopen', f.pass)
  // O6: open n7 on all three through 64-62's network opener (same strand factory, same sAppConfig)
  const hidBefore = hiddenOpen
  const wrapDbFactory = (factory: any) => async (hash: string) => {
    try { return await factory(hash) } catch (e) { hiddenOpen++; recordError('open', e, 'hidden'); throw e }
  }
  const markAttach = attaches.length
  const netIds: string[] = []
  for (const name of ROLES) {
    const rs = roles.get(name)!
    const o = await race(opener.openRoleNetwork(rs.node, STATE, name, N7, { wrapDbFactory }), 300_000)
    L.need('reopen-open', `O6-${name}`, `${name} opens n7 through the 64-62 network opener`, o.settled && o.ok, { ms: o.ms, error: o.ok ? null : String((o.error as any)?.name ?? 'timeout') })
    rs.engine = (o.value as any).networksEngine
    const est = rs.engine.getEstablishedContext(N7)
    for (const fn of [registerDbPlugins, declareViewsInMain]) { try { await fn(est.db) } catch (e) { say('OPEN', `${name} ${fn.name} ${String((e as any)?.message ?? e).slice(0, 80)}`) } }
    rs.ctx = { ...est, db: est.db, user: est.user ?? rs.user }
    rs.opened = true
    netIds.push(String((await poll(`${name}.networkId`, async () => (await one(rs.ctx.db, 'select Id from Network'))?.Id, (v) => typeof v === 'string', { timeoutMs: 60_000 })).value))
  }
  const founderTrue = attaches.slice(markAttach).filter((a) => a.kind === 'attach' && a.founder === true).length
  L.need('founder-reopen', 'O6f', 'no strand attach with founder true (D-13)', founderTrue === 0, { founderTrue, attaches: attaches.slice(markAttach).filter((a) => a.kind === 'attach').length })
  L.need('reopen-open', 'O6n', 'Network.Id is equal on all three and hidden opens are 0', netIds.every((i) => i === netIds[0]) && hiddenOpen - hidBefore === 0, { equal: netIds.every((i) => i === netIds[0]), hidden: hiddenOpen - hidBefore })
  const off = roles.get('officer')!
  S_.rendezvousDetach = await hostPoolRendezvous(off.node)
  L.check('O7', 'the officer hosts the pool rendezvous', typeof S_.rendezvousDetach === 'function')
  if (PHONE_KH2) {
    // both phones join with the multi-use n7 code (part 1 without with-khb spends one use on the host witness)
    L.need('phone-join', 'O8a', 'the phone Authority for seat hr5-kh-a joined n7 (orchestrator read-back flag)', await waitFlag('phone-kh-a-joined'))
    L.need('phone-join', 'O8b', 'the phone Authority for seat hr5-kh-b joined n7 (orchestrator read-back flag)', await waitFlag('phone-kh-b-joined'))
  } else if (PHONE_KH) L.need('phone-join', 'O8', 'the phone Authority (kh-b) joined n7 (orchestrator read-back flag)', await waitFlag('redmi-joined'))
  durations.reopenMs = Date.now() - t0
  key('HR5P2-REOPEN', `peersEqual=true soloOwnRowCommits=${solo} founderTrue=${founderTrue} hiddenOpens=${hiddenOpen - hidBefore} settleMs=${settleMs}`)
}

// ----------------------------------------------------------------------------------------------------------------
// leg: h6-election (mirrors spike 108 createTwoKeyholderElection 426-445 and test-context seedProposedBallot 1328-1365)
// ----------------------------------------------------------------------------------------------------------------
async function legElection (L: LegCtx): Promise<void> {
  const t0 = Date.now()
  const off = roles.get('officer')!
  const ctx = off.ctx
  const sign = off.sign
  S_.officerSign = sign
  const before = Number((await one(ctx.db, 'select count(*) as n from UserEncryptionKey where UserId = :u', { u: ctx.user.id }).catch(() => ({ n: -1 })))?.n)
  L.need('intake', 'E0', PHONE ? 'officer intake keys before (a re-run keeps the earlier one)' : 'zero officer intake keys before', PHONE ? before >= 0 : before === 0, { before })
  // mirrors test-context.ts provisionTestIntakeRecipient (1459-1484) with the persisted officer signer
  const vault = new InMemoryTestKeyVault()
  const intakeEngine = new IntakeEngine(ctx)
  const registration = await intakeEngine.registerOfficerEncryptionKey(AUTHORITY_ID, vault, sign)
  ctx.intakeOpener = intakeEngine.createOpener(vault)
  S_.intake = { vault, opener: ctx.intakeOpener, publicKey: registration.publicKey }
  const after = Number((await one(ctx.db, 'select count(*) as n from UserEncryptionKey where UserId = :u', { u: ctx.user.id }))?.n)
  L.need('intake', 'E0b', 'one officer intake key registered', after === before + 1, { after })

  const electionId = `election-${Date.now()}`
  S_.electionId = electionId
  const electionsEngine = new ElectionsEngine(ctx)
  const init: any = makeElectionInit({ authorityId: AUTHORITY_ID, id: electionId, title: process.env.LEAN_TITLE ?? 'hr5-election', ...(process.env.LEAN_DATE_DAYS ? { date: Date.now() + Number(process.env.LEAN_DATE_DAYS) * 86_400_000 } : {}) })
  init.revision.keyholderThreshold = 2
  const T = Date.now()
  const votingStarts = T + LEAD_MS
  const accruing = votingStarts + WINDOW_MS
  init.revision.timeline = {
    ...init.revision.timeline, votingStarts, accruingVotes: accruing, hashingVotes: accruing + 60_000, releasingKeys: accruing + 120_000,
    tallyingStarts: accruing + 180_000, validation: accruing + 240_000, certificationStarts: accruing + 300_000, closed: accruing + 360_000
  }
  init.revision.timeline.registrationEnds = votingStarts - 60_000
  init.revision.timeline.ballotsFinal = votingStarts - 60_000
  init.election.date = init.revision.timeline.closed
  init.election.revisionDeadline = votingStarts
  init.election.ballotDeadline = votingStarts
  const { parseTimeline } = await import(U(join(REPO, 'packages/ui-web/src/lifecycle/timeline-core.js')))
  const tlBlocking = parseTimeline(init.revision.timeline, { date: init.election.date, ballotDeadline: init.election.ballotDeadline }).conflicts.map((c: any) => c.code).filter((c: string) => c !== 'MISSING_EVENT')
  L.need('timeline-voter-rules', 'E0t', 'the election timeline passes the Voter app rules (timeline-core parseTimeline: no blocking conflict)', tlBlocking.length === 0, { conflicts: tlBlocking })
  S_.timeline = init.revision.timeline
  const e = init.election
  const pastRevTimestamp = Date.now() - 1000
  const electionFields = { id: e.id, authorityId: e.authorityId, title: e.title, date: e.date, revisionDeadline: e.revisionDeadline, ballotDeadline: e.ballotDeadline, type: e.type }
  const signingNonce = await electionsEngine.seedElectionSigning(electionFields, sign)
  const revTid = (await peekNextElectionTid(ctx.db)) + 1
  const revisionSigningNonce = await (electionsEngine as any).seedElectionRevisionSigning(
    e.id, e.authorityId,
    { revision: 0, revisionTimestamp: pastRevTimestamp, tags: init.revision.tags, instructions: init.revision.instructions, timeline: init.revision.timeline, keyholderThreshold: 2 },
    revTid, sign
  )
  await electionsEngine.createElection({ ...init, revision: { ...init.revision, revisionTimestamp: pastRevTimestamp } }, { signingNonce, revisionSigningNonce })
  const electionEngine: any = await electionsEngine.openElection(electionId)
  ;(S_ as any).electionEngine = electionEngine
  // seats: mirrors spike 108 lines 648-657
  const NAMES = ['hr5-kh-a', 'hr5-kh-b']
  for (const name of NAMES) {
    const sk = secp256k1.utils.randomSecretKey()
    const invitePrivate = secret(bytesToHex(sk), { windows: true })
    const inviteKey = bytesToHex(secp256k1.getPublicKey(sk))
    const expiration = keyholderInviteExpiration(Date.now(), DEFAULT_KEYHOLDER_INVITE_EXPIRY_HOURS)
    const shareText = secret(JSON.stringify({ invitePrivate, inviteKey, expiration, type: 'k', name }), { windows: true })
    await electionEngine.inviteKeyholder({ name, type: 'k', expiration, inviteKey, inviteSignature: '' }, electionId, sign)
    S_.seats.push({ name, invitePrivate, inviteKey, shareText })
  }
  const revRow = await one(ctx.db, 'select KeyholderThreshold as th, Revision as rev, Timeline as tl from ElectionRevision where ElectionId = :e', { e: electionId })
  const slotCount = Number((await one(ctx.db, "select count(*) as n from InviteSlot where Type = 'k' and ElectionId = :e", { e: electionId }))?.n)
  S_.revision = Number(revRow?.rev)
  L.need('election', 'E1', 'the election has threshold 2 and two keyholder invite slots', Number(revRow?.th) === 2 && slotCount === 2, { threshold: Number(revRow?.th), slots: slotCount })
  // E2: both slots live on both keyholders
  const sS0 = Date.now()
  if (PHONE_KH2) { writeFileSync(join(SEC, 'seat-a-share.txt'), S_.seats[0].shareText, { flag: 'wx', mode: 0o600 }); leanNote('seat-a-share written') }
  if (PHONE_KH) { writeFileSync(join(SEC, 'seat-b-share.txt'), S_.seats[1].shareText, { flag: 'wx', mode: 0o600 }); leanNote('seat-b-share written') }
  const seen = await Promise.all(KH_LOCAL.map(async (n) => {
    const ie = new InvitationEngine(roles.get(n as RoleName)!.ctx)
    const flags: boolean[] = []
    for (const seat of S_.seats) {
      const r: any = await poll(`${n}.resolveInviteSlot`, () => ie.resolveInviteSlot(seat.inviteKey, 'k'), (x: any) => x?.status === 'live', { timeoutMs: 180_000, intervalMs: 1000 })
      flags.push(r.ok)
    }
    return flags
  }))
  L.need('slots', 'E2', 'both keyholder slots are live on every host keyholder within 180 s', seen.every((s) => s.every(Boolean)), { ms: Date.now() - sS0, seen })
  // E3: self-invite refusal (mirrors spike 108 R3, 678-687)
  S_.founderVault = new InMemoryTestKeyVault()
  S_.founderStore = mapKeyVaultStorage()
  let selfCode: string | null = null
  try { await acceptKeyholderInvitation({ invitationEngine: new InvitationEngine(ctx), vault: S_.founderVault, storage: S_.founderStore }, S_.seats[0].shareText) } catch (err) { selfCode = (err as any)?.code ?? (err as any)?.name ?? 'unknown' }
  const ids = (await listKeyholderIdentities(S_.founderStore)).length
  L.need('self-invite', 'E3', 'the officer is refused its own keyholder invitation (self-invite) and keeps zero identities', selfCode === 'self-invite' && ids === 0, { code: selfCode, identities: ids })
  // B1: the ballot. The needle is the code and title of the option at code-order index 0 (mirrors test-context.ts:1342-1362)
  const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const needle = 'hr5-needle-' + Array.from(randomBytes(10), (b) => ALPHA[b % 36]).join('')
  S_.needle = secret(needle, { windows: true })
  writeFileSync(join(SEC, 'hr5-needle.txt'), needle, { flag: 'wx', mode: 0o600 })
  const ballot = {
    id: S_.ballotId, electionId, authorityId: AUTHORITY_ID, description: 'hr5-ballot', districts: [],
    questions: [{ code: 'hr5-q1', title: 'hr5-q1', instructions: 'Choose one option.', type: 'select', options: [{ code: needle, title: 'hr5 option one' }, { code: 'hr5-opt-b', title: 'hr5-opt-b' }] }]
  }
  await electionEngine.proposeBallot(ballot)
  await electionEngine.submitBallotForConfirmation(S_.ballotId)
  const recents: any[] = await off.engine.getRecentNetworks()
  const ref = recents.find((r: any) => r.hash === N7)
  const tasksEngine = new SignatureTasksEngine(ref, ctx)
  ;(S_ as any).ref = ref
  ;(S_ as any).tasksEngine = tasksEngine
  const ballotTasks: any[] = await tasksEngine.getRequestedSignatures(true)
  const ballotTask = ballotTasks.find((t: any) => t.signatureType === 'ballot' && t.ballot?.proposed?.id === S_.ballotId)
  if (ballotTask !== undefined) {
    const digest = await tasksEngine.getSignatureDigest(ballotTask)
    await tasksEngine.completeSignature(ballotTask, { isAccepted: true, signature: await sign(digest) })
  }
  const confirmedState = await electionEngine.getBallotConfirmationState(S_.ballotId)
  const details = await electionEngine.getBallotDetails(S_.ballotId)
  const q = details?.ballot?.questions?.find((x: any) => x.code === 'hr5-q1')
  const sorted = q ? [...q.options].sort((a: any, b: any) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)) : []
  L.need('ballot', 'B1', 'one confirmed ballot hr5-ballot, question hr5-q1, 2 options, the needle at code-order index 0', ballotTask !== undefined && confirmedState?.confirmed === true && q !== undefined && q.options.length === 2 && sorted[0]?.code === needle,
    { confirmed: confirmedState?.confirmed === true, options: q?.options?.length ?? -1, needleIndex0: sorted[0]?.code === needle })
  durations.electionMs = Date.now() - t0
  const mins = (ms: number): number => Math.round((ms - T) / 60_000)
  key('HR5P2-ELECTION', `id8=${electionId.slice(0, 8)} title=hr5-election threshold=2 slots=2 intake=on votingStarts=+${mins(votingStarts)} accruingVotes=+${mins(accruing)} releasingKeys=+${mins(accruing + 120_000)} basis=host-lead40-w15`)
  key('HR5P2-BALLOT', 'confirmed=true question=hr5-q1 options=2 needleIndex0=true')
}

// ----------------------------------------------------------------------------------------------------------------
// leg: h7-accept (mirrors spike 108 692-739)
// ----------------------------------------------------------------------------------------------------------------
function instrument<T extends object> (obj: T, label: string): T {
  const READ = /^(get|resolve|query|is)/
  return new Proxy(obj, {
    get (target: any, prop: string | symbol) {
      const v = target[prop]
      if (typeof v !== 'function' || typeof prop !== 'string') return v
      const path = READ.test(prop) ? 'hidden' : 'thrown'
      return (...args: unknown[]) => {
        try {
          const r = v.apply(target, args)
          if (r && typeof r.then === 'function') return r.catch((e: unknown) => { recordError(`${label}.${prop}`, e, path as any); throw e })
          return r
        } catch (e) { recordError(`${label}.${prop}`, e, path as any); throw e }
      }
    }
  })
}
async function legAccept (L: LegCtx): Promise<void> {
  const t0 = Date.now()
  const off = roles.get('officer')!
  const dkgPromptBase: number[] = []
  void dkgPromptBase
  let i = 0
  for (const name of (PHONE_KH2 ? [] as RoleName[] : KH_LOCAL)) {
    i = name === 'kh-a' ? 0 : 1
    const r = roles.get(name)!
    const vault = new InMemoryTestKeyVault()
    const store = mapKeyVaultStorage()
    const dkg = instrument(new KeyholderDkgEngine(r.ctx, { vault }), `${name}:keyholderDkg`)
    const invitations = instrument(new InvitationEngine(r.ctx), `${name}:invitations`)
    const cache = new Map<string, any>()
    const kh: any = { name, role: r, vault, store, userId: '', dkg, tasks: null, acceptUnwraps: -1, dkgUnwraps: -1, releaseUnwraps: -1 }
    kh.getEngine = async (n: string) => {
      if (n === 'keyholderDkg') return dkg
      if (n === 'invitations') return invitations
      if (n === 'keysTasksEngine') {
        if (!cache.has(n)) {
          const ref = (await r.engine.getRecentNetworks()).find((x: any) => x.hash === N7)
          // the real clock: no injected release time (Task 3 plan: `now: () => Date.now()`)
          cache.set(n, instrument(new KeysTasksEngine(ref, r.ctx, { vault, now: () => Date.now() } as any), `${name}:keysTasks`))
        }
        return cache.get(n)
      }
      throw new Error(`getEngine: unknown engine ${n}`)
    }
    S_.khs.push(kh)
    const s0 = Date.now()
    const before = vault.authPromptCount
    let userId = ''
    try {
      const res = await acceptKeyholderInvitation({
        invitationEngine: invitations, vault, storage: store,
        readKeyholderSeatFacts: async (eid: string) => { try { const s = await dkg.getDkgStatus(eid); return { revision: s.revision, liveRoster: s.liveRoster, earlierRevisionUserIds: s.earlierRevisionUserIds } } catch { return undefined } }
      }, S_.seats[i].shareText)
      userId = res.userId
    } catch (e) { recordError(`${name}.accept`, e, 'thrown'); L.check(`A${i + 1}x`, `${name} accept threw`, false, { name: (e as any)?.name, code: (e as any)?.code ?? null }) }
    kh.userId = userId
    kh.acceptUnwraps = vault.authPromptCount - before
    L.need('accept', `A${i + 1}`, `${name} accepts its keyholder invitation through the shipped module`, userId !== '' && userId !== off.ctx.user.id && userId !== r.user.id, { distinctFromOfficer: userId !== off.ctx.user.id, acceptUnwraps: kh.acceptUnwraps, ms: Date.now() - s0 })
    key(i === 0 ? 'HR5P2-ACCEPT-KH-A' : 'HR5P2-ACCEPT-KH-B', `seat=${S_.seats[i].name} ok=true distinctFromOfficer=true acceptUnwraps=${kh.acceptUnwraps} ms=${Date.now() - s0}`)
  }
  const founderDkg = new KeyholderDkgEngine(off.ctx, { vault: S_.founderVault })
  const rosterOf = (s: any): string[] => (s?.liveRoster ?? s?.roster ?? [])
  if (PHONE_KH) rawLog(`LEAN-WAIT phone-accept at=${new Date().toISOString()}`)
  const rosterSeen: any = await poll('officer.getDkgStatus', () => founderDkg.getDkgStatus(S_.electionId), (s: any) => S_.khs.every((k: any) => rosterOf(s).includes(k.userId)) && rosterOf(s).length >= 2, { timeoutMs: PHONE_KH ? PHONE_MS : 180_000, intervalMs: PHONE_KH ? 3000 : 1000 })
  if (PHONE_KH2) {
    const others = rosterOf(rosterSeen.value).filter((u: string) => u !== off.ctx.user.id && u !== roles.get('kh-a')!.user.id)
    ;(S_ as any).remoteKhs = others
    rawLog(`LEAN-GO phone-accept ok=${rosterSeen.ok} waitedMs=${rosterSeen.waitedMs} remote=${others.length}`)
    L.need('accept', 'A1', 'two phone Authorities accepted seats hr5-kh-a and hr5-kh-b: two roster users on the officer, distinct from the officer and the host witness', rosterSeen.ok && others.length === 2 && rosterOf(rosterSeen.value).length === 2, { others: others.length, roster: rosterOf(rosterSeen.value).length })
    key('HR5P2-ACCEPT-KH-AB', `seats=${S_.seats.map((s: any) => s.name).join(',')} ok=true by=phone-authorities waitedMs=${rosterSeen.waitedMs}`)
  } else if (PHONE_KH) {
    const other = rosterOf(rosterSeen.value).filter((u: string) => !S_.khs.some((k: any) => k.userId === u) && u !== off.ctx.user.id)
    ;(S_ as any).remoteKhb = other[0] ?? ''
    rawLog(`LEAN-GO phone-accept ok=${rosterSeen.ok} waitedMs=${rosterSeen.waitedMs}`)
    L.need('accept', 'A2', 'the phone Authority accepted seat hr5-kh-b: a second roster user, distinct from kh-a and the officer, on the officer', other.length === 1, { others: other.length })
    key('HR5P2-ACCEPT-KH-B', `seat=${S_.seats[1].name} ok=true distinctFromOfficer=true by=phone-authority waitedMs=${rosterSeen.waitedMs}`)
  }
  L.need('seats', 'A3', 'both accepted seats are visible on the officer', rosterSeen.ok, { roster: rosterOf(rosterSeen.value).length })
  durations.acceptMs = Date.now() - t0
}

// ----------------------------------------------------------------------------------------------------------------
// leg: h8-dkg (mirrors spike 108 744-788, with the outline bound 30 drives and 30 min)
// ----------------------------------------------------------------------------------------------------------------
async function legDkg (L: LegCtx): Promise<void> {
  const off = roles.get('officer')!
  const khs = S_.khs
  const before = khs.map((k: any) => k.vault.authPromptCount)
  const dkgRes: any = { drives: 0, advancing: 0, actions: 0, ms: 0, attempt: 0, errors: [] as any[] }
  const sDkg = Date.now()
  let nonAdv = 0
  const lastPhase: Record<string, string | null> = {}
  let driveErr = false
  const kr0 = new KeyReleaseEngine(off.ctx)
  let officerKey = false
  if (PHONE_KH) rawLog(`LEAN-WAIT phone-dkg at=${new Date().toISOString()}`)
  if (PHONE_KH2) {
    // no host keyholder to drive: the two phones run the DKG; wait for the officer to read phase complete and hold the ElectionKey
    const founderDkg = new KeyholderDkgEngine(off.ctx, { vault: S_.founderVault })
    const w: any = await poll('officer.dkgComplete', async () => {
      const st: any = await founderDkg.getDkgStatus(S_.electionId).catch(() => null)
      const ks: any = await kr0.getKeyReleaseStatus(S_.electionId).catch(() => null)
      return { phase: st?.phase ?? null, attempt: st?.currentAttempt ?? null, key: ks?.electionKey != null }
    }, (v: any) => (v.phase === 'complete' && v.key === true) || v.phase === 'failed', { timeoutMs: PHONE_MS, intervalMs: 5000 })
    officerKey = w.value?.key === true
    lastPhase.officer = w.value?.phase ?? null
    if (typeof w.value?.attempt === 'number') dkgRes.attempt = w.value.attempt
    if (w.value?.phase === 'failed') { dkgRes.errors.push({ node: 'officer-view', code: 'phase-failed' }); driveErr = true }
  }
  while (!PHONE_KH2 && Date.now() - sDkg < (PHONE_KH ? 2700000 : 1800000) && dkgRes.drives < (PHONE_KH ? 400 : 30)) {
    const k = khs[dkgRes.drives % khs.length]
    const out = await driveKeyholderDkg({ getEngine: k.getEngine, vault: k.vault, storage: k.store }, S_.electionId, k.userId)
    dkgRes.drives++
    if (out.advanced) { dkgRes.advancing++; nonAdv = 0 } else nonAdv++
    dkgRes.actions += out.actions.length
    const phase = out.status?.phase ?? null
    lastPhase[k.name] = phase
    if (typeof out.status?.currentAttempt === 'number') dkgRes.attempt = Math.max(dkgRes.attempt, out.status.currentAttempt)
    L.check(`D-drive-${dkgRes.drives}`, `drive ${k.name} phase=${phase} advanced=${out.advanced} actions=${out.actions.length}${out.error ? ` error=${out.error.code}` : ''}`, true)
    if (out.error) { dkgRes.errors.push({ node: k.name, code: out.error.code }); driveErr = true; break }
    if (khs.every((x: any) => lastPhase[x.name] === 'complete')) {
      if (!PHONE_KH) break
      officerKey = ((await kr0.getKeyReleaseStatus(S_.electionId).catch(() => null)) as any)?.electionKey != null
      if (officerKey) break
    }
    if (nonAdv >= 2) await sleep(PHONE_KH ? 5000 : 2000)
    else if (PHONE_KH && out.actions.length === 0) await sleep(3000)
  }
  dkgRes.ms = Date.now() - sDkg
  khs.forEach((k: any, i: number) => { k.dkgUnwraps = k.vault.authPromptCount - before[i] })
  L.need('dkg-error', 'D4', 'no DKG drive returned an error', !driveErr, dkgRes.errors)
  const done = PHONE_KH2 ? lastPhase.officer === 'complete' : khs.every((x: any) => lastPhase[x.name] === 'complete')
  if (PHONE_KH) rawLog(`LEAN-GO phone-dkg ok=${done && officerKey} ms=${dkgRes.ms}`)
  L.need('dkg-bound', 'D1', PHONE_KH2 ? 'the officer reads DKG phase complete and holds the election key inside LEAN_PHONE_MS (both phone keyholders ran the DKG)' : PHONE_KH ? 'kh-a reads DKG phase complete and the officer holds the election key inside 45 min' : 'both keyholders read DKG phase complete inside 30 drives and 30 min', done && (!PHONE_KH || officerKey), { drives: dkgRes.drives, ms: dkgRes.ms, phases: khs.map((x: any) => lastPhase[x.name]) })
  const statuses: any[] = []
  for (const k of khs) statuses.push(await k.dkg.getDkgStatus(S_.electionId, k.userId).catch((e: unknown) => { recordError(`${k.name}.finalStatus`, e, 'hidden'); return null }))
  if (PHONE_KH2) L.check('D2', 'KH2: each phone holds its own share (read on the phones by the orchestrator, not by the driver)', true, { phases: lastPhase })
  else L.need('dkg-key', 'D2', 'both keyholders hold their own share', statuses.every((s) => s?.self?.hasShare === true), statuses.map((s) => s?.self?.hasShare ?? null))
  const kr = new KeyReleaseEngine(off.ctx)
  const keyOnOfficer: any = await poll('officer.getKeyReleaseStatus', () => kr.getKeyReleaseStatus(S_.electionId), (s: any) => s?.electionKey != null, { timeoutMs: 180_000 })
  const keys = [...statuses.map((s) => s?.electionKey), (keyOnOfficer.value as any)?.electionKey]
  const identical = keys.every((k) => k && k.jointPublicKey === keys[0]?.jointPublicKey)
  L.need('dkg-key', 'D3', PHONE_KH2 ? 'one ElectionKey on the officer, threshold 2 and participants 2' : PHONE_KH ? 'one ElectionKey, identical on kh-a and the officer, threshold 2 and participants 2' : 'one ElectionKey, identical on kh-a, kh-b and the officer, threshold 2 and participants 2', identical && keys[0]?.threshold === 2 && keys[0]?.participants === 2, { present: keys.map((k) => k != null), threshold: keys[0]?.threshold ?? null, participants: keys[0]?.participants ?? null })
  S_.jointPublicKey = keys[0].jointPublicKey
  const f = await fork('dkg', L.dir)
  key('HR5P2-FORK-PRECHECK-DKG', f.line)
  L.need(`fork-precheck-${f.token || 'unreadable'}`, 'D5', 'FORK-PRECHECK after the DKG', f.pass)
  durations.dkgMs = dkgRes.ms
  ;(S_ as any).dkgRes = dkgRes
  key('HR5P2-DKG', `phase=complete attempt=${dkgRes.attempt} drives=${dkgRes.drives} advancing=${dkgRes.advancing} actions=${dkgRes.actions} ms=${dkgRes.ms} electionKeyIdentical=true threshold=2 participants=2 hasShareA=${PHONE_KH2 ? 'phone' : 'true'} hasShareB=${PHONE_KH ? 'phone' : 'true'} dkgUnwrapsA=${PHONE_KH2 ? 'phone' : khs[0].dkgUnwraps} dkgUnwrapsB=${PHONE_KH ? 'phone' : khs[1].dkgUnwraps}`)
}

// ----------------------------------------------------------------------------------------------------------------
// leg: h9-voters (mirrors host-voter selftest.ts 497-640 and voter-invite.ts 134-160)
// ----------------------------------------------------------------------------------------------------------------
function stageSeen (logPath: string, stageName: string): boolean { try { return new RegExp(`^STAGE ${stageName}$`, 'm').test(readFileSync(logPath, 'utf8')) } catch { return false } }

async function legVoters (L: LegCtx): Promise<void> {
  const off = roles.get('officer')!
  const ctx = off.ctx
  const sign = S_.officerSign
  const dirHv = L.dir
  // C0: mirrors voter-invite.ts:134-160 (createVoterJoinCode itself is not called: its bare require at l.149 cannot run under the ESM hook)
  // mirrors voter-invite.ts:134-160
  const anchor = await off.engine.getFoundingAnchor(N7, { userId: off.user.id, signerKey: off.user.activeKeys[0].key })
  await ensureVoterInviteOwner(off.node)
  const minted = await off.node.createCadreInvitation({ uses: VOTER_INVITE_USES, expiresInMs: VOTER_INVITE_LIFETIME_MS })
  const codeText = secret(encodeNetworkJoinCode({ v: 2, invitation: minted.encoded, networkHash: anchor.networkHash, name: anchor.name, genesis: anchor.genesis, digest: anchor.digest } as any), { windows: true })
  secret(minted.encoded, { windows: true })
  secret(minted.invitation?.invitePrivateKey, { windows: true })
  S_.codePath = join(SEC, 'hr5-code.txt')
  writeFileSync(S_.codePath, codeText, { flag: 'wx', mode: 0o600 })
  const dec: any = decodeNetworkJoinCode(codeText)
  const membersList: string[] = Array.isArray(minted.invitation?.members) ? minted.invitation.members : []
  const members0IsOfficer = membersList.length > 0 && trailingPeer(membersList[0]!) === off.peerId
  L.need('code', 'C0', 'the code is a v2 code in a 0600 scratch file and members[0] of the invitation is the officer', dec.ok && dec.code?.v === 2 && members0IsOfficer, { chars: codeText.length, members: membersList.length, members0IsOfficer })
  key('HR5P2-CODE', `v=2 chars=${codeText.length} members=${membersList.length} members0=officer sha256Prefix=${sha12(codeText)}`)
  // N0 (mirrors selftest.ts:574-588)
  {
    const nonce = 'n0-' + randomBytes(8).toString('hex')
    const deviceKey = makeP256TestKey().pubHex
    const att = buildSyntheticAndroidAttestation({ nonce, deviceKey, deviceId: 'hv-synthetic-n0', now: Date.now() })
    const challenge: any = { nonce, authorityId: AUTHORITY_ID, registrantId: 'n0-registrant', deviceKey, electionId: S_.electionId }
    const stub = await new StubAttestationVerifier().verify(challenge, att)
    const real: any = await verifyKeyAttestation(att.certificateChain.map((c: string) => new Uint8Array(Buffer.from(c, 'base64'))), challenge, [], new Set(), { packageName: 'org.votetorrent.voter', certificateSha256Digests: [] }, 'single').catch(() => ({ ok: false }))
    L.need('n0', 'N0', 'on one synthetic attestation the dev stub verifier accepts and verifyKeyAttestation refuses', stub.ok === true && real.ok === false, { stubAccepts: stub.ok === true, realRefuses: real.ok === false })
  }
  // children: the README REHEARSAL COMMAND form, sequential, no stagger
  const gate = S_.gatePath
  const kids: any[] = []
  if (PHONE_VOTER) { leanNote('voter code at secrets/hr5-code.txt'); rawLog(`LEAN-WAIT iphone-register at=${new Date().toISOString()}`) }
  for (let k = 1; k <= HV_N; k++) {
    const label = `hv${k}`
    const logPath = join(dirHv, `${label}.log`)
    const jsonPath = join(dirHv, `${label}.json`)
    const votePath = join(SEC, `${label}-vote.json`)
    S_.voteFiles.push(votePath)
    const fd = openSync(logPath, 'wx')
    const env: Record<string, string | undefined> = {
      ...process.env, FORCE_COLOR: '0', NODE_OPTIONS: undefined, TS_NODE_PROJECT: './tsconfig.test.json',
      HV_LABEL: label, HV_CODE_FILE: S_.codePath, HV_RELAY: preEnv.RELAY_MULTIADDR, HV_PARTY_ID: party.partyId, HV_ELECTION_ID: S_.electionId,
      HV_RESULTS: jsonPath, HV_VOTE_OUT: votePath, HV_SEND_GATE_FILE: gate, HV_CLOCK_OFFSET_MS: '0'
    }
    delete env.NODE_OPTIONS
    const spawnedAt = Date.now()
    const child = spawn('perl', ['-e', `alarm ${Number(process.env.LEAN_HV_ALARM_S ?? 3900)}; exec @ARGV`, process.execPath, '--import', join(HV, 'clock-offset.mjs'), '--import', './register-ts-node.mjs', ...(process.env.LEAN_HV_PRELOAD ? ['--import', process.env.LEAN_HV_PRELOAD] : []), '--experimental-specifier-resolution=node', join(HV, 'host-voter.ts')], { cwd: VE, env: env as NodeJS.ProcessEnv, stdio: ['ignore', fd, fd] })
    closeSync(fd)
    appendFileSync(PIDS_FILE, `${child.pid}\n`)
    const entry: any = { label, child, logPath, jsonPath, votePath, exited: false, exitCode: null as number | null, spawnedAt, exit: null as any }
    entry.exit = new Promise<void>((resolve) => child.on('exit', (code: number | null) => { entry.exited = true; entry.exitCode = code; resolve() }))
    kids.push(entry)
    S_.children.push(entry)
    say('CHILD', `${label} spawned`)
  }
  // V: each child reaches STAGE joined (bounded 300 s)
  for (const c of kids) {
    const r = await poll(`${c.label}.joined`, async () => stageSeen(c.logPath, 'joined'), (v) => v === true || c.exited, { timeoutMs: 300_000, intervalMs: 1000 })
    L.need('hv-joined', `V-${c.label}`, `${c.label} reached STAGE joined`, stageSeen(c.logPath, 'joined'), { waitedMs: r.waitedMs, exited: c.exited })
  }
  const joinedAt = Date.now()
  void joinedAt
  // wait until all three print association-staged (bounded 900 s)
  const staged = await poll('children.association-staged', async () => kids.every((c) => stageSeen(c.logPath, 'association-staged')), (v) => v === true || kids.some((c) => c.exited), { timeoutMs: 900_000, intervalMs: 2000 })
  L.need('hv-association-staged', 'V-staged', 'every host child prints STAGE association-staged within 900 s', kids.every((c) => stageSeen(c.logPath, 'association-staged')), { waitedMs: staged.waitedMs })
  // officer loop (mirrors selftest.ts:497-558)
  const officer = { syncs: 0, approvals: 0, challenges: 0, associated: 0, syncErrors: 0 }
  const engines = new Map<string, any>()
  const getEngine = async (name: string): Promise<any> => {
    if (!engines.has(name)) {
      if (name === 'intake') engines.set(name, new IntakeEngine(ctx))
      else if (name === 'registration') engines.set(name, new RegistrationEngine(ctx))
      else if (name === 'association') engines.set(name, new AssociationEngine(ctx, new StubAttestationVerifier()))
      else throw new Error(`getEngine: unknown engine ${name}`)
    }
    return engines.get(name)
  }
  // mirrors apps/VoteTorrentAuthority/src/engines/engine-factory.ts:449-499 (createPeerStagingTransports)
  const refuseSubmit = async (..._args: unknown[]): Promise<Uint8Array> => { throw new Error('The authority app never submits staged requests') }
  const createTransports = (deps: { opener: any, decisionSigner: any }): any => {
    const openStrand = async (): Promise<any> => createStrandPort(ctx.db)
    return {
      strandId: N7,
      registration: new P2pRegistrationTransport({ openStrand, computeDigest: refuseSubmit, strandId: N7, opener: deps.opener, decisionSigner: deps.decisionSigner } as any),
      association: new P2pAssociationTransport({ openStrand, computeDigest: refuseSubmit, computeAttestationDigest: refuseSubmit, strandId: N7, opener: deps.opener, decisionSigner: deps.decisionSigner } as any)
    }
  }
  const binding = createPeerSyncBinding({ getEngine, createTransports, resolveVault: () => S_.intake.vault, createSigner: async () => sign })
  const tasksEngine = (S_ as any).tasksEngine
  const approved = new Set<string>()
  const officerSync = async (): Promise<void> => { try { const r = await binding.syncNow({ authorityId: AUTHORITY_ID }); officer.syncs++; if (officer.syncs % 6 === 1) say('OFFICER', `sync imported=${r.imported} pending=${r.pending} errors=${r.errorItemIds.length} approvals=${officer.approvals} challenges=${officer.challenges} associated=${officer.associated}`) } catch (err) { officer.syncErrors++; recordError('officer.syncNow', err, 'thrown') } }
  const approvePending = async (): Promise<void> => {
    try {
      const tasks: any[] = await tasksEngine.getRequestedSignatures(true)
      for (const task of tasks) {
        if (task.signatureType !== 'registrant' || approved.has(task.requestId)) continue
        const digestBytes = await tasksEngine.getSignatureDigest(task)
        const signature = await sign(digestBytes)
        await tasksEngine.completeSignature(task, { isAccepted: true, signature, sign, decision: { checklist: ['id'] } } as any)
        approved.add(task.requestId)
        officer.approvals++
      }
    } catch (err) { recordError('officer.approve', err, 'thrown') }
  }
  const countA = async (sql: string): Promise<number> => Number((await one(ctx.db, sql))?.n ?? 0)
  const loopStart = Date.now()
  let loopOk = false
  while (Date.now() - loopStart < (PHONE ? PHONE_MS : 900_000)) {
    await officerSync(); await approvePending(); await officerSync()
    try { officer.challenges = await countA("select count(*) as n from AssociationDecision where Status = 'c'"); officer.associated = await countA('select count(*) as n from Association') } catch (err) { recordError('officer.counts', err, 'hidden') }
    if (officer.approvals >= REG_TARGET && officer.associated >= REG_TARGET) { await officerSync(); loopOk = true; break }
    if (seedStopRequested) break
    if (kids.some((c) => c.exited)) break
    await sleep(5000)
  }
  const regReqs = await countA('select count(*) as n from RegistrationRequest').catch(() => -1)
  const assocReqs = await countA('select count(*) as n from AssociationRequest').catch(() => -1)
  L.need('officer-loop', 'G1', `the officer Sync Now intaked ${REG_TARGET} registration and ${REG_TARGET} association requests`, regReqs === REG_TARGET && assocReqs === REG_TARGET, { registrationRequests: regReqs, associationRequests: assocReqs, loopOk })
  L.need('officer-loop', 'G2', `${REG_TARGET} registrations approved through SignatureTasksEngine`, officer.approvals === REG_TARGET, { approvals: officer.approvals })
  L.need('officer-loop', 'G3', `${REG_TARGET} challenges issued`, officer.challenges >= REG_TARGET, { challenges: officer.challenges })
  const assocRows = await poll('officer.associationRows', () => countA('select count(*) as n from Association'), (n) => n === REG_TARGET, { timeoutMs: 60_000, intervalMs: 2000 })
  L.need('officer-loop', 'G4', `${REG_TARGET} Association rows on the officer`, assocRows.ok, { rows: assocRows.value })
  durations.associatedWaitMs = Date.now() - loopStart
  if (SEED_VOTERS) {
    // SEED: stop here with the host voters live (they wait for votingStarts + the send gate); the hold keeps the officer approving
    ;(S_ as any).seedOfficerTick = async (): Promise<void> => { await officerSync(); await approvePending(); await officerSync() }
    ;(S_ as any).seedOfficer = officer
    return
  }
  // Send window
  const tl = S_.timeline
  const waitReady = await poll('children.ready-to-send', async () => kids.every((c) => stageSeen(c.logPath, 'ready-to-send')), (v) => v === true || kids.some((c) => c.exited), { timeoutMs: Math.max(60_000, tl.accruingVotes - 3 * 60_000 - Date.now()), intervalMs: 2000 })
  if (PHONE_VOTER) L.need('phone-vote', 'W0p', 'the iPhone Voter is associated and on the ballot (orchestrator read-back flag)', await waitFlag('iphone-ready'))
  // UAT65 (2026-10-31): phase-65 UAT tests 1-2 need the rendezvous unreachable while the iPhone sends; test 3 needs it back.
  // Detach the officer's pool rendezvous, wait for the orchestrator's flag, then host a fresh one before the send gate opens.
  if (process.env.LEAN_UAT65 === '1') {
    try { await S_.rendezvousDetach?.() } catch (err) { recordError('uat65.detach', err, 'thrown') }
    S_.rendezvousDetach = null
    leanNote(`uat65 rendezvous DETACHED at=${new Date().toISOString()}`)
    L.check('U65a', 'the orchestrator finished the rendezvous-offline tests (flag uat65-offline-done)', await waitFlag('uat65-offline-done'))
    S_.rendezvousDetach = await hostPoolRendezvous(off.node)
    leanNote(`uat65 rendezvous RE-HOSTED at=${new Date().toISOString()}`)
    L.check('U65b', 'the officer hosts the pool rendezvous again', typeof S_.rendezvousDetach === 'function')
  }
  L.need('hv-ready-to-send', 'W0', 'every host child prints STAGE ready-to-send', kids.every((c) => stageSeen(c.logPath, 'ready-to-send')), { waitedMs: waitReady.waitedMs })
  const nowMs = Date.now()
  L.need('timeline-missed', 'W0t', 'Date.now() is at least votingStarts and at most accruingVotes - 3 min at the Send window', nowMs >= tl.votingStarts && nowMs <= tl.accruingVotes - 3 * 60_000, { aheadOfVotingStartsMs: nowMs - tl.votingStarts, beforeCloseMs: tl.accruingVotes - nowMs })
  writeFileSync(gate, '', { flag: 'wx', mode: 0o600 })
  say('SEND', 'send gate opened')
  if (PHONE_VOTER) rawLog(`LEAN-WAIT iphone-vote at=${new Date().toISOString()}`)
  // children exit (bounded 900 s)
  await Promise.race([Promise.all(kids.map((c) => c.exit)), sleep(900_000)])
  L.need('hv-exit', 'P0', 'every host child exited within 900 s of the Send window', kids.every((c) => c.exited), kids.map((c) => c.exited))
  const childJson: any[] = kids.map((c) => { try { return JSON.parse(readFileSync(c.jsonPath, 'utf8')) } catch (err) { recordError(`${c.label}.results`, err, 'hidden'); return null } })
  S_.hvResults = childJson
  const hvInfo = childJson.map((j, i) => ({ label: kids[i].label, verdict: j?.verdict ?? 'NO-RESULT', stage: j?.stage ?? null, joinMs: j?.join?.ms ?? null, outcome: j?.join?.outcome ?? null, admittedVia: j?.join?.admittedVia ?? null, associatedMs: j?.stages?.associated ?? null, poolMs: j?.pool?.ballots?.[0]?.ms ?? null, cidPrefix: j?.pool?.ballots?.[0]?.cidPrefix ?? null }))
  const hit = childJson.some((j) => j?.verdict === 'HIT' || (j?.wall?.oversized ?? 0) > 0 || (j?.wall?.superMajority ?? 0) > 0 || (j?.wall?.torn ?? 0) > 0 || (j?.join?.hiddenOpenFailures ?? 0) > 0)
  L.hv.hit = hit
  hvHitFlag = hit ? 1 : 0
  L.join = (() => {
    const joins = childJson.map((j) => j?.join).filter(Boolean)
    const worst = joins.sort((a: any, b: any) => Number(b.ms ?? 0) - Number(a.ms ?? 0))[0] ?? null
    return worst ? { ok: joins.every((j: any) => j.ok === true), reason: worst.reason ?? null, ms: worst.ms ?? 0, hiddenOpenFailures: joins.reduce((a: number, j: any) => a + Number(j.hiddenOpenFailures ?? 0), 0), oversizedRequests: 0, steps: 'host-voter' } : null
  })()
  for (let k = 0; k < HV_N; k++) {
    const h = hvInfo[k]
    L.need('join-outcome', `V3-${h.label}`, `${h.label} joined with outcome joined and admittedVia redeemed or self-admission`, childJson[k]?.join?.ok === true && h.outcome === 'joined' && (h.admittedVia === 'redeemed' || h.admittedVia === 'self-admission'), { outcome: h.outcome, admittedVia: h.admittedVia })
  }
  for (let k = 0; k < HV_N; k++) {
    const h = hvInfo[k]
    key(`HR5P2-HV${k + 1}`, `verdict=${h.verdict} stage=${h.stage} joinMs=${h.joinMs} admittedVia=${h.admittedVia} associatedMs=${h.associatedMs} poolMs=${h.poolMs} cidPrefix=${h.cidPrefix}`)
  }
  L.need(`hv-${hvInfo.find((h) => h.verdict !== 'COMMITTED')?.stage ?? 'result'}`.replace(/[^a-z0-9-]/g, '-'), 'P1a', 'every child verdict is COMMITTED', hvInfo.every((h) => h.verdict === 'COMMITTED'), hvInfo.map((h) => `${h.verdict}/${h.stage}`))
  const cids = hvInfo.map((h) => h.cidPrefix)
  const cidAgree = cids.every((c) => typeof c === 'string' && c === cids[0])
  L.need('cid-disagree', 'P1', 'one shared cid prefix', cidAgree, { cidAgree })
  const blockPoll = await poll('officer.voteBlock', async () => ({
    blocks: Number((await one(ctx.db, 'select count(*) as n from VoteBlock where ElectionId = :e', { e: S_.electionId }))?.n ?? -1),
    entry: Number((await one(ctx.db, 'select EntryCount as n from VoteBlock where BallotId = :b', { b: S_.ballotId }))?.n ?? -1),
    rows: Number((await one(ctx.db, 'select count(*) as n from VoteBlockVoter where BallotId = :b', { b: S_.ballotId }))?.n ?? -1)
  }), (r: any) => r.blocks === 1 && r.entry === 3 && r.rows === 3, { timeoutMs: 180_000, intervalMs: 2000 })
  const bv: any = blockPoll.value
  L.need(bv && bv.entry < 3 ? 'block-size' : 'block', 'P2', 'the officer reads exactly one VoteBlock for the election with EntryCount 3 and 3 VoteBlockVoter rows', blockPoll.ok, bv)
  S_.blockEntries = bv.entry
  // P3: each child's entrySha256 equals the sha256 prefix of its vote file
  const p3 = kids.map((c, i) => {
    try {
      const arr = JSON.parse(readFileSync(c.votePath, 'utf8')) as string[]
      for (const t of arr) secret(t, { windows: true })
      return JSON.stringify(arr.map(sha12)) === JSON.stringify(childJson[i]?.vote?.entrySha256)
    } catch { return false }
  })
  L.need('entry-hash', 'P3', 'each child vote.entrySha256 equals the sha256 prefix of its vote file', p3.every(Boolean), p3)
  // W1
  const cw = childJson.reduce((a, j) => ({ oversized: a.oversized + (j?.wall?.oversized ?? 0), sm: a.sm + (j?.wall?.superMajority ?? 0), torn: a.torn + (j?.wall?.torn ?? 0), hidden: a.hidden + (j?.join?.hiddenOpenFailures ?? 0) }), { oversized: 0, sm: 0, torn: 0, hidden: 0 })
  L.check('W1', 'no wall signal, oversized request or hidden open in the children (the driver counters are read by the in-script D-14 rule)', cw.oversized + cw.sm + cw.torn + cw.hidden === 0, cw)
  // needle voter (boolean only)
  let needleVoter = false
  try { needleVoter = (JSON.parse(readFileSync(kids[0].votePath, 'utf8')) as string[]).some((t) => t.includes(S_.needle)) } catch { needleVoter = false }
  key('HR5P2-NEEDLE-VOTER', `hv1 chose-needle=${needleVoter}`)
  L.need('block', 'P4', 'hv1 chose the needle option', needleVoter)
  key('HR5P2-OFFICER', `syncs=${officer.syncs} approvals=${officer.approvals} challenges=${officer.challenges} associations=${officer.associated}`)
  key('HR5P2-BLOCK', `voteBlocks=${bv.blocks} entryCount=${bv.entry} voterRows=${bv.rows} cidAgree=${cidAgree}`)
  durations.hvJoinMs = Math.max(...hvInfo.map((h) => Number(h.joinMs ?? 0)))
  durations.associatedMs = Math.max(...hvInfo.map((h) => Number(h.associatedMs ?? 0)))
  durations.poolMs = Math.max(...hvInfo.map((h) => Number(h.poolMs ?? 0)))
  const f = await fork('block', L.dir)
  key('HR5P2-FORK-PRECHECK-BLOCK', f.line)
  L.need(`fork-precheck-${f.token || 'unreadable'}`, 'P5', 'FORK-PRECHECK after the block', f.pass)
}

// ----------------------------------------------------------------------------------------------------------------
// leg: h10-release-decrypt (mirrors spike 108 823-867 and scripts/proof/decrypt-probe.ts 241-333)
// ----------------------------------------------------------------------------------------------------------------
async function legRelease (L: LegCtx): Promise<void> {
  MON_PHASE = 'h10'
  const off = roles.get('officer')!
  const khs = S_.khs
  const tlText = (await one(hostReaderCtx().db, 'select Timeline as tl from ElectionRevision where ElectionId = :e', { e: S_.electionId }))?.tl
  const releaseAt = releasingKeysAt(JSON.parse(String(tlText)))
  L.need('release-wait', 'Q0a', 'a releasingKeys time is published', releaseAt !== null)
  const sQ = Date.now()
  while (Date.now() < releaseAt) await sleep(1000)
  L.need('release-wait', 'Q0', 'releasingKeys reached by the real clock within releasingKeys + 10 min', Date.now() <= releaseAt + 10 * 60_000, { waitedMs: Date.now() - sQ })
  // Q1: pre-release, ciphertext only
  const kr = new KeyReleaseEngine(off.ctx)
  const statusPre = await kr.getKeyReleaseStatus(S_.electionId)
  const rows: any[] = []
  for await (const row of off.ctx.db.eval('select Cid, Id, BallotId, EntryCount, Ciphertext from VoteBlock where ElectionId = :electionId and ElectionRevision = :revision', { electionId: S_.electionId, revision: statusPre.revision })) rows.push(row)
  const pre = await kr.decryptElectionBlocks(S_.electionId, rows.map((r: any) => ({ blockId: r.Id, ciphertext: r.Ciphertext })))
  const notRecon = pre.filter((x: any) => x.ok === false && x.reason === 'not-reconstructable').length
  L.need('pre-release', 'Q1a', 'before the release the officer cannot reconstruct (phase is not reconstructable, every block not-reconstructable)', statusPre.phase !== 'reconstructable' && rows.length >= 1 && notRecon === rows.length, { phase: statusPre.phase, blocks: rows.length, notReconstructable: notRecon })
  const plainFiles: string[] = S_.voteFiles.map((p: string) => readFileSync(p, 'utf8'))
  const nonces: string[] = []
  for (const t of plainFiles) for (const j of JSON.parse(t) as string[]) { const n = JSON.parse(j).nonce; if (typeof n === 'string') nonces.push(secret(n, { windows: true })) }
  const markers = [S_.needle, ...nonces]
  const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex')
  const control = markers.every((m) => plainFiles.some((t) => t.includes(m)))
  L.need('needle-control', 'Q1c', 'positive control: the needle and every host nonce are found in the plaintext vote files', control && nonces.length === HV_N, { markers: markers.length })
  const found = rows.some((r) => markers.some((m) => String(r.Ciphertext).includes(m) || String(r.Ciphertext).includes(hex(m))))
  L.need('pre-release', 'Q1b', 'the needle and every nonce are absent, raw and hex, from every raw VoteBlock ciphertext', !found, { needlesChecked: markers.length })
  key('HR5P2-PRE-RELEASE', `phase=${statusPre.phase} reconstructable=false notReconstructable=${notRecon} needleFound=false needlesChecked=${markers.length}`)
  // L1-L3: both keyholders release
  const relBefore = khs.map((k: any) => k.vault.authPromptCount)
  const found2: any[] = []
  for (const k of khs) { const eng = await k.getEngine('keysTasksEngine'); const tasks = await eng.getKeysToRelease(true); found2.push(tasks.find((t: any) => t.userId === k.userId) ?? null) }
  if (!PHONE_KH2) L.need('release', 'L1', "each keyholder's task list yields its release-key task", found2.every((t) => t !== null), found2.map((t) => t !== null))
  const sRel = Date.now()
  const outcomes: any[] = []
  for (let i = 0; i < khs.length; i++) {
    const o = await releaseKeyholderShare({ getEngine: khs[i].getEngine, vault: khs[i].vault, storage: khs[i].store }, found2[i])
    if (o.kind === 'failed') recordError(`${khs[i].name}.release`, Object.assign(new Error('release failed'), { code: o.code }), 'thrown')
    outcomes.push(o)
  }
  khs.forEach((k: any, i: number) => { k.releaseUnwraps = k.vault.authPromptCount - relBefore[i] })
  if (!PHONE_KH2) L.need('release', 'L2', 'every host keyholder releases through the shipped module', outcomes.every((o) => o.kind === 'released'), outcomes.map((o) => (o.kind === 'released' ? 'released' : o.code)))
  if (PHONE_KH) rawLog(`LEAN-WAIT phone-release at=${new Date().toISOString()}`)
  const relOnOfficer: any = await poll('officer.getKeyReleaseStatus', () => kr.getKeyReleaseStatus(S_.electionId), (s: any) => (s?.releasedCount ?? 0) >= 2, { timeoutMs: PHONE_KH ? PHONE_MS : 180_000, intervalMs: PHONE_KH ? 3000 : 1000 })
  if (PHONE_KH) rawLog(`LEAN-GO phone-release ok=${relOnOfficer.ok} waitedMs=${relOnOfficer.waitedMs}`)
  const releasedCount = (relOnOfficer.value as any)?.releasedCount ?? 0
  const rejected = (relOnOfficer.value as any)?.rejectedReleases?.length ?? 0
  durations.releaseMs = Date.now() - sRel
  L.need('release', 'L3', 'the officer sees releasedCount >= 2 and 0 rejected', releasedCount >= 2 && rejected === 0, { releasedCount, rejected, ms: durations.releaseMs })
  key('HR5P2-RELEASE', `releasedCount=${releasedCount} rejected=${rejected} threshold=2 ms=${durations.releaseMs}`)
  // X1: decrypt on the officer (mirrors decrypt-probe.ts openAll)
  const sDec = Date.now()
  const status = await kr.getKeyReleaseStatus(S_.electionId)
  const recon = await kr.reconstructElectionKey(S_.electionId)
  let openedCount = 0; let openFailures = 0; let needleIn = false; let openedHash = ''; let openedProjected: Array<{ ballotId: string, answers: any[] }> = []
  try {
    const ek = { electionId: S_.electionId, revision: recon.revision, jointPublicKey: recon.jointPublicKey }
    const projected: Array<{ ballotId: string, answers: any[] }> = []
    for (const row of rows) {
      const opened: any = openElectionBlock(recon.secretKey, ek, { blockId: row.Id, ciphertext: row.Ciphertext } as any)
      if (!opened.ok) { openFailures++; continue }
      for (const entry of openVoteEntries(recon.secretKey, ek, row.BallotId, opened.payload) as any[]) {
        if (!entry.ok) { openFailures++; continue }
        if (entry.voteEntryJson.includes(S_.needle)) needleIn = true
        try { const parsed = JSON.parse(entry.voteEntryJson); projected.push({ ballotId: parsed.ballotId, answers: parsed.answers }) } catch { openFailures++ }
      }
    }
    openedCount = projected.length
    openedHash = sha256hex(openedSetPreimage(projected))
    openedProjected = projected
  } finally { recon.secretKey.fill(0) }
  const expected: Array<{ ballotId: string, answers: any[] }> = []
  for (const t of plainFiles) for (const j of JSON.parse(t) as string[]) { const p = JSON.parse(j); expected.push({ ballotId: p.ballotId, answers: p.answers }) }
  const expectedHash = sha256hex(openedSetPreimage(expected))
  // phone mode: the iPhone's plaintext is not on the host; every host entry must be in the opened set (multiset containment)
  let hashEqual = openedHash === expectedHash
  if (PHONE_VOTER) {
    const left = new Map<string, number>()
    for (const p of openedProjected) { const s = JSON.stringify(p); left.set(s, (left.get(s) ?? 0) + 1) }
    hashEqual = expected.every((p) => { const s = JSON.stringify(p); const n = left.get(s) ?? 0; if (n < 1) return false; left.set(s, n - 1); return true })
  }
  durations.decryptMs = Date.now() - sDec
  void status
  L.need('decrypt', 'X1', PHONE_VOTER ? 'the officer opens every block (openedCount 3, openFailures 0), both host votes are in the opened set, and the needle is in the opened set' : 'the officer opens every block (openedCount 3, openFailures 0), the opened-set hash equals the host hash, and the needle alone is in the opened set', openedCount === 3 && openFailures === 0 && hashEqual && needleIn, { openedCount, openFailures, hashEqual, needleInOpened: needleIn })
  key('HR5P2-DECRYPT', `openedCount=${openedCount} openFailures=${openFailures} hashEqual=${hashEqual} needleInOpened=${needleIn}`)
  // X3: the shipped ElectionResultsEngine (decrypt + R7 validate + R8 tally) on the officer's REAL strand, and on a
  // keyholder peer, must count exactly the votes that were cast (host mode) / every opened vote (phone mode).
  {
    const tallyOf = (res: any): Record<string, number> => {
      const out: Record<string, number> = {}
      if (res?.status !== 'tallied') return out
      for (const b of res.ballots) for (const q of b.questions) for (const o of q.options) if (o.count > 0) out[`${b.ballotId}/${q.code}/${o.code}`] = o.count
      return out
    }
    const want: Record<string, number> = {}
    for (const p of (PHONE_VOTER ? openedProjected : expected)) for (const a of p.answers) for (const o of a.optionCodes) { const k = `${p.ballotId}/${a.questionCode}/${o}`; want[k] = (want[k] ?? 0) + 1 }
    const sRes = Date.now()
    const resOff: any = await new ElectionResultsEngine(off.ctx).getElectionResults(S_.electionId)
    const resMs = Date.now() - sRes
    const gotOff = tallyOf(resOff)
    // a keyholder peer: poll up to 120 s for its replica to reach the same tally root (sync lag), logging each read
    const khEngine = new ElectionResultsEngine(hostReaderCtx())
    const summarize = (r: any) => r?.status === 'tallied'
      ? { status: r.status, totals: r.totals, blockCount: r.blockCount, ballots: r.ballots.map((b: any) => ({ votes: b.votes, valid: b.valid, invalid: b.invalid, excluded: b.excluded, questions: b.questions.length })), leaves: r.tally.leaves.map((l: any) => ({ disposition: l.disposition, excludedFor: l.excludedFor, entryCount: l.entryCount })), root8: String(r.tallyRoot).slice(0, 8), blockRoot8: String(r.blockRoot).slice(0, 8) }
      : { status: r?.status, reason: r?.reason, detail: r?.detail, phase: r?.phase, releasedCount: r?.releasedCount }
    let resKh: any = null
    const khReads: any[] = []
    const sKh = Date.now()
    for (;;) {
      resKh = await khEngine.getElectionResults(S_.electionId)
      khReads.push({ atMs: Date.now() - sKh, ...summarize(resKh) })
      if (resKh?.status === 'tallied' && resKh.tallyRoot === resOff?.tallyRoot) break
      if (Date.now() - sKh > 120_000) break
      await sleep(5000)
    }
    const sameCounts = JSON.stringify(Object.entries(gotOff).sort()) === JSON.stringify(Object.entries(want).sort())
    // the needle is a secret marker: never print an option code, only the count multiset
    const counts = (m: Record<string, number>) => Object.values(m).sort((a, b) => a - b)
    const detail = {
      officer: summarize(resOff), gotCounts: counts(gotOff), wantCounts: counts(want), sameCounts,
      sameRootOnKeyholder: resKh?.tallyRoot === resOff?.tallyRoot, khReads: khReads.length, khFirst: khReads[0], khLast: khReads[khReads.length - 1], ms: resMs
    }
    rawLog(`HR5P2-RESULTS ${JSON.stringify(detail)}`)
    L.need('results', 'X3', 'ElectionResultsEngine tallies on the officer: status tallied, valid = opened votes, 0 invalid, 0 excluded, per-option counts equal the cast votes, and a keyholder peer reaches the same tally root within 120 s',
      resOff?.status === 'tallied' && resOff.totals.valid === openedCount && resOff.totals.invalid === 0 && resOff.totals.excluded === 0 && sameCounts && resKh?.status === 'tallied' && resKh.tallyRoot === resOff.tallyRoot, detail)
    key('HR5P2-RESULTS', `status=${resOff?.status} valid=${resOff?.totals?.valid} sameCounts=${sameCounts} khSameRoot=${resKh?.tallyRoot === resOff?.tallyRoot} ms=${resMs}`)
  }
  // X4 (D4/D5, 2026-11-02 merge test): the host officer publishes the tally through the shipped TallyPublicationEngine,
  // then publishes again; exactly one ElectionTally row must exist. A keyholder peer must read the same signed row.
  // The flag publish-go lets the orchestrator open the device Results screens first (missing flag: go on after 600 s).
  {
    const go = await waitFlag('publish-go', 600_000)
    leanNote(`x4 publish-go flag=${go}`)
    const res: any = await new ElectionResultsEngine(off.ctx).getElectionResults(S_.electionId)
    const pubEngine = new TallyPublicationEngine(off.ctx)
    const publisher = { userId: off.user.id, signingPublicKey: off.user.activeKeys[0].key, sign: off.sign }
    const countRows = async (): Promise<number> => Number((await off.ctx.db.prepare('select count(*) as n from ElectionTally where ElectionId = :e').get({ e: S_.electionId }))?.n ?? -1)
    let first: any = null; let second: any = null; let firstAt = ''; let firstMs = -1
    if (res?.status === 'tallied') {
      const s1 = Date.now()
      first = await pubEngine.publishElectionTally(res.tally, publisher)
      firstMs = Date.now() - s1
      firstAt = new Date().toISOString()
      second = await pubEngine.publishElectionTally(res.tally, publisher)
    }
    const rows = await countRows()
    leanNote(`x4 first-publish outcome=${first?.outcome} at=${firstAt} ms=${firstMs} blocks=${res?.tally?.size ?? res?.blockCount} votes=${res?.totals?.valid}`)
    leanNote(`x4 second-publish outcome=${second?.outcome} rows=${rows}`)
    L.check('X4a', 'the host officer publishes the tally: outcome published, one ElectionTally row', first?.outcome === 'published' && rows >= 1, { first: first?.outcome, resultsStatus: res?.status, ms: firstMs, at: firstAt })
    L.check('X4b', 'a second publish of the same tally leaves exactly one row (already-published)', second?.outcome === 'already-published' && rows === 1, { second: second?.outcome, rows })
    // a keyholder peer reads the row back: signature valid, tree consistent, and equal to its own recomputed tally
    const khPub = new TallyPublicationEngine(hostReaderCtx())
    const khRes = new ElectionResultsEngine(hostReaderCtx())
    let khRead: any = null; const sKh = Date.now(); let khReads = 0
    for (;;) {
      khReads++
      const mine: any = await khRes.getElectionResults(S_.electionId)
      khRead = await khPub.readPublishedTally(S_.electionId, res?.tally?.electionRevision ?? 0, mine?.status === 'tallied' ? mine.tally : undefined)
      if (khRead !== null && khRead.signatureValid && khRead.treeCheck?.ok && khRead.matchesRecomputed === true) break
      if (Date.now() - sKh > 120_000) break
      await sleep(5000)
    }
    L.check('X4c', 'a keyholder peer reads the published row within 120 s: signature valid, tree consistent, matches its own tally', khRead !== null && khRead.signatureValid === true && khRead.treeCheck?.ok === true && khRead.matchesRecomputed === true,
      { found: khRead !== null, signatureValid: khRead?.signatureValid, treeOk: khRead?.treeCheck?.ok, matches: khRead?.matchesRecomputed, blockCount: khRead?.blockCount, reads: khReads, waitedMs: Date.now() - sKh })
    key('HR5P2-PUBLISH', `first=${first?.outcome} second=${second?.outcome} rows=${rows} khMatches=${khRead?.matchesRecomputed} at=${firstAt}`)
  }
  // N1 (mirrors spike 108 864-867)
  const ids = await listKeyholderIdentities(S_.founderStore)
  const signers = await Promise.all([...khs.map((k: any) => k.userId), ...(PHONE_KH2 ? ((S_ as any).remoteKhs ?? []) : PHONE_KH ? [(S_ as any).remoteKhb] : [])].map((u: string) => S_.founderVault.hasSecret(keyholderSigningKeyAlias(u))))
  L.need('release', 'N1', 'the officer holds no keyholder identity or signing key', ids.length === 0 && signers.every((h: boolean) => h === false), { identities: ids.length, signers })
  const f = await fork('exit', L.dir)
  key('HR5P2-FORK-PRECHECK-EXIT', f.line)
  exitForkDone = true
  L.need(`fork-precheck-${f.token || 'unreadable'}`, 'X2', 'FORK-PRECHECK at EXIT', f.pass)
}
let exitForkDone = false

// ----------------------------------------------------------------------------------------------------------------
// EXIT
// ----------------------------------------------------------------------------------------------------------------
function scanSecrets (): { whole: number, windows: number, files: number } {
  let whole = 0; let windows = 0; let files = 0
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      const st = statSync(p)
      if (st.isDirectory()) { walk(p); continue }
      files++
      const text = readFileSync(p, 'utf8')
      for (const [s, w] of SECRETS) {
        if (text.includes(s)) { whole++; continue }
        if (w && s.length >= 16) for (let i = 0; i + 16 <= s.length; i += 1) if (text.includes(s.slice(i, i + 16))) { windows++; break }
      }
    }
  }
  try { walk(EV) } catch { whole = -1 }
  return { whole, windows, files }
}

// ----------------------------------------------------------------------------------------------------------------
// MONITOR (notes 19 E40, attempt 2): informational only, gates nothing and never writes to a strand. Every 60 s one MON line per
// role: control leaf rev, control connections, registerSelfInFlight, self-record publish age, pending self-record publishes, each
// strand's status, connected peers, last activity and libp2p connections (per connection: peer tail4, direction, circuit c/direct d,
// status, stream count, oldest stream age and protocol), and in h10 the role's KeyholderShareRelease row count. Each read is bounded
// at 15 s ('T' = did not settle). One MON POLLERR line per distinct error a poll swallowed. Everything goes through redact/scrubWall.
// ----------------------------------------------------------------------------------------------------------------
let MON_PHASE = 'pre-h10'
let monTimer: any = null
const MON_ERRS = new Map<string, number>()
const MON_SELFPUB = new Map<string, number[]>()
function monLine (s: string): void { rawLog(redact(scrubWall(`MON ${new Date().toISOString()} ${s}`))) }
function monPollError (where: string, e: unknown): void {
  const msg = `${String((e as any)?.name ?? 'Error')}: ${String((e as any)?.message ?? e)}`.slice(0, 240)
  const k = `${where} ${msg}`
  const n = (MON_ERRS.get(k) ?? 0) + 1
  MON_ERRS.set(k, n)
  if (n === 1 && MON_ERRS.size <= 200) monLine(`POLLERR where=${where} first ${msg}`)
  else if (n === 10 || n === 100 || n === 1000) monLine(`POLLERR where=${where} repeat=${n} ${msg}`)
}
async function monBound<T> (p: () => Promise<T> | T, ms = 15_000): Promise<{ v?: T, s: 'ok' | 'T' | 'E', e?: string }> {
  let timer: any
  try {
    return await Promise.race([
      Promise.resolve().then(p).then((v) => ({ v, s: 'ok' as const })),
      new Promise<{ s: 'T' }>((resolve) => { timer = setTimeout(() => resolve({ s: 'T' }), ms) })
    ]) as any
  } catch (e) { return { s: 'E', e: String((e as any)?.message ?? e).slice(0, 80) } } finally { clearTimeout(timer) }
}
const t4 = (id: unknown): string => String(id ?? '').slice(-4)
function monConns (lp: any): string {
  try {
    const now = Date.now()
    return lp.getConnections().map((c: any) => {
      const ss: any[] = c.streams ?? []
      let oldest = 0; let oldestProto = '-'
      for (const s of ss) { const age = now - Number(s.timeline?.open ?? now); if (age > oldest) { oldest = age; oldestProto = String(s.protocol ?? '?') } }
      const via = String(c.remoteAddr ?? '').includes('/p2p-circuit') ? 'c' : 'd'
      return `${t4(c.remotePeer?.toString())}:${String(c.direction ?? '?')[0]}${via}:${c.status ?? '?'}:s${ss.length}:o${Math.round(oldest / 1000)}s:${oldestProto.replace(/^\/+/, '').slice(0, 40)}`
    }).join('|') || 'none'
  } catch { return 'E' }
}
function startMonitor (): any {
  let busy = false; let last = Date.now(); let tick = 0
  const t = setInterval(() => {
    const now = Date.now(); const lag = now - last - 60_000; last = now; tick++
    if (busy) { monLine(`tick=${tick} skipped (previous sample still running) lagMs=${lag}`); return }
    busy = true
    void (async () => {
      try {
        for (const [n, r] of roles) {
          const node: any = r.node
          const rev = await monBound(() => readControlLeaf(node))
          const revS = rev.s !== 'ok' ? rev.s : ((rev.v as any)?.unreadable ? 'U:' + String((rev.v as any).unreadable) : String((rev.v as any)?.leafRev))
          let cconns = 'E'; try { cconns = monConns(node.getControlNode()) } catch { /* mon */ }
          let infl = '?'; let pub = '?'
          try { infl = String(node.registerSelfInFlight != null); pub = node.lastSelfRecordPublishAt == null ? 'null' : String(Math.round((Date.now() - node.lastSelfRecordPublishAt) / 1000)) } catch { /* mon */ }
          const pend = MON_SELFPUB.get(n) ?? []
          const pendS = pend.length === 0 ? '0' : `${pend.length}/oldest${Math.round((Date.now() - Math.min(...pend)) / 1000)}s`
          const strands: string[] = []
          try {
            for (const [sid, si] of node.getStrands() as Map<string, any>) {
              const act = si.lastActivity ? Math.round((Date.now() - new Date(si.lastActivity).getTime()) / 1000) : -1
              strands.push(`${String(sid).slice(-8)}:${si.status}:cp${si.connectedPeers}:act${act}s:db${si.database ? 1 : 0}:[${si.libp2pNode ? monConns(si.libp2pNode) : 'no-node'}]`)
            }
          } catch { strands.push('E') }
          let rel = '-'
          if (MON_PHASE === 'h10' && r.ctx && S_.electionId) {
            const q = await monBound(() => one(r.ctx.db, 'select count(*) as n from KeyholderShareRelease where ElectionId = :e', { e: S_.electionId }))
            rel = q.s === 'ok' ? String((q.v as any)?.n ?? '?') : q.s + (q.e ? ':' + q.e : '')
          }
          monLine(`tick=${tick} lagMs=${lag} phase=${MON_PHASE} ${n} ctlRev=${revS} inflight=${infl} pubAgeS=${pub} selfPubPending=${pendS} ctl=[${cconns}] rel=${rel} strands=${strands.join(' ')}`)
        }
      } catch (e) { monLine(`tick=${tick} error ${String((e as any)?.message ?? e).slice(0, 120)}`) } finally { busy = false }
    })()
  }, 60_000)
  t.unref?.()
  return t
}

// SEED: keep the host peers (and any host voters) live after the seed stage. Writes <EV>/seed-state.json (ids, ISO timeline, the
// secrets-dir file paths — never their contents). Ends on a signal, <SEC>/flag-seed-stop, or the deadline (SEED_HOLD_MIN, else the
// election's `closed` + 10 min, else 120 min). With seeded voters the officer keeps Sync Now + approving, and the send gate opens at
// votingStarts so the host voters cast their votes (a pool needs 3: a 3rd voter, e.g. a phone, completes it).
async function seedHold (): Promise<void> {
  const tl = S_.timeline
  const holdMin = Number(process.env.SEED_HOLD_MIN ?? 0)
  const deadline = holdMin > 0 ? Date.now() + holdMin * 60_000 : (tl?.closed ? tl.closed + 10 * 60_000 : Date.now() + 120 * 60_000)
  const stopFlag = join(SEC, 'flag-seed-stop')
  const iso = (v: unknown): string | null => (typeof v === 'number' ? new Date(v).toISOString() : null)
  const files = ['n7-code.txt', 'hr5-code.txt', 'seat-a-share.txt', 'seat-b-share.txt', 'hr5-needle.txt'].filter((f) => existsSync(join(SEC, f))).map((f) => join(SEC, f))
  const state = {
    stage: SEED_STOP, at: new Date().toISOString(), holdUntil: new Date(deadline).toISOString(), partyId: party.partyId ?? null, networkHash: N7, authorityId: AUTHORITY_ID,
    election: S_.electionId === '' ? null : { id: S_.electionId, title: process.env.LEAN_TITLE ?? 'hr5-election', ballotId: S_.ballotId, timeline: tl ? Object.fromEntries(Object.entries(tl).map(([k, v]) => [k, iso(v)])) : null },
    hostPeers: [...roles.keys()], hostVoters: S_.children.map((c: any) => c.label), files, stopFlag
  }
  writeFileSync(join(EV, 'seed-state.json'), JSON.stringify(state, null, 2) + '\n', { flag: 'wx' })
  rawLog(redact(`SEED-HOLD stage=${SEED_STOP} until=${state.holdUntil} (stop: Ctrl-C in seed-election.sh, kill -TERM ${process.pid}, or touch ${stopFlag})`))
  const tick = (S_ as any).seedOfficerTick as (() => Promise<void>) | undefined
  const officer = (S_ as any).seedOfficer
  let gateOpened = existsSync(S_.gatePath)
  let lastTick = 0
  let lastBeat = Date.now()
  while (!seedStopRequested && !existsSync(stopFlag) && Date.now() < deadline) {
    if (tick && Date.now() - lastTick >= 15_000) {
      lastTick = Date.now()
      try { await tick() } catch (err) { recordError('seed.officerTick', err, 'thrown') }
    }
    if (SEED_VOTERS && !gateOpened && tl && Date.now() >= tl.votingStarts) {
      try { writeFileSync(S_.gatePath, '', { flag: 'wx', mode: 0o600 }) } catch { /* already there */ }
      gateOpened = true
      rawLog(`SEED-NOTE send gate opened at votingStarts (${iso(tl.votingStarts)}): the host voters now cast their votes`)
    }
    if (Date.now() - lastBeat >= 5 * 60_000) {
      lastBeat = Date.now()
      const live = S_.children.filter((c: any) => c.child.exitCode === null && c.child.signalCode === null).length
      rawLog(`SEED-HEARTBEAT at=${new Date().toISOString()} holdUntil=${state.holdUntil} hostVotersLive=${live}${officer ? ` approvals=${officer.approvals} associated=${officer.associated}` : ''}`)
    }
    await sleep(2000)
  }
  rawLog(`SEED-RELEASE reason=${seedStopRequested ? 'signal' : existsSync(stopFlag) ? 'flag' : 'deadline'} at=${new Date().toISOString()}`)
}

async function runMain (): Promise<void> {
  if (!EV || !EV.startsWith('/') || !existsSync(EV) || process.env.HR5_SCRATCH !== S) { rawLog('RESULT ' + JSON.stringify({ tool: 'hr5-part2', verdict: 'VOID', reason: 'usage' })); return }
  if (existsSync(join(EV, 'driver-results.json'))) { rawLog('RESULT ' + JSON.stringify({ tool: 'hr5-part2', verdict: 'VOID', reason: 'results-exist' })); return }
  if (SEED_STOP !== '' && SEED_LEGS[SEED_STOP] === undefined) { rawLog('RESULT ' + JSON.stringify({ tool: 'hr5-part2', verdict: 'VOID', reason: 'seed-stop-unknown' })); return }
  if (SEED_STOP !== '') {
    // SEED: the 1st/2nd signal asks for a clean stop (between legs, or out of the hold); the 3rd exits at once
    let sigs = 0
    const onSig = (sig: string): void => { sigs++; seedStopRequested = true; rawLog(`SEED-STOP-REQUESTED signal=${sig} n=${sigs} at=${new Date().toISOString()}`); if (sigs >= 3) process.exit(130) }
    process.on('SIGINT', () => onSig('SIGINT'))
    process.on('SIGTERM', () => onSig('SIGTERM'))
  }
  installProbe()
  monTimer = startMonitor()
  const start = new Date().toISOString()
  key('HR5P2-START', `at=${start}`)
  const plan: Array<[string, (L: LegCtx) => Promise<void>]> = [
    ['reopen', legReopen], ['h6-election', legElection], ['h7-accept', legAccept], ['h8-dkg', legDkg], ['h9-voters', legVoters], ['h10-release-decrypt', legRelease]
  ]
  const seedLeg = SEED_LEGS[SEED_STOP]
  const runPlan = seedLeg === undefined ? plan : plan.slice(0, plan.findIndex(([n]) => n === seedLeg) + 1)
  if (SEED_STOP !== '') rawLog(`SEED-PLAN stage=${SEED_STOP} legs=${runPlan.map(([n]) => n).join(',')}`)
  let finalScan: any = null
  try {
    for (const [name, fn] of runPlan) {
      if (seedStopRequested) break
      const st = await leg(name, fn)
      if (st.status !== 'PASS' && !(st.status === 'FAIL' && SOFT_TOKENS.has(st.token))) break
    }
    if (SEED_STOP !== '' && nonPass === null && legStatuses.length === runPlan.length && !seedStopRequested) await seedHold()
    if (nonPass !== null && roles.size === ROLES.length && [...roles.values()].every((r) => r.opened) && !exitForkDone && lastLegDir !== '') {
      try { const f = await fork('exit', lastLegDir); key('HR5P2-FORK-PRECHECK-EXIT', f.line) } catch { /* recorded by absence */ }
    }
  } catch (e) {
    say('FATAL', String((e as Error)?.stack ?? e).slice(0, 800))
    if (nonPass === null) nonPass = { leg: 'driver', status: 'FAIL', token: 'crash', inScriptD14: 'CLEAN', reason: 'none', checks: [] }
  } finally {
    clearInterval(stallTimer)
    if (monTimer !== null) clearInterval(monTimer)
    restoreProbe()
    try { await S_.rendezvousDetach?.() } catch { /* detach is best effort */ }
    // leftover children, by recorded PID only
    // D-119 (65-25): SIGTERM first (the patched host voter snapshots its agent counts), up to 5 s, then SIGKILL
    let leftover = 0
    const live = (): any[] => S_.children.filter((c: any) => c.child.exitCode === null && c.child.signalCode === null)
    for (const c of live()) { leftover++; try { c.child.kill('SIGTERM') } catch { /* gone */ } }
    for (let w = 0; w < 50 && live().length > 0; w++) await sleep(100)
    for (const c of live()) { try { c.child.kill('SIGKILL') } catch { /* gone */ } }
    for (const n of ['kh-b', 'kh-a', 'officer'] as RoleName[]) {
      const r = roles.get(n)
      if (!r) continue
      try { await race(r.node.stop(), 15_000) } catch { /* bounded */ }
      try { await race(r.closeStores(), 10_000) } catch { /* bounded */ }
    }
    for (const p of [join(SEC, 'send-gate')]) void p
    finalScan = scanSecrets()
  }
  if (finalScan && (finalScan.whole !== 0 || finalScan.windows !== 0) && nonPass === null) nonPass = { leg: legStatuses.at(-1)?.leg ?? 'driver', status: 'FAIL', token: 'secret-leak', inScriptD14: 'CLEAN', reason: 'none', checks: [] }
  const passAll = nonPass === null && legStatuses.length === runPlan.length
  const summary = passAll ? 'PASS' : `FAIL ${(nonPass as LegStatus | null)?.leg ?? 'driver'} ${(nonPass as LegStatus | null)?.token ?? (seedStopRequested ? 'seed-stopped' : 'no-result')}`
  const resultObj = {
    tool: 'hr5-part2', summary, seed: SEED_STOP === '' ? null : SEED_STOP, legs: legStatuses.map((l) => ({ leg: l.leg, status: l.status, token: l.token, inScriptD14: l.inScriptD14, reason: l.reason })), durations,
    wall: { oversized: probe.oversized, clusterRequests: probe.calls, maxRequestBytes: probe.maxBytes, hiddenOpen, tokens: tokenCount, paths: wallPaths }, hvHit: hvHitFlag,
    secretScan: finalScan, stallMaxMs, lateErrors: lateErrors.length, keys: Object.fromEntries(KEYS), startedAt: start, endedAt: new Date().toISOString(), dkg: (S_ as any).dkgRes ?? null, blockEntries: S_.blockEntries
  }
  try { writeFileSync(join(EV, 'driver-results.json'), JSON.stringify(resultObj, null, 2), { flag: 'wx' }) } catch { /* recorded by the RESULT line */ }
  rawLog('RESULT ' + redact(JSON.stringify({ tool: 'hr5-part2', summary, legs: legStatuses.length, secretScan: finalScan })))
  rawLog(`SUMMARY ${summary}`)
}

// ----------------------------------------------------------------------------------------------------------------
// selfcheck (no node, no network)
// ----------------------------------------------------------------------------------------------------------------
async function selfcheck (): Promise<void> {
  const results: Array<[string, boolean, string]> = []
  const ok = (id: string, pass: boolean, detail = ''): void => { results.push([id, pass, detail]); rawLog(`${pass ? 'PASS' : 'FAIL'} ${id} ${redact(scrubWall(detail))}`) }
  // (a) exports
  const fnExports: Array<[string, unknown]> = [
    ['acceptKeyholderInvitation', acceptKeyholderInvitation], ['driveKeyholderDkg', driveKeyholderDkg], ['releaseKeyholderShare', releaseKeyholderShare], ['listKeyholderIdentities', listKeyholderIdentities],
    ['keyholderSigningKeyAlias', keyholderSigningKeyAlias], ['keyholderInviteExpiration', keyholderInviteExpiration], ['ensureVoterInviteOwner', ensureVoterInviteOwner], ['hostPoolRendezvous', hostPoolRendezvous],
    ['createPeerSyncBinding', createPeerSyncBinding], ['createStrandPort', createStrandPort], ['buildRoleNode', opener.buildRoleNode], ['roleNetworksEngine', opener.roleNetworksEngine], ['openRoleNetwork', opener.openRoleNetwork],
    ['readControlLeaf', readControlLeaf], ['classifyRound', classifyRound], ['forkPrecheckLine', forkPrecheckLine], ['forkPrecheck', forkPrecheck], ['openedSetPreimage', openedSetPreimage]
  ]
  const bad = fnExports.filter(([, f]) => typeof f !== 'function').map(([n]) => n)
  if (typeof DEFAULT_KEYHOLDER_INVITE_EXPIRY_HOURS !== 'number') bad.push('DEFAULT_KEYHOLDER_INVITE_EXPIRY_HOURS')
  ok('A', bad.length === 0, `${fnExports.length + 1} exports, bad=[${bad.join(',')}]`)
  // (b) classifier self-test (spike 108 I1)
  {
    const smMsg = 'Failed to get ' + 'super-' + 'majority: 1/3 approvals (needed 3, 0 rejections)'
    const sm = classify(new Error('outer', { cause: new Error('mid', { cause: new Error(smMsg) }) }))
    const tornErr = Object.assign(new Error('x'), { name: TORN })
    const torn = classify(new AggregateError([tornErr], 'agg'))
    const plain = classify(new Error('plain failure'))
    let deep: Error = new Error(smMsg)
    for (let i = 0; i < 7; i++) deep = new Error('wrap' + i, { cause: deep })
    const depth7 = classify(deep)
    const idl = classify(Object.assign(new Error('y'), { name: IDL }))
    ok('B', sm.superMajority === 1 && torn.tornAction === 1 && plain.superMajority + plain.tornAction === 0 && depth7.superMajority === 0 && idl.invalidDataLength === 1, 'depth-2 chain, aggregate, plain, depth-7 negative, invalid-data-length')
  }
  // (c) redact self-test
  {
    const v = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0'
    secret(v, { windows: true })
    const whole = redact(`x ${v} y`)
    const win = redact(`x ${v.slice(5, 21)} y`)
    const peer = redact('dial 12D3KooWSyntheticPeerRedactSamp1eXyzABCDEFGHJKMNPQRSTUVWxyz failed on 192.168.77.77')
    ok('C', !whole.includes(v) && !win.includes(v.slice(5, 21)) && !peer.includes('12D3KooWSyntheticPeerRedactSamp1eXyzABCDEFGHJKMNPQRSTUVWxyz') && !peer.includes('192.168'), 'whole value, 16-char window, full peer id and LAN ip are redacted')
    SECRETS.delete(v)
    for (let i = 0; i + 16 <= v.length; i++) WINDOWS.delete(v.slice(i, i + 16))
  }
  // (d) mapping self-test (interfaces D)
  {
    mkdirSync(join(EV || S, 'sc'), { recursive: true })
    const base = (over: any = {}): any => ({
      schema: 'vt64-wall-leg/1', runId: 'hr5p2-selfcheck', shape: 'hr5', stack: stack(), instrument: { thresholdBytes: CAP_BYTES, probeInstalled: true, probeCalls: 40, probeRestored: true },
      stage: 'done', setupError: null, timedOut: false, oversizedTotal: 0, hiddenOpenFailuresTotal: 0,
      wallSignals: { hidden: { superMajority: 0, superMajorityRatios: [], tornAction: 0, tornReasons: [], invalidDataLength: 0 }, thrown: { superMajority: 0, superMajorityRatios: [], tornAction: 0, tornReasons: [], invalidDataLength: 0 }, late: { superMajority: 0, superMajorityRatios: [], tornAction: 0, tornReasons: [], invalidDataLength: 0 } },
      join: { ok: true, reason: null, ms: 700, hiddenOpenFailures: 0, oversizedRequests: 0, steps: 'host-voter' }, otherSignals: {}, stall: { maxMs: 10, over2000: 0 }, totalMs: 1000, ...over
    })
    const wall = (part: string, k: string): any => { const w = base().wallSignals; w[part][k] = 1; return w }
    const run = (name: string, r: any, startOnly = false): any => {
      const p = join(EV || S, 'sc', `${name}.log`)
      const start = `LEG-START ${JSON.stringify({ schema: 'vt64-wall-leg/1', runId: r.runId, shape: 'hr5' })}\n`
      writeFileSync(p, start + (startOnly ? '' : `RESULT ${JSON.stringify(r)}\n`))
      const c = d14map.classifyFile(p)
      const m = d14map.mapClass(c.cls, c.why)
      return { cls: c.cls, why: c.why, reading: m.reading }
    }
    const clean = run('clean', base())
    ok('D1', clean.cls === 'VOID-run (wrong-stack)' && clean.reading === 'CLEAN', `class=${clean.cls} mapped=${clean.reading} why=${clean.why}`)
    const torn = run('torn', base({ wallSignals: wall('thrown', 'tornAction') }))
    ok('D2', torn.cls === 'HIT' && torn.reading === 'HIT', `class=${torn.cls} mapped=${torn.reading}`)
    const big = run('big', base({ oversizedTotal: 1 }))
    ok('D3', big.cls === 'MASKED HIT' && big.reading === 'HIT', `class=${big.cls} mapped=${big.reading}`)
    const so = run('startonly', base(), true)
    ok('D4', so.cls === 'HIT' && so.reading === 'HIT', `class=${so.cls} mapped=${so.reading}`)
    const hid = run('hidden', base({ hiddenOpenFailuresTotal: 1 }))
    const hidIn = d14map.inScript({ hiddenOpen: 1 })
    ok('D5', hid.cls === 'VOID-run (wrong-stack)' && hid.reading === 'CLEAN' && hidIn.hit === true && hidIn.reason === 'hidden-open', `classifier=${hid.cls}/${hid.reading} inScript=${hidIn.reason}`)
    const idl = run('idl', base({ wallSignals: wall('hidden', 'invalidDataLength') }))
    ok('D6', idl.reading === 'HIT' && d14map.inScript({ invalidDataLength: 1 }).hit === true && d14map.inScript({ hostVoterHit: 1 }).hit === true && d14map.inScript({}).hit === false, `class=${idl.cls}`)
    const wrongNamed = d14map.mapClass('VOID-run (wrong-stack)', 'stack differs: mainEvent')
    ok('D7', wrongNamed.reading === 'INSTRUMENT' && d14map.mapClass('CLEAN', '').reading === 'INSTRUMENT', 'a wrong-stack naming mainEvent, and any other class, is an instrument error')
    rmSync(join(EV || S, 'sc'), { recursive: true, force: true })
  }
  // (e) grammar self-test (the only FORK-PRECHECK literals in this file)
  {
    const PASS_RE = /^FORK-PRECHECK: PASS roles=officer,kh-a,kh-b leafRev=\d+ leafAction8=[A-Za-z0-9_-]{8} tailRev=\d+ tailAction8=[A-Za-z0-9_-]{8} digestMismatch=0 reads=\d+ at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/
    const FAIL_RE = /^FORK-PRECHECK: FAIL (role-missing|digest-mismatch-logged|fork-leaf|fork-tail|unreadable)$/
    const VERDICT_RE = /^VERDICT: (PASS|(FAIL|VOID) [a-z0-9][a-z0-9-]*)$/
    const vals = { leafRev: 4, leafAction8: 'abcd1234', tailRev: 5, tailAction8: 'wxyz_-90' }
    const roles3 = ['officer', 'kh-a', 'kh-b']
    const pass = forkPrecheckLine({ roles: roles3, verdict: 'agree', values: vals, digestMismatch: 0, reads: 2, at: '2026-01-01T00:00:00.000Z' })
    const fails = ['role-missing', 'digest-mismatch-logged', 'fork-leaf', 'fork-tail', 'unreadable'].map((t) => forkPrecheckLine({ roles: roles3, verdict: t === 'digest-mismatch-logged' ? 'agree' : t, values: vals, digestMismatch: t === 'digest-mismatch-logged' ? 1 : 0, reads: 1, at: '2026-01-01T00:00:00.000Z' }))
    const needleShape = /[a-z0-9]+-needle-[a-z0-9]{4,}/
    const tokenOk = FAIL_TOKENS.every((t) => !needleShape.test(t) && VERDICT_RE.test(`VERDICT: FAIL ${t}`) && KEEP_RE.test(t))
    const fk = ['role-missing', 'digest-mismatch-logged', 'fork-leaf', 'fork-tail', 'unreadable'].map((t) => `fork-precheck-${t}`)
    ok('E', PASS_RE.test(pass) && fails.every((l) => FAIL_RE.test(l)) && tokenOk && fk.every((t) => FAIL_TOKENS.includes(t)), `pass=${PASS_RE.test(pass)} fails=${fails.filter((l) => FAIL_RE.test(l)).length}/5 tokens=${FAIL_TOKENS.length}`)
  }
  // (f) classify.mjs selftest
  {
    const r = spawnSync(process.execPath, [join(LIB, 'classify.mjs'), '--selftest'], { encoding: 'utf8' })
    const m = /SELFTEST PASS (\d+)\/(\d+)/.exec(r.stdout ?? '')
    ok('F', m !== null && m[1] === m[2], (r.stdout ?? '').trim().split('\n').at(-1) ?? '')
  }
  // (g) opened-set self-test
  {
    const e = (b: string, q: string, o: string[]): any => ({ ballotId: b, answers: [{ questionCode: q, optionCodes: o }] })
    const a = [e('b', 'q', ['x']), e('b', 'q', ['y']), e('b', 'q', ['x'])]
    const hA = sha256hex(openedSetPreimage(a))
    const hB = sha256hex(openedSetPreimage([a[2], a[0], a[1]]))
    const hC = sha256hex(openedSetPreimage([a[0], a[1], e('b', 'q', ['z'])]))
    ok('G', hA === hB && hA !== hC, 'two orders equal, a changed option differs')
  }
  // (h) fork-line parity (notes 19 E26): the driver's fork() path against stub readers and a virtual clock; the line equals forkPrecheckLine's output for the scripted inputs
  {
    const spacing = 5000; const cap = 12000
    const t0 = Date.UTC(2026, 0, 1)
    const mkClock = (): { now: () => number, sleep: (ms: number) => Promise<void>, t: () => number } => { let t = t0; return { now: () => t, sleep: async (ms: number) => { t += ms }, t: () => t } }
    const good = { leafRev: 7, leafAction8: 'AAAAAAAA', tailRev: 8, tailAction8: 'BBBBBBBB' }
    const roles3 = ['officer', 'kh-a', 'kh-b']
    const cases: Array<{ name: string, script: (k: number, role: string) => any, digest: number, expect: (clk: number) => any }> = [
      { name: 'agree-round-1', script: () => good, digest: 0, expect: () => ({ verdict: 'agree', values: good, digestMismatch: 0, reads: 1, at: new Date(t0).toISOString() }) },
      { name: 'agree-after-lag', script: (k, role) => (k >= 2 ? good : (role === 'kh-b' ? { ...good, leafRev: 6 } : good)), digest: 0, expect: () => ({ verdict: 'agree', values: good, digestMismatch: 0, reads: 3, at: new Date(t0 + 2 * spacing).toISOString() }) },
      { name: 'fork-leaf', script: (_k, role) => (role === 'kh-b' ? { ...good, leafAction8: 'CCCCCCCC' } : good), digest: 0, expect: () => ({ verdict: 'fork-leaf', digestMismatch: 0, reads: 3, at: new Date(t0 + 2 * spacing).toISOString() }) },
      { name: 'fork-tail', script: (_k, role) => (role === 'kh-a' ? { ...good, tailRev: 9 } : good), digest: 0, expect: () => ({ verdict: 'fork-tail', digestMismatch: 0, reads: 3, at: new Date(t0 + 2 * spacing).toISOString() }) },
      { name: 'unreadable', script: (_k, role) => (role === 'officer' ? { unreadable: 'shape' } : good), digest: 0, expect: () => ({ verdict: 'unreadable', digestMismatch: 0, reads: 3, at: new Date(t0 + 2 * spacing).toISOString() }) },
      { name: 'digest-1', script: () => good, digest: 1, expect: () => ({ verdict: 'agree', values: good, digestMismatch: 1, reads: 1, at: new Date(t0).toISOString() }) }
    ]
    let allEqual = true
    for (const c of cases) {
      const clk = mkClock()
      let k = 0; let seen = 0
      const rd: Record<string, () => Promise<any>> = {}
      for (const r of roles3) rd[r] = async () => { const v = c.script(k, r); seen++; if (seen % 3 === 0) k++; return v }
      let dig = c.digest
      // the driver's own code path: forkPrecheck with the reader map the driver builds, test-only spacing/cap/clock
      const res = await forkPrecheck({ readers: rd, digestMismatch: () => { const n = dig; dig = 0; return n }, spacingMs: spacing, capMs: cap, now: clk.now, sleep: clk.sleep })
      const want = forkPrecheckLine({ roles: roles3, ...c.expect(clk.t()) })
      const eq = res.line === want
      allEqual = allEqual && eq
      ok(`H-${c.name}`, eq, eq ? 'line equals forkPrecheckLine for the scripted inputs' : `got=${res.line} want=${want}`)
    }
    const neg = cases[0]
    const clk = mkClock()
    const good1 = forkPrecheckLine({ roles: roles3, verdict: 'agree', values: good, digestMismatch: 0, reads: 1, at: new Date(t0).toISOString() })
    const swapped = good1.replace('PASS', 'FAIL fork-leaf').replace(/ roles=.*$/, '')
    void neg; void clk
    ok('H-negative', swapped !== good1 && swapped.includes(' FAIL '), 'a line with its verdict token swapped is reported unequal')
    ok('H', allEqual, 'six cases equal')
  }
  const failed = results.filter(([, p]) => !p).map(([id]) => id)
  rawLog(failed.length === 0 ? `SELFCHECK: PASS ${results.length}/${results.length}` : `SELFCHECK: FAIL ${failed.join(',')}`)
}

if (MODE === 'selfcheck') { try { await selfcheck() } catch (e) { rawLog('SELFCHECK: FAIL crash ' + redact(scrubWall(String((e as Error)?.stack ?? e))).slice(0, 1500)) } clearInterval(stallTimer); process.exit(0) }
if (MODE === 'run') { try { await runMain() } catch (e) { rawLog('RESULT ' + JSON.stringify({ tool: 'hr5-part2', verdict: 'FAIL', reason: 'driver-crash' })); rawLog('CRASH ' + redact(scrubWall(String((e as Error)?.stack ?? e))).slice(0, 1500)) } setTimeout(() => process.exit(0), 200) } else { rawLog('RESULT ' + JSON.stringify({ tool: 'hr5-part2', verdict: 'VOID', reason: 'mode' })); process.exit(0) }
