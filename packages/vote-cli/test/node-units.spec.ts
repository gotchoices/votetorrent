// node-units.spec.ts: the role node builder with FAKE engine deps (no CadreNode starts, no socket
// opens). The peer key uses the real libp2p key helpers; the kv is a real file kv in a temp dir.
// Nothing here prints a key, an address or a peer id; the fake relay id is built at runtime and the
// error-message assertions compare against it without echoing it.

import { expect } from 'chai'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { AUTHORITY_JOIN_BOOTSTRAP_KEY, AUTHORITY_JOINED_NETWORKS_KEY, isJoinedNetworksUnreadableError } from '@votetorrent/workflows'
import { openFileKv, type FileKvStorage } from '../src/vault/file-kv.js'
import { PEER_FILES, bootFile, nodeDir, safeScope, scopeDir, secretsDir, storeDir } from '../src/node/peer-layout.js'
import { loadOrCreatePeerKey } from '../src/node/peer-key.js'
import { createScopedStorage } from '../src/node/scoped-storage.js'
import { fileSlot, slotKey } from '../src/node/durable-slots.js'
import { createFileLocalStorage } from '../src/node/local-storage.js'
import { RELAY_READY_MAX_MS, awaitRelayReservation, relayPeerIdOf } from '../src/node/relay-readiness.js'
import {
  AUTHORITY_CADRE_STORE_SCOPE,
  VOTER_CADRE_STORE_SCOPE,
  buildRoleNode,
  createRoleStores,
  type BuildRoleNodeOptions,
  type RoleNodeDeps
} from '../src/node/build-role-node.js'
import { openRoleNetwork, type RoleNetworksEngineLike } from '../src/node/role-networks.js'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function fakePeerId(seed: number): string {
  let id = '12D3KooW'
  for (let i = 0; i < 44; i++) id += BASE58[(i * 7 + seed) % BASE58.length]
  return id
}

const RELAY_ID = fakePeerId(3)
const OTHER_ID = fakePeerId(11)
const MEMBER_ID = fakePeerId(19)
const RELAY_ADDR = `/ip4/127.0.0.1/tcp/1/ws/p2p/${RELAY_ID}`
const circuitVia = (relay: string, self: string): string => `/ip4/127.0.0.1/tcp/1/ws/p2p/${relay}/p2p-circuit/p2p/${self}`

class FakeRaw {
  static dirs: string[] = []
  static closes: string[] = []
  readonly dir: string
  constructor(dir: string) {
    this.dir = dir
    FakeRaw.dirs.push(dir)
  }

  async close(): Promise<void> {
    FakeRaw.closes.push(this.dir)
  }
}

interface Script {
  addrs: string[]
  startError?: unknown
}

interface FakeNodeOptions {
  controlNetwork: { partyId: string, bootstrapNodes: string[] }
  storage: { provider(scope: string): unknown }
  network: {
    relayAddrs: string[]
    connectionGater: Record<string, (p: unknown) => Promise<boolean>>
    inviteAddressResolver?: () => Promise<string[]>
  }
  trustedOwners?: unknown
  strandNetworkState?: unknown
  bootstrapPeers?: unknown
  edgeReaderProtocol?: string
}

class FakeNode {
  static instances: FakeNode[] = []
  static script: Script = { addrs: [] }
  readonly options: FakeNodeOptions
  starts = 0
  stops = 0

  constructor(options: FakeNodeOptions) {
    this.options = options
    FakeNode.instances.push(this)
    // cadre-core opens the control scope through the provider at construction
    options.storage.provider('control-fake')
  }

  async start(): Promise<void> {
    this.starts++
    if (FakeNode.script.startError !== undefined) throw FakeNode.script.startError
  }

  async stop(): Promise<void> {
    this.stops++
  }

  getMultiaddrs(): string[] {
    return FakeNode.script.addrs
  }

  getControlNode(): null {
    return null
  }

  getControlDatabase(): null {
    return null
  }

  getTrustedOwnerStore(): null {
    return null
  }
}

interface Counters {
  wraps: number
  reanchors: number
  classifies: number
  hosts: number
  detaches: number
}

function fakeDeps(counters: Counters): RoleNodeDeps {
  const detach = async (): Promise<void> => {
    counters.detaches++
  }
  const deps = {
    CadreNode: FakeNode,
    controlStorageScope: (partyId: string) => `control-${partyId}`,
    PersistentTrustedOwnerStore: { open: async (slot: unknown, partyId: string) => ({ kind: 'trustedOwners', partyId, slot }) },
    PersistentStrandNetworkStateStore: { open: async (slot: unknown, partyId: string) => ({ kind: 'strandNetworkState', partyId, slot }) },
    PersistentBootstrapPeerStore: { open: async (slot: unknown, partyId: string) => ({ kind: 'bootstrapPeers', partyId, slot }) },
    ed25519KeyPairFromLibp2p: () => ({}),
    softwareOwnerSigner: () => ({}),
    FileRawStorage: FakeRaw,
    webSockets: () => ({ transport: 'ws' }),
    circuitRelayTransport: (init: unknown) => ({ transport: 'circuit', init }),
    generateKeyPair,
    privateKeyToProtobuf,
    privateKeyFromProtobuf,
    peerIdFromPrivateKey,
    createEdgeReaderRefusal: () => ({ hook: () => undefined, control: {} }),
    EDGE_READER_PROTOCOL: '/vt-test/edge-reader/1',
    registerVoteTorrentFunctions: async () => undefined,
    withIdentityOwnerKey: (node: object) => {
      counters.wraps++
      return node
    },
    reanchorOwnKey: async () => {
      counters.reanchors++
      return 'wired'
    },
    readOwnerTrustClassification: async () => {
      counters.classifies++
      return 'ok'
    },
    hostPoolRendezvous: async () => {
      counters.hosts++
      return detach
    }
  }
  return deps as unknown as RoleNodeDeps
}

function newCounters(): Counters {
  return { wraps: 0, reanchors: 0, classifies: 0, hosts: 0, detaches: 0 }
}

describe('node units', function () {
  this.timeout(60000)
  let root: string
  let kv: FileKvStorage | undefined
  const warnings: unknown[][] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vt-23-units-'))
    chmodSync(root, 0o700)
    FakeRaw.dirs = []
    FakeRaw.closes = []
    FakeNode.instances = []
    FakeNode.script = { addrs: [] }
    warnings.length = 0
  })

  afterEach(() => {
    kv?.close()
    kv = undefined
    rmSync(root, { recursive: true, force: true })
  })

  const openKv = (peerDir: string): FileKvStorage => {
    kv = openFileKv({ path: join(nodeDir(peerDir), PEER_FILES.asyncStorage) })
    return kv
  }

  const buildOpts = (role: BuildRoleNodeOptions['role'], peerDir: string, extra: Partial<BuildRoleNodeOptions> = {}): BuildRoleNodeOptions => ({
    role,
    label: role === 'voter' ? 'v1' : role,
    partyId: 'vt23-party',
    peerDir,
    relay: { multiaddr: RELAY_ADDR, peerId: RELAY_ID },
    kv: openKv(peerDir),
    warn: (...a: unknown[]) => {
      warnings.push(a)
    },
    instruments: false,
    relayReadyMs: 5000,
    bootTimeoutMs: 60000,
    ...extra
  })

  it('peer key is created once at 0600 and gives the same peer id on reload', async () => {
    const peerDir = join(root, 'p', 'officer')
    const deps = { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf }
    const k1 = await loadOrCreatePeerKey(peerDir, deps)
    const file = join(nodeDir(peerDir), PEER_FILES.peerKey)
    expect(statSync(nodeDir(peerDir)).mode & 0o777).to.equal(0o700)
    expect(statSync(file).mode & 0o777).to.equal(0o600)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(Object.keys(parsed)).to.deep.equal(['k'])
    const k2 = await loadOrCreatePeerKey(peerDir, deps)
    expect(peerIdFromPrivateKey(k1).toString()).to.equal(peerIdFromPrivateKey(k2).toString())
    expect(peerIdFromPrivateKey(k1).toString().startsWith('12D3KooW')).to.equal(true)
    expect(secretsDir(peerDir)).to.equal(join(peerDir, 'secrets'))
    expect(bootFile(2)).to.equal('boot-2.json')
  })

  it('peer key refuses a group-readable or corrupt key file without naming the path', async () => {
    const peerDir = join(root, 'p', 'officer')
    const deps = { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf }
    await loadOrCreatePeerKey(peerDir, deps)
    const file = join(nodeDir(peerDir), PEER_FILES.peerKey)
    const k = (JSON.parse(readFileSync(file, 'utf8')) as { k: string }).k
    chmodSync(file, 0o644)
    let err: unknown
    try {
      await loadOrCreatePeerKey(peerDir, deps)
    } catch (e) {
      err = e
    }
    const e1 = err as { name?: string, code?: string, message?: string }
    expect(e1.name).to.equal('PeerKeyError')
    expect(e1.code).to.equal('peer-key-mode')
    expect(e1.message).to.not.include(peerDir)
    expect(e1.message).to.not.include(k)
    chmodSync(file, 0o600)
    writeFileSync(file, '{"nope":1}', { mode: 0o600 })
    err = undefined
    try {
      await loadOrCreatePeerKey(peerDir, deps)
    } catch (e) {
      err = e
    }
    const e2 = err as { name?: string, code?: string, message?: string }
    expect(e2.name).to.equal('PeerKeyError')
    expect(e2.code).to.equal('peer-key-corrupt')
    expect(e2.message).to.not.include(peerDir)
    writeFileSync(file, 'not json', { mode: 0o600 })
    err = undefined
    try {
      await loadOrCreatePeerKey(peerDir, deps)
    } catch (e) {
      err = e
    }
    expect((err as { code?: string }).code).to.equal('peer-key-corrupt')
  })

  it('scoped storage gives one FileRawStorage per scope inside store/ and never outside it', () => {
    const peerDir = join(root, 'p', 'officer')
    const scoped = createScopedStorage(peerDir, FakeRaw)
    const a = scoped.provider('control-abc')
    expect(scoped.provider('control-abc')).to.equal(a)
    expect(FakeRaw.dirs).to.have.lengthOf(1)
    expect(FakeRaw.dirs[0]).to.equal(scopeDir(peerDir, 'control-abc'))
    expect(FakeRaw.dirs[0]!.startsWith(storeDir(peerDir) + sep)).to.equal(true)
    expect(statSync(FakeRaw.dirs[0]!).mode & 0o777).to.equal(0o700)
    expect(statSync(storeDir(peerDir)).mode & 0o777).to.equal(0o700)
    const escaped = scoped.provider('../../x')
    expect(escaped).to.not.equal(a)
    const dir = FakeRaw.dirs[1]!
    expect(resolve(dir).startsWith(resolve(storeDir(peerDir)) + sep)).to.equal(true)
    expect(dir.endsWith(`scope-${safeScope('../../x')}`)).to.equal(true)
    expect(safeScope('../../x')).to.equal('______x')
    expect(safeScope('a'.repeat(300))).to.have.lengthOf(128)
    expect(scoped.scopes().sort()).to.deep.equal(['../../x', 'control-abc'])
  })

  it('destroyScope closes then removes only its scope and closeStores closes every scope once', async () => {
    const peerDir = join(root, 'p', 'officer')
    const scoped = createScopedStorage(peerDir, FakeRaw)
    scoped.provider('control-one')
    scoped.provider('strand-two')
    const oneDir = scopeDir(peerDir, 'control-one')
    const twoDir = scopeDir(peerDir, 'strand-two')
    writeFileSync(join(oneDir, 'x'), 'x')
    writeFileSync(join(twoDir, 'y'), 'y')
    await scoped.destroyScope('control-one')
    expect(FakeRaw.closes).to.deep.equal([oneDir])
    expect(existsSync(oneDir)).to.equal(false)
    expect(existsSync(join(twoDir, 'y'))).to.equal(true)
    expect(scoped.scopes()).to.deep.equal(['strand-two'])
    await scoped.closeStores()
    await scoped.closeStores()
    expect(FakeRaw.closes).to.deep.equal([oneDir, twoDir])
    expect(scoped.scopes()).to.deep.equal([])
    // a fresh provider call after closeStores opens a new store
    scoped.provider('strand-two')
    expect(FakeRaw.dirs.filter((d) => d === twoDir)).to.have.lengthOf(2)
  })

  it("durable slot keys match the apps' rn-durable-slot templates", async () => {
    const authority = readFileSync(join(REPO_ROOT, 'apps/VoteTorrentAuthority/src/engines/rn-durable-slot.ts'), 'utf8')
    const voter = readFileSync(join(REPO_ROOT, 'apps/VoteTorrentVoter/src/engines/rn-durable-slot.ts'), 'utf8')
    expect(authority).to.include('`@votetorrent/strandNetworkState/${scope}/${partyId}`')
    expect(authority).to.include('`@votetorrent/trustedOwners/${scope}/${partyId}`')
    expect(voter).to.include('`@votetorrent/trustedOwners/${scope}/${partyId}`')
    expect(voter).to.include('`@votetorrent/bootstrapPeers/${scope}/${partyId}`')
    expect(slotKey('strandNetworkState', 'votetorrent-cadre-node', 'p1')).to.equal('@votetorrent/strandNetworkState/votetorrent-cadre-node/p1')
    expect(slotKey('trustedOwners', 'votetorrent-cadre-node', 'p1')).to.equal('@votetorrent/trustedOwners/votetorrent-cadre-node/p1')
    expect(slotKey('bootstrapPeers', 'votetorrent-voter-cadre-node', 'p1')).to.equal('@votetorrent/bootstrapPeers/votetorrent-voter-cadre-node/p1')
    const peerDir = join(root, 'p', 'officer')
    const store = openKv(peerDir)
    const slot = fileSlot(store, slotKey('trustedOwners', AUTHORITY_CADRE_STORE_SCOPE, 'p1'))
    expect(await slot.load()).to.equal(undefined)
    await slot.save('{"v":1}')
    expect(await slot.load()).to.equal('{"v":1}')
    expect(await store.getItem('@votetorrent/trustedOwners/votetorrent-cadre-node/p1')).to.equal('{"v":1}')
  })

  it('local storage adapter round-trips objects, returns undefined when absent and clears', async () => {
    const peerDir = join(root, 'p', 'officer')
    const store = openKv(peerDir)
    const ls = createFileLocalStorage(store)
    expect(await ls.getItem('recentNetworks')).to.equal(undefined)
    await ls.setItem('recentNetworks', [{ hash: 'abc', n: 1n }])
    expect(await ls.getItem('recentNetworks')).to.deep.equal([{ hash: 'abc', n: '1' }])
    await ls.setItem('other', { a: true })
    await ls.removeItem('recentNetworks')
    expect(await ls.getItem('recentNetworks')).to.equal(undefined)
    expect(await ls.getItem('other')).to.deep.equal({ a: true })
    await store.setItem('broken', 'not json')
    let err: unknown
    try {
      await ls.getItem('broken')
    } catch (e) {
      err = e
    }
    expect((err as Error).message).to.equal('local storage: unreadable value')
    await ls.clear()
    expect(store.keys()).to.deep.equal([])
  })

  it('relay readiness resolves once a circuit via the relay exists and no direct address is left', async () => {
    expect(relayPeerIdOf(RELAY_ADDR)).to.equal(RELAY_ID)
    expect(relayPeerIdOf(circuitVia(RELAY_ID, OTHER_ID))).to.equal(OTHER_ID)
    const frames: string[][] = [
      [],
      ['/ip4/127.0.0.1/tcp/4001/ws'],
      ['/ip4/127.0.0.1/tcp/4001/ws', circuitVia(RELAY_ID, OTHER_ID)],
      [circuitVia(OTHER_ID, MEMBER_ID)],
      [circuitVia(RELAY_ID, OTHER_ID)]
    ]
    let polls = 0
    let clock = 0
    const sleeps: number[] = []
    const node = { getMultiaddrs: () => frames[Math.min(polls++, frames.length - 1)]! }
    const result = await awaitRelayReservation(node, RELAY_ID, {
      timeoutMs: 90000,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      }
    })
    expect(polls).to.equal(5)
    expect(sleeps).to.deep.equal([1000, 1000, 1000, 1000])
    expect(result.waitedMs).to.equal(4000)
    expect(result.circuitAddrs).to.equal(1)
  })

  it('relay readiness rejects relay-reservation-timeout at the bound and never shows the relay address', async () => {
    let clock = 0
    const node = { getMultiaddrs: () => [circuitVia(OTHER_ID, MEMBER_ID), `/ip4/127.0.0.1/tcp/5/ws/p2p/${RELAY_ID}`] }
    let err: unknown
    try {
      await awaitRelayReservation(node, RELAY_ID, { timeoutMs: 3000, now: () => clock, sleep: async (ms) => { clock += ms } })
    } catch (e) {
      err = e
    }
    const e = err as { name?: string, code?: string, message?: string, waitedMs?: number, lastCircuit?: number, lastDirect?: number }
    expect(e.name).to.equal('RelayNotReadyError')
    expect(e.code).to.equal('relay-reservation-timeout')
    expect(e.waitedMs).to.equal(3000)
    expect(e.lastCircuit).to.equal(1)
    expect(e.lastDirect).to.equal(1)
    expect(e.message).to.equal('relay reservation not ready within 3 s')
    expect(e.message).to.not.include(RELAY_ID)
    expect(e.message).to.not.include('/ip4/')
    const throwing = { getMultiaddrs: (): string[] => { throw new Error('not started') } }
    let err2: unknown
    try {
      await awaitRelayReservation(throwing, RELAY_ID, { timeoutMs: 1000, now: () => clock, sleep: async (ms) => { clock += ms } })
    } catch (x) {
      err2 = x
    }
    expect((err2 as { code?: string }).code).to.equal('relay-reservation-timeout')
    expect(() => awaitRelayReservation(node, RELAY_ID, { timeoutMs: RELAY_READY_MAX_MS + 1 })).to.throw(RangeError)
    expect(() => awaitRelayReservation(node, RELAY_ID, { timeoutMs: 0 })).to.throw(RangeError)
    expect(RELAY_READY_MAX_MS).to.equal(90000)
  })

  it('authority node options: relay, stored join bootstrap, owner and strand-state stores, no edge-reader protocol, identity owner wrap', async () => {
    const peerDir = join(root, 'p', 'officer')
    const counters = newCounters()
    const opts = buildOpts('officer', peerDir)
    const hint = circuitVia(RELAY_ID, MEMBER_ID)
    await opts.kv.setItem(AUTHORITY_JOIN_BOOTSTRAP_KEY, JSON.stringify([hint, 'not-an-address']))
    const selfId = fakePeerId(23)
    FakeNode.script.addrs = [circuitVia(RELAY_ID, selfId)]
    const built = await buildRoleNode(opts, fakeDeps(counters))
    expect(FakeNode.instances).to.have.lengthOf(1)
    const o = FakeNode.instances[0]!.options
    expect(o.controlNetwork.partyId).to.equal('vt23-party')
    expect(o.controlNetwork.bootstrapNodes).to.deep.equal([RELAY_ADDR, hint])
    expect(o.network.relayAddrs).to.deep.equal([RELAY_ADDR])
    expect(o.trustedOwners).to.not.equal(undefined)
    expect(o.strandNetworkState).to.not.equal(undefined)
    expect(o.bootstrapPeers).to.equal(undefined)
    expect(o.edgeReaderProtocol).to.equal(undefined)
    expect(o.network.inviteAddressResolver).to.equal(undefined)
    expect(counters.wraps).to.equal(1)
    expect(counters.reanchors).to.equal(1)
    expect(counters.classifies).to.equal(1)
    expect(counters.hosts).to.equal(1)
    expect(built.kind).to.equal('authority')
    expect(built.storeScope).to.equal(AUTHORITY_CADRE_STORE_SCOPE)
    expect(built.reanchor).to.equal('wired')
    expect(built.ownerTrust).to.equal('ok')
    expect(built.rendezvous).to.equal('hosted')
    expect(built.recreated).to.equal(false)
    expect(built.peerId8).to.have.lengthOf(8)
    expect(built.peerId.endsWith(built.peerId8)).to.equal(true)
    expect(built.ownerNode).to.equal(built.node)
    expect(built.isolated).to.equal(null)
    expect(built.dialRefused).to.equal(null)
    expect(FakeNode.instances[0]!.starts).to.equal(1)
    await built.stop()
    await built.stop()
    expect(FakeNode.instances[0]!.stops).to.equal(1)
    expect(counters.detaches).to.equal(1)
    expect(FakeRaw.closes).to.deep.equal([scopeDir(peerDir, 'control-fake')])
  })

  it('voter node options: edge-reader protocol, bootstrap-peer store, relay-only invite addresses, no owner-trust or rendezvous', async () => {
    const peerDir = join(root, 'p', 'v1')
    const counters = newCounters()
    const opts = buildOpts('voter', peerDir)
    const deps = fakeDeps(counters)
    const selfId = fakePeerId(29)
    FakeNode.script.addrs = [circuitVia(RELAY_ID, selfId)]
    const built = await buildRoleNode(opts, deps)
    const o = FakeNode.instances[0]!.options
    expect(o.edgeReaderProtocol).to.equal((deps as unknown as { EDGE_READER_PROTOCOL: string }).EDGE_READER_PROTOCOL)
    expect(o.bootstrapPeers).to.not.equal(undefined)
    expect(o.trustedOwners).to.not.equal(undefined)
    expect(o.strandNetworkState).to.equal(undefined)
    expect(counters.wraps).to.equal(0)
    expect(counters.reanchors).to.equal(0)
    expect(counters.classifies).to.equal(0)
    expect(counters.hosts).to.equal(0)
    FakeNode.script.addrs = ['/ip4/127.0.0.1/tcp/4001/ws', circuitVia(RELAY_ID, selfId)]
    expect(await o.network.inviteAddressResolver!()).to.deep.equal([circuitVia(RELAY_ID, selfId)])
    expect(built.kind).to.equal('voter')
    expect(built.storeScope).to.equal(VOTER_CADRE_STORE_SCOPE)
    expect(built.rendezvous).to.equal('skipped')
    expect(built.ownerTrust).to.equal(null)
    expect(built.reanchor).to.equal(null)
    expect(built.ownerNode).to.equal(null)
    await built.stop()
    expect(FakeNode.instances[0]!.stops).to.equal(1)
  })

  it('a failed start or a missed reservation stops the node and closes every store', async () => {
    const peerDir = join(root, 'p', 'officer')
    const counters = newCounters()
    const opts = buildOpts('officer', peerDir)
    const boom = new Error('start failed')
    FakeNode.script.startError = boom
    let err: unknown
    try {
      await buildRoleNode(opts, fakeDeps(counters))
    } catch (e) {
      err = e
    }
    expect(err).to.equal(boom)
    expect(FakeNode.instances).to.have.lengthOf(1)
    expect(FakeNode.instances[0]!.stops).to.equal(1)
    expect(FakeRaw.closes).to.deep.equal([scopeDir(peerDir, 'control-fake')])
    FakeNode.script = { addrs: [] }
    FakeRaw.closes = []
    FakeNode.instances = []
    let err2: unknown
    try {
      await buildRoleNode({ ...opts, relayReadyMs: 1 }, fakeDeps(counters))
    } catch (e) {
      err2 = e
    }
    const e2 = err2 as { name?: string, code?: string }
    expect(e2.name).to.equal('RelayNotReadyError')
    expect(e2.code).to.equal('relay-reservation-timeout')
    expect(FakeNode.instances[0]!.stops).to.equal(1)
    expect(FakeRaw.closes).to.deep.equal([scopeDir(peerDir, 'control-fake')])
  })

  it('instruments add the isolation gater only when asked', async () => {
    const peerDir = join(root, 'p', 'officer')
    const counters = newCounters()
    const selfId = fakePeerId(31)
    FakeNode.script.addrs = [circuitVia(RELAY_ID, selfId)]
    const built = await buildRoleNode(buildOpts('officer', peerDir, { instruments: true }), fakeDeps(counters))
    const gater = FakeNode.instances[0]!.options.network.connectionGater
    expect(typeof gater.denyDialPeer).to.equal('function')
    expect(built.dialRefused).to.be.instanceOf(Set)
    expect(built.isolated).to.be.instanceOf(Set)
    const victim = { toString: () => OTHER_ID }
    expect(await gater.denyDialPeer!(victim)).to.equal(false)
    built.dialRefused!.add(OTHER_ID)
    expect(await gater.denyDialPeer!(victim)).to.equal(true)
    expect(await gater.denyOutboundEncryptedConnection!(victim)).to.equal(true)
    expect(await gater.denyInboundEncryptedConnection!(victim)).to.equal(false)
    built.isolated!.add(OTHER_ID)
    expect(await gater.denyInboundEncryptedConnection!(victim)).to.equal(true)
    expect(await gater.denyDialMultiaddr!({})).to.equal(false)
    await built.stop()
    kv?.close()
    kv = undefined
    FakeNode.instances = []
    const plain = await buildRoleNode(buildOpts('officer', join(root, 'q', 'officer')), fakeDeps(counters))
    const plainGater = FakeNode.instances[0]!.options.network.connectionGater
    expect(plainGater.denyDialPeer).to.equal(undefined)
    expect(typeof plainGater.denyDialMultiaddr).to.equal('function')
    expect(plain.isolated).to.equal(null)
    expect(plain.dialRefused).to.equal(null)
    await plain.stop()
  })

  it('role networks engine reads the joined list through the shared store; openRoleNetwork refuses an unknown hash and a missing user', async () => {
    const peerDir = join(root, 'p', 'officer')
    const store = openKv(peerDir)
    const stores = createRoleStores('authority', store)
    expect(await stores.joinedNetworks.isJoinedNetwork('abc')).to.equal(false)
    await stores.joinedNetworks.rememberJoinedNetwork('abc')
    expect(await stores.joinedNetworks.isJoinedNetwork('abc')).to.equal(true)
    expect(await store.getItem(AUTHORITY_JOINED_NETWORKS_KEY)).to.equal('["abc"]')
    await store.setItem(AUTHORITY_JOINED_NETWORKS_KEY, '{"corrupt":true}')
    let err: unknown
    try {
      await stores.joinedNetworks.isJoinedNetwork('abc')
    } catch (e) {
      err = e
    }
    expect(isJoinedNetworksUnreadableError(err)).to.equal(true)
    const voterStores = createRoleStores('voter', store)
    expect(await voterStores.joinedNetworks.isJoinedNetwork('abc')).to.equal(false)

    const ls = createFileLocalStorage(store)
    const opened: Array<{ hash: string, user: unknown }> = []
    const engine = {
      async open(ref: { hash: string }, user: unknown) {
        opened.push({ hash: ref.hash, user })
        return {}
      },
      getEstablishedContext(hash: string) {
        return { db: { hash } }
      }
    } as unknown as RoleNetworksEngineLike
    const user = { id: 'u1', name: 'Officer', activeKeys: [] }
    let e1: unknown
    try {
      await openRoleNetwork({ engine, localStorage: ls, networkHash: 'h1', user })
    } catch (e) {
      e1 = e
    }
    expect((e1 as { name?: string, code?: string, message?: string }).name).to.equal('NetworkOpenError')
    expect((e1 as { code?: string }).code).to.equal('network-not-open')
    expect((e1 as { message?: string }).message).to.equal('network-not-open')
    await ls.setItem('recentNetworks', [{ hash: 'h1', name: 'n1', primaryAuthorityDomainName: 'a', relays: [] }])
    let e2: unknown
    try {
      await openRoleNetwork({ engine, localStorage: ls, networkHash: 'h1', user: null })
    } catch (e) {
      e2 = e
    }
    expect((e2 as { code?: string }).code).to.equal('user-missing')
    expect(opened).to.have.lengthOf(0)
    const out = await openRoleNetwork({ engine, localStorage: ls, networkHash: 'h1', user })
    expect(opened).to.deep.equal([{ hash: 'h1', user }])
    expect(out.ref.hash).to.equal('h1')
    expect(out.est).to.deep.equal({ db: { hash: 'h1' } })
    expect(out.networksEngine).to.equal(engine)
  })
})
