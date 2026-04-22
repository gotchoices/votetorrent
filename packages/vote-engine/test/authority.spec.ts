import { ElectionType, UserKeyType } from '@votetorrent/vote-core'
// import { expect } from 'chai'
// import { AuthorityEngine } from '../src/authority/authority-engine'
// import { NetworkEngine } from '../src/network/network-engine'
import { NetworksEngine } from '../src/networks/networks-engine'
import { AsyncStorage } from './shims/react-native'
import type {
  User,
  NetworkInit,
  INetworkEngine,
  IAuthorityEngine,
  Authority,
  // AdminDetails,
  // AuthorityDetails,
  // AdminInit,
  // OfficerInit,
  // OfficerInvite,
  // AuthorityInvite,
  // InviteStatus,
  // SentAuthorityInvite,
  // Proposal,
  Scope,
  // Signature,
  NetworkReference
} from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser (overrides?: Partial<User>): User {
  return {
    id: 'user-1',
    name: 'Test User',
    imageRef: { url: 'https://img.local/user.png' },
    activeKeys: [
      {
        key: 'key-1',
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
    },
    ...overrides
  }
}

async function createNetworkAndAuthority (): Promise<{
  networkEngine: INetworkEngine
  authorityEngine: IAuthorityEngine
  authority: Authority
}> {
  await AsyncStorage.clear()
  await AsyncStorage.setItem('recentNetworks', [])
  const networksEngine = new NetworksEngine(AsyncStorage)
  const user = makeUser()
  const networkInit = makeNetworkInit()
  const networkEngine = await networksEngine.create(networkInit, user)
  const recents = (await AsyncStorage.getItem<NetworkReference[]>('recentNetworks')) ?? []
  const ref = recents[0]
  if (!ref) throw new Error('No network reference found after create')

  // Open the primary authority created during network creation
  const details = await networkEngine.getDetails()
  const authorityId = details.network.primaryAuthorityId
  const authorityEngine = await networkEngine.openAuthority(authorityId)
  const authorityDetails = await authorityEngine.getDetails()

  return {
    networkEngine,
    authorityEngine,
    authority: authorityDetails.authority
  }
}

// ===========================================================================
// AuthorityEngine Tests
// ===========================================================================

describe('AuthorityEngine', () => {
  // -----------------------------------------------------------------------
  // 1. Authority Details
  // -----------------------------------------------------------------------
  describe('getDetails', () => {
    it('should return authority details with correct id, name, and domainName')

    it('should return imageRef when set on the authority')

    it('should return undefined imageRef when not set')

    it('should include proposed authority details when a proposal exists')

    it('should return undefined proposed when no authority proposal exists')
  })

  // -----------------------------------------------------------------------
  // 2. Admin Details
  // -----------------------------------------------------------------------
  describe('getAdminDetails', () => {
    it('should return admin with correct id, authorityId, and effectiveAt')

    it('should return the current admin officers with userId, title, and scopes')

    it('should parse thresholdPolicies from JSON stored in the Admin row')

    it('should return proposed admin details when a ProposedAdmin exists')

    it('should return proposed officers from ProposedOfficer rows')

    it('should throw when authority has no admin rows')
  })

  // -----------------------------------------------------------------------
  // 3. Propose Admin
  // -----------------------------------------------------------------------
  describe('proposeAdmin', () => {
    it('should insert a ProposedAdmin row with authorityId, effectiveAt, and thresholdPolicies')

    it('should serialize thresholdPolicies as JSON')

    it('should start a signing session with scope rad')

    it('should throw when no signers are provided in the proposal')

    it('should use the first signer as the instigator of the signing session')

    it('should propagate Quereus constraint errors with descriptive messages')
  })

  // -----------------------------------------------------------------------
  // 4. Create Officer Invite
  // -----------------------------------------------------------------------
  describe('createOfficerInvite', () => {
    it('should return an OfficerInvite with type "of"')

    it('should generate a secp256k1 key pair for the invite')

    it('should set expiration based on invitationSpanMinutes from now')

    it('should include the officer init fields (name, title, scopes) in the invite')

    it('should compute inviteSignature over the invite fields using the private key')

    it('should compute a digest over all invite fields including the signature')
  })

  // -----------------------------------------------------------------------
  // 5. Create Authority Invite
  // -----------------------------------------------------------------------
  describe('createAuthorityInvite', () => {
    it('should return an AuthorityInvite with type "au"')

    it('should generate a secp256k1 key pair for the invite')

    it('should set expiration based on invitationSpanMinutes from now')

    it('should include the authority name in the invite')

    it('should compute inviteSignature over the invite fields using the private key')

    it('should compute a digest over all invite fields including the signature')
  })

  // -----------------------------------------------------------------------
  // 6. Save Invite with Signing
  // -----------------------------------------------------------------------
  describe('saveInviteWithSigning', () => {
    it('should start a signing session using the authority id and invite digest')

    it('should save an authority invite to InviteSlot when type is "au"')

    it('should save an officer invite to InviteSlot when type is "of"')

    it('should use scope "iad" for authority invites')

    it('should use scope "rad" for officer invites')

    it('should compute CID as Digest of invite fields and nonce')

    it('should store expiration, inviteKey, and inviteSignature in InviteSlot')
  })

  // -----------------------------------------------------------------------
  // 7. Get Authority Invites
  // -----------------------------------------------------------------------
  describe('getAuthorityInvites', () => {
    it('should return an empty array when no authority invites exist')

    it('should return sent invites with name and type "au"')

    it('should include InviteResult when an invite has been accepted')

    it('should include InviteResult when an invite has been rejected')

    it('should return undefined result when invite has not been responded to')

    it('should only return invites scoped to "iad" for the current authority')
  })

  // -----------------------------------------------------------------------
  // 8. Schema Constraints - Authority Table
  // -----------------------------------------------------------------------
  describe('schema constraints - Authority table', () => {
    it('should allow the very first authority without an invite or signing nonce')

    it('should reject deletion of an Authority (CantDelete constraint)')

    it('should reject mutation of Authority.Id on update (IdImmutable constraint)')

    it('should require an Admin row to exist when inserting an Authority (AdminRequired)')

    it('should require a valid accepted InviteResult for subsequent authority inserts (InsertValid)')

    it('should validate update using AdminSignature with scope uai (UpdateValid)')
  })

  // -----------------------------------------------------------------------
  // 9. Schema Constraints - Admin Table
  // -----------------------------------------------------------------------
  describe('schema constraints - Admin table', () => {
    it('should require at least one Officer with rad scope when inserting Admin (OfficerRequired)')

    it('should reject Admin insert when AuthorityId does not reference an existing Authority')

    it('should reject Admin when EffectiveAt is not a valid ISO datetime ending in Z')

    it('should allow initial admin for very first authority without invite or signing (MutationValid)')

    it('should require valid invite for admin of a new (non-first) authority (MutationValid)')

    it('should require valid AdminSignature for admin update of existing authority (MutationValid)')
  })

  // -----------------------------------------------------------------------
  // 10. Schema Constraints - Officer Table
  // -----------------------------------------------------------------------
  describe('schema constraints - Officer table', () => {
    it('should reject Officer with scopes not in the Scope view (ScopesValid)')

    it('should reject Officer update or delete (OnlyInsert constraint)')

    it('should require Admin row to exist for the officer AdminEffectiveAt (AdminValid)')

    it('should require User to exist for the officer UserId (UserIdValid)')

    it('should allow initial officer for very first authority without invite or signing (InsertValid)')

    it('should require valid invite for officers of a new authority (InsertValid)')

    it('should require valid AdminSigning for officers of an existing authority (InsertValid)')
  })

  // -----------------------------------------------------------------------
  // 11. Schema Constraints - ProposedAuthority Table
  // -----------------------------------------------------------------------
  describe('schema constraints - ProposedAuthority table', () => {
    it('should require the authority to exist (AuthorityExists)')

    it('should require a valid officer with uai scope and matching signature (UserValid)')
  })

  // -----------------------------------------------------------------------
  // 12. Schema Constraints - ProposedAdmin Table
  // -----------------------------------------------------------------------
  describe('schema constraints - ProposedAdmin table', () => {
    it('should require the authority to exist (AuthorityIdValid)')

    it('should require EffectiveAt to be a valid ISO datetime ending in Z')

    it('should require a valid officer with rad scope and matching signature (UserValid)')
  })

  // -----------------------------------------------------------------------
  // 13. Schema Constraints - ProposedOfficer Table
  // -----------------------------------------------------------------------
  describe('schema constraints - ProposedOfficer table', () => {
    it('should require the authority to exist (AuthorityIdValid)')

    it('should require a ProposedAdmin to exist for the officer AdminEffectiveAt (AdminValid)')

    it('should reject deletion of a ProposedOfficer (CantDelete)')

    it('should reject scopes not in the Scope view (ScopesValid)')

    it('should require a valid officer with rad scope and matching signature (UserValid)')
  })

  // -----------------------------------------------------------------------
  // 14. Schema Constraints - InviteSlot Table
  // -----------------------------------------------------------------------
  describe('schema constraints - InviteSlot table', () => {
    it('should validate CID as Digest of invite fields (CidValid)')

    it('should reject InviteSlot when expiration is in the past (ExpirationValid)')

    it('should validate InviteSignature against InviteKey (InviteSignatureValid)')

    it('should reject update or delete of InviteSlot (InsertOnly)')

    it('should require a completed AdminSignature for the signing nonce (InsertValid)')
  })

  // -----------------------------------------------------------------------
  // 15. Schema Constraints - InviteResult Table
  // -----------------------------------------------------------------------
  describe('schema constraints - InviteResult table', () => {
    it('should reject update or delete of InviteResult (InsertOnly)')

    it('should require a valid InviteSlot and AdminSignature (SigningValid)')

    it('should validate InviteSignature against the InviteSlot InviteKey (SignatureValid)')

    it('should reject acceptance when Digest is null (DigestValid)')

    it('should reject rejection when Digest is not null (DigestValid)')
  })

  // -----------------------------------------------------------------------
  // 16. Admin Signing Flow (via SigningEngine)
  // -----------------------------------------------------------------------
  describe('admin signing flow', () => {
    it('should create an AdminSigning session with a random nonce')

    it('should reject AdminSigning with an invalid scope code (ScopeValid)')

    it('should validate the instigator signature on AdminSigning (SignatureValid)')

    it('should reject update or delete of AdminSigning (InsertOnly)')

    it('should accept OfficerSignature when the officer has the required scope and digest matches')

    it('should reject OfficerSignature when the signature does not match the digest')

    it('should create AdminSignature only when the threshold of OfficerSignatures is met')

    it('should reject AdminSignature when insufficient OfficerSignatures exist')
  })

  // -----------------------------------------------------------------------
  // 17. Administration Lifecycle
  // -----------------------------------------------------------------------
  describe('administration lifecycle', () => {
    it('should allow admin renewal before expiration with proper signatures')

    it('should allow primary authority to replace expired admin of another authority')

    it('should require a new network if the primary authority admin itself expires without renewal')

    it('should transition proposed admin to current admin after signing threshold is met')
  })

  // -----------------------------------------------------------------------
  // 18. Invitation Flow - Authority
  // -----------------------------------------------------------------------
  describe('invitation flow - authority invites', () => {
    it('should create an InviteSlot with a valid CID, key pair, and AdminSignature backing')

    it('should allow creating a new Authority via accepted invite with valid proof of possession')

    it('should prevent reuse of an already-claimed invite slot')

    it('should create InviteResult marking acceptance with digest and invite signature')

    it('should create InviteResult marking rejection with null digest')
  })

  // -----------------------------------------------------------------------
  // 19. Invitation Flow - Officer
  // -----------------------------------------------------------------------
  describe('invitation flow - officer invites', () => {
    it('should create an InviteSlot for an officer invite with type "of"')

    it('should include officer name, title, and scopes in the invite')

    it('should allow accepting an officer invite to associate a user with the authority')

    it('should prevent reuse of an already-claimed officer invite slot')
  })
})
