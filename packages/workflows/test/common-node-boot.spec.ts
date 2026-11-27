// common-node-boot.spec.ts: plain-Node proof of the shared CadreNode option builder, the control-schema
// recovery predicate and the boot step order (phase 67 plan 16). Fakes are plain objects; the boot logs
// only through the injected `warn`, so nothing is silenced.
import { expect } from 'chai'
import {
  CadreNodeOptionsError,
  STRAND_ADDR_REFRESH_MS,
  bootCadreNode,
  buildCadreNodeOptions,
  isCadreNodeOptionsError,
  isUnrestorableControlSchemaError,
  relayOnlyAddrs,
  type BootableCadreNode,
  type CadreNodeBootInput,
  type CadreNodeOptionsInput,
} from '../src/common/join-node.js'

// ------------------------------------------------------------------------------------------------ fixtures

const OBSERVED =
  'Failed to execute DDL: DROP TABLE IF EXISTS CadreControl.pendingjoin\n' +
  "Error: cannot drop table 'cadrecontrol.pendingjoin': it is referenced by CHECK constraint 'RowIsGone' on table 'Revocation' — drop or redefine it first\n" +
  'The schema could not be restored: the failing step `DROP TABLE IF EXISTS CadreControl.pendingjoin` cannot be undone'

const OBSERVED_115_CAUSE = "Module for table 'CadrePeer' does not support ALTER TABLE ADD COLUMN"
const OBSERVED_115 = new Error(
  'Failed to execute DDL: ALTER TABLE CadreControl.CadrePeer ADD COLUMN Profile text null\nError: ' + OBSERVED_115_CAUSE,
  { cause: new Error(OBSERVED_115_CAUSE) },
)

const OBSERVED_118_MESSAGE =
  'The control store for this party was written before control schema migrations (it records control schema ' +
  'version 0; this build declares 3; migrations start at version 3), so this build cannot upgrade it in place. ' +
  'Run a release whose control schema matches the store, or recreate the control store.'
function storeRefusal(reason: string, message = OBSERVED_118_MESSAGE): Error {
  return Object.assign(new Error(message), { name: 'ControlStoreIncompatibleError', reason })
}

const SELF = '12D3KooWEqqPhiUSHecCFe4ZxvMDuX48mwjxEKgYK8Y81RiMqVQN'
const RELAY_PEER = '12D3KooWRelayRelayRelayRelayRelayRelayRelayRelayRela'
const RELAY_A = `/ip4/203.0.113.9/tcp/4801/ws/p2p/${RELAY_PEER}`
const RELAY_B = `/dns4/relay.example.org/tcp/443/wss/p2p/${RELAY_PEER}`
const HINT = `/ip4/203.0.113.9/tcp/4801/ws/p2p/${RELAY_PEER}/p2p-circuit/p2p/${SELF}`
const DIRECT = `/ip4/10.0.2.16/tcp/1/ws/p2p/${SELF}`
const CIRCUIT = `${RELAY_A}/p2p-circuit/p2p/${SELF}`
const PLANTED_RELAY = '/ip4/198.51.100.77/tcp/4802/ws/p2p/12D3KooWPlantedPlantedPlantedPlantedPlantedPlanted'

interface FakeTransports {
  factories: { webSockets: () => unknown; circuitRelayTransport: (init: { reservationConcurrency: number }) => unknown }
  wsCalls: number
  circuitCalls: Array<{ reservationConcurrency: number }>
}
function fakeTransports(): FakeTransports {
  const t: FakeTransports = { factories: { webSockets: () => ({}), circuitRelayTransport: () => ({}) }, wsCalls: 0, circuitCalls: [] }
  t.factories.webSockets = () => {
    t.wsCalls += 1
    return { tag: 'ws', n: t.wsCalls }
  }
  t.factories.circuitRelayTransport = (init) => {
    t.circuitCalls.push(init)
    return { tag: 'circuit', n: t.circuitCalls.length }
  }
  return t
}

const fakeRefusal = () => ({ hook: () => ({ refuses: () => false }), control: { refuses: () => false } })
const fakeSetup = (_db: unknown) => undefined
const fakeOpen = async (_scope: string) => ({})

function authorityInput(overrides: Partial<CadreNodeOptionsInput> = {}, transports = fakeTransports()): CadreNodeOptionsInput {
  return {
    role: 'authority',
    partyId: 'party-under-test',
    privateKey: { type: 'Ed25519' },
    relay: [RELAY_A],
    bootstrap: [],
    storage: { open: fakeOpen },
    transports: transports.factories,
    edgeReader: { refusal: fakeRefusal() },
    strandDatabaseSetup: fakeSetup,
    ...overrides,
  }
}

function voterInput(overrides: Partial<CadreNodeOptionsInput> = {}, transports = fakeTransports()): CadreNodeOptionsInput {
  return authorityInput(
    {
      role: 'voter',
      edgeReader: { refusal: fakeRefusal(), protocol: '/votetorrent/edge-reader/1.0.0' },
      ownAddrs: () => [DIRECT, CIRCUIT],
      ...overrides,
    },
    transports,
  )
}

function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown = null
  try {
    fn()
  } catch (e) {
    thrown = e
  }
  expect(thrown, `expected a throw with code ${code}`).to.not.equal(null)
  expect(isCadreNodeOptionsError(thrown)).to.equal(true)
  expect(thrown).to.be.instanceOf(CadreNodeOptionsError)
  expect((thrown as CadreNodeOptionsError).code).to.equal(code)
  expect((thrown as Error).name).to.equal('CadreNodeOptionsError')
  expect((thrown as Error).message).to.not.include(PLANTED_RELAY)
  expect((thrown as Error).message).to.not.include('198.51.100.77')
}

interface FakeNode extends BootableCadreNode {
  id: number
  startCalls: number
  stopCalls: number
}

interface BootRig {
  order: string[]
  nodes: FakeNode[]
  destroyed: string[]
  warns: unknown[][]
  input: CadreNodeBootInput<FakeNode>
}

function rig(startErrors: Array<Error | null>, extra: Partial<CadreNodeBootInput<FakeNode>> = {}): BootRig {
  const order: string[] = []
  const nodes: FakeNode[] = []
  const destroyed: string[] = []
  const warns: unknown[][] = []
  const queue = [...startErrors]
  const createNode = (): FakeNode => {
    const node: FakeNode = {
      id: nodes.length + 1,
      startCalls: 0,
      stopCalls: 0,
      async start() {
        node.startCalls += 1
        order.push(`start:${node.id}`)
        const planted = queue.shift()
        if (planted) throw planted
      },
      async stop() {
        node.stopCalls += 1
        order.push(`stop:${node.id}`)
      },
    }
    nodes.push(node)
    return node
  }
  const input: CadreNodeBootInput<FakeNode> = {
    partyId: 'party-under-test',
    createNode,
    destroyScope: async (scope) => {
      destroyed.push(scope)
    },
    controlStorageScope: (partyId) => 'control-' + Buffer.from(partyId).toString('hex'),
    logTag: '[T]',
    warn: (...args) => {
      warns.push(args)
    },
    ...extra,
  }
  return { order, nodes, destroyed, warns, input }
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}

// ------------------------------------------------------------------------------------------------ cases

describe('common node boot', function () {
  this.timeout(10_000)

  describe('control-schema recovery predicate', () => {
    it('CSR-1 matches the 1.13 -> 1.14 control-schema failure', () => {
      expect(isUnrestorableControlSchemaError(new Error(OBSERVED))).to.equal(true)
    })
    it('CSR-2 matches it when it arrives as the cause of a wrapper error', () => {
      expect(isUnrestorableControlSchemaError(new Error('CadreNode start failed', { cause: new Error(OBSERVED) }))).to.equal(true)
    })
    it('CSR-3 matches the 1.14 -> 1.15 control-schema failure (ALTER TABLE ADD COLUMN refused)', () => {
      expect(isUnrestorableControlSchemaError(OBSERVED_115)).to.equal(true)
    })
    it('CSR-4 matches the typed refusal (reason before-migrations)', () => {
      expect(isUnrestorableControlSchemaError(storeRefusal('before-migrations'))).to.equal(true)
    })
    it('CSR-5 matches the typed refusal when it arrives as the cause of a wrapper error', () => {
      expect(isUnrestorableControlSchemaError(new Error('CadreNode start failed', { cause: storeRefusal('before-migrations') }))).to.equal(true)
    })
    it('CSR-6 matches a typed not-migratable refusal', () => {
      expect(isUnrestorableControlSchemaError(storeRefusal('not-migratable', 'not migratable'))).to.equal(true)
    })
    it('CSR-7 never matches a store a newer release migrated (newer-release: update the app, keep the rows)', () => {
      expect(isUnrestorableControlSchemaError(storeRefusal('newer-release', 'migrated by a newer release; CadreControl. could not be restored'))).to.equal(false)
    })
    const negatives: Array<[string, string, unknown]> = [
      ['CSR-8', 'a network failure', new Error('Relay reservation failed: NoValidAddressesError')],
      ['CSR-9', 'a strand (App) schema refusal', new Error('The schema could not be restored: App.Registrant')],
      ['CSR-10', 'a strand (App) ALTER refusal', new Error("Failed to execute DDL: ALTER TABLE App.Registrant ADD COLUMN Note text null\nError: Module for table 'Registrant' does not support ALTER TABLE ADD COLUMN")],
      ['CSR-11', 'the module refusal without the CadreControl DDL around it', new Error(OBSERVED_115_CAUSE)],
      ['CSR-12', 'a CadreControl write refusal that is not a migration', new Error('CHECK constraint failed: InsertValid on CadreControl.CadrePeer')],
      ['CSR-13', 'a non-error value', 'boom'],
      ['CSR-14', 'undefined', undefined],
    ]
    for (const [id, label, value] of negatives) {
      it(`${id} does not match ${label}`, () => {
        expect(isUnrestorableControlSchemaError(value)).to.equal(false)
      })
    }
  })

  describe('buildCadreNodeOptions', () => {
    it('NO-1 authority: the posture constants, relay-first deduplicated bootstrap, identity of the injected pieces, no voter keys', () => {
      const t = fakeTransports()
      const input = authorityInput({ relay: [RELAY_A, '', '   ', RELAY_B], bootstrap: [HINT, RELAY_A] }, t)
      const opts = buildCadreNodeOptions(input)
      expect(opts.nodeClass).to.equal('device')
      expect(opts.requireSignedSchemas).to.equal(false)
      expect(opts.strandFilter).to.deep.equal({ mode: 'all' })
      expect(opts.hibernation).to.deep.equal({ enabled: false })
      expect(opts.strandReactivity).to.deep.equal({ enabled: true })
      expect(opts.network.controlCohort).to.deep.equal({ strandAddrRefreshMs: 30000 })
      expect(STRAND_ADDR_REFRESH_MS).to.equal(30000)
      expect(opts.network.requireRelay).to.equal(false)
      expect(opts.network.relayAddrs).to.deep.equal([RELAY_A, RELAY_B])
      expect(opts.controlNetwork).to.deep.equal({ partyId: 'party-under-test', bootstrapNodes: [RELAY_A, RELAY_B, HINT] })
      expect(opts.privateKey).to.equal(input.privateKey)
      expect(opts.strandCohortRefusal).to.equal(input.edgeReader.refusal.hook)
      expect(opts.controlCohortRefusal).to.equal(input.edgeReader.refusal.control)
      expect(opts.strandDatabaseSetup).to.equal(input.strandDatabaseSetup)
      expect(opts.storage.open).to.equal(input.storage.open)
      expect('edgeReaderProtocol' in opts).to.equal(false)
      expect('inviteAddressResolver' in opts.network).to.equal(false)
    })

    it('NO-2 the transport factories are called once each; circuit concurrency is max(1, relays); transports hold both results in order', () => {
      for (const [relay, expected] of [[[], 1], [[RELAY_A], 1], [[RELAY_A, RELAY_B], 2]] as Array<[string[], number]>) {
        const t = fakeTransports()
        const opts = buildCadreNodeOptions(authorityInput({ relay }, t))
        expect(t.wsCalls).to.equal(1)
        expect(t.circuitCalls).to.deep.equal([{ reservationConcurrency: expected }])
        expect(opts.network.transports).to.have.length(2)
        expect(opts.network.transports[0]).to.deep.equal({ tag: 'ws', n: 1 })
        expect(opts.network.transports[1]).to.deep.equal({ tag: 'circuit', n: 1 })
      }
    })

    it('NO-3 stores: absent keys when undefined, `{ store }` by identity when given', () => {
      const none = buildCadreNodeOptions(authorityInput())
      expect('strandNetworkState' in none).to.equal(false)
      expect('trustedOwners' in none).to.equal(false)
      expect('bootstrapPeers' in none).to.equal(false)
      const sns = { kind: 'sns' }
      const to = { kind: 'to' }
      const bp = { kind: 'bp' }
      const all = buildCadreNodeOptions(authorityInput({ stores: { strandNetworkState: sns, trustedOwners: to, bootstrapPeers: bp } }))
      expect(all.strandNetworkState?.store).to.equal(sns)
      expect(all.trustedOwners?.store).to.equal(to)
      expect(all.bootstrapPeers?.store).to.equal(bp)
    })

    it('NO-4 voter: edgeReaderProtocol by identity; the invite resolver yields only circuit addresses and reads ownAddrs at call time', async () => {
      let current: string[] = [DIRECT]
      const input = voterInput({ ownAddrs: () => current })
      const opts = buildCadreNodeOptions(input)
      expect(opts.edgeReaderProtocol).to.equal(input.edgeReader.protocol)
      expect(opts.network.inviteAddressResolver).to.be.a('function')
      expect(await opts.network.inviteAddressResolver!()).to.deep.equal([])
      current = [DIRECT, CIRCUIT]
      expect(await opts.network.inviteAddressResolver!()).to.deep.equal([CIRCUIT])
    })

    it('NO-5 every refusal throws a typed CadreNodeOptionsError with its code, and no message echoes a planted relay address', () => {
      const planted = { relay: [PLANTED_RELAY] }
      expectCode(() => buildCadreNodeOptions(voterInput({ ...planted, edgeReader: { refusal: fakeRefusal() } })), 'edge-reader-protocol-missing')
      expectCode(() => buildCadreNodeOptions(authorityInput({ ...planted, edgeReader: { refusal: fakeRefusal(), protocol: '/x/1.0.0' } })), 'edge-reader-protocol-forbidden')
      expectCode(() => buildCadreNodeOptions(voterInput({ ...planted, ownAddrs: undefined })), 'invite-address-source-missing')
      expectCode(() => buildCadreNodeOptions(authorityInput({ ...planted, ownAddrs: () => [] })), 'invite-address-source-forbidden')
      expectCode(() => buildCadreNodeOptions(authorityInput({ ...planted, partyId: '' })), 'party-id-missing')
      expectCode(() => buildCadreNodeOptions(authorityInput({ ...planted, partyId: '   ' })), 'party-id-missing')
      expectCode(() => buildCadreNodeOptions(authorityInput({ ...planted, strandDatabaseSetup: 'nope' as unknown as (db: unknown) => unknown })), 'strand-database-setup-missing')
      expectCode(() => buildCadreNodeOptions(authorityInput({ ...planted, edgeReader: { refusal: { hook: 'nope' as unknown as () => unknown, control: {} } } })), 'edge-reader-refusal-missing')
      expectCode(() => buildCadreNodeOptions(authorityInput({ ...planted, edgeReader: { refusal: { hook: () => undefined } as unknown as CadreNodeOptionsInput['edgeReader']['refusal'] } })), 'edge-reader-refusal-missing')
      expectCode(() => buildCadreNodeOptions(authorityInput({ ...planted, storage: {} as unknown as CadreNodeOptionsInput['storage'] })), 'storage-provider-missing')
      expectCode(() => buildCadreNodeOptions(authorityInput({ ...planted, transports: { webSockets: () => ({}) } as unknown as CadreNodeOptionsInput['transports'] })), 'transport-factory-missing')
      expectCode(() => buildCadreNodeOptions(voterInput({ ...planted, nodeClass: 'server' })), 'node-class-invalid')
      expectCode(() => buildCadreNodeOptions(authorityInput({ ...planted, nodeClass: 'phone' as unknown as 'device' })), 'node-class-invalid')
      expect(isCadreNodeOptionsError(new Error('x'))).to.equal(false)
      expect(isCadreNodeOptionsError(null)).to.equal(false)
    })

    it('NO-6 two builds from one input are distinct objects with distinct transports and the same refusal, stores and storage opener', () => {
      const t = fakeTransports()
      const to = { kind: 'to' }
      const input = authorityInput({ stores: { trustedOwners: to } }, t)
      const a = buildCadreNodeOptions(input)
      const b = buildCadreNodeOptions(input)
      expect(a).to.not.equal(b)
      expect(a.network).to.not.equal(b.network)
      expect(a.network.transports[0]).to.not.equal(b.network.transports[0])
      expect(a.network.transports[1]).to.not.equal(b.network.transports[1])
      expect(t.wsCalls).to.equal(2)
      expect(t.circuitCalls).to.have.length(2)
      expect(a.strandCohortRefusal).to.equal(b.strandCohortRefusal)
      expect(a.controlCohortRefusal).to.equal(b.controlCohortRefusal)
      expect(a.trustedOwners?.store).to.equal(b.trustedOwners?.store)
      expect(a.storage.open).to.equal(b.storage.open)
      expect(a.controlNetwork.bootstrapNodes).to.deep.equal(b.controlNetwork.bootstrapNodes)
    })

    it('NO-7 noiseCrypto and connectionGater pass through when given and are absent (no key) or defaulted when not', async () => {
      const bare = buildCadreNodeOptions(authorityInput())
      expect('noiseCrypto' in bare.network).to.equal(false)
      expect(Object.keys(bare.network.connectionGater)).to.deep.equal(['denyDialMultiaddr'])
      const deny = bare.network.connectionGater.denyDialMultiaddr as () => Promise<boolean>
      expect(await deny()).to.equal(false)
      const noise = { tag: 'noise' }
      const gater = { denyDialMultiaddr: async () => true, denyDialPeer: async () => true }
      const given = buildCadreNodeOptions(authorityInput({ noiseCrypto: noise, connectionGater: gater }))
      expect(given.network.noiseCrypto).to.equal(noise)
      expect(given.network.connectionGater).to.equal(gater)
    })

    it('NO-8 relayOnlyAddrs keeps only circuit addresses, answers [] for direct-only or empty input, and drops a non-string entry', () => {
      expect(relayOnlyAddrs([
        `/ip4/192.168.1.23/tcp/41234/ws/p2p/${SELF}`,
        `/ip4/203.0.113.7/tcp/41234/ws/p2p/${SELF}`,
        `/ip6/2001:db8::1/tcp/41234/ws/p2p/${SELF}`,
        CIRCUIT,
        `/ip4/127.0.0.1/tcp/55204/ws/p2p/${SELF}`,
      ])).to.deep.equal([CIRCUIT])
      expect(relayOnlyAddrs([DIRECT])).to.deep.equal([])
      expect(relayOnlyAddrs([])).to.deep.equal([])
      expect(relayOnlyAddrs([undefined as unknown as string, `/p2p/${RELAY_PEER}/p2p-circuit/p2p/${SELF}`])).to.deep.equal([
        `/p2p/${RELAY_PEER}/p2p-circuit/p2p/${SELF}`,
      ])
    })
  })

  describe('bootCadreNode', () => {
    const SCOPE = 'control-' + Buffer.from('party-under-test').toString('hex')

    it('BT-1 a happy boot: one createNode, one start, no destroyScope, nulls for the optional outcomes', async () => {
      const r = rig([null])
      const boot = await bootCadreNode(r.input)
      expect(r.nodes).to.have.length(1)
      expect(r.nodes[0]!.startCalls).to.equal(1)
      expect(r.destroyed).to.deep.equal([])
      expect(r.warns).to.deep.equal([])
      expect(boot.node).to.equal(r.nodes[0])
      expect(boot.recreated).to.equal(false)
      expect(boot.recreatedScope).to.equal(null)
      expect(boot.reanchor).to.equal(null)
      expect(boot.ownerTrust).to.equal(null)
      expect(boot.rendezvous).to.equal(null)
    })

    it('BT-2 an unrestorable first start: one closed warn line, stop, one destroyScope of the control scope, a second node started once', async () => {
      const r = rig([new Error(OBSERVED), null])
      const boot = await bootCadreNode(r.input)
      expect(r.warns).to.deep.equal([[`[T] control store '${SCOPE}' was written by an older cadre-core and cannot be migrated; recreating it`]])
      expect(r.nodes).to.have.length(2)
      expect(r.nodes[0]!.stopCalls).to.equal(1)
      expect(r.nodes[0]!.startCalls).to.equal(1)
      expect(r.destroyed).to.deep.equal([SCOPE])
      expect(r.nodes[1]!.startCalls).to.equal(1)
      expect(r.nodes[1]!.stopCalls).to.equal(0)
      expect(boot.recreated).to.equal(true)
      expect(boot.recreatedScope).to.equal(SCOPE)
      expect(boot.node).to.equal(r.nodes[1])
      expect(r.order).to.deep.equal(['start:1', 'stop:1', 'start:2'])
    })

    it('BT-3 a relay-failure start rejects with the SAME error object, no destroyScope, a single createNode', async () => {
      const planted = Object.assign(new Error('network.relayAddrs reservation failed (status: retrying)'), { name: 'RelayReservationFailedError' })
      const r = rig([planted])
      const e = await rejection(bootCadreNode(r.input))
      expect(e).to.equal(planted)
      expect(r.destroyed).to.deep.equal([])
      expect(r.nodes).to.have.length(1)
      expect(r.warns).to.deep.equal([])
    })

    it('BT-4 both starts unrestorable: the boot rejects with the SECOND error, destroyScope once, createNode twice (one-shot)', async () => {
      const first = new Error(OBSERVED)
      const second = new Error('CadreNode start failed', { cause: new Error(OBSERVED) })
      const r = rig([first, second])
      const e = await rejection(bootCadreNode(r.input))
      expect(e).to.equal(second)
      expect(r.destroyed).to.deep.equal([SCOPE])
      expect(r.nodes).to.have.length(2)
      expect(r.warns).to.have.length(1)
    })

    it('BT-5 a typed newer-release refusal rejects with no destroyScope', async () => {
      const planted = storeRefusal('newer-release', 'migrated by a newer release; CadreControl. could not be restored')
      const r = rig([planted])
      const e = await rejection(bootCadreNode(r.input))
      expect(e).to.equal(planted)
      expect(r.destroyed).to.deep.equal([])
      expect(r.nodes).to.have.length(1)
    })

    it('BT-6 owner trust: re-anchor once on the FINAL node, classification after it, the state mapping, memory skips the read', async () => {
      const reanchored: FakeNode[] = []
      const classified: Array<[FakeNode, string]> = []
      const ownerTrust = (storeKind: 'persistent' | 'memory', answer: 'ok' | 'needs-reinvite' | 'unreadable') => ({
        storeKind,
        reanchorOwnKey: async (node: FakeNode) => {
          reanchored.push(node)
          return 'wired'
        },
        readOwnerTrustClassification: async (node: FakeNode, kind: 'persistent') => {
          classified.push([node, kind])
          return answer
        },
      })
      // recovery shape: never on the first node
      const r1 = rig([new Error(OBSERVED), null], { ownerTrust: ownerTrust('persistent', 'needs-reinvite') })
      const b1 = await bootCadreNode(r1.input)
      expect(reanchored).to.deep.equal([r1.nodes[1]])
      expect(reanchored[0]).to.not.equal(r1.nodes[0])
      expect(classified).to.deep.equal([[r1.nodes[1], 'persistent']])
      expect(b1.reanchor).to.equal('wired')
      expect(b1.ownerTrust).to.equal('needs-reinvite')
      // mapping
      reanchored.length = 0
      classified.length = 0
      const b2 = await bootCadreNode(rig([null], { ownerTrust: ownerTrust('persistent', 'unreadable') }).input)
      expect(b2.ownerTrust).to.equal('ok')
      const b3 = await bootCadreNode(rig([null], { ownerTrust: ownerTrust('persistent', 'ok') }).input)
      expect(b3.ownerTrust).to.equal('ok')
      expect(reanchored).to.have.length(2)
      expect(classified).to.have.length(2)
      // memory store
      reanchored.length = 0
      classified.length = 0
      const b4 = await bootCadreNode(rig([null], { ownerTrust: ownerTrust('memory', 'needs-reinvite') }).input)
      expect(b4.ownerTrust).to.equal('memory-only')
      expect(reanchored).to.have.length(1)
      expect(classified).to.deep.equal([])
    })

    it('BT-7 step order start, reanchor, classify, host; shouldHost false skips the host; a host failure resolves null with the closed warn; a detach is passed through', async () => {
      const detach = async () => undefined
      const mk = (shouldHost: boolean, hostImpl: (node: FakeNode) => Promise<() => Promise<void>>) => {
        const r = rig([null])
        const order = r.order
        r.input.ownerTrust = {
          storeKind: 'persistent',
          reanchorOwnKey: async () => {
            order.push('reanchor')
            return 'not-owner'
          },
          readOwnerTrustClassification: async () => {
            order.push('classify')
            return 'ok'
          },
        }
        r.input.rendezvous = {
          host: async (node) => {
            order.push('host')
            return hostImpl(node)
          },
          shouldHost: () => shouldHost,
        }
        return r
      }
      const ok = mk(true, async () => detach)
      const b1 = await bootCadreNode(ok.input)
      expect(ok.order).to.deep.equal(['start:1', 'reanchor', 'classify', 'host'])
      expect(b1.rendezvous).to.not.equal(null)
      expect(await b1.rendezvous).to.equal(detach)

      const skipped = mk(false, async () => detach)
      const b2 = await bootCadreNode(skipped.input)
      expect(skipped.order).to.deep.equal(['start:1', 'reanchor', 'classify'])
      expect(b2.rendezvous).to.equal(null)

      const failing = mk(true, async () => {
        throw new Error('the control node is not running')
      })
      const b3 = await bootCadreNode(failing.input)
      expect(await b3.rendezvous).to.equal(null)
      expect(failing.warns).to.deep.equal([['[T] pool rendezvous not hosted:', 'the control node is not running']])
    })

    it('BT-8 input refusals: an empty partyId rejects before createNode; a missing createNode, destroyScope or controlStorageScope rejects with its code', async () => {
      const r = rig([null])
      const e1 = await rejection(bootCadreNode({ ...r.input, partyId: '' }))
      expect(isCadreNodeOptionsError(e1)).to.equal(true)
      expect((e1 as CadreNodeOptionsError).code).to.equal('party-id-missing')
      expect(r.nodes).to.have.length(0)
      const e2 = await rejection(bootCadreNode({ ...r.input, createNode: undefined as unknown as () => FakeNode }))
      expect((e2 as CadreNodeOptionsError).code).to.equal('create-node-missing')
      const e3 = await rejection(bootCadreNode({ ...r.input, destroyScope: undefined as unknown as (s: string) => Promise<void> }))
      expect((e3 as CadreNodeOptionsError).code).to.equal('destroy-scope-missing')
      const e4 = await rejection(bootCadreNode({ ...r.input, controlStorageScope: undefined as unknown as (p: string) => string }))
      expect((e4 as CadreNodeOptionsError).code).to.equal('control-scope-missing')
      expect(r.nodes).to.have.length(0)
    })
  })
})
