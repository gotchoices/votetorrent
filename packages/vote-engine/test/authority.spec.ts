import { Database } from '@quereus/quereus'
import { bytesToHex } from '@noble/curves/abstract/utils'
import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha2'
import { ElectionType, UserKeyType } from '@votetorrent/vote-core'
import { expect } from 'chai'
import { AuthorityEngine } from '../src/authority/authority-engine'
import { prepareDb } from '../src/database/initialize'
import { NetworksEngine } from '../src/networks/networks-engine'
import type { EngineContext } from '../src/types.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { AsyncStorage } from './shims/react-native'
import type {
  User,
  NetworkInit,
  INetworkEngine,
  IAuthorityEngine,
  Authority,
  Scope,
  Signature,
  NetworkReference,
  OfficerInit,
  Proposal,
  AdminInit
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

// AUTH-01: real hex-encoded secp256k1 signature for test inputs.
// Generates a fresh keypair, signs sha256(digestText ?? signerUserId), and
// returns the hex shapes contractually required by the engine.
function makeRealSignature (signerUserId: string, digestText?: string): Signature {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = Uint8Array.from(privateHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
  const digestBytes = sha256(new TextEncoder().encode(digestText ?? signerUserId))
  const sig = secp256k1.sign(digestBytes, privBytes).toCompactHex()
  return { signerUserId, signerKey: publicHex, signature: sig }
}

// Construct a minimal AuthorityEngine that has a real Database (so the
// constructor's default SigningEngine wiring is valid) but where the
// caller does NOT depend on a populated db. Useful for testing pure
// methods like createOfficerInvite / createAuthorityInvite that touch
// only in-memory crypto.
async function makeDbOnlyAuthorityEngine (): Promise<{ authorityEngine: AuthorityEngine, ctx: EngineContext, authority: Authority }> {
  const db = new Database()
  await prepareDb(db)
  const authority: Authority = {
    id: 'aid-pure',
    name: 'Pure Test Authority',
    domainName: 'pure.example.com'
  }
  const ctx: EngineContext = { db, user: undefined }
  const authorityEngine = new AuthorityEngine(authority, ctx)
  return { authorityEngine, ctx, authority }
}

// ===========================================================================
// AuthorityEngine Tests
// ===========================================================================

describe('AuthorityEngine', () => {
  // -----------------------------------------------------------------------
  // 1. Authority Details
  // -----------------------------------------------------------------------
  describe('getDetails', () => {
    // BLOCKED on https://github.com/gotchoices/quereus/issues/23 — CantDelete
    // fires on INSERT in the create() batch; createNetworkAndAuthority cannot
    // complete until upstream ships the fix. Unskip once #23 lands.
    it.skip('should return authority details with correct id, name, and domainName', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getDetails()
      expect(details.authority.id).to.equal(authority.id)
      expect(details.authority.name).to.equal('Primary Authority')
      expect(details.authority.domainName).to.equal('authority.example.com')
    })

    // BLOCKED on quereus#23 (CantDelete on INSERT)
    it.skip('should return imageRef when set on the authority', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getDetails()
      // The seed network init does not set primaryAuthority.imageUrl, so
      // this exists only to assert presence semantics once #23 lands.
      expect(details.authority).to.have.property('imageRef')
    })

    // BLOCKED on quereus#23 (CantDelete on INSERT)
    it.skip('should return undefined imageRef when not set', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getDetails()
      expect(details.authority.imageRef).to.equal(undefined)
    })

    // BLOCKED on quereus#23 (CantDelete on INSERT) — Plan 03-04 does not seed
    // ProposedAuthority directly because the schema's ProposedAuthority
    // CHECK constraints would themselves trip on the same upstream bugs.
    // Phase 6 will cover the full flow with proposal seeding once upstream
    // is unblocked.
    it.skip('should include proposed authority details when a proposal exists', async () => {
      // Placeholder body — see comment.
    })

    // BLOCKED on quereus#23 (CantDelete on INSERT)
    it.skip('should return undefined proposed when no authority proposal exists', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getDetails()
      expect(details.proposed).to.equal(undefined)
    })
  })

  // -----------------------------------------------------------------------
  // 2. Admin Details
  // -----------------------------------------------------------------------
  describe('getAdminDetails', () => {
    // BLOCKED on quereus#23 (CantDelete on INSERT) — all rows depend on the
    // create() batch succeeding.
    it.skip('should return admin with correct id, authorityId, and effectiveAt', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getAdminDetails()
      expect(details.admin.authorityId).to.equal(authority.id)
      expect(details.admin.id).to.be.a('string').with.length.greaterThan(0)
      expect(details.admin.effectiveAt).to.be.a('number')
    })

    // BLOCKED on quereus#23
    it.skip('should return the current admin officers with userId, title, and scopes', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getAdminDetails()
      expect(details.admin.officers).to.be.an('array').with.length(1)
      const officer = details.admin.officers[0]!
      expect(officer.userId).to.be.a('string').with.length.greaterThan(0)
      expect(officer.title).to.equal('Chair')
      expect(officer.scopes).to.be.an('array').that.includes('rad')
    })

    // BLOCKED on quereus#23
    it.skip('should parse thresholdPolicies from JSON stored in the Admin row', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getAdminDetails()
      expect(details.admin.thresholdPolicies).to.deep.equal([
        { policy: 'rad', threshold: 1 }
      ])
    })

    // BLOCKED on quereus#23 — needs ProposedAdmin row, which requires create()
    it.skip('should return proposed admin details when a ProposedAdmin exists', async () => {
      // Placeholder body — Phase 6 covers full proposal seeding.
    })

    // BLOCKED on quereus#23
    it.skip('should return proposed officers from ProposedOfficer rows', async () => {
      // Placeholder body — Phase 6 covers full proposal seeding.
    })

    // BLOCKED on quereus#23 — even the "no admin row" path needs a populated
    // db to demonstrate the AUTH-04 null guard against a bound-but-missing
    // authority id. Pure construction of an AuthorityEngine against an empty
    // db would also trip quereus#23 because prepareDb itself runs INSERTs
    // through the schema's deferred-constraint queue.
    it.skip('should throw Admin not found when the AuthorityEngine is bound to an unknown authority id', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const empty = new AuthorityEngine(
        { id: 'never-existed-authority', name: 'X', domainName: 'x' },
        ctx
      )
      try {
        await empty.getAdminDetails()
        expect.fail('expected getAdminDetails to throw Admin not found')
      } catch (err) {
        expect((err as Error).message).to.include('Admin not found')
      }
    })
  })

  // -----------------------------------------------------------------------
  // 3. Propose Admin
  // -----------------------------------------------------------------------
  describe('proposeAdmin', () => {
    // BLOCKED on quereus#23 — proposeAdmin inserts into ProposedAdmin which
    // requires an existing Admin row from create().
    it.skip('should insert a ProposedAdmin row with authorityId, effectiveAt, and thresholdPolicies', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [{ existing: { userId: 'user-1', authorityId: authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } }],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: ['user-1']
      }
      await authorityEngine.proposeAdmin(proposal, sig)
      const row = await ctx.db
        .prepare('select count(*) as n from ProposedAdmin where AuthorityId = :id and EffectiveAt = :e')
        .get({ ':id': authority.id, ':e': effectiveAt })
      expect(Number(row?.n)).to.equal(1)
    })

    // BLOCKED on quereus#23
    it.skip('should serialize thresholdPolicies as JSON', async () => {
      // Placeholder body — Phase 6 covers full proposal seeding.
    })

    // BLOCKED on quereus#23
    it.skip('should start a signing session with scope rad', async () => {
      // Placeholder body — Phase 6 covers full proposal seeding.
    })

    // This test does NOT depend on create() succeeding — the guard fires
    // before the DB call. Runs against a freshly-prepared empty db.
    it('should throw when no signers are provided in the proposal', async () => {
      const { authorityEngine } = await makeDbOnlyAuthorityEngine()
      const sig = makeRealSignature('user-1')
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [],
          effectiveAt: Date.now(),
          thresholdPolicies: []
        },
        signers: []
      }
      try {
        await authorityEngine.proposeAdmin(proposal, sig)
        expect.fail('expected proposeAdmin to throw on empty signers')
      } catch (err) {
        expect((err as Error).message).to.include('No initial signer')
      }
    })

    // BLOCKED on quereus#23
    it.skip('should use the first signer as the instigator of the signing session', async () => {
      // Placeholder body — Phase 6 covers full proposal seeding.
    })

    // BLOCKED on quereus#23
    it.skip('should propagate Quereus constraint errors with descriptive messages', async () => {
      // Placeholder body — Phase 6 covers full proposal seeding.
    })
  })

  // -----------------------------------------------------------------------
  // 4. Create Officer Invite — pure crypto, NO db dependency
  // -----------------------------------------------------------------------
  describe('createOfficerInvite', () => {
    const officerInit: OfficerInit = {
      name: 'Officer Aria',
      title: 'Inspector',
      scopes: ['rad', 'iad'] as Scope[]
    }

    it('should return an OfficerInvite with type "of"', async () => {
      const { authorityEngine } = await makeDbOnlyAuthorityEngine()
      const invite = authorityEngine.createOfficerInvite(officerInit)
      expect(invite.type).to.equal('of')
    })

    it('should generate a hex-encoded secp256k1 key pair for the invite', async () => {
      const { authorityEngine } = await makeDbOnlyAuthorityEngine()
      const invite = authorityEngine.createOfficerInvite(officerInit)
      expect(invite.invitePrivate).to.match(/^[0-9a-f]{64}$/)
      expect(invite.inviteKey).to.match(/^[0-9a-f]{66}$/)
    })

    it('should set expiration based on invitationSpanMinutes from now', async () => {
      const { authorityEngine } = await makeDbOnlyAuthorityEngine()
      const before = Date.now()
      const invite = authorityEngine.createOfficerInvite(officerInit)
      // Expiration is a Temporal.PlainDateTime ISO string. Parse via Date.
      const expMs = Date.parse(invite.expiration + 'Z')
      const deltaMin = (expMs - before) / 60_000
      // 60-minute span ± 1 minute tolerance.
      expect(deltaMin).to.be.greaterThan(59)
      expect(deltaMin).to.be.lessThan(61)
    })

    it('should include the officer init fields (name, title, scopes) in the invite', async () => {
      const { authorityEngine } = await makeDbOnlyAuthorityEngine()
      const invite = authorityEngine.createOfficerInvite(officerInit)
      expect(invite.name).to.equal(officerInit.name)
      expect(invite.title).to.equal(officerInit.title)
      expect(invite.scopes).to.deep.equal(officerInit.scopes)
    })

    it('should compute inviteSignature as a 128-char hex compact secp256k1 signature', async () => {
      // Phase 6 / TEST-01 will add full SignatureValid round-trip per
      // CONTEXT.md <deferred> (the digest formula here does not match the
      // schema's InviteSignatureValid).
      const { authorityEngine } = await makeDbOnlyAuthorityEngine()
      const invite = authorityEngine.createOfficerInvite(officerInit)
      expect(invite.inviteSignature).to.match(/^[0-9a-f]{128}$/)
    })

    it('should compute a non-empty digest over the invite fields', async () => {
      // Exact digest-formula verification deferred to Phase 6 per
      // CONTEXT.md <deferred>.
      const { authorityEngine } = await makeDbOnlyAuthorityEngine()
      const invite = authorityEngine.createOfficerInvite(officerInit)
      expect(invite.digest).to.be.a('string').with.length.greaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // 5. Create Authority Invite — pure crypto, NO db dependency
  // -----------------------------------------------------------------------
  describe('createAuthorityInvite', () => {
    it('should return an AuthorityInvite with type "au"', async () => {
      const { authorityEngine } = await makeDbOnlyAuthorityEngine()
      const invite = authorityEngine.createAuthorityInvite('InviteCorp')
      expect(invite.type).to.equal('au')
    })

    it('should generate a hex-encoded secp256k1 key pair for the invite', async () => {
      const { authorityEngine } = await makeDbOnlyAuthorityEngine()
      const invite = authorityEngine.createAuthorityInvite('InviteCorp')
      expect(invite.invitePrivate).to.match(/^[0-9a-f]{64}$/)
      expect(invite.inviteKey).to.match(/^[0-9a-f]{66}$/)
    })

    it('should set expiration based on invitationSpanMinutes from now', async () => {
      const { authorityEngine } = await makeDbOnlyAuthorityEngine()
      const before = Date.now()
      const invite = authorityEngine.createAuthorityInvite('InviteCorp')
      const expMs = Date.parse(invite.expiration + 'Z')
      const deltaMin = (expMs - before) / 60_000
      expect(deltaMin).to.be.greaterThan(59)
      expect(deltaMin).to.be.lessThan(61)
    })

    it('should include the authority name in the invite', async () => {
      const { authorityEngine } = await makeDbOnlyAuthorityEngine()
      const invite = authorityEngine.createAuthorityInvite('InviteCorp')
      expect(invite.name).to.equal('InviteCorp')
    })

    it('should compute inviteSignature as a 128-char hex compact secp256k1 signature', async () => {
      // Phase 6 / TEST-01 will add full SignatureValid round-trip.
      const { authorityEngine } = await makeDbOnlyAuthorityEngine()
      const invite = authorityEngine.createAuthorityInvite('InviteCorp')
      expect(invite.inviteSignature).to.match(/^[0-9a-f]{128}$/)
    })

    it('should compute a non-empty digest over the invite fields', async () => {
      const { authorityEngine } = await makeDbOnlyAuthorityEngine()
      const invite = authorityEngine.createAuthorityInvite('InviteCorp')
      expect(invite.digest).to.be.a('string').with.length.greaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // 6. Save Invite with Signing
  // -----------------------------------------------------------------------
  describe('saveInviteWithSigning', () => {
    // BLOCKED on quereus#23 — all flows depend on create() succeeding.
    it.skip('should start a signing session using the authority id and invite digest', async () => {
      // Placeholder body — Phase 6 covers the full flow.
    })

    // BLOCKED on quereus#23
    it.skip('should save an authority invite to InviteSlot when type is "au"', async () => {
      // Placeholder body — Phase 6 covers the full flow.
    })

    // BLOCKED on quereus#23
    it.skip('should save an officer invite to InviteSlot when type is "of"', async () => {
      // Placeholder body — Phase 6 covers the full flow.
    })

    // BLOCKED on quereus#23
    it.skip('should use scope "iad" for authority invites', async () => {
      // Placeholder body — Phase 6 covers the full flow.
    })

    // BLOCKED on quereus#23
    it.skip('should use scope "rad" for officer invites', async () => {
      // Placeholder body — Phase 6 covers the full flow.
    })

    // BLOCKED on quereus#23
    it.skip('should compute CID as Digest of invite fields and nonce', async () => {
      // Placeholder body — Phase 6 covers the full flow.
    })

    // BLOCKED on quereus#23
    it.skip('should store expiration, inviteKey, and inviteSignature in InviteSlot', async () => {
      // Placeholder body — Phase 6 covers the full flow.
    })
  })

  // -----------------------------------------------------------------------
  // 7. Get Authority Invites
  // -----------------------------------------------------------------------
  describe('getAuthorityInvites', () => {
    // BLOCKED on quereus#23 — needs a populated db from create().
    it.skip('should return an empty array when no authority invites exist', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const invites = await authorityEngine.getAuthorityInvites()
      expect(invites).to.be.an('array').with.length(0)
    })

    // BLOCKED on quereus#23
    it.skip('should return sent invites with name and type "au"', async () => {
      // Placeholder body — Phase 6 covers the full flow.
    })

    // BLOCKED on https://github.com/gotchoices/quereus/issues/23 —
    // NetworkEngine.respondToInvite (USER-07) shipped in Phase 4, but
    // exercising it requires a seeded InviteSlot + AdminSignature from
    // AuthorityEngine.saveInviteWithSigning, which itself trips #23.
    it.skip('should include InviteResult when an invite has been accepted', async () => {
      // Placeholder body — see comment.
    })

    // BLOCKED on quereus#23 (same chain — needs a seeded InviteSlot row).
    it.skip('should include InviteResult when an invite has been rejected', async () => {
      // Placeholder body — see comment.
    })

    // BLOCKED on quereus#23
    it.skip('should return undefined result when invite has not been responded to', async () => {
      // Placeholder body — Phase 6 covers the full flow.
    })

    // BLOCKED on quereus#23
    it.skip('should only return invites scoped to "iad" for the current authority', async () => {
      // Placeholder body — Phase 6 covers the full flow.
    })
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

// Quiet unused-import warning — bytesToHex is reserved for future hex
// reconstruction; the current makeRealSignature reads privateHex back
// via Uint8Array.from + .match.
void bytesToHex
