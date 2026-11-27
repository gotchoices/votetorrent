// officer-network-verbs.loopback.spec.ts: the six officer network verbs against REAL officer daemons
// (the built vt bin, a real CadreNode each) on the loopback relay, through the ctl endpoint. Gated by
// VT_HOST_TIER=1 (test/support/host-tier.ts), like every loopback spec of this package. At most two
// daemons are alive at once (A and B). Every secret a verb produces lands in a 0600 file under a 0700
// `secrets` dir outside the repo; the final test scans every daemon log and every reply for a whole
// secret or any 16-char window of one. Nothing here prints a code, a fingerprint, a token, a multiaddr
// or a full peer id.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { writeApprovalTokenFile } from '../src/approval/token.js'
import { callCtl, type CtlReply } from '../src/ctl/ctl-client.js'
import { PEER_FILES } from '../src/node/peer-layout.js'
import { relayPeerIdOf } from '../src/node/relay-readiness.js'
import { SecretRegistry } from '../src/secrecy/redact.js'
import { scanSecrets } from '../src/secrecy/scan-secrets.js'
import { OFFICER_NETWORK_VERB_NAMES } from '../src/verbs/officer/network-verbs.js'
import { readTokenOnce, startDaemon, vt, type DaemonProc } from './support/daemon-fixture.js'
import { hostTierEnabled } from './support/host-tier.js'
import { startLoopbackRelay, type LoopbackRelay } from './support/loopback-relay.js'

const HASH_RE = /^[0-9a-f]{32}$/
const ID8_RE = /^[0-9a-f]{8}$/
const WINDOW = 16

interface ErrorView {
  name: string
  code?: string
  message?: string
}

describe('officer network verbs: loopback relay', function () {
  this.timeout(1_800_000)
  let relay: LoopbackRelay
  let root: string
  let party: string
  let secretsDir: string
  let logs: string
  let tokenA: string
  let tokenB: string
  let wrongToken: string
  let A: DaemonProc
  let B: DaemonProc | undefined
  let H = ''
  let AID8 = ''
  let codeFile = ''
  let fingerprintFile = ''
  let dashFile = ''
  let failed = false
  const live: DaemonProc[] = []
  const replies: string[] = []
  const dirA = (): string => join(root, party, 'officer-a')
  const dirB = (): string => join(root, party, 'officer-b')
  const mode = (p: string): number => statSync(p).mode & 0o777

  const track = (d: DaemonProc): DaemonProc => {
    live.push(d)
    return d
  }
  const ctl = async (dir: string, verb: string, args: Record<string, unknown> = {}, timeoutMs = 600_000): Promise<CtlReply> => {
    const reply = await callCtl({ dir, role: 'officer', verb, args, timeoutMs })
    replies.push(JSON.stringify(reply))
    return reply
  }
  const ok = async (dir: string, verb: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> => {
    const reply = await ctl(dir, verb, args, timeoutMs)
    expect(reply.status, `${verb}: ${JSON.stringify(reply.body.error ?? {})}`).to.equal(200)
    expect(reply.body.ok).to.equal(true)
    return reply.body.result ?? {}
  }
  const refused = async (dir: string, verb: string, args: Record<string, unknown>, code: string, name = 'NetworkVerbError', timeoutMs?: number): Promise<ErrorView> => {
    const reply = await ctl(dir, verb, args, timeoutMs)
    expect(reply.status, `${verb}: expected a refusal, got ${JSON.stringify(reply.body.result ?? reply.body.error ?? {})}`).to.equal(500)
    const err = reply.body.error as ErrorView
    expect(err.name, `${verb}: ${String(err.code)} ${String(err.message)}`).to.equal(name)
    expect(err.code).to.equal(code)
    return err
  }
  const rssOf = async (dir: string, label: string): Promise<number> => {
    const r = await vt(['officer', 'readback', '--peer', dir])
    expect(r.code, r.stderr.slice(0, 200)).to.equal(0)
    const rb = JSON.parse(r.stdout) as { rssMb: number, recentCount: number }
    console.log(`      RSS ${label}=${rb.rssMb}MB recentCount=${rb.recentCount}`)
    return rb.rssMb
  }
  const noWindowOf = (text: string, secret: string): void => {
    expect(text).to.not.include(secret)
    for (let i = 0; i + WINDOW <= secret.length; i++) expect(text).to.not.include(secret.slice(i, i + WINDOW))
  }
  const startA = async (): Promise<DaemonProc> => {
    const d = track(await startDaemon({ role: 'officer', peerDir: dirA(), relayEnvPath: relay.relayEnvPath, party, logDir: logs }))
    expect(d.ready, `officer-a boot failed: ${d.bootFailedToken ?? 'no token'} exit=${String(d.exitCode())}`).to.equal(true)
    return d
  }

  before(async function () {
    this.timeout(600_000)
    if (!hostTierEnabled()) this.skip()
    root = mkdtempSync(join(tmpdir(), 'vt-24-'))
    chmodSync(root, 0o700)
    party = 'vt-t24-' + randomBytes(3).toString('hex')
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
    relay = await startLoopbackRelay()
    A = await startA()
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

  it('found founds a network and returns its 32-hex hash', async function () {
    this.timeout(600_000)
    const listed = await vt(['officer', 'verbs', '--peer', dirA()])
    expect(listed.code).to.equal(0)
    expect((JSON.parse(listed.stdout) as { verbs: string[] }).verbs).to.include.members([...OFFICER_NETWORK_VERB_NAMES])
    const r = await ok(dirA(), 'found', { name: 'T24 Net', tokenFile: tokenA })
    expect(String(r.networkHash)).to.match(HASH_RE)
    expect(r.networkHash8).to.equal(String(r.networkHash).slice(0, 8))
    expect(r.recentHas).to.equal(true)
    expect(r.posture).to.equal('production')
    expect(typeof r.createMs).to.equal('number')
    expect(Object.keys(r).sort()).to.deep.equal(['createMs', 'electionType', 'networkHash', 'networkHash8', 'posture', 'recentHas'])
    H = String(r.networkHash)
    console.log(`      found createMs=${String(r.createMs)}`)
    expect(mode(join(dirA(), PEER_FILES.node, PEER_FILES.user))).to.equal(0o600)
    await rssOf(dirA(), 'officer-a-after-found')
  })

  it('authority-id returns the 8-char primary authority id for the hash argument', async function () {
    this.timeout(300_000)
    const r = await ok(dirA(), 'authority-id', { networkHash: H })
    expect(r.count).to.equal(1)
    expect(String(r.authorityId8)).to.match(ID8_RE)
    expect(r.networkHash8).to.equal(H.slice(0, 8))
    expect(Object.keys(r).sort()).to.deep.equal(['authorityId8', 'count', 'networkHash8'])
    AID8 = String(r.authorityId8)
  })

  it('dashboard-code refuses not-owner before owner-setup', async function () {
    this.timeout(300_000)
    const early = join(secretsDir, 'dash-early.txt')
    await refused(dirA(), 'dashboard-code', { networkHash: H, codeFile: early, tokenFile: tokenA }, 'not-owner')
    expect(existsSync(early)).to.equal(false)
  })

  it('owner-setup makes the identity the cadre owner and returns no key material', async function () {
    this.timeout(300_000)
    const r = await ok(dirA(), 'owner-setup')
    expect(Object.keys(r).sort()).to.deep.equal(['capabilityAfter', 'capabilityBefore', 'ownerCount', 'ownerIsIdentity'])
    expect(r.capabilityBefore).to.equal('needs-owner-setup')
    expect(r.capabilityAfter).to.equal('ready')
    expect(r.ownerIsIdentity).to.equal(true)
    expect(r.ownerCount).to.equal(1)
    const cap = await vt(['officer', 'capability', '--peer', dirA()])
    expect(cap.stdout).to.equal('{"capability":"ready"}\n')
  })

  it('mint writes the join code and fingerprint 0600 under secrets and returns only paths', async function () {
    this.timeout(300_000)
    codeFile = join(secretsDir, 'join-code.txt')
    fingerprintFile = join(secretsDir, 'fingerprint.txt')
    const reply = await ctl(dirA(), 'mint', { networkHash: H, codeFile, fingerprintFile })
    expect(reply.status, JSON.stringify(reply.body.error ?? {})).to.equal(200)
    const r = reply.body.result ?? {}
    expect(r.codeFile).to.equal(codeFile)
    expect(r.fingerprintFile).to.equal(fingerprintFile)
    expect(mode(codeFile)).to.equal(0o600)
    expect(mode(fingerprintFile)).to.equal(0o600)
    const code = readFileSync(codeFile, 'utf8').trim()
    const fingerprint = readFileSync(fingerprintFile, 'utf8').trim()
    expect(code.length).to.equal(r.chars)
    expect(code.length).to.be.greaterThan(WINDOW)
    expect(fingerprint.length).to.be.greaterThan(0)
    const text = JSON.stringify(reply)
    noWindowOf(text, code)
    expect(text).to.not.include(fingerprint)
    expect(r.v).to.equal(2)
    expect(r.fingerprintEqual).to.equal(true)
    expect(r.memberAddrsCircuitOnly).to.equal(true)
    expect(r.expiresAtPresent).to.equal(true)
    expect(Object.keys(r).sort()).to.deep.equal(['chars', 'codeFile', 'expiresAtPresent', 'fingerprintEqual', 'fingerprintFile', 'memberAddrsCircuitOnly', 'members', 'networkName8', 'v'])
  })

  it('mint refuses an existing code file', async function () {
    this.timeout(300_000)
    const before = readFileSync(codeFile, 'utf8')
    await refused(dirA(), 'mint', { networkHash: H, codeFile, fingerprintFile: join(secretsDir, 'fingerprint-2.txt') }, 'secret-file-exists')
    expect(readFileSync(codeFile, 'utf8')).to.equal(before)
    expect(existsSync(join(secretsDir, 'fingerprint-2.txt'))).to.equal(false)
  })

  it('join refuses the founder of the network', async function () {
    this.timeout(600_000)
    // The shared verdict for a founder redeeming its OWN code: the founder guard allows it (the invitation
    // names this cadre's own owner key, so it is not another cadre's network) and the shared joinNetwork
    // then refuses `not-admitted`. A code of another cadre naming none of our owners reads
    // `founder-cannot-join`. Either way the founder is refused and its state is untouched.
    const reply = await ctl(dirA(), 'join', { codeFile, expectName: 'T24 Net', expectFingerprintFile: fingerprintFile, networkHash: H, tokenFile: tokenA, timeoutMs: '300000' })
    expect(reply.status).to.equal(500)
    const err = reply.body.error as ErrorView
    expect(err.name).to.equal('NetworkVerbError')
    expect(['join-not-admitted', 'join-founder-cannot-join']).to.include(err.code)
    expect(err.message).to.equal(`officer verb refused (${String(err.code)})`)
    console.log(`      founder self-join refused as ${String(err.code)}`)
    const still = await ok(dirA(), 'authority-id', { networkHash: H })
    expect(still.authorityId8).to.equal(AID8)
  })

  it('join on a second officer refuses a wrong expected name, a wrong fingerprint file and a wrong network hash', async function () {
    this.timeout(600_000)
    B = track(await startDaemon({ role: 'officer', peerDir: dirB(), relayEnvPath: relay.relayEnvPath, party, logDir: logs }))
    expect(B.ready, `officer-b boot failed: ${B.bootFailedToken ?? 'no token'} exit=${String(B.exitCode())}`).to.equal(true)
    const wrongFp = join(secretsDir, 'wrong-fingerprint.txt')
    writeFileSync(wrongFp, 'not-the-fingerprint\n', { mode: 0o600 })
    const base = { codeFile, expectName: 'T24 Net', expectFingerprintFile: fingerprintFile, networkHash: H, tokenFile: tokenB }
    await refused(dirB(), 'join', { ...base, expectName: 'Other Net' }, 'preview-mismatch')
    await refused(dirB(), 'join', { ...base, expectFingerprintFile: wrongFp }, 'preview-mismatch')
    await refused(dirB(), 'join', { ...base, networkHash: randomBytes(16).toString('hex') }, 'preview-mismatch')
    await refused(dirB(), 'authority-id', { networkHash: H }, 'network-unknown')
    expect(existsSync(join(dirB(), PEER_FILES.node, PEER_FILES.user))).to.equal(false)
  })

  it('join admits the second officer and records the network as joined', async function () {
    this.timeout(900_000)
    const r = await ok(dirB(), 'join', { codeFile, expectName: 'T24 Net', expectFingerprintFile: fingerprintFile, networkHash: H, tokenFile: tokenB, userName: 'Officer B', timeoutMs: '600000' }, 700_000)
    expect(r.isJoinedNetwork).to.equal(true)
    expect(['joined', 'already-joined']).to.include(r.outcome)
    expect(Array.isArray(r.steps) && (r.steps as string[]).length > 0).to.equal(true)
    expect(r.networkHash8).to.equal(H.slice(0, 8))
    expect(typeof r.joinMs).to.equal('number')
    expect(typeof r.trustSaved).to.equal('boolean')
    expect(Object.keys(r).sort()).to.deep.equal(['admittedVia', 'isJoinedNetwork', 'joinMs', 'networkHash8', 'outcome', 'ownerTrust', 'posture', 'selfVouched', 'steps', 'trustSaved'])
    console.log(`      join joinMs=${String(r.joinMs)} outcome=${String(r.outcome)} admittedVia=${String(r.admittedVia)} selfVouched=${String(r.selfVouched)} trustSaved=${String(r.trustSaved)}`)
    const aid = await ok(dirB(), 'authority-id', { networkHash: H })
    expect(aid.authorityId8).to.equal(AID8)
    await rssOf(dirB(), 'officer-b-after-join')
  })

  it('the joined officer refuses mint and owner-setup', async function () {
    this.timeout(300_000)
    const bCode = join(secretsDir, 'b-code.txt')
    await refused(dirB(), 'mint', { networkHash: H, codeFile: bCode, fingerprintFile: join(secretsDir, 'b-fp.txt') }, 'not-founding-officer')
    expect(existsSync(bCode)).to.equal(false)
    await refused(dirB(), 'owner-setup', {}, 'not-owner')
  })

  it('dashboard-code writes a pairing code 0600 and refuses a wrong token', async function () {
    this.timeout(600_000)
    dashFile = join(secretsDir, 'dash-code.txt')
    const reply = await ctl(dirA(), 'dashboard-code', { networkHash: H, codeFile: dashFile, tokenFile: tokenA })
    expect(reply.status, JSON.stringify(reply.body.error ?? {})).to.equal(200)
    const r = reply.body.result ?? {}
    expect(r.codeFile).to.equal(dashFile)
    expect(mode(dashFile)).to.equal(0o600)
    const code = readFileSync(dashFile, 'utf8').trim()
    expect(code.length).to.equal(r.chars)
    expect(Number(r.chars)).to.be.greaterThan(0)
    expect(typeof r.expiresAt).to.equal('string')
    expect(Object.keys(r).sort()).to.deep.equal(['chars', 'codeFile', 'expiresAt'])
    noWindowOf(JSON.stringify(reply), code)
    const second = join(secretsDir, 'dash-code-wrong.txt')
    const err = await refused(dirA(), 'dashboard-code', { networkHash: H, codeFile: second, tokenFile: wrongToken }, 'token-refused', 'TokenSignerError')
    expect(err.message).to.not.include(second)
    expect(existsSync(second)).to.equal(false)
  })

  it('after a daemon restart authority-id still resolves from the hash argument', async function () {
    this.timeout(600_000)
    await A.stop()
    expect(await A.waitExit(30_000)).to.equal(0)
    A = await startA()
    const boots = readdirSync(dirA()).filter((f) => /^boot-\d+\.json$/.test(f)).sort()
    expect(boots).to.deep.equal(['boot-1.json', 'boot-2.json'])
    const r = await ok(dirA(), 'authority-id', { networkHash: H })
    expect(r.authorityId8).to.equal(AID8)
    expect(r.count).to.equal(1)
    await rssOf(dirA(), 'officer-a-after-restart')
  })

  it('no reply or daemon log holds a code, fingerprint, pairing code or token', async function () {
    this.timeout(300_000)
    const scan = join(root, 'scan')
    mkdirSync(scan, { mode: 0o700 })
    // What a daemon EMITS: its stdout/stderr logs (the fixture's 0600 files) and its crash records. The
    // strand stores under node/store are replicated network DATA (they legitimately hold member
    // addresses) and are not daemon output, so they are not scanned.
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
    for (const peer of readdirSync(join(root, party))) copyLogs(join(root, party, peer))
    writeFileSync(join(scan, 'replies.txt'), replies.join('\n'), { mode: 0o600 })
    expect(copied).to.be.at.least(2)
    const registry = new SecretRegistry()
    for (const f of [codeFile, fingerprintFile, dashFile, tokenA, tokenB, wrongToken]) registry.add(readFileSync(f, 'utf8').trim(), { windows: true })
    for (const dir of [dirA(), dirB()]) if (existsSync(join(dir, PEER_FILES.ctlToken))) registry.add(readTokenOnce(dir), { windows: true })
    registry.add(relay.multiaddr)
    registry.add(relayPeerIdOf(relay.multiaddr))
    expect(registry.size).to.be.at.least(8)
    const result = scanSecrets(scan, registry)
    console.log(`      scan files=${result.files} whole=${result.whole} windows=${result.windows}`)
    expect(result.files).to.be.at.least(1)
    expect(result.whole).to.equal(0)
    expect(result.windows).to.equal(0)
    expect(replies.length).to.be.at.least(13)
  })
})
