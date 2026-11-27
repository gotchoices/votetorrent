// daemon-loopback.spec.ts: real role daemons (the built vt bin) on the loopback relay, driven through
// ctl. Gated by VT_HOST_TIER=1 (test/support/host-tier.ts). At most two CadreNodes are alive at once
// (test 9 has two; test 10 holds one while none other is live). Every assertion reads JSON fields; no
// test prints a token, a multiaddr or a full peer id, and the final test proves no daemon log or record
// holds one.

import { expect } from 'chai'
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CTL_PORT_FILE, CTL_TOKEN_FILE } from '../src/ctl/protocol.js'
import { readCtlPort } from '../src/ctl/ctl-files.js'
import type { BootedPeer } from '../src/daemon/boot-peer.js'
import { PEER_FILES, nodeDir } from '../src/node/peer-layout.js'
import { relayPeerIdOf } from '../src/node/relay-readiness.js'
import { writeRelayEnv } from '../src/relay/relay-env.js'
import { SecretRegistry } from '../src/secrecy/redact.js'
import { scanSecrets } from '../src/secrecy/scan-secrets.js'
import type { SecretRegistry as RunSecretRegistry } from '../src/run/secret-scan.js'
import type { createDaemonLauncher as CreateDaemonLauncher } from '../src/run/daemon-launcher.js'
import { COMMON_VERBS } from '../src/verbs/common.js'
import { PACKAGE_ROOT, bootInProcessPeer, readTokenOnce, startDaemon, vt, type DaemonProc } from './support/daemon-fixture.js'
import { hostTierEnabled } from './support/host-tier.js'
import { startLoopbackRelay, type LoopbackRelay } from './support/loopback-relay.js'

interface Readback {
  role: string
  label: string
  peerId8: string
  bootN: number
  recreated: boolean
  circuitReady: boolean
  circuitViaRelay: boolean
  circuitAddrs: number
  nonCircuitAddrs: number
  controlConnections: number
  ownerSetTag: string | null
  ownerTrust: string | null
  recentCount: number
  recent0: string | null
  rssMb: number
  heapUsedMb: number
  uptimeMs: number
  authPrompts: number
  acceptTokenAttestations: boolean
}

const READBACK_KEYS = [
  'role', 'label', 'peerId8', 'bootN', 'recreated',
  'circuitReady', 'circuitViaRelay', 'circuitAddrs', 'nonCircuitAddrs', 'controlConnections',
  'ownerSetTag', 'ownerTrust', 'recentCount', 'recent0',
  'rssMb', 'heapUsedMb', 'uptimeMs', 'authPrompts', 'acceptTokenAttestations'
]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(100)
  }
  return pred()
}

describe('daemon on the loopback relay', function () {
  this.timeout(1_800_000)
  let relay: LoopbackRelay
  let root: string
  let party: string
  let run: string
  let logs: string
  const registry = new SecretRegistry()
  const live: DaemonProc[] = []
  let inProcess: BootedPeer | undefined
  let officer: DaemonProc
  const officerLabelDir = (): string => join(run, party, 'officer')

  const track = (d: DaemonProc): DaemonProc => {
    live.push(d)
    return d
  }
  const registerPeerSecrets = (peerDir: string): void => {
    if (existsSync(join(peerDir, CTL_TOKEN_FILE))) registry.add(readTokenOnce(peerDir), { windows: true })
    const keyFile = join(nodeDir(peerDir), PEER_FILES.peerKey)
    if (existsSync(keyFile)) registry.add((JSON.parse(readFileSync(keyFile, 'utf8')) as { k: string }).k, { windows: true })
  }
  const readback = async (role: string, dir: string): Promise<Readback> => {
    const r = await vt([role, 'readback', '--peer', dir])
    expect(r.code, r.stderr.slice(0, 200)).to.equal(0)
    return JSON.parse(r.stdout) as Readback
  }
  const mode = (p: string): number => statSync(p).mode & 0o777

  before(async function () {
    if (!hostTierEnabled()) this.skip()
    relay = await startLoopbackRelay()
    root = mkdtempSync(join(tmpdir(), 'vt-23-'))
    chmodSync(root, 0o700)
    party = 'vt23-' + randomBytes(4).toString('hex')
    run = join(root, 'run')
    logs = join(root, 'logs')
    mkdirSync(run, { recursive: true, mode: 0o700 })
    mkdirSync(logs, { recursive: true, mode: 0o700 })
    registry.add(relay.multiaddr)
    registry.add(relayPeerIdOf(relay.multiaddr))
  })

  after(async function () {
    this.timeout(300000)
    for (const d of live) await d.stop().catch(() => undefined)
    await inProcess?.close('after').catch(() => undefined)
    if (relay !== undefined) await relay.stop()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
    if (relay !== undefined) rmSync(relay.dir, { recursive: true, force: true })
  })

  it('an officer daemon boots, reserves a circuit and writes its ctl files 0600 in a 0700 peer dir', async () => {
    officer = track(await startDaemon({ role: 'officer', peerDir: officerLabelDir(), relayEnvPath: relay.relayEnvPath, party, logDir: logs }))
    expect(officer.ready, `boot failed: ${officer.bootFailedToken ?? 'no token'} exit=${String(officer.exitCode())}`).to.equal(true)
    expect(await waitFor(() => officer.stdoutText().includes('VT-DAEMON-READY role=officer peer=officer boot=1'), 5000)).to.equal(true)
    const dir = officerLabelDir()
    registerPeerSecrets(dir)
    expect(mode(dir)).to.equal(0o700)
    expect(mode(join(dir, PEER_FILES.secrets))).to.equal(0o700)
    expect(mode(join(dir, PEER_FILES.vault))).to.equal(0o700)
    expect(mode(join(dir, CTL_PORT_FILE))).to.equal(0o600)
    expect(mode(join(dir, CTL_TOKEN_FILE))).to.equal(0o600)
    expect(mode(join(dir, PEER_FILES.daemon))).to.equal(0o600)
    expect(mode(join(dir, PEER_FILES.lock))).to.equal(0o600)
    expect(mode(join(nodeDir(dir), PEER_FILES.peerKey))).to.equal(0o600)
    expect(mode(join(dir, 'boot-1.json'))).to.equal(0o600)
    const daemon = JSON.parse(readFileSync(join(dir, PEER_FILES.daemon), 'utf8')) as Record<string, unknown>
    expect(daemon.pid).to.equal(officer.pid)
    expect(daemon.role).to.equal('officer')
    expect(daemon.label).to.equal('officer')
    expect(daemon.partyId).to.equal(party)
    expect(daemon.primary).to.equal(true)
    expect(String(daemon.peerId8)).to.have.lengthOf(8)
    const boot = JSON.parse(readFileSync(join(dir, 'boot-1.json'), 'utf8')) as Record<string, unknown>
    expect(boot.boot).to.equal(1)
    expect(boot.posture).to.equal('production')
    expect(boot.acceptTokenAttestations).to.equal(false)
    expect(boot.failed).to.equal(undefined)
    // the two kv files are lazy (67-13: created on the first set), so a fresh peer holds the key and the store dir
    expect(readdirSync(join(dir, PEER_FILES.node)).sort()).to.include.members(['peer-key.json', 'store'])
  })

  it('readback reports circuitReady, no direct address and only an 8-char peer id', async () => {
    const r = await vt(['officer', 'readback', '--peer', officerLabelDir()])
    expect(r.code).to.equal(0)
    expect(r.stdout).to.not.include('12D3Koo')
    expect(r.stdout).to.not.include('/p2p/')
    const rb = JSON.parse(r.stdout) as Readback
    expect(Object.keys(rb).sort()).to.deep.equal([...READBACK_KEYS].sort())
    expect(rb.role).to.equal('officer')
    expect(rb.label).to.equal('officer')
    expect(rb.bootN).to.equal(1)
    expect(rb.recreated).to.equal(false)
    expect(rb.circuitReady).to.equal(true)
    expect(rb.circuitViaRelay).to.equal(true)
    expect(rb.nonCircuitAddrs).to.equal(0)
    expect(rb.circuitAddrs).to.be.at.least(1)
    expect(rb.peerId8).to.have.lengthOf(8)
    expect(typeof rb.ownerTrust).to.equal('string')
    expect(typeof rb.ownerSetTag).to.equal('string')
    expect(rb.recentCount).to.equal(0)
    expect(rb.recent0).to.equal(null)
    expect(rb.authPrompts).to.equal(0)
    expect(rb.acceptTokenAttestations).to.equal(false)
    expect(rb.rssMb).to.be.greaterThan(50)
    console.log(`      RSS officer=${rb.rssMb}MB`)
  })

  it('capability reports needs-owner-setup on a fresh officer', async () => {
    const r = await vt(['officer', 'capability', '--peer', officerLabelDir()])
    expect(r.code).to.equal(0)
    expect(r.stdout).to.equal('{"capability":"needs-owner-setup"}\n')
  })

  it("wrong role, unknown verb and another peer's label are refused", async () => {
    const dir = officerLabelDir()
    const wrongRole = await vt(['voter', 'readback', '--peer', dir])
    expect(wrongRole.code).to.equal(2)
    expect(JSON.parse(wrongRole.stderr)).to.deep.equal({ error: { name: 'WrongRole' } })
    const unknown = await vt(['officer', 'no-such-verb', '--peer', dir])
    expect(unknown.code).to.equal(2)
    expect(JSON.parse(unknown.stderr)).to.deep.equal({ error: { name: 'NoSuchVerb' } })
    const wrongPeer = await vt(['officer', 'readback', '--peer', dir, '--args-json', '{"peer":"kh-a"}'])
    expect(wrongPeer.code).to.equal(1)
    const err = (JSON.parse(wrongPeer.stderr) as { error: { name: string, code?: string } }).error
    expect(err.name).to.equal('WrongPeer')
    expect(err.code).to.equal('wrong-peer')
    const extraArg = await vt(['officer', 'readback', '--peer', dir, '--verbose'])
    expect(extraArg.code).to.equal(1)
    expect((JSON.parse(extraArg.stderr) as { error: { name: string } }).error.name).to.equal('VerbArgsError')
  })

  it('refusals through the real bin: max-peers, test posture on the production party, posture on a keyholder and a second daemon on a busy peer dir', async () => {
    const partyM = `${party}-m`
    const maxPeers = await vt(['officer', 'start', '--state', join(run, partyM, 'officer'), '--relay', relay.relayEnvPath, '--party', partyM, '--colocate', 'officer,kh-a', '--max-peers', '1'])
    expect(maxPeers.code).to.equal(2)
    expect(maxPeers.stdout).to.include('VT-DAEMON-BOOT-FAILED role=officer peer=? token=max-peers\n')
    expect(existsSync(join(run, partyM))).to.equal(false)
    const production = await vt(['officer', 'start', '--state', join(run, 'votetorrent', 'officer'), '--relay', relay.relayEnvPath, '--party', 'votetorrent', '--accept-token-attestations'])
    expect(production.code).to.equal(2)
    expect(production.stdout).to.include('token=production-party\n')
    expect(production.stderr).to.include('start refused (production-party)')
    expect(existsSync(join(run, 'votetorrent'))).to.equal(false)
    const khPosture = await vt(['keyholder', 'start', '--state', join(run, party, 'kh-a'), '--relay', relay.relayEnvPath, '--party', party, '--accept-token-attestations'])
    expect(khPosture.code).to.equal(2)
    expect(khPosture.stderr).to.include('start refused (posture-role)')
    expect(existsSync(join(run, party, 'kh-a'))).to.equal(false)
    const busy = await vt(['officer', 'start', '--state', officerLabelDir(), '--relay', relay.relayEnvPath, '--party', party])
    expect(busy.code).to.equal(2)
    expect(busy.stdout).to.include('VT-DAEMON-BOOT-FAILED role=officer peer=officer token=peer-dir-busy\n')
    expect(busy.stdout).to.include('VT-DAEMON-POSTURE party=')
    expect(busy.stdout).to.not.include(run)
    expect(existsSync(join(officerLabelDir(), CTL_PORT_FILE))).to.equal(true)
    const stillUp = await readback('officer', officerLabelDir())
    expect(stillUp.bootN).to.equal(1)
    // a busy refusal writes nothing into the live daemon's dir: no boot record, no lock change
    expect(existsSync(join(officerLabelDir(), 'boot-2.json'))).to.equal(false)
    expect(readFileSync(join(officerLabelDir(), PEER_FILES.lock), 'utf8')).to.equal(`${officer.pid}\n`)
  })

  it('stop shuts the daemon down, removes ctl.port, ctl.token and daemon.lock, and the peer reads unreachable', async () => {
    const dir = officerLabelDir()
    const r = await vt(['officer', 'stop', '--peer', dir])
    expect(r.code).to.equal(0)
    expect(r.stdout).to.equal('{"stopping":true}\n')
    const code = await officer.waitExit(30000)
    expect(code).to.equal(0)
    expect(existsSync(join(dir, CTL_PORT_FILE))).to.equal(false)
    expect(existsSync(join(dir, CTL_TOKEN_FILE))).to.equal(false)
    expect(existsSync(join(dir, PEER_FILES.lock))).to.equal(false)
    const daemon = JSON.parse(readFileSync(join(dir, PEER_FILES.daemon), 'utf8')) as Record<string, unknown>
    expect(daemon.stopReason).to.equal('stop-verb')
    expect(typeof daemon.stoppedAt).to.equal('string')
    expect(officer.stdoutText()).to.include('VT-DAEMON-STOPPED role=officer peer=officer reason=stop-verb')
    expect(officer.stdoutText()).to.include('VT-CALL peer=officer verb=stop status=200')
    const gone = await vt(['officer', 'readback', '--peer', dir])
    expect(gone.code).to.equal(3)
    expect(existsSync(join(nodeDir(dir), PEER_FILES.store))).to.equal(true)
  })

  it('a restart on the same peer dir keeps the peer id and records boot 2; SIGTERM also stops cleanly', async () => {
    const dir = officerLabelDir()
    const first = JSON.parse(readFileSync(join(dir, 'boot-1.json'), 'utf8')) as { peerId8: string }
    const again = track(await startDaemon({ role: 'officer', peerDir: dir, relayEnvPath: relay.relayEnvPath, party, logDir: logs }))
    expect(again.ready, `restart failed: ${again.bootFailedToken ?? 'no token'}`).to.equal(true)
    registerPeerSecrets(dir)
    const boots = readdirSync(dir).filter((f) => /^boot-\d+\.json$/.test(f)).sort()
    expect(boots).to.deep.equal(['boot-1.json', 'boot-2.json'])
    const second = JSON.parse(readFileSync(join(dir, 'boot-2.json'), 'utf8')) as { peerId8: string, boot: number, failed?: unknown }
    expect(second.boot).to.equal(2)
    expect(second.failed).to.equal(undefined)
    expect(second.peerId8).to.equal(first.peerId8)
    const rb = await readback('officer', dir)
    expect(rb.peerId8).to.equal(first.peerId8)
    expect(rb.bootN).to.equal(2)
    expect(rb.circuitReady).to.equal(true)
    again.proc.kill('SIGTERM')
    const code = await again.waitExit(30000)
    expect(code).to.equal(0)
    expect(existsSync(join(dir, CTL_PORT_FILE))).to.equal(false)
    expect(existsSync(join(dir, PEER_FILES.lock))).to.equal(false)
    const daemon = JSON.parse(readFileSync(join(dir, PEER_FILES.daemon), 'utf8')) as Record<string, unknown>
    expect(daemon.stopReason).to.equal('signal')
    expect(again.stdoutText()).to.include('VT-DAEMON-STOPPED role=officer peer=officer reason=signal')
  })

  it('a voter daemon boots with the edge-reader posture and serves no capability verb', async () => {
    const dir = join(run, party, 'v1')
    const voter = track(await startDaemon({ role: 'voter', peerDir: dir, relayEnvPath: relay.relayEnvPath, party, logDir: logs }))
    expect(voter.ready, `voter boot failed: ${voter.bootFailedToken ?? 'no token'}`).to.equal(true)
    registerPeerSecrets(dir)
    const rb = await readback('voter', dir)
    expect(rb.role).to.equal('voter')
    expect(rb.label).to.equal('v1')
    expect(rb.ownerTrust).to.equal(null)
    expect(rb.ownerSetTag).to.equal(null)
    expect(rb.circuitReady).to.equal(true)
    expect(rb.peerId8).to.have.lengthOf(8)
    const cap = await vt(['voter', 'capability', '--peer', dir])
    expect(cap.code).to.equal(2)
    expect(JSON.parse(cap.stderr)).to.deep.equal({ error: { name: 'NoSuchVerb' } })
    const verbs = await vt(['voter', 'verbs', '--peer', dir])
    expect(verbs.code).to.equal(0)
    const listed = (JSON.parse(verbs.stdout) as { verbs: string[] }).verbs
    expect(listed).to.include.members(['readback', 'stop'])
    expect(listed).to.not.include('capability')
    const boot = JSON.parse(readFileSync(join(dir, 'boot-1.json'), 'utf8')) as Record<string, unknown>
    expect(boot.rendezvous).to.equal('skipped')
    expect(boot.ownerTrust).to.equal(null)
    await voter.stop()
    expect(await voter.waitExit(30000)).to.equal(0)
  })

  it('colocated officer and kh-a get separate dirs, tokens, vaults and peer ids in one process', async () => {
    const partyC = `${party}-c`
    const officerDir = join(run, partyC, 'officer')
    const khDir = join(run, partyC, 'kh-a')
    const group = track(await startDaemon({ role: 'officer', peerDir: officerDir, relayEnvPath: relay.relayEnvPath, party: partyC, extra: ['--colocate', 'officer,kh-a'], logDir: logs }))
    expect(group.ready, `colocated boot failed: ${group.bootFailedToken ?? 'no token'}`).to.equal(true)
    expect(existsSync(join(khDir, CTL_PORT_FILE))).to.equal(true)
    registerPeerSecrets(officerDir)
    registerPeerSecrets(khDir)
    const officerToken = readTokenOnce(officerDir)
    const khToken = readTokenOnce(khDir)
    expect(officerToken === khToken).to.equal(false)
    const officerPort = readCtlPort(officerDir)
    const khPort = readCtlPort(khDir)
    expect(officerPort.ok && khPort.ok && officerPort.port !== khPort.port).to.equal(true)
    expect(mode(join(officerDir, PEER_FILES.vault))).to.equal(0o700)
    expect(mode(join(khDir, PEER_FILES.vault))).to.equal(0o700)
    expect(existsSync(join(officerDir, PEER_FILES.vault, 'at-rest.key'))).to.equal(true)
    expect(existsSync(join(khDir, PEER_FILES.vault, 'at-rest.key'))).to.equal(true)
    expect(readFileSync(join(officerDir, PEER_FILES.vault, 'at-rest.key')).equals(readFileSync(join(khDir, PEER_FILES.vault, 'at-rest.key')))).to.equal(false)
    const o = await readback('officer', officerDir)
    const k = await readback('keyholder', khDir)
    expect(o.role).to.equal('officer')
    expect(k.role).to.equal('keyholder')
    expect(k.label).to.equal('kh-a')
    expect(o.peerId8 === k.peerId8).to.equal(false)
    expect(k.circuitReady).to.equal(true)
    const oDaemon = JSON.parse(readFileSync(join(officerDir, PEER_FILES.daemon), 'utf8')) as Record<string, unknown>
    const kDaemon = JSON.parse(readFileSync(join(khDir, PEER_FILES.daemon), 'utf8')) as Record<string, unknown>
    expect(oDaemon.pid).to.equal(group.pid)
    expect(kDaemon.pid).to.equal(group.pid)
    expect(oDaemon.primary).to.equal(true)
    expect(kDaemon.primary).to.equal(false)
    const wrong = await vt(['keyholder', 'readback', '--peer', khDir, '--args-json', '{"peer":"officer"}'])
    expect(wrong.code).to.equal(1)
    expect((JSON.parse(wrong.stderr) as { error: { name: string } }).error.name).to.equal('WrongPeer')
    const right = await vt(['keyholder', 'readback', '--peer', khDir, '--args-json', '{"peer":"kh-a"}'])
    expect(right.code).to.equal(0)
    const cap = await vt(['keyholder', 'capability', '--peer', khDir])
    expect(cap.code).to.equal(0)
    expect(cap.stdout).to.equal('{"capability":"needs-owner-setup"}\n')
    console.log(`      RSS colocated(2)=${o.rssMb}MB`)
    const stop = await vt(['officer', 'stop', '--peer', officerDir])
    expect(stop.code).to.equal(0)
    expect(await group.waitExit(30000)).to.equal(0)
    for (const dir of [officerDir, khDir]) {
      expect(existsSync(join(dir, CTL_PORT_FILE)), dir).to.equal(false)
      expect(existsSync(join(dir, CTL_TOKEN_FILE)), dir).to.equal(false)
      expect(existsSync(join(dir, PEER_FILES.lock)), dir).to.equal(false)
      const d = JSON.parse(readFileSync(join(dir, PEER_FILES.daemon), 'utf8')) as Record<string, unknown>
      expect(d.stopReason, dir).to.equal('stop-verb')
    }
    expect(group.stdoutText()).to.include('VT-DAEMON-STOPPED role=keyholder peer=kh-a reason=stop-verb')
    expect(group.stdoutText()).to.include('VT-DAEMON-STOPPED role=officer peer=officer reason=stop-verb')
  })

  it('an officer started with --accept-token-attestations reports the posture, and the in-process builder boots the same context', async () => {
    const partyP = `${party}-p`
    const dir = join(run, partyP, 'officer')
    const posture = track(await startDaemon({ role: 'officer', peerDir: dir, relayEnvPath: relay.relayEnvPath, party: partyP, extra: ['--accept-token-attestations'], logDir: logs }))
    expect(posture.ready, `posture boot failed: ${posture.bootFailedToken ?? 'no token'}`).to.equal(true)
    registerPeerSecrets(dir)
    expect(posture.stdoutText()).to.include(`VT-DAEMON-POSTURE party=${partyP} posture=test`)
    const rb = await readback('officer', dir)
    expect(rb.acceptTokenAttestations).to.equal(true)
    const boot = JSON.parse(readFileSync(join(dir, 'boot-1.json'), 'utf8')) as Record<string, unknown>
    expect(boot.acceptTokenAttestations).to.equal(true)
    expect(boot.posture).to.equal('test')
    await posture.stop()
    expect(await posture.waitExit(30000)).to.equal(0)

    const partyI = `${party}-i`
    inProcess = await bootInProcessPeer({ role: 'officer', label: 'officer', party: partyI, runRoot: run, relayEnvPath: relay.relayEnvPath, acceptTokenAttestations: true })
    const ctx = inProcess.ctx
    const peerDir = join(run, partyI, 'officer')
    registerPeerSecrets(peerDir)
    expect(ctx.peerDir).to.equal(peerDir)
    expect(ctx.role).to.equal('officer')
    expect(ctx.partyId).to.equal(partyI)
    expect(ctx.posture).to.equal('test')
    expect(ctx.acceptTokenAttestations).to.equal(true)
    expect(ctx.secretsDir).to.equal(join(peerDir, 'secrets'))
    expect(mode(ctx.secretsDir)).to.equal(0o700)
    expect(ctx.user).to.equal(null)
    expect(ctx.relay.private).to.equal(true)
    expect(existsSync(join(peerDir, PEER_FILES.lock))).to.equal(true)
    expect(existsSync(join(peerDir, 'boot-1.json'))).to.equal(true)
    const direct = (await COMMON_VERBS.readback!(ctx, {})) as unknown as Readback
    expect(direct.circuitReady).to.equal(true)
    expect(direct.role).to.equal('officer')
    expect(direct.acceptTokenAttestations).to.equal(true)
    expect(direct.peerId8).to.equal(ctx.peerId8)
    expect(Object.keys(direct).sort()).to.deep.equal([...READBACK_KEYS].sort())
    const cap = (await ctx.built.ownerNode) !== null
    expect(cap).to.equal(true)
    await inProcess.close('spec')
    inProcess = undefined
    expect(existsSync(join(peerDir, PEER_FILES.lock))).to.equal(false)
    expect(existsSync(join(peerDir, CTL_PORT_FILE))).to.equal(false)
  })

  it('a relay that never answers fails the boot with a named token inside the bound', async () => {
    const port = await closedPort()
    const deadEnv = join(root, 'dead-relay.env')
    writeRelayEnv(deadEnv, `/ip4/127.0.0.1/tcp/${port}/ws/p2p/${relayPeerIdOf(relay.multiaddr)}`)
    const partyD = `${party}-d`
    const dir = join(run, partyD, 'officer')
    const started = Date.now()
    const dead = track(await startDaemon({ role: 'officer', peerDir: dir, relayEnvPath: deadEnv, party: partyD, extra: ['--relay-ready-ms', '5000', '--boot-timeout-ms', '60000'], logDir: logs, bootBoundMs: 120000 }))
    expect(dead.ready).to.equal(false)
    expect(dead.bootFailedToken).to.be.oneOf(['relay-reservation-timeout', 'boot-timeout'])
    const code = await dead.waitExit(120000 - (Date.now() - started))
    expect(code).to.equal(1)
    expect(existsSync(join(dir, CTL_PORT_FILE))).to.equal(false)
    expect(existsSync(join(dir, PEER_FILES.lock))).to.equal(false)
    const boot = JSON.parse(readFileSync(join(dir, 'boot-1.json'), 'utf8')) as { failed?: { token: string, chain: string[] } }
    expect(boot.failed?.token).to.equal(dead.bootFailedToken)
    expect(dead.stdoutText()).to.include(`VT-DAEMON-STOPPED role=officer peer=officer reason=boot-failed`)
    registerPeerSecrets(dir)
  })

  it('the run launcher starts and stops a real officer daemon over its default argv', async () => {
    const launcherMod = (await import(pathToFileURL(join(PACKAGE_ROOT, 'dist', 'run', 'daemon-launcher.js')).href)) as { createDaemonLauncher: typeof CreateDaemonLauncher }
    const scanMod = (await import(pathToFileURL(join(PACKAGE_ROOT, 'dist', 'run', 'secret-scan.js')).href)) as { SecretRegistry: new () => RunSecretRegistry }
    const partyL = `${party}-l`
    const stateDir = join(root, 'launch')
    const evDir = join(root, 'launch-ev')
    mkdirSync(evDir, { recursive: true, mode: 0o700 })
    const launcher = launcherMod.createDaemonLauncher({
      stateDir,
      party: partyL,
      relayEnvPath: relay.relayEnvPath,
      evDir,
      registry: new scanMod.SecretRegistry(),
      mask: (s) => s,
      cpuProf: false,
      instruments: false
    })
    const handle = await launcher.start({ label: 'officer', role: 'officer', kind: 'authority', labels: ['officer'] })
    const dir = join(stateDir, partyL, 'officer')
    expect(handle.dir).to.equal(dir)
    registerPeerSecrets(dir)
    const r = await handle.call('readback', {})
    expect(r.ok, r.ok ? '' : `${r.error.name} ${r.error.code ?? ''} unreachable=${String(r.unreachable)}`).to.equal(true)
    if (r.ok) {
      expect(r.result.circuitReady).to.equal(true)
      expect(r.result.role).to.equal('officer')
    }
    const stopped = await launcher.stopAll()
    expect(stopped).to.deep.equal({ stopped: 1, killed: 0 })
    const commands = readFileSync(join(evDir, 'commands.log'), 'utf8').split('\n').filter((l) => l.length > 0)
    expect(commands.filter((l) => l.includes(' readback ok=true'))).to.have.lengthOf(1)
    expect(commands.filter((l) => l.includes(' stop ok=true'))).to.have.lengthOf(1)
    // debug.log (authority stderr) is opened lazily by the launcher on the first stderr byte; a quiet daemon writes none
    expect(existsSync(join(evDir, 'officer.log'))).to.equal(true)
    expect(readFileSync(join(evDir, 'officer.log'), 'utf8')).to.include('VT-DAEMON-READY role=officer peer=officer boot=1')
    expect(existsSync(join(dir, CTL_PORT_FILE))).to.equal(false)
  })

  it('no daemon log or record holds a ctl token, the peer key or the relay address', () => {
    expect(registry.size).to.be.at.least(10)
    const records = join(root, 'records')
    mkdirSync(records, { recursive: true, mode: 0o700 })
    let copied = 0
    for (const stateRoot of [run, join(root, 'launch')]) {
      if (!existsSync(stateRoot)) continue
      for (const p of readdirSync(stateRoot)) {
        for (const label of readdirSync(join(stateRoot, p))) {
          const peerDir = join(stateRoot, p, label)
          if (!statSync(peerDir).isDirectory()) continue
          const dest = join(records, `${p}-${label}`)
          mkdirSync(dest, { recursive: true, mode: 0o700 })
          for (const f of readdirSync(peerDir)) {
            if (/^boot-\d+\.json$/.test(f) || f === PEER_FILES.daemon || f === PEER_FILES.crash) {
              copyFileSync(join(peerDir, f), join(dest, f))
              copied++
            }
          }
        }
      }
    }
    expect(copied).to.be.at.least(8)
    const scans = [scanSecrets(logs, registry), scanSecrets(records, registry), scanSecrets(join(root, 'launch-ev'), registry)]
    const total = scans.reduce((a, s) => ({ whole: a.whole + s.whole, windows: a.windows + s.windows, files: a.files + s.files }), { whole: 0, windows: 0, files: 0 })
    expect(total.files).to.be.at.least(1)
    expect(total.whole).to.equal(0)
    expect(total.windows).to.equal(0)
    for (const f of readdirSync(logs)) {
      const text = readFileSync(join(logs, f), 'utf8')
      expect(text, f).to.not.match(/12D3Koo[1-9A-HJ-NP-Za-km-z]{30,}/)
      expect(text, f).to.not.include(relay.multiaddr)
    }
  })
})
