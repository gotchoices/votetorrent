import {
  BuilderAlreadyCommittedError,
  BuilderValidationError,
  ElectionType,
  UserKeyType
} from '@votetorrent/vote-core'
import { expect } from 'chai'
import { NetworkEngine } from '../src/network/network-engine'
import { NetworksEngine } from '../src/networks/networks-engine'
import { NetworksCreateBuilder } from '../src/networks/builders/networks-create-builder.js'
import { MockNetworksEngine } from '../src/networks/mock-networks-engine.js'
import type { EngineContext } from '../src/types.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { AsyncStorage } from './shims/react-native'
import type {
  User,
  NetworkInit,
  INetworksEngine,
  INetworkEngine,
  Scope,
  NetworkReference
} from '@votetorrent/vote-core'

// Using AsyncStorage shim for local storage

describe('NetworksEngine', () => {
  // BLOCKED on https://github.com/gotchoices/quereus/issues/23 — Network's
  // `CantDelete check on delete (false)` fires on INSERT in Quereus 2.9.0/
  // 3.1.1. Whole-flow test depends on create() succeeding.
  it('should exercise create, clearRecentNetworks, getRecentNetworks, and open', async () => {
    // Ensure recentNetworks starts as an empty array for spread operations in create()
    await AsyncStorage.setItem('recentNetworks', [])

    const engine = new NetworksEngine(AsyncStorage) as INetworksEngine

    // getRecentNetworks (initial)
    const initialRecents = await engine.getRecentNetworks()
    expect(initialRecents).to.be.an('array').that.has.length(0)

    // clearRecentNetworks
    await engine.clearRecentNetworks()
    // Storage remove happened; do not call getRecentNetworks immediately since engine casts the result.
    expect(await AsyncStorage.getItem('recentNetworks')).to.equal(undefined)

    // Re-seed to empty for create()
    await AsyncStorage.setItem('recentNetworks', [])

    // create()
    const networkInitPass: NetworkInit = {
      name: 'Test Network',
      imageUrl: 'https://cdn.example.com/logo.png',
      relays: ['/dns4/relay.example.com/tcp/443/wss'],
      primaryAuthority: {
        name: 'Primary Authority',
        domainName: 'authority.example.com'
      },
      admin: {
        officers: [
          {
            init: {
              name: 'Admin A',
              title: 'Chair',
              scopes: ['rn', 'mel'] as Scope[]
            }
          }
        ],
        effectiveAt: Date.now(),
        thresholdPolicies: [{ policy: 'rn', threshold: 1 }]
      },
      policies: {
        timestampAuthorities: [{ url: 'https://tsa.example.com' }],
        numberRequiredTSAs: 1,
        electionType: ElectionType.adhoc
      }
    }

    const user: User = {
      id: 'user-1',
      name: 'Test User',
      imageRef: { url: 'https://img.local/user.png' },
      activeKeys: [
        {
          key: 'key-1',
          type: UserKeyType.mobile,
          expiration: Date.now() + 86_400_000
        }
      ]
    }

    const returnedNetwork: INetworkEngine = await engine.create(
      networkInitPass,
      user
    )

    // Returned engine type
    expect(returnedNetwork).to.be.instanceOf(NetworkEngine)

    // Recent networks updated
    const recents: NetworkReference[] = (await AsyncStorage.getItem('recentNetworks')) ?? []
    expect(recents).to.be.an('array').with.length(1)
    const firstRecent = recents[0]
    expect(firstRecent).to.include({
      name: networkInitPass.name,
      primaryAuthorityDomainName: networkInitPass.primaryAuthority.domainName
    })
    expect(firstRecent?.relays).to.deep.equal(networkInitPass.relays)
    expect(firstRecent?.imageUrl).to.equal(networkInitPass.imageUrl)

    // getRecentNetworks after create
    const recentViaEngine = await engine.getRecentNetworks()
    expect(recentViaEngine).to.be.an('array').with.length(1)

    // create() should fail with missing officers
    const networkInitFail: NetworkInit = {
      name: 'Failing Network',
      imageUrl: 'https://cdn.example.com/logo.png',
      relays: ['/dns4/relay.example.com/tcp/443/wss'],
      primaryAuthority: {
        name: 'Primary Authority',
        domainName: 'authority.example.com'
      },
      admin: {
        officers: [],
        effectiveAt: Date.now(),
        thresholdPolicies: []
      },
      policies: {
        timestampAuthorities: [],
        numberRequiredTSAs: 0,
        electionType: ElectionType.adhoc
      }
    }

    try {
      await engine.create(networkInitFail, user)
    } catch (error) {
      expect(error)
        .to.be.an('error')
        .with.property('message')
        .that.includes('Failed to create network: Officer init is required')
    }

    // open() returns a NetworkEngine and can store as recent (dedup to front)
    const ref: NetworkReference = {
      hash: recents?.[0]?.hash ?? '',
      relays: recents?.[0]?.relays ?? [],
      imageUrl: recents?.[0]?.imageUrl ?? '',
      name: recents?.[0]?.name ?? 'mock-name',
      primaryAuthorityDomainName: recents?.[0]?.primaryAuthorityDomainName ?? ''
    }
    const opened = await engine.open(ref, user, true)
    expect(opened).to.be.instanceOf(NetworkEngine)

    const recentsAfterOpen: NetworkReference[] = (await AsyncStorage.getItem(
      'recentNetworks'
    )) ?? []
    expect(recentsAfterOpen).to.be.an('array').with.length(1)
    expect(recentsAfterOpen?.[0]?.hash).to.equal(ref.hash)
    expect(recentsAfterOpen?.[0]?.name).to.equal(ref.name)

    // open() with storeAsRecent=false does not modify recents.
    // Note: after D-09/D-10, open() requires the hash to be in the
    // per-instance cache; we reuse the just-created ref so the cache
    // hit succeeds while exercising the storeAsRecent=false branch.
    const prev = JSON.stringify(recentsAfterOpen)
    const opened2 = await engine.open(ref, user, false)
    expect(opened2).to.be.instanceOf(NetworkEngine)
    expect(
      JSON.stringify(await AsyncStorage.getItem('recentNetworks'))
    ).to.equal(prev)
  })

  // ---------------------------------------------------------------
  // NET-01..NET-04 — Phase 3 Plan 01 additions
  // ---------------------------------------------------------------

  const makeNetworkInit = (pubKeyHex: string): NetworkInit => ({
    name: 'NET-test Network',
    imageUrl: 'https://cdn.example.com/logo.png',
    relays: ['/dns4/relay.example.com/tcp/443/wss'],
    primaryAuthority: {
      name: 'Primary Authority',
      domainName: 'authority.example.com'
    },
    admin: {
      officers: [
        {
          init: {
            name: 'Admin A',
            title: 'Chair',
            scopes: ['rn', 'mel'] as Scope[]
          }
        }
      ],
      effectiveAt: Date.now(),
      thresholdPolicies: [{ policy: 'rn', threshold: 1 }]
    },
    policies: {
      timestampAuthorities: [{ url: 'https://tsa.example.com' }],
      numberRequiredTSAs: 1,
      electionType: ElectionType.adhoc
    }
  })

  const makeUser = (pubKeyHex: string): User => ({
    id: 'net-test-user-1',
    name: 'NET Test User',
    imageRef: { url: 'https://img.local/user.png' },
    activeKeys: [
      {
        key: pubKeyHex,
        type: UserKeyType.mobile,
        expiration: Date.now() + 60_000
      }
    ]
  })

  // Helper: read the cached EngineContext for a given hash by reaching
  // into the private `contexts` Map. Tests at this layer need to inspect
  // the DB instance directly to prove NET-01/02 invariants; production
  // code never does this.
  const cachedCtx = (
    engine: NetworksEngine,
    hash: string
  ): EngineContext | undefined => {
    return (engine as unknown as {
      contexts: Map<string, EngineContext>
    }).contexts.get(hash)
  }

  // BLOCKED on https://github.com/gotchoices/quereus/issues/23
  // — `check on delete (false)` fires on INSERT in Quereus 2.9.0 / 3.1.1,
  // tripping Network.CantDelete during the create() batch. When the
  // upstream fix ships, remove `.skip` and the row-level read below
  // becomes a passing assertion.
  it('NET-01: create() binds the UserKey insert to the PubKey column and caches the EngineContext', async () => {
    await AsyncStorage.setItem('recentNetworks', [])
    const engine = new NetworksEngine(AsyncStorage)
    const { publicHex } = randomTestKeyPair()
    const user = makeUser(publicHex)
    const returned = await engine.create(makeNetworkInit(publicHex), user)
    expect(returned).to.be.instanceOf(NetworkEngine)

    const recents: NetworkReference[] =
      (await AsyncStorage.getItem('recentNetworks')) ?? []
    const hash = recents[0]?.hash ?? ''
    const ctx = cachedCtx(engine, hash)
    expect(ctx, 'context should be cached after create()').to.not.equal(
      undefined
    )

    // Plan 03-05 NET-01 row-level assertion (restored — will pass once
    // quereus#23 lands): the UserKey row written by create() must round-trip
    // through `select PubKey from UserKey where UserId = :userId` and equal
    // the hex pubkey the engine bound on insert.
    const row = await ctx!.db
      .prepare(`select PubKey from UserKey where UserId = :userId`)
      .get({ userId: user.id })
    expect(row?.['PubKey'], 'UserKey.PubKey should round-trip the inserted hex').to.equal(publicHex)
  })

  // BLOCKED on https://github.com/gotchoices/quereus/issues/23 (same
  // CantDelete-on-INSERT trip as NET-01). Restored row-level read of the
  // User row becomes a passing assertion once #23 lands.
  it('NET-02/NET-03: open() reuses the cached EngineContext.db instance from create()', async () => {
    await AsyncStorage.setItem('recentNetworks', [])
    const engine = new NetworksEngine(AsyncStorage)
    const { publicHex } = randomTestKeyPair()
    const user = makeUser(publicHex)

    const createdEngine = await engine.create(
      makeNetworkInit(publicHex),
      user
    )
    expect(createdEngine).to.be.instanceOf(NetworkEngine)

    const recents: NetworkReference[] =
      (await AsyncStorage.getItem('recentNetworks')) ?? []
    const ref = recents[0]!
    const ctxAfterCreate = cachedCtx(engine, ref.hash)
    expect(ctxAfterCreate).to.not.equal(undefined)

    const reopened = await engine.open(ref, user, false)
    expect(reopened).to.be.instanceOf(NetworkEngine)

    // Cache identity: open() must reuse the very same Database instance
    // that create() built. The EngineContext.db reference must be
    // unchanged across the create()/open() boundary.
    const ctxAfterOpen = cachedCtx(engine, ref.hash)
    expect(ctxAfterOpen).to.not.equal(undefined)
    expect(ctxAfterOpen!.db).to.equal(ctxAfterCreate!.db)

    // Plan 03-05 NET-02 row-level assertion (restored — will pass once
    // quereus#23 lands): the User row written by create() must round-trip
    // through `select Name from User where Id = :userId`.
    const userRow = await ctxAfterOpen!.db
      .prepare(`select Name from User where Id = :userId`)
      .get({ userId: user.id })
    expect(userRow?.['Name'], 'User.Name should round-trip from create()').to.equal(user.name)
  })

  it('NET-03: open() throws when called with an unknown ref hash', async () => {
    await AsyncStorage.setItem('recentNetworks', [])
    const engine = new NetworksEngine(AsyncStorage)
    const { publicHex } = randomTestKeyPair()
    const user = makeUser(publicHex)

    const unknownRef: NetworkReference = {
      hash: 'unknown-hash-no-such-network',
      relays: [],
      name: 'nope',
      primaryAuthorityDomainName: 'nope.example'
    }

    let caught: unknown
    try {
      await engine.open(unknownRef, user, false)
      expect.fail('open() should have thrown for an uncached ref hash')
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.an('error')
    expect((caught as Error).message).to.include(
      'Network not opened in this session'
    )
  })

  // BLOCKED on https://github.com/gotchoices/quereus/issues/23 (CantDelete
  // fires on INSERT). NET-04 itself only tests LocalStorage, but it gates
  // on a successful create() call which trips #23.
  it('NET-04: getRecentNetworks() round-trips through LocalStorage after create()', async () => {
    await AsyncStorage.setItem('recentNetworks', [])
    const engine = new NetworksEngine(AsyncStorage)
    const { publicHex } = randomTestKeyPair()
    const user = makeUser(publicHex)
    await engine.create(makeNetworkInit(publicHex), user)

    const recents = await engine.getRecentNetworks()
    expect(recents).to.be.an('array').with.length(1)
    expect(recents[0]?.name).to.equal('NET-test Network')
    expect(recents[0]?.hash).to.be.a('string').with.length.greaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// NetworksCreateBuilder — Phase 08 Plan 01
// ---------------------------------------------------------------------------

function makeStubNetworksEngine (): INetworksEngine {
  const stub: INetworksEngine = {
    async clearRecentNetworks () {},
    async create (_init: NetworkInit, _user: User): Promise<INetworkEngine> {
      return {} as INetworkEngine
    },
    async getRecentNetworks () { return [] },
    async open () { return {} as INetworkEngine },
    buildCreate () { return new NetworksCreateBuilder(stub) }
  }
  return stub
}

function makeBuilderNetworkInit (): NetworkInit {
  return {
    name: 'Builder Test Network',
    imageUrl: 'https://cdn.example.com/logo.png',
    relays: ['/dns4/relay.example.com/tcp/443/wss'],
    primaryAuthority: {
      name: 'Primary Authority',
      domainName: 'authority.example.com'
    },
    admin: {
      officers: [{ init: { name: 'Admin', title: 'Chair', scopes: ['rn'] as Scope[] } }],
      effectiveAt: Date.now(),
      thresholdPolicies: [{ policy: 'rn', threshold: 1 }]
    },
    policies: {
      timestampAuthorities: [{ url: 'https://tsa.example.com' }],
      numberRequiredTSAs: 1,
      electionType: ElectionType.adhoc
    }
  }
}

function makeBuilderUser (): User {
  return {
    id: 'builder-user-1',
    name: 'Builder Test User',
    activeKeys: [{ key: 'abc123hex', type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 }]
  }
}

describe('NetworksCreateBuilder', () => {
  // Test 1 — BTEST-01
  it('empty builder reports isValid===false and lists required missingFields', () => {
    const engine = makeStubNetworksEngine()
    const builder = new NetworksCreateBuilder(engine)
    expect(builder.isValid()).to.equal(false)
    const missing = builder.missingFields()
    expect(missing.map(m => m.path)).to.include('networkInit')
    expect(missing.map(m => m.path)).to.include('user')
  })

  // Test 2 — VALID-01
  it('per-setter validation: invalid networkInit records BuilderError without throwing', () => {
    const engine = makeStubNetworksEngine()
    const invalidInit = { name: '', relays: [], policies: null, primaryAuthority: null, admin: null } as unknown as NetworkInit
    const b = new NetworksCreateBuilder(engine).setNetworkInit(invalidInit)
    // Should not throw -- errors are recorded
    const errs = b.errors()
    expect(errs.some(e => e.kind === 'per-setter')).to.equal(true)
    // Now set a valid networkInit, per-setter errors for networkInit should clear
    const b2 = new NetworksCreateBuilder(engine).setNetworkInit(makeBuilderNetworkInit())
    const errs2 = b2.errors().filter(e => e.path.startsWith('networkInit'))
    expect(errs2.length).to.equal(0)
  })

  // Test 3 — BTEST-01
  it('errors/missingFields progression as setters fill fields', () => {
    const engine = makeStubNetworksEngine()
    const b0 = new NetworksCreateBuilder(engine)
    expect(b0.missingFields().length).to.equal(2) // networkInit + user

    const b1 = b0.setNetworkInit(makeBuilderNetworkInit())
    expect(b1.missingFields().length).to.equal(1) // user still missing
    expect(b1.missingFields()[0]?.path).to.equal('user')

    const b2 = b1.setUser(makeBuilderUser())
    expect(b2.missingFields().length).to.equal(0)
    expect(b2.isValid()).to.equal(true)
  })

  // Test 4 — DB-bound (real engine)
  it('REAL ENGINE: isValid===true => commit() returns INetworkEngine', async () => {
    await AsyncStorage.clear()
    await AsyncStorage.setItem('recentNetworks', [])
    const networksEngine = new NetworksEngine(AsyncStorage)
    const b = new NetworksCreateBuilder(networksEngine)
      .setNetworkInit(makeBuilderNetworkInit())
      .setUser(makeBuilderUser())
    expect(b.isValid()).to.equal(true)
    const result = await b.commit()
    expect(result).to.not.equal(undefined)
  })

  // Test 5 — SER-04
  it('round-trip serialization and fromJSON kind/version rejection', () => {
    const engine = makeStubNetworksEngine()
    const b = new NetworksCreateBuilder(engine)
      .setNetworkInit(makeBuilderNetworkInit())
      .setUser(makeBuilderUser())
    const json = b.toJSON()

    // Round-trip via JSON.parse(JSON.stringify(...))
    const roundTripped = JSON.parse(JSON.stringify(json))
    expect(roundTripped).to.deep.equal(json)

    // fromJSON reproduces draft + validation state
    const restored = NetworksCreateBuilder.fromJSON(json, engine)
    expect(restored.isValid()).to.equal(b.isValid())
    expect(restored.toJSON()).to.deep.equal(json)

    // Rejects wrong kind
    expect(() => NetworksCreateBuilder.fromJSON({ kind: 'wrong', version: 1, draft: {} }, engine))
      .to.throw(/unknown kind/)

    // Rejects wrong version
    expect(() => NetworksCreateBuilder.fromJSON({ kind: 'networks.create', version: 99, draft: {} }, engine))
      .to.throw(/unsupported version/)
  })

  // Test 6 — DB-bound (real engine)
  it('REAL ENGINE: double-commit guard throws BuilderAlreadyCommittedError', async () => {
    await AsyncStorage.clear()
    await AsyncStorage.setItem('recentNetworks', [])
    const networksEngine = new NetworksEngine(AsyncStorage)
    const b = new NetworksCreateBuilder(networksEngine)
      .setNetworkInit(makeBuilderNetworkInit())
      .setUser(makeBuilderUser())
    await b.commit()
    let caught: unknown
    try { b.commit() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  // Test 7 — BTEST-01
  it('toEngineInput returns compound { networkInit, user } shape; throws on incomplete', () => {
    const engine = makeStubNetworksEngine()
    const bIncomplete = new NetworksCreateBuilder(engine)
    expect(() => bIncomplete.toEngineInput()).to.throw(BuilderValidationError)

    const bComplete = new NetworksCreateBuilder(engine)
      .setNetworkInit(makeBuilderNetworkInit())
      .setUser(makeBuilderUser())
    const input = bComplete.toEngineInput()
    expect(input).to.have.property('networkInit')
    expect(input).to.have.property('user')
    expect(input.networkInit.name).to.equal('Builder Test Network')
    expect(input.user.id).to.equal('builder-user-1')
  })

  // Test 8 — SC4 DB-FREE stub engine
  it('SC4 DB-FREE: stub INetworksEngine -- isValid===true => commit() no-throw AND double-commit sync-guard', async () => {
    const engine = makeStubNetworksEngine()
    const b = new NetworksCreateBuilder(engine)
      .setNetworkInit(makeBuilderNetworkInit())
      .setUser(makeBuilderUser())

    expect(b.isValid()).to.equal(true)

    // commit() returns a value (the stub INetworkEngine)
    const result = await b.commit()
    expect(result).to.not.equal(undefined)

    // Second commit() throws BuilderAlreadyCommittedError synchronously
    expect(() => b.commit()).to.throw(BuilderAlreadyCommittedError)
  })

  // Test 9 — equivalence smoke (real engine)
  it('REAL ENGINE equivalence smoke: engine.create(init, user) vs engine.buildCreate().fromPayload({networkInit, user}).commit()', async () => {
    const ni = makeBuilderNetworkInit()
    const u = makeBuilderUser()
    // Direct path
    await AsyncStorage.clear()
    await AsyncStorage.setItem('recentNetworks', [])
    const eng1 = new NetworksEngine(AsyncStorage)
    const directResult = await eng1.create(ni, u)
    expect(directResult).to.not.equal(undefined)
    // Builder path
    await AsyncStorage.clear()
    await AsyncStorage.setItem('recentNetworks', [])
    const eng2 = new NetworksEngine(AsyncStorage)
    const builderResult = await eng2.buildCreate().fromPayload({ networkInit: ni, user: u }).commit()
    expect(builderResult).to.not.equal(undefined)
  })

  // Test 10 — FACT-04
  it('FACT-04 parity: MockNetworksEngine.buildCreate() returns instanceof NetworksCreateBuilder', () => {
    const mockEngine = new MockNetworksEngine()
    const builder = mockEngine.buildCreate()
    expect(builder).to.be.instanceOf(NetworksCreateBuilder)
  })

  // Test 11 — cross-field validation
  it('cross-field: policies.numberRequiredTSAs > timestampAuthorities.length surfaces cross-field error', () => {
    const engine = makeStubNetworksEngine()
    const ni = makeBuilderNetworkInit()
    ni.policies.numberRequiredTSAs = 5 // exceeds timestampAuthorities.length (1)
    const b = new NetworksCreateBuilder(engine)
      .setNetworkInit(ni)
      .setUser(makeBuilderUser())
    expect(b.isValid()).to.equal(false)
    const crossFieldErrors = b.errors().filter(e => e.kind === 'cross-field')
    expect(crossFieldErrors.length).to.be.greaterThan(0)
    expect(crossFieldErrors.some(e => e.code === 'TSA_MISMATCH')).to.equal(true)
  })
})
