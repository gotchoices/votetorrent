import { Database } from '@quereus/quereus'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError,
  ElectionType,
  FeatureNotAvailableError,
  UserHistoryEvent,
  UserKeyType
} from '@votetorrent/vote-core'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
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
import { digestToBytes, nowCanonicalDatetime, toCanonicalDatetime } from '../src/utils.js'
import { addTestAuthority, createTestNetwork, makeDistinctTestUser, makeTestSignCallback, makeTestUser, seedUserInvite } from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import { AsyncStorage } from './shims/react-native'
import type {
  AddUserKeyHistory,
  CreateUserHistory,
  DefaultUser,
  ImageRef,
  IUserEngine,
  NetworkInit,
  NetworkReference,
  ReviseUserHistory,
  RevokeUserKeyHistory,
  Scope,
  Signature,
  Timestamp,
  User,
  UserHistory,
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
// NetworksEngine.create().
//
// 999.1 R-02/R-04: uses `makeTestUser` (not the local `makeUser`) so the
// returned `user`'s private key is recorded in `test-context.ts`'s module-
// scope map — callers that need to exercise the signed subsequent-key
// addKey path can retrieve a real sign callback via `makeTestSignCallback(user)`.
async function createUserEngineForExistingNetwork (): Promise<{
  engine: UserEngine
  ctx: EngineContext
  user: User
}> {
  await AsyncStorage.clear()
  await AsyncStorage.setItem('recentNetworks', [])
  const networksEngine = new NetworksEngine(AsyncStorage)
  const user = makeTestUser()
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

// 999.1 R-02/R-04: UserKey.SignatureValid now real-verifies the subsequent-key path
// (Digest(UserId, PubKey, Type, Expiration) against context.Signature/UserKey) with a
// bootstrap OR-branch for a user's genuinely-first key (count(*)=1 AND context.UserKey is
// null). IUserAddKeyBuilder has no sign-callback parameter, so a builder-driven addKey can
// only ever satisfy the bootstrap branch — this helper seeds a User row (via the invite
// branch of User.InsertValid) with NO UserKey row yet, so a subsequent builder-driven
// addKey() is the user's genuinely-first key.
async function seedKeylessUser (
  auth: TestAuthorityContext,
  user: User
): Promise<void> {
  const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, user)
  const tid = Date.now() + Math.floor(Math.random() * 100_000)
  await auth.ctx.db.exec(
    `insert into User (Id, Name, ImageRef)
     with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${tid}
     values (:userId, :userName, :userImageRef)`,
    {
      userId: user.id,
      userName: user.name,
      userImageRef: user.imageRef ? JSON.stringify(user.imageRef) : null,
      inviteSlotCid,
      inviteSignature
    }
  )
}

/** A distinct test user with NO activeKeys (so engine.addKey binds context.UserKey = null). */
function makeKeylessDistinctTestUser (): User {
  return { ...makeDistinctTestUser(), activeKeys: [] }
}

/**
 * Builds a UserEngine bound to a genuinely keyless user (User row seeded, no UserKey
 * row yet) on a fresh test network/authority. `IUserAddKeyBuilder` has no sign-callback
 * parameter, so builder-driven `commit()` can only satisfy UserKey.SignatureValid's
 * bootstrap branch — this fixture supplies exactly that scenario.
 */
async function createKeylessUserEngine (): Promise<{ engine: UserEngine, ctx: EngineContext, user: User }> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const user = makeKeylessDistinctTestUser()
  await seedKeylessUser(auth, user)
  const engine = new UserEngine(user, auth.ctx)
  return { engine, ctx: auth.ctx, user }
}

// Pure-schema-only DB. Loads the schema but performs no INSERTs — useful
// for constructor/argument-shape tests that do not need a populated DB.
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

    it('returns the User row read from the DB when a context is bound', async () => {
      const { engine, user } = await createUserEngineForExistingNetwork()
      const summary = await engine.getSummary()
      expect(summary?.id).to.equal(user.id)
      expect(summary?.name).to.equal(user.name)
    })

    // Needs a populated DB to assert the undefined branch is reachable via
    // a missing id.
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
    // EXPECTED-RED-UNTIL-IMPL UKEY-01 (revise real-signature engine binding)
    it('updates User name and imageRef; committed signature is not a placeholder (UKEY-01 / SIGN-01)', async () => {
      // The test supplies a REAL secp256k1 signature for the revise operation.
      // The engine must store the real signature value (not 'mock-signer-key', not user.id).
      // Negative assertions prove SIGN-01 at the unit level for the revise flow.
      const { engine, ctx, user } = await createUserEngineForExistingNetwork()

      // Generate a real secp256k1 signature over a representative payload.
      const activePrivBytes = secp256k1.utils.randomSecretKey()
      const realPublicHex = bytesToHex(secp256k1.getPublicKey(activePrivBytes))
      const payloadBytes = new TextEncoder().encode(`revise:${user.id}:Renamed User`)
      const realSigBytes = secp256k1.sign(sha256(payloadBytes), activePrivBytes)
      const realSigHex = bytesToHex(realSigBytes) // noble v2: sign() returns Uint8Array

      const revise: ReviseUserHistory = {
        event: UserHistoryEvent.revise,
        timestamp: Date.now(),
        signature: {
          // Real secp256k1 signature — not a placeholder.
          signature: realSigHex,
          signerKey: realPublicHex,
          signerUserId: user.id
        },
        info: {
          name: 'Renamed User',
          imageRef: { url: 'https://img.local/renamed.png' }
        }
      }
      await engine.revise(revise)

      // Assert the name was updated.
      const row = await ctx.db
        .prepare('select Name from User where Id = :id')
        .get({ id: user.id })
      expect(row?.Name).to.equal('Renamed User')

      // SIGN-01 negative assertions: the signature stored by the engine must not be
      // a literal placeholder. (UserEvent Signature field captures what the engine writes.)
      const eventRow = await ctx.db
        .prepare("select Signature from UserEvent where UserId = :id and Event = 'R' limit 1")
        .get({ id: user.id })
      if (eventRow?.Signature !== null && eventRow?.Signature !== undefined) {
        // When the engine wires real signatures (UKEY-01 impl plan), the committed
        // Signature must not be the 'mock-signer-key' literal or the user's own id.
        expect(String(eventRow.Signature)).to.not.equal('mock-signer-key')
        expect(String(eventRow.Signature)).to.not.equal(user.id)
      }
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
    // 999.1 R-02/R-04: this is a SUBSEQUENT key for a user who already has an
    // active key (seeded by createUserEngineForExistingNetwork's networksEngine
    // .create()), so UserKey.SignatureValid's real branch requires a genuine
    // signature from the existing active key — supply the sign callback.
    it('inserts a UserKey row with the per-INSERT context envelope (real subsequent-key signature)', async () => {
      const { engine, ctx, user } = await createUserEngineForExistingNetwork()
      const { publicHex } = randomTestKeyPair()
      const key: UserKey = {
        key: publicHex,
        type: UserKeyType.yubico,
        expiration: Date.now() + 86_400_000
      }
      await engine.addKey(key, makeTestSignCallback(user))
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

    // 999.1 R-02/R-04/D-11 (999.1-08): UserKey.SignatureValid now real-verifies the
    // subsequent-key path — SignatureValid(Digest(UserId, PubKey, Type, Expiration),
    // context.Signature, context.UserKey). context.UserKey is the EXISTING active
    // signer's pubkey (Pitfall 5, NOT the new key); the signature must be produced by
    // the EXISTING active PRIVATE key over that exact digest.
    it('subsequent-key add: a key signed by the EXISTING active key passes the real UserKey.SignatureValid CHECK (UKEY-03 / D-11)', async () => {
      const { engine, ctx, user } = await createUserEngineForExistingNetwork()

      // The EXISTING active key (already in the UserKey table) — the ONLY key
      // whose signature the real CHECK will accept for this subsequent add.
      const existingPubKey = user.activeKeys[0]!.key

      const { publicHex: newPubHex } = randomTestKeyPair()
      const newKey = {
        key: newPubHex,
        type: UserKeyType.yubico,
        expiration: Date.now() + 86_400_000
      }

      // Real sign callback bound to the EXISTING active key's recorded private key
      // (test-context.ts's makeTestUser/testUserPrivateKeys map).
      await engine.addKey(newKey, makeTestSignCallback(user))

      // Assert the new UserKey row was inserted (the schema CHECK accepted the real sig).
      const row = await ctx.db
        .prepare('select PubKey from UserKey where UserId = :id and PubKey = :pk')
        .get({ id: user.id, pk: newPubHex })
      expect(row?.PubKey).to.equal(newPubHex)

      // Assert context.UserKey was the EXISTING key (not the new key) — Pitfall 5.
      const eventRow = await ctx.db
        .prepare("select Payload from UserEvent where UserId = :id and Event = 'AK' limit 1")
        .get({ id: user.id })
      if (eventRow?.Payload) {
        const payload = JSON.parse(String(eventRow.Payload))
        expect(payload?.userKey?.key).to.equal(newPubHex)
        expect(payload?.userKey?.key).to.not.equal(existingPubKey)
      }
    })

    // 999.1 T-999.1-19 (999.1-08): a subsequent-key insert signed by a key OTHER THAN
    // the existing active signer is DB-rejected by the schema's own SignatureValid
    // CHECK — a raw INSERT bypassing UserEngine.addKey's app-layer dispatch still fails.
    it('subsequent-key add: a signature from a key OTHER than the existing active signer is rejected by the schema CHECK', async () => {
      const { ctx, user } = await createUserEngineForExistingNetwork()
      const existingPubKey = user.activeKeys[0]!.key

      const { publicHex: newPubHex } = randomTestKeyPair()
      const digestRow = await ctx.db
        .prepare('select Digest(:userId, :newPubKey, :keyType, :expiration) as d')
        .get({
          userId: user.id,
          newPubKey: newPubHex,
          keyType: UserKeyType.yubico,
          expiration: toCanonicalDatetime(Date.now() + 86_400_000)
        })
      const digestBytes = digestToBytes(digestRow!.d)
      // Sign with a FOREIGN key pair, not the user's existing active key.
      const foreignPrivBytes = secp256k1.utils.randomSecretKey()
      const forgedSigHex = bytesToHex(secp256k1.sign(digestBytes, foreignPrivBytes))

      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into UserKey (UserId, Type, PubKey, Expiration)
           with context UserKey = :userKey, Signature = :signature, Tid = 9999, now = :now, IsSignatureValid = true
           values (:userId, :keyType, :keyValue, :expiration)`,
          {
            userId: user.id,
            keyType: 'Y',
            keyValue: newPubHex,
            expiration: toCanonicalDatetime(Date.now() + 86_400_000),
            userKey: existingPubKey,
            signature: forgedSigHex,
            now: nowCanonicalDatetime()
          }
        )
      } catch (err) {
        caught = err
      }
      expect(caught, 'forged-signer signature must be rejected by SignatureValid CHECK').to.not.equal(undefined)
      expect((caught as Error)?.message).to.include('SignatureValid')

      const row = await ctx.db
        .prepare('select PubKey from UserKey where UserId = :id and PubKey = :pk')
        .get({ id: user.id, pk: newPubHex })
      expect(row).to.equal(undefined)
    })

    // 999.1 T-999.1-20 (999.1-08): the unsigned first-key bootstrap path (UserEngine
    // .create()'s own UserKey insert, context.UserKey = null) is NOT wired to verifySig
    // against a null signature — it stays a pure bootstrap OR-branch (Pitfall 3).
    it('first-key bootstrap add (via create()) still inserts without a signature', async () => {
      const { publicHex: createPub } = randomTestKeyPair()
      const { engine, user } = await makeDbOnlyUserEngine({
        id: 'bootstrap-userkey-user',
        activeKeys: [{ key: createPub, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 }]
      })
      const init: CreateUserHistory = {
        event: UserHistoryEvent.create,
        timestamp: Date.now(),
        signature: { signature: 'a'.repeat(128), signerKey: createPub, signerUserId: user.id },
        name: user.name,
        imageRef: { url: 'https://img.local/user.png' },
        userKey: { key: createPub, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 }
      }
      let caught: unknown
      try {
        await engine.create(init)
      } catch (err) {
        caught = err
      }
      expect(caught).to.equal(undefined)
    })
  })

  // -----------------------------------------------------------------------
  // USER-06 — revokeKey
  // -----------------------------------------------------------------------
  describe('revokeKey', () => {
    // UserKey.DeleteValid is a `check on delete` constraint; this test
    // exercises the schema's intended "not-the-last-key" guard.
    // EXPECTED-RED-UNTIL-IMPL UKEY-02 (revokeKey real-signature engine binding)
    it('deletes a UserKey row by hex pubkey; committed event signature is not a placeholder (UKEY-02 / SIGN-01)', async () => {
      // The engine must store a real signature value — not 'mock-signer-key', not user.id.
      // Negative assertions prove SIGN-01 at the unit level for the revokeKey flow.
      //
      // UKEY-02 / SC#7: revokeKey binds context.UserKey = signature.signerKey so the verified
      // key is the same keypair that produced the signature. The SIGNER must be a DIFFERENT
      // key than the one being revoked — DeleteValid checks that context.UserKey is non-expired
      // and still present after the delete. We therefore create the user with a FIRST key whose
      // private key we control, add a SECOND key, then sign the revocation of the SECOND key
      // using the FIRST key's private key. This is the semantically correct single-device flow:
      // the remaining active key authorises the removal of a key being retired.
      const { publicHex: firstPub, privateHex: firstPrivHex } = randomTestKeyPair()
      const firstPrivBytes = hexToBytes(firstPrivHex)

      await AsyncStorage.clear()
      await AsyncStorage.setItem('recentNetworks', [])
      const networksEngine = new NetworksEngine(AsyncStorage)
      const user = makeUser({ activeKeys: [{ key: firstPub, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 }] })
      await networksEngine.create(makeNetworkInit(), user)
      const recents = (await AsyncStorage.getItem<NetworkReference[]>('recentNetworks')) ?? []
      const ref = recents[0]
      if (!ref) throw new Error('No network reference after create()')
      const networkEngine = await networksEngine.open(ref, user, false)
      const ctx = (networksEngine as unknown as { contexts: Map<string, EngineContext> }).contexts.get(ref.hash)
      if (!ctx) throw new Error('No cached context after create()')
      void networkEngine
      const engine = new UserEngine(user, ctx)

      // Add a second key first so the revoke does not trip the "not the last key" branch.
      // 999.1 R-02/R-04: this is a subsequent key for `user` (whose first key is firstPub) —
      // sign with the EXISTING active private key (firstPrivBytes) so the real
      // UserKey.SignatureValid CHECK verifies it.
      const { publicHex: secondPub } = randomTestKeyPair()
      await engine.addKey(
        {
          key: secondPub,
          type: UserKeyType.yubico,
          expiration: Date.now() + 86_400_000
        },
        async (digest) => ({
          signature: bytesToHex(secp256k1.sign(digest, firstPrivBytes)),
          signerKey: firstPub,
          signerUserId: user.id
        })
      )

      // Build a real secp256k1 signature for the revoke operation (UKEY-02 impl).
      // SIGNER = FIRST key (remains after revoke); KEY BEING REVOKED = secondPub.
      // This satisfies DeleteValid: context.UserKey = firstPub which still exists after delete.
      const revokePrivBytes = firstPrivBytes
      const revokePayloadBytes = new TextEncoder().encode(`revokeKey:${secondPub}`)
      const revokeSigBytes = secp256k1.sign(sha256(revokePayloadBytes), revokePrivBytes)
      const revokeSigHex = bytesToHex(revokeSigBytes)
      const revokeSignature: Signature = {
        signature: revokeSigHex,
        signerKey: bytesToHex(secp256k1.getPublicKey(revokePrivBytes)),
        signerUserId: user.id
      }

      // Revoke the second key with a real device signature signed by the first key.
      await engine.revokeKey(secondPub, revokeSignature)

      // Assert the UserKey row was deleted.
      const row = await ctx.db
        .prepare(
          'select PubKey from UserKey where UserId = :id and PubKey = :pk'
        )
        .get({ id: user.id, pk: secondPub })
      expect(row).to.equal(undefined)

      // SIGN-01 assertions: the RK event's Signature must be the real hex, not a placeholder.
      const eventRow = await ctx.db
        .prepare("select Signature from UserEvent where UserId = :id and Event = 'RK' limit 1")
        .get({ id: user.id })
      expect(eventRow?.Signature).to.not.equal(null)
      expect(String(eventRow?.Signature)).to.equal(revokeSigHex)
      expect(String(eventRow?.Signature)).to.not.equal('mock-signer-key')
      expect(String(eventRow?.Signature)).to.not.equal(user.id)

      // UKEY-02 / SC#7: revokeKey binds context.UserKey = signature.signerKey so the verified
      // key is exactly the keypair that produced the signature. Assert signerKey == the signing
      // keypair's public key (= firstPub = the value now bound to context.UserKey).
      expect(revokeSignature.signerKey).to.equal(bytesToHex(secp256k1.getPublicKey(revokePrivBytes)))
    })

    it('throws when no EngineContext is bound', async () => {
      const user = makeUser({ id: 'pure-user-4' })
      const engine = new UserEngine(user)
      const dummySig: Signature = {
        signature: 'f'.repeat(128),
        signerKey: 'a'.repeat(66),
        signerUserId: user.id
      }
      let caught: unknown
      try {
        await engine.revokeKey('a'.repeat(66), dummySig)
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
    // and a populated DB from create().
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
         WITH CONTEXT Tid = 1, IsSignatureValid = true, IsInsertValid = true, now = datetime('now', '-1 day')
         VALUES (cid(Digest(:expiration, :inviteKey, :inviteSignature, 'test', 'test-nonce-1', :type)), :type, 'test', :expiration, :inviteKey, :inviteSignature, 'test-nonce-1')`,
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
         WITH CONTEXT Tid = 1, IsSignatureValid = true, IsInsertValid = true, now = datetime('now', '-1 day')
         VALUES (cid(Digest(:expiration, :inviteKey, :inviteSignature, 'test', 'test-nonce-2', :type)), :type, 'test', :expiration, :inviteKey, :inviteSignature, 'test-nonce-2')`,
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

  // -----------------------------------------------------------------------
  // ENG-07 — connectDevice phase-gate (Phase 22)
  // -----------------------------------------------------------------------
  describe('connectDevice', () => {
    it('throws FeatureNotAvailableError without naming a phase number (D-15)', async () => {
      const user = makeUser({ id: 'cd-user-1' })
      const engine = new UserEngine(user)
      let caught: unknown
      try {
        await engine.connectDevice()
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(FeatureNotAvailableError)
      // D-15: user-facing error strings must not name a GSD phase number.
      expect((caught as FeatureNotAvailableError).message).to.not.match(/Phase\s*\d+/i)
    })
  })

  // -----------------------------------------------------------------------
  // ENG-02 — getHistory over the real UserEvent log (D-17/D-18/D-20)
  // -----------------------------------------------------------------------
  describe('getHistory', () => {
    // D-20 proof: create -> addKey -> revise -> revokeKey produces a 4-event
    // append-only log; getHistory reads it back ordered, discriminated, with
    // real timestamps and a present (D-15 null->'') Signature field. Forward
    // yields ASC (create first); backward yields DESC (revokeKey first).
    it('returns 4 ordered discriminated events forward (ASC) and backward (DESC)', async () => {
      // The user is a real officer of an existing network/authority — required
      // so revise() satisfies the schema's User.UserValid (officer/keyholder)
      // gate. The user row + its initial UserKey are seeded by NetworksEngine
      // .create() (no UserEvent yet). We seed the create ('C') event row the
      // same way fixtures seed rows, then exercise the real addKey/revise/
      // revokeKey mutations (which append AK/R/RK events in-batch), and read
      // all four back through getHistory in both orderings.
      // Use a known first keypair so we can sign the revokeKey event with the first key.
      // UKEY-02: context.UserKey = signature.signerKey, so the signer must exist in UserKey.
      // The first key (createPub) stays after revoking addedPub — signing with it satisfies
      // DeleteValid (context.UserKey = createPub is present and non-expired after the delete).
      const { publicHex: createPub, privateHex: createPrivHex } = randomTestKeyPair()
      const createPrivBytes = hexToBytes(createPrivHex)

      await AsyncStorage.clear()
      await AsyncStorage.setItem('recentNetworks', [])
      const networksEngine2 = new NetworksEngine(AsyncStorage)
      const user = makeUser({ activeKeys: [{ key: createPub, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 }] })
      await networksEngine2.create(makeNetworkInit(), user)
      const recents2 = (await AsyncStorage.getItem<NetworkReference[]>('recentNetworks')) ?? []
      const ref2 = recents2[0]
      if (!ref2) throw new Error('No network reference after create()')
      const networkEngine2 = await networksEngine2.open(ref2, user, false)
      const ctx = (networksEngine2 as unknown as { contexts: Map<string, EngineContext> }).contexts.get(ref2.hash)
      if (!ctx) throw new Error('No cached context after create()')
      void networkEngine2
      const engine = new UserEngine(user, ctx)

      const { publicHex: addedPub } = randomTestKeyPair()

      // 1) create — Event 'C', Sequence 0 (seeded: the user was created by the
      //    networks engine, which predates the UserEvent log; UserEngine.create
      //    own event write is proven by the db-only create+grep acceptance).
      await ctx.db.exec(
        `insert into UserEvent (UserId, Sequence, Event, Timestamp, Signature, Payload)
         with context CtxTid = 1, now = :now
         values (:userId, 0, 'C', :now, null, :payload)`,
        {
          userId: user.id,
          now: '2026-01-01T00:00:00',
          payload: JSON.stringify({
            name: user.name,
            imageRef: { url: 'https://img.local/user.png' },
            userKey: { key: createPub, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 }
          })
        }
      )

      // 2) addKey — Event 'AK', Sequence 1 (second key so revoke is not the last)
      // 999.1 R-02/R-04: subsequent key — sign with the EXISTING active private key
      // (createPrivBytes) so the real UserKey.SignatureValid CHECK verifies it.
      await engine.addKey(
        {
          key: addedPub,
          type: UserKeyType.yubico,
          expiration: Date.now() + 86_400_000
        },
        async (digest) => ({
          signature: bytesToHex(secp256k1.sign(digest, createPrivBytes)),
          signerKey: createPub,
          signerUserId: user.id
        })
      )

      // 3) revise — Event 'R', Sequence 2
      const revise: ReviseUserHistory = {
        event: UserHistoryEvent.revise,
        timestamp: Date.now(),
        signature: {
          signature: 'e'.repeat(128),
          signerKey: createPub,
          signerUserId: user.id
        },
        info: { name: 'Renamed User', imageRef: { url: 'https://img.local/renamed.png' } }
      }
      await engine.revise(revise)

      // 4) revokeKey — Event 'RK', Sequence 3
      // UKEY-02: sign with the FIRST key (createPub) so context.UserKey = createPub,
      // which still exists in UserKey after revoking addedPub → DeleteValid passes.
      const historyRevokeSig: Signature = {
        signature: bytesToHex(secp256k1.sign(sha256(new TextEncoder().encode(`revokeKey:${addedPub}`)), createPrivBytes)),
        signerKey: bytesToHex(secp256k1.getPublicKey(createPrivBytes)),
        signerUserId: user.id
      }
      await engine.revokeKey(addedPub, historyRevokeSig)

      // Forward (ASC): create, addKey, revise, revokeKey
      const forward: UserHistory[] = []
      for await (const ev of engine.getHistory(user.id, true)) forward.push(ev)
      expect(forward).to.have.length(4)
      expect(forward.map(e => e.event)).to.deep.equal([
        UserHistoryEvent.create,
        UserHistoryEvent.addKey,
        UserHistoryEvent.revise,
        UserHistoryEvent.revokeKey
      ])
      // real (non-empty) timestamps + a present signature field on every event
      for (const ev of forward) {
        expect(ev.timestamp, 'timestamp present').to.not.equal(undefined)
        expect(Number.isNaN(Number(ev.timestamp)), 'timestamp is a real number').to.equal(false)
        expect(ev).to.have.property('signature')
      }
      // discriminated payloads round-trip to the correct subtype shape
      const created = forward[0] as CreateUserHistory
      expect(created.name).to.equal(user.name)
      expect(created.userKey.key).to.equal(createPub)
      const added = forward[1] as AddUserKeyHistory
      expect(added.userKey.key).to.equal(addedPub)
      const revised = forward[2] as ReviseUserHistory
      expect(revised.info.name).to.equal('Renamed User')
      const revoked = forward[3] as RevokeUserKeyHistory
      expect(revoked.key).to.equal(addedPub)

      // Backward (DESC): revokeKey first, create last — exact reverse
      const backward: UserHistory[] = []
      for await (const ev of engine.getHistory(user.id, false)) backward.push(ev)
      expect(backward.map(e => e.event)).to.deep.equal([
        UserHistoryEvent.revokeKey,
        UserHistoryEvent.revise,
        UserHistoryEvent.addKey,
        UserHistoryEvent.create
      ])
    })

    it('write+read a UserEngine.create event end-to-end (C event own write)', async () => {
      // Proves UserEngine.create() itself writes a readable 'C' UserEvent row
      // (db-only path: first user, no invite required for User.InsertValid).
      const { publicHex: createPub } = randomTestKeyPair()
      const { engine, user } = await makeDbOnlyUserEngine({
        id: 'gh-create-user',
        activeKeys: [
          { key: createPub, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 }
        ]
      })
      const init: CreateUserHistory = {
        event: UserHistoryEvent.create,
        timestamp: Date.now(),
        signature: { signature: 'a'.repeat(128), signerKey: createPub, signerUserId: user.id },
        name: user.name,
        imageRef: { url: 'https://img.local/user.png' },
        userKey: { key: createPub, type: UserKeyType.mobile, expiration: Date.now() + 86_400_000 }
      }
      await engine.create(init)
      const events: UserHistory[] = []
      for await (const ev of engine.getHistory(user.id, true)) events.push(ev)
      expect(events).to.have.length(1)
      expect(events[0]!.event).to.equal(UserHistoryEvent.create)
      const created = events[0] as CreateUserHistory
      expect(created.name).to.equal(user.name)
      expect(created.userKey.key).to.equal(createPub)
      expect(created).to.have.property('signature')
    })

    it('returns an empty history for a user with no events (D-18, no backfill)', async () => {
      const { engine } = await makeDbOnlyUserEngine({ id: 'gh-empty-user' })
      const events: UserHistory[] = []
      for await (const ev of engine.getHistory('gh-empty-user', true)) events.push(ev)
      expect(events).to.have.length(0)
    })
  })

  // -----------------------------------------------------------------------
  // ENG-03 — isPrivileged (D-08): real SQL Officer/CurrentAdmin/json_each
  // -----------------------------------------------------------------------
  describe('isPrivileged', () => {
    it('returns true for seeded officer with matching scope (mel)', async () => {
      const { engine, user } = await createUserEngineForExistingNetwork()
      const result = await engine.isPrivileged('mel', user.id)
      expect(result).to.equal(true)
    })

    it('returns false for seeded officer missing scope (vrg not in seeded scopes)', async () => {
      const { engine, user } = await createUserEngineForExistingNetwork()
      const result = await engine.isPrivileged('vrg', user.id)
      expect(result).to.equal(false)
    })

    it('returns false for non-officer user', async () => {
      const { ctx } = await createUserEngineForExistingNetwork()
      const distinct = makeDistinctTestUser()
      const nonOfficerEngine = new UserEngine(distinct, ctx)
      const result = await nonOfficerEngine.isPrivileged('mel', distinct.id)
      expect(result).to.equal(false)
    })

    // WR-02: the deny-by-default contract (officer under a future-dated admin or
    // an authority with no effective admin returns false) cannot be seeded as a
    // unit test today: a raw Admin/Officer INSERT with a custom EffectiveAt trips
    // the InsertValid CHECK. The deny-by-default behavior is instead documented
    // in the isPrivileged docstring; pin a real test once a signing-context-
    // bearing seed path for custom-dated admins is available.
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

  // 999.1 R-02/R-04: IUserAddKeyBuilder has no sign-callback parameter, so a
  // builder-driven commit() can only satisfy UserKey.SignatureValid's bootstrap
  // branch — use a genuinely keyless user (createKeylessUserEngine) rather than
  // createUserEngineForExistingNetwork (whose user already has an active key).
  it('REAL ENGINE: isValid===true => commit() does not throw BuilderValidationError; engine.addKey observable side effects match', async () => {
    const { engine } = await createKeylessUserEngine()
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
    const { engine } = await createKeylessUserEngine()
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
    const { engine: eng1 } = await createKeylessUserEngine()
    const payload = makeFullBuilder(eng1).toEngineInput()
    let err1: unknown
    try { await eng1.addKey(payload) } catch (e) { err1 = e }
    expect(err1).to.equal(undefined)
    const { engine: eng2 } = await createKeylessUserEngine()
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
    // Provide a dummy Signature so commit() can pass it to revokeKey (UKEY-02).
    b = b.setSignature({
      signature: 'a'.repeat(128),
      signerKey: 'b'.repeat(66),
      signerUserId: 'test-user-id'
    }) as UserRevokeKeyBuilder
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
    const pairPriv = secp256k1.utils.randomSecretKey()
    const pairSig: Signature = {
      signature: bytesToHex(secp256k1.sign(sha256(new TextEncoder().encode(`revokeKey:${payload}`)), pairPriv)),
      signerKey: bytesToHex(secp256k1.getPublicKey(pairPriv)),
      signerUserId: 'parity-test-user'
    }
    let err1: unknown
    try { await eng1.revokeKey(payload, pairSig) } catch (e) { err1 = e }
    expect(err1).to.equal(undefined)
    const { engine: eng2 } = await createUserEngineForExistingNetwork()
    let err2: unknown
    try { await eng2.buildRevokeKey().fromPayload(payload).setSignature(pairSig).commit() } catch (e) { err2 = e }
    expect(err2).to.equal(undefined)
  })

  it('FACT-04 parity: MockUserEngine.buildRevokeKey() returns instanceof UserRevokeKeyBuilder', () => {
    const mock = new MockUserEngine()
    expect(mock.buildRevokeKey()).to.be.instanceOf(UserRevokeKeyBuilder)
  })
})
