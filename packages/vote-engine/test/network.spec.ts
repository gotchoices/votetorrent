import { Database } from '@quereus/quereus'
import { ElectionType, UserKeyType } from '@votetorrent/vote-core'
import { expect } from 'chai'
import { prepareDb } from '../src/database/initialize'
import { NetworkEngine } from '../src/network/network-engine'
import { NetworksEngine } from '../src/networks/networks-engine'
import type { EngineContext } from '../src/types.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { AsyncStorage } from './shims/react-native'
import type {
  Authority,
  INetworkEngine,
  NetworkInit,
  NetworkReference,
  Scope,
  User
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

function makeNetworkInit (overrides?: Partial<NetworkInit>): NetworkInit {
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
    },
    ...overrides
  }
}

async function createNetworkEngine (): Promise<{
  engine: INetworkEngine
  ref: NetworkReference
}> {
  await AsyncStorage.clear()
  await AsyncStorage.setItem('recentNetworks', [])
  const networksEngine = new NetworksEngine(AsyncStorage)
  const user = makeUser()
  const networkInit = makeNetworkInit()
  const engine = await networksEngine.create(networkInit, user)
  const recents = (await AsyncStorage.getItem<NetworkReference[]>('recentNetworks')) ?? []
  const ref = recents[0]
  if (!ref) throw new Error('No network reference found after create')
  return { engine, ref }
}

// Construct a NetworkEngine bound to a schema-only DB (no INSERTs run, so
// quereus#23 is not in play). Used for guard-path tests that only need a
// queryable schema and a NetworkReference shell.
async function makeDbOnlyNetworkEngine (): Promise<{
  engine: NetworkEngine
  ctx: EngineContext
  ref: NetworkReference
  user: User
}> {
  const db = new Database()
  await prepareDb(db)
  const user = makeUser()
  const ctx: EngineContext = { db, user }
  const ref: NetworkReference = {
    hash: 'h'.repeat(16),
    name: 'Pure Test Network',
    relays: ['/dns4/relay.example.com/tcp/443/wss'],
    primaryAuthorityDomainName: 'pure.example.com'
  }
  const engine = new NetworkEngine(ref, AsyncStorage, ctx)
  return { engine, ctx, ref, user }
}

// ===========================================================================
// NetworkEngine Tests
// ===========================================================================

describe('NetworkEngine', () => {
  // -----------------------------------------------------------------------
  // 1. Network Details & Summary
  // -----------------------------------------------------------------------
  describe('getDetails', () => {
    it('throws Network not found when the hash is not present in the DB', async () => {
      // Pure read-side guard: schema-only DB has no Network row. The
      // implementation catches the missing row and rethrows
      // 'Network not found'. No INSERT — quereus#23 is not exercised.
      const { engine } = await makeDbOnlyNetworkEngine()
      let caught: unknown
      try {
        await engine.getDetails()
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('Network not found')
    })

    // BLOCKED on https://github.com/gotchoices/quereus/issues/23 —
    // createNetworkEngine() depends on NetworksEngine.create() which
    // trips CantDelete on INSERT today.
    it.skip('should return network details with correct id, hash, name, and relays', async () => {
      const { engine, ref } = await createNetworkEngine()
      const details = await engine.getDetails()
      expect(details.network.hash).to.equal(ref.hash)
      expect(details.network.name).to.equal('Test Network')
      expect(details.network.relays).to.deep.equal(ref.relays)
    })

    // BLOCKED on quereus#23
    it.skip('should include primaryAuthorityId referencing the created authority', async () => {
      const { engine } = await createNetworkEngine()
      const details = await engine.getDetails()
      expect(details.network.primaryAuthorityId).to.be.a('string').with.length.greaterThan(0)
    })

    // BLOCKED on quereus#23
    it.skip('should return correct network policies (electionType, TSAs, numberRequiredTSAs)', async () => {
      const { engine } = await createNetworkEngine()
      const details = await engine.getDetails()
      expect(details.network.policies.electionType).to.equal(ElectionType.adhoc)
      expect(details.network.policies.numberRequiredTSAs).to.equal(1)
    })

    // BLOCKED on quereus#23
    it.skip('should return undefined proposed revision when none has been proposed', async () => {
      const { engine } = await createNetworkEngine()
      const details = await engine.getDetails()
      expect(details.proposed).to.equal(undefined)
    })
  })

  describe('getNetworkSummary', () => {
    it('throws Network not found when the hash is not present in the DB', async () => {
      const { engine } = await makeDbOnlyNetworkEngine()
      let caught: unknown
      try {
        await engine.getNetworkSummary()
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('Network not found')
    })

    // BLOCKED on quereus#23
    it.skip('should return a summary with hash, name, id, and primaryAuthorityDomainName', async () => {
      const { engine, ref } = await createNetworkEngine()
      const summary = await engine.getNetworkSummary()
      expect(summary.hash).to.equal(ref.hash)
      expect(summary.name).to.equal('Test Network')
      expect(summary.primaryAuthorityDomainName).to.equal('authority.example.com')
    })

    // BLOCKED on quereus#23
    it.skip('should return imageUrl from the primary authority imageRef', async () => {
      const { engine } = await createNetworkEngine()
      const summary = await engine.getNetworkSummary()
      // primaryAuthority.imageUrl is not seeded in the default init.
      expect(summary.imageUrl).to.equal(undefined)
    })

    // BLOCKED on quereus#23
    it.skip('should throw when the primary authority for the network is missing', async () => {
      // Phase 6 will need to manually delete the Authority row after a
      // successful create() to exercise this branch. Bug-blocked until
      // #23 ships (UPDATE/DELETE on Network/Authority also trips today).
    })
  })

  // -----------------------------------------------------------------------
  // 2. Network Schema Constraints (from votetorrent.qsql)
  // -----------------------------------------------------------------------
  // All assertions in this describe require a populated DB seeded via
  // NetworksEngine.create() (so a Network row exists to attempt a
  // mutation against). All are bug-blocked on quereus#23.
  describe('schema constraints - Network table', () => {
    it.skip('should reject deletion of a Network (CantDelete constraint) — BLOCKED on quereus#23')

    it.skip('should reject mutation of Network.Id on update (IdImmutable constraint) — BLOCKED on quereus#23')

    it.skip('should reject mutation of Network.Hash on update (HashImmutable constraint) — BLOCKED on quereus#23')

    it.skip('should reject mutation of Network.PrimaryAuthorityId on update (PrimaryAuthorityIdImmutable constraint) — BLOCKED on quereus#23')

    it.skip('should reject insert when PrimaryAuthorityId does not reference an existing Authority — BLOCKED on quereus#23')

    it.skip('should reject insert/update when ElectionType is not a valid code (o or a) — BLOCKED on quereus#23')

    it.skip('should reject insert/update when NumberRequiredTSAs is negative — BLOCKED on quereus#23')

    it.skip('should reject insert/update when NumberRequiredTSAs is not an integer — BLOCKED on quereus#23')

    it.skip('should enforce that SigningNonce is null on insert (NoSigningNonceOnInsert) — BLOCKED on quereus#23')

    it.skip('should reject update without a valid AdminSignature with scope rn from primary authority (UpdateNetworkValid) — BLOCKED on quereus#23')
  })

  // -----------------------------------------------------------------------
  // 3. Authority Creation from within a Network
  // -----------------------------------------------------------------------
  describe('createAuthority', () => {
    // BLOCKED on quereus#23 — createAuthority INSERTs into Authority/Admin/Officer.
    it.skip('should create an authority with a generated UUID id')

    it.skip('should insert Authority, Admin, and Officer rows in one transaction')

    it('should fail when officer init is missing (no officers provided)', async () => {
      // Pure-guard path: createAuthority validates officer.init before
      // touching the DB. Empty officers array triggers the throw.
      const { engine } = await makeDbOnlyNetworkEngine()
      let caught: unknown
      try {
        await engine.createAuthority(
          { name: 'No-Officer Authority', domainName: 'no.example' },
          {
            officers: [],
            effectiveAt: Date.now(),
            thresholdPolicies: []
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('Officer init is required')
    })

    it.skip('should fail when officer scopes contain invalid scope codes — BLOCKED on quereus#23')

    it.skip('should reject creating a second authority without a valid invite (InsertValid constraint) — BLOCKED on quereus#23')

    it.skip('should set Authority.DomainName to the provided value or null — BLOCKED on quereus#23')

    it.skip('should serialize imageRef as JSON in the Authority row — BLOCKED on quereus#23')
  })

  // -----------------------------------------------------------------------
  // 4. Authority Schema Constraints (from votetorrent.qsql)
  // -----------------------------------------------------------------------
  describe('schema constraints - Authority table', () => {
    it.skip('should allow the very first authority without an invite or signing nonce — BLOCKED on quereus#23')

    it.skip('should reject deletion of an Authority (CantDelete constraint) — BLOCKED on quereus#23')

    it.skip('should reject mutation of Authority.Id on update (IdImmutable constraint) — BLOCKED on quereus#23')

    it.skip('should require an Admin row to exist when inserting an Authority (AdminRequired) — BLOCKED on quereus#23')

    it.skip('should require a valid invite for subsequent authority inserts — BLOCKED on quereus#23')

    it.skip('should validate update using AdminSignature with scope uai (UpdateValid) — BLOCKED on quereus#23')
  })

  // -----------------------------------------------------------------------
  // 5. Network Revision Proposals
  // -----------------------------------------------------------------------
  describe('proposeRevision', () => {
    it.skip('should insert a ProposedNetwork row with the proposed name, relays, and policies — BLOCKED on quereus#23')

    it.skip('should serialize imageRef as JSON or null — BLOCKED on quereus#23')

    it.skip('should serialize relays as a JSON array — BLOCKED on quereus#23')

    it.skip('should serialize timestampAuthorities as a JSON array — BLOCKED on quereus#23')

    it.skip('should reject proposed revision with invalid ElectionType (ElectionTypeValid constraint) — BLOCKED on quereus#23')

    it.skip('should reject proposed revision with negative NumberRequiredTSAs — BLOCKED on quereus#23')

    it.skip('should only allow officers with rn scope from the primary authority (UserValid constraint) — BLOCKED on quereus#23')

    it.skip('should require a valid user signature over the proposed digest — BLOCKED on quereus#23')
  })

  // -----------------------------------------------------------------------
  // 6. Network Revision Signing (AdminSigning / AdminSignature flow)
  // -----------------------------------------------------------------------
  describe('network revision signing flow', () => {
    it.skip('should create an AdminSigning session with scope rn and a valid digest — BLOCKED on quereus#23')

    it.skip('should reject AdminSigning with an invalid scope code — BLOCKED on quereus#23')

    it.skip('should validate the instigator signature on AdminSigning (SignatureValid) — BLOCKED on quereus#23')

    it.skip('should accept OfficerSignature when the officer has rn scope and the digest matches — BLOCKED on quereus#23')

    it.skip('should reject OfficerSignature when the signature does not match the AdminSigning digest — BLOCKED on quereus#23')

    it.skip('should create AdminSignature only when the threshold of OfficerSignatures is met — BLOCKED on quereus#23')

    it.skip('should reject AdminSignature when insufficient OfficerSignatures exist — BLOCKED on quereus#23')

    it.skip('should allow network update only after AdminSignature exists with matching digest — BLOCKED on quereus#23')
  })

  // -----------------------------------------------------------------------
  // 7. Pinned Authorities (local storage) — pure LocalStorage tests
  // -----------------------------------------------------------------------
  describe('pinAuthority / unpinAuthority', () => {
    it('should start with an empty list of pinned authorities', async () => {
      await AsyncStorage.clear()
      const { engine } = await makeDbOnlyNetworkEngine()
      const pinned = await engine.getPinnedAuthorities()
      expect(pinned).to.deep.equal([])
    })

    it('should add an authority to pinned list via pinAuthority', async () => {
      await AsyncStorage.clear()
      const { engine } = await makeDbOnlyNetworkEngine()
      const auth: Authority = {
        id: 'aid-1',
        name: 'AuthorityOne',
        domainName: 'one.example.com'
      }
      await engine.pinAuthority(auth)
      const pinned = await engine.getPinnedAuthorities()
      expect(pinned).to.have.length(1)
      expect(pinned[0]?.id).to.equal('aid-1')
    })

    it('should deduplicate when pinning the same authority twice', async () => {
      await AsyncStorage.clear()
      const { engine } = await makeDbOnlyNetworkEngine()
      const auth: Authority = {
        id: 'aid-dup',
        name: 'Dup',
        domainName: 'dup.example.com'
      }
      await engine.pinAuthority(auth)
      await engine.pinAuthority(auth)
      const pinned = await engine.getPinnedAuthorities()
      expect(pinned).to.have.length(1)
    })

    it('should remove an authority from pinned list via unpinAuthority', async () => {
      await AsyncStorage.clear()
      const { engine } = await makeDbOnlyNetworkEngine()
      const auth: Authority = {
        id: 'aid-rm',
        name: 'Removable',
        domainName: 'rm.example.com'
      }
      await engine.pinAuthority(auth)
      await engine.unpinAuthority(auth.id)
      const pinned = await engine.getPinnedAuthorities()
      expect(pinned).to.deep.equal([])
    })

    it('should be a no-op when unpinning an authority that is not pinned', async () => {
      await AsyncStorage.clear()
      const { engine } = await makeDbOnlyNetworkEngine()
      const auth: Authority = {
        id: 'aid-real',
        name: 'Real',
        domainName: 'real.example.com'
      }
      await engine.pinAuthority(auth)
      await engine.unpinAuthority('aid-ghost')
      const pinned = await engine.getPinnedAuthorities()
      expect(pinned).to.have.length(1)
      expect(pinned[0]?.id).to.equal('aid-real')
    })

    it('should persist pinned authorities across engine instances via localStorage', async () => {
      await AsyncStorage.clear()
      const first = await makeDbOnlyNetworkEngine()
      const auth: Authority = {
        id: 'aid-persist',
        name: 'Persistent',
        domainName: 'p.example.com'
      }
      await first.engine.pinAuthority(auth)
      const second = await makeDbOnlyNetworkEngine()
      const pinned = await second.engine.getPinnedAuthorities()
      expect(pinned).to.have.length(1)
      expect(pinned[0]?.id).to.equal('aid-persist')
    })
  })

  // -----------------------------------------------------------------------
  // 8. Open Authority
  // -----------------------------------------------------------------------
  describe('openAuthority', () => {
    it('should use the provided Authority object when supplied (no DB lookup)', async () => {
      // openAuthority's two-arg form short-circuits the DB SELECT.
      // No INSERT or row read — runs against schema-only DB.
      const { engine } = await makeDbOnlyNetworkEngine()
      const auth: Authority = {
        id: 'aid-pass-through',
        name: 'PassThrough',
        domainName: 'pt.example.com'
      }
      const authorityEngine = await engine.openAuthority(auth.id, auth)
      expect(authorityEngine).to.not.equal(undefined)
    })

    // BLOCKED on quereus#23 — NetworkEngine.openAuthority uses colon-prefix
    // bind keys (`:id`) which fail to resolve under Quereus 3.x parameter
    // convention (see 05-SUMMARY.md deviation §1). The not-found path
    // therefore can't be exercised without modifying engine source, which
    // is out of scope for Phase 6. When colon-prefix sites are swept post-#23,
    // unskip and assert 'Authority not found'.
    it.skip('should throw Authority not found when the authorityId does not exist in the database', async () => {
      const { engine } = await makeDbOnlyNetworkEngine()
      let caught: unknown
      try {
        await engine.openAuthority('never-existed-authority')
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('Authority not found')
    })

    // BLOCKED on quereus#23 — happy-path query needs a seeded Authority row.
    it.skip('should return an AuthorityEngine when given a valid authorityId', async () => {
      const { engine } = await createNetworkEngine()
      const details = await engine.getDetails()
      const authorityEngine = await engine.openAuthority(details.network.primaryAuthorityId)
      expect(authorityEngine).to.not.equal(undefined)
    })

    // BLOCKED on quereus#23 — needs a seeded Authority row to query.
    it.skip('should query the database for the authority when no object is provided', async () => {
      const { engine } = await createNetworkEngine()
      const details = await engine.getDetails()
      const authorityEngine = await engine.openAuthority(details.network.primaryAuthorityId)
      expect(authorityEngine).to.not.equal(undefined)
    })
  })

  // -----------------------------------------------------------------------
  // 9. User Retrieval
  // -----------------------------------------------------------------------
  describe('getUser', () => {
    // BLOCKED on quereus#23 — NetworkEngine.getUser uses colon-prefix
    // bind keys (`:id`) which fail to resolve under Quereus 3.x. The
    // not-found path can't be exercised without engine-source changes
    // (out of Phase 6 scope; documented in 05-SUMMARY.md deviation §1).
    it.skip('throws User not found when userId does not exist', async () => {
      const { engine } = await makeDbOnlyNetworkEngine()
      let caught: unknown
      try {
        await engine.getUser('never-existed-user')
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('User not found')
    })

    // BLOCKED on quereus#23
    it.skip('should return a UserEngine for a valid userId')

    // BLOCKED on quereus#23
    it.skip('should include only non-expired active keys in the returned user')
  })

  describe('getCurrentUser', () => {
    it('returns undefined when no user is bound to the engine context', async () => {
      // ctx.user is undefined → getCurrentUser returns undefined without
      // touching the DB.
      const db = new Database()
      await prepareDb(db)
      const ref: NetworkReference = {
        hash: 'h'.repeat(16),
        name: 'NoUser',
        relays: [],
        primaryAuthorityDomainName: 'n.example'
      }
      const ctx: EngineContext = { db, user: undefined }
      const engine = new NetworkEngine(ref, AsyncStorage, ctx)
      const current = await engine.getCurrentUser()
      expect(current).to.equal(undefined)
    })

    // BLOCKED on quereus#23
    it.skip('should return the current user engine from the engine context')
  })

  // -----------------------------------------------------------------------
  // 10. Election Stubs (ensure not-implemented errors)
  // -----------------------------------------------------------------------
  describe('election methods (not yet implemented)', () => {
    it('should throw "Not implemented" from createElection', async () => {
      const { engine } = await makeDbOnlyNetworkEngine()
      let caught: unknown
      try {
        await engine.createElection({} as never)
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('Not implemented')
    })

    it('should throw "Not implemented" from openElection', async () => {
      const { engine } = await makeDbOnlyNetworkEngine()
      let caught: unknown
      try {
        await engine.openElection('any-id')
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('Not implemented')
    })
  })

  // -----------------------------------------------------------------------
  // 11. Invite Response — USER-07 (shipped in Phase 4)
  // -----------------------------------------------------------------------
  describe('respondToInvite', () => {
    // BLOCKED on quereus#23 — needs a seeded InviteSlot + AdminSignature
    // row, which require NetworksEngine.create() / saveInviteWithSigning,
    // both of which trip the same #23 chain.
    it.skip('inserts an InviteResult row for an accepted invite')

    it.skip('inserts an InviteResult row with null digest for a rejected invite — BLOCKED on quereus#23')
  })

  // -----------------------------------------------------------------------
  // 12. Authorities By Name (cursor-based) — Not implemented stubs
  // -----------------------------------------------------------------------
  describe('getAuthoritiesByName / nextAuthoritiesByName', () => {
    it('should throw "Not implemented" from getAuthoritiesByName', async () => {
      const { engine } = await makeDbOnlyNetworkEngine()
      let caught: unknown
      try {
        await engine.getAuthoritiesByName(undefined)
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('Not implemented')
    })

    it('should throw "Not implemented" from nextAuthoritiesByName', async () => {
      const { engine } = await makeDbOnlyNetworkEngine()
      let caught: unknown
      try {
        await engine.nextAuthoritiesByName({ items: [] } as never, true)
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('Not implemented')
    })
  })
})

// ===========================================================================
// NetworksEngine - Additional Constraint & Validation Tests
// ===========================================================================

describe('NetworksEngine - creation constraints', () => {
  // -----------------------------------------------------------------------
  // 13. Network Creation Validation
  // -----------------------------------------------------------------------
  describe('create - input validation', () => {
    it('should fail when no officers are provided in admin init', async () => {
      // Pure-guard: NetworksEngine.create throws before any DB write when
      // officer init is missing. quereus#23 not exercised.
      await AsyncStorage.clear()
      await AsyncStorage.setItem('recentNetworks', [])
      const engine = new NetworksEngine(AsyncStorage)
      const user = makeUser()
      const init = makeNetworkInit({
        admin: {
          officers: [],
          effectiveAt: Date.now(),
          thresholdPolicies: []
        }
      })
      let caught: unknown
      try {
        await engine.create(init, user)
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('Officer init is required')
    })

    it('should fail when user has no active keys', async () => {
      await AsyncStorage.clear()
      await AsyncStorage.setItem('recentNetworks', [])
      const engine = new NetworksEngine(AsyncStorage)
      const user = makeUser({ activeKeys: [] })
      let caught: unknown
      try {
        await engine.create(makeNetworkInit(), user)
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('User key is required')
    })

    // The user-key-expired guard is enforced at the schema level (UserKey
    // ExpirationFuture CHECK) rather than in the engine; it can't run
    // until the schema can accept the INSERT, so it's bug-blocked.
    it.skip('should fail when user key is expired — BLOCKED on quereus#23')

    it.skip('should create Network, Authority, Admin, Officer, User, and UserKey in one transaction — BLOCKED on quereus#23')

    it.skip('should generate a unique network ID (UUID) on each create — BLOCKED on quereus#23')

    it.skip('should compute Hash as H16 of the network ID — BLOCKED on quereus#23')

    it.skip('should set PrimaryAuthorityId to the generated authority UUID — BLOCKED on quereus#23')
  })

  // -----------------------------------------------------------------------
  // 14. Network Creation - Schema Constraint Coverage
  // -----------------------------------------------------------------------
  describe('create - schema constraints', () => {
    it.skip('should reject when ElectionType is not a valid code — BLOCKED on quereus#23')

    it.skip('should reject when NumberRequiredTSAs is negative — BLOCKED on quereus#23')

    it.skip('should reject when admin EffectiveAt is not a valid ISO datetime ending in Z — BLOCKED on quereus#23')

    it.skip('should reject when officer scopes contain unknown scope codes — BLOCKED on quereus#23')

    it.skip('should allow the first authority+admin+officer to bootstrap without signing context — BLOCKED on quereus#23')
  })

  // -----------------------------------------------------------------------
  // 15. Recent Networks Management — pure LocalStorage tests
  // -----------------------------------------------------------------------
  describe('recent networks', () => {
    // BLOCKED on quereus#23 — `append after create()` half exercises
    // the create() pipeline.
    it.skip('should append the created network to recent networks')

    it('should return empty array from getRecentNetworks when none exist', async () => {
      await AsyncStorage.clear()
      const engine = new NetworksEngine(AsyncStorage)
      const recents = await engine.getRecentNetworks()
      expect(recents).to.deep.equal([])
    })

    it('should remove all recent networks on clearRecentNetworks', async () => {
      await AsyncStorage.clear()
      const ref: NetworkReference = {
        hash: 'preseed-hash',
        relays: [],
        name: 'preseed',
        primaryAuthorityDomainName: 'p.example'
      }
      await AsyncStorage.setItem('recentNetworks', [ref])
      const engine = new NetworksEngine(AsyncStorage)
      await engine.clearRecentNetworks()
      const got = await AsyncStorage.getItem('recentNetworks')
      expect(got).to.equal(undefined)
    })

    it.skip('should move a reopened network to the front of recents (dedup) — BLOCKED on quereus#23')

    it.skip('should not modify recents when open is called with storeAsRecent=false — BLOCKED on quereus#23')
  })

  // -----------------------------------------------------------------------
  // 16. Open
  // -----------------------------------------------------------------------
  describe('open', () => {
    it.skip('should return a NetworkEngine instance — BLOCKED on quereus#23 (open() requires a cached context from create())')

    it.skip('should create a fresh database context for each open call — BLOCKED on quereus#23')

    it.skip('should work with undefined user — BLOCKED on quereus#23')
  })

  // -----------------------------------------------------------------------
  // 17. Admin / Officer Schema Constraints
  // -----------------------------------------------------------------------
  describe('Admin table constraints', () => {
    it.skip('should require at least one Officer with rad scope when inserting Admin (OfficerRequired) — BLOCKED on quereus#23')

    it.skip('should reject Admin insert when AuthorityId does not reference an existing Authority — BLOCKED on quereus#23')

    it.skip('should reject Admin when EffectiveAt is not a valid ISO datetime ending in Z — BLOCKED on quereus#23')

    it.skip('should allow initial admin for very first authority without invite or signing — BLOCKED on quereus#23')

    it.skip('should require valid invite for admin of a new (non-first) authority — BLOCKED on quereus#23')

    it.skip('should require valid AdminSignature for admin update of existing authority — BLOCKED on quereus#23')
  })

  describe('Officer table constraints', () => {
    it.skip('should reject Officer with scopes not in the Scope view — BLOCKED on quereus#23')

    it.skip('should reject Officer update or delete (OnlyInsert constraint) — BLOCKED on quereus#23')

    it.skip('should allow initial officer for very first authority without invite or signing — BLOCKED on quereus#23')

    it.skip('should require valid invite for officers of a new authority — BLOCKED on quereus#23')

    it.skip('should require valid AdminSigning for officers of an existing authority — BLOCKED on quereus#23')
  })

  // -----------------------------------------------------------------------
  // 18. ProposedNetwork Constraints
  // -----------------------------------------------------------------------
  describe('ProposedNetwork constraints', () => {
    it.skip('should reject proposal from user without rn scope on primary authority — BLOCKED on quereus#23')

    it.skip('should require a valid user signature matching the proposed digest — BLOCKED on quereus#23')

    it.skip('should reject proposal with invalid ElectionType — BLOCKED on quereus#23')

    it.skip('should reject proposal with non-integer NumberRequiredTSAs — BLOCKED on quereus#23')
  })

  // -----------------------------------------------------------------------
  // 19. Administration Lifecycle (from doc)
  // -----------------------------------------------------------------------
  describe('administration lifecycle', () => {
    it.skip('should allow admin renewal before expiration with proper signatures — BLOCKED on quereus#23')

    it.skip('should allow primary authority to replace expired admin of another authority — BLOCKED on quereus#23')

    it.skip('should require a new network if the primary authority admin itself expires without renewal — BLOCKED on quereus#23')
  })

  // -----------------------------------------------------------------------
  // 20. Invitation Flow (from doc/invitations.md & schema)
  // -----------------------------------------------------------------------
  describe('invitation flow for authorities', () => {
    it.skip('should create an InviteSlot with a valid CID, key pair, and AdminSignature backing — BLOCKED on quereus#23')

    it.skip('should reject InviteSlot when expiration is in the past — BLOCKED on quereus#23')

    it.skip('should reject InviteSlot when InviteSignature does not validate against InviteKey — BLOCKED on quereus#23')

    it.skip('should reject InviteSlot without a completed AdminSignature for the signing nonce — BLOCKED on quereus#23')

    it.skip('should create InviteResult marking acceptance with digest and invite signature — BLOCKED on quereus#23')

    it.skip('should reject InviteResult acceptance when Digest is null — BLOCKED on quereus#23')

    it.skip('should reject InviteResult rejection when Digest is not null — BLOCKED on quereus#23')

    it.skip('should allow creating a new Authority via accepted invite with valid proof of possession — BLOCKED on quereus#23')

    it.skip('should prevent reuse of an already-claimed invite slot — BLOCKED on quereus#23')
  })
})
