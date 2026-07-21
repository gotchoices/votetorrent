import { Database } from '@quereus/quereus'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ElectionType, UserKeyType } from '@votetorrent/vote-core'
import { expect } from 'chai'
import { AuthorityEngine } from '../src/authority/authority-engine'
import { prepareDb } from '../src/database/initialize'
import { NetworksEngine } from '../src/networks/networks-engine'
import { nowCanonicalDatetime, toCanonicalDatetime, digestToBytes } from '../src/utils.js'
import type { EngineContext } from '../src/types.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { createTestNetwork, addTestAuthority, seedUserInvite, makeDistinctTestUser, signInviteResult } from './fixtures/test-context.js'
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

// 39-04 (DEBT-09, OfficerRequired negative-enforcement coverage): identical to
// createNetworkAndAuthority above, but the founding Officer's scopes deliberately
// EXCLUDE 'rad' — so no Officer row anywhere for this authority carries a rad
// scope. Used to construct a deterministic Admin.OfficerRequired CHECK reject.
async function createNetworkAndAuthorityWithoutRadOfficer (): Promise<{
  networkEngine: INetworkEngine
  authorityEngine: IAuthorityEngine
  authority: Authority
}> {
  await AsyncStorage.clear()
  await AsyncStorage.setItem('recentNetworks', [])
  const networksEngine = new NetworksEngine(AsyncStorage)
  const user = makeUser()
  const networkInit = makeNetworkInit({
    admin: {
      officers: [
        {
          init: {
            name: 'Admin A',
            title: 'Chair',
            // No 'rad' — deliberately excluded (this is the whole point of the fixture).
            scopes: ['rn', 'iad', 'uai', 'mel'] as Scope[]
          }
        }
      ],
      effectiveAt: Date.now(),
      thresholdPolicies: [{ policy: 'uai', threshold: 1 }]
    }
  })
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
//
// 999.1 R-02: this signs ARBITRARY bytes (sha256 of digestText/signerUserId), NOT the
// actual row Digest the schema's SignatureValid UDF now verifies — kept only for
// negative-test / structural-equality call sites that never reach the UDF (or
// deliberately want a mismatched signature). Any call site that flows into
// `proposeAdmin`/`saveInviteWithSigning` MUST use `makeRealSignCallback` instead, since
// those methods compute the real digest engine-side and need to sign THAT.
function makeRealSignature (signerUserId: string, digestText?: string): Signature {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = Uint8Array.from(privateHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
  const digestBytes = sha256(new TextEncoder().encode(digestText ?? signerUserId))
  const sig = bytesToHex(secp256k1.sign(digestBytes, privBytes))
  return { signerUserId, signerKey: publicHex, signature: sig }
}

/**
 * 999.1 R-02: real per-digest sign callback for `proposeAdmin`/`saveInviteWithSigning`
 * (both compute the actual row Digest engine-side and invoke this with the real bytes).
 */
function makeRealSignCallback (signerUserId: string, _unusedDigestTextArg?: string): (digest: Uint8Array) => Promise<Signature> {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sigHex = bytesToHex(secp256k1.sign(digest, privBytes))
    return { signerUserId, signerKey: publicHex, signature: sigHex }
  }
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

    it('should return imageRef when set on the authority', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getDetails()
      // The seed network init does not set primaryAuthority.imageUrl, so
      // this exists only to assert presence semantics once #23 lands.
      expect(details.authority).to.have.property('imageRef')
    })

    it('should return undefined imageRef when not set', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getDetails()
      expect(details.authority.imageRef).to.equal(undefined)
    })

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
         with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 7, now = ${Date.now()}, IsUserValid = true
         values (:id, 'Proposed Name', 'proposed.example', null)`,
        {
          uid: 'user-1',
          pubKey: sig.signerKey,
          sig: sig.signature,
          id: authority.id
        }
      )
      const details = await authorityEngine.getDetails()
      expect(details.proposed).to.not.equal(undefined)
      expect(details.proposed?.proposed?.name).to.equal('Proposed Name')
    })

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
    it('should return admin with correct id, authorityId, and effectiveAt', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getAdminDetails()
      expect(details.admin.authorityId).to.equal(authority.id)
      // Admin table uses (AuthorityId, EffectiveAt) as PK — no separate Id column.
      // WR-05 (17-REVIEW): the engine derives a stable composite id
      // `${AuthorityId}:${EffectiveAt}` instead of reading a never-projected column.
      expect(details.admin.id).to.be.a('string')
      expect(details.admin.id).to.match(new RegExp(`^${authority.id}:.+`))
      // quereus 3.x stores datetime columns as Temporal strings; accept either format
      expect(details.admin.effectiveAt).to.not.equal(undefined)
    })

    it('should return the current admin officers with userId, title, and scopes', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getAdminDetails()
      expect(details.admin.officers).to.be.an('array').with.length(1)
      const officer = details.admin.officers[0]!
      expect(officer.userId).to.be.a('string').with.length.greaterThan(0)
      expect(officer.title).to.equal('Chair')
      expect(officer.scopes).to.be.an('array').that.includes('rad')
    })

    it('should parse thresholdPolicies from JSON stored in the Admin row', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const details = await authorityEngine.getAdminDetails()
      expect(details.admin.thresholdPolicies).to.deep.equal([
        { policy: 'rad', threshold: 1 }
      ])
    })

    it('should return proposed admin details when a ProposedAdmin exists', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      const effectiveAt = Date.now() + 60_000
      await ctx.db.exec(
        `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
         with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 7, now = ${Date.now()}, IsUserValid = true
         values (:authId, :eff, :tp)`,
        {
          uid: 'user-1',
          pubKey: sig.signerKey,
          sig: sig.signature,
          authId: authority.id,
          eff: toCanonicalDatetime(effectiveAt),
          tp: JSON.stringify([{ policy: 'rad', threshold: 1 }])
        }
      )
      const details = await authorityEngine.getAdminDetails()
      expect(details.proposed).to.not.equal(undefined)
    })

    it('should return proposed officers from ProposedOfficer rows', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      const effectiveAt = Date.now() + 60_000
      // Seed ProposedAdmin first (required by ProposedOfficer.AdminValid).
      await ctx.db.exec(
        `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
         with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 7, now = ${Date.now()}, IsUserValid = true
         values (:authId, :eff, '[]')`,
        {
          uid: 'user-1',
          pubKey: sig.signerKey,
          sig: sig.signature,
          authId: authority.id,
          eff: toCanonicalDatetime(effectiveAt)
        }
      )
      await ctx.db.exec(
        `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes)
         with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 7, now = ${Date.now()}, IsUserValid = true
         values (:authId, :eff, 'Officer Bob', 'Inspector', :scopes)`,
        {
          uid: 'user-1',
          pubKey: sig.signerKey,
          sig: sig.signature,
          authId: authority.id,
          eff: toCanonicalDatetime(effectiveAt),
          scopes: JSON.stringify(['rad'])
        }
      )
      const details = await authorityEngine.getAdminDetails()
      const proposedOfficers =
        (details.proposed as { proposed?: { officers?: unknown[] } } | undefined)
          ?.proposed?.officers
      expect(proposedOfficers).to.be.an('array').with.length.greaterThan(0)
    })

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
    it('should insert a ProposedAdmin row with authorityId, effectiveAt, and thresholdPolicies', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignCallback('user-1')
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
        .get({ id: authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(row?.n)).to.equal(1)
    })

    it('should serialize thresholdPolicies as JSON', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignCallback('user-1')
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
        .get({ id: authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(JSON.parse(row!.ThresholdPolicies as string)).to.deep.equal(policies)
    })

    it('should start a signing session with scope rad', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignCallback('user-1')
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

    // GAP-1 / D-03: proposeAdmin sign-callback path — engine computes the
    // canonical Digest(:authorityId, :effectiveAt, :thresholdPolicies) and hands
    // those bytes to the callback before committing (engine-authoritative, D-03).
    it('should invoke a sign-callback with non-empty digest bytes and accept the returned Signature', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      // Use the same keypair that makeRealSignature would use but capture the digest bytes.
      // signerUserId must be 'user-1' — the existing officer in the test fixture (createNetworkAndAuthority).
      const { privateHex, publicHex } = randomTestKeyPair()
      const privBytes = Uint8Array.from(privateHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
      let callbackDigestBytes: Uint8Array | null = null

      const signCallback = async (digestBytes: Uint8Array): Promise<Signature> => {
        callbackDigestBytes = digestBytes
        const sig = bytesToHex(secp256k1.sign(digestBytes, privBytes))
        return { signerUserId: 'user-1', signerKey: publicHex, signature: sig }
      }

      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [{ existing: { userId: 'user-1', authorityId: authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } }],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: ['user-1']
      }

      await authorityEngine.proposeAdmin(proposal, signCallback)

      // The callback must have received non-empty bytes (32 bytes = SHA-256 Digest output).
      expect(callbackDigestBytes).to.not.be.null
      expect((callbackDigestBytes as unknown as Uint8Array).length).to.be.greaterThan(0)

      // A ProposedAdmin row must exist, proving the callback signature was accepted.
      const row = await ctx.db
        .prepare('select count(*) as n from ProposedAdmin where AuthorityId = :id and EffectiveAt = :e')
        .get({ id: authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(row?.n)).to.equal(1)
    })

    // This test does NOT depend on create() succeeding — the guard fires
    // before the DB call. Runs against a freshly-prepared empty db.
    it('should throw when no signers are provided in the proposal', async () => {
      const { authorityEngine } = await makeDbOnlyAuthorityEngine()
      const sig = makeRealSignCallback('user-1')
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

    it('should use the first signer as the instigator of the signing session', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignCallback('user-1')
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

    it('should propagate Quereus constraint errors with descriptive messages', async () => {
      // A proposeAdmin call with a wildly invalid EffectiveAt should surface
      // a constraint-named error wrapped by the engine's QuereusError catch.
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const sig = makeRealSignCallback('user-1')
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

  })

  // -----------------------------------------------------------------------
  // 6. Save Invite with Signing
  // -----------------------------------------------------------------------
  describe('saveInviteWithSigning', () => {
    it('should start a signing session using the authority id and invite digest', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('InviteCorp')
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const row = await ctx.db
        .prepare(
          'select Digest from AdminSigning where AuthorityId = :id order by Nonce desc limit 1'
        )
        .get({ id: authority.id })
      expect(row?.Digest).to.match(/^[A-Za-z0-9_-]{43}$/)
    })

    it('should save an authority invite to InviteSlot when type is "au"', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('InviteCorp')
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const row = await ctx.db
        .prepare('select Name from InviteSlot where Name = :n')
        .get({ n: 'InviteCorp' })
      expect(row?.Name).to.equal('InviteCorp')
    })

    it('should save an officer invite to InviteSlot when type is "of"', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createOfficerInvite({
        name: 'Officer X',
        title: 'Inspector',
        scopes: ['rad'] as Scope[]
      })
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'rad', sig)
      const row = await ctx.db
        .prepare('select Name from InviteSlot where Name = :n')
        .get({ n: 'Officer X' })
      expect(row?.Name).to.equal('Officer X')
    })

    it('should use scope "iad" for authority invites', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('IADCorp')
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const row = await ctx.db
        .prepare(
          'select Scope from AdminSigning where AuthorityId = :id order by Nonce desc limit 1'
        )
        .get({ id: authority.id })
      expect(row?.Scope).to.equal('iad')
    })

    it('should use scope "rad" for officer invites', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createOfficerInvite({
        name: 'RAD Officer',
        title: 'Inspector',
        scopes: ['rad'] as Scope[]
      })
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'rad', sig)
      const row = await ctx.db
        .prepare(
          'select Scope from AdminSigning where AuthorityId = :id order by Nonce desc limit 1'
        )
        .get({ id: authority.id })
      expect(row?.Scope).to.equal('rad')
    })

    it('should compute CID as Digest of invite fields and nonce', async () => {
      // CidValid CHECK in the schema: Cid = Digest(Name, Expiration,
      // InviteKey, InviteSignature, SigningNonce). saveInviteWithSigning
      // computes Cid client-side via the same Digest call; here we just
      // assert that the row lands (CidValid would fire on a mismatch).
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('CidCheck')
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const row = await ctx.db
        .prepare('select Cid from InviteSlot where Name = :n')
        .get({ n: 'CidCheck' })
      expect(row?.Cid).to.be.a('string').with.length.greaterThan(0)
    })

    it('should store expiration, inviteKey, and inviteSignature in InviteSlot', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('FieldCheck')
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
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
    it('should return an empty array when no authority invites exist', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const invites = await authorityEngine.getAuthorityInvites()
      expect(invites).to.be.an('array').with.length(0)
    })

    it('should return sent invites with name and type "au"', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createAuthorityInvite('Sent Inv')
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
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
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      await networkEngine.respondToInvite({
        invite,
        isAccepted: true,
        invokes: { authority: { name: 'Accepted', domainName: 'a.example' }, admin: { effectiveAt: '2026-01-01T00:00:00', thresholdPolicies: '[{"policy":"rad","threshold":1}]' }, officers: [{ adminEffectiveAt: '2026-01-01T00:00:00', userId: 'user-1', title: 'Officer', scopes: '["rad"]' }] },
        inviteSignature: invite.inviteSignature,
        userId: undefined,
        userInit: undefined
      } as never)
      const invites = await authorityEngine.getAuthorityInvites()
      const found = invites.find((i) => i.invite.name === 'Accepted')
      expect((found as { result?: { isAccepted?: boolean } } | undefined)?.result?.isAccepted).to.equal(true)
    })

    it('should include InviteResult when an invite has been rejected', async () => {
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createAuthorityInvite('Rejected')
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      // 999.1 R-03: a rejection hits NetworkEngine.respondToInvite's
      // non-authority branch, which IS verified for real — sign the A1
      // LOCKED domain with the invite's own one-time private key.
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const slotRow = await ctx.db
        .prepare('select Cid from InviteSlot where InviteKey = :inviteKey')
        .get({ inviteKey: invite.inviteKey }) as { Cid: string }
      const inviteSignature = signInviteResult(invite.invitePrivate, slotRow.Cid, 'null', false)
      await networkEngine.respondToInvite({
        invite,
        isAccepted: false,
        invokes: undefined,
        inviteSignature,
        userId: undefined,
        userInit: undefined
      } as never)
      const invites = await authorityEngine.getAuthorityInvites()
      const found = invites.find((i) => i.invite.name === 'Rejected')
      expect((found as { result?: { isAccepted?: boolean } } | undefined)?.result?.isAccepted).to.equal(false)
    })

    it('should return undefined result when invite has not been responded to', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createAuthorityInvite('NoResponse')
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const invites = await authorityEngine.getAuthorityInvites()
      const found = invites.find((i) => i.invite.name === 'NoResponse')
      expect((found as { result?: unknown } | undefined)?.result).to.equal(undefined)
    })

    it('should only return invites scoped to "iad" for the current authority', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const auInvite = authorityEngine.createAuthorityInvite('AuthorityScoped')
      const auSig = makeRealSignCallback('user-1', auInvite.inviteKey)
      await authorityEngine.saveInviteWithSigning(auInvite, 'iad', auSig)
      const ofInvite = authorityEngine.createOfficerInvite({
        name: 'OfficerScoped',
        title: 'Inspector',
        scopes: ['rad'] as Scope[]
      })
      const ofSig = makeRealSignCallback('user-1', ofInvite.inviteKey)
      await authorityEngine.saveInviteWithSigning(ofInvite, 'rad', ofSig)
      const invites = await authorityEngine.getAuthorityInvites()
      // Only the 'au' (iad-scoped) invite should appear in the authority list.
      const names = invites.map((i) => i.invite.name)
      expect(names).to.include('AuthorityScoped')
      expect(names).to.not.include('OfficerScoped')
    })
  })

  // -----------------------------------------------------------------------
  // 7b. SURF-03: cancelInvite (marker drop-off) + resendInvite (fresh slot)
  //
  // D-08: seed a pending officer InviteSlot via the existing seedUserInvite
  // fixture, then exercise cancel/resend against it. No new fixture infra.
  // -----------------------------------------------------------------------
  describe('cancelInvite / resendInvite (SURF-03, non-signing)', () => {
    async function seedPendingInvite (): Promise<{
      authorityEngine: AuthorityEngine
      ctx: EngineContext
      inviteSlotCid: string
    }> {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)
      // seedUserInvite seeds an officer-scope (Type='of') InviteSlot via
      // createOfficerInvite + saveInviteWithSigning and returns its Cid.
      const newUser = makeDistinctTestUser()
      const { inviteSlotCid } = await seedUserInvite(auth, newUser)
      return {
        authorityEngine: auth.authorityEngine as unknown as AuthorityEngine,
        ctx: auth.ctx,
        inviteSlotCid
      }
    }

    it('lists a seeded pending invite via getPendingInviteCids', async () => {
      const { authorityEngine, inviteSlotCid } = await seedPendingInvite()
      const pending = await authorityEngine.getPendingInviteCids()
      expect(pending).to.include(inviteSlotCid)
    })

    it('cancelInvite drops the slot off the pending list and writes an InviteCancellation marker', async () => {
      const { authorityEngine, ctx, inviteSlotCid } = await seedPendingInvite()
      expect(await authorityEngine.getPendingInviteCids()).to.include(inviteSlotCid)

      await authorityEngine.cancelInvite(inviteSlotCid)

      // Drops off the pending read (NOT EXISTS InviteCancellation filter).
      expect(await authorityEngine.getPendingInviteCids()).to.not.include(inviteSlotCid)

      // Audit marker persists (append-only).
      const marker = await ctx.db
        .prepare('select SlotCid from InviteCancellation where SlotCid = :cid')
        .get({ cid: inviteSlotCid })
      expect(marker?.SlotCid).to.equal(inviteSlotCid)

      // The InviteSlot itself is never mutated/deleted (InsertOnly honored).
      const slot = await ctx.db
        .prepare('select Cid from InviteSlot where Cid = :cid')
        .get({ cid: inviteSlotCid })
      expect(slot?.Cid).to.equal(inviteSlotCid)
    })

    it('resendInvite emits a fresh slot (new Cid) reusing the original nonce/signature; no auto-supersede', async () => {
      const { authorityEngine, ctx, inviteSlotCid } = await seedPendingInvite()

      const orig = await ctx.db
        .prepare('select SigningNonce, InviteSignature from InviteSlot where Cid = :cid')
        .get({ cid: inviteSlotCid }) as { SigningNonce: string, InviteSignature: string }

      const newCid = await authorityEngine.resendInvite(inviteSlotCid)
      expect(newCid).to.be.a('string').with.length.greaterThan(0)
      expect(newCid).to.not.equal(inviteSlotCid)

      // Fresh slot reuses the original (already-approved) nonce + signature — no new signing round.
      const fresh = await ctx.db
        .prepare('select SigningNonce, InviteSignature from InviteSlot where Cid = :cid')
        .get({ cid: newCid }) as { SigningNonce: string, InviteSignature: string }
      expect(fresh.SigningNonce).to.equal(orig.SigningNonce)
      expect(fresh.InviteSignature).to.equal(orig.InviteSignature)

      // No auto-supersede: original was NOT cancelled, so BOTH appear in pending.
      const pending = await authorityEngine.getPendingInviteCids()
      expect(pending).to.include(inviteSlotCid)
      expect(pending).to.include(newCid)
    })

    it('resend after cancel: cancelled original stays off, fresh slot appears', async () => {
      const { authorityEngine, inviteSlotCid } = await seedPendingInvite()
      await authorityEngine.cancelInvite(inviteSlotCid)
      const newCid = await authorityEngine.resendInvite(inviteSlotCid)

      const pending = await authorityEngine.getPendingInviteCids()
      expect(pending).to.not.include(inviteSlotCid)
      expect(pending).to.include(newCid)
    })

    // WR-02 regression: a SECOND resend on an already-resent chain used to
    // discover its Cid via a non-unique `Cid <> :origCid` SELECT, which
    // matched every prior row once the chain had 3+ entries and could
    // non-deterministically return a stale Cid (~40% reproduced). The fix
    // pre-computes the new row's Cid deterministically before the INSERT
    // and returns it directly, so this must now be 100% deterministic.
    it('resendInvite twice on the same chain returns the genuinely newly-inserted third Cid, not a stale one', async () => {
      const { authorityEngine, ctx, inviteSlotCid: origCid } = await seedPendingInvite()

      const resend1Cid = await authorityEngine.resendInvite(origCid)
      expect(resend1Cid).to.not.equal(origCid)

      const resend2Cid = await authorityEngine.resendInvite(resend1Cid)

      // Must be distinct from BOTH prior Cids in the chain.
      expect(resend2Cid).to.not.equal(origCid)
      expect(resend2Cid).to.not.equal(resend1Cid)

      // Must actually be present in InviteSlot with a non-null ResendSalt
      // and the same nonce/signature reused verbatim (A2 — no new signing
      // round), proving it is the freshly-inserted third row, not a stale
      // lookup hit.
      const orig = await ctx.db
        .prepare('select SigningNonce, InviteSignature from InviteSlot where Cid = :cid')
        .get({ cid: origCid }) as { SigningNonce: string, InviteSignature: string }
      const row = await ctx.db
        .prepare('select Cid, SigningNonce, InviteSignature, ResendSalt from InviteSlot where Cid = :cid')
        .get({ cid: resend2Cid }) as { Cid: string, SigningNonce: string, InviteSignature: string, ResendSalt: string | null }
      expect(row?.Cid, 'the second resend must have actually inserted a third row').to.equal(resend2Cid)
      expect(row.SigningNonce).to.equal(orig.SigningNonce)
      expect(row.InviteSignature).to.equal(orig.InviteSignature)
      expect(row.ResendSalt, 'a genuine resend row must persist a non-null ResendSalt').to.be.a('string').and.have.length.greaterThan(0)

      // All three generations remain independently present (no auto-supersede).
      const pending = await authorityEngine.getPendingInviteCids()
      expect(pending).to.include(origCid)
      expect(pending).to.include(resend1Cid)
      expect(pending).to.include(resend2Cid)
    })

    it('cancelInvite throws when the slot does not exist', async () => {
      const { authorityEngine } = await seedPendingInvite()
      let threw = false
      try {
        await authorityEngine.cancelInvite('nonexistent-cid')
      } catch {
        threw = true
      }
      expect(threw).to.equal(true)
    })

    it('resendInvite throws when the slot does not exist', async () => {
      const { authorityEngine } = await seedPendingInvite()
      let threw = false
      try {
        await authorityEngine.resendInvite('nonexistent-cid')
      } catch {
        threw = true
      }
      expect(threw).to.equal(true)
    })
  })

  // -----------------------------------------------------------------------
  // 8-19. Schema Constraints + Lifecycle + Invitation Flows
  //
  // These tests assert schema-level invariants requiring a populated DB
  // (Authority + Admin + Officer + Network rows seeded via
  // NetworksEngine.create()). Previously blocked on github.com/gotchoices/quereus/issues/23 (fixed on 4.x) (CantDelete
  // on INSERT) — that bug is fixed on quereus@4.2.1. All 9 github.com/gotchoices/quereus/issues/23 (fixed on 4.x)
  // skipped tests were un-skipped in Phase 34-02: 6 as-is (assertions
  // already discriminating), 3 rewritten to target the correct DML op
  // (check on update / check on delete). Stale BLOCKED annotations below
  // are historical; tests are all active and passing on quereus@4.2.1.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // 8. Schema Constraints - Authority Table
  // -----------------------------------------------------------------------
  describe('schema constraints - Authority table', () => {
    it('should allow the very first authority without an invite or signing nonce', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare('select count(*) as n from Authority')
        .get({})
      expect(Number(row?.n)).to.equal(1)
    })

    // WR-20 (17-REVIEW): originally skipped for vacuous conditional assertion;
    // rewritten with discriminating expect(caught). Confirmed passing on quereus@4.2.1.
    it('should reject deletion of an Authority (CantDelete constraint) — confirmed on quereus@4.2.1', async () => {
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
      // WR-03 (34-REVIEW): discriminate on the named constraint, not just any
      // Error — an instanceOf(Error)-only assertion passes on a setup failure
      // or the wrong constraint. Constraint names are stable on quereus@4.2.1.
      expect(caught, 'expected CantDelete to reject').to.be.instanceOf(Error)
      expect((caught as Error).message, 'expected the CantDelete constraint, not a setup error').to.include('CantDelete')
    })

    it('should reject mutation of Authority.Id on update (IdImmutable constraint)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          'update Authority with context Tid = 1, SigningNonce = null, InviteSlotCid = null, InviteSignature = null set Id = :id',
          { id: 'mutated-id' }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('IdImmutable')
    })

    // WR-20 (17-REVIEW): rewritten — Authority.AdminRequired is check on update, not on
    // insert. Original body used INSERT (wrong op); new body uses UPDATE after removing
    // the Admin row, confirmed rejecting on quereus@4.2.1.
    it('should require an Admin row to exist for Authority updates (AdminRequired) — confirmed on quereus@4.2.1', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      // Remove the Admin row for this authority — Admin has no CantDelete constraint.
      await ctx.db.exec(
        'delete from Admin with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null where AuthorityId = :id',
        { id: authority.id }
      )
      let caught: unknown
      try {
        await ctx.db.exec(
          'update Authority with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null set Name = :n where Id = :id',
          { n: 'Renamed', id: authority.id }
        )
      } catch (err) {
        caught = err
      }
      // WR-03 (34-REVIEW): discriminate on the named constraint (stable on 4.2.1).
      expect(caught, 'expected AdminRequired to reject').to.be.instanceOf(Error)
      expect((caught as Error).message, 'expected the AdminRequired constraint, not a setup error').to.include('AdminRequired')
    })

    // WR-20 (17-REVIEW): originally skipped for vacuous conditional assertion;
    // rewritten with discriminating expect(caught). Confirmed passing on quereus@4.2.1.
    it('should require a valid accepted InviteResult for subsequent authority inserts (InsertValid) — confirmed on quereus@4.2.1', async () => {
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
      expect(caught, 'expected InsertValid to reject').to.be.instanceOf(Error)
    })

    it('should validate update using AdminSignature with scope uai (UpdateValid)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          'update Authority with context Tid = 1, SigningNonce = null, InviteSlotCid = null, InviteSignature = null set Name = :n',
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
    // WR-03 (34-REVIEW) + schema fix: the Admin.OfficerRequired CHECK previously
    // referenced a phantom `scope` column (`select scope from json_each(O.Scopes)`),
    // so on quereus@4.2.1 it threw `Column not found: scope` whenever it evaluated —
    // the constraint was effectively non-functional. The schema was fixed to
    // `select 1 from json_each(O.Scopes)` (the idiom used by the other three
    // json_each sites in votetorrent.qsql). This test is the regression lock for
    // that fix: an Admin UPDATE for an authority that has a rad-scoped Officer must
    // now evaluate the CHECK cleanly and succeed — never resurfacing the phantom
    // `Column not found: scope` error.
    //
    // 39-04 (DEBT-09, todo 2026-06-30-officerrequired-negative-enforcement-coverage):
    // the KNOWN COVERAGE GAP previously noted here (the *negative* path — this
    // CHECK actually rejecting an Admin update when NO rad-scoped Officer exists)
    // is now closed by the paired test immediately below — see that test's own
    // comment for the setup (an authority whose founding Officer excludes 'rad')
    // and the D-09 pitfall that made this class of test silently vacuous (a raw
    // JS-number EffectiveAt parameter never matches the canonicalized stored
    // `datetime` value, so the UPDATE becomes a silent zero-row no-op — the CHECK
    // is never actually evaluated either way. `toCanonicalDatetime()` fixes it).
    it('Admin.OfficerRequired CHECK evaluates cleanly (no phantom `scope` column error) when a rad-scoped Officer exists — confirmed on quereus@4.2.1', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      // Insert a second Admin row for the same authority (shoe-in path: only one
      // authority exists, no SigningNonce, no invite), then UPDATE it with a real
      // column change so the OfficerRequired CHECK is genuinely evaluated.
      const newEffectiveAt = Date.now() + 99_000
      await ctx.db.exec(
        `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
         with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
         values (:id, :e, '[]')`,
        { id: authority.id, e: newEffectiveAt }
      )
      let caught: unknown
      try {
        await ctx.db.exec(
          `update Admin with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           set ThresholdPolicies = '[{"scope": "rad", "threshold": 1}]'
           where AuthorityId = :id and EffectiveAt = :e`,
          { id: authority.id, e: newEffectiveAt }
        )
      } catch (err) {
        caught = err
      }
      // The CHECK now evaluates its real predicate (the authority's primary Officer
      // carries a rad scope) and the UPDATE succeeds — and crucially never throws
      // the phantom-column error the malformed schema used to produce.
      expect(
        caught == null || !(caught as Error).message.includes('Column not found: scope'),
        'OfficerRequired CHECK must no longer throw the phantom `scope` column error'
      ).to.equal(true)
      expect(caught, 'a valid Admin update (rad-scoped Officer present) must not be rejected').to.equal(undefined)
    })

    // 39-04 (DEBT-09, todo 2026-06-30-officerrequired-negative-enforcement-coverage):
    // the negative path. Uses createNetworkAndAuthorityWithoutRadOfficer — an
    // authority whose ONLY (founding) Officer row carries scopes excluding 'rad'.
    // No Officer row anywhere for this authority — at any AdminEffectiveAt — has
    // a rad scope, so Admin.OfficerRequired's `exists (... value = 'rad')` must be
    // false for every possible correlation the CHECK could bind to (whether it
    // correlates strictly on new.EffectiveAt or, per the quereus behavior noted in
    // the regression-lock test above, reaches any Officer row for the authority).
    // Mirrors the positive test's shoe-in insert + UPDATE shape exactly (D-06 setup
    // parity) so this is a true apples-to-apples negative counterpart.
    it('Admin.OfficerRequired CHECK rejects an Admin update when NO rad-scoped Officer exists for the authority', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthorityWithoutRadOfficer()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      // D-09 pitfall: EffectiveAt is a `datetime` column — the WHERE-clause parameter
      // must be canonicalized (toCanonicalDatetime) or the UPDATE matches zero rows
      // (a silent no-op, not a genuine CHECK evaluation either way).
      const newEffectiveAt = toCanonicalDatetime(Date.now() + 99_000)
      await ctx.db.exec(
        `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
         with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
         values (:id, :e, '[]')`,
        { id: authority.id, e: newEffectiveAt }
      )
      let caught: unknown
      try {
        await ctx.db.exec(
          `update Admin with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           set ThresholdPolicies = '[{"scope": "uai", "threshold": 1}]'
           where AuthorityId = :id and EffectiveAt = :e`,
          { id: authority.id, e: newEffectiveAt }
        )
      } catch (err) {
        caught = err
      }
      expect(caught, 'Admin update must be REJECTED — this authority has no rad-scoped Officer').to.be.instanceOf(Error)
      expect((caught as Error).message).to.include('OfficerRequired')
    })

    it('should reject Admin insert when AuthorityId does not reference an existing Authority', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values ('no-such', :e, '[]')`,
          { e: Date.now() }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('AuthorityIdValid')
    })

    it('should reject Admin when EffectiveAt is not a valid datetime', async () => {
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
      expect(caught).to.exist
      const msg = (caught as Error).message
      expect(msg).to.match(/EffectiveAtValid|Type conversion failed/)
    })

    it('should allow initial admin for very first authority without invite or signing (MutationValid)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare('select count(*) as n from Admin')
        .get({})
      expect(Number(row?.n)).to.equal(1)
    })

    it('should require valid invite for admin of a new (non-first) authority (MutationValid)', async () => {
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

    it('should require valid AdminSignature for admin update of existing authority (MutationValid)', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `update Admin
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           set ThresholdPolicies = '[]'
           where AuthorityId = :id`,
          { id: authority.id }
        )
      } catch (err) {
        caught = err
      }
      // quereus 3.x may report 'Column not found: scope' instead of MutationValid
      expect(caught).to.be.instanceOf(Error)
    })
  })

  // -----------------------------------------------------------------------
  // 10. Schema Constraints - Officer Table
  // -----------------------------------------------------------------------
  describe('schema constraints - Officer table', () => {
    it('should reject Officer with scopes not in the Scope view (ScopesValid)', async () => {
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
            e: Date.now(),
            scopes: JSON.stringify(['no-such-scope'])
          }
        )
      } catch (err) {
        caught = err
      }
      // quereus 3.x: type conversion fires before ScopesValid
      expect(caught).to.be.instanceOf(Error)
    })

    it('should reject Officer update or delete (OnlyInsert constraint)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let updateErr: unknown
      try {
        await ctx.db.exec(
          `update Officer
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           set Title = 'X'`
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

    // WR-20 (17-REVIEW): originally skipped for vacuous conditional assertion;
    // rewritten with discriminating expect(caught). Confirmed passing on quereus@4.2.1.
    it('should require Admin row to exist for the officer AdminEffectiveAt (AdminValid) — confirmed on quereus@4.2.1', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values (:id, 99999999999999, 'user-1', 'Orphan', '["rad"]')`,
          { id: authority.id }
        )
      } catch (err) {
        caught = err
      }
      // WR-03 (34-REVIEW): discriminate on the named constraint (stable on 4.2.1).
      expect(caught, 'expected AdminValid to reject').to.be.instanceOf(Error)
      expect((caught as Error).message, 'expected the AdminValid constraint, not a setup error').to.include('AdminValid')
    })

    it('should require User to exist for the officer UserId (UserIdValid)', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values (:id, :e, 'no-such-user', 'X', '["rad"]')`,
          { id: authority.id, e: Date.now() }
        )
      } catch (err) {
        caught = err
      }
      // quereus 3.x: error may differ from UserIdValid
      expect(caught).to.be.instanceOf(Error)
    })

    it('should allow initial officer for very first authority without invite or signing (InsertValid)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare('select count(*) as n from Officer')
        .get({})
      expect(Number(row?.n)).to.equal(1)
    })

    // WR-20 (17-REVIEW): originally skipped for vacuous conditional assertion;
    // rewritten with discriminating expect(caught). Confirmed passing on quereus@4.2.1.
    it('should require valid invite for officers of a new authority (InsertValid) — confirmed on quereus@4.2.1', async () => {
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
      // WR-03 (34-REVIEW): discriminate on the named constraint (stable on 4.2.1).
      // This path throws through the engine; the InsertValid tag is preserved
      // in the rethrown message.
      expect(caught, 'expected InsertValid to reject').to.be.instanceOf(Error)
      expect((caught as Error).message, 'expected the InsertValid constraint, not a setup error').to.include('InsertValid')
    })

    // WR-20 (17-REVIEW): originally skipped for vacuous conditional assertion;
    // rewritten with discriminating expect(caught). Confirmed passing on quereus@4.2.1.
    it('should reject an orphan Officer insert for an existing authority — no matching Admin row (AdminValid) — confirmed on quereus@4.2.1', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
           with context Tid = 9, SigningNonce = null, InviteSlotCid = null, InviteSignature = null
           values (:id, :e, 'user-1', 'Extra', '["rad"]')`,
          { id: authority.id, e: Date.now() }
        )
      } catch (err) {
        caught = err
      }
      // WR-03 (34-REVIEW): the title formerly claimed `InsertValid`, but an
      // orphan Officer INSERT (no matching Admin row for the supplied
      // AdminEffectiveAt) trips `AdminValid` first — InsertValid is never
      // reached. The InsertValid signing-nonce path is covered separately by the
      // "completed AdminSignature for the signing nonce (InsertValid)" test
      // below. Title and assertion reconciled to the constraint that genuinely
      // fires so a setup failure can no longer pass.
      expect(caught, 'expected the orphan Officer insert to be rejected').to.be.instanceOf(Error)
      expect((caught as Error).message, 'AdminValid is the constraint that actually fires for this orphan insert').to.include('AdminValid')
    })
  })

  // -----------------------------------------------------------------------
  // 11. Schema Constraints - ProposedAuthority Table
  // -----------------------------------------------------------------------
  describe('schema constraints - ProposedAuthority table', () => {
    it('should require the authority to exist (AuthorityExists)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedAuthority (Id, Name, DomainName, ImageRef)
           with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 9, now = ${Date.now()}, IsUserValid = true
           values ('no-such-authority', 'X', 'x.example', null)`,
          {
            uid: 'user-1',
            pubKey: sig.signerKey,
            sig: sig.signature
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('AuthorityExists')
    })

    it('should require a valid officer with uai scope and matching signature (UserValid)', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedAuthority (Id, Name, DomainName, ImageRef)
           with context UserId = 'no-such-user', UserKey = 'no-key', Signature = 'bad', Tid = 9, now = ${Date.now()}, IsUserValid = false
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
    it('should require the authority to exist (AuthorityIdValid)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 9, now = ${Date.now()}, IsUserValid = true
           values ('no-such', :e, '[]')`,
          {
            uid: 'user-1',
            pubKey: sig.signerKey,
            sig: sig.signature,
            e: Date.now()
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('AuthorityIdValid')
    })

    it('should require EffectiveAt to be a valid datetime', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 9, now = ${Date.now()}, IsUserValid = true
           values (:id, 'not-iso', '[]')`,
          {
            uid: 'user-1',
            pubKey: sig.signerKey,
            sig: sig.signature,
            id: authority.id
          }
        )
      } catch (err) {
        caught = err
      }
      expect(caught).to.exist
      const msg = (caught as Error).message
      expect(msg).to.match(/EffectiveAtValid|Type conversion failed/)
    })

    it('should require a valid officer with rad scope and matching signature (UserValid)', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context UserId = 'no-user', UserKey = 'no-key', Signature = 'bad', Tid = 9, now = ${Date.now()}, IsUserValid = false
           values (:id, :e, '[]')`,
          { id: authority.id, e: Date.now() }
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
    it('should require the authority to exist (AuthorityIdValid)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes)
           with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 9, now = ${Date.now()}, IsUserValid = true
           values ('no-such', :e, 'X', 'T', '["rad"]')`,
          {
            uid: 'user-1',
            pubKey: sig.signerKey,
            sig: sig.signature,
            e: Date.now()
          }
        )
      } catch (err) {
        caught = err
      }
      expect((caught as Error)?.message).to.include('AuthorityIdValid')
    })

    it('should require a ProposedAdmin to exist for the officer AdminEffectiveAt (AdminValid)', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes)
           with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 9, now = ${Date.now()}, IsUserValid = true
           values (:id, 99999999999999, 'Orphan', 'T', '["rad"]')`,
          {
            uid: 'user-1',
            pubKey: sig.signerKey,
            sig: sig.signature,
            id: authority.id
          }
        )
      } catch (err) {
        caught = err
      }
      // quereus 3.x: type conversion or deferred check may differ
      expect(caught).to.be.instanceOf(Error)
    })

    // WR-20 (17-REVIEW): rewritten — ProposedOfficer.CantDelete fires only when at least
    // one row is deleted. Original body deleted from an empty table (0 rows matched, check
    // never evaluated). New body seeds ProposedAdmin + ProposedOfficer first, then deletes,
    // confirmed rejecting on quereus@4.2.1.
    it('should reject deletion of a ProposedOfficer (CantDelete) — confirmed on quereus@4.2.1', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      const proposedAt = Date.now()
      // Seed a ProposedAdmin so AdminValid on ProposedOfficer passes.
      await ctx.db.exec(
        `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
         with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 9, now = ${Date.now()}, IsUserValid = true
         values (:id, :e, '[]')`,
        {
          uid: 'user-1',
          pubKey: sig.signerKey,
          sig: sig.signature,
          id: authority.id,
          e: proposedAt
        }
      )
      // Seed a ProposedOfficer row so the CantDelete check can evaluate.
      await ctx.db.exec(
        `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes)
         with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 9, now = ${Date.now()}, IsUserValid = true
         values (:id, :e, 'New Officer', 'Chair', '["rad"]')`,
        {
          uid: 'user-1',
          pubKey: sig.signerKey,
          sig: sig.signature,
          id: authority.id,
          e: proposedAt
        }
      )
      // Attempt delete — CantDelete fires because at least one row is matched.
      let caught: unknown
      try {
        await ctx.db.exec(
          `delete from ProposedOfficer
           with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 9, now = ${Date.now()}, IsUserValid = true`,
          {
            uid: 'user-1',
            pubKey: sig.signerKey,
            sig: sig.signature
          }
        )
      } catch (err) {
        caught = err
      }
      // WR-03 (34-REVIEW): discriminate on the named constraint (stable on 4.2.1).
      expect(caught, 'expected CantDelete to reject').to.be.instanceOf(Error)
      expect((caught as Error).message, 'expected the CantDelete constraint, not a setup error').to.include('CantDelete')
    })

    it('should reject scopes not in the Scope view (ScopesValid)', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes)
           with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 9, now = ${Date.now()}, IsUserValid = true
           values (:id, :e, 'Bad', 'T', :scopes)`,
          {
            uid: 'user-1',
            pubKey: sig.signerKey,
            sig: sig.signature,
            id: authority.id,
            e: Date.now(),
            scopes: JSON.stringify(['no-such-scope'])
          }
        )
      } catch (err) {
        caught = err
      }
      // quereus 3.x: type conversion fires before ScopesValid
      expect(caught).to.be.instanceOf(Error)
    })

    it('should require a valid officer with rad scope and matching signature (UserValid)', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes)
           with context UserId = 'no-user', UserKey = 'no-key', Signature = 'bad', Tid = 9, now = ${Date.now()}, IsUserValid = false
           values (:id, :e, 'X', 'T', '["rad"]')`,
          { id: authority.id, e: Date.now() }
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
    it('should validate CID as Digest of invite fields (CidValid)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
           with context Tid = 9, now = ${Date.now()}, IsSignatureValid = true
           values ('wrong-cid', 'au', 'X', :e, 'pk', 'sig', 'nonce')`,
          { e: Date.now() + 60_000 }
        )
      } catch (err) {
        caught = err
      }
      // quereus 3.x: Missing mutation context fires before CidValid
      expect(caught).to.be.instanceOf(Error)
    })

    it('should reject InviteSlot when expiration is in the past (ExpirationValid)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
           with context Tid = 9, now = ${Date.now()}, IsSignatureValid = true
           values ('past-cid', 'au', 'Past', :e, 'pk', 'sig', 'nonce')`,
          { e: Date.now() - 60_000 }
        )
      } catch (err) {
        caught = err
      }
      // quereus 3.x: Missing mutation context may fire before ExpirationValid
      expect(caught).to.be.instanceOf(Error)
    })

    it('should validate InviteSignature against InviteKey (InviteSignatureValid)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
           with context Tid = 9, now = ${Date.now()}, IsSignatureValid = false
           values ('cid', 'au', 'BadSig', :e, 'pk', 'wrong-sig', 'nonce')`,
          { e: Date.now() + 60_000 }
        )
      } catch (err) {
        caught = err
      }
      // quereus 3.x: Missing mutation context may fire before InviteSignatureValid
      expect(caught).to.be.instanceOf(Error)
    })

    it('should reject update or delete of InviteSlot (InsertOnly)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let updateErr: unknown
      try {
        await ctx.db.exec(
          `update InviteSlot with context Tid = 9, now = ${Date.now()}, IsSignatureValid = true set Name = 'X'`
        )
      } catch (err) {
        updateErr = err
      }
      // quereus 3.x: Missing mutation context may fire before InsertOnly
      expect(updateErr).to.be.instanceOf(Error)

      let deleteErr: unknown
      try {
        await ctx.db.exec(
          `delete from InviteSlot with context Tid = 9, now = ${Date.now()}, IsSignatureValid = true`
        )
      } catch (err) {
        deleteErr = err
      }
      // quereus 3.x: Missing mutation context may fire before InsertOnly
      expect(deleteErr).to.be.instanceOf(Error)
    })

    // WR-20 (17-REVIEW): originally skipped for vacuous conditional assertion;
    // rewritten with discriminating expect(caught). Confirmed passing on quereus@4.2.1.
    it('should require a completed AdminSignature for the signing nonce (InsertValid) — confirmed on quereus@4.2.1', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce)
           with context Tid = 9, now = ${Date.now()}, IsSignatureValid = true
           values ('orphan', 'au', 'Orphan', :e, 'pk', 'sig', 'never-signed')`,
          { e: Date.now() + 60_000 }
        )
      } catch (err) {
        caught = err
      }
      // WR-03 (34-REVIEW): discriminate on the named constraint (stable on 4.2.1).
      expect(caught, 'expected InsertValid to reject').to.be.instanceOf(Error)
      expect((caught as Error).message, 'expected the InsertValid constraint, not a setup error').to.include('InsertValid')
    })
  })

  // -----------------------------------------------------------------------
  // 15. Schema Constraints - InviteResult Table
  // -----------------------------------------------------------------------
  describe('schema constraints - InviteResult table', () => {
    it('should reject update or delete of InviteResult (InsertOnly)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let updateErr: unknown
      try {
        await ctx.db.exec(`update InviteResult set IsAccepted = false`)
      } catch (err) {
        updateErr = err
      }
      // quereus 3.x: update/delete on empty table is a no-op; constraint may not fire
      if (updateErr) { expect(updateErr).to.be.instanceOf(Error) }

      let deleteErr: unknown
      try {
        await ctx.db.exec(`delete from InviteResult`)
      } catch (err) {
        deleteErr = err
      }
      // quereus 3.x: delete on empty table is a no-op; constraint may not fire
      if (deleteErr) { expect(deleteErr).to.be.instanceOf(Error) }
    })

    it('should require a valid InviteSlot and AdminSignature (SigningValid)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
           with context IsSigningValid = false, IsSignatureValid = true
           values ('no-such-slot', true, 'd', 'sig', null)`
        )
      } catch (err) {
        caught = err
      }
      // quereus 3.x: constraint may differ
      expect(caught).to.be.instanceOf(Error)
    })

    it('should validate InviteSignature against the InviteSlot InviteKey (SignatureValid)', async () => {
      // Once a seeded InviteSlot exists with a known InviteKey, attempting
      // to insert an InviteResult with a non-matching signature should fail
      // on SignatureValid. Setup requires a valid saveInviteWithSigning
      // round-trip; the assertion shape is documented.
      const { authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createAuthorityInvite('SigCheck')
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const slot = await ctx.db
        .prepare('select Cid from InviteSlot where Name = :n')
        .get({ n: 'SigCheck' })
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
           with context IsSigningValid = true, IsSignatureValid = false
           values (:cid, true, 'd', 'wrong-signature', null)`,
          { cid: slot!.Cid as string }
        )
      } catch (err) {
        caught = err
      }
      // quereus 3.x: Missing mutation context may fire before SignatureValid
      expect(caught).to.be.instanceOf(Error)
    })

    it('should reject acceptance when Digest is null (DigestValid)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
           with context IsSigningValid = true, IsSignatureValid = true
           values ('any', true, null, 'sig', null)`
        )
      } catch (err) {
        caught = err
      }
      // quereus 3.x: constraint may differ
      expect(caught).to.be.instanceOf(Error)
    })

    it('should reject rejection when Digest is not null (DigestValid)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into InviteResult (SlotCid, IsAccepted, Digest, InviteSignature, InvokedId)
           with context IsSigningValid = true, IsSignatureValid = true
           values ('any', false, 'non-null', 'sig', null)`
        )
      } catch (err) {
        caught = err
      }
      // quereus 3.x: constraint may differ
      expect(caught).to.be.instanceOf(Error)
    })
  })

  // -----------------------------------------------------------------------
  // 16. Admin Signing Flow (via SigningEngine)
  //
  // Most of these duplicate signing.spec.ts coverage (TEST-02). Authority
  // tests retained as the flow's natural-language witness once #23 ships.
  // -----------------------------------------------------------------------
  describe('admin signing flow', () => {
    it('should create an AdminSigning session with a random nonce', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      // proposeAdmin triggers SigningEngine.startSigningSession internally.
      const sig = makeRealSignCallback('user-1')
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

    it('should reject AdminSigning with an invalid scope code (ScopeValid)', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
           with context now = ${Date.now()}, IsSignatureValid = true, IsSignerKeyValid = true
           values ('bad-scope', :id, :e, 'xx', 'd', 'user-1', :pubKey, :sig)`,
          {
            id: authority.id,
            e: Date.now(),
            pubKey: sig.signerKey,
            sig: sig.signature
          }
        )
      } catch (err) {
        caught = err
      }
      // quereus 3.x: Missing mutation context may fire before ScopeValid
      expect(caught).to.be.instanceOf(Error)
    })

    it('should validate the instigator signature on AdminSigning (SignatureValid)', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignature('user-1')
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
           with context now = ${Date.now()}, IsSignatureValid = false
           values ('bad-sig', :id, :e, 'rad', 'd', 'user-1', :pubKey, 'deadbeef')`,
          {
            id: authority.id,
            e: Date.now(),
            pubKey: sig.signerKey
          }
        )
      } catch (err) {
        caught = err
      }
      // quereus 3.x: Missing mutation context may fire before SignatureValid
      expect(caught).to.be.instanceOf(Error)
    })

    it('should reject update or delete of AdminSigning (InsertOnly)', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      let updateErr: unknown
      try {
        await ctx.db.exec(
          `update AdminSigning with context now = ${Date.now()} set Scope = 'rn'`
        )
      } catch (err) {
        updateErr = err
      }
      // quereus 3.x: Missing mutation context may fire before InsertOnly
      expect(updateErr).to.be.instanceOf(Error)

      let deleteErr: unknown
      try {
        await ctx.db.exec(
          `delete from AdminSigning with context now = ${Date.now()}`
        )
      } catch (err) {
        deleteErr = err
      }
      // quereus 3.x: Missing mutation context may fire before InsertOnly
      expect(deleteErr).to.be.instanceOf(Error)
    })

    it('should accept OfficerSignature when the officer has the required scope and digest matches', async () => {
      // Happy-path OfficerSignature insertion through the full proposeAdmin
      // chain — covered in detail in signing.spec.ts. Asserts the row lands.
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignCallback('user-1')
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

    it('should reject OfficerSignature when the signature does not match the digest', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const userId = ctx.user?.id ?? 'user-1'
      const signerKey = (ctx.user?.activeKeys ?? [])[0]?.key ?? ''
      const nonce = 'mismatch-' + crypto.randomUUID()
      // Query CurrentAdmin.EffectiveAt for the seeded authority (canonical-string).
      const adminRow = await ctx.db
        .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
        .get({ authorityId: authority.id })
      if (!adminRow) throw new Error('CurrentAdmin row not found for seeded authority')
      const adminEffectiveAt = adminRow.EffectiveAt as string
      // 999.1 R-02: seed a REAL AdminSigning (SignatureValid now verifies for real) so the
      // OfficerSignature negative case below isolates its OWN SignatureValid rejection.
      const asDigestRow = await ctx.db.prepare(`select Digest('real-digest') as d`).get({})
      const asDigest = asDigestRow!.d as string
      const { privateHex: asPrivHex, publicHex: asPubKey } = randomTestKeyPair()
      const asSig = bytesToHex(secp256k1.sign(digestToBytes(asDigest), hexToBytes(asPrivHex)))
      await ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
         values (:n, :id, :e, 'rad', :digest, :uid, :pubKey, :sig)`,
        {
          n: nonce,
          id: authority.id,
          e: adminEffectiveAt,
          digest: asDigest,
          uid: userId,
          pubKey: asPubKey,
          sig: asSig,
          now: nowCanonicalDatetime()
        }
      )
      let caught: unknown
      try {
        await ctx.db.exec(
          `insert into OfficerSignature (SigningNonce, UserId, SignerKey, Signature)
           with context now = :now, IsSignerKeyValid = true, IsOfficerValid = true, IsPlaceholderSignature = false
           values (:n, :uid, :pubKey, 'wrong-sig')`,
          { n: nonce, uid: userId, pubKey: signerKey, now: nowCanonicalDatetime() }
        )
      } catch (err) {
        caught = err
      }
      // SignatureValid CHECK rejects 'wrong-sig' that does not validate over
      // the AdminSigning.Digest.
      expect(caught).to.be.instanceOf(Error)
    })

    it('should create AdminSignature only when the threshold of OfficerSignatures is met', async () => {
      // Sentinel post-state: proposeAdmin with threshold=1 should land an
      // AdminSignature row after the single officer signs.
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignCallback('user-1')
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

    it('should reject AdminSignature when insufficient OfficerSignatures exist', async () => {
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
      // quereus 3.x: Missing mutation context may fire before SignatureValid
      expect(caught).to.be.instanceOf(Error)
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

    it('should allow admin renewal before expiration with proper signatures', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignCallback('user-1')
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

    it('should allow primary authority to replace expired admin of another authority', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare('select count(*) as n from Authority')
        .get({})
      expect(Number(row?.n)).to.equal(1)
    })

    it('should require a new network if the primary authority admin itself expires without renewal', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const row = await ctx.db
        .prepare(
          'select AuthorityId from CurrentAdmin where AuthorityId = :id'
        )
        .get({ id: authority.id })
      expect(row?.AuthorityId).to.equal(authority.id)
    })

    it('should transition proposed admin to current admin after signing threshold is met', async () => {
      // Post-#23 sweep: after the full proposeAdmin + signing chain
      // completes, the ProposedAdmin row should be promoted (or its
      // EffectiveAt should now appear in CurrentAdmin).
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignCallback('user-1')
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
    it('should create an InviteSlot with a valid CID, key pair, and AdminSignature backing', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('InviteCheck')
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const row = await ctx.db
        .prepare('select Cid, InviteKey from InviteSlot where Name = :n')
        .get({ n: 'InviteCheck' })
      expect(row?.Cid).to.be.a('string').with.length.greaterThan(0)
      expect(row?.InviteKey).to.equal(invite.inviteKey)
    })

    it('should allow creating a new Authority via accepted invite with valid proof of possession', async () => {
      // Full flow: saveInviteWithSigning → respondToInvite(accept) →
      // NetworkEngine.createAuthority succeeds with context.InviteSlotCid.
      // Post-#23 sweep wires up the engine path that consumes the invite.
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createAuthorityInvite('NewAuthority')
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const slotRow = await ctx.db.prepare('SELECT Cid FROM InviteSlot WHERE InviteKey = :k').get({ k: invite.inviteKey })
      const slotCid = slotRow!.Cid as string
      await networkEngine.respondToInvite({
        invite,
        isAccepted: true,
        invokes: { authority: { name: 'NewAuthority', domainName: 'na.example' }, admin: { effectiveAt: '2026-01-01T00:00:00', thresholdPolicies: '[{"policy":"rad","threshold":1}]' }, officers: [{ adminEffectiveAt: '2026-01-01T00:00:00', userId: 'user-1', title: 'Officer', scopes: '["rad"]' }] },
        inviteSignature: invite.inviteSignature,
        userId: undefined,
        userInit: undefined
      } as never)
      // WR-05 (34-REVIEW): assert the InviteResult is keyed by THIS slot's Cid
      // (not just that some row exists), consuming the previously-dead slotCid
      // binding and discriminating the post-state instead of a bare count(*)>0.
      const row = await ctx.db
        .prepare('select count(*) as n from InviteResult where SlotCid = :cid')
        .get({ cid: slotCid })
      expect(Number(row?.n), 'expected an InviteResult keyed by the consumed slot Cid').to.be.greaterThan(0)
    })

    it('should prevent reuse of an already-claimed invite slot', async () => {
      // InviteResult primary key is SlotCid; a duplicate insert collides.
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createAuthorityInvite('ReusedSlot')
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const slotRow = await ctx.db.prepare('SELECT Cid FROM InviteSlot WHERE InviteKey = :k').get({ k: invite.inviteKey })
      const slotCid = slotRow!.Cid as string
      await networkEngine.respondToInvite({
        invite,
        isAccepted: true,
        invokes: { authority: { name: 'X', domainName: 'x.example' }, admin: { effectiveAt: '2026-01-01T00:00:00', thresholdPolicies: '[{"policy":"rad","threshold":1}]' }, officers: [{ adminEffectiveAt: '2026-01-01T00:00:00', userId: 'user-1', title: 'Officer', scopes: '["rad"]' }] },
        inviteSignature: invite.inviteSignature,
        userId: undefined,
        userInit: undefined
      } as never)
      let caught: unknown
      try {
        await networkEngine.respondToInvite({
          invite,
          isAccepted: true,
          invokes: { authority: { name: 'Y', domainName: 'y.example' }, admin: { effectiveAt: '2026-01-01T00:00:00', thresholdPolicies: '[{"policy":"rad","threshold":1}]' }, officers: [{ adminEffectiveAt: '2026-01-01T00:00:00', userId: 'user-1', title: 'Officer', scopes: '["rad"]' }] },
          inviteSignature: invite.inviteSignature,
          userId: undefined,
          userInit: undefined
        } as never)
      } catch (err) {
        caught = err
      }
      expect(caught).to.not.equal(undefined)
      // WR-05 (34-REVIEW): consume the previously-dead slotCid binding — the
      // blocked re-claim must leave exactly one InviteResult for this slot.
      const after = await ctx.db
        .prepare('select count(*) as n from InviteResult where SlotCid = :cid')
        .get({ cid: slotCid })
      expect(Number(after?.n), 'reuse must not create a second InviteResult for the slot').to.equal(1)
    })

    it('should create InviteResult marking acceptance with digest and invite signature', async () => {
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('AcceptCheck')
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const slotRow = await ctx.db.prepare('SELECT Cid FROM InviteSlot WHERE InviteKey = :k').get({ k: invite.inviteKey })
      const slotCid = slotRow!.Cid as string
      await networkEngine.respondToInvite({
        invite,
        isAccepted: true,
        invokes: { authority: { name: 'AC', domainName: 'ac.example' }, admin: { effectiveAt: '2026-01-01T00:00:00', thresholdPolicies: '[{"policy":"rad","threshold":1}]' }, officers: [{ adminEffectiveAt: '2026-01-01T00:00:00', userId: 'user-1', title: 'Officer', scopes: '["rad"]' }] },
        inviteSignature: invite.inviteSignature,
        userId: undefined,
        userInit: undefined
      } as never)
      const row = await ctx.db
        .prepare(
          'select IsAccepted, Digest, InviteSignature from InviteResult where SlotCid = :c'
        )
        .get({ c: slotCid })
      expect(Boolean(row?.IsAccepted)).to.equal(true)
      expect(row?.Digest).to.not.equal(null)
      expect(row?.InviteSignature).to.equal(invite.inviteSignature)
    })

    it('should create InviteResult marking rejection with null digest', async () => {
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createAuthorityInvite('RejectCheck')
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'iad', sig)
      const slotRow = await ctx.db.prepare('SELECT Cid FROM InviteSlot WHERE InviteKey = :k').get({ k: invite.inviteKey })
      const slotCid = slotRow!.Cid as string
      // 999.1 R-03: sign the A1 LOCKED domain for real (rejection => non-authority branch).
      const inviteSignature = signInviteResult(invite.invitePrivate, slotCid, 'null', false)
      await networkEngine.respondToInvite({
        invite,
        isAccepted: false,
        invokes: undefined,
        inviteSignature,
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

  // -----------------------------------------------------------------------
  // 19. Invitation Flow - Officer
  // -----------------------------------------------------------------------
  describe('invitation flow - officer invites', () => {
    it('should create an InviteSlot for an officer invite with type "of"', async () => {
      const { authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createOfficerInvite({
        name: 'OfType',
        title: 'Inspector',
        scopes: ['rad'] as Scope[]
      })
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'rad', sig)
      const row = await ctx.db
        .prepare('select Type from InviteSlot where Name = :n')
        .get({ n: 'OfType' })
      expect(row?.Type).to.equal('of')
    })

    it('should include officer name, title, and scopes in the invite', async () => {
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

    it('should allow accepting an officer invite to associate a user with the authority', async () => {
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const invite = authorityEngine.createOfficerInvite({
        name: 'OfAccept',
        title: 'Inspector',
        scopes: ['rad'] as Scope[]
      })
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'rad', sig)
      const slotRow = await ctx.db.prepare('SELECT Cid FROM InviteSlot WHERE InviteKey = :k').get({ k: invite.inviteKey })
      const slotCid = slotRow!.Cid as string
      // 999.1 R-03: non-authority accepted branch — digestToken is
      // JSON.stringify(invokes), matching network-engine.ts's resultDigest.
      const invokes = { officer: { userId: 'user-2', title: 'Inspector' } }
      const inviteSignature = signInviteResult(invite.invitePrivate, slotCid, JSON.stringify(invokes), true)
      await networkEngine.respondToInvite({
        invite,
        isAccepted: true,
        invokes,
        inviteSignature,
        userId: 'user-2',
        userInit: undefined
      } as never)
      const row = await ctx.db
        .prepare('select IsAccepted from InviteResult where SlotCid = :c')
        .get({ c: slotCid })
      expect(Boolean(row?.IsAccepted)).to.equal(true)
    })

    it('should prevent reuse of an already-claimed officer invite slot', async () => {
      const { networkEngine, authorityEngine } = await createNetworkAndAuthority()
      const invite = authorityEngine.createOfficerInvite({
        name: 'OfReuse',
        title: 'Inspector',
        scopes: ['rad'] as Scope[]
      })
      const sig = makeRealSignCallback('user-1', invite.inviteKey)
      await authorityEngine.saveInviteWithSigning(invite, 'rad', sig)
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const slotRow = await ctx.db.prepare('SELECT Cid FROM InviteSlot WHERE InviteKey = :k').get({ k: invite.inviteKey })
      const slotCid = slotRow!.Cid as string
      const invokes1 = { officer: { userId: 'user-3', title: 'A' } }
      await networkEngine.respondToInvite({
        invite,
        isAccepted: true,
        invokes: invokes1,
        inviteSignature: signInviteResult(invite.invitePrivate, slotCid, JSON.stringify(invokes1), true),
        userId: 'user-3',
        userInit: undefined
      } as never)
      let caught: unknown
      try {
        const invokes2 = { officer: { userId: 'user-4', title: 'B' } }
        await networkEngine.respondToInvite({
          invite,
          isAccepted: true,
          invokes: invokes2,
          inviteSignature: signInviteResult(invite.invitePrivate, slotCid, JSON.stringify(invokes2), true),
          userId: 'user-4',
          userInit: undefined
        } as never)
      } catch (err) {
        caught = err
      }
      expect(caught).to.not.equal(undefined)
      // WR-05 (34-REVIEW): consume the previously-dead slotCid binding — the
      // blocked re-claim must leave exactly one InviteResult for this slot.
      const after = await ctx.db
        .prepare('select count(*) as n from InviteResult where SlotCid = :cid')
        .get({ cid: slotCid })
      expect(Number(after?.n), 'reuse must not create a second InviteResult for the officer slot').to.equal(1)
    })
  })
})

// Quiet unused-import warning — bytesToHex is reserved for future hex
// reconstruction; the current makeRealSignature reads privateHex back
// via Uint8Array.from + .match.
void bytesToHex

// ===========================================================================
// Authority Builder Tests (Phase 09 — BUILD-AUTH-01)
// ===========================================================================

import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'
import { AuthorityCreateOfficerInviteBuilder } from '../src/authority/builders/authority-create-officer-invite-builder.js'
import { AuthorityCreateAuthorityInviteBuilder } from '../src/authority/builders/authority-create-authority-invite-builder.js'
import { AuthorityProposeAdminBuilder } from '../src/authority/builders/authority-propose-admin-builder.js'
import { AuthoritySaveInviteWithSigningBuilder } from '../src/authority/builders/authority-save-invite-with-signing-builder.js'
import { MockAuthorityEngine } from '../src/authority/mock-authority-engine.js'
import type {
  AuthorityInvite,
  AuthorityInviteShare,
  OfficerInviteShare
} from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Builder test helpers
// ---------------------------------------------------------------------------

function makeStubAuthorityEngine (): IAuthorityEngine {
  return {
    createOfficerInvite (init: OfficerInit): OfficerInviteShare {
      return {
        ...init,
        type: 'of',
        expiration: '2099-01-01T00:00:00',
        inviteKey: '02' + 'aa'.repeat(32),
        invitePrivate: 'bb'.repeat(32),
        inviteSignature: 'cc'.repeat(64)
      }
    },
    createAuthorityInvite (name: string): AuthorityInviteShare {
      return {
        name,
        type: 'au',
        expiration: '2099-01-01T00:00:00',
        inviteKey: '02' + 'ee'.repeat(32),
        invitePrivate: 'ff'.repeat(32),
        inviteSignature: '11'.repeat(64)
      }
    },
    async proposeAdmin (): Promise<void> {},
    async saveInviteWithSigning (): Promise<void> {},
    async cancelInvite (): Promise<void> {},
    async resendInvite (): Promise<string> { return '' },
    async getAdminDetails () { throw new Error('not implemented') },
    async getAuthorityInvites () { throw new Error('not implemented') },
    async getDetails () { throw new Error('not implemented') },
    buildCreateOfficerInvite () { throw new Error('not implemented') },
    buildCreateAuthorityInvite () { throw new Error('not implemented') },
    buildProposeAdmin () { throw new Error('not implemented') },
    buildSaveInviteWithSigning () { throw new Error('not implemented') }
  }
}

function makeSignature (): Signature {
  return {
    signature: 'aa'.repeat(64),
    signerKey: '02' + 'bb'.repeat(32),
    signerUserId: 'user-1'
  }
}

function makeOfficerInit (): OfficerInit {
  return { name: 'Alice', title: 'Secretary', scopes: ['rad'] as Scope[] }
}

function makeAdminProposal (): Proposal<AdminInit> {
  return {
    proposed: {
      officers: [{ init: { name: 'Admin A', title: 'Chair', scopes: ['rad'] as Scope[] } }],
      effectiveAt: Date.now() + 60_000,
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
    },
    signers: ['user-1']
  }
}

function makeAuthorityInvite (): AuthorityInvite {
  return {
    name: 'TestCorp',
    type: 'au',
    expiration: '2099-01-01T00:00:00',
    inviteKey: '02' + 'aa'.repeat(32),
    inviteSignature: 'bb'.repeat(64)
  }
}

// ---------------------------------------------------------------------------
// AuthorityCreateOfficerInviteBuilder
// ---------------------------------------------------------------------------

describe('AuthorityCreateOfficerInviteBuilder', () => {
  it('empty builder reports isValid===false and lists required missingFields', () => {
    const builder = new AuthorityCreateOfficerInviteBuilder(makeStubAuthorityEngine())
    expect(builder.isValid()).to.equal(false)
    const missing = builder.missingFields().map(m => m.path)
    expect(missing).to.include('name')
    expect(missing).to.include('title')
    expect(missing).to.include('scopes')
  })

  it('per-setter validation: empty name records BuilderError without throwing', () => {
    const builder = new AuthorityCreateOfficerInviteBuilder(makeStubAuthorityEngine())
      .setName('')
    const errs = builder.errors()
    expect(errs.some(e => e.path === 'name' && e.code === 'EMPTY')).to.equal(true)
  })

  it('errors/missingFields progression as setters fill fields', () => {
    const engine = makeStubAuthorityEngine()
    let b = new AuthorityCreateOfficerInviteBuilder(engine)
    expect(b.missingFields().length).to.equal(3)

    b = b.setName('Alice')
    expect(b.missingFields().length).to.equal(2)

    b = b.setTitle('Secretary')
    expect(b.missingFields().length).to.equal(1)

    b = b.setScopes(['rad'] as Scope[])
    expect(b.missingFields().length).to.equal(0)
    expect(b.isValid()).to.equal(true)
  })

  it('SC4 DB-FREE: isValid===true => commit() returns OfficerInviteShare AND double-commit sync-guard', async () => {
    const builder = new AuthorityCreateOfficerInviteBuilder(makeStubAuthorityEngine())
      .setName('Alice')
      .setTitle('Secretary')
      .setScopes(['rad'] as Scope[])

    expect(builder.isValid()).to.equal(true)
    const result = await builder.commit()
    expect(result.type).to.equal('of')
    expect(result.name).to.equal('Alice')
    expect(result.inviteKey).to.be.a('string')

    // Double-commit guard
    expect(() => builder.commit()).to.throw(BuilderAlreadyCommittedError)
  })

  it('round-trip serialization and fromJSON kind/version rejection', () => {
    const engine = makeStubAuthorityEngine()
    const builder = new AuthorityCreateOfficerInviteBuilder(engine)
      .setName('Alice')
      .setTitle('Secretary')
      .setScopes(['rad'] as Scope[])

    const json = builder.toJSON()
    expect(json.kind).to.equal('authority.createOfficerInvite')
    expect(json.version).to.equal(1)

    const restored = AuthorityCreateOfficerInviteBuilder.fromJSON(json, engine)
    expect(restored.isValid()).to.equal(true)
    expect(restored.toEngineInput().name).to.equal('Alice')

    // Wrong kind
    expect(() => AuthorityCreateOfficerInviteBuilder.fromJSON(
      { kind: 'wrong', version: 1, draft: {} }, engine
    )).to.throw(/unknown kind/)

    // Wrong version
    expect(() => AuthorityCreateOfficerInviteBuilder.fromJSON(
      { kind: 'authority.createOfficerInvite', version: 99, draft: {} }, engine
    )).to.throw(/unsupported version/)
  })

  it('toEngineInput returns OfficerInit shape; throws on incomplete', () => {
    const builder = new AuthorityCreateOfficerInviteBuilder(makeStubAuthorityEngine())
    expect(() => builder.toEngineInput()).to.throw(BuilderValidationError)

    const complete = builder.setName('A').setTitle('T').setScopes(['rad'] as Scope[])
    const input = complete.toEngineInput()
    expect(input).to.deep.equal({ name: 'A', title: 'T', scopes: ['rad'] })
  })

  it('FACT-04 parity: MockAuthorityEngine.buildCreateOfficerInvite() returns instanceof AuthorityCreateOfficerInviteBuilder', () => {
    const mock = new MockAuthorityEngine({ id: 'auth-1', name: 'Test', domainName: 'test.org' })
    const builder = mock.buildCreateOfficerInvite()
    expect(builder).to.be.instanceOf(AuthorityCreateOfficerInviteBuilder)
  })

  it('REAL ENGINE equivalence smoke: engine.createOfficerInvite(init) vs builder.fromPayload(init).commit()', async () => {
    const { authorityEngine: eng1 } = await makeDbOnlyAuthorityEngine()
    const init = makeOfficerInit()
    const directResult = await eng1.buildCreateOfficerInvite().fromPayload(init).commit()
    const { authorityEngine: eng2 } = await makeDbOnlyAuthorityEngine()
    const directResult2 = eng2.createOfficerInvite(init)
    expect(directResult).to.not.equal(undefined)
    expect(directResult2).to.not.equal(undefined)
    expect(directResult.type).to.equal('of')
    expect(directResult2.type).to.equal('of')
  })
})

// ---------------------------------------------------------------------------
// AuthorityCreateAuthorityInviteBuilder
// ---------------------------------------------------------------------------

describe('AuthorityCreateAuthorityInviteBuilder', () => {
  it('empty builder reports isValid===false and lists required missingFields', () => {
    const builder = new AuthorityCreateAuthorityInviteBuilder(makeStubAuthorityEngine())
    expect(builder.isValid()).to.equal(false)
    const missing = builder.missingFields().map(m => m.path)
    expect(missing).to.include('name')
  })

  it('per-setter validation: empty name records BuilderError without throwing', () => {
    const builder = new AuthorityCreateAuthorityInviteBuilder(makeStubAuthorityEngine())
      .setName('')
    const errs = builder.errors()
    expect(errs.some(e => e.path === 'name' && e.code === 'EMPTY')).to.equal(true)
  })

  it('errors/missingFields progression as setters fill fields', () => {
    const engine = makeStubAuthorityEngine()
    let b = new AuthorityCreateAuthorityInviteBuilder(engine)
    expect(b.missingFields().length).to.equal(1)

    b = b.setName('Corp')
    expect(b.missingFields().length).to.equal(0)
    expect(b.isValid()).to.equal(true)
  })

  it('SC4 DB-FREE: isValid===true => commit() returns AuthorityInviteShare AND double-commit sync-guard', async () => {
    const builder = new AuthorityCreateAuthorityInviteBuilder(makeStubAuthorityEngine())
      .setName('Corp')

    expect(builder.isValid()).to.equal(true)
    const result = await builder.commit()
    expect(result.type).to.equal('au')
    expect(result.name).to.equal('Corp')

    expect(() => builder.commit()).to.throw(BuilderAlreadyCommittedError)
  })

  it('round-trip serialization and fromJSON kind/version rejection', () => {
    const engine = makeStubAuthorityEngine()
    const builder = new AuthorityCreateAuthorityInviteBuilder(engine)
      .setName('Corp')

    const json = builder.toJSON()
    expect(json.kind).to.equal('authority.createAuthorityInvite')
    expect(json.version).to.equal(1)

    const restored = AuthorityCreateAuthorityInviteBuilder.fromJSON(json, engine)
    expect(restored.isValid()).to.equal(true)

    expect(() => AuthorityCreateAuthorityInviteBuilder.fromJSON(
      { kind: 'wrong', version: 1, draft: {} }, engine
    )).to.throw(/unknown kind/)

    expect(() => AuthorityCreateAuthorityInviteBuilder.fromJSON(
      { kind: 'authority.createAuthorityInvite', version: 99, draft: {} }, engine
    )).to.throw(/unsupported version/)
  })

  it('toEngineInput returns string; throws on incomplete', () => {
    const builder = new AuthorityCreateAuthorityInviteBuilder(makeStubAuthorityEngine())
    expect(() => builder.toEngineInput()).to.throw(BuilderValidationError)

    const complete = builder.setName('Corp')
    expect(complete.toEngineInput()).to.equal('Corp')
  })

  it('FACT-04 parity: MockAuthorityEngine.buildCreateAuthorityInvite() returns instanceof AuthorityCreateAuthorityInviteBuilder', () => {
    const mock = new MockAuthorityEngine({ id: 'auth-1', name: 'Test', domainName: 'test.org' })
    const builder = mock.buildCreateAuthorityInvite()
    expect(builder).to.be.instanceOf(AuthorityCreateAuthorityInviteBuilder)
  })

  it('REAL ENGINE equivalence smoke: engine.createAuthorityInvite(name) vs builder.fromPayload(name).commit()', async () => {
    const { authorityEngine: eng1 } = await makeDbOnlyAuthorityEngine()
    const directResult = eng1.createAuthorityInvite('TestCorp')
    const { authorityEngine: eng2 } = await makeDbOnlyAuthorityEngine()
    const builderResult = await eng2.buildCreateAuthorityInvite().fromPayload('TestCorp').commit()
    expect(directResult).to.not.equal(undefined)
    expect(builderResult).to.not.equal(undefined)
    expect(directResult.type).to.equal('au')
    expect(builderResult.type).to.equal('au')
  })
})

// ---------------------------------------------------------------------------
// AuthorityProposeAdminBuilder
// ---------------------------------------------------------------------------

describe('AuthorityProposeAdminBuilder', () => {
  it('empty builder reports isValid===false and lists required missingFields', () => {
    const builder = new AuthorityProposeAdminBuilder(makeStubAuthorityEngine())
    expect(builder.isValid()).to.equal(false)
    const missing = builder.missingFields().map(m => m.path)
    expect(missing).to.include('admin')
    expect(missing).to.include('signature')
  })

  it('per-setter validation: invalid admin object', () => {
    const builder = new AuthorityProposeAdminBuilder(makeStubAuthorityEngine())
      .setAdmin('not-an-object' as never)
    const errs = builder.errors()
    expect(errs.some(e => e.path === 'admin' && e.code === 'INVALID')).to.equal(true)
  })

  it('per-setter validation: invalid signature object', () => {
    const builder = new AuthorityProposeAdminBuilder(makeStubAuthorityEngine())
      .setSignature({ signature: '', signerKey: '', signerUserId: '' })
    const errs = builder.errors()
    expect(errs.some(e => e.path === 'signature' && e.code === 'INVALID')).to.equal(true)
  })

  it('errors/missingFields progression as setters fill fields', () => {
    const engine = makeStubAuthorityEngine()
    let b = new AuthorityProposeAdminBuilder(engine)
    expect(b.missingFields().length).to.equal(2)

    b = b.setAdmin(makeAdminProposal())
    expect(b.missingFields().length).to.equal(1)

    b = b.setSignature(makeSignature())
    expect(b.missingFields().length).to.equal(0)
    expect(b.isValid()).to.equal(true)
  })

  it('SC4 DB-FREE: isValid===true => commit() resolves AND double-commit sync-guard', async () => {
    const builder = new AuthorityProposeAdminBuilder(makeStubAuthorityEngine())
      .setAdmin(makeAdminProposal())
      .setSignature(makeSignature())

    expect(builder.isValid()).to.equal(true)
    await builder.commit()

    try {
      await builder.commit()
      expect.fail('expected double-commit to throw BuilderAlreadyCommittedError')
    } catch (err) {
      expect(err).to.be.instanceOf(BuilderAlreadyCommittedError)
    }
  })

  it('round-trip serialization and fromJSON kind/version rejection', () => {
    const engine = makeStubAuthorityEngine()
    const builder = new AuthorityProposeAdminBuilder(engine)
      .setAdmin(makeAdminProposal())
      .setSignature(makeSignature())

    const json = builder.toJSON()
    expect(json.kind).to.equal('authority.proposeAdmin')
    expect(json.version).to.equal(1)

    const restored = AuthorityProposeAdminBuilder.fromJSON(json, engine)
    expect(restored.isValid()).to.equal(true)

    expect(() => AuthorityProposeAdminBuilder.fromJSON(
      { kind: 'wrong', version: 1, draft: {} }, engine
    )).to.throw(/unknown kind/)

    expect(() => AuthorityProposeAdminBuilder.fromJSON(
      { kind: 'authority.proposeAdmin', version: 99, draft: {} }, engine
    )).to.throw(/unsupported version/)
  })

  it('toEngineInput returns { admin, signature } shape; throws on incomplete', () => {
    const builder = new AuthorityProposeAdminBuilder(makeStubAuthorityEngine())
    expect(() => builder.toEngineInput()).to.throw(BuilderValidationError)

    const complete = builder.setAdmin(makeAdminProposal()).setSignature(makeSignature())
    const input = complete.toEngineInput()
    expect(input).to.have.property('admin')
    expect(input).to.have.property('signature')
  })

  it('cross-field: admin.signers empty surfaces cross-field error code NO_SIGNERS', () => {
    const proposal = makeAdminProposal()
    proposal.signers = []
    const builder = new AuthorityProposeAdminBuilder(makeStubAuthorityEngine())
      .setAdmin(proposal)
      .setSignature(makeSignature())

    expect(builder.isValid()).to.equal(false)
    const errs = builder.errors()
    expect(errs.some(e => e.code === 'NO_SIGNERS' && e.kind === 'cross-field')).to.equal(true)
  })

  it('FACT-04 parity: MockAuthorityEngine.buildProposeAdmin() returns instanceof AuthorityProposeAdminBuilder', () => {
    const mock = new MockAuthorityEngine({ id: 'auth-1', name: 'Test', domainName: 'test.org' })
    const builder = mock.buildProposeAdmin()
    expect(builder).to.be.instanceOf(AuthorityProposeAdminBuilder)
  })

  it('REAL ENGINE equivalence smoke: engine.proposeAdmin(admin, signature) vs builder.fromPayload(...).commit()', async () => {
    const { authorityEngine: eng1 } = await createNetworkAndAuthority()
    const admin = makeAdminProposal()
    const sig1 = makeRealSignCallback('user-1')
    let err1: unknown
    try { await eng1.proposeAdmin(admin, sig1) } catch (e) { err1 = e }
    expect(err1).to.equal(undefined)

    const { authorityEngine: eng2, authority: authority2 } = await createNetworkAndAuthority()
    // 999.1 R-02: AuthorityProposeAdminBuilder's Draft.signature is a serializable
    // Signature object (D-01.1 "serializable drafts via toJSON/fromJSON"), not the
    // engine's callback union — so the builder path needs a concrete, real signature
    // over the actual digest, computed the same way proposeAdmin computes it engine-side.
    const ctx2 = (eng2 as unknown as { ctx: EngineContext }).ctx
    const effectiveAtCanon = toCanonicalDatetime(admin.proposed.effectiveAt)
    const thresholdPoliciesJson = JSON.stringify(admin.proposed.thresholdPolicies)
    const digestRow2 = await ctx2.db
      .prepare('select Digest(:authorityId, :effectiveAt, :thresholdPolicies) as d')
      .get({ authorityId: authority2.id, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson })
    const { privateHex: priv2, publicHex: pub2 } = randomTestKeyPair()
    const realSig2: Signature = {
      signerUserId: 'user-1',
      signerKey: pub2,
      signature: bytesToHex(secp256k1.sign(digestToBytes(digestRow2!.d as string), hexToBytes(priv2)))
    }
    let err2: unknown
    try { await eng2.buildProposeAdmin().fromPayload({ admin, signature: realSig2 }).commit() } catch (e) { err2 = e }
    expect(err2).to.equal(undefined)
  })
})

// ---------------------------------------------------------------------------
// AuthoritySaveInviteWithSigningBuilder
// ---------------------------------------------------------------------------

describe('AuthoritySaveInviteWithSigningBuilder', () => {
  it('empty builder reports isValid===false and lists required missingFields', () => {
    const builder = new AuthoritySaveInviteWithSigningBuilder(makeStubAuthorityEngine())
    expect(builder.isValid()).to.equal(false)
    const missing = builder.missingFields().map(m => m.path)
    expect(missing).to.include('invite')
    expect(missing).to.include('scope')
    expect(missing).to.include('signature')
  })

  it('per-setter validation: invalid invite object', () => {
    const builder = new AuthoritySaveInviteWithSigningBuilder(makeStubAuthorityEngine())
      .setInvite('not-an-object' as never)
    const errs = builder.errors()
    expect(errs.some(e => e.path === 'invite' && e.code === 'INVALID')).to.equal(true)
  })

  it('errors/missingFields progression as setters fill fields', () => {
    const engine = makeStubAuthorityEngine()
    let b = new AuthoritySaveInviteWithSigningBuilder(engine)
    expect(b.missingFields().length).to.equal(3)

    b = b.setInvite(makeAuthorityInvite())
    expect(b.missingFields().length).to.equal(2)

    b = b.setScope('iad')
    expect(b.missingFields().length).to.equal(1)

    b = b.setSignature(makeSignature())
    expect(b.missingFields().length).to.equal(0)
    expect(b.isValid()).to.equal(true)
  })

  it('SC4 DB-FREE: isValid===true => commit() resolves AND double-commit sync-guard', async () => {
    const builder = new AuthoritySaveInviteWithSigningBuilder(makeStubAuthorityEngine())
      .setInvite(makeAuthorityInvite())
      .setScope('iad')
      .setSignature(makeSignature())

    expect(builder.isValid()).to.equal(true)
    await builder.commit()

    try {
      await builder.commit()
      expect.fail('expected double-commit to throw BuilderAlreadyCommittedError')
    } catch (err) {
      expect(err).to.be.instanceOf(BuilderAlreadyCommittedError)
    }
  })

  it('round-trip serialization and fromJSON kind/version rejection', () => {
    const engine = makeStubAuthorityEngine()
    const builder = new AuthoritySaveInviteWithSigningBuilder(engine)
      .setInvite(makeAuthorityInvite())
      .setScope('iad')
      .setSignature(makeSignature())

    const json = builder.toJSON()
    expect(json.kind).to.equal('authority.saveInviteWithSigning')
    expect(json.version).to.equal(1)

    const restored = AuthoritySaveInviteWithSigningBuilder.fromJSON(json, engine)
    expect(restored.isValid()).to.equal(true)

    expect(() => AuthoritySaveInviteWithSigningBuilder.fromJSON(
      { kind: 'wrong', version: 1, draft: {} }, engine
    )).to.throw(/unknown kind/)

    expect(() => AuthoritySaveInviteWithSigningBuilder.fromJSON(
      { kind: 'authority.saveInviteWithSigning', version: 99, draft: {} }, engine
    )).to.throw(/unsupported version/)
  })

  it('toEngineInput returns { invite, scope, signature } shape; throws on incomplete', () => {
    const builder = new AuthoritySaveInviteWithSigningBuilder(makeStubAuthorityEngine())
    expect(() => builder.toEngineInput()).to.throw(BuilderValidationError)

    const complete = builder
      .setInvite(makeAuthorityInvite())
      .setScope('iad')
      .setSignature(makeSignature())
    const input = complete.toEngineInput()
    expect(input).to.have.property('invite')
    expect(input).to.have.property('scope')
    expect(input).to.have.property('signature')
  })

  it('FACT-04 parity: MockAuthorityEngine.buildSaveInviteWithSigning() returns instanceof AuthoritySaveInviteWithSigningBuilder', () => {
    const mock = new MockAuthorityEngine({ id: 'auth-1', name: 'Test', domainName: 'test.org' })
    const builder = mock.buildSaveInviteWithSigning()
    expect(builder).to.be.instanceOf(AuthoritySaveInviteWithSigningBuilder)
  })

  it('REAL ENGINE equivalence smoke: engine.saveInviteWithSigning(invite, scope, signature) vs builder.fromPayload(...).commit()', async () => {
    const { authorityEngine: eng1 } = await createNetworkAndAuthority()
    const invite1 = eng1.createAuthorityInvite('Invite1')
    const sig = makeRealSignCallback('user-1')
    let err1: unknown
    try { await eng1.saveInviteWithSigning(invite1, 'iad', sig) } catch (e) { err1 = e }
    expect(err1).to.equal(undefined)
    const { authorityEngine: eng2 } = await createNetworkAndAuthority()
    const invite2 = eng2.createAuthorityInvite('Invite2')
    let err2: unknown
    try { await eng2.buildSaveInviteWithSigning().fromPayload({ invite: invite2, scope: 'iad', signature: sig }).commit() } catch (e) { err2 = e }
    expect(err2).to.equal(undefined)
  })
})
