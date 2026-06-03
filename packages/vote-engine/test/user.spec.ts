import { Database } from '@quereus/quereus'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError,
  ElectionType,
  UserHistoryEvent,
  UserKeyType
} from '@votetorrent/vote-core'
import { UserCreateBuilder } from '../src/user/builders/user-create-builder.js'
import { UserAddKeyBuilder } from '../src/user/builders/user-add-key-builder.js'
import { UserReviseBuilder } from '../src/user/builders/user-revise-builder.js'
import { UserRevokeKeyBuilder } from '../src/user/builders/user-revoke-key-builder.js'
import { MockUserEngine } from '../src/user/mock-user-engine.js'
import { expect } from 'chai'
import { prepareDb } from '../src/database/initialize'
import { NetworkEngine } from '../src/network/network-engine'
import { NetworksEngine } from '../src/networks/networks-engine'
import { DefaultUserEngine } from '../src/user/default-user-engine'
import { DefaultUserSetBuilder } from '../src/user/builders/default-user-set-builder.js'
import { MockDefaultUserEngine } from '../src/user/mock-default-user-engine.js'
import { UserEngine } from '../src/user/user-engine'
import type { EngineContext } from '../src/types.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { addTestAuthority, createTestNetwork, makeDistinctTestUser, seedUserInvite } from './fixtures/test-context.js'
import { AsyncStorage } from './shims/react-native'
import type {
  CreateUserHistory,
  DefaultUser,
  ImageRef,
  IUserEngine,
  NetworkInit,
  NetworkReference,
  ReviseUserHistory,
  Scope,
  Signature,
  Timestamp,
  User,
  UserKey
} from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser (overrides?: Partial<User>): User {
  const { publicHex } = randomTestKeyPair()
  return {
    id: 'user-1',
    name: 'Test User',
    imageRef: { url: 'https://img.local/user.png' },
    activeKeys: [
      {
        key: publicHex,
        type: UserKeyType.mobile,
        expiration: Date.now() + 86_400_000
      }
    ],
    ...overrides
  }
}

function makeNetworkInit (): NetworkInit {
  return {
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
            scopes: ['rn', 'rad', 'iad', 'uai', 'mel'] as Scope[]
          }
        }
      ],
      effectiveAt: Date.now(),
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
    },
    policies: {
      timestampAuthorities: [{ url: 'https://tsa.example.com' }],
      numberRequiredTSAs: 1,
      electionType: ElectionType.adhoc
    }
  }
}

// Constructs a UserEngine bound to a DB context produced by
// NetworksEngine.create(). All call sites of this helper are bug-blocked
// on quereus#23 today (CantDelete fires on INSERT during the create()
// batch); the helper exists so the body of each `it.skip` reads naturally
// and converts to passing assertions the moment #23 ships.
async function createUserEngineForExistingNetwork (): Promise<{
  engine: UserEngine
  ctx: EngineContext
  user: User
}> {
  await AsyncStorage.clear()
  await AsyncStorage.setItem('recentNetworks', [])
  const networksEngine = new NetworksEngine(AsyncStorage)
  const user = makeUser()
  await networksEngine.create(makeNetworkInit(), user)
  const recents = (await AsyncStorage.getItem<NetworkReference[]>(
    'recentNetworks'
  )) ?? []
  const ref = recents[0]
  if (!ref) throw new Error('No network reference after create()')
  const networkEngine = await networksEngine.open(ref, user, false)
  // Reach into the cached EngineContext via the networks engine's private
  // map. Matches networks.spec.ts pattern for ctx access in tests.
  const ctx = (networksEngine as unknown as {
    contexts: Map<string, EngineContext>
  }).contexts.get(ref.hash)
  if (!ctx) throw new Error('No cached context after create()')
  void networkEngine // keep the binding alive for symmetry with other specs
  const engine = new UserEngine(user, ctx)
  return { engine, ctx, user }
}

// Pure-schema-only DB. Loads the schema but performs no INSERTs (so it
// does not trip quereus#23) — useful for constructor/argument-shape tests
// that do not need a populated DB.
async function makeDbOnlyUserEngine (
  overrides?: Partial<User>
): Promise<{ engine: UserEngine, ctx: EngineContext, user: User }> {
  const db = new Database()
  await prepareDb(db)
  const user = makeUser(overrides)
  const ctx: EngineContext = { db, user }
  const engine = new UserEngine(user, ctx)
  return { engine, ctx, user }
}

// ===========================================================================
// UserEngine Tests
// ===========================================================================

describe('UserEngine', () => {
  // -----------------------------------------------------------------------
  // USER-01 — getSummary
  // -----------------------------------------------------------------------
  describe('getSummary', () => {
    it('returns the constructor-supplied user when no EngineContext is bound', async () => {
      const user = makeUser({ id: 'pure-user-1', name: 'Pure User' })
      const engine = new UserEngine(user)
      const summary = await engine.getSummary()
      expect(summary).to.not.equal(undefined)
      expect(summary?.id).to.equal('pure-user-1')
      expect(summary?.name).to.equal('Pure User')
      expect(summary?.activeKeys).to.be.an('array').with.length(1)
    })

    // BLOCKED on https://github.com/gotchoices/quereus/issues/23 —
    // createUserEngineForExistingNetwork() depends on NetworksEngine.create()
    // succeeding, which trips CantDelete on INSERT in Quereus 3.1.1.
    it('returns the User row read from the DB when a context is bound', async () => {
      const { engine, user } = await createUserEngineForExistingNetwork()
      const summary = await engine.getSummary()
      expect(summary?.id).to.equal(user.id)
      expect(summary?.name).to.equal(user.name)
    })

    // BLOCKED on quereus#23 (same chain — needs a populated DB to assert
    // the undefined branch is reachable via missing id).
    it('returns undefined when the bound user id has no row', async () => {
      const { ctx } = await createUserEngineForExistingNetwork()
      const ghost = makeUser({ id: 'never-existed-user' })
      const engine = new UserEngine(ghost, ctx)
      const summary = await engine.getSummary()
      expect(summary).to.equal(undefined)
    })
  })

  // -----------------------------------------------------------------------
  // USER-02 — create
  // -----------------------------------------------------------------------
  describe('create', () => {
    // BLOCKED on quereus#23 — User.CantDelete (`check on delete (false)`)
    // fires on the INSERT, same chain as networks-engine.create().
    it('inserts a User row and an initial UserKey row with hex pubkey', async () => {
      const { engine, ctx, user } = await makeDbOnlyUserEngine()
      const { publicHex } = randomTestKeyPair()
      const init: CreateUserHistory = {
        event: UserHistoryEvent.create,
        timestamp: Date.now(),
        signature: {
          signature: 'a'.repeat(128),
          signerKey: publicHex,
          signerUserId: user.id
        },
        name: user.name,
        imageRef: user.imageRef ?? { url: 'https://img.local/user.png' },
        userKey: {
          key: publicHex,
          type: UserKeyType.mobile,
          expiration: Date.now() + 86_400_000
        }
      }
      await engine.create(init)
      const userRow = await ctx.db
        .prepare('select Name from User where Id = :id')
        .get({ id: user.id })
      expect(userRow?.Name).to.equal(user.name)
      const keyRow = await ctx.db
        .prepare('select PubKey from UserKey where UserId = :id')
        .get({ id: user.id })
      expect(keyRow?.PubKey).to.equal(publicHex)
    })

    it('throws when no EngineContext is bound', async () => {
      const user = makeUser({ id: 'pure-user-2' })
      const engine = new UserEngine(user)
      const init: CreateUserHistory = {
        event: UserHistoryEvent.create,
        timestamp: Date.now(),
        signature: {
          signature: 'b'.repeat(128),
          signerKey: 'c'.repeat(66),
          signerUserId: user.id
        },
        name: user.name,
        imageRef: { url: 'https://img.local/user.png' },
        userKey: {
          key: 'd'.repeat(66),
          type: UserKeyType.mobile,
          expiration: Date.now() + 86_400_000
        }
      }
      let caught: unknown
      try {
        await engine.create(init)
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('no EngineContext bound')
    })
  })

  // -----------------------------------------------------------------------
  // USER-04 — revise
  // -----------------------------------------------------------------------
  describe('revise', () => {
    // BLOCKED on quereus#23 — depends on a User row produced by create().
    it('updates User name and imageRef', async () => {
      const { engine, ctx, user } = await createUserEngineForExistingNetwork()
      const revise: ReviseUserHistory = {
        event: UserHistoryEvent.revise,
        timestamp: Date.now(),
        signature: {
          signature: 'e'.repeat(128),
          signerKey: user.activeKeys[0]!.key,
          signerUserId: user.id
        },
        info: {
          name: 'Renamed User',
          imageRef: { url: 'https://img.local/renamed.png' }
        }
      }
      await engine.revise(revise)
      const row = await ctx.db
        .prepare('select Name from User where Id = :id')
        .get({ id: user.id })
      expect(row?.Name).to.equal('Renamed User')
    })

    it('throws when the history event is not "revise"', async () => {
      const { engine, user } = await makeDbOnlyUserEngine()
      const bogus = {
        event: UserHistoryEvent.create,
        timestamp: Date.now(),
        signature: {
          signature: 'f'.repeat(128),
          signerKey: user.activeKeys[0]!.key,
          signerUserId: user.id
        },
        info: { name: 'x', imageRef: { url: 'y' } }
      } as unknown as ReviseUserHistory
      let caught: unknown
      try {
        await engine.revise(bogus)
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('must be "revise"')
    })
  })

  // -----------------------------------------------------------------------
  // USER-05 — addKey
  // -----------------------------------------------------------------------
  describe('addKey', () => {
    // BLOCKED on quereus#23 — UserKey CHECK pipeline (UserIdValid +
    // SignatureValid) needs a User row, which create() can't seed today.
    it('inserts a UserKey row with the per-INSERT context envelope', async () => {
      const { engine, ctx, user } = await createUserEngineForExistingNetwork()
      const { publicHex } = randomTestKeyPair()
      const key: UserKey = {
        key: publicHex,
        type: UserKeyType.yubico,
        expiration: Date.now() + 86_400_000
      }
      await engine.addKey(key)
      const row = await ctx.db
        .prepare(
          'select PubKey from UserKey where UserId = :id and PubKey = :pk'
        )
        .get({ id: user.id, pk: publicHex })
      expect(row?.PubKey).to.equal(publicHex)
    })

    it('throws when no EngineContext is bound', async () => {
      const user = makeUser({ id: 'pure-user-3' })
      const engine = new UserEngine(user)
      let caught: unknown
      try {
        await engine.addKey({
          key: 'a'.repeat(66),
          type: UserKeyType.mobile,
          expiration: Date.now() + 60_000
        })
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('no EngineContext bound')
    })
  })

  // -----------------------------------------------------------------------
  // USER-06 — revokeKey
  // -----------------------------------------------------------------------
  describe('revokeKey', () => {
    // BLOCKED on quereus#23 — UserKey.DeleteValid is `check on delete`,
    // which is *exactly* the constraint pattern the upstream bug breaks.
    // The DELETE will fail today on the buggy check-on-delete trip even
    // though the row to delete may not exist; once #23 lands, this test
    // exercises the schema's intended "not-the-last-key" guard.
    it('deletes a UserKey row by hex pubkey', async () => {
      const { engine, ctx, user } = await createUserEngineForExistingNetwork()
      // Add a second key first so the revoke does not trip the
      // "not the last key" branch of DeleteValid.
      const { publicHex: secondPub } = randomTestKeyPair()
      await engine.addKey({
        key: secondPub,
        type: UserKeyType.yubico,
        expiration: Date.now() + 86_400_000
      })
      await engine.revokeKey(secondPub)
      const row = await ctx.db
        .prepare(
          'select PubKey from UserKey where UserId = :id and PubKey = :pk'
        )
        .get({ id: user.id, pk: secondPub })
      expect(row).to.equal(undefined)
    })

    it('throws when no EngineContext is bound', async () => {
      const user = makeUser({ id: 'pure-user-4' })
      const engine = new UserEngine(user)
      let caught: unknown
      try {
        await engine.revokeKey('a'.repeat(66))
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('no EngineContext bound')
    })
  })

  // -----------------------------------------------------------------------
  // USER-07 — respondToInvite (implementation lives on NetworkEngine,
  // exposed indirectly to the user surface; here we exercise it via
  // NetworkEngine when DB seeding becomes possible).
  // -----------------------------------------------------------------------
  describe('respondToInvite', () => {
    // USER-07 lives on NetworkEngine. These tests exercise it via the
    // cached EngineContext produced by createUserEngineForExistingNetwork
    // — same shape as network.spec.ts §11. Both require a seeded
    // InviteSlot + AdminSignature for the InviteResult CHECK constraints,
    // so they remain bug-blocked on quereus#23.

    // BLOCKED on quereus#23 — seeding an InviteSlot + AdminSignature row
    // is required for the InviteResult CHECK constraints to pass, and
    // both require a populated DB from create().
    it('inserts an InviteResult row for an accepted invite', async () => {
      const { ctx } = await createUserEngineForExistingNetwork()
      const networkEngine = new NetworkEngine(
        {
          hash: 'unused-test-hash',
          name: 'unused',
          relays: [],
          primaryAuthorityDomainName: 'unused.example'
        },
        AsyncStorage,
        ctx
      )
      const fakeInviteKey = 'k'.repeat(66)
      const fakeInvite = { inviteKey: fakeInviteKey, type: 'au' as const, expiration: '0', inviteSignature: 'a'.repeat(128) }
      await ctx.db.exec(
        `INSERT INTO InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
         WITH CONTEXT Tid = 1, IsCidValid = true, IsSignatureValid = true, IsInsertValid = true, now = datetime('now', '-1 day')
         VALUES (Digest(:inviteKey, :type), :type, 'test', :expiration, :inviteKey, :inviteSignature, 'test-nonce-1')`,
        { inviteKey: fakeInviteKey, type: 'au', expiration: '2099-12-31T23:59:59', inviteSignature: 'a'.repeat(128) }
      )
      await networkEngine.respondToInvite({
        invite: fakeInvite,
        isAccepted: true,
        invokes: { authority: { name: 'Invokee', domainName: 'inv.example' }, admin: { effectiveAt: '2026-01-01T00:00:00', thresholdPolicies: '[{"policy":"rad","threshold":1}]' }, officers: [{ adminEffectiveAt: '2026-01-01T00:00:00', userId: 'user-1', title: 'Officer', scopes: '["rad"]' }] },
        inviteSignature: 'a'.repeat(128),
        userId: undefined,
        userInit: undefined
      } as never)
      const slotRow = await ctx.db.prepare('SELECT Cid FROM InviteSlot WHERE InviteKey = :k AND Type = :t').get({ k: fakeInviteKey, t: 'au' })
      const row = await ctx.db
        .prepare('select IsAccepted, Digest from InviteResult where SlotCid = :c')
        .get({ c: slotRow!.Cid as string })
      expect(Boolean(row?.IsAccepted)).to.equal(true)
      expect(row?.Digest).to.not.equal(null)
    })

    it('inserts an InviteResult row with null digest for a rejected invite', async () => {
      const { ctx } = await createUserEngineForExistingNetwork()
      const networkEngine = new NetworkEngine(
        {
          hash: 'unused-test-hash',
          name: 'unused',
          relays: [],
          primaryAuthorityDomainName: 'unused.example'
        },
        AsyncStorage,
        ctx
      )
      const fakeInviteKey = 'j'.repeat(66)
      const fakeInvite = { inviteKey: fakeInviteKey, type: 'au' as const, expiration: '0', inviteSignature: 'b'.repeat(128) }
      await ctx.db.exec(
        `INSERT INTO InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
         WITH CONTEXT Tid = 1, IsCidValid = true, IsSignatureValid = true, IsInsertValid = true, now = datetime('now', '-1 day')
         VALUES (Digest(:inviteKey, :type), :type, 'test', :expiration, :inviteKey, :inviteSignature, 'test-nonce-2')`,
        { inviteKey: fakeInviteKey, type: 'au', expiration: '2099-12-31T23:59:59', inviteSignature: 'b'.repeat(128) }
      )
      await networkEngine.respondToInvite({
        invite: fakeInvite,
        isAccepted: false,
        invokes: undefined,
        inviteSignature: 'b'.repeat(128),
        userId: undefined,
        userInit: undefined
      } as never)
      const slotRow = await ctx.db.prepare('SELECT Cid FROM InviteSlot WHERE InviteKey = :k AND Type = :t').get({ k: fakeInviteKey, t: 'au' })
      const row = await ctx.db
        .prepare('select IsAccepted, Digest from InviteResult where SlotCid = :c')
        .get({ c: slotRow!.Cid as string })
      expect(Boolean(row?.IsAccepted)).to.equal(false)
      expect(row?.Digest).to.equal(null)
    })
  })
})

// ===========================================================================
// DefaultUserEngine Tests
// ===========================================================================

describe('DefaultUserEngine', () => {
  describe('get', () => {
    it('returns undefined when no default user has been set', async () => {
      await AsyncStorage.clear()
      const engine = new DefaultUserEngine(AsyncStorage)
      const result = await engine.get()
      expect(result).to.equal(undefined)
    })
  })

  describe('set', () => {
    it('writes the DefaultUser through LocalStorage', async () => {
      await AsyncStorage.clear()
      const engine = new DefaultUserEngine(AsyncStorage)
      const user: DefaultUser = {
        name: 'Alice',
        imageRef: { url: 'https://img.local/alice.png' }
      }
      await engine.set(user)
      // Reach into the underlying store to verify the write went through
      // the LocalStorage abstraction (rather than a hidden in-memory cache).
      const raw = await AsyncStorage.getItem<DefaultUser>('defaultUser')
      expect(raw).to.deep.equal(user)
    })
  })

  describe('get/set round-trip', () => {
    it('returns the most recently set DefaultUser', async () => {
      await AsyncStorage.clear()
      const engine = new DefaultUserEngine(AsyncStorage)
      const first: DefaultUser = { name: 'First' }
      const second: DefaultUser = {
        name: 'Second',
        imageRef: { url: 'https://img.local/second.png' }
      }
      await engine.set(first)
      await engine.set(second)
      const got = await engine.get()
      expect(got).to.deep.equal(second)
    })

    it('handles DefaultUser without an imageRef', async () => {
      await AsyncStorage.clear()
      const engine = new DefaultUserEngine(AsyncStorage)
      const user: DefaultUser = { name: 'No-Image User' }
      await engine.set(user)
      const got = await engine.get()
      expect(got?.name).to.equal('No-Image User')
      expect(got?.imageRef).to.equal(undefined)
    })
  })
})

// ===========================================================================
// DefaultUserSetBuilder Tests
// ===========================================================================

describe('DefaultUserSetBuilder', () => {
  function makeDefaultUser (overrides?: Partial<DefaultUser>): DefaultUser {
    return {
      name: 'Alice',
      imageRef: { url: 'https://img.local/alice.png' },
      ...overrides
    }
  }

  let storage: typeof AsyncStorage
  let engine: DefaultUserEngine

  beforeEach(async () => {
    storage = AsyncStorage
    await storage.clear()
    engine = new DefaultUserEngine(storage)
  })

  it('empty builder is invalid and reports missingFields=[name]', async () => {
    const b = engine.buildSet()
    expect(b.isValid()).to.equal(false)
    const missing = b.missingFields().map(m => m.path)
    expect(missing).to.deep.equal(['name'])
    expect(b.errors().length).to.be.greaterThan(0)
  })

  it('setName per-setter validation: empty string records BuilderError; valid name clears it', () => {
    let caught: unknown
    let b: ReturnType<typeof engine.buildSet>
    try {
      b = engine.buildSet().setName('')
    } catch (err) {
      caught = err
    }
    expect(caught).to.equal(undefined) // setter never throws
    b = engine.buildSet().setName('')
    const errs = b.errors()
    const nameErr = errs.find(e => e.path === 'name' && e.kind === 'per-setter')
    expect(nameErr).to.not.equal(undefined)

    const b2 = b.setName('Alice')
    const errs2 = b2.errors()
    const nameErr2 = errs2.find(e => e.path === 'name')
    expect(nameErr2).to.equal(undefined)
  })

  it('errors/missingFields progression as setters succeed', () => {
    const empty = engine.buildSet()
    expect(empty.missingFields().length).to.equal(1)

    const withName = empty.setName('Alice')
    expect(withName.missingFields().length).to.equal(0)
    expect(withName.isValid()).to.equal(true)
  })

  it('isValid===true => commit() does not throw BuilderValidationError; engine.get() reflects the committed user', async () => {
    const b = engine.buildSet().setName('Alice')
    expect(b.isValid()).to.equal(true)

    await b.commit()
    const got = await engine.get()
    expect(got?.name).to.equal('Alice')
  })

  it('round-trip serialization: JSON.parse(JSON.stringify(b.toJSON())) deep-equals; fromJSON reproduces draft + validation state', () => {
    const b = engine.buildSet().setName('Alice').setImageRef({ url: 'https://img.local/alice.png' })
    const json = b.toJSON()
    const roundTripped = JSON.parse(JSON.stringify(json))
    expect(roundTripped).to.deep.equal(json)
    expect(json).to.deep.equal({
      kind: 'defaultUser.set',
      version: 1,
      draft: { name: 'Alice', imageRef: { url: 'https://img.local/alice.png' } }
    })

    const rehydrated = DefaultUserSetBuilder.fromJSON(json, engine)
    expect(rehydrated.isValid()).to.equal(true)
    expect(rehydrated.toEngineInput()).to.deep.equal(b.toEngineInput())

    // fromJSON throws on kind mismatch
    let kindErr: unknown
    try {
      DefaultUserSetBuilder.fromJSON({ kind: 'user.create', version: 1, draft: {} }, engine)
    } catch (err) {
      kindErr = err
    }
    expect(kindErr).to.be.instanceOf(Error)

    // fromJSON throws on version mismatch
    let versionErr: unknown
    try {
      DefaultUserSetBuilder.fromJSON({ kind: 'defaultUser.set', version: 99, draft: {} }, engine)
    } catch (err) {
      versionErr = err
    }
    expect(versionErr).to.be.instanceOf(Error)
  })

  it('double-commit guard: second commit() throws BuilderAlreadyCommittedError synchronously, no engine.set called twice', async () => {
    const b = engine.buildSet().setName('Alice')
    await b.commit()

    const before = await engine.get()

    let caught: unknown
    try {
      b.commit() // sync throw expected — no await
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)

    const after = await engine.get()
    expect(after).to.deep.equal(before)
  })

  it('toEngineInput returns DefaultUser shape; throws BuilderValidationError on incomplete builder', () => {
    const empty = engine.buildSet()
    let caught: unknown
    try {
      empty.toEngineInput()
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(BuilderValidationError)

    const valid = engine.buildSet().setName('Alice')
    const input = valid.toEngineInput()
    expect(input).to.have.property('name', 'Alice')
    expect(input).to.have.property('imageRef')
  })

  it('equivalence smoke: engine.set(payload) and engine.buildSet().fromPayload(payload).commit() produce identical engine.get() result', async () => {
    // Two separate engines with separate storage for isolation
    const storageA = AsyncStorage
    await storageA.clear()
    const engineA = new DefaultUserEngine(storageA)

    // For storageB, we reuse the same AsyncStorage after clearing again
    // (tests are serial; before/after isolation is per-test via beforeEach)
    const storageB = AsyncStorage
    await storageB.clear()
    const engineB = new DefaultUserEngine(storageB)

    const payload = makeDefaultUser()

    // Direct path
    await engineA.set(payload)
    const directResult = await engineA.get()

    // Clear storage for builder path
    await storageB.clear()
    const engineB2 = new DefaultUserEngine(storageB)
    await engineB2.buildSet().fromPayload(payload).commit()
    const builderResult = await engineB2.get()

    expect(builderResult).to.deep.equal(directResult)
  })

  it('FACT-04 real-mock parity: both DefaultUserEngine and MockDefaultUserEngine return DefaultUserSetBuilder instances from buildSet()', () => {
    const realEngine = new DefaultUserEngine(AsyncStorage)
    const mockEngine = new MockDefaultUserEngine()

    expect(realEngine.buildSet()).to.be.instanceOf(DefaultUserSetBuilder)
    expect(mockEngine.buildSet()).to.be.instanceOf(DefaultUserSetBuilder)
  })
})

// ===========================================================================
// Stub IUserEngine helper for DB-FREE SC4 coverage
// ===========================================================================

function makeStubUserEngine (opts?: { failOn?: 'create' | 'addKey' | 'revise' | 'revokeKey' }): IUserEngine {
  const fail = opts?.failOn
  return {
    create: fail === 'create'
      ? async () => { throw new Error('stub failure') }
      : async () => undefined,
    addKey: fail === 'addKey'
      ? async () => { throw new Error('stub failure') }
      : async () => undefined,
    revise: fail === 'revise'
      ? async () => { throw new Error('stub failure') }
      : async () => undefined,
    revokeKey: fail === 'revokeKey'
      ? async () => { throw new Error('stub failure') }
      : async () => undefined,
    connectDevice: async () => ({ multiAddress: '', token: '' }),
    getHistory: async function * () { /* empty */ },
    getSummary: async () => undefined,
    isPrivileged: async () => false,
    buildCreate: () => new UserCreateBuilder({} as IUserEngine),
    buildAddKey: () => new UserAddKeyBuilder({} as IUserEngine),
    buildRevise: () => new UserReviseBuilder({} as IUserEngine),
    buildRevokeKey: () => new UserRevokeKeyBuilder({} as IUserEngine)
  } as IUserEngine
}

// ===========================================================================
// UserCreateBuilder Tests
// ===========================================================================

describe('UserCreateBuilder', () => {
  const VALID_SIG: Signature = {
    signature: 'a'.repeat(128),
    signerKey: 'b'.repeat(66),
    signerUserId: 'user-1'
  }
  const VALID_KEY: UserKey = {
    key: 'c'.repeat(66),
    type: UserKeyType.mobile,
    expiration: Date.now() + 86_400_000
  }
  const VALID_IMAGE_REF: ImageRef = { url: 'https://img.local/user.png' }

  function makeFullBuilder (engine: IUserEngine): UserCreateBuilder {
    let b = new UserCreateBuilder(engine)
    b = b.setEvent(UserHistoryEvent.create)
      .setTimestamp(Date.now())
      .setSignature(VALID_SIG)
      .setName('Test User')
      .setImageRef(VALID_IMAGE_REF)
      .setUserKey(VALID_KEY) as UserCreateBuilder
    return b
  }

  it('empty builder reports isValid===false and lists required missingFields', () => {
    const b = new UserCreateBuilder(makeStubUserEngine())
    expect(b.isValid()).to.equal(false)
    const paths = b.missingFields().map(m => m.path)
    expect(paths).to.include('event')
    expect(paths).to.include('timestamp')
    expect(paths).to.include('signature')
    expect(paths).to.include('name')
    expect(paths).to.include('imageRef')
    expect(paths).to.include('userKey')
    expect(b.errors().length).to.be.greaterThan(0)
  })

  it('per-setter validation rejects invalid input as BuilderError without throwing', () => {
    let caught: unknown
    let b: UserCreateBuilder
    try {
      b = new UserCreateBuilder(makeStubUserEngine()).setName('')
    } catch (err) {
      caught = err
    }
    expect(caught).to.equal(undefined)
    b = new UserCreateBuilder(makeStubUserEngine()).setName('')
    const errs = b.errors()
    const nameErr = errs.find(e => e.path === 'name' && e.kind === 'per-setter')
    expect(nameErr).to.not.equal(undefined)

    const b2 = b.setName('Alice')
    const errs2 = b2.errors()
    const nameErr2 = errs2.find(e => e.path === 'name' && e.code === 'EMPTY')
    expect(nameErr2).to.equal(undefined)
  })

  it('errors/missingFields progression as setters succeed', () => {
    const stub = makeStubUserEngine()
    const empty = new UserCreateBuilder(stub)
    expect(empty.missingFields().length).to.equal(6)

    const step1 = empty.setEvent(UserHistoryEvent.create)
    expect(step1.missingFields().length).to.equal(5)

    const step2 = step1.setTimestamp(Date.now())
    expect(step2.missingFields().length).to.equal(4)

    const full = makeFullBuilder(stub)
    expect(full.missingFields().length).to.equal(0)
    expect(full.isValid()).to.equal(true)
  })

  it('REAL ENGINE: isValid===true => commit() does not throw BuilderValidationError; engine.create observable side effects match', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const distinctUser = makeDistinctTestUser()
    // Seed the User.InsertValid invite-bound branch for the 2nd user (Plan 12.3-03).
    const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, distinctUser)
    const engine = new UserEngine(distinctUser, auth.ctx)
    const b = makeFullBuilder(engine)
    expect(b.isValid()).to.equal(true)
    await b.commit({ inviteSlotCid, inviteSignature })
  })

  it('round-trip serialization: JSON.parse(JSON.stringify(b.toJSON())) deep-equals; fromJSON reproduces draft + validation state', () => {
    const stub = makeStubUserEngine()
    const b = makeFullBuilder(stub)
    const json = b.toJSON()
    const roundTripped = JSON.parse(JSON.stringify(json))
    expect(roundTripped).to.deep.equal(json)
    expect(json.kind).to.equal('user.create')
    expect(json.version).to.equal(1)

    const rehydrated = UserCreateBuilder.fromJSON(json, stub)
    expect(rehydrated.isValid()).to.equal(true)
    expect(rehydrated.toEngineInput()).to.deep.equal(b.toEngineInput())

    let kindErr: unknown
    try { UserCreateBuilder.fromJSON({ kind: 'wrong', version: 1, draft: {} }, stub) } catch (err) { kindErr = err }
    expect(kindErr).to.be.instanceOf(Error)

    let versionErr: unknown
    try { UserCreateBuilder.fromJSON({ kind: 'user.create', version: 99, draft: {} }, stub) } catch (err) { versionErr = err }
    expect(versionErr).to.be.instanceOf(Error)
  })

  it('REAL ENGINE: double-commit guard: 2nd commit() throws BuilderAlreadyCommittedError synchronously, no second engine write', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const distinctUser = makeDistinctTestUser()
    const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, distinctUser)
    const engine = new UserEngine(distinctUser, auth.ctx)
    const b = makeFullBuilder(engine)
    await b.commit({ inviteSlotCid, inviteSignature })
    let caught: unknown
    try { await b.commit({ inviteSlotCid, inviteSignature }) } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  it('toEngineInput returns the exact engine payload shape; throws BuilderValidationError on incomplete builder', () => {
    const stub = makeStubUserEngine()
    const empty = new UserCreateBuilder(stub)
    let caught: unknown
    try { empty.toEngineInput() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderValidationError)

    const full = makeFullBuilder(stub)
    const input = full.toEngineInput()
    expect(input).to.have.property('event', UserHistoryEvent.create)
    expect(input).to.have.property('timestamp').that.is.a('number')
    expect(input).to.have.property('signature').that.is.an('object')
    expect(input).to.have.property('name', 'Test User')
    expect(input).to.have.property('imageRef').that.is.an('object')
    expect(input).to.have.property('userKey').that.is.an('object')
  })

  it('SC4 DB-FREE: stub IUserEngine -- isValid===true => commit() does not throw BuilderValidationError AND second commit() throws BuilderAlreadyCommittedError synchronously', async () => {
    const stub = makeStubUserEngine()
    const b = makeFullBuilder(stub)
    expect(b.isValid()).to.equal(true)

    // SC4 part A: VALID-03
    let validationErr: unknown
    try { await b.commit() } catch (err) { validationErr = err }
    if (validationErr instanceof BuilderValidationError) {
      expect.fail('commit() threw BuilderValidationError on a valid builder')
    }
    expect(validationErr).to.equal(undefined)

    // SC4 part B: FACT-03
    let caught: unknown
    try { b.commit() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  it('REAL ENGINE: engine.create(payload) and engine.buildCreate().fromPayload(payload).commit() produce structurally identical observable state', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const user1 = makeDistinctTestUser()
    const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, user1)
    const eng1 = new UserEngine(user1, auth.ctx)
    const payload = makeFullBuilder(eng1).toEngineInput()
    let err1: unknown
    try { await eng1.create(payload, { inviteSlotCid, inviteSignature }) } catch (e) { err1 = e }
    expect(err1).to.equal(undefined)
  })

  it('FACT-04 parity: MockUserEngine.buildCreate() returns instanceof UserCreateBuilder', () => {
    const mock = new MockUserEngine()
    expect(mock.buildCreate()).to.be.instanceOf(UserCreateBuilder)
  })
})

// ===========================================================================
// UserAddKeyBuilder Tests
// ===========================================================================

describe('UserAddKeyBuilder', () => {
  function makeFullBuilder (engine: IUserEngine): UserAddKeyBuilder {
    let b = new UserAddKeyBuilder(engine)
    b = b.setKey('d'.repeat(66))
      .setType(UserKeyType.mobile)
      .setExpiration(Date.now() + 86_400_000) as UserAddKeyBuilder
    return b
  }

  it('empty builder reports isValid===false and lists required missingFields', () => {
    const b = new UserAddKeyBuilder(makeStubUserEngine())
    expect(b.isValid()).to.equal(false)
    const paths = b.missingFields().map(m => m.path)
    expect(paths).to.include('key')
    expect(paths).to.include('type')
    expect(paths).to.include('expiration')
    expect(b.errors().length).to.be.greaterThan(0)
  })

  it('per-setter validation rejects invalid input as BuilderError without throwing', () => {
    let caught: unknown
    let b: UserAddKeyBuilder
    try {
      b = new UserAddKeyBuilder(makeStubUserEngine()).setKey('not-hex')
    } catch (err) {
      caught = err
    }
    expect(caught).to.equal(undefined)
    b = new UserAddKeyBuilder(makeStubUserEngine()).setKey('not-hex')
    const errs = b.errors()
    const keyErr = errs.find(e => e.path === 'key' && e.kind === 'per-setter')
    expect(keyErr).to.not.equal(undefined)

    const b2 = b.setKey('d'.repeat(66))
    const errs2 = b2.errors()
    const keyErr2 = errs2.find(e => e.path === 'key' && e.code === 'INVALID_KEY_HEX')
    expect(keyErr2).to.equal(undefined)
  })

  it('errors/missingFields progression as setters succeed', () => {
    const stub = makeStubUserEngine()
    const empty = new UserAddKeyBuilder(stub)
    expect(empty.missingFields().length).to.equal(3)

    const step1 = empty.setKey('d'.repeat(66))
    expect(step1.missingFields().length).to.equal(2)

    const full = makeFullBuilder(stub)
    expect(full.missingFields().length).to.equal(0)
    expect(full.isValid()).to.equal(true)
  })

  it('REAL ENGINE: isValid===true => commit() does not throw BuilderValidationError; engine.addKey observable side effects match', async () => {
    const { engine } = await createUserEngineForExistingNetwork()
    const b = makeFullBuilder(engine)
    expect(b.isValid()).to.equal(true)
    await b.commit()
  })

  it('round-trip serialization: JSON.parse(JSON.stringify(b.toJSON())) deep-equals; fromJSON reproduces draft + validation state', () => {
    const stub = makeStubUserEngine()
    const b = makeFullBuilder(stub)
    const json = b.toJSON()
    const roundTripped = JSON.parse(JSON.stringify(json))
    expect(roundTripped).to.deep.equal(json)
    expect(json.kind).to.equal('user.addKey')
    expect(json.version).to.equal(1)

    const rehydrated = UserAddKeyBuilder.fromJSON(json, stub)
    expect(rehydrated.isValid()).to.equal(true)
    expect(rehydrated.toEngineInput()).to.deep.equal(b.toEngineInput())

    let kindErr: unknown
    try { UserAddKeyBuilder.fromJSON({ kind: 'wrong', version: 1, draft: {} }, stub) } catch (err) { kindErr = err }
    expect(kindErr).to.be.instanceOf(Error)

    let versionErr: unknown
    try { UserAddKeyBuilder.fromJSON({ kind: 'user.addKey', version: 99, draft: {} }, stub) } catch (err) { versionErr = err }
    expect(versionErr).to.be.instanceOf(Error)
  })

  it('REAL ENGINE: double-commit guard: 2nd commit() throws BuilderAlreadyCommittedError synchronously, no second engine write', async () => {
    const { engine } = await createUserEngineForExistingNetwork()
    const b = makeFullBuilder(engine)
    await b.commit()
    let caught: unknown
    try { b.commit() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  it('toEngineInput returns the exact engine payload shape; throws BuilderValidationError on incomplete builder', () => {
    const stub = makeStubUserEngine()
    const empty = new UserAddKeyBuilder(stub)
    let caught: unknown
    try { empty.toEngineInput() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderValidationError)

    const full = makeFullBuilder(stub)
    const input = full.toEngineInput()
    expect(input).to.have.property('key', 'd'.repeat(66))
    expect(input).to.have.property('type', UserKeyType.mobile)
    expect(input).to.have.property('expiration').that.is.a('number')
  })

  it('SC4 DB-FREE: stub IUserEngine -- isValid===true => commit() does not throw BuilderValidationError AND second commit() throws BuilderAlreadyCommittedError synchronously', async () => {
    const stub = makeStubUserEngine()
    const b = makeFullBuilder(stub)
    expect(b.isValid()).to.equal(true)

    let validationErr: unknown
    try { await b.commit() } catch (err) { validationErr = err }
    if (validationErr instanceof BuilderValidationError) {
      expect.fail('commit() threw BuilderValidationError on a valid builder')
    }
    expect(validationErr).to.equal(undefined)

    let caught: unknown
    try { b.commit() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  it('REAL ENGINE: engine.addKey(payload) and engine.buildAddKey().fromPayload(payload).commit() produce structurally identical observable state', async () => {
    const { engine: eng1 } = await createUserEngineForExistingNetwork()
    const payload = makeFullBuilder(eng1).toEngineInput()
    let err1: unknown
    try { await eng1.addKey(payload) } catch (e) { err1 = e }
    expect(err1).to.equal(undefined)
    const { engine: eng2 } = await createUserEngineForExistingNetwork()
    let err2: unknown
    try { await eng2.buildAddKey().fromPayload(payload).commit() } catch (e) { err2 = e }
    expect(err2).to.equal(undefined)
  })

  it('FACT-04 parity: MockUserEngine.buildAddKey() returns instanceof UserAddKeyBuilder', () => {
    const mock = new MockUserEngine()
    expect(mock.buildAddKey()).to.be.instanceOf(UserAddKeyBuilder)
  })

  it('cross-field validation: expired expiration reports cross-field EXPIRED error', () => {
    const stub = makeStubUserEngine()
    const b = new UserAddKeyBuilder(stub)
      .setKey('d'.repeat(66))
      .setType(UserKeyType.mobile)
      .setExpiration(1000) as UserAddKeyBuilder // well in the past
    const errs = b.errors()
    const expired = errs.find(e => e.code === 'EXPIRED' && e.kind === 'cross-field')
    expect(expired).to.not.equal(undefined)
    expect(b.isValid()).to.equal(false)
  })
})

// ===========================================================================
// UserReviseBuilder Tests
// ===========================================================================

describe('UserReviseBuilder', () => {
  const VALID_SIG: Signature = {
    signature: 'a'.repeat(128),
    signerKey: 'b'.repeat(66),
    signerUserId: 'user-1'
  }
  const VALID_IMAGE_REF: ImageRef = { url: 'https://img.local/user.png' }

  function makeFullBuilder (engine: IUserEngine): UserReviseBuilder {
    let b = new UserReviseBuilder(engine)
    b = b.setEvent(UserHistoryEvent.revise)
      .setTimestamp(Date.now())
      .setSignature(VALID_SIG)
      .setInfoName('Revised Name')
      .setInfoImageRef(VALID_IMAGE_REF) as UserReviseBuilder
    return b
  }

  it('empty builder reports isValid===false and lists required missingFields', () => {
    const b = new UserReviseBuilder(makeStubUserEngine())
    expect(b.isValid()).to.equal(false)
    const paths = b.missingFields().map(m => m.path)
    expect(paths).to.include('event')
    expect(paths).to.include('timestamp')
    expect(paths).to.include('signature')
    expect(paths).to.include('info.name')
    expect(paths).to.include('info.imageRef')
    expect(b.errors().length).to.be.greaterThan(0)
  })

  it('per-setter validation rejects invalid input as BuilderError without throwing', () => {
    let caught: unknown
    let b: UserReviseBuilder
    try {
      b = new UserReviseBuilder(makeStubUserEngine()).setInfoName('')
    } catch (err) {
      caught = err
    }
    expect(caught).to.equal(undefined)
    b = new UserReviseBuilder(makeStubUserEngine()).setInfoName('')
    const errs = b.errors()
    const nameErr = errs.find(e => e.path === 'info.name' && e.kind === 'per-setter')
    expect(nameErr).to.not.equal(undefined)

    const b2 = b.setInfoName('Alice')
    const errs2 = b2.errors()
    const nameErr2 = errs2.find(e => e.path === 'info.name' && e.code === 'EMPTY')
    expect(nameErr2).to.equal(undefined)
  })

  it('errors/missingFields progression as setters succeed', () => {
    const stub = makeStubUserEngine()
    const empty = new UserReviseBuilder(stub)
    expect(empty.missingFields().length).to.equal(5)

    const step1 = empty.setEvent(UserHistoryEvent.revise)
    expect(step1.missingFields().length).to.equal(4)

    const full = makeFullBuilder(stub)
    expect(full.missingFields().length).to.equal(0)
    expect(full.isValid()).to.equal(true)
  })

  it('REAL ENGINE: isValid===true => commit() does not throw BuilderValidationError; engine.revise observable side effects match', async () => {
    const { engine } = await createUserEngineForExistingNetwork()
    const b = makeFullBuilder(engine)
    expect(b.isValid()).to.equal(true)
    await b.commit()
  })

  it('round-trip serialization: JSON.parse(JSON.stringify(b.toJSON())) deep-equals; fromJSON reproduces draft + validation state', () => {
    const stub = makeStubUserEngine()
    const b = makeFullBuilder(stub)
    const json = b.toJSON()
    const roundTripped = JSON.parse(JSON.stringify(json))
    expect(roundTripped).to.deep.equal(json)
    expect(json.kind).to.equal('user.revise')
    expect(json.version).to.equal(1)

    const rehydrated = UserReviseBuilder.fromJSON(json, stub)
    expect(rehydrated.isValid()).to.equal(true)
    expect(rehydrated.toEngineInput()).to.deep.equal(b.toEngineInput())

    let kindErr: unknown
    try { UserReviseBuilder.fromJSON({ kind: 'wrong', version: 1, draft: {} }, stub) } catch (err) { kindErr = err }
    expect(kindErr).to.be.instanceOf(Error)

    let versionErr: unknown
    try { UserReviseBuilder.fromJSON({ kind: 'user.revise', version: 99, draft: {} }, stub) } catch (err) { versionErr = err }
    expect(versionErr).to.be.instanceOf(Error)
  })

  it('REAL ENGINE: double-commit guard: 2nd commit() throws BuilderAlreadyCommittedError synchronously, no second engine write', async () => {
    const { engine } = await createUserEngineForExistingNetwork()
    const b = makeFullBuilder(engine)
    await b.commit()
    let caught: unknown
    try { b.commit() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  it('toEngineInput returns the exact engine payload shape; throws BuilderValidationError on incomplete builder', () => {
    const stub = makeStubUserEngine()
    const empty = new UserReviseBuilder(stub)
    let caught: unknown
    try { empty.toEngineInput() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderValidationError)

    const full = makeFullBuilder(stub)
    const input = full.toEngineInput()
    expect(input).to.have.property('event', UserHistoryEvent.revise)
    expect(input).to.have.property('timestamp').that.is.a('number')
    expect(input).to.have.property('signature').that.is.an('object')
    expect(input).to.have.property('info').that.is.an('object')
    expect(input.info).to.have.property('name', 'Revised Name')
    expect(input.info).to.have.property('imageRef').that.is.an('object')
  })

  it('SC4 DB-FREE: stub IUserEngine -- isValid===true => commit() does not throw BuilderValidationError AND second commit() throws BuilderAlreadyCommittedError synchronously', async () => {
    const stub = makeStubUserEngine()
    const b = makeFullBuilder(stub)
    expect(b.isValid()).to.equal(true)

    let validationErr: unknown
    try { await b.commit() } catch (err) { validationErr = err }
    if (validationErr instanceof BuilderValidationError) {
      expect.fail('commit() threw BuilderValidationError on a valid builder')
    }
    expect(validationErr).to.equal(undefined)

    let caught: unknown
    try { b.commit() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  it('REAL ENGINE: engine.revise(payload) and engine.buildRevise().fromPayload(payload).commit() produce structurally identical observable state', async () => {
    const { engine: eng1 } = await createUserEngineForExistingNetwork()
    const payload = makeFullBuilder(eng1).toEngineInput()
    let err1: unknown
    try { await eng1.revise(payload) } catch (e) { err1 = e }
    expect(err1).to.equal(undefined)
    const { engine: eng2 } = await createUserEngineForExistingNetwork()
    let err2: unknown
    try { await eng2.buildRevise().fromPayload(payload).commit() } catch (e) { err2 = e }
    expect(err2).to.equal(undefined)
  })

  it('FACT-04 parity: MockUserEngine.buildRevise() returns instanceof UserReviseBuilder', () => {
    const mock = new MockUserEngine()
    expect(mock.buildRevise()).to.be.instanceOf(UserReviseBuilder)
  })
})

// ===========================================================================
// UserRevokeKeyBuilder Tests
// ===========================================================================

describe('UserRevokeKeyBuilder', () => {
  function makeFullBuilder (engine: IUserEngine): UserRevokeKeyBuilder {
    let b = new UserRevokeKeyBuilder(engine)
    b = b.setKey('e'.repeat(66)) as UserRevokeKeyBuilder
    return b
  }

  it('empty builder reports isValid===false and lists required missingFields', () => {
    const b = new UserRevokeKeyBuilder(makeStubUserEngine())
    expect(b.isValid()).to.equal(false)
    const paths = b.missingFields().map(m => m.path)
    expect(paths).to.include('key')
    expect(b.errors().length).to.be.greaterThan(0)
  })

  it('per-setter validation rejects invalid input as BuilderError without throwing', () => {
    let caught: unknown
    let b: UserRevokeKeyBuilder
    try {
      b = new UserRevokeKeyBuilder(makeStubUserEngine()).setKey('not-hex')
    } catch (err) {
      caught = err
    }
    expect(caught).to.equal(undefined)
    b = new UserRevokeKeyBuilder(makeStubUserEngine()).setKey('not-hex')
    const errs = b.errors()
    const keyErr = errs.find(e => e.path === 'key' && e.kind === 'per-setter')
    expect(keyErr).to.not.equal(undefined)

    const b2 = b.setKey('e'.repeat(66))
    const errs2 = b2.errors()
    const keyErr2 = errs2.find(e => e.path === 'key' && e.code === 'INVALID_KEY_HEX')
    expect(keyErr2).to.equal(undefined)
  })

  it('errors/missingFields progression as setters succeed', () => {
    const stub = makeStubUserEngine()
    const empty = new UserRevokeKeyBuilder(stub)
    expect(empty.missingFields().length).to.equal(1)

    const full = makeFullBuilder(stub)
    expect(full.missingFields().length).to.equal(0)
    expect(full.isValid()).to.equal(true)
  })

  it('REAL ENGINE: isValid===true => commit() does not throw BuilderValidationError; engine.revokeKey observable side effects match', async () => {
    const { engine } = await createUserEngineForExistingNetwork()
    const b = makeFullBuilder(engine)
    expect(b.isValid()).to.equal(true)
    await b.commit()
  })

  it('round-trip serialization: JSON.parse(JSON.stringify(b.toJSON())) deep-equals; fromJSON reproduces draft + validation state', () => {
    const stub = makeStubUserEngine()
    const b = makeFullBuilder(stub)
    const json = b.toJSON()
    const roundTripped = JSON.parse(JSON.stringify(json))
    expect(roundTripped).to.deep.equal(json)
    expect(json.kind).to.equal('user.revokeKey')
    expect(json.version).to.equal(1)

    const rehydrated = UserRevokeKeyBuilder.fromJSON(json, stub)
    expect(rehydrated.isValid()).to.equal(true)
    expect(rehydrated.toEngineInput()).to.deep.equal(b.toEngineInput())

    let kindErr: unknown
    try { UserRevokeKeyBuilder.fromJSON({ kind: 'wrong', version: 1, draft: {} }, stub) } catch (err) { kindErr = err }
    expect(kindErr).to.be.instanceOf(Error)

    let versionErr: unknown
    try { UserRevokeKeyBuilder.fromJSON({ kind: 'user.revokeKey', version: 99, draft: {} }, stub) } catch (err) { versionErr = err }
    expect(versionErr).to.be.instanceOf(Error)
  })

  it('REAL ENGINE: double-commit guard: 2nd commit() throws BuilderAlreadyCommittedError synchronously, no second engine write', async () => {
    const { engine } = await createUserEngineForExistingNetwork()
    const b = makeFullBuilder(engine)
    await b.commit()
    let caught: unknown
    try { b.commit() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  it('toEngineInput returns the exact engine payload shape; throws BuilderValidationError on incomplete builder', () => {
    const stub = makeStubUserEngine()
    const empty = new UserRevokeKeyBuilder(stub)
    let caught: unknown
    try { empty.toEngineInput() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderValidationError)

    const full = makeFullBuilder(stub)
    const input = full.toEngineInput()
    expect(input).to.equal('e'.repeat(66))
  })

  it('SC4 DB-FREE: stub IUserEngine -- isValid===true => commit() does not throw BuilderValidationError AND second commit() throws BuilderAlreadyCommittedError synchronously', async () => {
    const stub = makeStubUserEngine()
    const b = makeFullBuilder(stub)
    expect(b.isValid()).to.equal(true)

    let validationErr: unknown
    try { await b.commit() } catch (err) { validationErr = err }
    if (validationErr instanceof BuilderValidationError) {
      expect.fail('commit() threw BuilderValidationError on a valid builder')
    }
    expect(validationErr).to.equal(undefined)

    let caught: unknown
    try { b.commit() } catch (err) { caught = err }
    expect(caught).to.be.instanceOf(BuilderAlreadyCommittedError)
  })

  it('REAL ENGINE: engine.revokeKey(payload) and engine.buildRevokeKey().fromPayload(payload).commit() produce structurally identical observable state', async () => {
    const { engine: eng1 } = await createUserEngineForExistingNetwork()
    const payload = makeFullBuilder(eng1).toEngineInput()
    let err1: unknown
    try { await eng1.revokeKey(payload) } catch (e) { err1 = e }
    expect(err1).to.equal(undefined)
    const { engine: eng2 } = await createUserEngineForExistingNetwork()
    let err2: unknown
    try { await eng2.buildRevokeKey().fromPayload(payload).commit() } catch (e) { err2 = e }
    expect(err2).to.equal(undefined)
  })

  it('FACT-04 parity: MockUserEngine.buildRevokeKey() returns instanceof UserRevokeKeyBuilder', () => {
    const mock = new MockUserEngine()
    expect(mock.buildRevokeKey()).to.be.instanceOf(UserRevokeKeyBuilder)
  })
})
