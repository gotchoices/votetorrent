import { ElectionType, UserKeyType } from '@votetorrent/vote-core'
import { expect } from 'chai'
import { NetworkEngine } from '../src/network/network-engine'
import { NetworksEngine } from '../src/networks/networks-engine'
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
          expiration: Date.now()
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
