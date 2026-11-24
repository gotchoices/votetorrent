// officer-intake-ctl.spec.ts (67-27 Task 3): the five officer intake verbs through a REAL officer daemon's
// ctl endpoint on the loopback relay, driven by the bin's own command path (`runRoleCommand`, so 67-26's
// client-side approval transport is on the path), plus the production-party start refusal and the
// secret scan. Gated by VT_HOST_TIER=1 like every loopback spec of this package; at most two daemons are
// alive at once. Nothing here prints a token, a reason, a multiaddr or a full peer id; successful verbs
// append `VERB-MS <verb> <result.ms> <reply ms>` to `${TMPDIR}/67-27/verb-ms.txt` (names and numbers only).
//
// The approve/refuse HAPPY path needs a pending registration staged by a voter (67-29's verbs); here they
// are proven on every daemon-side refusal, and their happy path against the real 67-18 functions is the
// unit spec's A6/R1 (see the 67-27 SUMMARY).

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { APPROVAL_TOKEN_ENV } from '../src/approval/token.js'
import { writeApprovalTokenFile } from '../src/approval/token.js'
import { callCtl } from '../src/ctl/ctl-client.js'
import { runRoleCommand } from '../src/ctl/commands.js'
import { CTL_PORT_FILE } from '../src/ctl/protocol.js'
import { PEER_FILES } from '../src/node/peer-layout.js'
import { relayPeerIdOf } from '../src/node/relay-readiness.js'
import { SecretRegistry } from '../src/secrecy/redact.js'
import { scanSecrets } from '../src/secrecy/scan-secrets.js'
import { readTokenOnce, startDaemon, type DaemonProc } from './support/daemon-fixture.js'
import { hostTierEnabled } from './support/host-tier.js'
import { startLoopbackRelay, type LoopbackRelay } from './support/loopback-relay.js'

const HASH_RE = /^[0-9a-f]{32}$/
const ID8_RE = /^[0-9a-f]{8}$/
const POSTURE_FLAG = '--accept-token-attestations'
const VERB_MS_DIR = join(process.env.TMPDIR ?? tmpdir(), '67-27')
const VERB_MS_FILE = join(VERB_MS_DIR, 'verb-ms.txt')

interface CliResult {
  code: number
  out: string
  err: string
  body?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { name?: string, code?: string, message?: string }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('officer intake ctl', function () {
  this.timeout(1_800_000)
  let relay: LoopbackRelay
  let root: string
  let party: string
  let secretsDir: string
  let logs: string
  let tokenA = ''
  let tokenB = ''
  let wrongToken = ''
  let reasonFile = ''
  let A: DaemonProc
  let H = ''
  let AID8 = ''
  let failed = false
  const live: DaemonProc[] = []
  const replies: string[] = []
  const REASON = 'SECRET-MARKER-reason-' + randomBytes(8).toString('hex')
  const dirA = (): string => join(root, party, 'officer-a')

  const track = (d: DaemonProc): DaemonProc => {
    live.push(d)
    return d
  }

  const recordMs = (verb: string, r: CliResult): void => {
    const ms = r.result?.ms
    const replyMs = r.body?.ms
    if (typeof ms === 'number' && typeof replyMs === 'number') appendFileSync(VERB_MS_FILE, `VERB-MS ${verb} ${ms} ${replyMs}\n`, { mode: 0o600 })
  }

  /** The bin's own command path: `vt officer <verb> --peer <dir> --json <flags>`. */
  const cli = async (dir: string, verb: string, flags: readonly string[], env: Record<string, string> = {}): Promise<CliResult> => {
    let out = ''
    let err = ''
    const io = { out: (t: string) => { out += t }, err: (t: string) => { err += t } }
    const code = await runRoleCommand(['officer', verb, '--peer', dir, '--json', '--timeout-ms', '600000', ...flags], io, { env: { ...process.env, ...env } })
    const r: CliResult = { code, out, err }
    const line = out.split('\n').find((l) => l.startsWith('{'))
    if (line !== undefined) {
      r.body = JSON.parse(line) as Record<string, unknown>
      r.result = (r.body.result ?? undefined) as Record<string, unknown> | undefined
      r.error = (r.body.error ?? undefined) as CliResult['error']
    }
    replies.push(out, err)
    if (code === 0) recordMs(verb, r)
    return r
  }
  const okCli = async (dir: string, verb: string, flags: readonly string[], env?: Record<string, string>): Promise<Record<string, unknown>> => {
    const r = await cli(dir, verb, flags, env)
    expect(r.code, `${verb}: ${r.err.slice(0, 300)}`).to.equal(0)
    return r.result ?? {}
  }
  const refusedCli = async (dir: string, verb: string, flags: readonly string[], code: string, env?: Record<string, string>): Promise<CliResult> => {
    const r = await cli(dir, verb, flags, env)
    expect(r.code, `${verb}: expected a refusal, got ${r.out.slice(0, 300)}`).to.equal(1)
    expect(r.error?.code, `${verb}: ${r.err.slice(0, 300)}`).to.equal(code)
    expect(String(r.error?.message ?? '').length).to.be.at.most(200)
    return r
  }
  const common = (): string[] => ['--authority', AID8, '--network', H]
  const registrations = (): Promise<Record<string, unknown>> => okCli(dirA(), 'registrations', common())

  before(async function () {
    this.timeout(900_000)
    if (!hostTierEnabled()) this.skip()
    mkdirSync(VERB_MS_DIR, { recursive: true, mode: 0o700 })
    root = mkdtempSync(join(tmpdir(), 'vt-27c-'))
    chmodSync(root, 0o700)
    party = 'vt27-' + randomBytes(4).toString('hex')
    secretsDir = join(root, 'secrets')
    mkdirSync(secretsDir, { mode: 0o700 })
    logs = join(root, 'logs')
    mkdirSync(logs, { mode: 0o700 })
    mkdirSync(join(root, party), { mode: 0o700 })
    tokenA = join(secretsDir, 'officer-a.token')
    tokenB = join(secretsDir, 'officer-b.token')
    wrongToken = join(secretsDir, 'wrong.token')
    writeApprovalTokenFile(tokenA)
    writeApprovalTokenFile(tokenB)
    writeApprovalTokenFile(wrongToken)
    reasonFile = join(secretsDir, 'reason.txt')
    writeFileSync(reasonFile, `${REASON}\n`, { mode: 0o600 })
    relay = await startLoopbackRelay()
    A = track(await startDaemon({ role: 'officer', peerDir: dirA(), relayEnvPath: relay.relayEnvPath, party, extra: [POSTURE_FLAG], logDir: logs }))
    expect(A.ready, `officer-a boot failed: ${A.bootFailedToken ?? 'no token'} exit=${String(A.exitCode())}`).to.equal(true)
    const found = await callCtl({ dir: dirA(), role: 'officer', verb: 'found', args: { name: 'T27 Net', tokenFile: tokenA }, timeoutMs: 600_000 })
    replies.push(JSON.stringify(found))
    expect(found.status, JSON.stringify(found.body.error ?? {})).to.equal(200)
    H = String(found.body.result?.networkHash)
    expect(H).to.match(HASH_RE)
    expect(found.body.result?.posture).to.equal('test')
    const aid = await callCtl({ dir: dirA(), role: 'officer', verb: 'authority-id', args: { networkHash: H } })
    replies.push(JSON.stringify(aid))
    AID8 = String(aid.body.result?.authorityId8)
    expect(AID8).to.match(ID8_RE)
    console.log(`      found createMs=${String(found.body.result?.createMs)}`)
  })

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true
  })

  after(async function () {
    this.timeout(300_000)
    for (const d of live) await d.stop().catch(() => undefined)
    if (relay !== undefined) await relay.stop()
    if (!failed && root !== undefined) rmSync(root, { recursive: true, force: true })
    if (relay !== undefined) rmSync(relay.dir, { recursive: true, force: true })
  })

  it('K1 registrations on a fresh token-posture officer: posture token, no rows, intake not enabled', async function () {
    this.timeout(300_000)
    const r = await registrations()
    expect(r.posture).to.equal('token')
    expect(r.rows).to.deep.equal([])
    expect((r.counts as { pending: number }).pending).to.equal(0)
    expect(r.intake).to.equal('not-enabled')
    expect(r.attestationRows).to.deep.equal({ elections: 0, skipping: 0 })
    expect(Object.keys(r).sort()).to.deep.equal(['attestationRows', 'counts', 'intake', 'ms', 'posture', 'rows', 'truncated'])
    console.log(`      registrations ms=${String(r.ms)}`)
  })

  it('K2 enable-intake: token-absent, token-refused (still not enabled), a relative --token-file enables, --token-env repeats as changed false', async function () {
    this.timeout(600_000)
    await refusedCli(dirA(), 'enable-intake', common(), 'token-absent')
    await refusedCli(dirA(), 'enable-intake', [...common(), '--token-file', wrongToken], 'token-refused')
    expect((await registrations()).intake).to.equal('not-enabled')
    const rel = relative(process.cwd(), tokenA)
    expect(rel.startsWith('/')).to.equal(false)
    const first = await okCli(dirA(), 'enable-intake', [...common(), '--token-file', rel])
    expect(first.state).to.equal('enabled')
    expect(first.changed).to.equal(true)
    console.log(`      enable-intake ms=${String(first.ms)}`)
    const tokenText = readFileSync(tokenA, 'utf8').trim()
    const second = await okCli(dirA(), 'enable-intake', [...common(), '--token-env'], { [APPROVAL_TOKEN_ENV]: tokenText })
    expect(second.state).to.equal('enabled')
    expect(second.changed).to.equal(false)
    expect((await registrations()).intake).to.equal('enabled')
  })

  it('K3 peer-sync with the token and without: exit 0, no errors, no refusals, posture token', async function () {
    this.timeout(600_000)
    const withToken = await okCli(dirA(), 'peer-sync', [...common(), '--token-file', tokenA])
    expect(Number(withToken.imported)).to.be.at.least(0)
    expect(withToken.errors).to.equal(0)
    expect(withToken.refusals).to.deep.equal([])
    expect((withToken.attestation as { posture: string }).posture).to.equal('token')
    expect(withToken.signingRefused).to.equal(0)
    console.log(`      peer-sync(token) ms=${String(withToken.ms)}`)
    const unattended = await okCli(dirA(), 'peer-sync', common())
    expect(unattended.errors).to.equal(0)
    expect(unattended.refusals).to.deep.equal([])
    console.log(`      peer-sync(no token) ms=${String(unattended.ms)}`)
    const rb = await callCtl({ dir: dirA(), role: 'officer', verb: 'readback', args: {} })
    replies.push(JSON.stringify(rb))
    expect(rb.status).to.equal(200)
    console.log(`      RSS officer-a-after-intake=${String(rb.body.result?.rssMb)}MB acceptTokenAttestations=${String(rb.body.result?.acceptTokenAttestations)}`)
  })

  it('K4 approve refusals through the daemon: the D-07 gate, the vocabulary, token presence, the wrong token, an unknown request', async function () {
    this.timeout(600_000)
    const before = (await registrations()).counts
    const req = ['--request', 'req-' + randomBytes(6).toString('hex')]
    await refusedCli(dirA(), 'approve', [...common(), ...req, '--checklist', 'none,id'], 'checklist-incomplete')
    await refusedCli(dirA(), 'approve', [...common(), ...req, '--checklist', 'addr', '--token-file', tokenA], 'checklist-invalid')
    await refusedCli(dirA(), 'approve', [...common(), ...req, '--checklist', 'id'], 'token-absent')
    const ambiguous = await cli(dirA(), 'approve', [...common(), ...req, '--checklist', 'id', '--token-file', tokenA, '--token-env'], { [APPROVAL_TOKEN_ENV]: readFileSync(tokenA, 'utf8').trim() })
    expect(ambiguous.code).to.equal(1)
    expect(ambiguous.err).to.include('token-ambiguous')
    expect(ambiguous.body).to.equal(undefined)
    await refusedCli(dirA(), 'approve', [...common(), ...req, '--checklist', 'id', '--token-file', wrongToken], 'token-refused')
    await refusedCli(dirA(), 'approve', [...common(), ...req, '--checklist', 'id', '--token-file', tokenA], 'request-not-found')
    expect((await registrations()).counts).to.deep.equal(before)
  })

  it('K5 refuse refusals through the daemon: reason-required, the gate before the reason, the wrong token, an unknown request; the reason never appears', async function () {
    this.timeout(600_000)
    const req = ['--request', 'req-' + randomBytes(6).toString('hex')]
    await refusedCli(dirA(), 'refuse', [...common(), ...req, '--checklist', 'id', '--token-file', tokenA], 'reason-required')
    await refusedCli(dirA(), 'refuse', [...common(), ...req, '--checklist', 'none,id', '--reason-file', reasonFile], 'checklist-incomplete')
    await refusedCli(dirA(), 'refuse', [...common(), ...req, '--checklist', 'id', '--reason-file', reasonFile, '--token-file', wrongToken], 'token-refused')
    await refusedCli(dirA(), 'refuse', [...common(), ...req, '--checklist', 'id', '--reason-file', reasonFile, '--token-file', tokenA], 'request-not-found')
    expect(replies.join('\n')).to.not.include(REASON)
    expect(A.stdoutText()).to.not.include(REASON)
  })

  it('K6 the production party refuses the posture flag at start (no node, no ctl.port); a bare start elsewhere reads posture production', async function () {
    this.timeout(900_000)
    const prodDir = join(root, 'votetorrent', 'officer-p')
    mkdirSync(join(root, 'votetorrent'), { mode: 0o700 })
    const P = await startDaemon({ role: 'officer', peerDir: prodDir, relayEnvPath: relay.relayEnvPath, party: 'votetorrent', extra: [POSTURE_FLAG], logDir: logs, bootBoundMs: 60_000 })
    expect(P.ready).to.equal(false)
    expect(P.bootFailedToken).to.equal('production-party')
    expect(await P.waitExit(30_000)).to.equal(2)
    expect(readFileSync(P.stderrPath, 'utf8')).to.include('production-party')
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      expect(existsSync(join(prodDir, CTL_PORT_FILE))).to.equal(false)
      await sleep(500)
    }
    expect(existsSync(join(prodDir, PEER_FILES.node))).to.equal(false)
    // a bare start on another fresh party is the production posture: its registrations say so
    const partyB = 'vt27-' + randomBytes(4).toString('hex')
    mkdirSync(join(root, partyB), { mode: 0o700 })
    const dirB = join(root, partyB, 'officer-b')
    const B = track(await startDaemon({ role: 'officer', peerDir: dirB, relayEnvPath: relay.relayEnvPath, party: partyB, logDir: logs }))
    expect(B.ready, `officer-b boot failed: ${B.bootFailedToken ?? 'no token'}`).to.equal(true)
    const found = await callCtl({ dir: dirB, role: 'officer', verb: 'found', args: { name: 'T27 Prod Net', tokenFile: tokenB }, timeoutMs: 600_000 })
    replies.push(JSON.stringify(found))
    expect(found.status, JSON.stringify(found.body.error ?? {})).to.equal(200)
    const hB = String(found.body.result?.networkHash)
    const aidB = await callCtl({ dir: dirB, role: 'officer', verb: 'authority-id', args: { networkHash: hB } })
    replies.push(JSON.stringify(aidB))
    const r = await okCli(dirB, 'registrations', ['--authority', String(aidB.body.result?.authorityId8), '--network', hB])
    expect(r.posture).to.equal('production')
    await B.stop()
    expect(await B.waitExit(30_000)).to.equal(0)
  })

  it('K7 no reply or daemon log holds a token, the reason, a ctl token or the relay address', async function () {
    this.timeout(300_000)
    const scan = join(root, 'scan')
    mkdirSync(scan, { mode: 0o700 })
    let copied = 0
    const copyLogs = (dir: string): void => {
      if (!existsSync(dir)) return
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isFile() && (f.name.endsWith('.log') || f.name.endsWith('.jsonl'))) {
          copyFileSync(join(dir, f.name), join(scan, `${basename(dir)}-${f.name}`))
          copied++
        }
      }
    }
    copyLogs(logs)
    for (const p of readdirSync(join(root, party))) copyLogs(join(root, party, p))
    writeFileSync(join(scan, 'replies.txt'), replies.join('\n'), { mode: 0o600 })
    expect(copied).to.be.at.least(2)
    const registry = new SecretRegistry()
    for (const f of [tokenA, tokenB, wrongToken, reasonFile]) registry.add(readFileSync(f, 'utf8').trim(), { windows: true })
    if (existsSync(join(dirA(), PEER_FILES.ctlToken))) registry.add(readTokenOnce(dirA()), { windows: true })
    registry.add(relay.multiaddr)
    registry.add(relayPeerIdOf(relay.multiaddr))
    expect(registry.size).to.be.at.least(6)
    const result = scanSecrets(scan, registry)
    console.log(`      scan files=${result.files} whole=${result.whole} windows=${result.windows}`)
    expect(result.files).to.be.at.least(1)
    expect(result.whole).to.equal(0)
    expect(result.windows).to.equal(0)
    const msLines = readFileSync(VERB_MS_FILE, 'utf8')
    expect(msLines).to.match(/^VERB-MS registrations \d+ \d+$/m)
    expect(msLines).to.match(/^VERB-MS enable-intake \d+ \d+$/m)
    expect(msLines).to.match(/^VERB-MS peer-sync \d+ \d+$/m)
  })
})
