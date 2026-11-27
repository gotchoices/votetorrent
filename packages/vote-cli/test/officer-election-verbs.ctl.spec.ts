// officer-election-verbs.ctl.spec.ts: the five officer election verbs against ONE real officer daemon
// (the built vt bin, a real CadreNode) on the loopback relay, driven through the `vt officer <verb>`
// command table so the client-side token transport (--token-file / --token-env / --token-stdin) is on
// the path. Gated by VT_HOST_TIER=1 (test/support/host-tier.ts). The seat shares and the ballot needle
// land only in 0600 files under the peer's secrets dir; the last case scans every daemon log, peer
// record and captured reply for a whole secret or any 16-char window of one. One VERB-MS line per
// successful verb call goes to ${TMPDIR}/67-26/verb-ms.txt for 67-31/67-34 to compare. Nothing here
// prints a token, a share, a needle, a multiaddr or a full peer id.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { parseInviteShare } from '@votetorrent/workflows/authority'
import { APPROVAL_TOKEN_ENV, writeApprovalTokenFile } from '../src/approval/token.js'
import { EXIT } from '../src/cli/exit-codes.js'
import { callCtl } from '../src/ctl/ctl-client.js'
import { runRoleCommand } from '../src/ctl/commands.js'
import { assertFreshBuild } from '../src/engine.js'
import { PEER_FILES } from '../src/node/peer-layout.js'
import { relayPeerIdOf } from '../src/node/relay-readiness.js'
import { SecretRegistry } from '../src/secrecy/redact.js'
import { scanSecrets } from '../src/secrecy/scan-secrets.js'
import { OFFICER_ELECTION_VERB_NAMES } from '../src/verbs/officer/election-verbs.js'
import { readTokenOnce, startDaemon, type DaemonProc } from './support/daemon-fixture.js'
import { hostTierEnabled } from './support/host-tier.js'
import { startLoopbackRelay, type LoopbackRelay } from './support/loopback-relay.js'
import { assertNoLeak } from './support/vault-leak-check.js'

const HASH_RE = /^[0-9a-f]{32}$/
const BASE36 = 'abcdefghijklmnopqrstuvwxyz0123456789'
const VERB_MS_DIR = join(process.env.TMPDIR ?? tmpdir(), '67-26')
const VERB_MS_FILE = join(VERB_MS_DIR, 'verb-ms.txt')

interface ErrorView {
  name: string
  code?: string
  message?: string
}

interface CliRun {
  code: number
  out: string
  err: string
  /** The parsed `--json` body on exit 0. */
  body: { ok?: boolean, result?: Record<string, unknown>, ms?: number }
  /** The parsed `{"error":{...}}` view, or a synthetic one for a client-side refusal line. */
  error: ErrorView | undefined
}

describe('officer election verbs over ctl', function () {
  this.timeout(900_000)
  let relay: LoopbackRelay
  let root: string
  let party: string
  let peerDir: string
  let logs: string
  let officerToken: string
  let wrongToken: string
  let looseToken: string
  let goodText: string
  let tokenBytes: Uint8Array[]
  let daemon: DaemonProc
  let H = ''
  let E = ''
  let ballotId = ''
  let failed = false
  const captured: string[] = []
  const registry = new SecretRegistry()
  const mode = (p: string): number => statSync(p).mode & 0o777
  const peerSecrets = (): string => join(peerDir, PEER_FILES.secrets)

  const cli = async (verb: string, flags: readonly string[], opts: { env?: NodeJS.ProcessEnv, stdin?: Readable } = {}): Promise<CliRun> => {
    let out = ''
    let err = ''
    const code = await runRoleCommand(
      ['officer', verb, '--peer', peerDir, '--json', '--timeout-ms', '600000', ...flags],
      { out: (t) => (out += t), err: (t) => (err += t) },
      { env: opts.env ?? {}, stdin: opts.stdin ?? Readable.from([]) }
    )
    captured.push(out, err)
    let body: CliRun['body'] = {}
    try {
      body = JSON.parse(out) as CliRun['body']
    } catch {
      body = {}
    }
    let error: ErrorView | undefined
    const m = /^vt: approval token refused \(([a-z-]+)\)$/m.exec(err)
    if (m !== null) error = { name: 'ApprovalTransport', code: m[1] }
    else if (err.startsWith('{')) error = (JSON.parse(err.split('\n')[0]!) as { error: ErrorView }).error
    return { code, out, err, body, error }
  }
  const ok = async (verb: string, flags: readonly string[], opts: { env?: NodeJS.ProcessEnv, stdin?: Readable } = {}): Promise<Record<string, unknown>> => {
    const r = await cli(verb, flags, opts)
    expect(r.code, `${verb}: ${r.err.slice(0, 300)}`).to.equal(EXIT.PASS)
    expect(r.body.ok).to.equal(true)
    const result = r.body.result ?? {}
    appendFileSync(VERB_MS_FILE, `VERB-MS ${verb} ${String(result.ms)} ${String(r.body.ms)}\n`, { mode: 0o600 })
    return result
  }
  const refused = async (verb: string, flags: readonly string[], code: string, opts: { env?: NodeJS.ProcessEnv, stdin?: Readable } = {}): Promise<ErrorView> => {
    const r = await cli(verb, flags, opts)
    expect(r.code, `${verb}: expected exit 1, got ${r.code} ${r.out.slice(0, 200)}`).to.equal(EXIT.FAIL)
    expect(r.error, `${verb}: no error view in ${r.err.slice(0, 200)}`).to.not.equal(undefined)
    expect(r.error!.code, `${verb}: ${r.error!.name} ${String(r.error!.message)}`).to.equal(code)
    return r.error!
  }

  before(async function () {
    this.timeout(600_000)
    if (!hostTierEnabled()) this.skip()
    assertFreshBuild()
    root = mkdtempSync(join(tmpdir(), 'vt-26-ctl-'))
    chmodSync(root, 0o700)
    party = 'vt26-' + Array.from(randomBytes(6), (b) => BASE36[b % 36]!).join('')
    mkdirSync(join(root, party), { mode: 0o700 })
    peerDir = join(root, party, 'officer')
    logs = join(root, 'logs')
    mkdirSync(logs, { mode: 0o700 })
    const secrets = join(root, 'secrets')
    mkdirSync(secrets, { mode: 0o700 })
    officerToken = join(secrets, 'officer.token')
    wrongToken = join(secrets, 'wrong.token')
    looseToken = join(secrets, 'loose.token')
    writeApprovalTokenFile(officerToken)
    writeApprovalTokenFile(wrongToken)
    copyFileSync(officerToken, looseToken)
    chmodSync(looseToken, 0o640)
    goodText = readFileSync(officerToken, 'utf8').trim()
    const wrongText = readFileSync(wrongToken, 'utf8').trim()
    tokenBytes = [goodText, wrongText].map((t) => Buffer.from(t, 'base64url'))
    for (const t of [goodText, wrongText]) registry.add(t, { windows: true })
    mkdirSync(VERB_MS_DIR, { recursive: true, mode: 0o700 })
    relay = await startLoopbackRelay()
    registry.add(relay.multiaddr)
    registry.add(relayPeerIdOf(relay.multiaddr))
    daemon = await startDaemon({ role: 'officer', peerDir, relayEnvPath: relay.relayEnvPath, party, logDir: logs })
    expect(daemon.ready, `officer boot failed: ${daemon.bootFailedToken ?? 'no token'} exit=${String(daemon.exitCode())}`).to.equal(true)
    registry.add(readTokenOnce(peerDir), { windows: true })
    const found = await callCtl({ dir: peerDir, role: 'officer', verb: 'found', args: { name: 'T26 Net', tokenFile: officerToken }, timeoutMs: 600_000 })
    captured.push(JSON.stringify(found))
    expect(found.status, JSON.stringify(found.body.error ?? {})).to.equal(200)
    H = String(found.body.result?.networkHash)
    expect(H).to.match(HASH_RE)
    console.log(`      found createMs=${String(found.body.result?.createMs)}`)
  })

  afterEach(function () {
    if (this.currentTest?.state === 'failed') failed = true
  })

  after(async function () {
    this.timeout(300_000)
    if (daemon !== undefined) await daemon.stop().catch(() => undefined)
    if (relay !== undefined) await relay.stop()
    if (!failed && root !== undefined) rmSync(root, { recursive: true, force: true })
    if (relay !== undefined) rmSync(relay.dir, { recursive: true, force: true })
    if (failed && root !== undefined) console.log('      run dir kept: <tmp>/' + basename(root))
  })

  it('create-election refuses without a token, with a wrong token and with a group-readable token file, writing nothing', async function () {
    this.timeout(300_000)
    const absent = await refused('create-election', ['--network', H], 'token-absent')
    expect(absent.name).to.equal('ApprovalRefusal')
    const wrong = await refused('create-election', ['--network', H, '--token-file', wrongToken], 'token-refused')
    expect(wrong.name).to.equal('VerbRefusal')
    await refused('create-election', ['--network', H, '--token-file', looseToken], 'token-refused')
    const both = await refused('create-election', ['--network', H, '--token-file', officerToken, '--token-env'], 'token-ambiguous', { env: { [APPROVAL_TOKEN_ENV]: goodText } })
    expect(both.name).to.equal('ApprovalTransport')
  })

  it('create-election creates a threshold-2 election on the CLI short timeline', async function () {
    this.timeout(300_000)
    const before = Date.now()
    const r = await ok('create-election', ['--network', H, '--token-file', officerToken])
    expect(r.threshold).to.equal(2)
    expect(r.seats).to.equal(2)
    expect(r.leadMs).to.equal(600000)
    expect(r.windowMs).to.equal(480000)
    expect(r.belowProvenDefaults).to.equal(false)
    expect(r.electionCount).to.equal(1)
    expect(Number(r.signatures)).to.be.at.least(2)
    expect(typeof r.ms).to.equal('number')
    const vs = Date.parse(String(r.votingStartsAt))
    expect(Math.abs(vs - (before + 600000))).to.be.lessThan(5000 + Number(r.ms))
    expect(Date.parse(String(r.closedAt))).to.equal(vs + 480000 + 360000)
    expect(String(r.electionId).startsWith('election-')).to.equal(true)
    expect(Object.keys(r).sort()).to.deep.equal(['authorityId8', 'belowProvenDefaults', 'closedAt', 'electionCount', 'electionId', 'leadMs', 'ms', 'seats', 'signatures', 'threshold', 'title', 'votingStartsAt', 'windowMs'])
    E = String(r.electionId)
    console.log(`      create-election ms=${String(r.ms)} signatures=${String(r.signatures)}`)
  })

  it('invite-keyholder refuses an expiry beyond the offered presets', async function () {
    this.timeout(300_000)
    await refused('invite-keyholder', ['--network', H, '--election', E, '--name', 'kh-a', '--expiry-hours', '720', '--token-file', officerToken], 'expiry-not-preset')
    expect(readdirSync(peerSecrets()).filter((f) => f.endsWith('.share'))).to.deep.equal([])
  })

  it('invite-keyholder writes each seat share to a 0600 file and returns only its path', async function () {
    this.timeout(300_000)
    const a = await ok('invite-keyholder', ['--network', H, '--election', E, '--name', 'kh-a', '--token-stdin'], { stdin: Readable.from([goodText + '\n']) })
    const b = await ok('invite-keyholder', ['--network', H, '--election', E, '--name', 'kh-b', '--token-file', officerToken])
    for (const [r, name] of [[a, 'kh-a'], [b, 'kh-b']] as const) {
      expect(r.name).to.equal(name)
      expect(r.electionId).to.equal(E)
      const file = String(r.shareFile)
      expect(file.startsWith(peerSecrets() + '/')).to.equal(true)
      expect(file).to.equal(join(peerSecrets(), `seat-${name}.share`))
      expect(mode(file)).to.equal(0o600)
      const text = readFileSync(file, 'utf8').trim()
      const parsed = parseInviteShare(text)
      expect(parsed?.inviteKey.endsWith(String(r.inviteKey8))).to.equal(true)
      expect(String(r.inviteKey8).length).to.equal(8)
      expect(r.expiryHours).to.equal(24)
      expect(typeof r.expiresAt).to.equal('number')
      expect(Number(r.signatures)).to.be.at.least(1)
      registry.add(text, { windows: true })
      registry.add(parsed!.invitePrivate, { windows: true })
      expect(Object.keys(r).sort()).to.deep.equal(['electionId', 'expiresAt', 'expiryHours', 'inviteKey8', 'invitedSeats', 'ms', 'name', 'shareFile', 'signatures'])
    }
    expect(a.invitedSeats).to.equal(1)
    expect(b.invitedSeats).to.equal(2)
    console.log(`      invite-keyholder ms=${String(a.ms)},${String(b.ms)}`)
  })

  it('keyholder-policy reads the election policy without a token', async function () {
    this.timeout(300_000)
    const r = await ok('keyholder-policy', ['--network', H, '--election', E])
    expect(r.mode).to.equal('read')
    expect(r.electionId).to.equal(E)
    expect(r.revision).to.equal(0)
    expect(r.threshold).to.equal(2)
    expect(r.seats).to.equal(2)
    expect(r.invitedSeats).to.equal(2)
    await refused('keyholder-policy', ['--network', H, '--election', E, '--token-file', officerToken], 'bad-arg')
  })

  it('ballot-submit proposes and submits a ballot', async function () {
    this.timeout(300_000)
    const r = await ok('ballot-submit', ['--network', H, '--election', E, '--token-file', officerToken])
    expect(r.electionId).to.equal(E)
    expect(r.questions).to.equal(1)
    expect(r.options).to.equal(2)
    const needleFile = String(r.needleFile)
    expect(needleFile.startsWith(peerSecrets() + '/ballot-needle-')).to.equal(true)
    expect(mode(needleFile)).to.equal(0o600)
    const needle = readFileSync(needleFile, 'utf8').trim()
    expect(needle.startsWith('vt-needle-')).to.equal(true)
    registry.add(needle, { windows: true })
    expect(r.locked === true || r.ownTaskOpen === true, JSON.stringify({ locked: r.locked, ownTaskOpen: r.ownTaskOpen, confirmed: r.confirmed })).to.equal(true)
    expect(typeof r.proposeMs).to.equal('number')
    expect(typeof r.submitMs).to.equal('number')
    ballotId = String(r.ballotId)
    expect(ballotId.length).to.be.greaterThan(0)
    console.log(`      ballot-submit proposeMs=${String(r.proposeMs)} submitMs=${String(r.submitMs)} locked=${String(r.locked)} ownTaskOpen=${String(r.ownTaskOpen)}`)
  })

  it('task-sign signs the ballot task and the ballot reads confirmed', async function () {
    this.timeout(600_000)
    const r = await ok('task-sign', ['--network', H, '--election', E, '--ballot', ballotId, '--wait-ms', '120000', '--token-env'], { env: { [APPROVAL_TOKEN_ENV]: goodText } })
    expect(r.accepted).to.equal(true)
    expect(r.confirmed).to.equal(true)
    expect(Number(r.signatures)).to.be.at.least(1)
    expect(typeof r.digestMs).to.equal('number')
    expect(typeof r.completeMs).to.equal('number')
    expect(typeof r.waitMs).to.equal('number')
    expect(r.ballotId).to.equal(ballotId)
    console.log(`      task-sign digestMs=${String(r.digestMs)} completeMs=${String(r.completeMs)} waitMs=${String(r.waitMs)} ms=${String(r.ms)}`)
    await refused('task-sign', ['--network', H, '--election', E, '--ballot', ballotId, '--wait-ms', '0', '--token-file', officerToken], 'no-task')
  })

  it('the officer registry serves the five election verbs and keyholder-policy proposes a revision', async function () {
    this.timeout(300_000)
    const listed = await cli('verbs', [])
    expect(listed.code).to.equal(EXIT.PASS)
    expect((listed.body.result as { verbs: string[] }).verbs).to.include.members([...OFFICER_ELECTION_VERB_NAMES])
    expect(OFFICER_ELECTION_VERB_NAMES.length).to.equal(5)
    const r = await ok('keyholder-policy', ['--network', H, '--election', E, '--threshold', '2', '--keyholders', 'kh-a,kh-b'])
    expect(r.mode).to.equal('propose')
    expect(r.proposedRevision).to.equal(1)
    expect(r.threshold).to.equal(2)
    expect(r.seats).to.equal(2)
    await refused('create-election', ['--network', H, '--lead-ms', '89999', '--token-file', officerToken], 'lead-too-short')
  })

  it('no share, needle, token, digest or signature reaches a log, a result or the spec output', async function () {
    this.timeout(300_000)
    // What the daemon and the client EMIT: the daemon's stdout/stderr logs, its top-level records (crash,
    // daemon, boot) and every captured reply. Excluded: `secrets/` (the shares and needle live there by
    // design) and `node/` (the peer's stored network STATE: the strand store holds the public invite keys
    // and the ballot, and the recents / join-bootstrap kv files hold the relay address, as 67-24 found).
    const scan = join(root, 'scan')
    mkdirSync(scan, { mode: 0o700 })
    let copied = 0
    const copyFiles = (dir: string, pick: (name: string) => boolean): void => {
      if (!existsSync(dir)) return
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isFile() && pick(f.name)) {
          copyFileSync(join(dir, f.name), join(scan, `${basename(dir)}-${f.name}`))
          copied++
        }
      }
    }
    copyFiles(logs, (n) => n.endsWith('.log'))
    copyFiles(peerDir, (n) => n.endsWith('.json') || n.endsWith('.jsonl'))
    writeFileSync(join(scan, 'replies.txt'), captured.join('\n'), { mode: 0o600 })
    expect(copied).to.be.at.least(3)
    expect(registry.size).to.be.at.least(8)
    const result = scanSecrets(scan, registry)
    console.log(`      scan files=${result.files} whole=${result.whole} windows=${result.windows}`)
    expect(result.files).to.be.at.least(4)
    expect(result.whole).to.equal(0)
    expect(result.windows).to.equal(0)
    for (const text of captured) assertNoLeak(text, tokenBytes)
    expect(captured.length).to.be.at.least(20)
    const verbMs = readFileSync(VERB_MS_FILE, 'utf8')
    for (const verb of OFFICER_ELECTION_VERB_NAMES) expect(verbMs, verb).to.match(new RegExp(`^VERB-MS ${verb} \\d+ \\d+$`, 'm'))
  })
})
