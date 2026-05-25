import { Database } from '@quereus/quereus'
import {
  ElectionType,
  UserHistoryEvent,
  UserKeyType
} from '@votetorrent/vote-core'
import { expect } from 'chai'
import { prepareDb } from '../src/database/initialize'
import { NetworkEngine } from '../src/network/network-engine'
import { NetworksEngine } from '../src/networks/networks-engine'
import { DefaultUserEngine } from '../src/user/default-user-engine'
import { UserEngine } from '../src/user/user-engine'
import type { EngineContext } from '../src/types.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { AsyncStorage } from './shims/react-native'
import type {
  CreateUserHistory,
  DefaultUser,
  NetworkInit,
  NetworkReference,
  ReviseUserHistory,
  Scope,
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
      const slotCid = 'slot-accept-' + crypto.randomUUID()
      await networkEngine.respondToInvite({
        invite: { digest: slotCid } as never,
        isAccepted: true,
        invokes: { authority: { name: 'Invokee', domainName: 'inv.example' } },
        inviteSignature: 'a'.repeat(128),
        userId: undefined,
        userInit: undefined
      } as never)
      const row = await ctx.db
        .prepare('select IsAccepted, Digest from InviteResult where SlotCid = :c')
        .get({ c: slotCid })
      expect(Boolean(row?.IsAccepted)).to.equal(true)
      expect(row?.Digest).to.not.equal(null)
    })

    // BLOCKED on quereus#23 — same chain.
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
      const slotCid = 'slot-reject-' + crypto.randomUUID()
      await networkEngine.respondToInvite({
        invite: { digest: slotCid } as never,
        isAccepted: false,
        invokes: undefined,
        inviteSignature: 'b'.repeat(128),
        userId: undefined,
        userInit: undefined
      } as never)
      const row = await ctx.db
        .prepare('select IsAccepted, Digest from InviteResult where SlotCid = :c')
        .get({ c: slotCid })
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
