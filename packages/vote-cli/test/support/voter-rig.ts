// The voter rig for the host-tier ctl specs (67-29 Task 3): ONE officer daemon in the chosen posture plus at
// most ONE voter daemon alive at a time, on the loopback relay, driven through the bin's own command path
// (`runRoleCommand`, so 67-26's client-side approval transport is on the path). Every officer step goes
// through the officer's ctl with the verb and flag names the 67-24/67-26/67-27 SUMMARYs fixed (the
// OFFICER_CALLS adapter below is the one place they are spelled). Nothing here prints a token, a code, a
// fingerprint, a registrant value, a reason, a multiaddr or a full peer id; each successful call appends
// `VERB-MS <verb> <result.ms> <reply ms>` (names and numbers only) to `${TMPDIR}/67-29/verb-ms.txt`.

import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeApprovalTokenFile } from '../../src/approval/token.js'
import { runRoleCommand } from '../../src/ctl/commands.js'
import type { Role } from '../../src/ctl/protocol.js'
import { PEER_FILES } from '../../src/node/peer-layout.js'
import { relayPeerIdOf } from '../../src/node/relay-readiness.js'
import { SecretRegistry } from '../../src/secrecy/redact.js'
import { scanSecrets, type SecretScan } from '../../src/secrecy/scan-secrets.js'
import { readTokenOnce, startDaemon, type DaemonProc } from './daemon-fixture.js'
import { startLoopbackRelay, type LoopbackRelay } from './loopback-relay.js'

export const REPO_ROOT = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)))
export const VERB_MS_DIR = join(process.env.TMPDIR ?? tmpdir(), '67-29')
export const VERB_MS_FILE = join(VERB_MS_DIR, 'verb-ms.txt')
export const POSTURE_FLAG = '--accept-token-attestations'
/** Registration has to finish before registration ends: a long lead is deliberate. */
export const ELECTION_LEAD_MS = 1_800_000
export const ELECTION_WINDOW_MS = 480_000
const CTL_TIMEOUT_MS = 900_000
const SYNC_EVERY_MS = 5_000

/** The officer verb and flag names this rig drives (from the 67-24 / 67-26 / 67-27 SUMMARYs). */
export const OFFICER_CALLS = Object.freeze({
  found: { verb: 'found', name: '--name', token: '--token-file' },
  ownerSetup: { verb: 'owner-setup' },
  authorityId: { verb: 'authority-id', networkHash: '--network-hash' },
  mint: { verb: 'mint', networkHash: '--network-hash', codeFile: '--code-file', fingerprintFile: '--fingerprint-file' },
  createElection: { verb: 'create-election', network: '--network', leadMs: '--lead-ms', windowMs: '--window-ms', token: '--token-file' },
  enableIntake: { verb: 'enable-intake', authority: '--authority', network: '--network', token: '--token-file' },
  peerSync: { verb: 'peer-sync', authority: '--authority', network: '--network', token: '--token-file' },
  approve: { verb: 'approve', authority: '--authority', network: '--network', request: '--request', checklist: '--checklist', token: '--token-file' },
  refuse: { verb: 'refuse', authority: '--authority', network: '--network', request: '--request', checklist: '--checklist', reasonFile: '--reason-file', token: '--token-file' },
  registrations: { verb: 'registrations', authority: '--authority', network: '--network' },
  readback: { verb: 'readback' }
})

export type OfficerPosture = 'token' | 'production'

export interface CallResult {
  exit: number
  /** The whole `--json` reply line (`{ ok, result, ms }` or `{ ok: false, error }`), when one was printed. */
  body: Record<string, unknown> | undefined
  result: Record<string, unknown>
  error: { name?: string, code?: string, message?: string } | undefined
  out: string
  err: string
}

export interface OfficerSetup {
  networkHash: string
  authorityId: string
  electionId: string
  codeFiles: string[]
  fingerprintFiles: string[]
}

export interface PeerSyncBody {
  imported: number
  pending: number
  errors: number
  associations: { before: number, after: number }
  challenges: number
  refusals: string[]
  attestation: { posture: string }
  [k: string]: unknown
}

export interface VoterRig {
  readonly runDir: string
  readonly party: string
  readonly secretsDir: string
  readonly logsDir: string
  readonly relay: LoopbackRelay
  readonly registry: SecretRegistry
  readonly officerPosture: OfficerPosture
  readonly officerToken: string
  readonly wrongToken: string
  voterToken(label: string): string
  registrantFile(label: string): string
  readonly reasonFile: string
  /** A 0600 fingerprint file that matches no code of this run. */
  readonly wrongFingerprintFile: string
  peerDir(label: string): string
  call(role: Role, label: string, verb: string, flags: readonly string[], env?: Record<string, string>): Promise<CallResult>
  startOfficer(): Promise<DaemonProc>
  startVoter(label: string): Promise<DaemonProc>
  stopVoter(label: string): Promise<number | null>
  restartVoter(label: string): Promise<DaemonProc>
  setupOfficer(voterLabels: readonly string[]): Promise<OfficerSetup>
  officerSyncUntil(pred: (sync: PeerSyncBody, rounds: number) => boolean | Promise<boolean>, boundMs: number): Promise<{ body: PeerSyncBody, rounds: number }>
  /** The officer's `registrations` reply. */
  registrations(): Promise<Record<string, unknown>>
  /** Every live daemon's handle, by label. */
  readonly daemons: ReadonlyMap<string, DaemonProc>
  /** High-water mark of daemons alive at once. */
  readonly peerHighWater: number
  readonly captured: string[]
  scan(): SecretScan & { copied: number }
  close(): Promise<void>
}

export interface StartVoterRigOptions {
  party: string
  officerPosture: OfficerPosture
}

const HASH_RE = /^[0-9a-f]{32}$/
const ID8_RE = /^[0-9a-f]{8}$/

function requireOutsideRepo(dir: string): void {
  const real = realpathSync(dir)
  if (real === REPO_ROOT || real.startsWith(REPO_ROOT + '/')) throw new Error('voter rig: the run dir must be outside the repo')
}

export async function startVoterRig(opts: StartVoterRigOptions): Promise<VoterRig> {
  const { party, officerPosture } = opts
  mkdirSync(VERB_MS_DIR, { recursive: true, mode: 0o700 })
  const runDir = mkdtempSync(join(tmpdir(), 'vt-29-'))
  chmodSync(runDir, 0o700)
  requireOutsideRepo(runDir)
  const secretsDir = join(runDir, 'secrets')
  mkdirSync(secretsDir, { mode: 0o700 })
  const logsDir = join(runDir, 'logs')
  mkdirSync(logsDir, { mode: 0o700 })
  mkdirSync(join(runDir, party), { mode: 0o700 })
  const registry = new SecretRegistry()
  const captured: string[] = []

  const officerToken = join(secretsDir, 'officer.token')
  const wrongToken = join(secretsDir, 'wrong.token')
  writeApprovalTokenFile(officerToken)
  writeApprovalTokenFile(wrongToken)
  const voterTokens = new Map<string, string>()
  const registrantFiles = new Map<string, string>()
  const voterToken = (label: string): string => {
    let p = voterTokens.get(label)
    if (p === undefined) {
      p = join(secretsDir, `${label}.token`)
      writeApprovalTokenFile(p)
      registry.add(readFileSync(p, 'utf8').trim(), { windows: true })
      voterTokens.set(label, p)
    }
    return p
  }
  const registrantFile = (label: string): string => {
    let p = registrantFiles.get(label)
    if (p === undefined) {
      p = join(secretsDir, `${label}.registrant.json`)
      const n = label.replace(/[^0-9]/g, '') || '1'
      const email = `voter${n}-${randomBytes(4).toString('hex')}@example.invalid`
      const dob = '1990-01-01'
      writeFileSync(p, JSON.stringify({ firstName: 'Vtcli', lastName: `Voter${n}`, email, dob }), { mode: 0o600 })
      chmodSync(p, 0o600)
      registry.add(email, { windows: true })
      registrantFiles.set(label, p)
    }
    return p
  }
  for (const t of [officerToken, wrongToken]) registry.add(readFileSync(t, 'utf8').trim(), { windows: true })
  const reasonFile = join(secretsDir, 'reason.txt')
  const reason = 'synthetic refusal reason ' + randomBytes(8).toString('hex')
  writeFileSync(reasonFile, `${reason}\n`, { mode: 0o600 })
  chmodSync(reasonFile, 0o600)
  registry.add(reason, { windows: true })
  // Every code minted for ONE network shares the founding-bundle fingerprint, so a wrong one is made here.
  const wrongFingerprintFile = join(secretsDir, 'wrong.fp')
  const wrongFingerprint = `${randomBytes(2).toString('hex')} ${randomBytes(2).toString('hex')} ${randomBytes(2).toString('hex')} ${randomBytes(2).toString('hex')}`
  writeFileSync(wrongFingerprintFile, `${wrongFingerprint}\n`, { mode: 0o600 })
  chmodSync(wrongFingerprintFile, 0o600)
  registry.add(wrongFingerprint, { windows: true })

  const relay = await startLoopbackRelay()
  registry.add(relay.multiaddr)
  registry.add(relayPeerIdOf(relay.multiaddr))

  const daemons = new Map<string, DaemonProc>()
  let highWater = 0
  const peerDir = (label: string): string => join(runDir, party, label)
  const repliesPath = join(logsDir, 'ctl-replies.jsonl')

  const recordMs = (verb: string, r: CallResult): void => {
    const ms = r.result.ms
    const replyMs = r.body?.ms
    if (typeof ms === 'number' && typeof replyMs === 'number') appendFileSync(VERB_MS_FILE, `VERB-MS ${verb} ${Math.round(ms)} ${Math.round(replyMs)}\n`, { mode: 0o600 })
  }

  const call = async (role: Role, label: string, verb: string, flags: readonly string[], env: Record<string, string> = {}): Promise<CallResult> => {
    let out = ''
    let err = ''
    const io = { out: (t: string) => { out += t }, err: (t: string) => { err += t } }
    const exit = await runRoleCommand([role, verb, '--peer', peerDir(label), '--json', '--timeout-ms', String(CTL_TIMEOUT_MS), ...flags], io, { env: { ...process.env, ...env } })
    const line = out.split('\n').find((l) => l.startsWith('{'))
    let body: Record<string, unknown> | undefined
    if (line !== undefined) {
      try {
        body = JSON.parse(line) as Record<string, unknown>
      } catch {
        body = undefined
      }
    }
    const result = (body?.result ?? {}) as Record<string, unknown>
    const error = body?.error as CallResult['error']
    appendFileSync(repliesPath, JSON.stringify({ role, label, verb, exit, body: body ?? null, err }) + '\n', { mode: 0o600 })
    captured.push(out, err)
    const r: CallResult = { exit, body, result, error, out, err }
    if (exit === 0) recordMs(verb, r)
    return r
  }

  const track = (label: string, d: DaemonProc): DaemonProc => {
    daemons.set(label, d)
    const alive = [...daemons.values()].filter((x) => !x.exited()).length
    if (alive > highWater) highWater = alive
    return d
  }

  const startOfficer = async (): Promise<DaemonProc> => {
    const extra = officerPosture === 'token' ? [POSTURE_FLAG] : []
    const d = track('officer', await startDaemon({ role: 'officer', peerDir: peerDir('officer'), relayEnvPath: relay.relayEnvPath, party, extra, logDir: logsDir }))
    if (!d.ready) throw new Error(`officer boot failed: ${d.bootFailedToken ?? 'no token'} exit=${String(d.exitCode())}`)
    registry.add(readTokenOnce(peerDir('officer')), { windows: true })
    return d
  }
  const startVoter = async (label: string): Promise<DaemonProc> => {
    const d = track(label, await startDaemon({ role: 'voter', peerDir: peerDir(label), relayEnvPath: relay.relayEnvPath, party, logDir: logsDir }))
    if (!d.ready) throw new Error(`voter ${label} boot failed: ${d.bootFailedToken ?? 'no token'} exit=${String(d.exitCode())}`)
    registry.add(readTokenOnce(peerDir(label)), { windows: true })
    return d
  }
  const stopVoter = async (label: string): Promise<number | null> => {
    const d = daemons.get(label)
    if (d === undefined) return null
    await d.stop()
    const code = await d.waitExit(30_000)
    daemons.delete(label)
    return code
  }
  const restartVoter = async (label: string): Promise<DaemonProc> => {
    const code = await stopVoter(label)
    if (code !== 0) throw new Error(`voter ${label} did not stop cleanly: ${String(code)}`)
    return startVoter(label)
  }

  const okCall = async (role: Role, label: string, verb: string, flags: readonly string[]): Promise<Record<string, unknown>> => {
    const r = await call(role, label, verb, flags)
    if (r.exit !== 0) throw new Error(`${role} ${verb} failed: exit ${r.exit} ${r.error?.code ?? ''} ${r.err.slice(0, 200)}`)
    return r.result
  }

  let setup: OfficerSetup | undefined
  const setupOfficer = async (voterLabels: readonly string[]): Promise<OfficerSetup> => {
    const C = OFFICER_CALLS
    const found = await okCall('officer', 'officer', C.found.verb, [C.found.name, 'T29 Net', C.found.token, officerToken])
    const networkHash = String(found.networkHash)
    if (!HASH_RE.test(networkHash)) throw new Error('found: no network hash')
    await okCall('officer', 'officer', C.ownerSetup.verb, [])
    const aid = await okCall('officer', 'officer', C.authorityId.verb, [C.authorityId.networkHash, networkHash])
    const authorityId = String(aid.authorityId8)
    if (!ID8_RE.test(authorityId)) throw new Error('authority-id: no id')
    const codeFiles: string[] = []
    const fingerprintFiles: string[] = []
    for (const label of voterLabels) {
      const codeFile = join(secretsDir, `${label}.code`)
      const fingerprintFile = join(secretsDir, `${label}.fp`)
      await okCall('officer', 'officer', C.mint.verb, [C.mint.networkHash, networkHash, C.mint.codeFile, codeFile, C.mint.fingerprintFile, fingerprintFile])
      registry.add(readFileSync(codeFile, 'utf8').trim(), { windows: true })
      registry.add(readFileSync(fingerprintFile, 'utf8').trim(), { windows: true })
      codeFiles.push(codeFile)
      fingerprintFiles.push(fingerprintFile)
    }
    const election = await okCall('officer', 'officer', C.createElection.verb, [C.createElection.network, networkHash, C.createElection.leadMs, String(ELECTION_LEAD_MS), C.createElection.windowMs, String(ELECTION_WINDOW_MS), C.createElection.token, officerToken])
    const electionId = String(election.electionId)
    await okCall('officer', 'officer', C.enableIntake.verb, [C.enableIntake.authority, authorityId, C.enableIntake.network, networkHash, C.enableIntake.token, officerToken])
    setup = { networkHash, authorityId, electionId, codeFiles, fingerprintFiles }
    return setup
  }

  const registrations = async (): Promise<Record<string, unknown>> => {
    if (setup === undefined) throw new Error('setupOfficer first')
    const C = OFFICER_CALLS.registrations
    return okCall('officer', 'officer', C.verb, [C.authority, setup.authorityId, C.network, setup.networkHash])
  }

  const officerSyncUntil = async (pred: (sync: PeerSyncBody, rounds: number) => boolean | Promise<boolean>, boundMs: number): Promise<{ body: PeerSyncBody, rounds: number }> => {
    if (setup === undefined) throw new Error('setupOfficer first')
    const C = OFFICER_CALLS.peerSync
    const deadline = Date.now() + boundMs
    let rounds = 0
    for (;;) {
      rounds++
      const body = (await okCall('officer', 'officer', C.verb, [C.authority, setup.authorityId, C.network, setup.networkHash, C.token, officerToken])) as unknown as PeerSyncBody
      if (await pred(body, rounds)) return { body, rounds }
      if (Date.now() >= deadline) return { body, rounds }
      await new Promise((r) => setTimeout(r, SYNC_EVERY_MS))
    }
  }

  const scan = (): SecretScan & { copied: number } => {
    const scanDir = join(runDir, 'scan')
    rmSync(scanDir, { recursive: true, force: true })
    mkdirSync(scanDir, { mode: 0o700 })
    let copied = 0
    const copyOutputs = (dir: string): void => {
      if (!existsSync(dir)) return
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (!f.isFile()) continue
        // daemon output and records: logs, the daemon/boot/crash records, the replies; stored state (node/, vault/, secrets/) is not output
        if (f.name.endsWith('.log') || f.name.endsWith('.jsonl') || f.name.endsWith('.json') || f.name === PEER_FILES.ctlPort) {
          copyFileSync(join(dir, f.name), join(scanDir, `${basename(dir)}-${f.name}`))
          copied++
        }
      }
    }
    copyOutputs(logsDir)
    for (const label of readdirSync(join(runDir, party))) copyOutputs(join(runDir, party, label))
    writeFileSync(join(scanDir, 'captured.txt'), captured.join('\n'), { mode: 0o600 })
    copied++
    const result = scanSecrets(scanDir, registry)
    return { ...result, copied }
  }

  const close = async (): Promise<void> => {
    for (const [label, d] of daemons) {
      await d.stop().catch(() => undefined)
      daemons.delete(label)
    }
    await relay.stop().catch(() => undefined)
    if (process.env.VT_KEEP_RUN !== '1') {
      rmSync(runDir, { recursive: true, force: true })
      rmSync(relay.dir, { recursive: true, force: true })
    }
  }

  return {
    runDir,
    party,
    secretsDir,
    logsDir,
    relay,
    registry,
    officerPosture,
    officerToken,
    wrongToken,
    voterToken,
    registrantFile,
    reasonFile,
    wrongFingerprintFile,
    peerDir,
    call,
    startOfficer,
    startVoter,
    stopVoter,
    restartVoter,
    setupOfficer,
    officerSyncUntil,
    registrations,
    daemons,
    get peerHighWater() {
      return highWater
    },
    captured,
    scan,
    close
  }
}
