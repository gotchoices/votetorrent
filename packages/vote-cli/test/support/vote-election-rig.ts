// vote-election-rig.ts: the SIX-peer election rig for the host-tier ctl spec (67-30 Task 4): one officer daemon
// in token posture, two keyholder daemons and three voter daemons (the BUILT vt bin, real CadreNodes) on the
// loopback relay, driven only through `callCtl`. Modeled on 67-28's keyholder rig (per-peer start, step timing,
// ctl reply capture, the election setup in the lean rig's proven order) and 67-29's voter rig (the token-posture
// officer, the intake loop, the per-voter codes, tokens and registrant files); 67-28's rig itself has no officer
// posture option and a closed label set, so the parts live here. Every verb and arg name of 67-24/26/27/28/29
// and of this plan's verbs sits in ONE adapter object (ELECTION_STEPS). Each successful call appends
// `VERB-MS <role>:<verb> <result.ms> <reply ms>` (names and numbers only) to `${TMPDIR}/67-30/verb-ms.txt`.
//
// Secrecy: tokens, join codes, fingerprints, seat shares and their invite private keys, the ballot needle,
// registrant values, each peer's ctl token and the relay address are registered in the run registry and never
// printed; a STEP line carries a name and a duration only; a kept run dir is named by its basename only.

import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { parseInviteShare } from '@votetorrent/workflows/authority'
import { writeApprovalTokenFile } from '../../src/approval/token.js'
import { callCtl, type CtlReply } from '../../src/ctl/ctl-client.js'
import { CTL_TOKEN_FILE, type Role } from '../../src/ctl/protocol.js'
import { DEFAULT_LEAD_MS, DEFAULT_WINDOW_MS } from '../../src/election/parse-timeline.js'
import { relayPeerIdOf } from '../../src/node/relay-readiness.js'
import { defaultMaxPeers } from '../../src/run/peer-budget.js'
import { REPO_ROOT } from '../../src/run/options.js'
import { SecretRegistry } from '../../src/secrecy/redact.js'
import { scanSecrets, type SecretScan } from '../../src/secrecy/scan-secrets.js'
import { readTokenOnce, startDaemon, type DaemonProc } from './daemon-fixture.js'
import { startLoopbackRelay, type LoopbackRelay } from './loopback-relay.js'

/** Every verb and argument name the rig drives, in one place (from the landed SUMMARYs). */
export const ELECTION_STEPS = Object.freeze({
  officer: {
    found: { verb: 'found', args: { name: 'name', tokenFile: 'tokenFile' }, reply: { networkHash: 'networkHash' } },
    ownerSetup: { verb: 'owner-setup' },
    authorityId: { verb: 'authority-id', args: { networkHash: 'networkHash' }, reply: { authorityId8: 'authorityId8' } },
    mint: { verb: 'mint', args: { networkHash: 'networkHash', codeFile: 'codeFile', fingerprintFile: 'fingerprintFile' } },
    createElection: {
      verb: 'create-election',
      args: { network: 'network', tokenFile: 'tokenFile', leadMs: 'leadMs', windowMs: 'windowMs', threshold: 'threshold', keyholders: 'keyholders', title: 'title' },
      reply: { electionId: 'electionId', votingStartsAt: 'votingStartsAt', closedAt: 'closedAt' }
    },
    inviteKeyholder: { verb: 'invite-keyholder', args: { network: 'network', election: 'election', name: 'name', tokenFile: 'tokenFile' }, reply: { shareFile: 'shareFile' } },
    ballotSubmit: { verb: 'ballot-submit', args: { network: 'network', election: 'election', tokenFile: 'tokenFile' }, reply: { needleFile: 'needleFile', ballotId: 'ballotId' } },
    taskSign: { verb: 'task-sign', args: { network: 'network', election: 'election', ballot: 'ballot', waitMs: 'waitMs', tokenFile: 'tokenFile' }, reply: { confirmed: 'confirmed' } },
    enableIntake: { verb: 'enable-intake', args: { authority: 'authority', network: 'network', tokenFile: 'tokenFile' } },
    peerSync: { verb: 'peer-sync', args: { authority: 'authority', network: 'network', tokenFile: 'tokenFile' } },
    registrations: { verb: 'registrations', args: { authority: 'authority', network: 'network' }, reply: { rows: 'rows' } },
    approve: { verb: 'approve', args: { authority: 'authority', network: 'network', request: 'request', checklist: 'checklist', tokenFile: 'tokenFile' } },
    releaseWindow: { verb: 'release-window', args: { network: 'network', election: 'election', waitMs: 'waitMs', awaitReleased: 'awaitReleased', needleFile: 'needleFile' } },
    tally: { verb: 'tally', args: { network: 'network', election: 'election', expectedFiles: 'expectedFiles', needleFile: 'needleFile', tokenFile: 'tokenFile' } },
    publish: { verb: 'publish', args: { network: 'network', election: 'election', tokenFile: 'tokenFile' } },
    results: { verb: 'results', args: { network: 'network', election: 'election', waitMs: 'waitMs', requirePublished: 'requirePublished', expectedFiles: 'expectedFiles', needleFile: 'needleFile' } },
    readback: { verb: 'readback' }
  },
  keyholder: {
    join: { verb: 'join', args: { codeFile: 'codeFile', expectName: 'expectName', expectFingerprintFile: 'expectFingerprintFile', networkHash: 'networkHash', tokenFile: 'tokenFile', timeoutMs: 'timeoutMs' } },
    accept: { verb: 'accept', args: { network: 'network', shareFile: 'shareFile', tokenFile: 'tokenFile' } },
    dkg: { verb: 'dkg', args: { network: 'network', election: 'election', tokenFile: 'tokenFile' } },
    release: { verb: 'release', args: { network: 'network', election: 'election', tokenFile: 'tokenFile' }, reply: { releasedCount: 'releasedCount', rejected: 'rejected' } },
    results: { verb: 'results' }
  },
  voter: {
    join: { verb: 'join', args: { codeFile: 'codeFile', expectFingerprintFile: 'expectFingerprintFile', tokenFile: 'tokenFile' } },
    register: { verb: 'register', args: { network: 'network', registrantFile: 'registrantFile', tokenFile: 'tokenFile' }, reply: { registrantId: 'registrantId' } },
    stageAssociation: { verb: 'stage-association', args: { network: 'network', tokenFile: 'tokenFile' } },
    answerChallenge: { verb: 'answer-challenge', args: { network: 'network', waitMs: 'waitMs', tokenFile: 'tokenFile' } },
    readDecision: { verb: 'read-decision', args: { network: 'network', waitFor: 'waitFor', waitMs: 'waitMs' }, reply: { status: 'status' } },
    cast: { verb: 'cast', args: { network: 'network', election: 'election', choiceIndex: 'choiceIndex', tokenFile: 'tokenFile' } },
    send: { verb: 'send', args: { network: 'network', election: 'election', tokenFile: 'tokenFile' } },
    results: { verb: 'results' }
  }
})

export const RIG_LABELS = Object.freeze(['officer', 'kh-a', 'kh-b', 'v1', 'v2', 'v3'] as const)
export type RigLabel = (typeof RIG_LABELS)[number]
export const KEYHOLDER_LABELS: readonly RigLabel[] = Object.freeze(['kh-a', 'kh-b'])
export const VOTER_LABELS: readonly RigLabel[] = Object.freeze(['v1', 'v2', 'v3'])
export const NETWORK_NAME = 'T30 Net'
export const VERB_MS_DIR = join(process.env.TMPDIR ?? tmpdir(), '67-30')
export const VERB_MS_FILE = join(VERB_MS_DIR, 'verb-ms.txt')
export const POSTURE_FLAG = '--accept-token-attestations'
export const MIN_PEERS = 6

const RELEASING_KEYS_AFTER_ACCRUING_MS = 120_000
const READBACK_READY_MS = 90_000
const READBACK_POLL_MS = 1_000
const STOP_VERB_TIMEOUT_MS = 10_000
const STOP_WAIT_MS = 15_000
const TERM_WAIT_MS = 10_000
const KILL_WAIT_MS = 10_000
const JOIN_TIMEOUT_MS = '420000'
const SYNC_EVERY_MS = 5_000
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface StepRecord {
  name: string
  startMs: number
  endMs: number
}

export interface VotingElectionSetup {
  networkHash: string
  authorityId8: string
  electionId: string
  ballotId: string
  needleFile: string
  seatFiles: [string, string]
  votingStartsAt: number
  releasingKeysAt: number
  closedAt: number
  registrantIds: Record<string, string>
}

export interface CallOptions {
  timeoutMs?: number
}

export class RigError extends Error {
  readonly token: string

  constructor(token: string, detail = '') {
    super(`vote election rig: ${token}${detail === '' ? '' : ` ${detail}`}`)
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

export interface VoteElectionRig {
  readonly dir: string
  readonly party: string
  readonly relay: LoopbackRelay
  readonly registry: SecretRegistry
  readonly logsDir: string
  readonly secretsDir: string
  readonly tokens: Readonly<Record<RigLabel | 'wrong', string>>
  readonly steps: StepRecord[]
  readonly captured: string[]
  readonly election: VotingElectionSetup | undefined
  peerDir(label: RigLabel): string
  roleOf(label: RigLabel): Role
  isLive(label: RigLabel): boolean
  startPeer(label: RigLabel): Promise<{ peerId8: string, startMs: number, circuitReady: boolean }>
  stopPeer(label: RigLabel): Promise<{ exitCode: number | null, killed: boolean, stopMs: number }>
  call(label: RigLabel, verb: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<CtlReply>
  ok(label: RigLabel, verb: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<Record<string, unknown>>
  refused(label: RigLabel, verb: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<ErrorView>
  step<T>(name: string, fn: () => Promise<T>): Promise<T>
  setupVotingElection(): Promise<VotingElectionSetup>
  /** Daemon output: logs (incl. ctl-replies.jsonl), top-level peer records and every captured reply, against the run registry. */
  scanOutputs(): SecretScan
  /** Every peer dir minus `secrets/`, the strand replica (`node/store`) and `ctl.token`, plus `logs/`, against `registry`. */
  scanPeersAndLogs(registry: SecretRegistry): SecretScan
  close(opts?: { keep?: boolean }): Promise<void>
}

export interface VoteElectionRigOptions {
  party: string
  leadMs?: number
  windowMs?: number
}

function insideRepo(dir: string): boolean {
  const repo = realpathSync(REPO_ROOT).replace(/\/$/, '')
  const real = realpathSync(dir)
  return real === repo || real.startsWith(repo + '/')
}

export function randomParty(prefix: string): string {
  return `${prefix}-${randomBytes(3).toString('hex')}`
}

export async function startVoteElectionRig(opts: VoteElectionRigOptions): Promise<VoteElectionRig> {
  const maxPeers = defaultMaxPeers()
  if (maxPeers < MIN_PEERS) throw new RigError('max-peers', `defaultMaxPeers=${maxPeers} < ${MIN_PEERS}`)
  const leadMs = opts.leadMs ?? DEFAULT_LEAD_MS
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  mkdirSync(VERB_MS_DIR, { recursive: true, mode: 0o700 })
  const dir = mkdtempSync(join(tmpdir(), 'vt-30-'))
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
  const tokens = {} as Record<RigLabel | 'wrong', string>
  for (const k of [...RIG_LABELS, 'wrong'] as const) {
    tokens[k] = join(secretsDir, `${k}.token`)
    writeApprovalTokenFile(tokens[k])
    registry.add(readFileSync(tokens[k], 'utf8').trim(), { windows: true })
  }
  const repliesPath = join(logsDir, 'ctl-replies.jsonl')
  writeFileSync(repliesPath, '', { mode: 0o600 })

  const relay = await startLoopbackRelay()
  registry.add(relay.multiaddr)
  registry.add(relayPeerIdOf(relay.multiaddr))

  const procs = new Map<RigLabel, DaemonProc>()
  const peerIds = new Map<RigLabel, string>()
  const steps: StepRecord[] = []
  const captured: string[] = []
  let election: VotingElectionSetup | undefined

  const peerDir = (label: RigLabel): string => join(stateRoot, opts.party, label)
  const roleOf = (label: RigLabel): Role => (label === 'officer' ? 'officer' : label.startsWith('kh-') ? 'keyholder' : 'voter')

  const call = async (label: RigLabel, verb: string, args: Record<string, unknown> = {}, o: CallOptions = {}): Promise<CtlReply> => {
    const reply = await callCtl({ dir: peerDir(label), role: roleOf(label), verb, args, timeoutMs: o.timeoutMs ?? 1_000_000 })
    const line = JSON.stringify({ label, verb, status: reply.status, body: reply.body })
    captured.push(line)
    appendFileSync(repliesPath, line + '\n', { mode: 0o600 })
    if (reply.status === 200 && reply.body.ok === true) {
      const result = (reply.body.result ?? {}) as { ms?: unknown }
      const replyMs = (reply.body as { ms?: unknown }).ms
      if (typeof result.ms === 'number' && typeof replyMs === 'number') appendFileSync(VERB_MS_FILE, `VERB-MS ${roleOf(label)}:${verb} ${Math.round(result.ms)} ${Math.round(replyMs)}\n`, { mode: 0o600 })
    }
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
    const extra = label === 'officer' ? [POSTURE_FLAG] : []
    const proc = await startDaemon({ role: roleOf(label), peerDir: peerDir(label), relayEnvPath: relay.relayEnvPath, party: opts.party, extra, logDir: logsDir })
    if (!proc.ready) throw new RigError('boot-failed', `${label} token=${proc.bootFailedToken ?? 'none'} exit=${String(proc.exitCode())}`)
    procs.set(label, proc)
    registry.add(readTokenOnce(peerDir(label)), { windows: true })
    let circuitReady = false
    let peerId8 = ''
    const deadline = Date.now() + READBACK_READY_MS
    for (;;) {
      const r = await call(label, ELECTION_STEPS.officer.readback.verb, {}, { timeoutMs: 30_000 })
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

  const stopPeer = async (label: RigLabel): Promise<{ exitCode: number | null, killed: boolean, stopMs: number }> => {
    const proc = procs.get(label)
    if (proc === undefined) throw new RigError('peer-not-live', label)
    const t0 = Date.now()
    let killed = false
    if (!proc.exited()) {
      await call(label, 'stop', {}, { timeoutMs: STOP_VERB_TIMEOUT_MS }).catch(() => undefined)
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

  const readSecretFileOnce = (path: string, windows: boolean): string => {
    const text = readFileSync(path, 'utf8').trim()
    registry.add(text, { windows })
    return text
  }

  const registrantFile = (label: RigLabel): string => {
    const p = join(secretsDir, `${label}.registrant.json`)
    if (!existsSync(p)) {
      const n = label.replace(/[^0-9]/g, '') || '1'
      const email = `voter${n}-${randomBytes(4).toString('hex')}@example.invalid`
      writeFileSync(p, JSON.stringify({ firstName: 'Vtcli', lastName: `Voter${n}`, email, dob: '1990-01-01' }), { mode: 0o600 })
      chmodSync(p, 0o600)
      registry.add(email, { windows: true })
    }
    return p
  }

  /** The officer's peer-sync every 5 s until `pred` holds or `boundMs` passes; the last body is returned. */
  const officerSyncUntil = async (authorityId8: string, networkHash: string, pred: (body: Record<string, unknown>) => boolean | Promise<boolean>, boundMs: number): Promise<{ body: Record<string, unknown>, rounds: number }> => {
    const S = ELECTION_STEPS.officer.peerSync
    const deadline = Date.now() + boundMs
    let rounds = 0
    for (;;) {
      rounds++
      const body = await ok('officer', S.verb, { [S.args.authority]: authorityId8, [S.args.network]: networkHash, [S.args.tokenFile]: tokens.officer }, { timeoutMs: 300_000 })
      if (await pred(body)) return { body, rounds }
      if (Date.now() >= deadline) throw new RigError('sync-timeout', `after ${rounds} rounds`)
      await sleep(SYNC_EVERY_MS)
    }
  }

  /** Runs the officer's peer-sync every 5 s in the background until `stop()` is called. */
  const syncLoop = (authorityId8: string, networkHash: string): { stop(): Promise<number> } => {
    const S = ELECTION_STEPS.officer.peerSync
    let stopped = false
    let rounds = 0
    const done = (async () => {
      while (!stopped) {
        rounds++
        await ok('officer', S.verb, { [S.args.authority]: authorityId8, [S.args.network]: networkHash, [S.args.tokenFile]: tokens.officer }, { timeoutMs: 300_000 }).catch(() => undefined)
        for (let i = 0; i < SYNC_EVERY_MS / 500 && !stopped; i++) await sleep(500)
      }
      return rounds
    })()
    return { stop: async () => { stopped = true; return done } }
  }

  const setupVotingElection = async (): Promise<VotingElectionSetup> => {
    const O = ELECTION_STEPS.officer
    const K = ELECTION_STEPS.keyholder
    const V = ELECTION_STEPS.voter
    await step('start-officer', () => startPeer('officer'))
    const found = await step('found', () => ok('officer', O.found.verb, { [O.found.args.name]: NETWORK_NAME, [O.found.args.tokenFile]: tokens.officer }, { timeoutMs: 600_000 }))
    const networkHash = String(found[O.found.reply.networkHash])
    await step('owner-setup', () => ok('officer', O.ownerSetup.verb, {}, { timeoutMs: 300_000 }))
    const aid = await step('authority-id', () => ok('officer', O.authorityId.verb, { [O.authorityId.args.networkHash]: networkHash }))
    const authorityId8 = String(aid[O.authorityId.reply.authorityId8])
    const codeFiles = new Map<RigLabel, { codeFile: string, fingerprintFile: string }>()
    for (const label of [...KEYHOLDER_LABELS, ...VOTER_LABELS]) {
      const codeFile = join(secretsDir, `join-${label}.txt`)
      const fingerprintFile = join(secretsDir, `fingerprint-${label}.txt`)
      await step(`mint-${label}`, () => ok('officer', O.mint.verb, { [O.mint.args.networkHash]: networkHash, [O.mint.args.codeFile]: codeFile, [O.mint.args.fingerprintFile]: fingerprintFile }, { timeoutMs: 300_000 }))
      readSecretFileOnce(codeFile, true)
      readSecretFileOnce(fingerprintFile, true)
      codeFiles.set(label, { codeFile, fingerprintFile })
    }
    for (const kh of KEYHOLDER_LABELS) await step(`start-${kh}`, () => startPeer(kh))
    for (const kh of KEYHOLDER_LABELS) {
      const f = codeFiles.get(kh)!
      await step(`join-${kh}`, () => ok(kh, K.join.verb, { [K.join.args.codeFile]: f.codeFile, [K.join.args.expectName]: NETWORK_NAME, [K.join.args.expectFingerprintFile]: f.fingerprintFile, [K.join.args.networkHash]: networkHash, [K.join.args.tokenFile]: tokens[kh], [K.join.args.timeoutMs]: JOIN_TIMEOUT_MS }, { timeoutMs: 600_000 }))
    }
    const c = O.createElection
    const created = await step('create-election', () => ok('officer', c.verb, { [c.args.network]: networkHash, [c.args.tokenFile]: tokens.officer, [c.args.leadMs]: String(leadMs), [c.args.windowMs]: String(windowMs), [c.args.threshold]: '2', [c.args.keyholders]: 'kh-a,kh-b', [c.args.title]: 'vt30-election' }, { timeoutMs: 300_000 }))
    const electionId = String(created[c.reply.electionId])
    const votingStartsAt = Date.parse(String(created[c.reply.votingStartsAt]))
    const closedAt = Date.parse(String(created[c.reply.closedAt]))
    const releasingKeysAt = votingStartsAt + windowMs + RELEASING_KEYS_AFTER_ACCRUING_MS
    const seatFiles: [string, string] = ['', '']
    for (const kh of KEYHOLDER_LABELS) {
      const i = O.inviteKeyholder
      const r = await step(`invite-${kh}`, () => ok('officer', i.verb, { [i.args.network]: networkHash, [i.args.election]: electionId, [i.args.name]: kh, [i.args.tokenFile]: tokens.officer }, { timeoutMs: 300_000 }))
      const shareFile = String(r[i.reply.shareFile])
      const text = readSecretFileOnce(shareFile, true)
      const parsed = parseInviteShare(text)
      if (parsed !== undefined) registry.add(parsed.invitePrivate, { windows: true })
      seatFiles[kh === 'kh-a' ? 0 : 1] = shareFile
    }
    const b = O.ballotSubmit
    const ballot = await step('ballot-submit', () => ok('officer', b.verb, { [b.args.network]: networkHash, [b.args.election]: electionId, [b.args.tokenFile]: tokens.officer }, { timeoutMs: 300_000 }))
    const needleFile = String(ballot[b.reply.needleFile])
    readSecretFileOnce(needleFile, true)
    const ballotId = String(ballot[b.reply.ballotId])
    // an unsigned ballot reads unconfirmed on every voter (cast refuses ineligible:ballot-unconfirmed)
    const t = O.taskSign
    const signed = await step('task-sign', () => ok('officer', t.verb, { [t.args.network]: networkHash, [t.args.election]: electionId, [t.args.ballot]: ballotId, [t.args.waitMs]: '120000', [t.args.tokenFile]: tokens.officer }, { timeoutMs: 600_000 }))
    if (signed[t.reply.confirmed] !== true) throw new RigError('ballot-not-confirmed')
    await step('enable-intake', () => ok('officer', O.enableIntake.verb, { [O.enableIntake.args.authority]: authorityId8, [O.enableIntake.args.network]: networkHash, [O.enableIntake.args.tokenFile]: tokens.officer }, { timeoutMs: 300_000 }))
    // keyholders: accept, then the DKG in parallel
    for (const kh of KEYHOLDER_LABELS) await step(`accept-${kh}`, () => ok(kh, K.accept.verb, { [K.accept.args.network]: networkHash, [K.accept.args.shareFile]: seatFiles[kh === 'kh-a' ? 0 : 1], [K.accept.args.tokenFile]: tokens[kh] }, { timeoutMs: 600_000 }))
    await step('dkg', () => Promise.all(KEYHOLDER_LABELS.map((kh) => ok(kh, K.dkg.verb, { [K.dkg.args.network]: networkHash, [K.dkg.args.election]: electionId, [K.dkg.args.tokenFile]: tokens[kh] }, { timeoutMs: 1_000_000 }))))
    // voters: start, join, register
    for (const v of VOTER_LABELS) await step(`start-${v}`, () => startPeer(v))
    await step('join-voters', () => Promise.all(VOTER_LABELS.map((v) => {
      const f = codeFiles.get(v)!
      return ok(v, V.join.verb, { [V.join.args.codeFile]: f.codeFile, [V.join.args.expectFingerprintFile]: f.fingerprintFile, [V.join.args.tokenFile]: tokens[v] }, { timeoutMs: 900_000 })
    })))
    const registrantIds: Record<string, string> = {}
    await step('register-voters', () => Promise.all(VOTER_LABELS.map(async (v) => {
      const r = await ok(v, V.register.verb, { [V.register.args.network]: networkHash, [V.register.args.registrantFile]: registrantFile(v), [V.register.args.tokenFile]: tokens[v] }, { timeoutMs: 600_000 })
      registrantIds[v] = String(r[V.register.reply.registrantId])
    })))
    // the officer imports the three requests and approves them (the 67-29 ctl spec's order)
    const R = O.registrations
    await step('sync-registrations', () => officerSyncUntil(authorityId8, networkHash, async () => {
      const regs = await ok('officer', R.verb, { [R.args.authority]: authorityId8, [R.args.network]: networkHash })
      const rows = (regs[R.reply.rows] ?? []) as Array<{ requestId: string, status: string }>
      return VOTER_LABELS.every((v) => rows.some((row) => row.requestId === registrantIds[v] && row.status === 'p'))
    }, 300_000))
    for (const v of VOTER_LABELS) {
      const A = O.approve
      await step(`approve-${v}`, () => ok('officer', A.verb, { [A.args.authority]: authorityId8, [A.args.network]: networkHash, [A.args.request]: registrantIds[v]!, [A.args.checklist]: 'id', [A.args.tokenFile]: tokens.officer }, { timeoutMs: 300_000 }))
    }
    await step('stage-association', () => Promise.all(VOTER_LABELS.map((v) => ok(v, V.stageAssociation.verb, { [V.stageAssociation.args.network]: networkHash, [V.stageAssociation.args.tokenFile]: tokens[v] }, { timeoutMs: 600_000 }))))
    // the officer's sync issues the challenges while the voters wait for them
    await step('challenge', async () => {
      const loop = syncLoop(authorityId8, networkHash)
      try {
        await Promise.all(VOTER_LABELS.map((v) => ok(v, V.readDecision.verb, { [V.readDecision.args.network]: networkHash, [V.readDecision.args.waitFor]: 'challenge', [V.readDecision.args.waitMs]: '300000' }, { timeoutMs: 600_000 })))
      } finally {
        await loop.stop()
      }
    })
    await step('answer-challenge', () => Promise.all(VOTER_LABELS.map((v) => ok(v, V.answerChallenge.verb, { [V.answerChallenge.args.network]: networkHash, [V.answerChallenge.args.waitMs]: '300000', [V.answerChallenge.args.tokenFile]: tokens[v] }, { timeoutMs: 600_000 }))))
    await step('associate', async () => {
      const loop = syncLoop(authorityId8, networkHash)
      try {
        const reads = await Promise.all(VOTER_LABELS.map((v) => ok(v, V.readDecision.verb, { [V.readDecision.args.network]: networkHash, [V.readDecision.args.waitFor]: 'registered', [V.readDecision.args.waitMs]: '600000' }, { timeoutMs: 900_000 })))
        for (const r of reads) if (r[V.readDecision.reply.status] !== 'registered') throw new RigError('not-registered', String(r[V.readDecision.reply.status]))
      } finally {
        await loop.stop()
      }
    })
    election = { networkHash, authorityId8, electionId, ballotId, needleFile, seatFiles, votingStartsAt, releasingKeysAt, closedAt, registrantIds }
    return election
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
  const scanOutputs = (): SecretScan => {
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

  const scanPeersAndLogs = (reg: SecretRegistry): SecretScan => {
    const scanDir = join(dir, `scan-${++scanN}`)
    mkdirSync(scanDir, { mode: 0o700 })
    let total: SecretScan = { whole: 0, windows: 0, files: 0 }
    for (const label of RIG_LABELS) {
      const pd = peerDir(label)
      if (!existsSync(pd)) continue
      // the daemon's own 0600 credential file is the one place its ctl token belongs
      copyInto(scanDir, pd, (n) => n !== CTL_TOKEN_FILE, label)
      copyInto(scanDir, join(pd, 'node'), () => true, `${label}-node`)
      const vault = join(pd, 'vault')
      if (existsSync(vault)) total = sum(total, scanSecrets(vault, reg))
    }
    total = sum(total, scanSecrets(scanDir, reg))
    total = sum(total, scanSecrets(logsDir, reg))
    return total
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
    get election() {
      return election
    },
    peerDir,
    roleOf,
    isLive: (label) => procs.has(label),
    startPeer,
    stopPeer,
    call,
    ok,
    refused,
    step,
    setupVotingElection,
    scanOutputs,
    scanPeersAndLogs,
    close
  }
}
