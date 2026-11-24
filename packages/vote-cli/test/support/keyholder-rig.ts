// keyholder-rig.ts: officer + two keyholder daemons (the BUILT vt bin, real CadreNodes) on the
// loopback relay, driven only through `callCtl`, with per-peer clean restart, ctl reply capture, vault
// state snapshots (names and hashes, never contents), step timings and the secret scan. The election
// is set up through the officer verbs of 67-24 and 67-26 in the lean rig's proven order
// (tools/lean-rig/lean/lean-part2.ts 715-800): found, owner-setup, one mint per keyholder, the
// keyholder joins, create-election, two invite-keyholder seats, ballot-submit. Every officer verb and
// arg name sits in ONE adapter object (OFFICER_VERBS) so a rename changes one line.
//
// Secrecy: tokens, join codes, fingerprints, seat shares, invite private keys, the ballot needle, each
// peer's ctl token and the relay address are registered in the run registry and never printed; a
// STEP line carries a name and a duration only; a kept run dir is named by its basename only.

import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { parseInviteShare } from '@votetorrent/workflows/authority'
import { writeApprovalTokenFile } from '../../src/approval/token.js'
import { callCtl, type CtlReply } from '../../src/ctl/ctl-client.js'
import type { Role } from '../../src/ctl/protocol.js'
import { relayPeerIdOf } from '../../src/node/relay-readiness.js'
import { REPO_ROOT } from '../../src/run/options.js'
import { SecretRegistry } from '../../src/secrecy/redact.js'
import { scanSecrets, type SecretScan } from '../../src/secrecy/scan-secrets.js'
import { DEFAULT_KEY_VAULT_STORAGE_FILE, DEFAULT_VAULT_DIR } from '../../src/vault/device-vault.js'
import { DEVICE_KEY_FILES } from '../../src/vault/device-keys.js'
import { readTokenOnce, startDaemon, type DaemonProc } from './daemon-fixture.js'
import { startLoopbackRelay, type LoopbackRelay } from './loopback-relay.js'

/** Every officer verb and argument name the rig uses, in one place. */
export const OFFICER_VERBS = Object.freeze({
  found: { verb: 'found', args: { name: 'name', tokenFile: 'tokenFile' } },
  ownerSetup: { verb: 'owner-setup' },
  mint: { verb: 'mint', args: { networkHash: 'networkHash', codeFile: 'codeFile', fingerprintFile: 'fingerprintFile' } },
  createElection: {
    verb: 'create-election',
    args: { network: 'network', tokenFile: 'tokenFile', leadMs: 'leadMs', windowMs: 'windowMs', threshold: 'threshold', keyholders: 'keyholders', title: 'title' },
    reply: { electionId: 'electionId', votingStartsAt: 'votingStartsAt', closedAt: 'closedAt' }
  },
  inviteKeyholder: { verb: 'invite-keyholder', args: { network: 'network', election: 'election', name: 'name', tokenFile: 'tokenFile' }, reply: { shareFile: 'shareFile' } },
  ballotSubmit: { verb: 'ballot-submit', args: { network: 'network', election: 'election', tokenFile: 'tokenFile' }, reply: { needleFile: 'needleFile', ballotId: 'ballotId' } }
})

/** The keyholder join's arg names (67-24's authority join, served on the keyholder role by 67-28). */
export const KEYHOLDER_JOIN_ARGS = Object.freeze({ verb: 'join', codeFile: 'codeFile', expectName: 'expectName', expectFingerprintFile: 'expectFingerprintFile', networkHash: 'networkHash', tokenFile: 'tokenFile', timeoutMs: 'timeoutMs' })

export const RIG_LABELS = Object.freeze(['officer', 'kh-a', 'kh-b'] as const)
export type RigLabel = (typeof RIG_LABELS)[number]
export const KEYHOLDER_LABELS: readonly RigLabel[] = Object.freeze(['kh-a', 'kh-b'])
export const NETWORK_NAME = 'T28 Net'

const RELEASING_KEYS_AFTER_ACCRUING_MS = 120_000
const READBACK_READY_MS = 90_000
const READBACK_POLL_MS = 1_000
const STOP_VERB_TIMEOUT_MS = 10_000
const STOP_WAIT_MS = 15_000
const TERM_WAIT_MS = 10_000
const KILL_WAIT_MS = 10_000
const JOIN_TIMEOUT_MS = '420000'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface StepRecord {
  name: string
  startMs: number
  endMs: number
}

export interface VaultState {
  /** Sorted record file names under `vault/records/`. */
  records: string[]
  salt: string | null
  atRest: string | null
  sealed: string | null
  tokenCheck: string | null
}

export interface StopResult {
  exitCode: number | null
  killed: boolean
  stopMs: number
}

export interface RestartResult extends StopResult {
  before: VaultState
  after: VaultState
  peerId8Before: string
  peerId8After: string
  startMs: number
}

export interface ElectionSetup {
  networkHash: string
  electionId: string
  /** Absolute paths of the two seat share files (kh-a, kh-b), inside the officer's secrets dir. */
  seatFiles: [string, string]
  releasingKeysAt: number
  votingStartsAt: number
  closedAt: number
}

export interface KeyholderRigOptions {
  party: string
  leadMs: number
  windowMs: number
}

export interface CallOptions {
  timeoutMs?: number
}

export class RigError extends Error {
  readonly token: string

  constructor(token: string, detail = '') {
    super(`keyholder rig: ${token}${detail === '' ? '' : ` ${detail}`}`)
    this.name = 'RigError'
    this.token = token
  }
}

export interface ErrorView {
  name: string
  code?: string
  message?: string
  chain?: string[]
}

export interface KeyholderRig {
  readonly dir: string
  readonly party: string
  readonly relay: LoopbackRelay
  readonly registry: SecretRegistry
  readonly logsDir: string
  readonly secretsDir: string
  readonly tokens: Readonly<Record<RigLabel | 'wrong' | 'open', string>>
  readonly steps: StepRecord[]
  readonly captured: string[]
  peerDir(label: RigLabel): string
  roleOf(label: RigLabel): Role
  peerId8(label: RigLabel): string
  isLive(label: RigLabel): boolean
  startPeer(label: RigLabel): Promise<{ peerId8: string, startMs: number, circuitReady: boolean }>
  stopPeer(label: RigLabel): Promise<StopResult>
  restartPeer(label: RigLabel): Promise<RestartResult>
  listVaultState(label: RigLabel): VaultState
  call(label: RigLabel, verb: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<CtlReply>
  ok(label: RigLabel, verb: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<Record<string, unknown>>
  refused(label: RigLabel, verb: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<ErrorView>
  step<T>(name: string, fn: () => Promise<T>): Promise<T>
  // the election setup, whole or in parts
  startOfficerAndFound(): Promise<string>
  mintFor(label: RigLabel): Promise<{ codeFile: string, fingerprintFile: string }>
  joinKeyholder(label: RigLabel, opts?: { expectName?: string }): Promise<Record<string, unknown>>
  createElection(): Promise<ElectionSetup>
  inviteSeat(label: RigLabel): Promise<string>
  ballotSubmit(): Promise<Record<string, unknown>>
  setupElection(): Promise<ElectionSetup>
  readonly election: ElectionSetup | undefined
  readonly networkHash: string
  /** Daemon output: logs, top-level peer records and every captured reply, against the run registry. */
  scan(): SecretScan
  /** Every file under each peer dir (vault, node, store, records) against `registry`. */
  scanPeerDirs(registry: SecretRegistry): SecretScan
  /** The vault dir (key files, sealed store, records) and top-level records of each peer against `registry`; never `node/` or `secrets/`. */
  scanVaults(registry: SecretRegistry): SecretScan
  close(opts?: { keep?: boolean }): Promise<void>
}

function sha256File(path: string): string | null {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function insideRepo(dir: string): boolean {
  const repo = realpathSync(REPO_ROOT).replace(/\/$/, '')
  const real = realpathSync(dir)
  return real === repo || real.startsWith(repo + '/')
}

export function randomParty(prefix: string): string {
  return `${prefix}-${randomBytes(3).toString('hex')}`
}

export async function startKeyholderRig(opts: KeyholderRigOptions): Promise<KeyholderRig> {
  const dir = mkdtempSync(join(tmpdir(), 'vt-28-'))
  chmodSync(dir, 0o700)
  if (insideRepo(dir)) {
    rmSync(dir, { recursive: true, force: true })
    throw new RigError('run-dir-in-repo')
  }
  const secretsDir = join(dir, 'secrets')
  const logsDir = join(dir, 'logs')
  const stateRoot = join(dir, 'state')
  for (const d of [secretsDir, logsDir, stateRoot, join(stateRoot, opts.party)]) mkdirSync(d, { mode: 0o700 })
  const registry = new SecretRegistry()
  const tokens: Record<RigLabel | 'wrong' | 'open', string> = {
    officer: join(secretsDir, 'officer.token'),
    'kh-a': join(secretsDir, 'kh-a.token'),
    'kh-b': join(secretsDir, 'kh-b.token'),
    wrong: join(secretsDir, 'wrong.token'),
    open: join(secretsDir, 'open.token')
  }
  for (const k of ['officer', 'kh-a', 'kh-b', 'wrong'] as const) {
    writeApprovalTokenFile(tokens[k])
    registry.add(readFileSync(tokens[k], 'utf8').trim(), { windows: true })
  }
  copyFileSync(tokens.officer, tokens.open)
  chmodSync(tokens.open, 0o644)
  const repliesPath = join(logsDir, 'ctl-replies.jsonl')
  writeFileSync(repliesPath, '', { mode: 0o600 })

  const relay = await startLoopbackRelay()
  registry.add(relay.multiaddr)
  registry.add(relayPeerIdOf(relay.multiaddr))

  const procs = new Map<RigLabel, DaemonProc>()
  const peerIds = new Map<RigLabel, string>()
  const steps: StepRecord[] = []
  const captured: string[] = []
  let networkHash = ''
  let election: ElectionSetup | undefined

  const peerDir = (label: RigLabel): string => join(stateRoot, opts.party, label)
  const roleOf = (label: RigLabel): Role => (label === 'officer' ? 'officer' : 'keyholder')

  const call = async (label: RigLabel, verb: string, args: Record<string, unknown> = {}, o: CallOptions = {}): Promise<CtlReply> => {
    const reply = await callCtl({ dir: peerDir(label), role: roleOf(label), verb, args, timeoutMs: o.timeoutMs ?? 1_000_000 })
    const line = JSON.stringify({ label, verb, status: reply.status, body: reply.body })
    captured.push(line)
    appendFileSync(repliesPath, line + '\n', { mode: 0o600 })
    return reply
  }
  const ok = async (label: RigLabel, verb: string, args: Record<string, unknown> = {}, o: CallOptions = {}): Promise<Record<string, unknown>> => {
    const reply = await call(label, verb, args, o)
    if (reply.status !== 200 || reply.body.ok !== true) {
      const e = reply.body.error
      throw new RigError('call-failed', `${label} ${verb} status=${reply.status} ${e?.name ?? ''} ${e?.code ?? ''} ${String(e?.message ?? '').slice(0, 160)}`)
    }
    return (reply.body.result ?? {}) as Record<string, unknown>
  }
  const refused = async (label: RigLabel, verb: string, args: Record<string, unknown> = {}, o: CallOptions = {}): Promise<ErrorView> => {
    const reply = await call(label, verb, args, o)
    if (reply.status === 200 && reply.body.ok === true) throw new RigError('call-succeeded', `${label} ${verb}`)
    const e = reply.body.error
    if (e === undefined) throw new RigError('no-error-view', `${label} ${verb} status=${reply.status}`)
    return e as ErrorView
  }

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const startMs = Date.now()
    try {
      return await fn()
    } finally {
      const endMs = Date.now()
      steps.push({ name, startMs, endMs })
      console.log(`      STEP ${name} ms=${endMs - startMs}`)
    }
  }

  const startPeer = async (label: RigLabel): Promise<{ peerId8: string, startMs: number, circuitReady: boolean }> => {
    if (procs.has(label)) throw new RigError('peer-live', label)
    const t0 = Date.now()
    const proc = await startDaemon({ role: roleOf(label), peerDir: peerDir(label), relayEnvPath: relay.relayEnvPath, party: opts.party, logDir: logsDir })
    if (!proc.ready) throw new RigError('boot-failed', `${label} token=${proc.bootFailedToken ?? 'none'} exit=${String(proc.exitCode())}`)
    procs.set(label, proc)
    registry.add(readTokenOnce(peerDir(label)), { windows: true })
    let circuitReady = false
    let peerId8 = ''
    const deadline = Date.now() + READBACK_READY_MS
    for (;;) {
      const r = await call(label, 'readback', {}, { timeoutMs: 30_000 })
      const res = (r.body.result ?? {}) as { peerId8?: unknown, circuitReady?: unknown }
      if (typeof res.peerId8 === 'string') peerId8 = res.peerId8
      if (res.circuitReady === true) {
        circuitReady = true
        break
      }
      if (Date.now() > deadline) break
      await sleep(READBACK_POLL_MS)
    }
    if (peerId8 === '') throw new RigError('readback-failed', label)
    peerIds.set(label, peerId8)
    return { peerId8, startMs: Date.now() - t0, circuitReady }
  }

  const stopPeer = async (label: RigLabel): Promise<StopResult> => {
    const proc = procs.get(label)
    if (proc === undefined) throw new RigError('peer-not-live', label)
    const t0 = Date.now()
    let killed = false
    if (!proc.exited()) {
      await call(label, 'stop', {}, { timeoutMs: STOP_VERB_TIMEOUT_MS })
      if ((await proc.waitExit(STOP_WAIT_MS)) === null && !proc.exited()) {
        killed = true
        proc.proc.kill('SIGTERM')
        if ((await proc.waitExit(TERM_WAIT_MS)) === null && !proc.exited()) {
          proc.proc.kill('SIGKILL')
          await proc.waitExit(KILL_WAIT_MS)
        }
      }
    }
    procs.delete(label)
    return { exitCode: proc.exitCode(), killed, stopMs: Date.now() - t0 }
  }

  const listVaultState = (label: RigLabel): VaultState => {
    const vault = join(peerDir(label), DEFAULT_VAULT_DIR)
    const recordsDir = join(vault, 'records')
    return {
      records: existsSync(recordsDir) ? readdirSync(recordsDir).sort() : [],
      salt: sha256File(join(vault, DEVICE_KEY_FILES.salt)),
      atRest: sha256File(join(vault, DEVICE_KEY_FILES.atRest)),
      sealed: sha256File(join(vault, DEFAULT_KEY_VAULT_STORAGE_FILE)),
      tokenCheck: sha256File(join(vault, DEVICE_KEY_FILES.tokenCheck))
    }
  }

  const restartPeer = async (label: RigLabel): Promise<RestartResult> => {
    const peerId8Before = peerIds.get(label) ?? ''
    const stopped = await stopPeer(label)
    if (stopped.killed || stopped.exitCode !== 0) throw new RigError('unclean-stop', `${label} killed=${String(stopped.killed)} exit=${String(stopped.exitCode)}`)
    const before = listVaultState(label)
    const started = await startPeer(label)
    const after = listVaultState(label)
    return { ...stopped, before, after, peerId8Before, peerId8After: started.peerId8, startMs: started.startMs }
  }

  const readSecretFileOnce = (path: string, windows: boolean): string => {
    const text = readFileSync(path, 'utf8').trim()
    registry.add(text, { windows })
    return text
  }

  const startOfficerAndFound = async (): Promise<string> => {
    if (!procs.has('officer')) await step('start-officer', () => startPeer('officer'))
    const r = await step('found', () => ok('officer', OFFICER_VERBS.found.verb, { [OFFICER_VERBS.found.args.name]: NETWORK_NAME, [OFFICER_VERBS.found.args.tokenFile]: tokens.officer }, { timeoutMs: 600_000 }))
    networkHash = String(r.networkHash)
    await step('owner-setup', () => ok('officer', OFFICER_VERBS.ownerSetup.verb, {}, { timeoutMs: 300_000 }))
    return networkHash
  }

  const mintFor = async (label: RigLabel): Promise<{ codeFile: string, fingerprintFile: string }> => {
    const codeFile = join(secretsDir, `join-${label}.txt`)
    const fingerprintFile = join(secretsDir, `fingerprint-${label}.txt`)
    await step(`mint-${label}`, () => ok('officer', OFFICER_VERBS.mint.verb, { [OFFICER_VERBS.mint.args.networkHash]: networkHash, [OFFICER_VERBS.mint.args.codeFile]: codeFile, [OFFICER_VERBS.mint.args.fingerprintFile]: fingerprintFile }, { timeoutMs: 300_000 }))
    readSecretFileOnce(codeFile, true)
    readSecretFileOnce(fingerprintFile, true)
    return { codeFile, fingerprintFile }
  }

  const joinKeyholder = async (label: RigLabel, o: { expectName?: string } = {}): Promise<Record<string, unknown>> => {
    const codeFile = join(secretsDir, `join-${label}.txt`)
    const fingerprintFile = join(secretsDir, `fingerprint-${label}.txt`)
    return step(`join-${label}`, () =>
      ok(label, KEYHOLDER_JOIN_ARGS.verb, {
        [KEYHOLDER_JOIN_ARGS.codeFile]: codeFile,
        [KEYHOLDER_JOIN_ARGS.expectName]: o.expectName ?? NETWORK_NAME,
        [KEYHOLDER_JOIN_ARGS.expectFingerprintFile]: fingerprintFile,
        [KEYHOLDER_JOIN_ARGS.networkHash]: networkHash,
        [KEYHOLDER_JOIN_ARGS.tokenFile]: tokens[label],
        [KEYHOLDER_JOIN_ARGS.timeoutMs]: JOIN_TIMEOUT_MS
      }, { timeoutMs: 600_000 })
    )
  }

  const createElection = async (): Promise<ElectionSetup> => {
    const c = OFFICER_VERBS.createElection
    const r = await step('create-election', () =>
      ok('officer', c.verb, {
        [c.args.network]: networkHash,
        [c.args.tokenFile]: tokens.officer,
        [c.args.leadMs]: String(opts.leadMs),
        [c.args.windowMs]: String(opts.windowMs),
        [c.args.threshold]: '2',
        [c.args.keyholders]: 'kh-a,kh-b',
        [c.args.title]: 'vt28-election'
      }, { timeoutMs: 300_000 })
    )
    const votingStartsAt = Date.parse(String(r[c.reply.votingStartsAt]))
    const closedAt = Date.parse(String(r[c.reply.closedAt]))
    const releasingKeysAt = Number.isFinite(votingStartsAt) ? votingStartsAt + opts.windowMs + RELEASING_KEYS_AFTER_ACCRUING_MS : Date.now() + opts.leadMs + opts.windowMs + RELEASING_KEYS_AFTER_ACCRUING_MS
    election = { networkHash, electionId: String(r[c.reply.electionId]), seatFiles: ['', ''], releasingKeysAt, votingStartsAt, closedAt }
    return election
  }

  const inviteSeat = async (label: RigLabel): Promise<string> => {
    if (election === undefined) throw new RigError('no-election')
    const i = OFFICER_VERBS.inviteKeyholder
    const r = await step(`invite-${label}`, () =>
      ok('officer', i.verb, { [i.args.network]: networkHash, [i.args.election]: election!.electionId, [i.args.name]: label, [i.args.tokenFile]: tokens.officer }, { timeoutMs: 300_000 })
    )
    const shareFile = String(r[i.reply.shareFile])
    const text = readSecretFileOnce(shareFile, true)
    const parsed = parseInviteShare(text)
    if (parsed !== undefined) registry.add(parsed.invitePrivate, { windows: true })
    election.seatFiles[label === 'kh-a' ? 0 : 1] = shareFile
    return shareFile
  }

  const ballotSubmit = async (): Promise<Record<string, unknown>> => {
    if (election === undefined) throw new RigError('no-election')
    const b = OFFICER_VERBS.ballotSubmit
    const r = await step('ballot-submit', () => ok('officer', b.verb, { [b.args.network]: networkHash, [b.args.election]: election!.electionId, [b.args.tokenFile]: tokens.officer }, { timeoutMs: 300_000 }))
    const needleFile = r[b.reply.needleFile]
    if (typeof needleFile === 'string') readSecretFileOnce(needleFile, true)
    return r
  }

  const setupElection = async (): Promise<ElectionSetup> => {
    await startOfficerAndFound()
    for (const kh of KEYHOLDER_LABELS) await mintFor(kh)
    for (const kh of KEYHOLDER_LABELS) await step(`start-${kh}`, () => startPeer(kh))
    for (const kh of KEYHOLDER_LABELS) await joinKeyholder(kh)
    await createElection()
    for (const kh of KEYHOLDER_LABELS) await inviteSeat(kh)
    await ballotSubmit()
    return election!
  }

  const copyInto = (scanDir: string, srcDir: string, pick: (name: string) => boolean, prefix: string): number => {
    if (!existsSync(srcDir)) return 0
    let n = 0
    for (const f of readdirSync(srcDir, { withFileTypes: true })) {
      if (f.isFile() && pick(f.name)) {
        copyFileSync(join(srcDir, f.name), join(scanDir, `${prefix}-${f.name}`))
        n++
      }
    }
    return n
  }

  let scanN = 0
  const scan = (): SecretScan => {
    const scanDir = join(dir, `scan-${++scanN}`)
    mkdirSync(scanDir, { mode: 0o700 })
    copyInto(scanDir, logsDir, (n) => n.endsWith('.log') || n.endsWith('.jsonl'), 'logs')
    for (const label of RIG_LABELS) copyInto(scanDir, peerDir(label), (n) => n.endsWith('.json') || n.endsWith('.jsonl'), label)
    writeFileSync(join(scanDir, 'replies.txt'), captured.join('\n'), { mode: 0o600 })
    return scanSecrets(scanDir, registry)
  }

  const sum = (a: SecretScan, b: SecretScan): SecretScan => ({
    whole: a.whole < 0 || b.whole < 0 ? -1 : a.whole + b.whole,
    windows: a.windows + b.windows,
    files: a.files + b.files
  })

  const scanPeerDirs = (reg: SecretRegistry): SecretScan => {
    let total: SecretScan = { whole: 0, windows: 0, files: 0 }
    for (const label of RIG_LABELS) if (existsSync(peerDir(label))) total = sum(total, scanSecrets(peerDir(label), reg))
    return total
  }

  const scanVaults = (reg: SecretRegistry): SecretScan => {
    const scanDir = join(dir, `scan-${++scanN}`)
    mkdirSync(scanDir, { mode: 0o700 })
    for (const label of RIG_LABELS) {
      const vault = join(peerDir(label), DEFAULT_VAULT_DIR)
      copyInto(scanDir, vault, () => true, `${label}-vault`)
      copyInto(scanDir, join(vault, 'records'), () => true, `${label}-rec`)
      copyInto(scanDir, peerDir(label), (n) => n.endsWith('.json') || n.endsWith('.jsonl'), label)
    }
    return scanSecrets(scanDir, reg)
  }

  const close = async (o: { keep?: boolean } = {}): Promise<void> => {
    for (const label of [...procs.keys()]) {
      try {
        await stopPeer(label)
      } catch {
        // best effort
      }
    }
    await relay.stop().catch(() => undefined)
    rmSync(relay.dir, { recursive: true, force: true })
    const keep = o.keep === true || process.env.VT_KEEP_RUN === '1'
    if (keep) console.log(`      run dir kept: <tmp>/${basename(dir)}`)
    else rmSync(dir, { recursive: true, force: true })
  }

  return {
    dir,
    party: opts.party,
    relay,
    registry,
    logsDir,
    secretsDir,
    tokens,
    steps,
    captured,
    peerDir,
    roleOf,
    peerId8: (label) => peerIds.get(label) ?? '',
    isLive: (label) => procs.has(label),
    startPeer,
    stopPeer,
    restartPeer,
    listVaultState,
    call,
    ok,
    refused,
    step,
    startOfficerAndFound,
    mintFor,
    joinKeyholder,
    createElection,
    inviteSeat,
    ballotSubmit,
    setupElection,
    get election() {
      return election
    },
    get networkHash() {
      return networkHash
    },
    scan,
    scanPeerDirs,
    scanVaults,
    close
  }
}
