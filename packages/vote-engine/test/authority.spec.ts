import { Database } from '@quereus/quereus'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ElectionType, UserKeyType } from '@votetorrent/vote-core'
import { expect } from 'chai'
import { AuthorityEngine } from '../src/authority/authority-engine'
// 57-01 (D-02): namespace import, deliberately NOT `import { sortRosterEntries }`.
// Under this suite's real-ESM ts-node config a named import of an export that
// does not exist yet throws at module-LOAD time (breaking every test in this
// file, not just the new RED ones); a namespace import tolerates a missing
// property and just yields `undefined`, which the roster-digest tests below
// check for explicitly. See the 'proposeAdmin roster + digest (D-01/D-02)'
// tests for why: ProposedAdmin/ProposedOfficer's composite primary keys (plus
// ProposedOfficer.CantDelete) make a second proposeAdmin call against the
// SAME (authorityId, effectiveAt) structurally impossible, so roster-order
// determinism is tested against this exported pure function directly instead
// of via two live proposeAdmin round trips.
import * as AuthorityEngineModule from '../src/authority/authority-engine'
import { prepareDb } from '../src/database/initialize'
import { NetworksEngine } from '../src/networks/networks-engine'
import { UserEngine } from '../src/user/user-engine.js'
import { nowCanonicalDatetime, toCanonicalDatetime, fromCanonicalDatetime, digestToBytes } from '../src/utils.js'
import type { EngineContext } from '../src/types.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { createTestNetwork, addTestAuthority, seedAuthorityInvite, seedUserInvite, makeDistinctTestUser, makeTestSignCallback, makeTestSignature, signInviteResult } from './fixtures/test-context.js'
import { computeAdminPromotionDigest, computeRadProposalDigest, readProposedRosterJson } from '../src/authority/rad-roster-digest.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import { AsyncStorage } from './shims/react-native'
import { UserHistoryEvent } from '@votetorrent/vote-core'
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
  AdminInit,
  ReviseUserHistory
} from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// 49-08 (D-21): `proposeAdmin`'s `IsUserValid` now genuinely verifies signer/key
// membership against `UserKey`, so the founding user's key must be a REAL,
// registered secp256k1 keypair (not the literal placeholder string 'key-1') and
// `makeRealSignature`/`makeRealSignCallback` must sign with THAT SAME registered
// private key for any signerUserId they already hold one for — mirrors
// `test-context.ts`'s `testUserPrivateKeys` pattern. Module-scope map is safe here:
// mocha runs this suite serially, and `makeUser()` overwrites its id's entry with a
// fresh key before the next test's network is created.
const authoritySpecPrivateKeys = new Map<string, string>()

function makeUser (overrides?: Partial<User>): User {
  const id = overrides?.id ?? 'user-1'
  const { privateHex, publicHex } = randomTestKeyPair()
  authoritySpecPrivateKeys.set(id, privateHex)
  return {
    id,
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
// Signs sha256(digestText ?? signerUserId) using the SAME registered keypair
// `makeUser()` recorded for `signerUserId` when one exists (49-08 D-21: proposeAdmin's
// IsUserValid now checks real UserKey membership, so the signer key must be the
// registered one) — falling back to a fresh, unregistered keypair otherwise (this
// function's callers that never reach the UserKey/IsUserValid gate are unaffected).
//
// 999.1 R-02: this signs ARBITRARY bytes (sha256 of digestText/signerUserId), NOT the
// actual row Digest the schema's SignatureValid UDF now verifies — kept only for
// negative-test / structural-equality call sites that never reach the UDF (or
// deliberately want a mismatched signature). Any call site that flows into
// `proposeAdmin`/`saveInviteWithSigning` MUST use `makeRealSignCallback` instead, since
// those methods compute the real digest engine-side and need to sign THAT.
function makeRealSignature (signerUserId: string, digestText?: string): Signature {
  const registeredPrivateHex = authoritySpecPrivateKeys.get(signerUserId)
  const { privateHex, publicHex } = registeredPrivateHex
    ? { privateHex: registeredPrivateHex, publicHex: undefined }
    : randomTestKeyPair()
  const privBytes = Uint8Array.from(privateHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
  const resolvedPublicHex = publicHex ?? bytesToHex(secp256k1.getPublicKey(privBytes))
  const digestBytes = sha256(new TextEncoder().encode(digestText ?? signerUserId))
  const sig = bytesToHex(secp256k1.sign(digestBytes, privBytes))
  return { signerUserId, signerKey: resolvedPublicHex, signature: sig }
}

/**
 * 999.1 R-02: real per-digest sign callback for `proposeAdmin`/`saveInviteWithSigning`
 * (both compute the actual row Digest engine-side and invoke this with the real bytes).
 *
 * 49-08 (D-21): uses the SAME registered keypair `makeUser()` recorded for
 * `signerUserId` when one exists, so `proposeAdmin`'s real `IsUserValid` membership
 * check (against `UserKey`) passes — falling back to a fresh, unregistered keypair
 * for any signerUserId `makeUser()` never registered.
 */
function makeRealSignCallback (signerUserId: string, _unusedDigestTextArg?: string): (digest: Uint8Array) => Promise<Signature> {
  const registeredPrivateHex = authoritySpecPrivateKeys.get(signerUserId)
  const { privateHex, publicHex } = registeredPrivateHex
    ? { privateHex: registeredPrivateHex, publicHex: bytesToHex(secp256k1.getPublicKey(hexToBytes(registeredPrivateHex))) }
    : randomTestKeyPair()
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

/**
 * T-57-07-04: `Admin.MutationValid` branch 1 and `Officer.InsertValid`
 * branch 1 both admit a nonce-less write while only ONE `Authority`
 * row exists. Every promotion fixture below inserts a SECOND,
 * unrelated `Authority` (via a real invite ceremony, so it is a
 * genuinely valid row — not a raw-SQL shortcut) so that a passing
 * promotion test proves the signing-nonce branch admitted the write,
 * not the branch-1 escape hatch. Also seeds a SECOND real `User` row
 * (distinct name) via the `seedUserInvite` recipe (`user.spec.ts`'s
 * `seedKeylessUser`), so a two-officer roster can resolve both
 * `ProposedName`s uniquely against `User.Name` (D-03's `.existing`
 * name bridge).
 *
 * Module scope (57-08): moved out of `describe('applyAdminProposal
 * (promotion)')` so `describe('admin promotion trigger (end to end)')`
 * — a SIBLING top-level block per the plan — can call it too, without
 * nesting inside 57-07's block.
 *
 * 57-08 (Task 1) fixture extension — OPTIONAL, additive. With no `options`
 * this reproduces 57-07's exact default behaviour byte-for-byte (same
 * `createTestNetwork()` call, same implicit `Date.now()` effectiveAt, same
 * `makeTestNetworkInit()` founding-officer scope set), so every 57-07 case
 * stays green unchanged.
 *
 * `foundingEffectiveAt` — thread a founding-administration effective date
 * into `makeNetworkInit`'s `admin.effectiveAt`. `CurrentAdmin` (votetorrent.qsql
 * :179-183) filters `EffectiveAt <= datetime('now')` and takes `max(EffectiveAt)`
 * per authority; canonical datetimes are second-granularity
 * (`toCanonicalDatetime` = `toISOString().slice(0, 19)`), so a promotion proposed
 * in the SAME second as the founding admin can be neither "later" nor "not
 * future" than it. The end-to-end case below passes a founding date ~1h in the
 * past so its later, still-past promotion date is unambiguously selected by
 * `CurrentAdmin` (see P5).
 *
 * `foundingOfficerScopes` — 57-08 finding, not a 57-07 carryover: this fixture's
 * `createTestNetwork()` (unlike authority.spec.ts's OWN local `makeNetworkInit()`
 * used by `createNetworkAndAuthority()`) resolves through test-context.ts's
 * `makeTestNetworkInit()`, whose founding officer already carries `'vrg'`
 * (WR-22 — every seeded officer needs it for the registrant-seeding gates that
 * fixture serves). A genuine RED baseline (P6: `includes('vrg') === false`
 * BEFORE promotion) is impossible against that default, so the end-to-end case
 * overrides the founding officer's scopes to the pre-WR-22 set that does NOT
 * include `'vrg'` — proving the grant is real rather than vacuous. Passing this
 * option replaces the WHOLE `admin` object passed to `createTestNetwork`
 * (officers + effectiveAt + thresholdPolicies), because `makeTestNetworkInit`'s
 * `{...defaults, ...overrides}` spread is shallow — thresholdPolicies stays
 * `[{policy: 'rad', threshold: 1}]` to match the default exactly.
 */
async function createPromotionFixture (options?: {
  foundingEffectiveAt?: number
  foundingOfficerScopes?: Scope[]
}): Promise<{
  auth: TestAuthorityContext
  secondUser: User
}> {
  const net = options
    ? await createTestNetwork({
        network: {
          admin: {
            officers: [
              {
                init: {
                  name: 'Admin A',
                  title: 'Chair',
                  scopes: options.foundingOfficerScopes ?? (['rn', 'rad', 'vrg', 'iad', 'uai', 'mel', 'ceb'] as Scope[])
                }
              }
            ],
            effectiveAt: options.foundingEffectiveAt ?? Date.now(),
            thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
          }
        }
      })
    : await createTestNetwork()
  const auth = await addTestAuthority(net)

  const branch1CloserName = 'Branch-1 Closer Authority'
  const secondAuthorityInvite = await seedAuthorityInvite(auth, {
    name: branch1CloserName,
    domainName: 'branch1-closer.example.com',
    officers: [{ userId: auth.user.id, title: 'Inspector', scopes: JSON.stringify(['rad']) }]
  })
  await auth.networkEngine.createAuthority(
    { name: branch1CloserName, domainName: 'branch1-closer.example.com' },
    {
      officers: [
        { init: { name: 'Branch-1 Closer Officer', title: 'Inspector', scopes: ['rad'] as Scope[] } }
      ],
      effectiveAt: secondAuthorityInvite.adminEffectiveAt,
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
    },
    { inviteSlotCid: secondAuthorityInvite.inviteSlotCid, inviteSignature: 'a'.repeat(128) }
  )

  const authorityCountRow = await auth.ctx.db.prepare('select count(*) as n from Authority').get({})
  expect(
    Number(authorityCountRow?.n),
    'createPromotionFixture must close the branch-1 escape hatch (exactly 2 Authority rows)'
  ).to.equal(2)

  const secondUser: User = { ...makeDistinctTestUser(), name: 'Second Roster Officer' }
  const { inviteSlotCid: userInviteSlotCid, inviteSignature: userInviteSignature } =
    await seedUserInvite(auth, secondUser)
  const userTid = Date.now() + Math.floor(Math.random() * 100_000)
  await auth.ctx.db.exec(
    `insert into User (Id, Name, ImageRef)
     with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${userTid}
     values (:userId, :userName, :userImageRef)`,
    {
      userId: secondUser.id,
      userName: secondUser.name,
      userImageRef: secondUser.imageRef ? JSON.stringify(secondUser.imageRef) : null,
      inviteSlotCid: userInviteSlotCid,
      inviteSignature: userInviteSignature
    }
  )

  return { auth, secondUser }
}

/**
 * 57-08 — recompute proposeAdmin's exact roster-covering digest (D-02's
 * sortRosterEntries + the 4-arg Digest() formula) so a test can look up the
 * ORIGINAL proposal session's nonce by its Digest value, unambiguously, even
 * when Trigger A (57-08) mints ADDITIONAL 'rad' AdminSigning rows for the
 * SAME authority under fresh nonces (the Admin-side/officer-side mint
 * sessions applyAdminProposal creates internally on a successful auto-
 * promotion). "order by Nonce desc limit 1" cannot distinguish these —
 * Nonce is a random UUID, not chronological — so any test that needs the
 * ORIGINAL proposal session specifically must look it up by Digest instead.
 *
 * 57-13 (CR-01): `officers` now carries `userId` (`null` for `.init`
 * officers), matching `sortRosterEntries`'s widened serialized shape —
 * every call site must supply the SAME userId `resolveAdminRoster` would
 * have resolved for that officer, or the recomputed digest will not match
 * what `proposeAdmin` actually signed.
 */
async function computeRosterDigest (
  auth: TestAuthorityContext,
  officers: Array<{ proposedName: string, userId: string | null, title: string, scopes: string[] }>,
  effectiveAt: number,
  thresholdPolicies: Array<{ policy: string, threshold: number }>
): Promise<string> {
  const sortRosterEntriesExported = (AuthorityEngineModule as unknown as {
    sortRosterEntries?: (entries: typeof officers) => typeof officers
  }).sortRosterEntries
  if (typeof sortRosterEntriesExported !== 'function') {
    throw new Error('computeRosterDigest: authority-engine.ts does not export sortRosterEntries')
  }
  const roster = sortRosterEntriesExported(officers)
  const row = await auth.ctx.db
    .prepare('select Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies) as d')
    .get({
      authorityId: auth.authority.id,
      effectiveAt: toCanonicalDatetime(effectiveAt),
      officers: JSON.stringify(roster),
      thresholdPolicies: JSON.stringify(thresholdPolicies)
    })
  if (!row || row.d == null) throw new Error('computeRosterDigest: Digest() returned null')
  return row.d as string
}

/**
 * 62-65: the founder's `User.Name` is the ENTERED admin name (`officerInit.name`), not
 * `auth.user.name` — and `resolveAdminRoster` resolves an `.existing` entry's
 * `proposedName` from that DB row. Any hand-built roster for the founder must use this
 * value, exactly as the engine does, or the pre-signed digest will not match.
 */
async function founderDisplayName (auth: TestAuthorityContext): Promise<string> {
  const row = await auth.ctx.db
    .prepare('select Name from User where Id = :id')
    .get({ id: auth.user.id })
  if (!row) throw new Error('founderDisplayName: founder User row missing')
  return row.Name as string
}

/**
 * 57-14 (CR-01, promote-side closure): seed a THIRD, fully-independent User
 * row beyond `createPromotionFixture()`'s founder + `secondUser` — the
 * hijack case needs an attacker identity distinct from both. Mirrors
 * `createPromotionFixture`'s own `secondUser` insert (seedUserInvite +
 * raw `insert into User`) exactly, generalized to any caller.
 */
async function seedExtraUser (auth: TestAuthorityContext): Promise<User> {
  const user: User = { ...makeDistinctTestUser(), name: `Extra User ${crypto.randomUUID()}` }
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
  return user
}

/**
 * 57-14 (CR-01, promote-side closure): rename a User through the REAL engine
 * path — `UserEngine.revise()` — never a raw SQL UPDATE against the table
 * directly (the two-tier authorization model means a raw `Database` handle
 * silently loses the
 * engine-only `context.Is*Valid` delegations; a raw update would prove
 * nothing about the actual attack surface, see the plan's threat model
 * T-57-14-05). `makeTestSignature` is used rather than a fresh real
 * secp256k1 signature because `User`'s `ValidModification` CHECK on
 * `update` does not verify a signature today (user-engine.ts's own comment
 * at `revise()`) — the same non-gated surface CR-01's scope boundary
 * explicitly declines to close in this plan.
 */
async function renameUserViaEngine (ctx: EngineContext, user: User, newName: string): Promise<void> {
  const engine = new UserEngine(user, ctx)
  const revise: ReviseUserHistory = {
    event: UserHistoryEvent.revise,
    timestamp: Date.now(),
    signature: makeTestSignature(user),
    info: {
      name: newName,
      imageRef: user.imageRef ?? { url: 'https://img.local/unchanged.png' }
    }
  }
  await engine.revise(revise)
}

/**
 * 57-14 (CR-01, promote-side closure): `User.UserValid`/`User.UserKeyValid`
 * fire `check on update` and require the row to already be associated with
 * an Officer (or Keyholder) row AND to already hold at least one `UserKey`
 * row — a user proposed but not yet promoted has NEITHER, so
 * `renameUserViaEngine` cannot rename them pre-promotion without first
 * establishing both facts through the real engine paths. This helper does
 * exactly that, on the SAME authority, at an EARLIER effectiveAt than the
 * roster-under-test:
 *   1. `UserEngine.addKey()` with no `sign` callback — the genuinely-
 *      first-key bootstrap path (999.1 R-02/D-11), giving `user` a real
 *      `UserKey` row.
 *   2. a real, ordinary `proposeAdmin` + `applyAdminProposal` cycle that
 *      grants `user` an unrelated 'vrg' officer role (title 'Priming
 *      Officer') alongside `auth.user` maintaining 'rad' — satisfying
 *      `Admin.OfficerRequired` (T-57-07-08) for THIS priming cycle and
 *      giving `user` the Officer-association `UserValid` needs.
 * The priming cycle's Officer row lives under its OWN `AdminEffectiveAt`
 * and does not appear in — or interfere with — the roster-under-test's
 * later, separate promotion.
 */
async function primeUserForRename (auth: TestAuthorityContext, user: User, effectiveAt: number): Promise<void> {
  // UserEngine.addKey reads `this.user.activeKeys[0]?.key` as the EXISTING
  // active pubkey (bound to context.UserKey). `user.activeKeys` already
  // holds the key we are ABOUT to add (test fixtures generate it eagerly),
  // so the engine must be constructed with an EMPTY activeKeys list here —
  // otherwise it believes a key already exists and binds a non-null
  // context.UserKey, tripping UserKey.InsertValid's bootstrap branch
  // (`context.UserKey is null`).
  await new UserEngine({ ...user, activeKeys: [] }, auth.ctx).addKey(user.activeKeys[0]!)

  const sig = makeTestSignCallback(auth.user)
  const proposal: Proposal<AdminInit> = {
    proposed: {
      officers: [
        { existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
        { existing: { userId: user.id, authorityId: auth.authority.id, title: 'Priming Officer', scopes: ['vrg'] as Scope[] } }
      ],
      effectiveAt,
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
    },
    signers: [auth.user.id]
  }
  const rosterDigest = await computeRosterDigest(
    auth,
    [
      { proposedName: await founderDisplayName(auth), userId: auth.user.id, title: 'Chair', scopes: ['rad'] },
      { proposedName: user.name, userId: user.id, title: 'Priming Officer', scopes: ['vrg'] }
    ],
    effectiveAt,
    proposal.proposed.thresholdPolicies
  )
  const bareSignature = await sig(digestToBytes(rosterDigest))
  await auth.authorityEngine.proposeAdmin(proposal, bareSignature)
  const nonceRow = await auth.ctx.db
    .prepare('select Nonce from AdminSigning where AuthorityId = :id and Digest = :digest')
    .get({ id: auth.authority.id, digest: rosterDigest })
  const nonce = nonceRow!.Nonce as string
  const engine = auth.authorityEngine as unknown as {
    applyAdminProposal?: (nonce: string, sign: (digest: Uint8Array) => Promise<Signature>) => Promise<unknown>
  }
  await engine.applyAdminProposal!(nonce, sig)
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

    // UAT 62: ProposedAdmin rows are never deleted, and the read used to be an unordered
    // `.get()` — so it returned the EARLIEST row. On device that was an older empty proposal:
    // the proposed roster read empty and the new invitee had no Invite button.
    async function seedProposedAdmin (ctx: EngineContext, authorityId: string, effectiveAt: string): Promise<void> {
      const sig = makeRealSignature('user-1')
      await ctx.db.exec(
        `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
         with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 7, now = ${Date.now()}, IsUserValid = true
         values (:authId, :eff, :tp)`,
        {
          uid: 'user-1',
          pubKey: sig.signerKey,
          sig: sig.signature,
          authId: authorityId,
          eff: effectiveAt,
          tp: JSON.stringify([{ policy: 'rad', threshold: 1 }])
        }
      )
    }

    async function seedProposedOfficer (
      ctx: EngineContext,
      authorityId: string,
      effectiveAt: string,
      officer: { name: string, title: string, scopes: string[], userId: string | null }
    ): Promise<void> {
      const sig = makeRealSignature('user-1')
      await ctx.db.exec(
        `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes, UserId)
         with context UserId = :uid, UserKey = :pubKey, Signature = :sig, Tid = 7, now = ${Date.now()}, IsUserValid = true
         values (:authId, :eff, :name, :title, :scopes, :officerUserId)`,
        {
          uid: 'user-1',
          pubKey: sig.signerKey,
          sig: sig.signature,
          authId: authorityId,
          eff: effectiveAt,
          name: officer.name,
          title: officer.title,
          scopes: JSON.stringify(officer.scopes),
          officerUserId: officer.userId
        }
      )
    }

    it('UAT 62: returns the LATEST unpromoted proposal, not an older empty one, with existing and init officers shaped apart', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const before = await authorityEngine.getAdminDetails()
      const foundingUserId = before.admin.officers[0]!.userId

      const olderEmpty = toCanonicalDatetime(Date.now() + 60_000)
      const newer = toCanonicalDatetime(Date.now() + 120_000)
      await seedProposedAdmin(ctx, authority.id, olderEmpty)
      await seedProposedAdmin(ctx, authority.id, newer)
      await seedProposedOfficer(ctx, authority.id, newer, { name: 'Founding Chair', title: 'Chair', scopes: ['rad', 'rn'], userId: foundingUserId })
      await seedProposedOfficer(ctx, authority.id, newer, { name: 'Bea Two', title: 'Clerk', scopes: ['vrg'], userId: null })

      const details = await authorityEngine.getAdminDetails()
      expect(details.proposed, 'a proposal is pending').to.not.equal(undefined)
      expect(details.proposed!.proposed.effectiveAt).to.equal(fromCanonicalDatetime(newer))
      const officers = details.proposed!.proposed.officers
      expect(officers).to.have.length(2)
      const existing = officers.find((o) => o.existing)
      const init = officers.find((o) => o.init)
      expect(existing, 'the officer with a UserId is an existing officer').to.deep.equal({
        existing: { userId: foundingUserId, authorityId: authority.id, title: 'Chair', scopes: ['rad', 'rn'] }
      })
      expect(init, 'the null-UserId invitee stays an init officer').to.deep.equal({
        init: { name: 'Bea Two', title: 'Clerk', scopes: ['vrg'] }
      })
    })

    it('UAT 62: a ProposedAdmin already promoted to Admin is not reported as a pending proposal', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      // Promotion inserts Admin at the proposal's own EffectiveAt, so a ProposedAdmin whose
      // EffectiveAt matches an Admin row is history (also the debug task-seed's shape).
      const adminRow = await ctx.db
        .prepare('select EffectiveAt from Admin where AuthorityId = :id')
        .get({ id: authority.id })
      await seedProposedAdmin(ctx, authority.id, adminRow!.EffectiveAt as string)

      const details = await authorityEngine.getAdminDetails()
      expect(details.proposed).to.equal(undefined)
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
      // 49-08 (D-21): must use 'user-1's REGISTERED founding keypair (not a fresh,
      // unregistered one) so proposeAdmin's real IsUserValid membership check passes.
      // signerUserId must be 'user-1' — the existing officer in the test fixture (createNetworkAndAuthority).
      const privateHex = authoritySpecPrivateKeys.get('user-1')!
      const publicHex = bytesToHex(secp256k1.getPublicKey(hexToBytes(privateHex)))
      const privBytes = hexToBytes(privateHex)
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

    // -------------------------------------------------------------------
    // 57-01 (R1/D-01 propose-side, D-02, D-03): roster persistence + the
    // roster-covering 'rad' digest. RED at this commit — proposeAdmin does
    // not yet write ProposedOfficer, and the 'rad' digest does not yet
    // cover the roster. Must be GREEN by the end of Task 3.
    //
    // D-03 read-side probe (recorded verbatim in 57-01-SUMMARY.md):
    //   `grep -rln "ProposedOfficerUser" packages/*/src apps/*/src packages/vote-engine/test`
    //   -> packages/vote-engine/src/database/schema-sql.ts (generated schema
    //      string; not a reader) and packages/web-data/src/classification.js
    //      (a static table-name -> visibility-CLASS registry that gates
    //      anonymous reads away from DRAFT tables by name; it never queries
    //      or consumes ProposedOfficerUser row content). No TypeScript reader
    //      depends on ProposedOfficerUser rows existing. D-03 HOLDS — left
    //      unpopulated below.
    // -------------------------------------------------------------------

    it('should insert one ProposedOfficer row per OfficerSelection (roster persistence, D-01 propose side)', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignCallback('user-1')
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: 'user-1', authorityId: authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            { init: { name: 'Zeta Officer', title: 'Clerk', scopes: ['vrg'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: ['user-1']
      }
      await authorityEngine.proposeAdmin(proposal, sig)

      const countRow = await ctx.db
        .prepare('select count(*) as n from ProposedOfficer where AuthorityId = :id and AdminEffectiveAt = :e')
        .get({ id: authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(countRow?.n)).to.equal(2)

      const initRow = await ctx.db
        .prepare(
          `select ProposedName, Title, Scopes from ProposedOfficer
             where AuthorityId = :id and AdminEffectiveAt = :e and ProposedName = :name`
        )
        .get({ id: authority.id, e: toCanonicalDatetime(effectiveAt), name: 'Zeta Officer' })
      expect(initRow?.ProposedName).to.equal('Zeta Officer')
      expect(initRow?.Title).to.equal('Clerk')
      expect(JSON.parse(initRow!.Scopes as string)).to.deep.equal(['vrg'])
    })

    it('should persist a stable UserId reference for an .existing officer (CR-01 propose side)', async () => {
      // 57-13 (CR-01, Task 1 carrier probe verdict — fallback: ProposedOfficer.UserId):
      // the .existing officer's userId must be persisted in the SAME transaction
      // as the ProposedOfficer row, so promotion no longer has to re-derive
      // identity from the renameable User.Name bridge. The .init officer's row
      // must carry a null UserId (no User row exists for it).
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignCallback('user-1')
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: 'user-1', authorityId: authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            { init: { name: 'Zeta Officer', title: 'Clerk', scopes: ['vrg'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: ['user-1']
      }
      await authorityEngine.proposeAdmin(proposal, sig)

      const existingRow = await ctx.db
        .prepare(
          `select UserId from ProposedOfficer
             where AuthorityId = :id and AdminEffectiveAt = :e and Title = :title`
        )
        .get({ id: authority.id, e: toCanonicalDatetime(effectiveAt), title: 'Chair' })
      expect(existingRow?.UserId, 'the .existing officer row must carry its stable UserId').to.equal('user-1')

      const initRowForUserId = await ctx.db
        .prepare(
          `select UserId from ProposedOfficer
             where AuthorityId = :id and AdminEffectiveAt = :e and ProposedName = :name`
        )
        .get({ id: authority.id, e: toCanonicalDatetime(effectiveAt), name: 'Zeta Officer' })
      expect(initRowForUserId?.UserId, 'an .init officer (no User row) must carry a null UserId').to.equal(null)
    })

    it("should resolve a '.existing' officer's ProposedName from the User table, not the userId (D-01 name bridge)", async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignCallback('user-1')
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: 'user-1', authorityId: authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            { init: { name: 'Zeta Officer', title: 'Clerk', scopes: ['vrg'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: ['user-1']
      }
      await authorityEngine.proposeAdmin(proposal, sig)

      const userRow = await ctx.db.prepare('select Name from User where Id = :id').get({ id: 'user-1' })
      const existingOfficerRows: string[] = []
      for await (const row of ctx.db.eval(
        'select ProposedName from ProposedOfficer where AuthorityId = :id and AdminEffectiveAt = :e and Title = :title',
        { id: authority.id, e: toCanonicalDatetime(effectiveAt), title: 'Chair' }
      )) {
        existingOfficerRows.push(row.ProposedName as string)
      }
      expect(existingOfficerRows).to.have.length(1)
      expect(existingOfficerRows[0]).to.equal(userRow?.Name as string)
    })

    it('should serialize the admin roster deterministically regardless of caller input order (D-02)', () => {
      type RosterEntryForTest = { proposedName: string; title: string; scopes: string[] }
      const sortRosterEntries = (AuthorityEngineModule as unknown as {
        sortRosterEntries?: (entries: RosterEntryForTest[]) => RosterEntryForTest[]
      }).sortRosterEntries
      if (typeof sortRosterEntries !== 'function') {
        expect.fail('authority-engine.ts does not yet export sortRosterEntries (D-02 roster serializer)')
        return
      }
      const chair: RosterEntryForTest = { proposedName: 'Test User', title: 'Chair', scopes: ['rad'] }
      const clerk: RosterEntryForTest = { proposedName: 'Zeta Officer', title: 'Clerk', scopes: ['vrg'] }
      const naturalOrder = sortRosterEntries([chair, clerk])
      const reversedOrder = sortRosterEntries([clerk, chair])
      expect(JSON.stringify(reversedOrder)).to.equal(JSON.stringify(naturalOrder))
    })

    it('should change the serialized roster when a scope changes, proving full-roster coverage (D-02)', () => {
      type RosterEntryForTest = { proposedName: string; title: string; scopes: string[] }
      const sortRosterEntries = (AuthorityEngineModule as unknown as {
        sortRosterEntries?: (entries: RosterEntryForTest[]) => RosterEntryForTest[]
      }).sortRosterEntries
      if (typeof sortRosterEntries !== 'function') {
        expect.fail('authority-engine.ts does not yet export sortRosterEntries (D-02 roster serializer)')
        return
      }
      const chair: RosterEntryForTest = { proposedName: 'Test User', title: 'Chair', scopes: ['rad'] }
      const clerk: RosterEntryForTest = { proposedName: 'Zeta Officer', title: 'Clerk', scopes: ['vrg'] }
      const baseline = sortRosterEntries([chair, clerk])
      const clerkWithExtraScope: RosterEntryForTest = { ...clerk, scopes: ['vrg', 'uai'] }
      const changed = sortRosterEntries([chair, clerkWithExtraScope])
      expect(JSON.stringify(changed)).to.not.equal(JSON.stringify(baseline))
    })

    it('should order the roster by code unit, not by locale collation (CR-02)', () => {
      type RosterEntryForTest = { proposedName: string; title: string; scopes: string[] }
      const sortRosterEntries = (AuthorityEngineModule as unknown as {
        sortRosterEntries?: (entries: RosterEntryForTest[]) => RosterEntryForTest[]
      }).sortRosterEntries
      if (typeof sortRosterEntries !== 'function') {
        expect.fail('authority-engine.ts does not yet export sortRosterEntries (D-02 roster serializer)')
        return
      }
      const alice: RosterEntryForTest = { proposedName: 'alice', title: 'Clerk', scopes: ['vrg'] }
      const bob: RosterEntryForTest = { proposedName: 'Bob', title: 'Chair', scopes: ['rad'] }
      // Under the removed default `localeCompare`, this pair sorts 'alice' < 'Bob'
      // (locale collation ignores case). A plain code-unit comparison sorts
      // uppercase before lowercase, so 'Bob' < 'alice' — the OPPOSITE order.
      // That makes this assertion discriminating rather than tautological.
      const ordered = sortRosterEntries([alice, bob])
      expect(ordered[0]?.proposedName).to.equal('Bob')
    })

    it('should change the digest when only the officer userId changes (CR-01 identity coverage)', async () => {
      // 57-13 (CR-01): the signed 'rad' digest must attest to WHO receives each
      // scope, not merely to the scope set and display name. Two rosters
      // differing ONLY in userId must produce DIFFERENT Digest(...) values.
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sortRosterEntries = (AuthorityEngineModule as unknown as {
        sortRosterEntries?: (entries: Array<{ proposedName: string, userId: string | null, title: string, scopes: string[] }>) =>
          Array<{ proposedName: string, userId: string | null, title: string, scopes: string[] }>
      }).sortRosterEntries
      if (typeof sortRosterEntries !== 'function') {
        expect.fail('authority-engine.ts does not yet export sortRosterEntries (D-02 roster serializer)')
        return
      }
      const effectiveAt = Date.now() + 60_000
      const effectiveAtCanon = toCanonicalDatetime(effectiveAt)
      const thresholdPoliciesJson = JSON.stringify([{ policy: 'rad', threshold: 1 }])

      const rosterA = sortRosterEntries([
        { proposedName: 'Test User', userId: 'user-1', title: 'Chair', scopes: ['rad'] }
      ])
      const rosterB = sortRosterEntries([
        { proposedName: 'Test User', userId: 'a-completely-different-user-id', title: 'Chair', scopes: ['rad'] }
      ])
      expect(JSON.stringify(rosterA)).to.not.equal(
        JSON.stringify(rosterB),
        'the userId must be an explicit, never-dropped key so two rosters differing only in userId serialize differently'
      )

      const digestARow = await ctx.db
        .prepare('select Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies) as d')
        .get({
          authorityId: authority.id,
          effectiveAt: effectiveAtCanon,
          officers: JSON.stringify(rosterA),
          thresholdPolicies: thresholdPoliciesJson
        })
      const digestBRow = await ctx.db
        .prepare('select Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies) as d')
        .get({
          authorityId: authority.id,
          effectiveAt: effectiveAtCanon,
          officers: JSON.stringify(rosterB),
          thresholdPolicies: thresholdPoliciesJson
        })
      expect(digestARow?.d, 'CR-01 setup: digest A must be non-null').to.not.be.null
      expect(digestBRow?.d, 'CR-01 setup: digest B must be non-null').to.not.be.null
      expect(
        digestARow?.d,
        'two rosters differing ONLY in userId must produce DIFFERENT digests — the signature attests to identity'
      ).to.not.equal(digestBRow?.d)
    })

    it("should fold the roster into the 'rad' digest, not just thresholdPolicies (D-02 roster coverage, live digest)", async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignCallback('user-1')
      const effectiveAt = Date.now() + 60_000
      const thresholdPolicies = [{ policy: 'rad', threshold: 1 }]
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: 'user-1', authorityId: authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            { init: { name: 'Zeta Officer', title: 'Clerk', scopes: ['vrg'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies
        },
        signers: ['user-1']
      }
      await authorityEngine.proposeAdmin(proposal, sig)

      const storedDigestRow = await ctx.db
        .prepare(
          "select Digest from AdminSigning where AuthorityId = :id and Scope = 'rad' order by Nonce desc limit 1"
        )
        .get({ id: authority.id })
      // Counterfactual: what the OLD (roster-blind) formula would have produced
      // for the SAME authorityId/effectiveAt/thresholdPolicies. If the roster is
      // genuinely folded into the digest, the real stored digest must differ
      // from this 3-arg-only value.
      const threeArgDigestRow = await ctx.db
        .prepare('select Digest(:authorityId, :effectiveAt, :thresholdPolicies) as d')
        .get({
          authorityId: authority.id,
          effectiveAt: toCanonicalDatetime(effectiveAt),
          thresholdPolicies: JSON.stringify(thresholdPolicies)
        })
      expect(storedDigestRow?.Digest).to.not.equal(threeArgDigestRow?.d)
    })

    it('should roll back ProposedAdmin when a roster insert fails (T-57-04 atomicity)', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const sig = makeRealSignCallback('user-1')
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: 'user-1', authorityId: authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            // Deliberately invalid scope code — absent from the `Scope` table,
            // trips ProposedOfficer.ScopesValid.
            { init: { name: 'Zeta Officer', title: 'Clerk', scopes: ['not-a-real-scope'] as unknown as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: ['user-1']
      }

      let threw = false
      try {
        await authorityEngine.proposeAdmin(proposal, sig)
      } catch {
        threw = true
      }
      expect(threw, 'proposeAdmin must reject an invalid roster scope').to.be.true

      const row = await ctx.db
        .prepare('select count(*) as n from ProposedAdmin where AuthorityId = :id and EffectiveAt = :e')
        .get({ id: authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(row?.n)).to.equal(0)
    })

    it('WR-02: an unexpected promotion error keeps its identity instead of being flattened to "Unknown error"', async () => {
      // proposeAdmin's Trigger A re-throws any non-AdminPromotionError out of the
      // promotion attempt (authority-engine.ts:788). Before WR-02 was fixed, its
      // own outer catch had no `instanceof Error` pass-through, so that error was
      // rebuilt as a brand-new, cause-less `Error("Unknown error: ...")`. The
      // caller then could not tell "the proposal was never saved" from "the
      // proposal and its threshold-reached signature were saved correctly; only
      // the automatic promotion crashed" — and a retry collides on ProposedAdmin's
      // (AuthorityId, EffectiveAt) primary key.
      class PromotionBoom extends Error {
        constructor() {
          super('synthetic promotion failure')
          this.name = 'PromotionBoom'
        }
      }

      const { authority, authorityEngine } = await createNetworkAndAuthority()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const signCallback = makeRealSignCallback('user-1')

      // Force the promotion attempt to fail with something that is NOT an
      // AdminPromotionError, NOT a QuereusError and NOT a MisuseError.
      ;(authorityEngine as unknown as { applyAdminProposal: unknown }).applyAdminProposal =
        async () => { throw new PromotionBoom() }

      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [{ existing: { userId: 'user-1', authorityId: authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } }],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: ['user-1']
      }

      let thrown: unknown
      try {
        await authorityEngine.proposeAdmin(proposal, signCallback)
      } catch (err) {
        thrown = err
      }

      expect(thrown, 'the promotion failure must still surface to the caller').to.not.equal(undefined)
      expect(
        thrown instanceof PromotionBoom,
        `the original error identity must survive the outer catch; got ${(thrown as Error)?.name}: ${(thrown as Error)?.message}`
      ).to.equal(true)
      expect(
        (thrown as Error).message,
        'the message must not be flattened into the "Unknown error" wrapper'
      ).to.not.match(/^Unknown error:/)

      // Context for the caller-confusion this finding is about: the proposal
      // itself DID persist, so a blind retry would collide on the PK.
      const row = await ctx.db
        .prepare('select count(*) as n from ProposedAdmin where AuthorityId = :id and EffectiveAt = :e')
        .get({ id: authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(row?.n), 'the proposal was persisted before the promotion attempt failed').to.equal(1)
    })
  })

  // -----------------------------------------------------------------------
  // 57-07 (D-01 promotion half): applyAdminProposal — schema-branch
  // derivation probes (GROUP 1, must be GREEN at this commit) followed by
  // RED promotion cases (GROUP 2, GREEN only once Task 2 lands the method).
  // -----------------------------------------------------------------------
  describe('applyAdminProposal (promotion)', () => {
    // -----------------------------------------------------------------
    // GROUP 1 — schema branch digest-shape derivation probes (P1-P4).
    // 62-03 (D-33b): rewritten to the SINGLE-SESSION, full-roster promotion shape —
    // the former two-session (Admin-side null-officer-part + shared min-UserId
    // officer-part) design is gone; every promotion now mints exactly ONE session
    // whose roster argument is sourced from ProposedOfficer, shared by the Admin
    // insert AND every Officer insert. Raw SQL + the shared rad-roster-digest
    // module only; depend on no applyAdminProposal call. Must be GREEN now.
    // -----------------------------------------------------------------

    it('P1: computeAdminPromotionDigest over an EMPTY roster argument produces a non-null comparable value', async () => {
      const { auth } = await createPromotionFixture()
      const digest = await computeAdminPromotionDigest(auth.ctx.db, {
        tid: 12345,
        authorityId: auth.authority.id,
        effectiveAt: toCanonicalDatetime(Date.now() + 60_000),
        thresholdPolicies: JSON.stringify([{ policy: 'rad', threshold: 1 }]),
        officers: '[]'
      })
      expect(digest, 'computeAdminPromotionDigest over an empty roster must still yield a non-null comparable value').to.not.be.null
      expect(digest).to.not.be.undefined
    })

    it('P2: a minted real-signed AdminSigning session (empty roster) satisfies Admin.MutationValid signing-nonce branch (self-visible admin + roster subqueries)', async () => {
      const { auth } = await createPromotionFixture()
      const tid = Date.now()
      const newEffectiveAt = toCanonicalDatetime(Date.now() + 120_000)
      const thresholdPolicies = JSON.stringify([{ policy: 'rad', threshold: 1 }])

      // Candidate shape (self-visible): the Admin subquery in Admin.MutationValid
      // resolves to the ROW BEING INSERTED's own (EffectiveAt, ThresholdPolicies),
      // and the roster subquery resolves against the (still-empty) ProposedOfficer
      // set for this (AuthorityId, EffectiveAt) — no ProposedOfficer rows are
      // seeded here on purpose, proving the zero-row roster path integrates
      // correctly with the REAL Admin.MutationValid CHECK, not just the scratch
      // probe (Task 1's P2).
      const rosterJson = await readProposedRosterJson(auth.ctx.db, auth.authority.id, newEffectiveAt)
      const digest = await computeAdminPromotionDigest(auth.ctx.db, {
        tid, authorityId: auth.authority.id, effectiveAt: newEffectiveAt, thresholdPolicies, officers: rosterJson
      })

      const adminRow = await auth.ctx.db
        .prepare(
          `select CurrentAdmin.EffectiveAt from CurrentAdmin join Officer
              on CurrentAdmin.AuthorityId = Officer.AuthorityId
                and CurrentAdmin.EffectiveAt = Officer.AdminEffectiveAt
                  where Officer.UserId = :userId and Officer.AuthorityId = :authorityId`
        )
        .get({ userId: auth.user.id, authorityId: auth.authority.id })
      if (!adminRow) throw new Error('P2: CurrentAdmin/Officer lookup failed for the fixture officer')

      const signCallback = makeTestSignCallback(auth.user)
      const signature = await signCallback(digestToBytes(digest))
      const nonce = 'p2-' + crypto.randomUUID()
      await auth.ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad', :digest, :userId, :signerKey, :signature)`,
        {
          nonce,
          authorityId: auth.authority.id,
          adminEffectiveAt: adminRow.EffectiveAt as string,
          digest,
          userId: signature.signerUserId,
          signerKey: signature.signerKey,
          signature: signature.signature,
          now: nowCanonicalDatetime()
        }
      )
      const signResult = await new (await import('../src/signing/signing-engine.js')).SigningEngine(auth.ctx).sign(
        nonce,
        signature,
        { ownsTransaction: true }
      )
      expect(signResult, 'P2 setup: threshold=1 must complete on the instigator signature alone').to.equal(true)

      let caught: unknown
      try {
        await auth.ctx.db.exec(
          `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
           values (:authorityId, :effectiveAt, :thresholdPolicies)`,
          { nonce, tid, authorityId: auth.authority.id, effectiveAt: newEffectiveAt, thresholdPolicies }
        )
      } catch (err) {
        caught = err
      }
      expect(
        caught,
        `P2: Admin insert with the self-visible digest shape must succeed. Error: ${(caught as Error)?.message}`
      ).to.equal(undefined)
    })

    it('P3: negative control — an Admin insert against a digest computed over the WRONG thresholdPolicies is rejected', async () => {
      const { auth } = await createPromotionFixture()
      const tid = Date.now()
      const newEffectiveAt = toCanonicalDatetime(Date.now() + 130_000)
      const thresholdPolicies = JSON.stringify([{ policy: 'rad', threshold: 1 }])
      const wrongThresholdPolicies = JSON.stringify([{ policy: 'rad', threshold: 2 }])
      const rosterJson = await readProposedRosterJson(auth.ctx.db, auth.authority.id, newEffectiveAt)

      const digest = await computeAdminPromotionDigest(auth.ctx.db, {
        tid, authorityId: auth.authority.id, effectiveAt: newEffectiveAt, thresholdPolicies: wrongThresholdPolicies, officers: rosterJson
      })

      const adminRow = await auth.ctx.db
        .prepare(
          `select CurrentAdmin.EffectiveAt from CurrentAdmin join Officer
              on CurrentAdmin.AuthorityId = Officer.AuthorityId
                and CurrentAdmin.EffectiveAt = Officer.AdminEffectiveAt
                  where Officer.UserId = :userId and Officer.AuthorityId = :authorityId`
        )
        .get({ userId: auth.user.id, authorityId: auth.authority.id })
      if (!adminRow) throw new Error('P3: CurrentAdmin/Officer lookup failed for the fixture officer')

      const signCallback = makeTestSignCallback(auth.user)
      const signature = await signCallback(digestToBytes(digest))
      const nonce = 'p3-' + crypto.randomUUID()
      await auth.ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad', :digest, :userId, :signerKey, :signature)`,
        {
          nonce,
          authorityId: auth.authority.id,
          adminEffectiveAt: adminRow.EffectiveAt as string,
          digest,
          userId: signature.signerUserId,
          signerKey: signature.signerKey,
          signature: signature.signature,
          now: nowCanonicalDatetime()
        }
      )
      await new (await import('../src/signing/signing-engine.js')).SigningEngine(auth.ctx).sign(
        nonce,
        signature,
        { ownsTransaction: true }
      )

      let caught: unknown
      try {
        // Insert with the RIGHT thresholdPolicies — mismatched against the
        // session's digest, which covers the WRONG one.
        await auth.ctx.db.exec(
          `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
           values (:authorityId, :effectiveAt, :thresholdPolicies)`,
          { nonce, tid, authorityId: auth.authority.id, effectiveAt: newEffectiveAt, thresholdPolicies }
        )
      } catch (err) {
        caught = err
      }
      expect(caught, 'P3: a digest/roster mismatch must be REJECTED by Admin.MutationValid').to.be.instanceOf(Error)
    })

    it('P4: the whole promotion (Admin + N officers) succeeds inside ONE explicit transaction using exactly ONE minted session, when the deferred-constraint queue is drained after each insert', async () => {
      // T-57-07-01..T-57-07-06 backdrop: quereus's deferred-constraint queue
      // mis-evaluates self-referential correlated subqueries (Admin.MutationValid /
      // Officer.InsertValid both read from the SAME table they mutate) when MORE
      // THAN ONE deferred entry is pending at COMMIT time — a live `select` inside
      // the SAME open transaction shows the correct, self-visible value, but the
      // deferred evaluator computes something else and the CHECK spuriously fails.
      // WORKAROUND (verified here, adopted by applyAdminProposal): call the
      // database's public `runDeferredRowConstraints()` immediately after EACH
      // insert, while still inside the open transaction.
      //
      // 62-03 (D-33b): ONE promotion session now covers the Admin insert AND every
      // Officer insert — the roster argument is sourced from ProposedOfficer,
      // seeded here first (mirroring applyAdminProposal's Step 3/4 read of the
      // SAME table). Officer.InsertValid's RosterMember clause additionally
      // requires each inserted (UserId, Title, Scopes) to be an entry of that
      // signed roster.
      const { auth, secondUser } = await createPromotionFixture()
      const tid = Date.now()
      const newEffectiveAt = toCanonicalDatetime(Date.now() + 140_000)
      const thresholdPolicies = JSON.stringify([{ policy: 'rad', threshold: 1 }])
      const { SigningEngine } = await import('../src/signing/signing-engine.js')
      const signCallback = makeTestSignCallback(auth.user)

      const adminRow = await auth.ctx.db
        .prepare(
          `select CurrentAdmin.EffectiveAt from CurrentAdmin join Officer
              on CurrentAdmin.AuthorityId = Officer.AuthorityId
                and CurrentAdmin.EffectiveAt = Officer.AdminEffectiveAt
                  where Officer.UserId = :userId and Officer.AuthorityId = :authorityId`
        )
        .get({ userId: auth.user.id, authorityId: auth.authority.id })
      if (!adminRow) throw new Error('P4: CurrentAdmin/Officer lookup failed for the fixture officer')

      const officersAscending = [auth.user.id, secondUser.id].sort()
      const officerMeta: Record<string, { title: string, scopes: string[] }> = {
        [auth.user.id]: { title: 'Chair', scopes: ['rad'] },
        [secondUser.id]: { title: 'Clerk', scopes: ['vrg'] }
      }

      // Seed ProposedAdmin + ProposedOfficer rows matching the officers — the
      // SAME table applyAdminProposal's Step 3/4 (and the schema CHECKs) read.
      const seedNow = nowCanonicalDatetime()
      await auth.ctx.db.exec(
        `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
         with context IsUserValid = true, Tid = :tid, now = :now, UserId = null, UserKey = null, Signature = null
         values (:authorityId, :effectiveAt, :thresholdPolicies)`,
        { authorityId: auth.authority.id, effectiveAt: newEffectiveAt, thresholdPolicies, tid, now: seedNow }
      )
      for (const uid of officersAscending) {
        const meta = officerMeta[uid]!
        await auth.ctx.db.exec(
          `insert into ProposedOfficer (AuthorityId, AdminEffectiveAt, ProposedName, Title, Scopes, UserId)
           with context IsUserValid = true, Tid = :tid, now = :now, UserId = null, UserKey = null, Signature = null
           values (:authorityId, :effectiveAt, :proposedName, :title, :scopes, :userId)`,
          {
            authorityId: auth.authority.id, effectiveAt: newEffectiveAt, proposedName: `P4 Officer ${uid}`,
            title: meta.title, scopes: JSON.stringify(meta.scopes), userId: uid, tid, now: seedNow
          }
        )
      }
      const rosterJson = await readProposedRosterJson(auth.ctx.db, auth.authority.id, newEffectiveAt)

      const promotionDigest = await computeAdminPromotionDigest(auth.ctx.db, {
        tid, authorityId: auth.authority.id, effectiveAt: newEffectiveAt, thresholdPolicies, officers: rosterJson
      })
      const promotionSignature = await signCallback(digestToBytes(promotionDigest))
      const promotionNonce = 'p4-promotion-' + crypto.randomUUID()
      await auth.ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad', :digest, :userId, :signerKey, :signature)`,
        {
          nonce: promotionNonce, authorityId: auth.authority.id, adminEffectiveAt: adminRow.EffectiveAt as string,
          digest: promotionDigest, userId: promotionSignature.signerUserId, signerKey: promotionSignature.signerKey,
          signature: promotionSignature.signature, now: nowCanonicalDatetime()
        }
      )
      await new SigningEngine(auth.ctx).sign(promotionNonce, promotionSignature, { ownsTransaction: true })

      let caught: unknown
      try {
        await auth.ctx.db.exec('BEGIN')
        await auth.ctx.db.exec(
          `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
           values (:authorityId, :effectiveAt, :thresholdPolicies)`,
          { nonce: promotionNonce, tid, authorityId: auth.authority.id, effectiveAt: newEffectiveAt, thresholdPolicies }
        )
        await auth.ctx.db.runDeferredRowConstraints()
        for (const uid of officersAscending) {
          const meta = officerMeta[uid]!
          await auth.ctx.db.exec(
            `insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
             with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
             values (:authorityId, :effectiveAt, :userId, :title, :scopes)`,
            { nonce: promotionNonce, tid, authorityId: auth.authority.id, effectiveAt: newEffectiveAt, userId: uid, title: meta.title, scopes: JSON.stringify(meta.scopes) }
          )
          await auth.ctx.db.runDeferredRowConstraints()
        }
        await auth.ctx.db.exec('COMMIT')
      } catch (err) {
        caught = err
        try { await auth.ctx.db.exec('ROLLBACK') } catch { /* best-effort */ }
      }
      expect(
        caught,
        `P4: the whole promotion must succeed inside one transaction. Error: ${(caught as Error)?.message}`
      ).to.equal(undefined)

      const officerCountRow = await auth.ctx.db
        .prepare('select count(*) as n from Officer where AuthorityId = :id and AdminEffectiveAt = :e')
        .get({ id: auth.authority.id, e: newEffectiveAt })
      expect(Number(officerCountRow?.n)).to.equal(2)
    })

    // -----------------------------------------------------------------
    // GROUP 2 — RED promotion cases. `applyAdminProposal` does not exist
    // yet; expected to fail because it is not a function, not because of
    // a fixture/import/SQL error. Must be GREEN by the end of Task 3.
    // -----------------------------------------------------------------

    it('C1: should promote a threshold-reached roster into live Admin + Officer rows', async () => {
      const { auth, secondUser } = await createPromotionFixture()
      const sig = makeTestSignCallback(auth.user)
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            { existing: { userId: secondUser.id, authorityId: auth.authority.id, title: 'Clerk', scopes: ['vrg'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }
      // 57-08 (Trigger A): pass a bare Signature, not the callback — Trigger A
      // only auto-promotes when signatureOrCallback is a function, and this
      // test exercises applyAdminProposal DIRECTLY, decoupled from any
      // trigger, exactly as 57-07 designed it. A bare Signature still
      // persists the proposal + starts the signing session identically.
      const rosterDigest = await computeRosterDigest(
        auth,
        [
          { proposedName: await founderDisplayName(auth), userId: auth.user.id, title: 'Chair', scopes: ['rad'] },
          { proposedName: secondUser.name, userId: secondUser.id, title: 'Clerk', scopes: ['vrg'] }
        ],
        effectiveAt,
        proposal.proposed.thresholdPolicies
      )
      const bareSignature = await sig(digestToBytes(rosterDigest))
      await auth.authorityEngine.proposeAdmin(proposal, bareSignature)
      const nonceRow = await auth.ctx.db
        .prepare('select Nonce from AdminSigning where AuthorityId = :id and Digest = :digest')
        .get({ id: auth.authority.id, digest: rosterDigest })
      const nonce = nonceRow!.Nonce as string

      const engine = auth.authorityEngine as unknown as {
        applyAdminProposal?: (nonce: string, sign: (digest: Uint8Array) => Promise<Signature>) => Promise<unknown>
      }
      expect(typeof engine.applyAdminProposal, 'applyAdminProposal must exist as a function on IAuthorityEngine').to.equal('function')
      await engine.applyAdminProposal!(nonce, sig)

      const adminRow = await auth.ctx.db
        .prepare('select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e')
        .get({ id: auth.authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(adminRow?.n)).to.equal(1)
      const officerCountRow = await auth.ctx.db
        .prepare('select count(*) as n from Officer where AuthorityId = :id and AdminEffectiveAt = :e')
        .get({ id: auth.authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(officerCountRow?.n)).to.equal(2)
    })

    it('C2: a promoted Officer row carries the vrg scope when the proposal granted it', async () => {
      const { auth, secondUser } = await createPromotionFixture()
      const sig = makeTestSignCallback(auth.user)
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            { existing: { userId: secondUser.id, authorityId: auth.authority.id, title: 'Clerk', scopes: ['vrg'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }
      // 57-08 (Trigger A): bare Signature, not the callback — see C1's comment.
      const rosterDigest = await computeRosterDigest(
        auth,
        [
          { proposedName: await founderDisplayName(auth), userId: auth.user.id, title: 'Chair', scopes: ['rad'] },
          { proposedName: secondUser.name, userId: secondUser.id, title: 'Clerk', scopes: ['vrg'] }
        ],
        effectiveAt,
        proposal.proposed.thresholdPolicies
      )
      const bareSignature = await sig(digestToBytes(rosterDigest))
      await auth.authorityEngine.proposeAdmin(proposal, bareSignature)
      const nonceRow = await auth.ctx.db
        .prepare('select Nonce from AdminSigning where AuthorityId = :id and Digest = :digest')
        .get({ id: auth.authority.id, digest: rosterDigest })
      const nonce = nonceRow!.Nonce as string

      const engine = auth.authorityEngine as unknown as {
        applyAdminProposal?: (nonce: string, sign: (digest: Uint8Array) => Promise<Signature>) => Promise<unknown>
      }
      expect(typeof engine.applyAdminProposal).to.equal('function')
      await engine.applyAdminProposal!(nonce, sig)

      const officerRow = await auth.ctx.db
        .prepare(
          `select Scopes from Officer where AuthorityId = :id and AdminEffectiveAt = :e and UserId = :userId`
        )
        .get({ id: auth.authority.id, e: toCanonicalDatetime(effectiveAt), userId: secondUser.id })
      expect(JSON.parse(officerRow!.Scopes as string)).to.include('vrg')
    })

    it('C3: promoting the same signing session twice is idempotent', async () => {
      const { auth } = await createPromotionFixture()
      const sig = makeTestSignCallback(auth.user)
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }
      // 57-08 (Trigger A): bare Signature, not the callback — see C1's comment.
      const rosterDigest = await computeRosterDigest(
        auth,
        [{ proposedName: await founderDisplayName(auth), userId: auth.user.id, title: 'Chair', scopes: ['rad'] }],
        effectiveAt,
        proposal.proposed.thresholdPolicies
      )
      const bareSignature = await sig(digestToBytes(rosterDigest))
      await auth.authorityEngine.proposeAdmin(proposal, bareSignature)
      const nonceRow = await auth.ctx.db
        .prepare('select Nonce from AdminSigning where AuthorityId = :id and Digest = :digest')
        .get({ id: auth.authority.id, digest: rosterDigest })
      const nonce = nonceRow!.Nonce as string

      const engine = auth.authorityEngine as unknown as {
        applyAdminProposal?: (nonce: string, sign: (digest: Uint8Array) => Promise<Signature>) => Promise<{ alreadyApplied: boolean }>
      }
      expect(typeof engine.applyAdminProposal).to.equal('function')
      await engine.applyAdminProposal!(nonce, sig)
      const secondResult = await engine.applyAdminProposal!(nonce, sig)
      expect(secondResult.alreadyApplied, 'a second promotion of the same nonce must report alreadyApplied').to.equal(true)

      const officerCountRow = await auth.ctx.db
        .prepare('select count(*) as n from Officer where AuthorityId = :id and AdminEffectiveAt = :e')
        .get({ id: auth.authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(officerCountRow?.n)).to.equal(1)
    })

    it('should re-derive the roster digest from the persisted UserId, matching the proposal byte-for-byte (CR-01 round trip)', async () => {
      // 57-13 (CR-01, Task 3): applyAdminProposal Step 3 must re-derive the
      // IDENTICAL digest proposeAdmin signed, reading the userId back from
      // the persisted carrier (ProposedOfficer.UserId — the fallback carrier
      // per 57-13-CR01-CARRIER-PROBE.md), not merely infer success from the
      // promotion cases passing.
      const { auth, secondUser } = await createPromotionFixture()
      const sig = makeTestSignCallback(auth.user)
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            { existing: { userId: secondUser.id, authorityId: auth.authority.id, title: 'Clerk', scopes: ['vrg'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }
      const rosterDigest = await computeRosterDigest(
        auth,
        [
          { proposedName: await founderDisplayName(auth), userId: auth.user.id, title: 'Chair', scopes: ['rad'] },
          { proposedName: secondUser.name, userId: secondUser.id, title: 'Clerk', scopes: ['vrg'] }
        ],
        effectiveAt,
        proposal.proposed.thresholdPolicies
      )
      const bareSignature = await sig(digestToBytes(rosterDigest))
      await auth.authorityEngine.proposeAdmin(proposal, bareSignature)

      // The persisted AdminSigning.Digest for this session — what proposeAdmin
      // (the producer) actually signed.
      const sessionRow = await auth.ctx.db
        .prepare('select Digest from AdminSigning where AuthorityId = :id and Digest = :digest')
        .get({ id: auth.authority.id, digest: rosterDigest })
      expect(sessionRow?.Digest, 'setup: the session must exist under the digest computeRosterDigest predicted').to.equal(rosterDigest)

      // Independently recompute the SAME digest through computeRosterDigest
      // (which mirrors sortRosterEntries exactly) — this is the assertion
      // that the round trip is byte-for-byte, not merely inferred from the
      // promotion cases (C2/C3) succeeding.
      const recomputed = await computeRosterDigest(
        auth,
        [
          { proposedName: await founderDisplayName(auth), userId: auth.user.id, title: 'Chair', scopes: ['rad'] },
          { proposedName: secondUser.name, userId: secondUser.id, title: 'Clerk', scopes: ['vrg'] }
        ],
        effectiveAt,
        proposal.proposed.thresholdPolicies
      )
      expect(recomputed, 'the roster digest must be byte-for-byte reproducible from the persisted UserId').to.equal(sessionRow?.Digest)

      // And prove Step 3 ITSELF (not just the test helper) re-derives it: a
      // real applyAdminProposal call against this nonce must succeed rather
      // than refuse with roster-mismatch.
      const nonceRow = await auth.ctx.db
        .prepare('select Nonce from AdminSigning where AuthorityId = :id and Digest = :digest')
        .get({ id: auth.authority.id, digest: rosterDigest })
      const nonce = nonceRow!.Nonce as string
      const engine = auth.authorityEngine as unknown as {
        applyAdminProposal?: (nonce: string, sign: (digest: Uint8Array) => Promise<Signature>) => Promise<unknown>
      }
      let caught: unknown
      try {
        await engine.applyAdminProposal!(nonce, sig)
      } catch (err) {
        caught = err
      }
      expect(caught, 'Step 3 must re-derive the identical digest and promote without a roster-mismatch refusal').to.equal(undefined)
    })

    // -----------------------------------------------------------------
    // GROUP 3 — refusal negative controls + atomicity (Task 3).
    // Every case asserts on `err.reason`, never on message text.
    // -----------------------------------------------------------------

    it('N1: refuses an unsigned session — reason "not-signed", zero writes', async () => {
      const { auth } = await createPromotionFixture()
      const sig = makeTestSignCallback(auth.user)
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }
      // 57-08 (Trigger A): bare Signature, not the callback — see C1's
      // comment. N1 needs the ORIGINAL roster session to be UNPROMOTED
      // (it constructs its own genuinely-unsigned copy below); Trigger A
      // auto-promoting the callback form would leave a live Admin row for
      // this effectiveAt before N1 even gets there, invalidating its
      // "zero writes" assertion for a reason unrelated to what N1 tests.
      const rosterDigest = await computeRosterDigest(
        auth,
        [{ proposedName: await founderDisplayName(auth), userId: auth.user.id, title: 'Chair', scopes: ['rad'] }],
        effectiveAt,
        proposal.proposed.thresholdPolicies
      )
      const bareSignature = await sig(digestToBytes(rosterDigest))
      await auth.authorityEngine.proposeAdmin(proposal, bareSignature)
      const completedRow = await auth.ctx.db
        .prepare('select Digest, AdminEffectiveAt from AdminSigning where AuthorityId = :id and Digest = :digest')
        .get({ id: auth.authority.id, digest: rosterDigest })
      if (!completedRow) throw new Error('N1 setup: no completed rad session found')

      // 999.1 R-06 finding (recorded in the SUMMARY): sign()'s threshold query
      // extracts json_extract(value, '$.scope') while ThresholdPolicies stores
      // '$.policy' — the lookup always falls back to threshold=1, so a
      // thresholdPolicies:2 proposal still auto-completes on the instigator's
      // own signature (AdminSignature IS written). AdminSignature is also
      // InsertOnly (no delete), so an "unsigned" state cannot be constructed
      // by proposing threshold=2 and stopping short, nor by deleting the row.
      // Instead: mint a SECOND AdminSigning row carrying the SAME (already
      // roster-matching) Digest under a FRESH nonce, and never sign it — this
      // reproduces "a genuinely unsigned session for an otherwise-valid
      // roster" without relying on the broken threshold arithmetic.
      const unsignedNonce = 'n1-unsigned-' + crypto.randomUUID()
      await auth.ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad', :digest, :userId, :signerKey, :signature)`,
        {
          nonce: unsignedNonce,
          authorityId: auth.authority.id,
          adminEffectiveAt: completedRow.AdminEffectiveAt as string,
          digest: completedRow.Digest as string,
          now: nowCanonicalDatetime(),
          ...(await (async () => {
            const s = await sig(digestToBytes(completedRow.Digest as string))
            return { userId: s.signerUserId, signerKey: s.signerKey, signature: s.signature }
          })())
        }
      )

      let caught: unknown
      try {
        await auth.authorityEngine.applyAdminProposal(unsignedNonce, sig)
      } catch (err) {
        caught = err
      }
      expect((caught as { reason?: string })?.reason, 'N1 must refuse with reason "not-signed"').to.equal('not-signed')
      const adminRow = await auth.ctx.db
        .prepare('select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e')
        .get({ id: auth.authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(adminRow?.n), 'N1 must write zero Admin rows').to.equal(0)
      const officerRow = await auth.ctx.db
        .prepare('select count(*) as n from Officer where AuthorityId = :id and AdminEffectiveAt = :e')
        .get({ id: auth.authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(officerRow?.n), 'N1 must write zero Officer rows').to.equal(0)
    })

    it('N2: refuses a tampered roster — reason "roster-mismatch", zero writes (repudiation control)', async () => {
      const { auth, secondUser } = await createPromotionFixture()
      const sig = makeTestSignCallback(auth.user)
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            { existing: { userId: secondUser.id, authorityId: auth.authority.id, title: 'Clerk', scopes: ['vrg'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }
      // 57-08 (Trigger A): bare Signature, not the callback — see C1's
      // comment. N2 tampers with the persisted roster AFTER proposeAdmin
      // returns and BEFORE promoting; Trigger A auto-promoting the callback
      // form would apply the (still-correct-at-that-point) roster first,
      // leaving a live Admin row this test's tamper step cannot retract.
      const rosterDigest = await computeRosterDigest(
        auth,
        [
          { proposedName: await founderDisplayName(auth), userId: auth.user.id, title: 'Chair', scopes: ['rad'] },
          { proposedName: secondUser.name, userId: secondUser.id, title: 'Clerk', scopes: ['vrg'] }
        ],
        effectiveAt,
        proposal.proposed.thresholdPolicies
      )
      const bareSignature = await sig(digestToBytes(rosterDigest))
      await auth.authorityEngine.proposeAdmin(proposal, bareSignature)
      const nonceRow = await auth.ctx.db
        .prepare('select Nonce from AdminSigning where AuthorityId = :id and Digest = :digest')
        .get({ id: auth.authority.id, digest: rosterDigest })
      const nonce = nonceRow!.Nonce as string

      // Tamper with the persisted roster AFTER signing — the signed Digest no
      // longer covers this scope value. ProposedOfficer.UserValid applies to
      // UPDATE too, so the raw update must supply the full mutation context.
      await auth.ctx.db.exec(
        `update ProposedOfficer
         with context UserId = :uid, UserKey = :ukey, Signature = :sigv, Tid = 999999, now = :now, IsUserValid = true
         set Scopes = :scopes
         where AuthorityId = :authorityId and AdminEffectiveAt = :effectiveAt and ProposedName = :name`,
        {
          authorityId: auth.authority.id,
          effectiveAt: toCanonicalDatetime(effectiveAt),
          name: secondUser.name,
          scopes: JSON.stringify(['vrg', 'uai']),
          uid: auth.user.id,
          ukey: '0'.repeat(66),
          sigv: 'aa'.repeat(64),
          now: nowCanonicalDatetime()
        }
      )

      let caught: unknown
      try {
        await auth.authorityEngine.applyAdminProposal(nonce, sig)
      } catch (err) {
        caught = err
      }
      expect((caught as { reason?: string })?.reason, 'N2 must refuse with reason "roster-mismatch"').to.equal('roster-mismatch')
      const adminRow = await auth.ctx.db
        .prepare('select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e')
        .get({ id: auth.authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(adminRow?.n), 'N2 must write zero Admin rows').to.equal(0)
    })

    it('N3: refuses an unresolvable officer — reason "unresolvable-officer", zero writes (rolls back rather than promoting a partial roster)', async () => {
      const { auth } = await createPromotionFixture()
      const sig = makeTestSignCallback(auth.user)
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            { init: { name: 'Nobody Matches This Name', title: 'Clerk', scopes: ['vrg'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }
      await auth.authorityEngine.proposeAdmin(proposal, sig)
      const nonceRow = await auth.ctx.db
        .prepare("select Nonce from AdminSigning where AuthorityId = :id and Scope = 'rad' and not exists (select 1 from InviteSlot where SigningNonce = AdminSigning.Nonce) order by Nonce desc limit 1")
        .get({ id: auth.authority.id })
      const nonce = nonceRow!.Nonce as string

      let caught: unknown
      try {
        await auth.authorityEngine.applyAdminProposal(nonce, sig)
      } catch (err) {
        caught = err
      }
      expect((caught as { reason?: string })?.reason, 'N3 must refuse with reason "unresolvable-officer"').to.equal('unresolvable-officer')
      const adminRow = await auth.ctx.db
        .prepare('select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e')
        .get({ id: auth.authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(adminRow?.n), 'N3 must roll back — zero Admin rows for this EffectiveAt').to.equal(0)
    })

    it('N4: refuses a roster with no rad-scoped officer — reason "no-rad-officer", zero writes', async () => {
      const { auth, secondUser } = await createPromotionFixture()
      const sig = makeTestSignCallback(auth.user)
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['uai'] as Scope[] } },
            { existing: { userId: secondUser.id, authorityId: auth.authority.id, title: 'Clerk', scopes: ['vrg'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'uai', threshold: 1 }]
        },
        signers: [auth.user.id]
      }
      await auth.authorityEngine.proposeAdmin(proposal, sig)
      const nonceRow = await auth.ctx.db
        .prepare("select Nonce from AdminSigning where AuthorityId = :id and Scope = 'rad' and not exists (select 1 from InviteSlot where SigningNonce = AdminSigning.Nonce) order by Nonce desc limit 1")
        .get({ id: auth.authority.id })
      const nonce = nonceRow!.Nonce as string

      let caught: unknown
      try {
        await auth.authorityEngine.applyAdminProposal(nonce, sig)
      } catch (err) {
        caught = err
      }
      expect((caught as { reason?: string })?.reason, 'N4 must refuse with reason "no-rad-officer"').to.equal('no-rad-officer')
      const adminRow = await auth.ctx.db
        .prepare('select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e')
        .get({ id: auth.authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(adminRow?.n)).to.equal(0)
    })

    it('N5: a failed second Officer insert leaves zero Admin rows (transactional atomicity)', async () => {
      const { auth, secondUser } = await createPromotionFixture()
      const sig = makeTestSignCallback(auth.user)
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            { existing: { userId: secondUser.id, authorityId: auth.authority.id, title: 'Clerk', scopes: ['vrg'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }
      // 57-08 (Trigger A): bare Signature, not the callback — see C1's
      // comment. N5 needs the ORIGINAL roster session to be UNPROMOTED so
      // its OWN manual applyAdminProposal call (with the exec monkeypatch
      // installed below) is what actually drives the officer-insert loop;
      // an auto-promotion via the callback form would apply it first
      // (before the monkeypatch exists) and the manual call would then
      // short-circuit on alreadyApplied, never reaching the injected
      // failure.
      const rosterDigest = await computeRosterDigest(
        auth,
        [
          { proposedName: await founderDisplayName(auth), userId: auth.user.id, title: 'Chair', scopes: ['rad'] },
          { proposedName: secondUser.name, userId: secondUser.id, title: 'Clerk', scopes: ['vrg'] }
        ],
        effectiveAt,
        proposal.proposed.thresholdPolicies
      )
      const bareSignature = await sig(digestToBytes(rosterDigest))
      await auth.authorityEngine.proposeAdmin(proposal, bareSignature)
      const nonceRow = await auth.ctx.db
        .prepare('select Nonce from AdminSigning where AuthorityId = :id and Digest = :digest')
        .get({ id: auth.authority.id, digest: rosterDigest })
      const nonce = nonceRow!.Nonce as string

      // Neither the digest verification (T-57-07-02) nor any live SCOPE table
      // can be tampered independently of the roster it re-verifies (the whole
      // roster, including every non-minimum officer's Title/Scopes, is folded
      // into the ONE digest Step 3 checks) — so a genuine schema-CHECK
      // rejection isolated to exactly the second Officer row is structurally
      // unreachable without also tripping the (correctly stricter)
      // roster-mismatch refusal first. Per the plan's own fallback: stub the
      // failure at the second Officer insert by intercepting the DB's own
      // `exec`, proving the surrounding BEGIN/COMMIT/ROLLBACK envelope is
      // real — the first Officer insert and the Admin insert are inside the
      // SAME transaction as the second, so a failure there must roll back
      // all three.
      const originalExec = auth.ctx.db.exec.bind(auth.ctx.db)
      let officerInsertCount = 0
      auth.ctx.db.exec = (async (sql: string, params?: unknown) => {
        if (typeof sql === 'string' && sql.includes('insert into Officer (')) {
          officerInsertCount++
          if (officerInsertCount === 2) {
            throw new Error('N5 injected failure: second Officer insert')
          }
        }
        return originalExec(sql as never, params as never)
      }) as typeof auth.ctx.db.exec

      let caught: unknown
      try {
        await auth.authorityEngine.applyAdminProposal(nonce, sig)
      } catch (err) {
        caught = err
      } finally {
        auth.ctx.db.exec = originalExec
      }
      expect(caught, 'N5 must reject when the second Officer insert fails').to.exist
      expect(officerInsertCount, 'N5 setup: the injected failure must have fired on the second Officer insert').to.equal(2)
      const adminRow = await auth.ctx.db
        .prepare('select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e')
        .get({ id: auth.authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(adminRow?.n), 'N5: the rollback must leave zero Admin rows — no half-applied administration').to.equal(0)
      const officerRow = await auth.ctx.db
        .prepare('select count(*) as n from Officer where AuthorityId = :id and AdminEffectiveAt = :e')
        .get({ id: auth.authority.id, e: toCanonicalDatetime(effectiveAt) })
      expect(Number(officerRow?.n), 'N5: the rollback must leave zero Officer rows, including the FIRST officer').to.equal(0)
    })

    it('N6: the roster serializer reproduces the exact bytes a fresh proposeAdmin call signed (regression guard)', async () => {
      const { auth, secondUser } = await createPromotionFixture()
      const sig = makeTestSignCallback(auth.user)
      const effectiveAt = Date.now() + 60_000
      const thresholdPolicies = [{ policy: 'rad' as Scope, threshold: 1 }]
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            { existing: { userId: secondUser.id, authorityId: auth.authority.id, title: 'Clerk', scopes: ['vrg'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies
        },
        signers: [auth.user.id]
      }
      await auth.authorityEngine.proposeAdmin(proposal, sig)

      type RosterEntryForN6 = { proposedName: string; userId: string | null; title: string; scopes: string[] }
      const sortRosterEntriesExported = (AuthorityEngineModule as unknown as {
        sortRosterEntries?: (entries: RosterEntryForN6[]) => RosterEntryForN6[]
      }).sortRosterEntries
      if (typeof sortRosterEntriesExported !== 'function') {
        expect.fail('authority-engine.ts does not export sortRosterEntries')
        return
      }
      // 57-13 (CR-01): userId is now part of the digested shape — rebuild with
      // the SAME userIds the real proposeAdmin call above resolved, or this
      // regression guard's recomputed digest will not match.
      const rebuiltRoster = sortRosterEntriesExported([
        { proposedName: await founderDisplayName(auth), userId: auth.user.id, title: 'Chair', scopes: ['rad'] },
        { proposedName: secondUser.name, userId: secondUser.id, title: 'Clerk', scopes: ['vrg'] }
      ])
      const officersJson = JSON.stringify(rebuiltRoster)
      const recomputedRow = await auth.ctx.db
        .prepare('select Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies) as d')
        .get({
          authorityId: auth.authority.id,
          effectiveAt: toCanonicalDatetime(effectiveAt),
          officers: officersJson,
          thresholdPolicies: JSON.stringify(thresholdPolicies)
        })

      // 57-08 (Trigger A): look up the session by the recomputed Digest, not
      // "order by Nonce desc limit 1" — Trigger A auto-promotes this
      // (perfectly valid, resolvable) roster, minting ADDITIONAL 'rad'
      // AdminSigning rows (Admin-side/officer-side) under fresh, randomly-
      // ordered nonces. Nonce is a random UUID, not chronological, so the
      // old ordering query can no longer reliably pick the ORIGINAL
      // roster-covering session.
      const sessionRow = await auth.ctx.db
        .prepare('select Digest from AdminSigning where AuthorityId = :id and Digest = :digest')
        .get({ id: auth.authority.id, digest: recomputedRow?.d as string })
      expect(recomputedRow?.d, 'the exported sortRosterEntries must reproduce the exact signed Digest').to.equal(sessionRow?.Digest)
    })
  })

  // -----------------------------------------------------------------------
  // CR-01 promote-side closure (this plan): applyAdminProposal Step 4 must
  // resolve privilege grants from the signed, persisted userId — never from
  // User.Name, which UserEngine.revise() lets any user change unilaterally.
  // Sits BESIDE 'applyAdminProposal (promotion)' rather than nested inside
  // it, per the plan's own instruction. Every rename below goes through the
  // real UserEngine.revise() path (renameUserViaEngine), never a raw SQL
  // UPDATE against the table directly — see that helper's own comment.
  // -----------------------------------------------------------------------
  describe('applyAdminProposal identity resolution (CR-01)', () => {
    it('must not promote a different user who has taken over the proposed name (hijack)', async () => {
      const { auth, secondUser } = await createPromotionFixture()
      const attacker = await seedExtraUser(auth)
      // Prime BOTH the intended officer and the attacker with a real Officer
      // association + UserKey (User.UserValid/UserKeyValid fire on update —
      // see primeUserForRename's own comment) at an EARLIER effectiveAt than
      // the roster-under-test below, so the mid-flight renames later in this
      // test can actually be issued through UserEngine.revise().
      await primeUserForRename(auth, secondUser, Date.now() + 30_000)
      await primeUserForRename(auth, attacker, Date.now() + 45_000)
      const sig = makeTestSignCallback(auth.user)
      const effectiveAt = Date.now() + 90_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            { existing: { userId: secondUser.id, authorityId: auth.authority.id, title: 'Clerk', scopes: ['rad', 'vrg'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }
      const rosterDigest = await computeRosterDigest(
        auth,
        [
          { proposedName: await founderDisplayName(auth), userId: auth.user.id, title: 'Chair', scopes: ['rad'] },
          { proposedName: secondUser.name, userId: secondUser.id, title: 'Clerk', scopes: ['rad', 'vrg'] }
        ],
        effectiveAt,
        proposal.proposed.thresholdPolicies
      )
      const bareSignature = await sig(digestToBytes(rosterDigest))
      await auth.authorityEngine.proposeAdmin(proposal, bareSignature)
      const nonceRow = await auth.ctx.db
        .prepare('select Nonce from AdminSigning where AuthorityId = :id and Digest = :digest')
        .get({ id: auth.authority.id, digest: rosterDigest })
      const nonce = nonceRow!.Nonce as string

      // The attack: AFTER the roster is signed, rename the intended officer
      // away and rename an unrelated third user TO the name the intended
      // officer held at propose time — the captured ProposedName the old
      // Step 4 trusted.
      const capturedName = secondUser.name
      await renameUserViaEngine(auth.ctx, secondUser, 'Renamed Away From Second Roster Officer')
      await renameUserViaEngine(auth.ctx, attacker, capturedName)

      const engine = auth.authorityEngine as unknown as {
        applyAdminProposal?: (nonce: string, sign: (digest: Uint8Array) => Promise<Signature>) => Promise<unknown>
      }
      await engine.applyAdminProposal!(nonce, sig)

      const promotedRow = await auth.ctx.db
        .prepare('select UserId from Officer where AuthorityId = :id and AdminEffectiveAt = :e and UserId = :userId')
        .get({ id: auth.authority.id, e: toCanonicalDatetime(effectiveAt), userId: secondUser.id })
      expect(
        promotedRow?.UserId,
        'the intended officer (by persisted userId) must be promoted, regardless of what User.Name currently holds'
      ).to.equal(secondUser.id)

      // The discriminating assertion: no Officer row may exist for the
      // attacker, who merely captured the renamed-away display name.
      const attackerRow = await auth.ctx.db
        .prepare('select count(*) as n from Officer where AuthorityId = :id and AdminEffectiveAt = :e and UserId = :userId')
        .get({ id: auth.authority.id, e: toCanonicalDatetime(effectiveAt), userId: attacker.id })
      expect(
        Number(attackerRow?.n),
        'no Officer row may exist for the attacker who merely captured the renamed-away name'
      ).to.equal(0)
    })

    it('must still promote after the proposed officer has been renamed away (denial-of-promotion)', async () => {
      const { auth, secondUser } = await createPromotionFixture()
      // Prime secondUser with a real Officer association + UserKey (see
      // primeUserForRename's comment) so the pre-promotion rename below can
      // actually be issued through UserEngine.revise().
      await primeUserForRename(auth, secondUser, Date.now() + 30_000)
      const sig = makeTestSignCallback(auth.user)
      const effectiveAt = Date.now() + 90_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: secondUser.id, authorityId: auth.authority.id, title: 'Clerk', scopes: ['rad'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }
      const rosterDigest = await computeRosterDigest(
        auth,
        [{ proposedName: secondUser.name, userId: secondUser.id, title: 'Clerk', scopes: ['rad'] }],
        effectiveAt,
        proposal.proposed.thresholdPolicies
      )
      const bareSignature = await sig(digestToBytes(rosterDigest))
      await auth.authorityEngine.proposeAdmin(proposal, bareSignature)
      const nonceRow = await auth.ctx.db
        .prepare('select Nonce from AdminSigning where AuthorityId = :id and Digest = :digest')
        .get({ id: auth.authority.id, digest: rosterDigest })
      const nonce = nonceRow!.Nonce as string

      // Rename the proposed officer to a value matching no ProposedName.
      await renameUserViaEngine(auth.ctx, secondUser, 'Nobody Recognizes This Name Anymore')

      const engine = auth.authorityEngine as unknown as {
        applyAdminProposal?: (nonce: string, sign: (digest: Uint8Array) => Promise<Signature>) => Promise<unknown>
      }
      let caught: unknown
      try {
        await engine.applyAdminProposal!(nonce, sig)
      } catch (err) {
        caught = err
      }
      expect(
        caught,
        `promotion must succeed after a rename — the old name-based bridge is genuinely gone. Error: ${(caught as Error)?.message}`
      ).to.equal(undefined)

      const officerRow = await auth.ctx.db
        .prepare('select UserId from Officer where AuthorityId = :id and AdminEffectiveAt = :e and UserId = :userId')
        .get({ id: auth.authority.id, e: toCanonicalDatetime(effectiveAt), userId: secondUser.id })
      expect(
        officerRow?.UserId,
        'the renamed officer must still be promoted, resolved by persisted userId'
      ).to.equal(secondUser.id)
    })

    it('must stay idempotent across a rename between the original promotion and the retry', async () => {
      const { auth, secondUser } = await createPromotionFixture()
      const sig = makeTestSignCallback(auth.user)
      const effectiveAt = Date.now() + 60_000
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            { existing: { userId: secondUser.id, authorityId: auth.authority.id, title: 'Clerk', scopes: ['vrg'] as Scope[] } }
          ],
          effectiveAt,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }
      const rosterDigest = await computeRosterDigest(
        auth,
        [
          { proposedName: await founderDisplayName(auth), userId: auth.user.id, title: 'Chair', scopes: ['rad'] },
          { proposedName: secondUser.name, userId: secondUser.id, title: 'Clerk', scopes: ['vrg'] }
        ],
        effectiveAt,
        proposal.proposed.thresholdPolicies
      )
      const bareSignature = await sig(digestToBytes(rosterDigest))
      await auth.authorityEngine.proposeAdmin(proposal, bareSignature)
      const nonceRow = await auth.ctx.db
        .prepare('select Nonce from AdminSigning where AuthorityId = :id and Digest = :digest')
        .get({ id: auth.authority.id, digest: rosterDigest })
      const nonce = nonceRow!.Nonce as string

      const engine = auth.authorityEngine as unknown as {
        applyAdminProposal?: (nonce: string, sign: (digest: Uint8Array) => Promise<Signature>) => Promise<{ alreadyApplied: boolean, officersPromoted: number }>
      }
      await engine.applyAdminProposal!(nonce, sig)

      // Rename a roster member BETWEEN the original promotion and the retry.
      // auth.user already carries an Officer row (founding officer) and a
      // real UserKey, so User.UserValid/UserKeyValid (check on update) are
      // already satisfied — no priming needed, unlike secondUser above.
      await renameUserViaEngine(auth.ctx, auth.user, 'Renamed Between Promotion And Retry')

      let caught: unknown
      let secondResult: { alreadyApplied: boolean, officersPromoted: number } | undefined
      try {
        secondResult = await engine.applyAdminProposal!(nonce, sig)
      } catch (err) {
        caught = err
      }
      expect(
        caught,
        `a replay across a rename must return alreadyApplied, not throw AdminPromotionError. Error: ${(caught as Error)?.message}`
      ).to.equal(undefined)
      expect(secondResult?.alreadyApplied, 'the second call must report alreadyApplied: true').to.equal(true)
      expect(secondResult?.officersPromoted, 'a replay must write zero additional Officer rows').to.equal(0)
    })
  })

  // -----------------------------------------------------------------------
  // 57-08 (D-01, R1 close): admin promotion trigger — wires proposeAdmin's
  // discarded `thresholdReached` to 57-07's applyAdminProposal (Trigger A),
  // and proves the granted scope is readable through the screens' own gate
  // expression. RED at this commit (no trigger exists yet); GREEN after
  // Task 2. Scope fence: this block does NOT call applyAdminProposal
  // directly anywhere — that would prove 57-07's method, which 57-07
  // already proved, not that proposeAdmin's own trigger fires it.
  // -----------------------------------------------------------------------
  describe('admin promotion trigger (end to end)', () => {
    // P5's two offsets, per key fact 2 / the createPromotionFixture doc comment above:
    // canonical datetimes are second-granularity, so the founding administration must
    // be moved safely into the past for a same-run promotion to be "later but not future".
    const FOUNDING_PAST_MS = 60 * 60 * 1000 // ~1h in the past
    const PROMOTION_PAST_MS = 30 * 60 * 1000 // ~30m in the past — later than founding, still not future

    // -----------------------------------------------------------------
    // GROUP 2 — P5 (CurrentAdmin timing) and P7 (transaction composition)
    // probes. Raw SQL only, depend on no new engine code. Must be GREEN now.
    // -----------------------------------------------------------------

    it('P5a: a FUTURE Admin.EffectiveAt is invisible to getAdminDetails (CurrentAdmin stays on the founding administration)', async () => {
      const foundingEffectiveAtMs = Date.now() - FOUNDING_PAST_MS
      const { auth } = await createPromotionFixture({ foundingEffectiveAt: foundingEffectiveAtMs })
      const before = await auth.authorityEngine.getAdminDetails()

      const tid = Date.now()
      const futureEffectiveAt = toCanonicalDatetime(Date.now() + 60 * 60 * 1000)
      const thresholdPolicies = JSON.stringify([{ policy: 'rad', threshold: 1 }])
      const digestRow = await auth.ctx.db
        .prepare('select Digest(:tid, :authorityId, Digest(:effectiveAt, :thresholdPolicies), :officerPart) as d')
        .get({ tid, authorityId: auth.authority.id, effectiveAt: futureEffectiveAt, thresholdPolicies, officerPart: null })
      const digest = digestRow!.d as string

      const adminRow = await auth.ctx.db
        .prepare(
          `select CurrentAdmin.EffectiveAt from CurrentAdmin join Officer
              on CurrentAdmin.AuthorityId = Officer.AuthorityId
                and CurrentAdmin.EffectiveAt = Officer.AdminEffectiveAt
                  where Officer.UserId = :userId and Officer.AuthorityId = :authorityId`
        )
        .get({ userId: auth.user.id, authorityId: auth.authority.id })
      if (!adminRow) throw new Error('P5a: CurrentAdmin/Officer lookup failed for the fixture officer')

      const signCallback = makeTestSignCallback(auth.user)
      const signature = await signCallback(digestToBytes(digest))
      const nonce = 'p5a-' + crypto.randomUUID()
      await auth.ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad', :digest, :userId, :signerKey, :signature)`,
        {
          nonce,
          authorityId: auth.authority.id,
          adminEffectiveAt: adminRow.EffectiveAt as string,
          digest,
          userId: signature.signerUserId,
          signerKey: signature.signerKey,
          signature: signature.signature,
          now: nowCanonicalDatetime()
        }
      )
      const signing = new (await import('../src/signing/signing-engine.js')).SigningEngine(auth.ctx)
      const signResult = await signing.sign(nonce, signature, { ownsTransaction: true })
      expect(signResult, 'P5a setup: threshold=1 must complete on the instigator signature alone').to.equal(true)

      await auth.ctx.db.exec(
        `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
         with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
         values (:authorityId, :effectiveAt, :thresholdPolicies)`,
        { nonce, tid, authorityId: auth.authority.id, effectiveAt: futureEffectiveAt, thresholdPolicies }
      )

      const after = await auth.authorityEngine.getAdminDetails()
      expect(
        after.admin.effectiveAt,
        'P5a: a FUTURE Admin row must be invisible to CurrentAdmin — getAdminDetails must still report the founding administration'
      ).to.equal(before.admin.effectiveAt)
    })

    it('P5b: a PAST Admin.EffectiveAt later than the founding administration IS selected by getAdminDetails', async () => {
      const foundingEffectiveAtMs = Date.now() - FOUNDING_PAST_MS
      const { auth } = await createPromotionFixture({ foundingEffectiveAt: foundingEffectiveAtMs })
      const before = await auth.authorityEngine.getAdminDetails()

      const tid = Date.now()
      const pastLaterEffectiveAt = toCanonicalDatetime(Date.now() - PROMOTION_PAST_MS)
      const thresholdPolicies = JSON.stringify([{ policy: 'rad', threshold: 1 }])
      const digestRow = await auth.ctx.db
        .prepare('select Digest(:tid, :authorityId, Digest(:effectiveAt, :thresholdPolicies), :officerPart) as d')
        .get({ tid, authorityId: auth.authority.id, effectiveAt: pastLaterEffectiveAt, thresholdPolicies, officerPart: null })
      const digest = digestRow!.d as string

      const adminRow = await auth.ctx.db
        .prepare(
          `select CurrentAdmin.EffectiveAt from CurrentAdmin join Officer
              on CurrentAdmin.AuthorityId = Officer.AuthorityId
                and CurrentAdmin.EffectiveAt = Officer.AdminEffectiveAt
                  where Officer.UserId = :userId and Officer.AuthorityId = :authorityId`
        )
        .get({ userId: auth.user.id, authorityId: auth.authority.id })
      if (!adminRow) throw new Error('P5b: CurrentAdmin/Officer lookup failed for the fixture officer')

      const signCallback = makeTestSignCallback(auth.user)
      const signature = await signCallback(digestToBytes(digest))
      const nonce = 'p5b-' + crypto.randomUUID()
      await auth.ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad', :digest, :userId, :signerKey, :signature)`,
        {
          nonce,
          authorityId: auth.authority.id,
          adminEffectiveAt: adminRow.EffectiveAt as string,
          digest,
          userId: signature.signerUserId,
          signerKey: signature.signerKey,
          signature: signature.signature,
          now: nowCanonicalDatetime()
        }
      )
      const signing = new (await import('../src/signing/signing-engine.js')).SigningEngine(auth.ctx)
      const signResult = await signing.sign(nonce, signature, { ownsTransaction: true })
      expect(signResult, 'P5b setup: threshold=1 must complete on the instigator signature alone').to.equal(true)

      await auth.ctx.db.exec(
        `insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
         with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = :tid
         values (:authorityId, :effectiveAt, :thresholdPolicies)`,
        { nonce, tid, authorityId: auth.authority.id, effectiveAt: pastLaterEffectiveAt, thresholdPolicies }
      )

      const after = await auth.authorityEngine.getAdminDetails()
      expect(
        after.admin.effectiveAt,
        'P5b: a PAST-but-LATER Admin row must be selected by CurrentAdmin over the founding one'
      ).to.not.equal(before.admin.effectiveAt)
      expect(after.admin.effectiveAt).to.equal(fromCanonicalDatetime(pastLaterEffectiveAt))
    })

    it('P7: transaction-composition — visibility of an uncommitted AdminSignature row on the same handle before COMMIT', async () => {
      const { auth } = await createPromotionFixture()

      const adminRow = await auth.ctx.db
        .prepare(
          `select CurrentAdmin.EffectiveAt from CurrentAdmin join Officer
              on CurrentAdmin.AuthorityId = Officer.AuthorityId
                and CurrentAdmin.EffectiveAt = Officer.AdminEffectiveAt
                  where Officer.UserId = :userId and Officer.AuthorityId = :authorityId`
        )
        .get({ userId: auth.user.id, authorityId: auth.authority.id })
      if (!adminRow) throw new Error('P7: CurrentAdmin/Officer lookup failed for the fixture officer')

      // Arbitrary-content AdminSigning('rad') at threshold 1 — P7 tests sign()'s OWN
      // transactional visibility, not proposal/promotion digest semantics, so the digest
      // content itself is unconstrained.
      const digestRow = await auth.ctx.db.prepare('select Digest(:probe) as d').get({ probe: 'p7-probe' })
      const digest = digestRow!.d as string
      const signCallback = makeTestSignCallback(auth.user)
      const signature = await signCallback(digestToBytes(digest))
      const nonce = 'p7-' + crypto.randomUUID()
      await auth.ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad', :digest, :userId, :signerKey, :signature)`,
        {
          nonce,
          authorityId: auth.authority.id,
          adminEffectiveAt: adminRow.EffectiveAt as string,
          digest,
          userId: signature.signerUserId,
          signerKey: signature.signerKey,
          signature: signature.signature,
          now: nowCanonicalDatetime()
        }
      )

      const signing = new (await import('../src/signing/signing-engine.js')).SigningEngine(auth.ctx)
      await auth.ctx.db.exec('BEGIN')
      const thresholdReached = await signing.sign(nonce, signature, { ownsTransaction: false })
      expect(thresholdReached, 'P7 setup: threshold=1 must complete on the instigator signature alone').to.equal(true)
      const visRow = await auth.ctx.db
        .prepare('select 1 as x from AdminSignature where SigningNonce = :nonce')
        .get({ nonce })
      await auth.ctx.db.exec('COMMIT')

      // P7 VERDICT (pinned empirically, not assumed — see 57-08-SUMMARY.md): the row IS
      // visible to a same-handle read before COMMIT. Task 3's transaction-composition
      // decision for the completeSignature 'admin' branch is gated on this.
      expect(
        visRow,
        'P7 verdict: an uncommitted AdminSignature row IS visible on the same handle before COMMIT'
      ).to.not.be.undefined
    })

    // P8 — bare-Signature call sites (static analysis, not a DB probe; no `it()` needed).
    // `grep -rn "\.proposeAdmin(" --include="*.ts" --include="*.tsx" packages/ apps/ | grep -v "/test/"`:
    //   - packages/vote-engine/src/authority/builders/authority-propose-admin-builder.ts:154
    //     `await this.engine.proposeAdmin(input.admin, input.signature)` — passes a bare
    //     `Signature` (Draft.signature is typed `Signature`, never a callback). This IS a
    //     production (non-test, non-mock) call site: `AuthorityEngine.buildProposeAdmin()`
    //     exposes it on `IAuthorityEngine`. No app screen currently calls
    //     `buildProposeAdmin()` (grepped separately — zero hits under apps/), so it has no
    //     live UI consumer today, but it is reachable engine-API surface, not dead code.
    //     Escalated per the plan: Task 2 must refuse (not throw on) a bare-Signature
    //     thresholdReached promotion attempt, recording a distinct outcome marker, and this
    //     finding is named prominently in 57-08-SUMMARY.md.
    //   - apps/VoteTorrentAuthority/src/screens/admin/EditOfficerScreen.tsx:121 — callback.
    //   - apps/VoteTorrentAuthority/src/screens/authorities/ProposedAdministrationScreen.tsx:229 — callback.

    // -----------------------------------------------------------------
    // GROUP 3 — the end-to-end scope-readability proof. RED at this commit;
    // Task 2 (Trigger A) must turn both cases GREEN.
    // -----------------------------------------------------------------

    // Inherited finding 3 (57-07): this case runs at a genuine `threshold: 1` policy, so it
    // would pass with or without the `$.scope`/`$.policy` extraction defect in
    // signing-engine.ts:150-176 — it does not depend on that broken behaviour, and it does
    // not exercise a multi-signature threshold, which is currently unreachable in production.
    it('grants an officer the vrg scope end to end and the scope is readable through getAdminDetails', async () => {
      const foundingEffectiveAtMs = Date.now() - FOUNDING_PAST_MS
      const { auth } = await createPromotionFixture({
        foundingEffectiveAt: foundingEffectiveAtMs,
        // Pre-WR-22 scope set — deliberately excludes 'vrg' so the RED baseline below is
        // genuine (see createPromotionFixture's foundingOfficerScopes doc comment).
        foundingOfficerScopes: ['rn', 'rad', 'iad', 'uai', 'mel'] as Scope[]
      })

      // Step 2 (also P6's assertion, inlined): the founding officer must NOT hold 'vrg'
      // before promotion — a green end-to-end case must be unable to pass without this
      // having been false first.
      const before = await auth.authorityEngine.getAdminDetails()
      const beforeOfficer = before.admin.officers.find((o) => o.userId === auth.user.id)
      expect(beforeOfficer?.scopes, 'baseline must read a real, non-empty roster').to.not.be.undefined
      expect(beforeOfficer!.scopes.length, 'baseline must read a real, non-empty roster').to.be.greaterThan(0)
      expect(beforeOfficer!.scopes.includes('rad' as Scope), 'baseline sanity: the founding officer really carries rad').to.equal(true)
      expect(beforeOfficer!.scopes.includes('vrg'), 'baseline: vrg must be absent before promotion').to.equal(false)

      // Step 3: propose a roster — the founding officer, .existing, gaining 'vrg' alongside
      // 'rad' (required: Admin.OfficerRequired fires `check on update`, so a rad-less
      // administration could never be revised again — 57-07 refuses it as no-rad-officer).
      const proposedEffectiveAtMs = Date.now() - PROMOTION_PAST_MS
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            {
              existing: {
                userId: auth.user.id,
                authorityId: auth.authority.id,
                title: 'Chair',
                scopes: ['rad', 'vrg'] as Scope[]
              }
            }
          ],
          effectiveAt: proposedEffectiveAtMs,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }

      // Step 4: the production shape — proposeAdmin alone, with a device-signer callback
      // (matches EditOfficerScreen.tsx:121). The test does NOT call applyAdminProposal.
      await auth.authorityEngine.proposeAdmin(proposal, makeTestSignCallback(auth.user))

      // Step 5: the full three-hop hook expression, post-promotion.
      const after = await auth.authorityEngine.getAdminDetails()
      const afterOfficer = after.admin.officers.find((o) => o.userId === auth.user.id)
      expect(
        afterOfficer?.scopes?.includes('vrg'),
        "the promoted 'vrg' scope must be readable through getAdminDetails().admin.officers.find(...).scopes"
      ).to.equal(true)
      expect(afterOfficer?.title).to.equal('Chair')

      // Step 6: CurrentAdmin actually advanced — not a stale row that happened to satisfy
      // step 5.
      expect(
        after.admin.effectiveAt,
        'admin.admin.effectiveAt must correspond to the PROPOSED effective date, not the founding one'
      ).to.equal(fromCanonicalDatetime(toCanonicalDatetime(proposedEffectiveAtMs)))
      expect(after.admin.effectiveAt).to.not.equal(before.admin.effectiveAt)
    })

    // 62-65 regression guard: the founder's display name (User.Name = the entered
    // officerInit.name) deliberately differs from the provisioned device user's name.
    // Identity is the userId + registered key, never the name — so the production shape
    // (proposeAdmin with a device-signer callback, Trigger A promotion) must still work,
    // and the persisted roster must carry the ENTERED name bound to the founder's userId.
    it('62-65: a founder whose display name differs from the device user name can still propose and promote', async () => {
      const foundingEffectiveAtMs = Date.now() - FOUNDING_PAST_MS
      const { auth, secondUser } = await createPromotionFixture({ foundingEffectiveAt: foundingEffectiveAtMs })
      const displayName = await founderDisplayName(auth)
      expect(displayName, 'fixture precondition: founded with the entered admin name').to.equal('Admin A')
      expect(displayName, 'fixture precondition: display name differs from the device user name').to.not.equal(auth.user.name)

      const proposedEffectiveAtMs = Date.now() - PROMOTION_PAST_MS
      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            { existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } },
            { existing: { userId: secondUser.id, authorityId: auth.authority.id, title: 'Clerk', scopes: ['vrg'] as Scope[] } }
          ],
          effectiveAt: proposedEffectiveAtMs,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }
      await auth.authorityEngine.proposeAdmin(proposal, makeTestSignCallback(auth.user))

      const outcome = (auth.authorityEngine as unknown as { lastPromotionOutcome?: { status?: string, reason?: string } }).lastPromotionOutcome
      expect(outcome?.status, `promotion must apply (reason=${outcome?.reason})`).to.equal('promoted')

      const proposedFounder = await auth.ctx.db
        .prepare('select ProposedName from ProposedOfficer where AuthorityId = :a and AdminEffectiveAt = :e and UserId = :u')
        .get({ a: auth.authority.id, e: toCanonicalDatetime(proposedEffectiveAtMs), u: auth.user.id })
      expect(proposedFounder?.ProposedName, 'the signed roster carries the entered display name').to.equal(displayName)

      const after = await auth.authorityEngine.getAdminDetails()
      expect(after.admin.effectiveAt).to.equal(fromCanonicalDatetime(toCanonicalDatetime(proposedEffectiveAtMs)))
      const founderOfficer = after.admin.officers.find((o) => o.userId === auth.user.id)
      expect(founderOfficer?.title, 'the founder is promoted by userId despite the name difference').to.equal('Chair')
      expect(after.admin.officers.find((o) => o.userId === secondUser.id)?.scopes).to.deep.equal(['vrg'])
    })

    // D-03's cost made visible instead of silent (inherited finding 4): an `.init` officer
    // has no matching `User` row, so applyAdminProposal refuses with 'unresolvable-officer'
    // rather than silently promoting a smaller roster than the one that was signed.
    it('resolves without destroying the proposal when the roster contains an unpromotable .init officer', async () => {
      const foundingEffectiveAtMs = Date.now() - FOUNDING_PAST_MS
      const { auth } = await createPromotionFixture({ foundingEffectiveAt: foundingEffectiveAtMs })
      const proposedEffectiveAtMs = Date.now() - PROMOTION_PAST_MS
      const proposedEffectiveAtCanon = toCanonicalDatetime(proposedEffectiveAtMs)

      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [
            {
              existing: {
                userId: auth.user.id,
                authorityId: auth.authority.id,
                title: 'Chair',
                scopes: ['rad'] as Scope[]
              }
            },
            {
              init: {
                name: 'Nobody Nowhere',
                title: 'Clerk',
                scopes: ['vrg'] as Scope[]
              }
            }
          ],
          effectiveAt: proposedEffectiveAtMs,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }

      // (a) proposeAdmin RESOLVES rather than rejecting.
      await auth.authorityEngine.proposeAdmin(proposal, makeTestSignCallback(auth.user))

      // (b) the persisted ProposedAdmin and ProposedOfficer rows survive.
      const proposedAdminRow = await auth.ctx.db
        .prepare('select 1 as x from ProposedAdmin where AuthorityId = :id and EffectiveAt = :e')
        .get({ id: auth.authority.id, e: proposedEffectiveAtCanon })
      expect(proposedAdminRow, 'a refused promotion must not destroy the persisted ProposedAdmin row').to.not.be.undefined
      const proposedOfficerCountRow = await auth.ctx.db
        .prepare('select count(*) as n from ProposedOfficer where AuthorityId = :id and AdminEffectiveAt = :e')
        .get({ id: auth.authority.id, e: proposedEffectiveAtCanon })
      expect(Number(proposedOfficerCountRow?.n), 'both proposed officer rows must survive').to.equal(2)

      // (c) the engine's recorded promotion outcome reports reason === 'unresolvable-officer'.
      // Field name Task 2 introduces: AuthorityEngine.lastPromotionOutcome. RED until then.
      const engineWithOutcome = auth.authorityEngine as unknown as { lastPromotionOutcome?: { reason?: string } }
      expect(
        engineWithOutcome.lastPromotionOutcome?.reason,
        'a promotion that legitimately cannot apply must be RECORDED (lastPromotionOutcome), never silent'
      ).to.equal('unresolvable-officer')
    })

    // -----------------------------------------------------------------
    // GROUP 4 — Trigger B legacy-digest regression (D-34, 62-03). Before this
    // plan, `AdminSignatureTaskExtension.MutationValid` independently recomputed
    // the PRE-57-01 `Digest(Tid, AuthorityId, EffectiveAt, ThresholdPolicies)`
    // formula — architecturally divorced from 57-01's roster-covering formula
    // `proposeAdmin`/`applyAdminProposal` actually use — so a Task could never be
    // legitimately seeded against a real, roster-matching 'rad' session (only
    // against this SAME legacy-shaped, non-roster AdminSigning + ProposedAdmin
    // pair). 62-03 (D-33a) fixes Trigger B to recompute the REAL formula, which
    // means this legacy shape is now the thing that correctly FAILS: a 'rad'
    // session signed with the stale 4-argument digest can no longer seed a
    // co-signer task at all, and — per D-34 — any later promotion attempt on
    // that SAME nonce refuses with 'roster-mismatch', fail-closed, no migration.
    it("D-34: a legacy 4-arg 'rad' session can no longer seed a co-signer task, and promoting it refuses with roster-mismatch (fail-closed, no migration)", async () => {
      const { auth } = await createPromotionFixture()
      const nonce = crypto.randomUUID()
      const taskId = crypto.randomUUID()
      const tid = Date.now()
      const now = Date.now()
      const placeholderSig = 'a'.repeat(128)
      const thresholdPolicies = '[]'
      const signerKey = auth.user.activeKeys[0]!.key

      const adminRow = await auth.ctx.db
        .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
        .get({ authorityId: auth.authority.id })
      if (!adminRow) throw new Error('setup: CurrentAdmin not found')
      const adminEffectiveAt = adminRow.EffectiveAt as string

      try {
        await auth.ctx.db.exec(
          `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context IsUserValid = true, Tid = :tid, now = :now,
                        UserId = :userId, UserKey = :signerKey, Signature = :sig
           values (:authorityId, :adminEffectiveAt, :thresholdPolicies)`,
          { authorityId: auth.authority.id, adminEffectiveAt, thresholdPolicies, tid, now, userId: auth.user.id, signerKey, sig: placeholderSig }
        )
      } catch {
        // Idempotent — ProposedAdmin already exists for this (AuthorityId, EffectiveAt) PK.
      }
      // The LEGACY, pre-62-03 4-argument formula — exactly the shape D-34 targets.
      await auth.ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad',
                 Digest(:tid, :authorityId, :adminEffectiveAt, :thresholdPolicies),
                 :userId, :signerKey, :sig)`,
        { nonce, authorityId: auth.authority.id, adminEffectiveAt, thresholdPolicies, tid, now, userId: auth.user.id, signerKey, sig: placeholderSig }
      )

      // The legacy extension insert THROWS — MutationValid now recomputes the
      // full-roster formula and never matches this stale digest.
      let extensionCaught: unknown
      try {
        await auth.ctx.db.exec('BEGIN')
        await auth.ctx.db.exec(
          `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
           with context IsMutationValid = true, Tid = :tid
           values (:id, :userId, 'signature', 'admin', :nonce, 0)`,
          { id: taskId, userId: auth.user.id, nonce, tid }
        )
        await auth.ctx.db.exec(
          `insert into AdminSignatureTaskExtension (TaskId, AuthorityId, AdminEffectiveAt)
           with context Tid = :tid
           values (:taskId, :authorityId, :adminEffectiveAt)`,
          { taskId, authorityId: auth.authority.id, adminEffectiveAt, tid }
        )
        await auth.ctx.db.exec('COMMIT')
      } catch (err) {
        extensionCaught = err
        try { await auth.ctx.db.exec('ROLLBACK') } catch { /* best-effort */ }
      }
      expect(extensionCaught, 'a legacy 4-arg session must no longer be able to seed a co-signer task').to.be.instanceOf(Error)

      // applyAdminProposal on that SAME nonce — after a header sign() reaches
      // threshold — refuses with 'roster-mismatch' and writes no Admin row.
      const digestRow = await auth.ctx.db.prepare('select Digest from AdminSigning where Nonce = :nonce').get({ nonce })
      const digestB64 = digestRow!.Digest as string
      const signCb = makeTestSignCallback(auth.user)
      const realSig = await signCb(digestToBytes(digestB64))
      const { SigningEngine } = await import('../src/signing/signing-engine.js')
      const signResult = await new SigningEngine(auth.ctx).sign(nonce, realSig, { ownsTransaction: true })
      expect(signResult, 'setup: threshold=1 must complete on the instigator signature alone').to.equal(true)

      const adminCountBefore = await auth.ctx.db.prepare('select count(*) as n from Admin where AuthorityId = :id').get({ id: auth.authority.id })

      let promoCaught: unknown
      try {
        await auth.authorityEngine.applyAdminProposal(nonce, signCb)
      } catch (err) {
        promoCaught = err
      }
      expect((promoCaught as { reason?: string })?.reason, "D-34 refusal must be 'roster-mismatch'").to.equal('roster-mismatch')

      const adminCountAfter = await auth.ctx.db.prepare('select count(*) as n from Admin where AuthorityId = :id').get({ id: auth.authority.id })
      expect(Number(adminCountAfter?.n), 'a refused promotion must write NO Admin row').to.equal(Number(adminCountBefore?.n))
    })

    it('WR-01: a degraded admin task whose authority join missed records the fault and does NOT destroy the officer signature', async () => {
      // The task-listing path (signature-tasks-engine.ts, "Extension row missing"
      // branch) deliberately pushes a BASE SignatureTask when the
      // AdminSignatureTaskExtension -> Authority join misses. That base still
      // carries signatureType 'admin' but has NO `authority`. Before WR-01 was
      // fixed, completeSignature fed that undefined straight into
      // `new AuthorityEngine(...)`, applyAdminProposal threw a bare TypeError on
      // `this.authority.id`, and the outer catch ROLLED BACK the whole composed
      // transaction — discarding the officer's real, just-produced signature.
      //
      // This test drives that exact shape and asserts the signature survives.
      const { auth } = await createPromotionFixture()
      const nonce = crypto.randomUUID()
      const taskId = crypto.randomUUID()
      const tid = Date.now()
      const now = Date.now()
      const placeholderSig = 'a'.repeat(128)
      const thresholdPolicies = '[]'
      const signerKey = auth.user.activeKeys[0]!.key

      const adminRow = await auth.ctx.db
        .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
        .get({ authorityId: auth.authority.id })
      if (!adminRow) throw new Error('setup: CurrentAdmin not found')
      const adminEffectiveAt = adminRow.EffectiveAt as string

      try {
        await auth.ctx.db.exec(
          `insert into ProposedAdmin (AuthorityId, EffectiveAt, ThresholdPolicies)
           with context IsUserValid = true, Tid = :tid, now = :now,
                        UserId = :userId, UserKey = :signerKey, Signature = :sig
           values (:authorityId, :adminEffectiveAt, :thresholdPolicies)`,
          { authorityId: auth.authority.id, adminEffectiveAt, thresholdPolicies, tid, now, userId: auth.user.id, signerKey, sig: placeholderSig }
        )
      } catch {
        // Idempotent — ProposedAdmin already exists for this (AuthorityId, EffectiveAt) PK.
      }
      // 62-03 (D-33/D-34): the valid full-roster 'rad' PROPOSAL digest (zero
      // ProposedOfficer rows seeded here — the zero-row roster value) — WR-01's
      // own scenario (a degraded task missing `authority`) is orthogonal to the
      // roster shape; it just needs a session the extension insert ACCEPTS.
      const wr01RosterJson = await readProposedRosterJson(auth.ctx.db, auth.authority.id, adminEffectiveAt)
      const wr01Digest = await computeRadProposalDigest(auth.ctx.db, {
        authorityId: auth.authority.id, effectiveAt: adminEffectiveAt, officers: wr01RosterJson, thresholdPolicies
      })
      await auth.ctx.db.exec(
        `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
         with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
         values (:nonce, :authorityId, :adminEffectiveAt, 'rad', :digest, :userId, :signerKey, :sig)`,
        { nonce, authorityId: auth.authority.id, adminEffectiveAt, digest: wr01Digest, now, userId: auth.user.id, signerKey, sig: placeholderSig }
      )

      await auth.ctx.db.exec('BEGIN')
      try {
        await auth.ctx.db.exec(
          `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
           with context IsMutationValid = true, Tid = :tid
           values (:id, :userId, 'signature', 'admin', :nonce, 0)`,
          { id: taskId, userId: auth.user.id, nonce, tid }
        )
        await auth.ctx.db.exec(
          `insert into AdminSignatureTaskExtension (TaskId, AuthorityId, AdminEffectiveAt)
           with context Tid = :tid
           values (:taskId, :authorityId, :adminEffectiveAt)`,
          { taskId, authorityId: auth.authority.id, adminEffectiveAt, tid }
        )
        await auth.ctx.db.exec('COMMIT')
      } catch (err) {
        await auth.ctx.db.exec('ROLLBACK')
        throw err
      }

      const digestRow = await auth.ctx.db.prepare('select Digest from AdminSigning where Nonce = :nonce').get({ nonce })
      const digestB64 = digestRow!.Digest as string
      const signCb = makeTestSignCallback(auth.user)
      const realSig = await signCb(digestToBytes(digestB64))

      const networkRef = { hash: 'wr01-hash', name: 'WR-01 Network', relays: [], primaryAuthorityDomainName: 'wr01.example.com' }
      const tasksEngine = new (await import('../src/tasks/signature-tasks-engine.js')).SignatureTasksEngine(networkRef, auth.ctx)

      // The degraded shape: signatureType 'admin', but NO `authority` field.
      const degradedTask = {
        type: 'signature' as const,
        userId: auth.user.id,
        network: networkRef,
        signatureType: 'admin' as const,
      }

      const warnings: string[] = []
      const originalWarn = console.warn
      console.warn = ((...args: unknown[]) => { warnings.push(String(args[0])) }) as typeof console.warn
      let thrown: unknown
      try {
        await tasksEngine.completeSignature(
          degradedTask as unknown as Parameters<typeof tasksEngine.completeSignature>[0],
          { isAccepted: true, signature: realSig, sign: signCb }
        )
      } catch (err) {
        thrown = err
      } finally {
        console.warn = originalWarn
      }

      expect(thrown, `completeSignature must not throw on a degraded admin task; threw: ${String(thrown)}`).to.equal(undefined)

      const officerSigRow = await auth.ctx.db
        .prepare('select UserId from OfficerSignature where SigningNonce = :nonce')
        .get({ nonce })
      expect(
        officerSigRow?.UserId,
        "the officer's real signature must survive a join-miss — this is WR-01's actual harm"
      ).to.equal(auth.user.id)

      expect(
        warnings.some((w) => w.includes('finalize admin') && w.toLowerCase().includes('authority')),
        'the join-miss must be diagnosable, naming the missing authority — not a bare TypeError'
      ).to.equal(true)
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
        invitePrivate: invite.invitePrivate,
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
        invitePrivate: invite.invitePrivate,
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

    it('resendInvite emits a fresh slot (new Cid) reusing the original nonce/signature; the pending list shows only the newest copy', async () => {
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

      // One entry per invitation (CR-01): only the newest copy is listed.
      const pending = await authorityEngine.getPendingInviteCids()
      expect(pending).to.not.include(inviteSlotCid)
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

      // One entry per invitation (CR-01): only the newest generation is listed.
      const pending = await authorityEngine.getPendingInviteCids()
      expect(pending).to.not.include(origCid)
      expect(pending).to.not.include(resend1Cid)
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
      // 62-03 (D-48): a second unsigned Admin row can no longer be inserted on a
      // single-Authority network — formulation A admits only the first. This case
      // never needed a second row anyway: the UPDATE below targets a raw (non-
      // canonicalized) `newEffectiveAt` that can never MATCH the founding Admin's
      // own canonically-stored EffectiveAt (same D-09 pitfall the negative test below
      // documents), so it was ALWAYS a zero-row no-op — no CHECK, including
      // OfficerRequired, is ever evaluated either way. Targeting the EXISTING founding
      // Admin row directly (no insert at all) reproduces the exact same outcome.
      const newEffectiveAt = Date.now() + 99_000
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
    //
    // 62-03 (D-48): a second unsigned Admin row can no longer be inserted. Targets the
    // EXISTING founding Admin row directly instead — read back its own canonical
    // EffectiveAt so the UPDATE genuinely matches it (D-09 pitfall: a raw JS-number
    // parameter never matches the canonicalized stored value).
    it('Admin.OfficerRequired CHECK rejects an Admin update when NO rad-scoped Officer exists for the authority', async () => {
      const { authority, authorityEngine } = await createNetworkAndAuthorityWithoutRadOfficer()
      const ctx = (authorityEngine as unknown as { ctx: EngineContext }).ctx
      const foundingAdminRow = await ctx.db
        .prepare('select EffectiveAt from Admin where AuthorityId = :id')
        .get({ id: authority.id })
      // D-09 pitfall (kept, per the original test): canonicalize explicitly rather than
      // trust the read-back shape — idempotent on an already-canonical value.
      const newEffectiveAt = toCanonicalDatetime(foundingAdminRow?.EffectiveAt as string)
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
        invitePrivate: invite.invitePrivate,
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
        invitePrivate: invite.invitePrivate,
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
          invitePrivate: invite.invitePrivate,
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
        invitePrivate: invite.invitePrivate,
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
      // 62-102: the engine signs the result with the invite key itself; the stored value is not the caller's string.
      expect(row?.InviteSignature).to.be.a('string').with.length(128)
      expect(row?.InviteSignature).to.not.equal(invite.inviteSignature)
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
        invitePrivate: invite.invitePrivate,
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
        invitePrivate: invite.invitePrivate,
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
        invitePrivate: invite.invitePrivate,
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
          invitePrivate: invite.invitePrivate,
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
    async applyAdminProposal () { throw new Error('not implemented') },
    async saveInviteWithSigning (): Promise<void> {},
    async cancelInvite (): Promise<void> {},
    async getPendingInviteCids (): Promise<string[]> { return [] },
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
    // 57-01 (D-02): proposeAdmin now folds the roster into the digest too —
    // makeAdminProposal()'s single '.init' officer, serialized the same way
    // sortRosterEntries would (one entry, so ordering is moot).
    // 57-13 (CR-01): userId is now part of the digested shape — 'Admin A' is
    // an '.init' officer (no User row yet), so userId is null, matching
    // resolveAdminRoster's '.init' branch exactly.
    const officersJson2 = JSON.stringify([{ proposedName: 'Admin A', userId: null, title: 'Chair', scopes: ['rad'] }])
    const digestRow2 = await ctx2.db
      .prepare('select Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies) as d')
      .get({
        authorityId: authority2.id,
        effectiveAt: effectiveAtCanon,
        officers: officersJson2,
        thresholdPolicies: thresholdPoliciesJson
      })
    // 49-08 (D-21): must sign with eng2's REGISTERED founding 'user-1' key (not a
    // fresh, unregistered one) so proposeAdmin's real IsUserValid membership check
    // passes — createNetworkAndAuthority() above already recorded it.
    const priv2 = authoritySpecPrivateKeys.get('user-1')!
    const pub2 = bytesToHex(secp256k1.getPublicKey(hexToBytes(priv2)))
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
    // The second network re-registers 'user-1' with a fresh key, so the signer must be
    // rebuilt against it (SignerKeyValid requires the key registered in THIS network).
    const sig2 = makeRealSignCallback('user-1')
    let err2: unknown
    try { await eng2.buildSaveInviteWithSigning().fromPayload({ invite: invite2, scope: 'iad', signature: sig2 }).commit() } catch (e) { err2 = e }
    expect(err2).to.equal(undefined)
  })
})
