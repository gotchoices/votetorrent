// common-strand.spec.ts: plain-Node proof of the shared strand factory over a fake StrandHost (phase 67 plan 06).
// Mirrors the Authority's DF founder-intent and RS relay-seed jest cases: the founder flag, the one-shot
// founding window, the joined-list precedence, the relay seed, the addStrand config, the first-sync gate
// and the change hub with no reporter installed. Every case ends with the founder-intent slot empty.
import { expect } from 'chai'
import {
  createStrandDbFactory,
  isJoinedNetworksUnreadableError,
  setStrandChangeErrorReporter,
  strandChanges,
  takeFounderIntent,
  withFounding,
  withJoining,
  type StrandHost,
} from '../src/common/strand.js'

type AddStrandConfig = {
  strandRow: Record<string, unknown>
  sAppConfig: { id: string; version: string; schema: string; schemaVersion: unknown; latencyHint: string }
  founder: boolean
}

type FakeDb = { setSchemaPath: (path: string[]) => void; schemaPaths: string[][] }

type FakeHost = StrandHost & {
  calls: {
    addStrand: AddStrandConfig[]
    recordCarriedStrandAddrs: Array<{ strandId: string; addrs: readonly string[] }>
    whenStrandWritable: string[]
  }
  db: FakeDb
}

function makeFakeHost (opts: { connections?: number; carried?: string[]; addStrand?: (config: AddStrandConfig) => Promise<unknown> } = {}): FakeHost {
  const connections = opts.connections ?? 0
  const db: FakeDb = { schemaPaths: [], setSchemaPath (path) { this.schemaPaths.push(path) } }
  const strand = { database: { getDatabase: () => db } }
  const calls: FakeHost['calls'] = { addStrand: [], recordCarriedStrandAddrs: [], whenStrandWritable: [] }
  const host = {
    calls,
    db,
    getControlNode: () => ({ getConnections: () => new Array(connections).fill({}) }),
    addStrand: async (config: unknown) => {
      calls.addStrand.push(config as AddStrandConfig)
      if (opts.addStrand) return (await opts.addStrand(config as AddStrandConfig)) as never
      return strand as never
    },
    whenStrandWritable: async (strandId: string) => {
      calls.whenStrandWritable.push(strandId)
      return strand as never
    },
    getCarriedStrandAddrs: () => [...(opts.carried ?? [])],
    recordCarriedStrandAddrs: async (strandId: string, addrs: readonly string[]) => {
      calls.recordCarriedStrandAddrs.push({ strandId, addrs })
    },
  }
  return host as unknown as FakeHost
}

function gateError (strandId: string): Error {
  const err = new Error('awaiting first sync')
  err.name = 'StrandAwaitingFirstSyncError'
  ;(err as { strandId?: string }).strandId = strandId
  return err
}

describe('common strand', function () {
  this.timeout(10_000)

  let savedInfo: typeof console.info
  let savedWarn: typeof console.warn
  beforeEach(() => {
    savedInfo = console.info
    savedWarn = console.warn
    console.info = () => undefined
    console.warn = () => undefined
  })
  afterEach(() => {
    console.info = savedInfo
    console.warn = savedWarn
    expect(takeFounderIntent('__probe__')).to.equal(null)
  })

  it('MS-1: with no intent and no joined list, 0 control connections opens as founder and 2 do not', async () => {
    const solo = makeFakeHost({ connections: 0 })
    await createStrandDbFactory(solo)('h-ms1a')
    expect(solo.calls.addStrand).to.have.lengthOf(1)
    expect(solo.calls.addStrand[0]!.founder).to.equal(true)

    const peered = makeFakeHost({ connections: 2 })
    await createStrandDbFactory(peered)('h-ms1b')
    expect(peered.calls.addStrand).to.have.lengthOf(1)
    expect(peered.calls.addStrand[0]!.founder).to.equal(false)
  })

  it('MS-2: a factory call inside withFounding is founder despite 2 connections, and the window is consumed', async () => {
    const host = makeFakeHost({ connections: 2 })
    const factory = createStrandDbFactory(host)
    await withFounding(async () => {
      await factory('h-ms2')
      expect(takeFounderIntent('__probe__')).to.equal(null)
    })
    expect(host.calls.addStrand).to.have.lengthOf(1)
    expect(host.calls.addStrand[0]!.founder).to.equal(true)
  })

  it('MS-3: a joining window for h1 makes h1 a joiner and leaves h2 at the default', async () => {
    const host = makeFakeHost({ connections: 0 })
    const factory = createStrandDbFactory(host)
    await withJoining('h1', async () => {
      await factory('h1')
      await factory('h2')
    })
    expect(host.calls.addStrand).to.have.lengthOf(2)
    expect(host.calls.addStrand[0]!.strandRow.Id).to.equal('h1')
    expect(host.calls.addStrand[0]!.founder).to.equal(false)
    expect(host.calls.addStrand[1]!.strandRow.Id).to.equal('h2')
    expect(host.calls.addStrand[1]!.founder).to.equal(true)
  })

  it('MS-4: a joined hash is never founder; an unreadable joined list refuses the open before addStrand', async () => {
    const joined = makeFakeHost({ connections: 0 })
    await createStrandDbFactory(joined, { isJoinedNetwork: () => true })('h-ms4a')
    expect(joined.calls.addStrand).to.have.lengthOf(1)
    expect(joined.calls.addStrand[0]!.founder).to.equal(false)

    const unreadable = makeFakeHost({ connections: 0 })
    const factory = createStrandDbFactory(unreadable, {
      isJoinedNetwork: () => {
        throw new Error('storage down')
      },
    })
    let caught: unknown
    try {
      await factory('h-ms4b')
    } catch (e) {
      caught = e
    }
    expect(caught, 'the open must reject').to.not.equal(undefined)
    expect(isJoinedNetworksUnreadableError(caught)).to.equal(true)
    expect(unreadable.calls.addStrand).to.have.lengthOf(0)
  })

  it('MS-5: relays on a plain open are merged into the carried seed once; a founding open never seeds', async () => {
    const relay = '/dns4/r/tcp/1/p2p/12D3KooWX'
    const carried = '/dns4/c/tcp/2/p2p/12D3KooWY'
    const plain = makeFakeHost({ connections: 0, carried: [carried] })
    await createStrandDbFactory(plain)('h-ms5a', { relays: [relay] })
    expect(plain.calls.recordCarriedStrandAddrs).to.have.lengthOf(1)
    expect(plain.calls.recordCarriedStrandAddrs[0]!.strandId).to.equal('h-ms5a')
    expect(plain.calls.recordCarriedStrandAddrs[0]!.addrs).to.deep.equal([carried, relay])

    const founding = makeFakeHost({ connections: 0, carried: [carried] })
    await withFounding(() => createStrandDbFactory(founding)('h-ms5b', { relays: [relay] }))
    expect(founding.calls.recordCarriedStrandAddrs).to.have.lengthOf(0)
    expect(founding.calls.addStrand[0]!.founder).to.equal(true)
  })

  it('MS-6: the addStrand config carries the strand row, the org.votetorrent sApp with the inner DDL, and the db gets setSchemaPath([App, main])', async () => {
    const host = makeFakeHost({ connections: 0 })
    const db = await createStrandDbFactory(host)('h-ms6')
    const config = host.calls.addStrand[0]!
    expect(config.strandRow).to.deep.equal({ Id: 'h-ms6', MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null })
    expect(config.sAppConfig.id).to.equal('org.votetorrent')
    expect(config.sAppConfig.version).to.equal('1.0.0')
    expect(config.sAppConfig.latencyHint).to.equal('interactive')
    expect(config.sAppConfig.schema).to.be.a('string').and.not.match(/^\s*declare\s+schema/)
    expect(config.sAppConfig.schema.length).to.be.greaterThan(0)
    expect(db).to.equal(host.db as unknown)
    expect(host.db.schemaPaths).to.deep.equal([['App', 'main']])
  })

  it('MS-7: the first-sync gate error for this strand fires onAwaitingFirstSync once and waits on whenStrandWritable without a second addStrand', async () => {
    const host = makeFakeHost({
      connections: 1,
      addStrand: async (config) => {
        throw gateError(config.strandRow.Id as string)
      },
    })
    const awaiting: string[] = []
    const db = await createStrandDbFactory(host, { onAwaitingFirstSync: (id) => awaiting.push(id) })('h-ms7')
    expect(awaiting).to.deep.equal(['h-ms7'])
    expect(host.calls.whenStrandWritable).to.deep.equal(['h-ms7'])
    expect(host.calls.addStrand).to.have.lengthOf(1)
    expect(db).to.equal(host.db as unknown)
    expect(host.db.schemaPaths).to.deep.equal([['App', 'main']])
  })

  it('MS-8: with no reporter installed, subscribe returns an unsubscribe that does not throw, and clearing the reporter does not throw', () => {
    const unsubscribe = strandChanges.subscribe(['Network'], () => undefined, { label: 'ms8' })
    expect(unsubscribe).to.be.a('function')
    expect(() => unsubscribe()).to.not.throw()
    expect(() => setStrandChangeErrorReporter(undefined)).to.not.throw()
  })
})
