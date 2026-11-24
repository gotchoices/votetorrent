// daemon-units.spec.ts: the role daemon's pieces without a relay or a CadreNode: env hygiene, the
// start-argument refusals (incl. the party/posture rules), the stale-build gate, the peer lock, the
// output redactor, the crash recorder, the peer check, the registry layout, the VerbContext user and
// network rules, the start-path import gate and the local `start` routing. Nothing here prints a
// token, an address or a full peer id; fakes are built at runtime.

import { expect } from 'chai'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli, type CliIo } from '../src/cli/run-cli.js'
import { SecretRegistry } from '../src/secrecy/redact.js'
import { writeRelayEnv } from '../src/relay/relay-env.js'
import { openFileKv, type FileKvStorage } from '../src/vault/file-kv.js'
import { defaultMaxPeers } from '../src/run/peer-budget.js'
import { parseRunElectionArgs } from '../src/run/options.js'
import { DEBUG_ALLOWED_PREFIXES, DEBUG_REDACTED_NAMESPACES, applyDaemonEnv, filterDebugNamespaces } from '../src/daemon/daemon-env.js'
import { RESERVED_PARTIES, TEST_POSTURE_FLAGS, isReservedParty, startPostureOf } from '../src/daemon/posture.js'
import { parseStartArgs, type StartOptions } from '../src/daemon/start-args.js'
import { runStart } from '../src/daemon/start-command.js'
import { acquirePeerLock } from '../src/daemon/peer-lock.js'
import { installOutputRedaction, type RedactableStream } from '../src/daemon/output-redaction.js'
import { createErrorRecorder } from '../src/daemon/error-recorder.js'
import { ROLE_VERB_ENTRIES, buildPeerRegistry, withPeerCheck } from '../src/daemon/registries.js'
import { createVerbContext, type VerbContext } from '../src/daemon/verb-context.js'
import { PEER_FILES, nodeDir } from '../src/node/peer-layout.js'
import { createFileLocalStorage } from '../src/node/local-storage.js'
import type { BuiltRoleNode } from '../src/node/build-role-node.js'
import type { RoleNetworksEngineLike } from '../src/node/role-networks.js'
import type { Role } from '../src/ctl/protocol.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SRC = join(PACKAGE_ROOT, 'src')
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const GIB16 = 16 * 1024 * 1024 * 1024

function fakePeerId(seed: number): string {
  let id = '12D3KooW'
  for (let i = 0; i < 44; i++) id += BASE58[(i * 7 + seed) % BASE58.length]
  return id
}

function capture(): CliIo & { out_: string[], err_: string[] } {
  const out_: string[] = []
  const err_: string[] = []
  return { out_, err_, out: (t) => { out_.push(t) }, err: (t) => { err_.push(t) } }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    const err = e as { name?: string, code?: string, message?: string }
    expect(err.name).to.equal('StartArgsError')
    expect(err.message).to.equal(err.code)
    return err.code ?? ''
  }
  return 'no-throw'
}

describe('daemon units', function () {
  this.timeout(60000)
  let root: string
  let kv: FileKvStorage | undefined
  const parseEnv = { totalmem: () => GIB16, repoRoot: REPO_ROOT, defaultMaxPeers }
  const good = (party = 'party-x', label = 'officer', extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    state: join(root, party, label),
    relay: join(root, 'relay.env'),
    party,
    ...extra
  })
  const parse = (role: Role, args: Record<string, unknown>): StartOptions => parseStartArgs(role, args, parseEnv)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vt-23-daemon-'))
    chmodSync(root, 0o700)
  })

  afterEach(() => {
    kv?.close()
    kv = undefined
    rmSync(root, { recursive: true, force: true })
  })

  it('DEBUG keeps only optimystic and sereus namespaces and always excludes the secret-bearing ones', () => {
    expect(DEBUG_ALLOWED_PREFIXES).to.deep.equal(['optimystic:', 'sereus:'])
    expect(DEBUG_REDACTED_NAMESPACES).to.have.lengthOf(11)
    expect(DEBUG_REDACTED_NAMESPACES).to.include('sereus:cadre:invite-proto')
    expect(DEBUG_REDACTED_NAMESPACES).to.include('sereus:cadre:strand-party-key-rotation')
    expect(DEBUG_REDACTED_NAMESPACES).to.include('sereus:cadre:push:*')
    const r = filterDebugNamespaces('optimystic:*,libp2p:*,* sereus:cadre:timing,-optimystic:db-core:x,garbage;x')
    expect(r.kept).to.equal(3)
    expect(r.dropped).to.equal(3)
    const tokens = (r.value ?? '').split(',')
    expect(tokens.slice(0, 3)).to.deep.equal(['optimystic:*', 'sereus:cadre:timing', '-optimystic:db-core:x'])
    for (const ns of DEBUG_REDACTED_NAMESPACES) expect(tokens).to.include(`-${ns}`)
    expect(tokens).to.have.lengthOf(3 + DEBUG_REDACTED_NAMESPACES.length)
    expect(filterDebugNamespaces('libp2p:*')).to.deep.equal({ value: undefined, kept: 0, dropped: 1 })
    expect(filterDebugNamespaces(undefined)).to.deep.equal({ value: undefined, kept: 0, dropped: 0 })
    expect(filterDebugNamespaces('')).to.deep.equal({ value: undefined, kept: 0, dropped: 0 })
    expect(filterDebugNamespaces('sereus:cadre:invite-proto').value?.split(',')).to.include('-sereus:cadre:invite-proto')
  })

  it('applyDaemonEnv forces FORCE_COLOR, DEBUG_COLORS and DEBUG_HIDE_DATE to 0 and drops DUMP_SESSION_KEYS', () => {
    const env: NodeJS.ProcessEnv = {
      FORCE_COLOR: '3',
      DEBUG_COLORS: '1',
      DEBUG_HIDE_DATE: '1',
      DUMP_SESSION_KEYS: '/tmp/keys',
      NODE_OPTIONS: '--max-old-space-size=100',
      DEBUG: 'optimystic:db-p2p:cluster,libp2p:*',
      PATH: '/usr/bin'
    }
    const report = applyDaemonEnv(env)
    expect(env.FORCE_COLOR).to.equal('0')
    expect(env.DEBUG_COLORS).to.equal('0')
    expect(env.DEBUG_HIDE_DATE).to.equal('0')
    expect(Object.hasOwn(env, 'DUMP_SESSION_KEYS')).to.equal(false)
    expect(env.PATH).to.equal('/usr/bin')
    expect(report).to.deep.equal({ debugKept: 1, debugDropped: 1, nodeOptionsSet: true })
    expect(env.DEBUG?.startsWith('optimystic:db-p2p:cluster,-')).to.equal(true)
    const bare: NodeJS.ProcessEnv = { DEBUG: '*' }
    const report2 = applyDaemonEnv(bare)
    expect(report2).to.deep.equal({ debugKept: 0, debugDropped: 1, nodeOptionsSet: false })
    expect(Object.hasOwn(bare, 'DEBUG')).to.equal(false)
    expect(bare.FORCE_COLOR).to.equal('0')
  })

  it('start args refuse a missing, relative, in-repo or mis-laid state dir without echoing it', () => {
    expect(codeOf(() => parse('officer', { relay: join(root, 'r'), party: 'party-x' }))).to.equal('state-missing')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { state: 'rel/party-x/officer' })))).to.equal('state-relative')
    const inRepo = join(REPO_ROOT, 'packages', 'vote-cli', 'vt23-state-probe', 'party-x', 'officer')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { state: inRepo })))).to.equal('state-in-repo')
    expect(existsSync(join(REPO_ROOT, 'packages', 'vote-cli', 'vt23-state-probe'))).to.equal(false)
    expect(codeOf(() => parse('officer', { ...good(), state: join(root, 'party-x', 'Officer!') }))).to.equal('label-shape')
    expect(codeOf(() => parse('officer', { ...good(), state: join(root, 'party-x', '1bad') }))).to.equal('label-shape')
    expect(codeOf(() => parse('officer', { ...good(), state: join(root, 'other', 'officer') }))).to.equal('layout-party')
    const ok = parse('officer', good())
    expect(ok.label).to.equal('officer')
    expect(ok.peerDir).to.equal(join(root, 'party-x', 'officer'))
    expect(ok.partyDir).to.equal(join(root, 'party-x'))
    expect(ok.runRoot).to.equal(root)
    expect(ok.repoRoot).to.equal(resolve(REPO_ROOT))
    expect(ok.labels).to.deep.equal([{ label: 'officer', role: 'officer' }])
    expect(ok.colocate).to.equal(null)
    expect(existsSync(join(root, 'party-x'))).to.equal(false)
  })

  it('start args refuse a missing, malformed or production party id', () => {
    expect(codeOf(() => parse('officer', { state: join(root, 'party-x', 'officer'), relay: join(root, 'r') }))).to.equal('party-missing')
    expect(codeOf(() => parse('officer', good('AB')))).to.equal('party-shape')
    expect(codeOf(() => parse('officer', good('-bad')))).to.equal('party-shape')
    expect(codeOf(() => parse('officer', good('votetorrent-relay')))).to.equal('party-reserved')
    expect(codeOf(() => parse('officer', good('votetorrent', 'officer', { acceptTokenAttestations: true })))).to.equal('production-party')
    expect(codeOf(() => parse('officer', good('votetorrent-relay', 'officer', { acceptTokenAttestations: true })))).to.equal('production-party')
    const bare = parse('officer', good('votetorrent'))
    expect(bare.partyId).to.equal('votetorrent')
    expect(bare.posture).to.equal('production')
    expect(bare.acceptTokenAttestations).to.equal(false)
    expect(parse('keyholder', good('votetorrent', 'kh-a')).posture).to.equal('production')
    expect(parse('voter', good('votetorrent', 'v1')).posture).to.equal('production')
    expect(RESERVED_PARTIES).to.deep.equal(['votetorrent', 'votetorrent-relay'])
    expect(isReservedParty(' VoteTorrent ')).to.equal(true)
    expect(isReservedParty('votetorrent-relay')).to.equal(true)
    expect(isReservedParty('vt23-party')).to.equal(false)
    expect(startPostureOf({})).to.equal('production')
    expect(startPostureOf({ acceptTokenAttestations: true })).to.equal('test')
  })

  it('start args refuse a bad colocate list (shape, duplicate, primary missing, non-authority label, voter)', () => {
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { colocate: 'officer' })))).to.equal('colocate-shape')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { colocate: true })))).to.equal('colocate-shape')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { colocate: 'officer,Kh-A' })))).to.equal('colocate-shape')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { colocate: 'officer,officer' })))).to.equal('colocate-duplicate')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { colocate: 'kh-a,kh-b' })))).to.equal('colocate-primary')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { colocate: 'officer,v1' })))).to.equal('colocate-label')
    expect(codeOf(() => parse('voter', good('party-x', 'v1', { colocate: 'v1,kh-a' })))).to.equal('colocate-voter')
    const ok = parse('officer', good('party-x', 'officer', { colocate: 'officer,kh-a,kh-b' }))
    expect(ok.colocate).to.deep.equal(['officer', 'kh-a', 'kh-b'])
    expect(ok.labels).to.deep.equal([
      { label: 'kh-a', role: 'keyholder' },
      { label: 'kh-b', role: 'keyholder' },
      { label: 'officer', role: 'officer' }
    ])
    const khPrimary = parse('keyholder', good('party-x', 'kh-a', { colocate: 'officer,kh-a' }))
    expect(khPrimary.labels).to.deep.equal([{ label: 'officer', role: 'officer' }, { label: 'kh-a', role: 'keyholder' }])
  })

  it('start args accept --accept-token-attestations for the officer only and refuse a valued flag', () => {
    expect(TEST_POSTURE_FLAGS).to.deep.equal([{ flag: '--accept-token-attestations', key: 'acceptTokenAttestations', roles: ['officer'] }])
    const ok = parse('officer', good('party-x', 'officer', { acceptTokenAttestations: true }))
    expect(ok.acceptTokenAttestations).to.equal(true)
    expect(ok.posture).to.equal('test')
    expect(codeOf(() => parse('keyholder', good('party-x', 'kh-a', { acceptTokenAttestations: true })))).to.equal('posture-role')
    expect(codeOf(() => parse('voter', good('party-x', 'v1', { acceptTokenAttestations: true })))).to.equal('posture-role')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { acceptTokenAttestations: 'yes' })))).to.equal('posture-shape')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { acceptTokenAttestations: 'true' })))).to.equal('posture-shape')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { acceptTokenAttestations: false })))).to.equal('posture-shape')
  })

  it('start args refuse --max-peers below the colocated peer count, bad numeric bounds, an unknown flag and a missing relay', () => {
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { colocate: 'officer,kh-a', maxPeers: '1' })))).to.equal('max-peers')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { maxPeers: '0' })))).to.equal('max-peers-shape')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { maxPeers: 'abc' })))).to.equal('max-peers-shape')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { maxPeers: '10000' })))).to.equal('max-peers-shape')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { relayReadyMs: '999' })))).to.equal('relay-ready-ms')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { relayReadyMs: '90001' })))).to.equal('relay-ready-ms')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { bootTimeoutMs: '1000' })))).to.equal('boot-timeout-ms')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { maxRuntimeMs: '1' })))).to.equal('max-runtime-ms')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { peer: '/x' })))).to.equal('unknown-flag')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { tokenFile: '/x' })))).to.equal('unknown-flag')
    expect(codeOf(() => parse('officer', { state: join(root, 'party-x', 'officer'), party: 'party-x' }))).to.equal('relay-missing')
    expect(codeOf(() => parse('officer', good('party-x', 'officer', { relay: 'relay.env' })))).to.equal('relay-missing')
    const ok = parse('officer', good('party-x', 'officer', { colocate: 'officer,kh-a', maxPeers: '2', relayReadyMs: '1000', bootTimeoutMs: '30000', maxRuntimeMs: '60000', instruments: true }))
    expect(ok.maxPeers).to.equal(2)
    expect(ok.relayReadyMs).to.equal(1000)
    expect(ok.bootTimeoutMs).to.equal(30000)
    expect(ok.maxRuntimeMs).to.equal(60000)
    expect(ok.instruments).to.equal(true)
    const defaults = parse('officer', good())
    expect(defaults.maxPeers).to.equal(defaultMaxPeers(GIB16))
    expect(defaults.relayReadyMs).to.equal(90000)
    expect(defaults.bootTimeoutMs).to.equal(300000)
    expect(defaults.maxRuntimeMs).to.equal(14400000)
    expect(defaults.instruments).to.equal(false)
  })

  it('a stale build refuses the start with exit 2 before the daemon module loads', async () => {
    const io = capture()
    let loads = 0
    const stale = Object.assign(new Error('workflows dist is older than its src'), { name: 'StaleBuildError', code: 'stale', target: 'workflows' })
    const code = await runStart('officer', good(), io, {
      assertFresh: () => { throw stale },
      loadMain: async () => { loads++; return { runDaemon: async () => 0 } },
      totalmem: () => GIB16
    })
    expect(code).to.equal(2)
    expect(loads).to.equal(0)
    expect(io.out_.join('')).to.include('VT-DAEMON-BOOT-FAILED role=officer peer=? token=stale-build\n')
    expect(io.err_.join('')).to.include('start refused (stale-build)')
    expect(io.err_.join('')).to.not.include(root)
    expect(existsSync(join(root, 'party-x'))).to.equal(false)
  })

  it("the peer-dir lock refuses a second live daemon and replaces a dead one's lock", () => {
    const peerDir = join(root, 'party-x', 'officer')
    mkdirSync(peerDir, { recursive: true, mode: 0o700 })
    const lock = acquirePeerLock(peerDir)
    const file = join(peerDir, PEER_FILES.lock)
    expect(readFileSync(file, 'utf8')).to.equal(`${process.pid}\n`)
    expect(statSync(file).mode & 0o777).to.equal(0o600)
    let err: unknown
    try {
      acquirePeerLock(peerDir)
    } catch (e) {
      err = e
    }
    expect((err as { name?: string, code?: string }).name).to.equal('PeerLockError')
    expect((err as { code?: string }).code).to.equal('peer-dir-busy')
    lock.release()
    expect(existsSync(file)).to.equal(false)
    lock.release()
    const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
    expect(dead.status).to.equal(0)
    expect(typeof dead.pid).to.equal('number')
    writeFileSync(file, `${dead.pid}\n`, { mode: 0o600 })
    const again = acquirePeerLock(peerDir)
    expect(readFileSync(file, 'utf8')).to.equal(`${process.pid}\n`)
    writeFileSync(file, 'garbage', { mode: 0o600 })
    again.release()
    expect(existsSync(file)).to.equal(true)
    rmSync(file)
    const third = acquirePeerLock(peerDir)
    third.release()
  })

  it('the output redactor masks tokens, their windows, the private relay address and full peer ids line by line', () => {
    const registry = new SecretRegistry()
    const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f91'
    const relayId = fakePeerId(3)
    const relayAddr = `/ip4/127.0.0.1/tcp/4321/ws/p2p/${relayId}`
    const other = fakePeerId(7)
    registry.add(token, { windows: true })
    registry.add(relayAddr)
    registry.add(relayId)
    const captured: string[] = []
    const callbacks: number[] = []
    const stream: RedactableStream = {
      write(chunk, encoding, cb) {
        captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
        const done = typeof encoding === 'function' ? encoding : cb
        if (done !== undefined) {
          callbacks.push(1)
          done()
        }
        return true
      }
    }
    const installed = installOutputRedaction({ redactor: registry.redactor(), streams: [stream] })
    const prefix = '2026-11-24T15:00:00.000Z optimystic:db-p2p:cluster '
    stream.write(`${prefix}response peer=${other} token=${token.slice(0, 40)}`)
    expect(captured).to.deep.equal([])
    stream.write(`${token.slice(40)} relay=${relayAddr}\nsecond line window ${token.slice(10, 26)} id=${relayId}\n`, () => {})
    expect(captured).to.have.lengthOf(1)
    const lines = captured[0]!.split('\n')
    expect(lines).to.have.lengthOf(3)
    expect(lines[0]!.startsWith(prefix)).to.equal(true)
    expect(lines[0]).to.include(`<peer:${other.slice(-8)}>`)
    expect(lines[0]).to.include('token=<secret>')
    expect(lines[0]).to.include('relay=<secret>')
    expect(lines[1]).to.equal('second line window <secret> id=<secret>')
    expect(lines[2]).to.equal('')
    expect(captured[0]).to.not.include(token)
    expect(captured[0]).to.not.include(relayAddr)
    expect(captured[0]).to.not.include(other)
    expect(callbacks).to.have.lengthOf(1)
    stream.write(Buffer.from(`tail ${token}`), 'utf8')
    expect(captured).to.have.lengthOf(1)
    installed.uninstall()
    expect(captured).to.have.lengthOf(2)
    expect(captured[1]).to.equal('tail <secret>')
    stream.write('after uninstall\n')
    expect(captured[2]).to.equal('after uninstall\n')
    const big = installOutputRedaction({ redactor: registry.redactor(), streams: [stream] })
    captured.length = 0
    stream.write(`${'x'.repeat(70 * 1024)} ${token}`)
    expect(captured).to.have.lengthOf(1)
    expect(captured[0]!.endsWith(' <secret>')).to.equal(true)
    big.uninstall()
  })

  it('the error recorder writes a redacted, stack-free 0600 record and stops at its cap', () => {
    const registry = new SecretRegistry()
    const secret = 'planted-secret-value-0123456789abcdef'
    registry.add(secret, { windows: true })
    const file = join(root, 'crash.jsonl')
    const recorder = createErrorRecorder({ file, redactor: registry.redactor(), maxRecords: 2, now: () => 1700000000000 })
    const inner = Object.assign(new Error('inner'), { name: 'InnerBoom' })
    const err = Object.assign(new Error(`boom ${secret} ${'z'.repeat(300)}`), { name: 'BoomError', code: 'boom-code', cause: inner })
    recorder.record('verb.readback', err)
    expect(statSync(file).mode & 0o777).to.equal(0o600)
    const line1 = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0)
    expect(line1).to.have.lengthOf(1)
    const rec = JSON.parse(line1[0]!) as Record<string, unknown>
    expect(Object.keys(rec)).to.deep.equal(['at', 'where', 'name', 'code', 'message', 'chain'])
    expect(rec.at).to.equal(new Date(1700000000000).toISOString())
    expect(rec.where).to.equal('verb.readback')
    expect(rec.name).to.equal('BoomError')
    expect(rec.code).to.equal('boom-code')
    expect(rec.chain).to.deep.equal(['BoomError', 'InnerBoom'])
    expect((rec.message as string).length).to.be.at.most(200)
    expect(rec.message).to.include('<secret>')
    expect(line1[0]).to.not.include(secret)
    expect(line1[0]).to.not.include('stack')
    recorder.record('verb.stop', new Error('two'))
    recorder.record('verb.stop', new Error('three'))
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0)
    expect(lines).to.have.lengthOf(2)
    expect(recorder.count).to.equal(2)
    const noCode = JSON.parse(lines[1]!) as Record<string, unknown>
    expect(Object.keys(noCode)).to.deep.equal(['at', 'where', 'name', 'message', 'chain'])
    const file2 = join(root, 'crash2.jsonl')
    const r2 = createErrorRecorder({ file: file2, redactor: registry.redactor() })
    const out: string[] = []
    const proc = Object.assign(new EventEmitter(), { stdout: { write: (s: string) => { out.push(s); return true } } })
    r2.installProcessHandlers(proc)
    proc.emit('uncaughtException', Object.assign(new Error('late'), { name: 'Late Name!' }))
    proc.emit('unhandledRejection', 'a string reason')
    expect(out).to.deep.equal(['VT-DAEMON-LATE kind=uncaught name=Error\n', 'VT-DAEMON-LATE kind=unhandled name=Error\n'])
    const recs = readFileSync(file2, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(recs.map((r) => r.where)).to.deep.equal(['uncaught', 'unhandled'])
  })

  it("the peer check strips a matching peer argument and refuses another peer's label", async () => {
    const seen: Array<Record<string, unknown>> = []
    const handler = withPeerCheck('officer', async (_ctx, args) => {
      seen.push(args)
      return { ok: 1 }
    })
    const ctx = {} as VerbContext
    expect(await handler(ctx, { peer: 'officer', x: 1 })).to.deep.equal({ ok: 1 })
    expect(await handler(ctx, { x: 2 })).to.deep.equal({ ok: 1 })
    expect(seen).to.deep.equal([{ x: 1 }, { x: 2 }])
    for (const bad of [{ peer: 'kh-a' }, { peer: 5 }, { peer: '' }, { peer: ['officer'] }]) {
      let err: unknown
      try {
        await handler(ctx, bad as Record<string, unknown>)
      } catch (e) {
        err = e
      }
      expect((err as { name?: string }).name).to.equal('WrongPeer')
      expect((err as { code?: string }).code).to.equal('wrong-peer')
    }
    expect(seen).to.have.lengthOf(2)
  })

  it('role registries: officer and keyholder hold capability, readback and stop; voter holds readback and stop; each file is one frozen object of one-line spreads', () => {
    expect(Object.keys(ROLE_VERB_ENTRIES).sort()).to.deep.equal(['keyholder', 'officer', 'voter'])
    for (const role of ['officer', 'keyholder'] as const) {
      const names = buildPeerRegistry(role, 'x').names()
      expect(names).to.include.members(['capability', 'readback', 'stop'])
    }
    const voter = buildPeerRegistry('voter', 'v1').names()
    expect(voter).to.include.members(['readback', 'stop'])
    expect(voter).to.not.include('capability')
    expect(Object.isFrozen(ROLE_VERB_ENTRIES.officer)).to.equal(true)
    for (const role of ['officer', 'keyholder', 'voter'] as const) {
      const text = readFileSync(join(SRC, 'verbs', role, 'registry.ts'), 'utf8')
      const lines = text.split('\n')
      const opens = lines.filter((l) => l.includes('Object.freeze({'))
      expect(opens, role).to.have.lengthOf(1)
      const open = lines.indexOf(opens[0]!)
      expect(opens[0]).to.equal(`export const ${role.toUpperCase()}_VERB_ENTRIES: Readonly<Record<string, VerbHandler<VerbContext>>> = Object.freeze({`)
      const close = lines.indexOf('})', open)
      expect(close, role).to.be.greaterThan(open)
      const members = lines.slice(open + 1, close)
      expect(members.length, role).to.be.at.least(1)
      for (const m of members) expect(m, `${role}: ${m}`).to.match(/^ {2}\.\.\.[A-Z_]+,$/)
      expect(members[0]).to.equal('  ...COMMON_VERBS,')
      if (role === 'voter') expect(text).to.not.include('AUTHORITY_COMMON_VERBS')
      else expect(members[1]).to.equal('  ...AUTHORITY_COMMON_VERBS,')
    }
    expect(existsSync(join(SRC, 'daemon', 'role-verbs.ts'))).to.equal(false)
  })

  it('the VerbContext refuses a private user field, a second user and an unknown network', async () => {
    const peerDir = join(root, 'party-x', 'officer')
    mkdirSync(nodeDir(peerDir), { recursive: true, mode: 0o700 })
    kv = openFileKv({ path: join(nodeDir(peerDir), PEER_FILES.asyncStorage) })
    const lsKv = openFileKv({ path: join(nodeDir(peerDir), PEER_FILES.localStorage) })
    const localStorage = createFileLocalStorage(lsKv)
    const opened: string[] = []
    const engine = {
      async open(ref: { hash: string }) {
        opened.push(ref.hash)
        return {}
      },
      getEstablishedContext(hash: string) {
        return { db: { hash } }
      }
    } as unknown as RoleNetworksEngineLike
    let engineBuilds = 0
    const built = { node: {}, kind: 'authority', peerId: fakePeerId(5), peerId8: fakePeerId(5).slice(-8), stores: {} } as unknown as BuiltRoleNode
    const exits: string[] = []
    const ctx = createVerbContext({
      role: 'officer',
      label: 'officer',
      partyId: 'party-x',
      peerDir,
      bootN: 1,
      bootId: 'officer-1-1',
      built,
      relay: { multiaddr: '/ip4/127.0.0.1/tcp/1/ws/p2p/x', peerId: 'x', private: true },
      kv,
      localStorage,
      device: { keys: {}, vault: { authPromptCount: 3 }, storage: {}, close: () => {} } as unknown as Parameters<typeof createVerbContext>[0]['device'],
      secrets: new SecretRegistry(),
      redactor: (s) => s,
      acceptTokenAttestations: false,
      posture: 'production',
      instruments: false,
      record: () => {},
      exit: async (reason) => { exits.push(reason) },
      createEngine: () => { engineBuilds++; return engine }
    })
    expect(ctx.user).to.equal(null)
    expect(ctx.secretsDir).to.equal(join(peerDir, 'secrets'))
    expect(ctx.node).to.equal(built.node)
    expect(ctx.authPrompts).to.equal(3)
    expect(ctx.peerId8).to.have.lengthOf(8)
    let err: unknown
    try {
      await ctx.saveUser({ id: 'u1', name: 'Officer', activeKeys: [], privateHex: 'deadbeef' } as never)
    } catch (e) {
      err = e
    }
    expect((err as { name?: string, code?: string }).name).to.equal('VerbContextError')
    expect((err as { code?: string }).code).to.equal('user-private-field')
    expect(ctx.user).to.equal(null)
    expect(existsSync(join(nodeDir(peerDir), PEER_FILES.user))).to.equal(false)
    const u1 = { id: 'u1', name: 'Officer', activeKeys: [] }
    await ctx.saveUser(u1)
    expect(statSync(join(nodeDir(peerDir), PEER_FILES.user)).mode & 0o777).to.equal(0o600)
    expect(ctx.user?.id).to.equal('u1')
    err = undefined
    try {
      await ctx.saveUser({ id: 'u2', name: 'Other', activeKeys: [] })
    } catch (e) {
      err = e
    }
    expect((err as { code?: string }).code).to.equal('user-exists')
    await ctx.saveUser({ id: 'u1', name: 'Officer renamed', activeKeys: [] })
    expect(ctx.user?.name).to.equal('Officer renamed')
    err = undefined
    try {
      await ctx.openNetwork('nohash')
    } catch (e) {
      err = e
    }
    expect((err as { name?: string, code?: string }).name).to.equal('NetworkOpenError')
    expect((err as { code?: string }).code).to.equal('network-not-open')
    expect(engineBuilds).to.equal(1)
    await localStorage.setItem('recentNetworks', [{ hash: 'nohash', name: 'n', primaryAuthorityDomainName: 'a', relays: [] }])
    const first = await ctx.openNetwork('nohash')
    const second = await ctx.openNetwork('nohash')
    expect(first).to.equal(second)
    expect(opened).to.deep.equal(['nohash'])
    expect(engineBuilds).to.equal(1)
    expect(first.ref.hash).to.equal('nohash')
    await ctx.exit('stop-verb')
    expect(exits).to.deep.equal(['stop-verb'])
    lsKv.close()
  })

  it('the start path loads no engine package before the daemon env is applied', () => {
    const files = ['start-command.ts', 'start-args.ts', 'daemon-env.ts', 'peer-lock.ts']
    let dynamicImports = 0
    for (const f of files) {
      const text = readFileSync(join(SRC, 'daemon', f), 'utf8')
      const packageImports = text.split('\n').filter((l) => /^import .* from '@/.test(l))
      expect(packageImports, f).to.deep.equal([])
      dynamicImports += (text.match(/import\(/g) ?? []).length
    }
    expect(dynamicImports).to.equal(1)
    const startCommand = readFileSync(join(SRC, 'daemon', 'start-command.ts'), 'utf8')
    expect((startCommand.match(/import\('\.\/main\.js'\)/g) ?? []).length).to.equal(1)
    const posture = readFileSync(join(SRC, 'daemon', 'posture.ts'), 'utf8')
    expect(posture.split('\n').filter((l) => /^import .* from '@/.test(l))).to.deep.equal([])
    const marker = readFileSync(join(SRC, 'attestation', 'marker.ts'), 'utf8')
    expect(marker.split('\n').filter((l) => /^import /.test(l))).to.deep.equal([])
  })

  it('vt <role> start is handled locally: missing flags exit 2 and nothing is sent over ctl', async () => {
    const io = capture()
    const code = await runCli(['officer', 'start'], io)
    expect(code).to.equal(2)
    expect(io.err_.join('')).to.include('start refused (state-missing)')
    expect(io.err_.join('')).to.not.include('has no local handler')
    expect(io.out_.join('')).to.include('VT-DAEMON-BOOT-FAILED role=officer peer=? token=usage\n')
    const io2 = capture()
    const code2 = await runCli(['voter', 'start', '--state', join(root, 'party-x', 'v1'), '--relay', join(root, 'relay.env'), '--party', 'party-x', '--colocate', 'v1,kh-a'], io2)
    expect(code2).to.equal(2)
    expect(io2.err_.join('')).to.include('start refused (colocate-voter)')
    expect(io2.err_.join('')).to.not.include(root)
    expect(existsSync(join(root, 'party-x'))).to.equal(false)
  })

  it('party votetorrent: a bare start is allowed as posture production, a test posture is refused production-party, and vt run election still refuses the party', async () => {
    for (const [role, label] of [['officer', 'officer'], ['keyholder', 'kh-a'], ['voter', 'v1']] as const) {
      const io = capture()
      let loads = 0
      let received: unknown
      const code = await runStart(role, good('votetorrent', label), io, {
        assertFresh: () => [],
        loadMain: async () => {
          loads++
          return { runDaemon: async (opts) => { received = opts; return 0 } }
        },
        totalmem: () => GIB16
      })
      expect(code, role).to.equal(0)
      expect(loads, role).to.equal(1)
      const postureLines = io.out_.join('').split('\n').filter((l) => l.startsWith('VT-DAEMON-POSTURE'))
      expect(postureLines, role).to.deep.equal(['VT-DAEMON-POSTURE party=votetorrent posture=production'])
      const opts = received as StartOptions & { envReport: unknown }
      expect(opts.role).to.equal(role)
      expect(opts.label).to.equal(label)
      expect(opts.posture).to.equal('production')
      expect(opts.envReport).to.not.equal(undefined)
      expect(io.err_.join('')).to.equal('')
    }
    for (const party of ['votetorrent', 'votetorrent-relay']) {
      const io = capture()
      let loads = 0
      const code = await runStart('officer', good(party, 'officer', { acceptTokenAttestations: true }), io, {
        assertFresh: () => [],
        loadMain: async () => { loads++; return { runDaemon: async () => 0 } },
        totalmem: () => GIB16
      })
      expect(code, party).to.equal(2)
      expect(loads, party).to.equal(0)
      expect(io.err_.join(''), party).to.include('start refused (production-party)')
      expect(io.out_.join(''), party).to.include('VT-DAEMON-BOOT-FAILED role=officer peer=? token=production-party\n')
      expect(io.out_.join(''), party).to.not.include('VT-DAEMON-POSTURE')
      expect(existsSync(join(root, party)), party).to.equal(false)
    }
    const relayEnv = join(root, 'relay.env')
    writeRelayEnv(relayEnv, `/ip4/127.0.0.1/tcp/4001/ws/p2p/${fakePeerId(3)}`)
    for (const party of ['votetorrent', 'votetorrent-relay']) {
      let err: unknown
      try {
        parseRunElectionArgs(['--relay', relayEnv, '--state', join(root, 'run'), '--party', party])
      } catch (e) {
        err = e
      }
      expect((err as { name?: string, code?: string }).name, party).to.equal('RunUsageError')
      expect((err as { code?: string }).code, party).to.equal('party-production')
    }
  })
})
