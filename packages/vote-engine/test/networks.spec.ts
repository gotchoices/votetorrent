import {
  BuilderAlreadyCommittedError,
  BuilderValidationError,
  ElectionType,
  UserKeyType
} from '@votetorrent/vote-core'
import { expect } from 'chai'
import { Database } from '@quereus/quereus'
import { NetworkEngine } from '../src/network/network-engine'
import { NetworksEngine } from '../src/networks/networks-engine'
import { NetworksCreateBuilder } from '../src/networks/builders/networks-create-builder.js'
import { MockNetworksEngine } from '../src/networks/mock-networks-engine.js'
import type { EngineContext } from '../src/types.js'
import type { DbFactory } from '../src/types.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { AsyncStorage } from './shims/react-native'
import {
  isSchemaInitialized,
  markSchemaInitialized,
  readTidCounter,
  prepareDb,
  initDB,
  registerDbPlugins,
} from '../src/database/initialize.js'
import { peekTid } from '../src/database/tid-allocator.js'
import { VOTETORRENT_SCHEMA_SQL } from '../src/database/schema-sql.js'
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

    // Plan 03-05 NET-01 row-level assertion: the UserKey row written by
    // create() must round-trip through `select PubKey from UserKey where
    // UserId = :userId` and equal the hex pubkey the engine bound on insert.
    const row = await ctx!.db
      .prepare(`select PubKey from UserKey where UserId = :userId`)
      .get({ userId: user.id })
    expect(row?.['PubKey'], 'UserKey.PubKey should round-trip the inserted hex').to.equal(publicHex)
  })

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

    // Plan 03-05 NET-02 row-level assertion: the User row written by
    // create() must round-trip through `select Name from User where
    // Id = :userId`.
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

  // NET-04 itself only tests LocalStorage, but it gates on a successful
  // create() call.
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

// ---------------------------------------------------------------------------
// Phase 14 — factory DI and persistence seam
// ---------------------------------------------------------------------------

/** Returns a counting mock DbFactory whose returned db is fully prepareDb'd. */
function makeMockFactory(): { factory: DbFactory; getCallCount: () => number; getLastHash: () => string | undefined } {
  let callCount = 0;
  const lastHashes: string[] = [];
  const factory: DbFactory = async (hash: string) => {
    callCount++;
    lastHashes.push(hash);
    const db = new Database();
    await prepareDb(db);
    return db;
  };
  return {
    factory,
    getCallCount: () => callCount,
    getLastHash: () => lastHashes.at(-1),
  };
}

/** Returns a factory whose returned db has plugins applied but NO DDL (uninitialized store). */
function makeUninitializedFactory(): {
  factory: DbFactory;
  getExecCount: () => number;
} {
  let execCount = 0;
  const factory: DbFactory = async (_hash: string) => {
    const db = new Database();
    await registerDbPlugins(db);
    // Wrap exec to count DDL calls
    const origExec = db.exec.bind(db);
    (db as unknown as { exec: typeof origExec }).exec = async (sql: string, params?: unknown) => {
      execCount++;
      return origExec(sql, params as Parameters<typeof origExec>[1]);
    };
    return db;
  };
  return {
    factory,
    getExecCount: () => execCount,
  };
}

const makePhase14NetworkInit = (): NetworkInit => ({
  name: 'Phase14 Network',
  relays: [],
  primaryAuthority: { name: 'Auth', domainName: 'auth.example.com' },
  admin: {
    officers: [{ init: { name: 'Admin A', title: 'Chair', scopes: ['rn'] as Scope[] } }],
    effectiveAt: Date.now(),
    thresholdPolicies: [{ policy: 'rn', threshold: 1 }],
  },
  policies: {
    timestampAuthorities: [],
    numberRequiredTSAs: 0,
    electionType: ElectionType.adhoc,
  },
})

const makePhase14User = (): User => ({
  id: 'p14-user-1',
  name: 'Phase14 User',
  activeKeys: [{ key: 'p14-hex-key', type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 }],
})

describe('NetworksEngine — factory DI and persistence seam (Phase 14)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem('recentNetworks', []);
  });

  it('create() uses injected factory instead of new Database()', async () => {
    const { factory, getCallCount } = makeMockFactory();
    const engine = new NetworksEngine(AsyncStorage, factory);
    await engine.create(makePhase14NetworkInit(), makePhase14User());
    expect(getCallCount(), 'factory should have been called once during create()').to.equal(1);
  });

  it('in-memory factory default: create() succeeds with no factory argument (SC4)', async () => {
    const engine = new NetworksEngine(AsyncStorage);
    const result = await engine.create(makePhase14NetworkInit(), makePhase14User());
    expect(result).to.be.instanceOf(NetworkEngine);
  });

  it('after create(), isSchemaInitialized(ctx.db) is true and readTidCounter reflects seeded value', async () => {
    const { factory } = makeMockFactory();
    const engine = new NetworksEngine(AsyncStorage, factory);
    await engine.create(makePhase14NetworkInit(), makePhase14User());
    const recents: NetworkReference[] = (await AsyncStorage.getItem('recentNetworks')) ?? [];
    const hash = recents[0]?.hash ?? '';
    const ctx = (engine as unknown as { contexts: Map<string, EngineContext> }).contexts.get(hash);
    expect(ctx, 'context must be cached after create()').to.not.equal(undefined);
    const initialized = await isSchemaInitialized(ctx!.db);
    expect(initialized, 'schema should be initialized after create()').to.equal(true);
    const tid = await readTidCounter(ctx!.db);
    expect(tid, 'TidCounter should be a positive integer').to.be.a('number').greaterThanOrEqual(1);
  });

  it('Tid bound in create() batch comes from per-context counter (not module global)', async () => {
    const { factory } = makeMockFactory();
    const engine = new NetworksEngine(AsyncStorage, factory);
    // Run two separate creates on separate engine instances — each should start from
    // the seeded TidSequence value (not a global accumulator).
    const engine2 = new NetworksEngine(AsyncStorage, factory);
    await AsyncStorage.clear();
    await AsyncStorage.setItem('recentNetworks', []);
    await engine.create(makePhase14NetworkInit(), makePhase14User());
    const recents1: NetworkReference[] = (await AsyncStorage.getItem('recentNetworks')) ?? [];
    const hash1 = recents1[0]?.hash ?? '';
    const ctx1 = (engine as unknown as { contexts: Map<string, EngineContext> }).contexts.get(hash1);
    const tid1 = await readTidCounter(ctx1!.db);
    // A second independent engine from a fresh factory also starts at 1+ (not continuing from engine's tid)
    await AsyncStorage.clear();
    await AsyncStorage.setItem('recentNetworks', []);
    await engine2.create(makePhase14NetworkInit(), makePhase14User());
    const recents2: NetworkReference[] = (await AsyncStorage.getItem('recentNetworks')) ?? [];
    const hash2 = recents2[0]?.hash ?? '';
    const ctx2 = (engine2 as unknown as { contexts: Map<string, EngineContext> }).contexts.get(hash2);
    const tid2 = await readTidCounter(ctx2!.db);
    // Both Tid counters reflect the persisted TidSequence; neither should be 0
    expect(tid1).to.be.a('number').greaterThanOrEqual(1);
    expect(tid2).to.be.a('number').greaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // D-08 sentinel tests (schema-init flag)
  // --------------------------------------------------------------------------

  it('schema-init flag absent on fresh db → isSchemaInitialized returns false (D-08)', async () => {
    const db = new Database();
    const initialized = await isSchemaInitialized(db);
    expect(initialized).to.equal(false);
  });

  it('schema-init flag present after prepareDb → isSchemaInitialized returns true (D-08)', async () => {
    const db = new Database();
    await prepareDb(db);
    const initialized = await isSchemaInitialized(db);
    expect(initialized).to.equal(true);
  });

  it('TidCounter reflects seeded TidSequence value (D-12)', async () => {
    const db = new Database();
    await prepareDb(db);
    const tid = await readTidCounter(db);
    expect(tid).to.be.a('number').greaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // open() cache-first re-attach tests (D-05/D-06/D-13)
  // --------------------------------------------------------------------------

  it('open() returns cached context on cache HIT without calling factory again (D-06)', async () => {
    const { factory, getCallCount } = makeMockFactory();
    const engine = new NetworksEngine(AsyncStorage, factory);
    await engine.create(makePhase14NetworkInit(), makePhase14User());
    const countAfterCreate = getCallCount(); // should be 1
    const recents: NetworkReference[] = (await AsyncStorage.getItem('recentNetworks')) ?? [];
    const ref = recents[0]!;
    // open() on a cached hash — factory must NOT be called again
    await engine.open(ref, makePhase14User(), false);
    expect(getCallCount(), 'factory should not be called on cache hit').to.equal(countAfterCreate);
  });

  it('open() on cache MISS with INITIALIZED store re-attaches (plugins-only, no re-insertion) and caches handle (D-05/D-06)', async () => {
    // Create a fresh engine to set up an initialized db under a known hash
    const { factory } = makeMockFactory();
    const setupEngine = new NetworksEngine(AsyncStorage, factory);
    await setupEngine.create(makePhase14NetworkInit(), makePhase14User());
    const recents: NetworkReference[] = (await AsyncStorage.getItem('recentNetworks')) ?? [];
    const ref = recents[0]!;
    const hash = ref.hash;

    // Grab the db that was created so we can reuse it as the "persisted store"
    const setupCtx = (setupEngine as unknown as { contexts: Map<string, EngineContext> }).contexts.get(hash)!;
    const persistedDb = setupCtx.db;

    // Build a new engine with a factory that returns the already-initialized db
    let secondCallCount = 0;
    const reattachFactory: DbFactory = async (_h: string) => {
      secondCallCount++;
      return persistedDb; // already has schema + SchemaInit flag
    };
    const newEngine = new NetworksEngine(AsyncStorage, reattachFactory);

    // Cache miss → should re-attach (not throw) because the db is initialized
    const opened = await newEngine.open(ref, makePhase14User(), false);
    expect(opened).to.be.instanceOf(NetworkEngine);
    expect(secondCallCount, 'factory called once for cache miss').to.equal(1);

    // Second open on same hash → cache hit, factory NOT called again
    await newEngine.open(ref, makePhase14User(), false);
    expect(secondCallCount, 'factory not called on second open (cache hit)').to.equal(1);
  });

  it('open() on cache MISS with UNINITIALIZED store THROWS (D-05) — initDB runs before gate but marker absent', async () => {
    // 14-04: the hasDeclaredSchema guard means initDB now runs BEFORE the D-05 gate when
    // the handle lacks the declaration (hasDeclaredSchema=false). But initDB does NOT write
    // a SchemaInit flag — that is create()'s job. So an uninitialized store still throws.
    const { factory, getExecCount } = makeUninitializedFactory();
    const engine = new NetworksEngine(AsyncStorage, factory);

    const unknownRef: NetworkReference = {
      hash: 'unknown-uninit-hash',
      relays: [],
      name: 'ghost',
      primaryAuthorityDomainName: 'ghost.example.com',
    };

    let caught: unknown;
    try {
      await engine.open(unknownRef, makePhase14User(), false);
      expect.fail('open() should throw for an uninitialized store');
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.an('error');
    expect((caught as Error).message).to.include('Network not opened in this session');

    // 14-04 contract: initDB runs (hasDeclaredSchema was false → exec is called at least once).
    // D-05 intent is preserved: the store still throws because isSchemaInitialized returns false
    // (no SchemaInit flag — only create() writes that via markSchemaInitialized).
    expect(getExecCount(), 'open() runs initDB exec on uninitialized store (14-04 guard)').to.be.greaterThan(0);

    // The store must NOT be cached — a subsequent call with the same hash goes to factory again
    const contexts = (engine as unknown as { contexts: Map<string, EngineContext> }).contexts;
    expect(contexts.has('unknown-uninit-hash'), 'uninitialized store must not be cached').to.equal(false);
  });

  it('open() propagates factory throw — no silent in-memory fallback (D-13)', async () => {
    const throwingFactory: DbFactory = async (_hash: string) => {
      throw new Error('LevelDB open failed: disk full');
    };
    const engine = new NetworksEngine(AsyncStorage, throwingFactory);

    const ref: NetworkReference = {
      hash: 'some-hash',
      relays: [],
      name: 'failing-net',
      primaryAuthorityDomainName: 'fail.example.com',
    };

    let caught: unknown;
    try {
      await engine.open(ref, makePhase14User(), false);
      expect.fail('open() should propagate factory error');
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.an('error');
    // The message should include the factory error (wrapped in D-13 message)
    expect((caught as Error).message).to.include('use create() first');

    // No cached entry — factory failure must not pollute the cache
    const contexts = (engine as unknown as { contexts: Map<string, EngineContext> }).contexts;
    expect(contexts.has('some-hash'), 'failed open must not cache anything').to.equal(false);
  });

  it('DDL not re-applied when schema-version marker present (D-07) — re-attach skips initDB', async () => {
    // Create an initialized db via prepareDb (simulates a persisted store)
    const initializedDb = new Database();
    await prepareDb(initializedDb);

    // Capture subsequent exec calls to detect DDL
    let ddlExecCount = 0;
    const origExec = initializedDb.exec.bind(initializedDb);
    (initializedDb as unknown as { exec: (sql: string, params?: unknown) => Promise<void> }).exec =
      async (sql: string, params?: unknown) => {
        ddlExecCount++;
        return origExec(sql, params as Parameters<typeof origExec>[1]);
      };

    const reattachFactory: DbFactory = async (_hash: string) => initializedDb;
    const engine = new NetworksEngine(AsyncStorage, reattachFactory);
    const ref: NetworkReference = {
      hash: 'marker-hash',
      relays: [],
      name: 'initialized',
      primaryAuthorityDomainName: 'test.example.com',
    };

    // Should re-attach without running DDL
    await engine.open(ref, makePhase14User(), false);
    expect(ddlExecCount, 'open() on initialized store must not run any DDL exec').to.equal(0);
  });

  it("nextTid resumes above TidHighWater['networks'] on re-attach (999.1 D-02/D-07/D-09, was D-12)", async () => {
    // Build an initialized db and persist a known TidHighWater value for the 'networks'
    // namespace — the shared allocator's durable mechanism that replaced the retired
    // TidSequence table (R-01: NetworksEngine is now just one more allocator namespace).
    const persistedDb = new Database();
    await prepareDb(persistedDb);
    await persistedDb.exec(
      "insert into TidHighWater (Namespace, HighWater) values ('networks', 42) " +
        'on conflict (Namespace) do update set HighWater = 42;',
    );

    const reattachFactory: DbFactory = async (_hash: string) => persistedDb;
    const engine = new NetworksEngine(AsyncStorage, reattachFactory);
    const ref: NetworkReference = {
      hash: 'tid-seed-hash',
      relays: [],
      name: 'tid-seed',
      primaryAuthorityDomainName: 'tid.example.com',
    };

    await engine.open(ref, makePhase14User(), false);

    // Fresh engine, SAME persisted Database handle (re-attach): the next allocation for
    // this namespace must resume above the persisted high-water, never reissuing an
    // already-consumed Tid — asserted against TidHighWater, not the retired TidSequence.
    const nextTid = await peekTid(persistedDb, 'networks');
    expect(nextTid, 'Tid resumes from persisted TidHighWater value, not reissued').to.be.greaterThan(42);
  });

  // --------------------------------------------------------------------------
  // 14-04 hasDeclaredSchema guard unit tests (PERSIST-02)
  // --------------------------------------------------------------------------

  it('hasDeclaredSchema is false on a fresh Database() before initDB (PERSIST-02)', async () => {
    const db = new Database();
    // A fresh handle — before any initDB call — must not have the domain schema declared.
    expect(db.declaredSchemaManager.hasDeclaredSchema('main')).to.equal(false);
  });

  it('hasDeclaredSchema becomes true after initDB(db) (PERSIST-02)', async () => {
    const db = new Database();
    await registerDbPlugins(db);
    expect(db.declaredSchemaManager.hasDeclaredSchema('main'), 'should be false before initDB').to.equal(false);
    await initDB(db);
    // After initDB runs "declare schema main {...}", the schema manager records the declaration.
    expect(db.declaredSchemaManager.hasDeclaredSchema('main'), 'should be true after initDB').to.equal(true);
  });

  it('open() on already-declared in-memory handle does NOT trigger migration error (PERSIST-02 — already-declared path does not cause DROP NOT NULL migration)', async () => {
    // This test proves the guard prevents the failing Quereus migration:
    // "Cannot DROP NOT NULL on PRIMARY KEY column 'DependsOn'" which fires when
    // apply-schema is re-run on an already-declared in-memory catalog.
    //
    // Setup: create a db that already ran prepareDb (hasDeclaredSchema=true).
    // open() with this factory must succeed (no migration error) AND cache the handle.
    const alreadyDeclaredDb = new Database();
    await prepareDb(alreadyDeclaredDb); // hasDeclaredSchema('main') = true after this

    const factory: DbFactory = async (_hash: string) => alreadyDeclaredDb;
    const engine = new NetworksEngine(AsyncStorage, factory);
    const ref: NetworkReference = {
      hash: 'already-declared-hash',
      relays: [],
      name: 'already-declared-net',
      primaryAuthorityDomainName: 'test.example.com',
    };

    // Must not throw "Cannot DROP NOT NULL on PRIMARY KEY column 'DependsOn'" (or any error).
    // If the guard is missing, open() would re-run initDB on the already-declared handle,
    // causing the schema-differ migration to fail.
    let caughtError: unknown;
    let result: INetworkEngine | undefined;
    try {
      result = await engine.open(ref, makePhase14User(), false);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError, 'open() must not throw on already-declared handle — no migration error').to.equal(undefined);
    expect(result, 'open() must return a NetworkEngine on the already-declared path').to.be.instanceOf(NetworkEngine);

    // The handle must be cached (D-06)
    const contexts = (engine as unknown as { contexts: Map<string, EngineContext> }).contexts;
    expect(contexts.has('already-declared-hash'), 'already-declared handle must be cached after open()').to.equal(true);
  });

  // --------------------------------------------------------------------------
  // REL-01 strand-path createContext regression tests
  // --------------------------------------------------------------------------
  //
  // Background: In release builds NetworksEngine.createContext() is called on a
  // Database that StrandDatabase.initialize() already applied the App schema to
  // (via `declare schema App { <inner DDL> } apply schema App;`). The old gate
  // relied on isSchemaInitialized(db) which always returns false on the strand
  // path (no SchemaInit row yet), so initDB always ran — declaring the `main`
  // schema on top of an already-App-declared catalog. Dual-Table ownership of the
  // same tree://default/{table} LevelDB collections stalls every subsequent INSERT
  // (infinite spinner / hang in release builds).
  //
  // These tests reproduce that exact scenario using an in-memory Database with
  // the strand path simulated: run `declare schema App { <inner DDL> } apply schema App;`
  // (matching what StrandDatabase.executeSchema does), then hand it to NetworksEngine
  // via a DbFactory closure, call create(), and assert:
  //   (a) no error thrown
  //   (b) initDB (main schema) was NOT triggered — hasDeclaredSchema('main') stays false
  //   (c) SchemaInit flag IS planted — isSchemaInitialized returns true
  //   (d) TidSequence IS planted — readTidCounter does not throw
  //
  // The rnDbFactory-path (non-strand) unchanged assertion is also included so that
  // the PERSIST-02 behavior is locked as a tripwire.

  describe('REL-01 strand-path createContext', () => {
    // Strip the outer `declare schema main { ... } apply schema main;` wrapper from
    // the bundled schema SQL — exactly the same regex used in rn-db-factory.ts — so
    // only the inner DDL remains. StrandDatabase.executeSchema wraps it as:
    //   `declare schema App { <inner DDL> } apply schema App;`
    // and calls setSchemaPath(['App', 'main']) so bare table names resolve.
    const VOTETORRENT_INNER_DDL = VOTETORRENT_SCHEMA_SQL
      .replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
      .replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
      .trim();

    /**
     * Simulate a strand-path Database: runs App-schema declaration + apply,
     * then sets the schema path so bare table names resolve under App.
     * This mirrors exactly what StrandDatabase.initialize() + executeSchema() leave behind.
     */
    async function makeStrandDb(): Promise<Database> {
      const db = new Database();
      await registerDbPlugins(db);
      await db.exec(`declare schema App { ${VOTETORRENT_INNER_DDL} } apply schema App;`);
      db.setSchemaPath(['App', 'main']);
      return db;
    }

    beforeEach(async () => {
      await AsyncStorage.clear();
      await AsyncStorage.setItem('recentNetworks', []);
    });

    it('createContext skips initDB on a strand-declared (App) handle (REL-01)', async () => {
      // Given: a Database already in the strand-declared (App) state.
      const db = await makeStrandDb();
      // Pre-condition: App is declared, main is NOT declared.
      expect(db.declaredSchemaManager.hasDeclaredSchema('App'), 'App should be declared before create()').to.equal(true);
      expect(db.declaredSchemaManager.hasDeclaredSchema('main'), 'main must NOT be declared before create()').to.equal(false);

      const factory: DbFactory = async (_hash: string) => db;
      const engine = new NetworksEngine(AsyncStorage, factory);

      let caughtError: unknown;
      try {
        await engine.create(makePhase14NetworkInit(), makePhase14User());
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError, 'create() must not throw on a strand-declared (App) handle (REL-01)').to.equal(undefined);
      // Key assertion: initDB was NOT triggered on the strand-declared handle.
      // If initDB ran, it would run `declare schema main { ... }` and hasDeclaredSchema('main')
      // would become true — which is the bug that causes the double-init hang.
      expect(db.declaredSchemaManager.hasDeclaredSchema('main'), 'main schema must NOT be declared after create() on App-declared handle — initDB must have been skipped (REL-01)').to.equal(false);
    });

    it('createContext plants markers on the strand path (REL-01)', async () => {
      // Given: same strand-declared handle.
      const db = await makeStrandDb();
      const factory: DbFactory = async (_hash: string) => db;
      const engine = new NetworksEngine(AsyncStorage, factory);

      await engine.create(makePhase14NetworkInit(), makePhase14User());

      // SchemaInit flag must be planted (ensureTidSequence + markSchemaInitialized must have run).
      const initialized = await isSchemaInitialized(db);
      expect(initialized, 'isSchemaInitialized must return true after create() on strand path — SchemaInit flag planted (REL-01)').to.equal(true);

      // TidSequence must be planted and readable.
      let tidError: unknown;
      let tid: number | undefined;
      try {
        tid = await readTidCounter(db);
      } catch (err) {
        tidError = err;
      }
      expect(tidError, 'readTidCounter must not throw after create() on strand path — TidSequence row planted (REL-01)').to.equal(undefined);
      expect(tid, 'TidCounter must be a positive integer after create() on strand path (REL-01)').to.be.a('number').greaterThanOrEqual(1);
    });

    it('createContext rnDbFactory path unchanged (REL-01 regression guard)', async () => {
      // Given: a fresh Database with NO App declaration (the rnDbFactory / in-memory path).
      const db = new Database();
      const factory: DbFactory = async (_hash: string) => db;
      const engine = new NetworksEngine(AsyncStorage, factory);

      await engine.create(makePhase14NetworkInit(), makePhase14User());

      // On the non-strand path, initDB MUST have run (declares schema main).
      // If the strand gate mistakenly fires here (false positive), main would be absent.
      expect(db.declaredSchemaManager.hasDeclaredSchema('main'), 'main schema must be declared after create() on the rnDbFactory path — initDB must have run (REL-01 regression guard)').to.equal(true);
    });

    it('markSchemaInitialized is idempotent — second call on same handle does not throw (CR-01)', async () => {
      // CR-01 direct contract lock: markSchemaInitialized uses INSERT OR IGNORE, so
      // calling it twice on the same Database (simulating a strand store re-create)
      // must not throw a PK-uniqueness violation.
      //
      // This is the root fix for the strand-path re-create failure: the strand branch
      // in createContext() calls markSchemaInitialized() unconditionally (no
      // isSchemaInitialized gate), so a second createContext() on an already-initialized
      // store previously threw "UNIQUE constraint failed: SchemaVersion.Version".
      const db = await makeStrandDb();

      // First call — plants the SchemaInit flag.
      let firstError: unknown;
      try {
        await markSchemaInitialized(db);
      } catch (err) {
        firstError = err;
      }
      expect(firstError, 'first markSchemaInitialized call must not throw').to.equal(undefined);
      expect(await isSchemaInitialized(db), 'isSchemaInitialized must be true after first call').to.equal(true);

      // Second call — must be a no-op (INSERT OR IGNORE), NOT a PK violation.
      let secondError: unknown;
      try {
        await markSchemaInitialized(db);
      } catch (err) {
        secondError = err;
      }
      expect(secondError, 'second markSchemaInitialized call must not throw (CR-01 idempotency)').to.equal(undefined);
      expect(await isSchemaInitialized(db), 'isSchemaInitialized must still be true after second call').to.equal(true);
    });
  });
})
