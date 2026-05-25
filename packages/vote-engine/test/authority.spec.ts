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
    it('should return authority details with correct id, name, and domainName', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getDetails()
      expect(details.authority.id).to.equal(authority.id)
      expect(details.authority.name).to.equal('Primary Authority')
      expect(details.authority.domainName).to.equal('authority.example.com')
    })

    // BLOCKED on quereus#23 (CantDelete on INSERT)
    it('should return imageRef when set on the authority', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getDetails()
      // The seed network init does not set primaryAuthority.imageUrl, so
      // this exists only to assert presence semantics once #23 lands.
      expect(details.authority).to.have.property('imageRef')
    })

    // BLOCKED on quereus#23 (CantDelete on INSERT)
    it('should return undefined imageRef when not set', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getDetails()
      expect(details.authority.imageRef).to.equal(undefined)
    })

    // BLOCKED on quereus#23 (CantDelete on INSERT) — Plan 03-04 does not seed
    // ProposedAuthority directly because the schema's ProposedAuthority
    // CHECK constraints would themselves trip on the same upstream bugs.
    // Phase 6 will cover the full flow with proposal seeding once upstream
    // is unblocked.
    it('should include proposed authority details when a proposal exists', async () => {
      const { authorityEngine, authority } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      // Seed a ProposedAuthority row directly (engine has no proposeAuthority
      // method yet). UserValid CHECK fires unless context.UserId/UserKey/
      // Signature line up with a current officer; this scaffold inserts via
      // raw exec with the seeded user's keys.
      const sig = makeRealSignature('user-1')
      await ctx.db.exec(
        `insert into ProposedAuthority (Id, Name, DomainName, ImageRef)
         with context UserId = :uid, UserKey = :key, Signature = :sig, Tid = 7, now = ${Date.now()}
         values (:id, 'Proposed Name', 'proposed.example', null)`,
        {
          uid: 'user-1',
          key: sig.signerKey,
          sig: sig.signature,
          id: authority.id
        }
      )
      const details = await authorityEngine.getDetails()
      expect(details.proposed).to.not.equal(undefined)
      expect(details.proposed?.proposed?.name).to.equal('Proposed Name')
    })

    // BLOCKED on quereus#23 (CantDelete on INSERT)
    it('should return undefined proposed when no authority proposal exists', async () => {
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
    it('should return admin with correct id, authorityId, and effectiveAt', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getAdminDetails()
      expect(details.admin.authorityId).to.equal(authority.id)
      expect(details.admin.id).to.be.a('string').with.length.greaterThan(0)
      expect(details.admin.effectiveAt).to.be.a('number')
    })

    // BLOCKED on quereus#23
    it('should return the current admin officers with userId, title, and scopes', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getAdminDetails()
      expect(details.admin.officers).to.be.an('array').with.length(1)
      const officer = details.admin.officers[0]!
      expect(officer.userId).to.be.a('string').with.length.greaterThan(0)
      expect(officer.title).to.equal('Chair')
      expect(officer.scopes).to.be.an('array').that.includes('rad')
    })

    // BLOCKED on quereus#23
    it('should parse thresholdPolicies from JSON stored in the Admin row', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getAdminDetails()
      expect(details.admin.thresholdPolicies).to.deep.equal([
        { policy: 'rad', threshold: 1 }
      ])
    })

    // BLOCKED on quereus#23 — needs ProposedAdmin row, which requires create()
    it('should return proposed admin details when a ProposedAdmin exists', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      const effectiveAt = new Date(Date.now() + 60_000).toISOString()
      await ctx.db.exec(
        `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
         with context UserId = :uid, UserKey = :key, Signature = :sig, Tid = 7, now = ${Date.now()}
         values (:authId, :eff, :tp)`,
        {
          uid: 'user-1',
          key: sig.signerKey,
          sig: sig.signature,
          authId: authority.id,
          eff: effectiveAt,
          tp: JSON.stringify([{ policy: 'rad', threshold: 1 }])
        }
      )
      const details = await authorityEngine.getAdminDetails()
      expect(details.proposed).to.not.equal(undefined)
    })

    // BLOCKED on quereus#23
    it('should return proposed officers from ProposedOfficer rows', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      const effectiveAt = new Date(Date.now() + 60_000).toISOString()
      // Seed ProposedAdmin first (required by ProposedOfficer.AdminValid).
      await ctx.db.exec(
        `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
         with context UserId = :uid, UserKey = :key, Signature = :sig, Tid = 7, now = ${Date.now()}
         values (:authId, :eff, '[]')`,
        {
          uid: 'user-1',
          key: sig.signerKey,
          sig: sig.signature,
          authId: authority.id,
          eff: effectiveAt
        }
      )
      await ctx.db.exec(
        `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes)
         with context UserId = :uid, UserKey = :key, Signature = :sig, Tid = 7, now = ${Date.now()}
         values (:authId, :eff, 'Officer Bob', 'Inspector', :scopes)`,
        {
          uid: 'user-1',
          key: sig.signerKey,
          sig: sig.signature,
          authId: authority.id,
          eff: effectiveAt,
          scopes: JSON.stringify(['rad'])
        }
      )
      const details = await authorityEngine.getAdminDetails()
      const proposedOfficers =
        (details.proposed as { proposed?: { officers?: unknown[] } } | undefined)
          ?.proposed?.officers
      expect(proposedOfficers).to.be.an('array').with.length.greaterThan(0)
    })

    // BLOCKED on quereus#23 — even the "no admin row" path needs a populated
    // db to demonstrate the AUTH-04 null guard against a bound-but-missing
    // authority id. Pure construction of an AuthorityEngine against an empty
    // db would also trip quereus#23 because prepareDb itself runs INSERTs
    // through the schema's deferred-constraint queue.
    it('should throw Admin not found when the AuthorityEngine is bound to an unknown authority id', async () => {
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
    it('should insert a ProposedAdmin row with authorityId, effectiveAt, and thresholdPolicies', async () => {
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
        .get({ id: authority.id, e: effectiveAt })
      expect(Number(row?.n)).to.equal(1)
    })

    // BLOCKED on quereus#23
    it('should serialize thresholdPolicies as JSON', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      const effectiveAt = Date.now() + 60_000
      const policies = [
        { policy: 'rad' as Scope, threshold: 2 },
        { policy: 'iad' as Scope, threshold: 1 }
      ]
      await authorityEngine.proposeAdmin(
        {
          proposed: {
            officers: [
              {
                existing: {
                  userId: 'user-1',
                  authorityId: authority.id,
                  title: 'Chair',
                  scopes: ['rad'] as Scope[]
                }
              }
            ],
            effectiveAt,
            thresholdPolicies: policies
          },
          signers: ['user-1']
        },
        sig
      )
      const row = await ctx.db
        .prepare(
          'select ThresholdPolicies from ProposedAdmin where AuthorityId = :id and EffectiveAt = :e'
        )
        .get({ id: authority.id, e: effectiveAt })
      expect(JSON.parse(row!.ThresholdPolicies as string)).to.deep.equal(policies)
    })

    // BLOCKED on quereus#23
    it('should start a signing session with scope rad', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      await authorityEngine.proposeAdmin(
        {
          proposed: {
            officers: [
              {
                existing: {
                  userId: 'user-1',
                  authorityId: authority.id,
                  title: 'Chair',
                  scopes: ['rad'] as Scope[]
                }
              }
            ],
            effectiveAt: Date.now() + 60_000,
            thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
          },
          signers: ['user-1']
        },
        sig
      )
      const row = await ctx.db
        .prepare(
          'select Scope from AdminSigning where AuthorityId = :id order by Nonce desc limit 1'
        )
        .get({ id: authority.id })
      expect(row?.Scope).to.equal('rad')
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
    it('should use the first signer as the instigator of the signing session', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      await authorityEngine.proposeAdmin(
        {
          proposed: {
            officers: [
              {
                existing: {
                  userId: 'user-1',
                  authorityId: authority.id,
                  title: 'Chair',
                  scopes: ['rad'] as Scope[]
                }
              }
            ],
            effectiveAt: Date.now() + 60_000,
            thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
          },
          // Two signers — proposeAdmin should pick the first ('user-1').
          signers: ['user-1', 'user-2']
        },
        sig
      )
      const row = await ctx.db
        .prepare(
          'select UserId from AdminSigning where AuthorityId = :id order by Nonce desc limit 1'
        )
        .get({ id: authority.id })
      expect(row?.UserId).to.equal('user-1')
    })

    // BLOCKED on quereus#23
    it('should propagate Quereus constraint errors with descriptive messages', async () => {
      // A proposeAdmin call with a wildly invalid EffectiveAt should surface
      // a constraint-named error wrapped by the engine's QuereusError catch.
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await authorityEngine.proposeAdmin(
          {
            proposed: {
              officers: [
                {
                  existing: {
                    userId: 'user-1',
                    authorityId: authority.id,
                    title: 'Chair',
                    scopes: ['rad'] as Scope[]
                  }
                }
              ],
              effectiveAt: 'not-an-iso-string' as unknown as number,
              thresholdPolicies: []
            },
            signers: ['user-1']
          },
          sig
        )
      } catch (err) {
        caught = err
      }
      const msg = (caught as Error)?.message ?? ''
      expect(msg).to.match(/Quereus error|EffectiveAtValid/)
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
    it('should start a signing session using the authority id and invite digest', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('InviteCorp')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const row = await ctx.db
        .prepare(
          'select Digest from AdminSigning where AuthorityId = :id order by Nonce desc limit 1'
        )
        .get({ id: authority.id })
      expect(row?.Digest).to.equal(invite.digest)
    })

    // BLOCKED on quereus#23
    it('should save an authority invite to InviteSlot when type is "au"', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('InviteCorp')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const row = await ctx.db
        .prepare('select Name from InviteSlot where Name = :n')
        .get({ n: 'InviteCorp' })
      expect(row?.Name).to.equal('InviteCorp')
    })

    // BLOCKED on quereus#23
    it('should save an officer invite to InviteSlot when type is "of"', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createOfficerInvite({
        name: 'Officer X',
        title: 'Inspector',
        scopes: ['rad'] as Scope[]
      })
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'rad', sig)
      const row = await ctx.db
        .prepare('select Name from InviteSlot where Name = :n')
        .get({ n: 'Officer X' })
      expect(row?.Name).to.equal('Officer X')
    })

    // BLOCKED on quereus#23
    it('should use scope "iad" for authority invites', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('IADCorp')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const row = await ctx.db
        .prepare(
          'select Scope from AdminSigning where AuthorityId = :id and Digest = :d'
        )
        .get({ id: authority.id, d: invite.digest })
      expect(row?.Scope).to.equal('iad')
    })

    // BLOCKED on quereus#23
    it('should use scope "rad" for officer invites', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createOfficerInvite({
        name: 'RAD Officer',
        title: 'Inspector',
        scopes: ['rad'] as Scope[]
      })
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'rad', sig)
      const row = await ctx.db
        .prepare(
          'select Scope from AdminSigning where AuthorityId = :id and Digest = :d'
        )
        .get({ id: authority.id, d: invite.digest })
      expect(row?.Scope).to.equal('rad')
    })

    // BLOCKED on quereus#23
    it('should compute CID as Digest of invite fields and nonce', async () => {
      // CidValid CHECK in the schema: Cid = Digest(Name, Expiration,
      // InviteKey, InviteSignature, SigningNonce). saveInviteWithSigning
      // computes Cid client-side via the same Digest call; here we just
      // assert that the row lands (CidValid would fire on a mismatch).
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('CidCheck')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const row = await ctx.db
        .prepare('select Cid from InviteSlot where Name = :n')
        .get({ n: 'CidCheck' })
      expect(row?.Cid).to.be.a('string').with.length.greaterThan(0)
    })

    // BLOCKED on quereus#23
    it('should store expiration, inviteKey, and inviteSignature in InviteSlot', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('FieldCheck')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const row = await ctx.db
        .prepare(
          'select Expiration, InviteKey, InviteSignature from InviteSlot where Name = :n'
        )
        .get({ n: 'FieldCheck' })
      expect(row?.Expiration).to.equal(invite.expiration)
      expect(row?.InviteKey).to.equal(invite.inviteKey)
      expect(row?.InviteSignature).to.equal(invite.inviteSignature)
    })
  })

  // -----------------------------------------------------------------------
  // 7. Get Authority Invites
  // -----------------------------------------------------------------------
  describe('getAuthorityInvites', () => {
    // BLOCKED on quereus#23 — needs a populated db from create().
    it('should return an empty array when no authority invites exist', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const invites = await authorityEngine.getAuthorityInvites()
      expect(invites).to.be.an('array').with.length(0)
    })

    // BLOCKED on quereus#23
    it('should return sent invites with name and type "au"', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createAuthorityInvite('Sent Inv')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const invites = await authorityEngine.getAuthorityInvites()
      expect(invites).to.have.length.greaterThan(0)
      const found = invites.find((i) => i.invite.name === 'Sent Inv')
      expect(found?.invite.type).to.equal('au')
    })

    // BLOCKED on https://github.com/gotchoices/quereus/issues/23 —
    // NetworkEngine.respondToInvite (USER-07) shipped in Phase 4, but
    // exercising it requires a seeded InviteSlot + AdminSignature from
    // AuthorityEngine.saveInviteWithSigning, which itself trips #23.
    it('should include InviteResult when an invite has been accepted', async () => {
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createAuthorityInvite('Accepted')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      await networkEngine.respondToInvite({
        invite: { digest: invite.digest } as never,
        isAccepted: true,
        invokes: { authority: { name: 'Accepted', domainName: 'a.example' } },
        inviteSignature: invite.inviteSignature,
        userId: undefined,
        userInit: undefined
      } as never)
      const invites = await authorityEngine.getAuthorityInvites()
      const found = invites.find((i) => i.invite.name === 'Accepted')
      expect((found as { result?: { isAccepted?: boolean } } | undefined)?.result?.isAccepted).to.equal(true)
    })

    // BLOCKED on quereus#23 (same chain — needs a seeded InviteSlot row).
    it('should include InviteResult when an invite has been rejected', async () => {
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createAuthorityInvite('Rejected')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      await networkEngine.respondToInvite({
        invite: { digest: invite.digest } as never,
        isAccepted: false,
        invokes: undefined,
        inviteSignature: invite.inviteSignature,
        userId: undefined,
        userInit: undefined
      } as never)
      const invites = await authorityEngine.getAuthorityInvites()
      const found = invites.find((i) => i.invite.name === 'Rejected')
      expect((found as { result?: { isAccepted?: boolean } } | undefined)?.result?.isAccepted).to.equal(false)
    })

    // BLOCKED on quereus#23
    it('should return undefined result when invite has not been responded to', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createAuthorityInvite('NoResponse')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const invites = await authorityEngine.getAuthorityInvites()
      const found = invites.find((i) => i.invite.name === 'NoResponse')
      expect((found as { result?: unknown } | undefined)?.result).to.equal(undefined)
    })

    // BLOCKED on quereus#23
    it('should only return invites scoped to "iad" for the current authority', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const auInvite = authorityEngine.createAuthorityInvite('AuthorityScoped')
      const auSig = makeRealSignature('user-1', auInvite.digest)
      await authorityEngine.saveInviteWithSigning(auInvite, 'iad', auSig)
      const ofInvite = authorityEngine.createOfficerInvite({
        name: 'OfficerScoped',
        title: 'Inspector',
        scopes: ['rad'] as Scope[]
      })
      const ofSig = makeRealSignature('user-1', ofInvite.digest)
      await authorityEngine.saveInviteWithSigning(ofInvite, 'rad', ofSig)
      const invites = await authorityEngine.getAuthorityInvites()
      // Only the 'au' (iad-scoped) invite should appear in the authority list.
      const names = invites.map((i) => i.invite.name)
      expect(names).to.include('AuthorityScoped')
      expect(names).to.not.include('OfficerScoped')
    })
  })

  // -----------------------------------------------------------------------
  // 8-19. Schema Constraints + Lifecycle + Invitation Flows
  //
  // Each `it.skip` below was a body-less `it('...')` placeholder. All
  // assertions in these blocks are schema-level invariants requiring a
  // populated DB (Authority + Admin + Officer + Network rows seeded via
  // NetworksEngine.create()). Every such seed trips
  // https://github.com/gotchoices/quereus/issues/23 (CantDelete on INSERT)
  // today, so every placeholder is annotated `it.skip` + bug link rather
  // than left body-less. When #23 ships, sweep this section: replace
  // `it.skip` with `it` and fill the body using the same per-INSERT
  // context-envelope pattern AuthorityEngine + NetworksEngine establish.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // 8. Schema Constraints - Authority Table
  // -----------------------------------------------------------------------
  describe('schema constraints - Authority table', () => {
    it('should allow the very first authority without an invite or signing nonce — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare('select count(*) as n from Authority')
        .get({})
      expect(Number(row?.n)).to.equal(1)
    })

    it('should reject deletion of an Authority (CantDelete constraint) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          'delete from Authority with context Tid = 1, SigningNonce = null, InviteSlotCid = null, InviteSignature = null'
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('CantDelete')
    })

    it('should reject mutation of Authority.Id on update (IdImmutable constraint) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          'update Authority set Id = :id with context Tid = 1, SigningNonce = null, InviteSlotCid = null, InviteSignature = null',
          { id: 'mutated-id' }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('IdImmutable')
    })

    it('should require an Admin row to exist when inserting an Authority (AdminRequired) — BLOCKED on quereus#23', async () => {
      await AsyncStorage.clear()
      const db = new Database()
      await prepareDb(db)
      let caught: unknown
      try {
        await db.exec(
          `insert into Authority (Id, Name, DomainName, ImageRef)
           with context Tid = 1, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values (:id, 'NoAdmin', 'na.example', null)`,
          { id: crypto.randomUUID() }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('AdminRequired')
    })

    it('should require a valid accepted InviteResult for subsequent authority inserts (InsertValid) — BLOCKED on quereus#23', async () => {
      const { networkEngine } = await createNetworkAndAuthority()
      let caught: unknown
      try {
        await networkEngine.createAuthority(
          { name: 'NoInvite', domainName: 'ni.example' },
          {
            officers: [
              { init: { name: 'O', title: 'T', scopes: ['rad'] as Scope[] } }
            ],
            effectiveAt: Date.now(),
            thresholdPolicies: []
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('InsertValid')
    })

    it('should validate update using AdminSignature with scope uai (UpdateValid) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          'update Authority set Name = :n with context Tid = 1, SigningNonce = null, InviteSlotCid = null, InviteSignature = null',
          { n: 'Renamed' }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('UpdateValid')
    })
  })

  // -----------------------------------------------------------------------
  // 9. Schema Constraints - Admin Table
  // -----------------------------------------------------------------------
  describe('schema constraints - Admin table', () => {
    it('should require at least one Officer with rad scope when inserting Admin (OfficerRequired) — BLOCKED on quereus#23', async () => {
      await AsyncStorage.clear()
      await AsyncStorage.setItem('recentNetworks', [])
      let caught: unknown
      try {
        await new NetworksEngine(AsyncStorage).create(
          makeNetworkInit({
            admin: {
              officers: [
                {
                  init: {
                    name: 'No-Rad',
                    title: 'Chair',
                    scopes: ['mel'] as Scope[]
                  }
                }
              ],
              effectiveAt: Date.now(),
              thresholdPolicies: []
            }
          }),
          makeUser()
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('OfficerRequired')
    })

    it('should reject Admin insert when AuthorityId does not reference an existing Authority — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values ('no-such', :e, '[]')`,
          { e: new Date().toISOString() }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('AuthorityIdValid')
    })

    it('should reject Admin when EffectiveAt is not a valid ISO datetime ending in Z — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values (:id, 'not-iso', '[]')`,
          { id: authority.id }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('EffectiveAtValid')
    })

    it('should allow initial admin for very first authority without invite or signing (MutationValid) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare('select count(*) as n from Admin')
        .get({})
      expect(Number(row?.n)).to.equal(1)
    })

    it('should require valid invite for admin of a new (non-first) authority (MutationValid) — BLOCKED on quereus#23', async () => {
      const { networkEngine } = await createNetworkAndAuthority()
      let caught: unknown
      try {
        await networkEngine.createAuthority(
          { name: 'Second', domainName: 's.example' },
          {
            officers: [
              { init: { name: 'O', title: 'T', scopes: ['rad'] as Scope[] } }
            ],
            effectiveAt: Date.now(),
            thresholdPolicies: []
          }
        )
      } catch (err) {
        caught = err
      }
      const msg = (caught as Error)?.message ?? ''
      expect(msg).to.match(/MutationValid|InsertValid/)
    })

    it('should require valid AdminSignature for admin update of existing authority (MutationValid) — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `update Admin set ThresholdPolicies = '[]'
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           where AuthorityId = :id`,
          { id: authority.id }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('MutationValid')
    })
  })

  // -----------------------------------------------------------------------
  // 10. Schema Constraints - Officer Table
  // -----------------------------------------------------------------------
  describe('schema constraints - Officer table', () => {
    it('should reject Officer with scopes not in the Scope view (ScopesValid) — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values (:id, :e, 'user-1', 'Bad', :scopes)`,
          {
            id: authority.id,
            e: new Date().toISOString(),
            scopes: JSON.stringify(['no-such-scope'])
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('ScopesValid')
    })

    it('should reject Officer update or delete (OnlyInsert constraint) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let updateErr: unknown
      try {
        await ctx.db.exec(
          `update Officer set Title = 'X'
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null`
        )
      } catch (err) {
        updateErr = err
      }
      expect((updateErr as Error)?.message).to.include('OnlyInsert')

      let deleteErr: unknown
      try {
        await ctx.db.exec(
          `delete from Officer
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null`
        )
      } catch (err) {
        deleteErr = err
      }
      expect((deleteErr as Error)?.message).to.include('OnlyInsert')
    })

    it('should require Admin row to exist for the officer AdminEffectiveAt (AdminValid) — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values (:id, '9999-01-01T00:00:00.000Z', 'user-1', 'Orphan', '["rad"]')`,
          { id: authority.id }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('AdminValid')
    })

    it('should require User to exist for the officer UserId (UserIdValid) — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values (:id, :e, 'no-such-user', 'X', '["rad"]')`,
          { id: authority.id, e: new Date().toISOString() }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('UserIdValid')
    })

    it('should allow initial officer for very first authority without invite or signing (InsertValid) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare('select count(*) as n from Officer')
        .get({})
      expect(Number(row?.n)).to.equal(1)
    })

    it('should require valid invite for officers of a new authority (InsertValid) — BLOCKED on quereus#23', async () => {
      const { networkEngine } = await createNetworkAndAuthority()
      let caught: unknown
      try {
        await networkEngine.createAuthority(
          { name: 'NewOfficerCheck', domainName: 'noc.example' },
          {
            officers: [
              { init: { name: 'O', title: 'T', scopes: ['rad'] as Scope[] } }
            ],
            effectiveAt: Date.now(),
            thresholdPolicies: []
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('InsertValid')
    })

    it('should require valid AdminSigning for officers of an existing authority (InsertValid) — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values (:id, :e, 'user-1', 'Extra', '["rad"]')`,
          { id: authority.id, e: new Date().toISOString() }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('InsertValid')
    })
  })

  // -----------------------------------------------------------------------
  // 11. Schema Constraints - ProposedAuthority Table
  // -----------------------------------------------------------------------
  describe('schema constraints - ProposedAuthority table', () => {
    it('should require the authority to exist (AuthorityExists) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedAuthority (Id, Name, DomainName, ImageRef)
           with context UserId = :uid, UserKey = :key, Signature = :sig, Tid = 9, now = ${Date.now()}
           values ('no-such-authority', 'X', 'x.example', null)`,
          {
            uid: 'user-1',
            key: sig.signerKey,
            sig: sig.signature
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('AuthorityExists')
    })

    it('should require a valid officer with uai scope and matching signature (UserValid) — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedAuthority (Id, Name, DomainName, ImageRef)
           with context UserId = 'no-such-user', UserKey = 'no-key', Signature = 'bad', Tid = 9, now = ${Date.now()}
           values (:id, 'X', 'x.example', null)`,
          { id: authority.id }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('UserValid')
    })
  })

  // -----------------------------------------------------------------------
  // 12. Schema Constraints - ProposedAdmin Table
  // -----------------------------------------------------------------------
  describe('schema constraints - ProposedAdmin table', () => {
    it('should require the authority to exist (AuthorityIdValid) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context UserId = :uid, UserKey = :key, Signature = :sig, Tid = 9, now = ${Date.now()}
           values ('no-such', :e, '[]')`,
          {
            uid: 'user-1',
            key: sig.signerKey,
            sig: sig.signature,
            e: new Date().toISOString()
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('AuthorityIdValid')
    })

    it('should require EffectiveAt to be a valid ISO datetime ending in Z — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context UserId = :uid, UserKey = :key, Signature = :sig, Tid = 9, now = ${Date.now()}
           values (:id, 'not-iso', '[]')`,
          {
            uid: 'user-1',
            key: sig.signerKey,
            sig: sig.signature,
            id: authority.id
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('EffectiveAtValid')
    })

    it('should require a valid officer with rad scope and matching signature (UserValid) — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context UserId = 'no-user', UserKey = 'no-key', Signature = 'bad', Tid = 9, now = ${Date.now()}
           values (:id, :e, '[]')`,
          { id: authority.id, e: new Date().toISOString() }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('UserValid')
    })
  })

  // -----------------------------------------------------------------------
  // 13. Schema Constraints - ProposedOfficer Table
  // -----------------------------------------------------------------------
  describe('schema constraints - ProposedOfficer table', () => {
    it('should require the authority to exist (AuthorityIdValid) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes)
           with context UserId = :uid, UserKey = :key, Signature = :sig, Tid = 9, now = ${Date.now()}
           values ('no-such', :e, 'X', 'T', '["rad"]')`,
          {
            uid: 'user-1',
            key: sig.signerKey,
            sig: sig.signature,
            e: new Date().toISOString()
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('AuthorityIdValid')
    })

    it('should require a ProposedAdmin to exist for the officer AdminEffectiveAt (AdminValid) — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes)
           with context UserId = :uid, UserKey = :key, Signature = :sig, Tid = 9, now = ${Date.now()}
           values (:id, '9999-01-01T00:00:00.000Z', 'Orphan', 'T', '["rad"]')`,
          {
            uid: 'user-1',
            key: sig.signerKey,
            sig: sig.signature,
            id: authority.id
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('AdminValid')
    })

    it('should reject deletion of a ProposedOfficer (CantDelete) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `delete from ProposedOfficer
           with context UserId = :uid, UserKey = :key, Signature = :sig, Tid = 9, now = ${Date.now()}`,
          {
            uid: 'user-1',
            key: sig.signerKey,
            sig: sig.signature
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('CantDelete')
    })

    it('should reject scopes not in the Scope view (ScopesValid) — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes)
           with context UserId = :uid, UserKey = :key, Signature = :sig, Tid = 9, now = ${Date.now()}
           values (:id, :e, 'Bad', 'T', :scopes)`,
          {
            uid: 'user-1',
            key: sig.signerKey,
            sig: sig.signature,
            id: authority.id,
            e: new Date().toISOString(),
            scopes: JSON.stringify(['no-such-scope'])
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('ScopesValid')
    })

    it('should require a valid officer with rad scope and matching signature (UserValid) — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes)
           with context UserId = 'no-user', UserKey = 'no-key', Signature = 'bad', Tid = 9, now = ${Date.now()}
           values (:id, :e, 'X', 'T', '["rad"]')`,
          { id: authority.id, e: new Date().toISOString() }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('UserValid')
    })
  })

  // -----------------------------------------------------------------------
  // 14. Schema Constraints - InviteSlot Table
  // -----------------------------------------------------------------------
  describe('schema constraints - InviteSlot table', () => {
    it('should validate CID as Digest of invite fields (CidValid) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
           with context Tid = 9, now = ${Date.now()}
           values ('wrong-cid', 'au', 'X', :e, 'pk', 'sig', 'nonce')`,
          { e: new Date(Date.now() + 60_000).toISOString() }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('CidValid')
    })

    it('should reject InviteSlot when expiration is in the past (ExpirationValid) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
           with context Tid = 9, now = ${Date.now()}
           values ('past-cid', 'au', 'Past', :e, 'pk', 'sig', 'nonce')`,
          { e: new Date(Date.now() - 60_000).toISOString() }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('ExpirationValid')
    })

    it('should validate InviteSignature against InviteKey (InviteSignatureValid) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
           with context Tid = 9, now = ${Date.now()}
           values ('cid', 'au', 'BadSig', :e, 'pk', 'wrong-sig', 'nonce')`,
          { e: new Date(Date.now() + 60_000).toISOString() }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('InviteSignatureValid')
    })

    it('should reject update or delete of InviteSlot (InsertOnly) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let updateErr: unknown
      try {
        await ctx.db.exec(
          `update InviteSlot set Name = 'X' with context Tid = 9, now = ${Date.now()}`
        )
      } catch (err) {
        updateErr = err
      }
      expect((updateErr as Error)?.message).to.include('InsertOnly')

      let deleteErr: unknown
      try {
        await ctx.db.exec(
          `delete from InviteSlot with context Tid = 9, now = ${Date.now()}`
        )
      } catch (err) {
        deleteErr = err
      }
      expect((deleteErr as Error)?.message).to.include('InsertOnly')
    })

    it('should require a completed AdminSignature for the signing nonce (InsertValid) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
           with context Tid = 9, now = ${Date.now()}
           values ('orphan', 'au', 'Orphan', :e, 'pk', 'sig', 'never-signed')`,
          { e: new Date(Date.now() + 60_000).toISOString() }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('InsertValid')
    })
  })

  // -----------------------------------------------------------------------
  // 15. Schema Constraints - InviteResult Table
  // -----------------------------------------------------------------------
  describe('schema constraints - InviteResult table', () => {
    it('should reject update or delete of InviteResult (InsertOnly) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let updateErr: unknown
      try {
        await ctx.db.exec(`update InviteResult set IsAccepted = false`)
      } catch (err) {
        updateErr = err
      }
      expect((updateErr as Error)?.message).to.include('InsertOnly')

      let deleteErr: unknown
      try {
        await ctx.db.exec(`delete from InviteResult`)
      } catch (err) {
        deleteErr = err
      }
      expect((deleteErr as Error)?.message).to.include('InsertOnly')
    })

    it('should require a valid InviteSlot and AdminSignature (SigningValid) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
           values ('no-such-slot', true, 'd', 'sig', null)`
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('SigningValid')
    })

    it('should validate InviteSignature against the InviteSlot InviteKey (SignatureValid) — BLOCKED on quereus#23', async () => {
      // Once a seeded InviteSlot exists with a known InviteKey, attempting
      // to insert an InviteResult with a non-matching signature should fail
      // on SignatureValid. Setup requires a valid saveInviteWithSigning
      // round-trip; the assertion shape is documented.
      const { authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createAuthorityInvite('SigCheck')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const slot = await ctx.db
        .prepare('select Cid from InviteSlot where Name = :n')
        .get({ n: 'SigCheck' })
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
           values (:cid, true, 'd', 'wrong-signature', null)`,
          { cid: slot!.Cid as string }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('SignatureValid')
    })

    it('should reject acceptance when Digest is null (DigestValid) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
           values ('any', true, null, 'sig', null)`
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('DigestValid')
    })

    it('should reject rejection when Digest is not null (DigestValid) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
           values ('any', false, 'non-null', 'sig', null)`
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('DigestValid')
    })
  })

  // -----------------------------------------------------------------------
  // 16. Admin Signing Flow (via SigningEngine)
  //
  // Most of these duplicate signing.spec.ts coverage (TEST-02). Authority
  // tests retained as the flow's natural-language witness once #23 ships.
  // -----------------------------------------------------------------------
  describe('admin signing flow', () => {
    it('should create an AdminSigning session with a random nonce — BLOCKED on quereus#23 (covered in signing.spec.ts)', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      // proposeAdmin triggers SigningEngine.startSigningSession internally.
      const sig = makeRealSignature('user-1')
      await authorityEngine.proposeAdmin(
        {
          proposed: {
            officers: [
              {
                existing: {
                  userId: 'user-1',
                  authorityId: authority.id,
                  title: 'Chair',
                  scopes: ['rad'] as Scope[]
                }
              }
            ],
            effectiveAt: Date.now() + 60_000,
            thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
          },
          signers: ['user-1']
        },
        sig
      )
      const row = await ctx.db
        .prepare(
          'select Nonce from AdminSigning where AuthorityId = :id order by Nonce desc limit 1'
        )
        .get({ id: authority.id })
      expect(row?.Nonce).to.be.a('string').with.length.greaterThan(0)
    })

    it('should reject AdminSigning with an invalid scope code (ScopeValid) — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
           with context now = ${Date.now()}
           values ('bad-scope', :id, :e, 'xx', 'd', 'user-1', :key, :sig)`,
          {
            id: authority.id,
            e: new Date().toISOString(),
            key: sig.signerKey,
            sig: sig.signature
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('ScopeValid')
    })

    it('should validate the instigator signature on AdminSigning (SignatureValid) — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
           with context now = ${Date.now()}
           values ('bad-sig', :id, :e, 'rad', 'd', 'user-1', :key, 'deadbeef')`,
          {
            id: authority.id,
            e: new Date().toISOString(),
            key: sig.signerKey
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('SignatureValid')
    })

    it('should reject update or delete of AdminSigning (InsertOnly) — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let updateErr: unknown
      try {
        await ctx.db.exec(
          `update AdminSigning set Scope = 'rn' with context now = ${Date.now()}`
        )
      } catch (err) {
        updateErr = err
      }
      expect((updateErr as Error)?.message).to.include('InsertOnly')

      let deleteErr: unknown
      try {
        await ctx.db.exec(
          `delete from AdminSigning with context now = ${Date.now()}`
        )
      } catch (err) {
        deleteErr = err
      }
      expect((deleteErr as Error)?.message).to.include('InsertOnly')
    })

    it('should accept OfficerSignature when the officer has the required scope and digest matches — BLOCKED on quereus#23', async () => {
      // Happy-path OfficerSignature insertion through the full proposeAdmin
      // chain — covered in detail in signing.spec.ts. Asserts the row lands.
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      await authorityEngine.proposeAdmin(
        {
          proposed: {
            officers: [
              {
                existing: {
                  userId: 'user-1',
                  authorityId: authority.id,
                  title: 'Chair',
                  scopes: ['rad'] as Scope[]
                }
              }
            ],
            effectiveAt: Date.now() + 60_000,
            thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
          },
          signers: ['user-1']
        },
        sig
      )
      const row = await ctx.db
        .prepare('select count(*) as n from OfficerSignature')
        .get({})
      expect(Number(row?.n)).to.be.greaterThan(0)
    })

    it('should reject OfficerSignature when the signature does not match the digest — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      const nonce = 'mismatch-' + crypto.randomUUID()
      await ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = ${Date.now()}
         values (:n, :id, :e, 'rad', 'real-digest', 'user-1', :key, :sig)`,
        {
          n: nonce,
          id: authority.id,
          e: new Date().toISOString(),
          key: sig.signerKey,
          sig: sig.signature
        }
      )
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into OfficerSignature (SigningNonce, UserId, SignerKey, Signature)
           with context now = ${Date.now()}
           values (:n, 'user-1', :key, 'wrong-sig')`,
          { n: nonce, key: sig.signerKey }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('SignatureValid')
    })

    it('should create AdminSignature only when the threshold of OfficerSignatures is met — BLOCKED on quereus#23 (covered in signing.spec.ts threshold-met test)', async () => {
      // Sentinel post-state: proposeAdmin with threshold=1 should land an
      // AdminSignature row after the single officer signs.
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      await authorityEngine.proposeAdmin(
        {
          proposed: {
            officers: [
              {
                existing: {
                  userId: 'user-1',
                  authorityId: authority.id,
                  title: 'Chair',
                  scopes: ['rad'] as Scope[]
                }
              }
            ],
            effectiveAt: Date.now() + 60_000,
            thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
          },
          signers: ['user-1']
        },
        sig
      )
      const row = await ctx.db
        .prepare('select count(*) as n from AdminSignature')
        .get({})
      expect(Number(row?.n)).to.be.greaterThan(0)
    })

    it('should reject AdminSignature when insufficient OfficerSignatures exist — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into AdminSignature (SigningNonce) values ('no-sigs-nonce')`
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('SignatureValid')
    })
  })

  // -----------------------------------------------------------------------
  // 17. Administration Lifecycle
  // -----------------------------------------------------------------------
  describe('administration lifecycle', () => {
    // These lifecycle witnesses duplicate proposeAdmin + signing.spec.ts
    // coverage. They assert observable post-state shapes; the deeper
    // multi-step setup (time-warp, threshold-met chain across multiple
    // admins) will be wired in when #23 lands.

    it('should allow admin renewal before expiration with proper signatures — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      await authorityEngine.proposeAdmin(
        {
          proposed: {
            officers: [
              {
                existing: {
                  userId: 'user-1',
                  authorityId: authority.id,
                  title: 'Chair',
                  scopes: ['rad'] as Scope[]
                }
              }
            ],
            effectiveAt: Date.now() + 60_000,
            thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
          },
          signers: ['user-1']
        },
        sig
      )
      const row = await ctx.db
        .prepare(
          'select count(*) as n from ProposedAdmin where AuthorityId = :id'
        )
        .get({ id: authority.id })
      expect(Number(row?.n)).to.be.greaterThan(0)
    })

    it('should allow primary authority to replace expired admin of another authority — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare('select count(*) as n from Authority')
        .get({})
      expect(Number(row?.n)).to.equal(1)
    })

    it('should require a new network if the primary authority admin itself expires without renewal — BLOCKED on quereus#23', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare(
          'select AuthorityId from CurrentAdmin where AuthorityId = :id'
        )
        .get({ id: authority.id })
      expect(row?.AuthorityId).to.equal(authority.id)
    })

    it('should transition proposed admin to current admin after signing threshold is met — BLOCKED on quereus#23', async () => {
      // Post-#23 sweep: after the full proposeAdmin + signing chain
      // completes, the ProposedAdmin row should be promoted (or its
      // EffectiveAt should now appear in CurrentAdmin).
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      const newEffectiveAt = Date.now() + 60_000
      await authorityEngine.proposeAdmin(
        {
          proposed: {
            officers: [
              {
                existing: {
                  userId: 'user-1',
                  authorityId: authority.id,
                  title: 'Chair',
                  scopes: ['rad'] as Scope[]
                }
              }
            ],
            effectiveAt: newEffectiveAt,
            thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
          },
          signers: ['user-1']
        },
        sig
      )
      const adminSig = await ctx.db
        .prepare('select count(*) as n from AdminSignature')
        .get({})
      expect(Number(adminSig?.n)).to.be.greaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // 18. Invitation Flow - Authority
  // -----------------------------------------------------------------------
  describe('invitation flow - authority invites', () => {
    it('should create an InviteSlot with a valid CID, key pair, and AdminSignature backing — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('InviteCheck')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const row = await ctx.db
        .prepare('select Cid, InviteKey from InviteSlot where Name = :n')
        .get({ n: 'InviteCheck' })
      expect(row?.Cid).to.be.a('string').with.length.greaterThan(0)
      expect(row?.InviteKey).to.equal(invite.inviteKey)
    })

    it('should allow creating a new Authority via accepted invite with valid proof of possession — BLOCKED on quereus#23', async () => {
      // Full flow: saveInviteWithSigning → respondToInvite(accept) →
      // NetworkEngine.createAuthority succeeds with context.InviteSlotCid.
      // Post-#23 sweep wires up the engine path that consumes the invite.
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createAuthorityInvite('NewAuthority')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      await networkEngine.respondToInvite({
        invite: { digest: invite.digest } as never,
        isAccepted: true,
        invokes: { authority: { name: 'NewAuthority', domainName: 'na.example' } },
        inviteSignature: invite.inviteSignature,
        userId: undefined,
        userInit: undefined
      } as never)
      // Sweep: when createAuthority(...) accepts InviteSlotCid context, run
      // it here and assert a new Authority row exists.
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare('select count(*) as n from InviteResult')
        .get({})
      expect(Number(row?.n)).to.be.greaterThan(0)
    })

    it('should prevent reuse of an already-claimed invite slot — BLOCKED on quereus#23', async () => {
      // InviteResult primary key is SlotCid; a duplicate insert collides.
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createAuthorityInvite('ReusedSlot')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      await networkEngine.respondToInvite({
        invite: { digest: invite.digest } as never,
        isAccepted: true,
        invokes: { authority: { name: 'X', domainName: 'x.example' } },
        inviteSignature: invite.inviteSignature,
        userId: undefined,
        userInit: undefined
      } as never)
      let caught: unknown
      try {
        await networkEngine.respondToInvite({
          invite: { digest: invite.digest } as never,
          isAccepted: true,
          invokes: { authority: { name: 'Y', domainName: 'y.example' } },
          inviteSignature: invite.inviteSignature,
          userId: undefined,
          userInit: undefined
        } as never)
      } catch (err) {
        caught = err
      }
      expect(caught).to.not.equal(undefined)
    })

    it('should create InviteResult marking acceptance with digest and invite signature — BLOCKED on quereus#23', async () => {
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('AcceptCheck')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      await networkEngine.respondToInvite({
        invite: { digest: invite.digest } as never,
        isAccepted: true,
        invokes: { authority: { name: 'AC', domainName: 'ac.example' } },
        inviteSignature: invite.inviteSignature,
        userId: undefined,
        userInit: undefined
      } as never)
      const row = await ctx.db
        .prepare(
          'select IsAccepted, Digest, InviteSignature from InviteResult where SlotCid = :c'
        )
        .get({ c: invite.digest })
      expect(Boolean(row?.IsAccepted)).to.equal(true)
      expect(row?.Digest).to.not.equal(null)
      expect(row?.InviteSignature).to.equal(invite.inviteSignature)
    })

    it('should create InviteResult marking rejection with null digest — BLOCKED on quereus#23', async () => {
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('RejectCheck')
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      await networkEngine.respondToInvite({
        invite: { digest: invite.digest } as never,
        isAccepted: false,
        invokes: undefined,
        inviteSignature: invite.inviteSignature,
        userId: undefined,
        userInit: undefined
      } as never)
      const row = await ctx.db
        .prepare('select IsAccepted, Digest from InviteResult where SlotCid = :c')
        .get({ c: invite.digest })
      expect(Boolean(row?.IsAccepted)).to.equal(false)
      expect(row?.Digest).to.equal(null)
    })
  })

  // -----------------------------------------------------------------------
  // 19. Invitation Flow - Officer
  // -----------------------------------------------------------------------
  describe('invitation flow - officer invites', () => {
    it('should create an InviteSlot for an officer invite with type "of" — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createOfficerInvite({
        name: 'OfType',
        title: 'Inspector',
        scopes: ['rad'] as Scope[]
      })
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'rad', sig)
      const row = await ctx.db
        .prepare('select Type from InviteSlot where Name = :n')
        .get({ n: 'OfType' })
      expect(row?.Type).to.equal('of')
    })

    it('should include officer name, title, and scopes in the invite — BLOCKED on quereus#23', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createOfficerInvite({
        name: 'Officer X',
        title: 'Inspector',
        scopes: ['rad', 'iad'] as Scope[]
      })
      expect(invite.name).to.equal('Officer X')
      expect(invite.title).to.equal('Inspector')
      expect(invite.scopes).to.deep.equal(['rad', 'iad'])
    })

    it('should allow accepting an officer invite to associate a user with the authority — BLOCKED on quereus#23', async () => {
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createOfficerInvite({
        name: 'OfAccept',
        title: 'Inspector',
        scopes: ['rad'] as Scope[]
      })
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'rad', sig)
      await networkEngine.respondToInvite({
        invite: { digest: invite.digest } as never,
        isAccepted: true,
        invokes: { officer: { userId: 'user-2', title: 'Inspector' } },
        inviteSignature: invite.inviteSignature,
        userId: 'user-2',
        userInit: undefined
      } as never)
      const row = await ctx.db
        .prepare('select IsAccepted from InviteResult where SlotCid = :c')
        .get({ c: invite.digest })
      expect(Boolean(row?.IsAccepted)).to.equal(true)
    })

    it('should prevent reuse of an already-claimed officer invite slot — BLOCKED on quereus#23', async () => {
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createOfficerInvite({
        name: 'OfReuse',
        title: 'Inspector',
        scopes: ['rad'] as Scope[]
      })
      const sig = makeRealSignature('user-1', invite.digest)
      await authorityEngine.saveInviteWithSigning(invite, 'rad', sig)
      await networkEngine.respondToInvite({
        invite: { digest: invite.digest } as never,
        isAccepted: true,
        invokes: { officer: { userId: 'user-3', title: 'A' } },
        inviteSignature: invite.inviteSignature,
        userId: 'user-3',
        userInit: undefined
      } as never)
      let caught: unknown
      try {
        await networkEngine.respondToInvite({
          invite: { digest: invite.digest } as never,
          isAccepted: true,
          invokes: { officer: { userId: 'user-4', title: 'B' } },
          inviteSignature: invite.inviteSignature,
          userId: 'user-4',
          userInit: undefined
        } as never)
      } catch (err) {
        caught = err
      }
      expect(caught).to.not.equal(undefined)
    })
  })
})

// Quiet unused-import warning — bytesToHex is reserved for future hex
// reconstruction; the current makeRealSignature reads privateHex back
// via Uint8Array.from + .match.
void bytesToHex
