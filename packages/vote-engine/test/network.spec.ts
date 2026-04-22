import { ElectionType, UserKeyType } from '@votetorrent/vote-core'
import { expect } from 'chai'
import { NetworkEngine } from '../src/network/network-engine'
import { NetworksEngine } from '../src/networks/networks-engine'
import { AsyncStorage } from './shims/react-native'
import type {
  User,
  NetworkInit,
  INetworkEngine,
  NetworkRevision,
  NetworkReference,
  Authority,
  AdminInit,
  AuthorityInit,
  Scope,
  NetworkDetails,
  NetworkSummary,
} from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides?: Partial<User>): User {
  return {
    id: 'user-1',
    name: 'Test User',
    imageRef: { url: 'https://img.local/user.png' },
    activeKeys: [
      {
        key: 'key-1',
        type: UserKeyType.mobile,
        expiration: Date.now() + 86_400_000,
      },
    ],
    ...overrides,
  }
}

function makeNetworkInit(overrides?: Partial<NetworkInit>): NetworkInit {
  return {
    name: 'Test Network',
    imageUrl: 'https://cdn.example.com/logo.png',
    relays: ['/dns4/relay.example.com/tcp/443/wss'],
    primaryAuthority: {
      name: 'Primary Authority',
      domainName: 'authority.example.com',
    },
    admin: {
      officers: [
        {
          init: {
            name: 'Admin A',
            title: 'Chair',
            scopes: ['rn', 'mel'] as Scope[],
          },
        },
      ],
      effectiveAt: Date.now(),
      thresholdPolicies: [{ policy: 'rn', threshold: 1 }],
    },
    policies: {
      timestampAuthorities: [{ url: 'https://tsa.example.com' }],
      numberRequiredTSAs: 1,
      electionType: ElectionType.adhoc,
    },
    ...overrides,
  }
}

async function createNetworkEngine(): Promise<{
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

// ===========================================================================
// NetworkEngine Tests
// ===========================================================================

describe('NetworkEngine', () => {

  // -----------------------------------------------------------------------
  // 1. Network Details & Summary
  // -----------------------------------------------------------------------
  describe('getDetails', () => {
    it('should return network details with correct id, hash, name, and relays')

    it('should include primaryAuthorityId referencing the created authority')

    it('should return correct network policies (electionType, TSAs, numberRequiredTSAs)')

    it('should return undefined proposed revision when none has been proposed')

    it('should throw when network hash does not exist in the database')
  })

  describe('getNetworkSummary', () => {
    it('should return a summary with hash, name, id, and primaryAuthorityDomainName')

    it('should return imageUrl from the primary authority imageRef')

    it('should throw when the network is not found')

    it('should throw when the primary authority for the network is missing')
  })

  // -----------------------------------------------------------------------
  // 2. Network Schema Constraints (from votetorrent.qsql)
  // -----------------------------------------------------------------------
  describe('schema constraints - Network table', () => {
    it('should reject deletion of a Network (CantDelete constraint)')

    it('should reject mutation of Network.Id on update (IdImmutable constraint)')

    it('should reject mutation of Network.Hash on update (HashImmutable constraint)')

    it('should reject mutation of Network.PrimaryAuthorityId on update (PrimaryAuthorityIdImmutable constraint)')

    it('should reject insert when PrimaryAuthorityId does not reference an existing Authority')

    it('should reject insert/update when ElectionType is not a valid code (o or a)')

    it('should reject insert/update when NumberRequiredTSAs is negative')

    it('should reject insert/update when NumberRequiredTSAs is not an integer')

    it('should enforce that SigningNonce is null on insert (NoSigningNonceOnInsert)')

    it('should reject update without a valid AdminSignature with scope rn from primary authority (UpdateNetworkValid)')
  })

  // -----------------------------------------------------------------------
  // 3. Authority Creation from within a Network
  // -----------------------------------------------------------------------
  describe('createAuthority', () => {
    it('should create an authority with a generated UUID id')

    it('should insert Authority, Admin, and Officer rows in one transaction')

    it('should fail when officer init is missing (no officers provided)')

    it('should fail when officer scopes contain invalid scope codes')

    it('should reject creating a second authority without a valid invite (InsertValid constraint)')

    it('should set Authority.DomainName to the provided value or null')

    it('should serialize imageRef as JSON in the Authority row')
  })

  // -----------------------------------------------------------------------
  // 4. Authority Schema Constraints (from votetorrent.qsql)
  // -----------------------------------------------------------------------
  describe('schema constraints - Authority table', () => {
    it('should allow the very first authority without an invite or signing nonce')

    it('should reject deletion of an Authority (CantDelete constraint)')

    it('should reject mutation of Authority.Id on update (IdImmutable constraint)')

    it('should require an Admin row to exist when inserting an Authority (AdminRequired)')

    it('should require a valid invite for subsequent authority inserts')

    it('should validate update using AdminSignature with scope uai (UpdateValid)')
  })

  // -----------------------------------------------------------------------
  // 5. Network Revision Proposals
  // -----------------------------------------------------------------------
  describe('proposeRevision', () => {
    it('should insert a ProposedNetwork row with the proposed name, relays, and policies')

    it('should serialize imageRef as JSON or null')

    it('should serialize relays as a JSON array')

    it('should serialize timestampAuthorities as a JSON array')

    it('should reject proposed revision with invalid ElectionType (ElectionTypeValid constraint)')

    it('should reject proposed revision with negative NumberRequiredTSAs')

    it('should only allow officers with rn scope from the primary authority (UserValid constraint)')

    it('should require a valid user signature over the proposed digest')
  })

  // -----------------------------------------------------------------------
  // 6. Network Revision Signing (AdminSigning / AdminSignature flow)
  // -----------------------------------------------------------------------
  describe('network revision signing flow', () => {
    it('should create an AdminSigning session with scope rn and a valid digest')

    it('should reject AdminSigning with an invalid scope code')

    it('should validate the instigator signature on AdminSigning (SignatureValid)')

    it('should accept OfficerSignature when the officer has rn scope and the digest matches')

    it('should reject OfficerSignature when the signature does not match the AdminSigning digest')

    it('should create AdminSignature only when the threshold of OfficerSignatures is met')

    it('should reject AdminSignature when insufficient OfficerSignatures exist')

    it('should allow network update only after AdminSignature exists with matching digest')
  })

  // -----------------------------------------------------------------------
  // 7. Pinned Authorities (local storage)
  // -----------------------------------------------------------------------
  describe('pinAuthority / unpinAuthority', () => {
    it('should start with an empty list of pinned authorities')

    it('should add an authority to pinned list via pinAuthority')

    it('should deduplicate when pinning the same authority twice')

    it('should remove an authority from pinned list via unpinAuthority')

    it('should be a no-op when unpinning an authority that is not pinned')

    it('should persist pinned authorities across engine instances via localStorage')
  })

  // -----------------------------------------------------------------------
  // 8. Open Authority
  // -----------------------------------------------------------------------
  describe('openAuthority', () => {
    it('should return an AuthorityEngine when given a valid authorityId')

    it('should use the provided Authority object when supplied')

    it('should query the database for the authority when no object is provided')

    it('should throw when the authorityId does not exist in the database')
  })

  // -----------------------------------------------------------------------
  // 9. User Retrieval
  // -----------------------------------------------------------------------
  describe('getUser', () => {
    it('should return a UserEngine for a valid userId')

    it('should return undefined when userId does not exist')

    it('should include only non-expired active keys in the returned user')
  })

  describe('getCurrentUser', () => {
    it('should return the current user engine from the engine context')
  })

  // -----------------------------------------------------------------------
  // 10. Election Stubs (ensure not-implemented errors)
  // -----------------------------------------------------------------------
  describe('election methods (not yet implemented)', () => {
    it('should throw "Not implemented" from createElection')

    it('should throw "Not implemented" from openElection')
  })

  // -----------------------------------------------------------------------
  // 11. Invite Response
  // -----------------------------------------------------------------------
  describe('respondToInvite', () => {
    it('should throw "Not implemented" for now')
  })

  // -----------------------------------------------------------------------
  // 12. Authorities By Name (cursor-based)
  // -----------------------------------------------------------------------
  describe('getAuthoritiesByName / nextAuthoritiesByName', () => {
    it('should throw "Not implemented" from getAuthoritiesByName')

    it('should throw "Not implemented" from nextAuthoritiesByName')
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
    it('should fail when no officers are provided in admin init')

    it('should fail when user has no active keys')

    it('should fail when user key is expired')

    it('should create Network, Authority, Admin, Officer, User, and UserKey in one transaction')

    it('should generate a unique network ID (UUID) on each create')

    it('should compute Hash as H16 of the network ID')

    it('should set PrimaryAuthorityId to the generated authority UUID')
  })

  // -----------------------------------------------------------------------
  // 14. Network Creation - Schema Constraint Coverage
  // -----------------------------------------------------------------------
  describe('create - schema constraints', () => {
    it('should reject when ElectionType is not a valid code')

    it('should reject when NumberRequiredTSAs is negative')

    it('should reject when admin EffectiveAt is not a valid ISO datetime ending in Z')

    it('should reject when officer scopes contain unknown scope codes')

    it('should allow the first authority+admin+officer to bootstrap without signing context')
  })

  // -----------------------------------------------------------------------
  // 15. Recent Networks Management
  // -----------------------------------------------------------------------
  describe('recent networks', () => {
    it('should append the created network to recent networks')

    it('should return empty array from getRecentNetworks when none exist')

    it('should remove all recent networks on clearRecentNetworks')

    it('should move a reopened network to the front of recents (dedup)')

    it('should not modify recents when open is called with storeAsRecent=false')
  })

  // -----------------------------------------------------------------------
  // 16. Open
  // -----------------------------------------------------------------------
  describe('open', () => {
    it('should return a NetworkEngine instance')

    it('should create a fresh database context for each open call')

    it('should work with undefined user')
  })

  // -----------------------------------------------------------------------
  // 17. Admin / Officer Schema Constraints
  // -----------------------------------------------------------------------
  describe('Admin table constraints', () => {
    it('should require at least one Officer with rad scope when inserting Admin (OfficerRequired)')

    it('should reject Admin insert when AuthorityId does not reference an existing Authority')

    it('should reject Admin when EffectiveAt is not a valid ISO datetime ending in Z')

    it('should allow initial admin for very first authority without invite or signing')

    it('should require valid invite for admin of a new (non-first) authority')

    it('should require valid AdminSignature for admin update of existing authority')
  })

  describe('Officer table constraints', () => {
    it('should reject Officer with scopes not in the Scope view')

    it('should reject Officer update or delete (OnlyInsert constraint)')

    it('should allow initial officer for very first authority without invite or signing')

    it('should require valid invite for officers of a new authority')

    it('should require valid AdminSigning for officers of an existing authority')
  })

  // -----------------------------------------------------------------------
  // 18. ProposedNetwork Constraints
  // -----------------------------------------------------------------------
  describe('ProposedNetwork constraints', () => {
    it('should reject proposal from user without rn scope on primary authority')

    it('should require a valid user signature matching the proposed digest')

    it('should reject proposal with invalid ElectionType')

    it('should reject proposal with non-integer NumberRequiredTSAs')
  })

  // -----------------------------------------------------------------------
  // 19. Administration Lifecycle (from doc)
  // -----------------------------------------------------------------------
  describe('administration lifecycle', () => {
    it('should allow admin renewal before expiration with proper signatures')

    it('should allow primary authority to replace expired admin of another authority')

    it('should require a new network if the primary authority admin itself expires without renewal')
  })

  // -----------------------------------------------------------------------
  // 20. Invitation Flow (from doc/invitations.md & schema)
  // -----------------------------------------------------------------------
  describe('invitation flow for authorities', () => {
    it('should create an InviteSlot with a valid CID, key pair, and AdminSignature backing')

    it('should reject InviteSlot when expiration is in the past')

    it('should reject InviteSlot when InviteSignature does not validate against InviteKey')

    it('should reject InviteSlot without a completed AdminSignature for the signing nonce')

    it('should create InviteResult marking acceptance with digest and invite signature')

    it('should reject InviteResult acceptance when Digest is null')

    it('should reject InviteResult rejection when Digest is not null')

    it('should allow creating a new Authority via accepted invite with valid proof of possession')

    it('should prevent reuse of an already-claimed invite slot')
  })
})
