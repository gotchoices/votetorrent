// common-join-node.spec.ts: plain-Node proof of the join-node storage seams (phase 67 plan 08).
// Pins the four persisted key literals, both per-app sanitizers, both joined-list modes (the Authority's
// D-30 reject mode and the Voter's lenient empty mode), every factory refusal, the per-call kv lookup
// and silence. The injected unreadable error is a test-local class: the shared files define none.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect } from 'chai'
import {
  AUTHORITY_JOINED_NETWORKS_KEY,
  AUTHORITY_JOIN_BOOTSTRAP_KEY,
  BOOTSTRAP_CONFIG_MAX_ADDRS,
  VOTER_JOINED_NETWORKS_KEY,
  VOTER_JOIN_BOOTSTRAP_KEY,
  createJoinBootstrapStore,
  createJoinedNetworksStore,
  sanitizeAuthorityJoinBootstrap,
  sanitizeVoterJoinBootstrap,
  type JoinedNetworksStoreOptions,
} from '../src/common/join-node.js'
import type { KvStorage } from '../src/platform/storage.js'

class MapKv implements KvStorage {
  readonly map = new Map<string, string>()
  getCalls = 0
  setCalls = 0
  async getItem (key: string): Promise<string | null> {
    this.getCalls += 1
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  async setItem (key: string, value: string): Promise<void> {
    this.setCalls += 1
    this.map.set(key, value)
  }
  async removeItem (key: string): Promise<void> {
    this.map.delete(key)
  }
}

class TestUnreadable extends Error {
  constructor () {
    super('test unreadable')
    this.name = 'TestUnreadable'
  }
}

const CIRCUIT = '/dns4/relay.example/tcp/443/wss/p2p/12D3KooWRelayRelayRelayRelay/p2p-circuit/p2p/12D3KooWTargetTargetTarget'
const DIRECT = '/ip4/203.0.113.7/tcp/4001/ws/p2p/12D3KooWAuthorityAuthorityAuthority'

const consoleMethods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
const consoleCalls: string[] = []
const originalConsole: Partial<Record<(typeof consoleMethods)[number], (...args: unknown[]) => void>> = {}

async function rejection (p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}

function rejectMode (): JoinedNetworksStoreOptions {
  return { unreadable: 'reject', unreadableError: () => new TestUnreadable() }
}

describe('67-08 join-node storage seams', () => {
  before(() => {
    for (const m of consoleMethods) {
      originalConsole[m] = console[m]
      console[m] = (...args: unknown[]) => { consoleCalls.push(`${m}:${args.length}`) }
    }
  })

  after(() => {
    for (const m of consoleMethods) {
      console[m] = originalConsole[m] as (...args: unknown[]) => void
    }
  })

  it('K1 the four persisted keys are the exact literals and pairwise distinct', () => {
    expect(AUTHORITY_JOIN_BOOTSTRAP_KEY).to.equal('@votetorrent/authorityJoinBootstrap')
    expect(AUTHORITY_JOINED_NETWORKS_KEY).to.equal('@votetorrent/authorityJoinedNetworks')
    expect(VOTER_JOIN_BOOTSTRAP_KEY).to.equal('@votetorrent/voterJoinBootstrap')
    expect(VOTER_JOINED_NETWORKS_KEY).to.equal('@votetorrent/voterJoinedNetworks')
    const all = [AUTHORITY_JOIN_BOOTSTRAP_KEY, AUTHORITY_JOINED_NETWORKS_KEY, VOTER_JOIN_BOOTSTRAP_KEY, VOTER_JOINED_NETWORKS_KEY]
    expect(new Set(all).size).to.equal(4)
  })

  it('S1 the Authority sanitizer keeps relay-circuit addresses only, trimmed, deduped, capped at 16', () => {
    expect(sanitizeAuthorityJoinBootstrap([` ${CIRCUIT} `, CIRCUIT])).to.deep.equal([CIRCUIT])
    expect(sanitizeAuthorityJoinBootstrap([DIRECT])).to.deep.equal([])
    expect(sanitizeAuthorityJoinBootstrap([CIRCUIT.replace('/tcp/', '/t cp/')])).to.deep.equal([])
    expect(sanitizeAuthorityJoinBootstrap([42, null, {}])).to.deep.equal([])
    expect(sanitizeAuthorityJoinBootstrap('nope')).to.deep.equal([])
    const many = Array.from({ length: 20 }, (_, i) => `${CIRCUIT}${i}`)
    expect(sanitizeAuthorityJoinBootstrap(many)).to.have.length(BOOTSTRAP_CONFIG_MAX_ADDRS)
    expect(BOOTSTRAP_CONFIG_MAX_ADDRS).to.equal(16)
  })

  it('S2 the Voter sanitizer keeps any peer-bound address, drops oversized and unrooted ones, caps at 16', () => {
    expect(sanitizeVoterJoinBootstrap([` ${DIRECT} `, DIRECT])).to.deep.equal([DIRECT])
    expect(sanitizeVoterJoinBootstrap([`/x${'a'.repeat(300)}/p2p/x`])).to.deep.equal([])
    expect(sanitizeVoterJoinBootstrap(['ip4/1.2.3.4/tcp/1/p2p/x'])).to.deep.equal([])
    expect(sanitizeVoterJoinBootstrap(['/ip4/1.2.3.4/tcp/1'])).to.deep.equal([])
    expect(sanitizeVoterJoinBootstrap('nope')).to.deep.equal([])
    const many = Array.from({ length: 20 }, (_, i) => `${DIRECT}${i}`)
    expect(sanitizeVoterJoinBootstrap(many)).to.have.length(16)
  })

  it('S3 the two sanitizers disagree on a direct address (the per-app difference is pinned)', () => {
    expect(sanitizeVoterJoinBootstrap([DIRECT])).to.deep.equal([DIRECT])
    expect(sanitizeAuthorityJoinBootstrap([DIRECT])).to.deep.equal([])
    expect(sanitizeAuthorityJoinBootstrap([CIRCUIT])).to.deep.equal([CIRCUIT])
    expect(sanitizeVoterJoinBootstrap([CIRCUIT])).to.deep.equal([CIRCUIT])
  })

  it('B1 join-bootstrap store: lenient read, sanitized write, propagated write failure, per-call kv lookup', async () => {
    const kv = new MapKv()
    const store = createJoinBootstrapStore(kv, AUTHORITY_JOIN_BOOTSTRAP_KEY, sanitizeAuthorityJoinBootstrap)
    const { readJoinBootstrap, rememberJoinBootstrap } = store
    expect(await readJoinBootstrap()).to.deep.equal([])
    kv.map.set(AUTHORITY_JOIN_BOOTSTRAP_KEY, '{corrupt')
    expect(await readJoinBootstrap()).to.deep.equal([])
    kv.getItem = async () => { throw new Error('io') }
    expect(await readJoinBootstrap()).to.deep.equal([])
    kv.getItem = MapKv.prototype.getItem
    await rememberJoinBootstrap([DIRECT, CIRCUIT, CIRCUIT])
    expect(kv.map.get(AUTHORITY_JOIN_BOOTSTRAP_KEY)).to.equal(JSON.stringify([CIRCUIT]))
    expect(await readJoinBootstrap()).to.deep.equal([CIRCUIT])
    kv.setItem = async () => { throw new Error('disk full') }
    const err = await rejection(rememberJoinBootstrap([CIRCUIT]))
    expect((err as Error).message).to.equal('disk full')
    // replacing getItem on the kv object AFTER creation is honoured by the next read
    kv.getItem = async () => JSON.stringify([`${CIRCUIT}9`])
    expect(await readJoinBootstrap()).to.deep.equal([`${CIRCUIT}9`])
  })

  it('N1 reject mode is the D-30 fail-closed reader: fresh injected errors, dedupe, no write over an unreadable list', async () => {
    const kv = new MapKv()
    const store = createJoinedNetworksStore(kv, AUTHORITY_JOINED_NETWORKS_KEY, rejectMode())
    const { readJoinedNetworkHashes, isJoinedNetwork, rememberJoinedNetwork } = store
    expect(await readJoinedNetworkHashes()).to.deep.equal([])
    kv.map.set(AUTHORITY_JOINED_NETWORKS_KEY, '{corrupt')
    const e1 = await rejection(readJoinedNetworkHashes())
    const e2 = await rejection(readJoinedNetworkHashes())
    expect(e1).to.be.instanceOf(TestUnreadable)
    expect(e2).to.be.instanceOf(TestUnreadable)
    expect(e1).to.not.equal(e2)
    kv.map.set(AUTHORITY_JOINED_NETWORKS_KEY, '"x"')
    expect(await rejection(readJoinedNetworkHashes())).to.be.instanceOf(TestUnreadable)
    kv.getItem = async () => { throw new Error('io') }
    expect(await rejection(readJoinedNetworkHashes())).to.be.instanceOf(TestUnreadable)
    expect(await rejection(isJoinedNetwork('h1'))).to.be.instanceOf(TestUnreadable)
    kv.getItem = MapKv.prototype.getItem
    kv.map.set(AUTHORITY_JOINED_NETWORKS_KEY, JSON.stringify(['h1', 5, '', null, 'h2', 'h1']))
    expect(await readJoinedNetworkHashes()).to.deep.equal(['h1', 'h2'])
    expect(await isJoinedNetwork('h2')).to.equal(true)
    expect(await isJoinedNetwork('h3')).to.equal(false)
    await rememberJoinedNetwork('h3')
    await rememberJoinedNetwork('h1')
    expect(kv.map.get(AUTHORITY_JOINED_NETWORKS_KEY)).to.equal(JSON.stringify(['h1', 'h2', 'h3']))
    const bad = await rejection(rememberJoinedNetwork(''))
    expect(bad).to.be.instanceOf(TypeError)
    expect((bad as Error).message).to.equal('rememberJoinedNetwork needs a network hash')
    kv.map.set(AUTHORITY_JOINED_NETWORKS_KEY, '{corrupt')
    const before = kv.setCalls
    expect(await rejection(rememberJoinedNetwork('h4'))).to.be.instanceOf(TestUnreadable)
    expect(kv.setCalls - before).to.equal(0)
    expect(kv.map.get(AUTHORITY_JOINED_NETWORKS_KEY)).to.equal('{corrupt')
  })

  it('N2 empty mode is the Voter lenient reader: corrupt reads as [], no dedupe, overwrite on remember', async () => {
    const kv = new MapKv()
    const { readJoinedNetworkHashes, isJoinedNetwork, rememberJoinedNetwork } = createJoinedNetworksStore(kv, VOTER_JOINED_NETWORKS_KEY, { unreadable: 'empty' })
    expect(await readJoinedNetworkHashes()).to.deep.equal([])
    kv.map.set(VOTER_JOINED_NETWORKS_KEY, '{corrupt')
    expect(await readJoinedNetworkHashes()).to.deep.equal([])
    kv.map.set(VOTER_JOINED_NETWORKS_KEY, '"x"')
    expect(await readJoinedNetworkHashes()).to.deep.equal([])
    kv.getItem = async () => { throw new Error('io') }
    expect(await readJoinedNetworkHashes()).to.deep.equal([])
    kv.getItem = MapKv.prototype.getItem
    kv.map.set(VOTER_JOINED_NETWORKS_KEY, JSON.stringify(['h1', 'h1', 7, '']))
    expect(await readJoinedNetworkHashes()).to.deep.equal(['h1', 'h1'])
    expect(await isJoinedNetwork('h1')).to.equal(true)
    kv.map.set(VOTER_JOINED_NETWORKS_KEY, '{corrupt')
    await rememberJoinedNetwork('h')
    expect(kv.map.get(VOTER_JOINED_NETWORKS_KEY)).to.equal('["h"]')
    await rememberJoinedNetwork('h')
    expect(kv.map.get(VOTER_JOINED_NETWORKS_KEY)).to.equal('["h"]')
  })

  it('F1 every creation refusal is a TypeError thrown before any kv call', () => {
    const kv = new MapKv()
    const anyCreateJb = createJoinBootstrapStore as unknown as (...a: unknown[]) => unknown
    const anyCreateJn = createJoinedNetworksStore as unknown as (...a: unknown[]) => unknown
    const refusals: Array<[() => unknown, string]> = [
      [() => anyCreateJb(undefined, 'k', sanitizeVoterJoinBootstrap), 'createJoinBootstrapStore needs a key-value store'],
      [() => anyCreateJb({ getItem: async () => null }, 'k', sanitizeVoterJoinBootstrap), 'createJoinBootstrapStore needs a key-value store'],
      [() => anyCreateJb(kv, '', sanitizeVoterJoinBootstrap), 'createJoinBootstrapStore needs a storage key'],
      [() => anyCreateJb(kv, 7, sanitizeVoterJoinBootstrap), 'createJoinBootstrapStore needs a storage key'],
      [() => anyCreateJb(kv, 'k', undefined), 'createJoinBootstrapStore needs a sanitizer'],
      [() => anyCreateJn(undefined, 'k', rejectMode()), 'createJoinedNetworksStore needs a key-value store'],
      [() => anyCreateJn({ setItem: async () => undefined }, 'k', rejectMode()), 'createJoinedNetworksStore needs a key-value store'],
      [() => anyCreateJn(kv, '', rejectMode()), 'createJoinedNetworksStore needs a storage key'],
      [() => anyCreateJn(kv, 'k', undefined), 'createJoinedNetworksStore needs unreadable: reject or empty'],
      [() => anyCreateJn(kv, 'k', { unreadable: 'lenient' }), 'createJoinedNetworksStore needs unreadable: reject or empty'],
      [() => anyCreateJn(kv, 'k', { unreadable: 'reject' }), 'createJoinedNetworksStore needs an unreadableError factory'],
      [() => anyCreateJn(kv, 'k', { unreadable: 'reject', unreadableError: 'nope' }), 'createJoinedNetworksStore needs an unreadableError factory'],
    ]
    for (const [create, message] of refusals) {
      let caught: unknown
      try {
        create()
      } catch (e) {
        caught = e
      }
      expect(caught, message).to.be.instanceOf(TypeError)
      expect((caught as Error).message).to.equal(message)
    }
    expect(kv.getCalls).to.equal(0)
    expect(kv.setCalls).to.equal(0)
    // the well-formed calls succeed without touching the store either
    createJoinBootstrapStore(kv, 'k', sanitizeVoterJoinBootstrap)
    createJoinedNetworksStore(kv, 'k', { unreadable: 'empty' })
    expect(kv.getCalls + kv.setCalls).to.equal(0)
  })

  it('P1 source pin: no join-node file defines JoinedNetworksUnreadableError or names founder-intent', () => {
    const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/common/${rel}`, import.meta.url)), 'utf8')
    for (const rel of ['joined-networks.ts', 'join-bootstrap.ts', 'join-node.ts']) {
      const text = src(rel)
      expect(text, rel).to.not.match(/class\s+JoinedNetworksUnreadableError/)
      expect(text, rel).to.not.include('founder-intent')
    }
    expect(src('join-node.ts')).to.include("export * from './join-bootstrap.js'")
  })

  it('L1 no console method was called by any case above', () => {
    expect(consoleCalls).to.deep.equal([])
  })
})
