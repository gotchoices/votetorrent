// Shared composable test helper layers for DB seeding.
//
// D-01: Migrate shared helpers from per-file duplicates into this module.
// D-02: Composable layers — each layer builds on the previous:
//   createTestNetwork() → addTestAuthority() → addTestElection()
// D-03: Fresh AsyncStorage + in-memory Database per createTestNetwork() call.
//
// Phase 12.1 — Wave 1 deliverable.

import { ElectionEvent, ElectionType, UserKeyType } from '@votetorrent/vote-core'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { nowCanonicalDatetime, toCanonicalDatetime, digestToBytes, inviteResultSignedBytes } from '../../src/utils.js'
import { ElectionsEngine, peekNextElectionTid } from '../../src/elections/elections-engine.js'
import { SigningEngine } from '../../src/signing/signing-engine.js'
import { NetworksEngine } from '../../src/networks/networks-engine.js'
import { randomTestKeyPair } from './keys.js'
import { AsyncStorage } from '../shims/react-native.js'
import type { EngineContext } from '../../src/types.js'
import type { DbFactory } from '../../src/types.js'
import type {
  Authority,
  AuthorityInviteInvokes,
  AuthorityInviteShare,
  ElectionInit,
  IAuthorityEngine,
  IElectionEngine,
  INetworkEngine,
  InviteAction,
  NetworkInit,
  NetworkReference,
  OfficerInit,
  Scope,
  Signature,
  User,
} from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// 999.1-09 (R-03): NetworkEngine.respondToInvite's InviteResult.InviteSignature
// CHECK is now verified engine-side for real (verifyAdHocInviteSignature). Test
// fixtures that previously fabricated `inviteSignature: 'a'.repeat(128)` must
// now sign a REAL secp256k1 signature over the A1 LOCKED byte domain using the
// invite's own `invitePrivate` key. These helpers mirror
// `NetworkEngine.respondToInvite`'s signing/digest logic exactly (same field
// order, same `digest()` plugin export) so a fixture-produced signature
// verifies against the engine's own recomputation.
// ---------------------------------------------------------------------------

/**
 * Sign an InviteResult over the A1 LOCKED byte domain
 * ([slotCid, digestToken, String(accept)].join('|')) with the invite's own
 * one-time private key — mirrors `network-engine.ts respondToInvite`'s
 * `verifyAdHocInviteSignature` verification target exactly.
 */
export function signInviteResult (
  invitePrivateHex: string,
  slotCid: string,
  digestToken: string,
  accept: boolean
): string {
  const signedBytes = inviteResultSignedBytes({ slotCid, digestToken, accept })
  return bytesToHex(secp256k1.sign(sha256(signedBytes), hexToBytes(invitePrivateHex)))
}

// NOTE: NetworkEngine.respondToInvite's AUTHORITY-ACCEPTED branch (invoking
// createAuthority) is NOT wired to a real `verifyAdHocInviteSignature` check
// — see the "999.1 R-03 — DOCUMENTED LIMITATION" comment at that call site in
// `network-engine.ts`. Its InviteResult.Digest embeds a server-generated
// `crypto.randomUUID()` unknown to the caller at signing time, so no fixture
// (real or fake) can pre-sign it; `seedAuthorityInvite` below keeps its
// existing placeholder `inviteSignature` for that reason.

// ---------------------------------------------------------------------------
// Layer-0: fixture factories
// ---------------------------------------------------------------------------

// 999.1 R-02/R-04: AdminSigning/OfficerSignature's SignatureValid CHECK now runs the real
// SignatureValid() UDF (verifySig) instead of a hardcoded `context.IsSignatureValid = true`
// stub, so fixture signatures must be genuine secp256k1 signatures over the actual row Digest,
// not a fixed dummy string. `testUserPrivateKeys` retains each fixture user's private scalar
// (discarded before this plan) keyed by user.id, so `makeTestSignature`/`signTestDigest` can
// sign for real. Module-scope map is safe here: mocha runs this suite serially (no --parallel),
// and every `makeTestUser`/`makeDistinctTestUser` call overwrites its id's entry with a fresh
// key before the next signing round in the SAME test.
const testUserPrivateKeys = new Map<string, string>()

/**
 * Create a User fixture with a real secp256k1 hex-encoded public key.
 * Uses randomTestKeyPair() so the key passes the DB's secp256k1 CHECK.
 */
export function makeTestUser (overrides?: Partial<User>): User {
  const { privateHex, publicHex } = randomTestKeyPair()
  const id = overrides?.id ?? 'user-1'
  testUserPrivateKeys.set(id, privateHex)
  return {
    id,
    name: 'Test User',
    imageRef: { url: 'https://img.local/user.png' },
    activeKeys: [
      {
        key: publicHex,
        type: UserKeyType.mobile,
        expiration: Date.now() + 86_400_000,
      },
    ],
    ...overrides,
  }
}

/**
 * 999.1 R-02: sign a SQL `Digest()` output (base64url) for real, using the private key
 * recorded for `user` by `makeTestUser`/`makeDistinctTestUser`. @noble/curves v2 default
 * (prehash:true) — matches the `verifySig()`/`SignatureValid` UDF's expectation, same
 * convention already established by association.spec.ts/registration.spec.ts's `makeRealSigner`.
 */
export function signTestDigest (user: User, digestBase64url: string): Signature {
  const privateHex = testUserPrivateKeys.get(user.id)
  if (!privateHex) {
    throw new Error(
      `signTestDigest: no private key recorded for user.id=${user.id} — was this user created via makeTestUser/makeDistinctTestUser?`
    )
  }
  const privBytes = hexToBytes(privateHex)
  const digestBytes = digestToBytes(digestBase64url)
  const sig = secp256k1.sign(digestBytes, privBytes)
  return {
    signature: bytesToHex(sig),
    signerKey: user.activeKeys[0]!.key,
    signerUserId: user.id,
  }
}

/**
 * 999.1 R-02: real secp256k1 sign callback over caller-supplied digest bytes — for engine
 * methods that accept `(digest: Uint8Array) => Promise<Signature>` (e.g.
 * `AuthorityEngine.saveInviteWithSigning`) and compute the digest internally.
 */
export function makeTestSignCallback (user: User): (digest: Uint8Array) => Promise<Signature> {
  const privateHex = testUserPrivateKeys.get(user.id)
  if (!privateHex) {
    throw new Error(
      `makeTestSignCallback: no private key recorded for user.id=${user.id} — was this user created via makeTestUser/makeDistinctTestUser?`
    )
  }
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return {
      signature: bytesToHex(sig),
      signerKey: user.activeKeys[0]!.key,
      signerUserId: user.id,
    }
  }
}

/**
 * Create a Signature fixture from the given user's first active key.
 *
 * 999.1 R-02: DEPRECATED for any AdminSigning/OfficerSignature insert — the schema now
 * verifies the signature for real, and a fixed dummy string can never match a varying
 * per-row Digest. Kept only for non-AdminSigning context flags that still gate on a
 * literal boolean (e.g. InviteSlot's `IsSignatureValid`, UserKey's `Signature` column check)
 * where the DB never re-verifies the bytes. New AdminSigning/OfficerSignature call sites
 * MUST use `signTestDigest`/`makeTestSignCallback` instead.
 */
export function makeTestSignature (user: User): Signature {
  return {
    signature: 'a'.repeat(128),
    signerKey: user.activeKeys[0]!.key,
    signerUserId: user.id,
  }
}

/**
 * Create a User with a fresh UUID and fresh key pair per call.
 * Use when a test needs a second user identity that won't collide
 * with the 'user-1' seeded by createTestNetwork() (D-07).
 */
export function makeDistinctTestUser (): User {
  const { privateHex, publicHex } = randomTestKeyPair()
  const id = crypto.randomUUID()
  testUserPrivateKeys.set(id, privateHex)
  return {
    id,
    name: 'Distinct Test User',
    imageRef: { url: 'https://img.local/user2.png' },
    activeKeys: [
      {
        key: publicHex,
        type: UserKeyType.mobile,
        expiration: Date.now() + 86_400_000,
      },
    ],
  }
}

/**
 * Create a NetworkInit fixture using the full 6-scope set (rn, rad, iad, uai, mel, ceb).
 * The full scope set is required so authority/election tests that depend on
 * 'ceb'/'mel' scopes work without modifications to the init.
 */
export function makeTestNetworkInit (overrides?: Partial<NetworkInit>): NetworkInit {
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
            scopes: ['rn', 'rad', 'iad', 'uai', 'mel', 'ceb'] as Scope[],
          },
        },
      ],
      effectiveAt: Date.now(),
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }],
    },
    policies: {
      timestampAuthorities: [{ url: 'https://tsa.example.com' }],
      numberRequiredTSAs: 1,
      electionType: ElectionType.adhoc,
    },
    ...overrides,
  }
}

/**
 * Create an ElectionInit fixture for use in election-level tests.
 * Includes the full timeline event set required by the ElectionRevision schema.
 */
export function makeElectionInit (overrides?: Partial<ElectionInit['election']>): ElectionInit {
  const now = Date.now()
  return {
    election: {
      id: 'election-1',
      authorityId: 'authority-1',
      title: 'Test Election',
      date: now + 30 * 86_400_000,
      revisionDeadline: now + 7 * 86_400_000,
      ballotDeadline: now + 14 * 86_400_000,
      type: ElectionType.adhoc,
      ...overrides,
    },
    revision: {
      electionId: overrides?.id ?? 'election-1',
      revision: 0,
      revisionTimestamp: now,
      tags: ['test'],
      instructions: '# Test Election',
      keyholders: [],
      timeline: {
        [ElectionEvent.registrationEnds]: now + 25 * 86_400_000,
        [ElectionEvent.ballotsFinal]: now + 14 * 86_400_000,
        [ElectionEvent.votingStarts]: now + 28 * 86_400_000,
        [ElectionEvent.tallyingStarts]: now + 30 * 86_400_000,
        [ElectionEvent.validation]: now + 31 * 86_400_000,
        [ElectionEvent.certificationStarts]: now + 32 * 86_400_000,
        [ElectionEvent.closed]: now + 33 * 86_400_000,
      },
      keyholderThreshold: 1,
    },
  }
}

// ---------------------------------------------------------------------------
// Layer-2.5: seedElectionSigning primitive (per D-04/D-05)
// ---------------------------------------------------------------------------

/**
 * Seed AdminSigning + AdminSignature rows for the election-scope digest
 * required by Election.InsertValid. No existing engine method produces
 * the election-specific digest formula, so this inserts AdminSigning
 * directly using the DB's Digest() function, then calls SigningEngine.sign()
 * to trigger OfficerSignature + AdminSignature (threshold=1).
 *
 * @returns The signing nonce to pass to createElection({ signingNonce }).
 */
export async function seedElectionSigning (
  ctx: EngineContext,
  authorityId: string,
  electionInit: ElectionInit,
  user: User,
  tid: number
): Promise<{ nonce: string }> {
  const nonce = crypto.randomUUID()
  const e = electionInit.election

  // Resolve CurrentAdmin.EffectiveAt for the authority
  const adminRow = await ctx.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId })
  if (!adminRow) throw new Error('seedElectionSigning: CurrentAdmin not found')
  const adminEffectiveAt = adminRow.EffectiveAt as number | string

  const digestParams = {
    tid: tid, // INTEGER — must be a JS number (not String(tid)): canonical Digest(TAG_INT) vs TEXT causes InsertValid mismatch
    id: e.id,
    authorityId,
    title: e.title,
    date: toCanonicalDatetime(e.date),
    revisionDeadline: toCanonicalDatetime(e.revisionDeadline),
    ballotDeadline: toCanonicalDatetime(e.ballotDeadline),
    type: e.type,
  }
  // 999.1 R-02: compute the REAL digest first (same expression the INSERT below embeds) so
  // `sig` is a genuine secp256k1 signature the schema's SignatureValid UDF can verify.
  const digestRow = await ctx.db
    .prepare('select Digest(:tid, :id, :authorityId, :title, :date, :revisionDeadline, :ballotDeadline, :type) as d')
    .get(digestParams)
  if (!digestRow || digestRow.d == null) throw new Error('seedElectionSigning: Digest() returned null')
  const sig = signTestDigest(user, digestRow.d as string)

  // Insert AdminSigning with election-specific Digest matching Election.InsertValid
  await ctx.db.exec(
    `insert into AdminSigning (
      Nonce,
      AuthorityId,
      AdminEffectiveAt,
      Scope,
      Digest,
      UserId,
      SignerKey,
      Signature
    )
    with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
    values (
      :nonce,
      :authorityId,
      :adminEffectiveAt,
      'mel',
      Digest(:tid, :id, :authorityId, :title, :date, :revisionDeadline, :ballotDeadline, :type),
      :userId,
      :signerKey,
      :signature
    )`,
    {
      ...digestParams,
      nonce,
      adminEffectiveAt,
      userId: user.id,
      signerKey: sig.signerKey,
      signature: sig.signature,
      now: nowCanonicalDatetime(),
    }
  )

  // Call sign() to create OfficerSignature and trigger AdminSignature (threshold=1)
  const signing = new SigningEngine(ctx)
  await signing.sign(nonce, sig)

  return { nonce }
}

// ---------------------------------------------------------------------------
// Layer-2.5b: generic seedSignedMutation fixture (Phase 42 Plan 02)
// ---------------------------------------------------------------------------

/**
 * Generic AdminSigning + AdminSignature seed fixture — the test-fixture twin
 * of `src/signing/signed-mutation.ts`'s `seedSignedMutation` production
 * helper. Mirrors `seedElectionSigning`'s shape (resolve CurrentAdmin ->
 * insert AdminSigning -> SigningEngine.sign) but is parameterized like the
 * production helper so downstream registration/association/authority-config
 * specs can seed the vrg/mel/cap ceremonies without an app-layer signing key
 * — 999.1 R-02: `signTestDigest(user, ...)` produces a genuine secp256k1 signature over the
 * real Digest, standing in for the production `sign` callback (the schema now verifies it).
 *
 * `digestExpr` is a `select <Digest(...)> as d`-shaped SQL expression matching
 * the target table's own InsertValid/MutationValid/DeleteValid CHECK field
 * order EXACTLY (same fidelity requirement as the production helper);
 * `digestParams` supplies its bind params and MUST NOT use the reserved
 * names this fixture itself binds: `nonce`, `authorityId`, `adminEffectiveAt`,
 * `scope`, `userId`, `signerKey`, `signature`, `now`.
 *
 * @returns The signing nonce to pass to the caller's row-insert method
 *   (`with context SigningNonce = :nonce, Tid = ${tid}`).
 */
export async function seedSignedMutation (
  ctx: EngineContext,
  authorityId: string,
  scope: Scope,
  tid: number,
  digestExpr: string,
  digestParams: Record<string, unknown>,
  user: User
): Promise<{ nonce: string }> {
  const nonce = crypto.randomUUID()

  // Resolve CurrentAdmin.EffectiveAt for the authority
  const adminRow = await ctx.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId })
  if (!adminRow) throw new Error(`seedSignedMutation: CurrentAdmin not found for authorityId=${authorityId}`)
  const adminEffectiveAt = adminRow.EffectiveAt as number | string

  // 999.1 R-02: compute the REAL digest first via the caller's own expression, then sign it
  // for real — the schema's SignatureValid UDF now verifies these bytes.
  const digestRow = await ctx.db.prepare(digestExpr).get(digestParams as Record<string, string | number | null>)
  if (!digestRow || digestRow.d == null) throw new Error('seedSignedMutation: Digest() returned null')
  const sig = signTestDigest(user, digestRow.d as string)

  // Insert AdminSigning — embeds the SAME digestExpr so the stored Digest matches
  // whatever a subsequent direct SELECT (or the row's own CHECK) recomputes.
  await ctx.db.exec(
    `insert into AdminSigning (
      Nonce,
      AuthorityId,
      AdminEffectiveAt,
      Scope,
      Digest,
      UserId,
      SignerKey,
      Signature
    )
    with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
    values (
      :nonce,
      :authorityId,
      :adminEffectiveAt,
      :scope,
      (${digestExpr}),
      :userId,
      :signerKey,
      :signature
    )`,
    {
      ...digestParams,
      nonce,
      authorityId,
      adminEffectiveAt,
      scope,
      userId: user.id,
      signerKey: sig.signerKey,
      signature: sig.signature,
      now: nowCanonicalDatetime(),
    }
  )

  // Call sign() to create OfficerSignature and trigger AdminSignature (threshold=1)
  const signing = new SigningEngine(ctx)
  await signing.sign(nonce, sig)

  return { nonce }
}

// ---------------------------------------------------------------------------
// Layer-1: TestNetworkContext
// ---------------------------------------------------------------------------

export interface TestNetworkContext {
  networksEngine: NetworksEngine
  networkEngine: INetworkEngine
  ctx: EngineContext
  user: User
  ref: NetworkReference
}

/**
 * Create a fresh in-memory DB seeded with a network, primary authority,
 * admin, officer, user, and user key. Returns the full TestNetworkContext.
 *
 * D-03: Calls AsyncStorage.clear() before every invocation for test isolation.
 */
export async function createTestNetwork (overrides?: {
  user?: Partial<User>
  network?: Partial<NetworkInit>
  dbFactory?: DbFactory
}): Promise<TestNetworkContext> {
  await AsyncStorage.clear()
  await AsyncStorage.setItem('recentNetworks', [])
  const networksEngine = new NetworksEngine(AsyncStorage, overrides?.dbFactory)
  const user = makeTestUser(overrides?.user)
  const networkInit = makeTestNetworkInit(overrides?.network)
  const networkEngine = await networksEngine.create(networkInit, user)
  const recents = (await AsyncStorage.getItem<NetworkReference[]>('recentNetworks')) ?? []
  const ref = recents[0]
  if (!ref) throw new Error('No network reference after create()')
  const ctx = (networksEngine as unknown as { contexts: Map<string, EngineContext> }).contexts.get(ref.hash)
  if (!ctx) throw new Error('No cached context after create()')
  return { networksEngine, networkEngine, ctx, user, ref }
}

// ---------------------------------------------------------------------------
// Layer-2: TestAuthorityContext
// ---------------------------------------------------------------------------

export interface TestAuthorityContext extends TestNetworkContext {
  authorityEngine: IAuthorityEngine
  authority: Authority
}

/**
 * Open the primary authority from a TestNetworkContext.
 * Returns a TestAuthorityContext with authorityEngine and authority.
 */
export async function addTestAuthority (net: TestNetworkContext): Promise<TestAuthorityContext> {
  const details = await net.networkEngine.getDetails()
  const authorityEngine = await net.networkEngine.openAuthority(details.network.primaryAuthorityId)
  const authorityDetails = await authorityEngine.getDetails()
  return { ...net, authorityEngine, authority: authorityDetails.authority }
}

// ---------------------------------------------------------------------------
// Layer-3: TestElectionContext
// ---------------------------------------------------------------------------

export interface TestElectionContext extends TestAuthorityContext {
  electionsEngine: ElectionsEngine
  electionEngine: IElectionEngine
}

/**
 * Create an election from a TestAuthorityContext by seeding the full
 * AdminSigning/AdminSignature pipeline first. The election always
 * succeeds — no try/catch swallow.
 */
export async function addTestElection (auth: TestAuthorityContext): Promise<TestElectionContext> {
  const electionsEngine = new ElectionsEngine(auth.ctx)
  const init = makeElectionInit({ authorityId: auth.authority.id })
  const tid = await peekNextElectionTid(auth.ctx.db)
  const { nonce } = await seedElectionSigning(auth.ctx, auth.authority.id, init, auth.user, tid)
  await electionsEngine.createElection(init, { signingNonce: nonce })

  // Also seed ElectionRevision (revision 0) so tests that need getElectionDetails work.
  // The ElectionRevision.MutationValid CHECK requires its own AdminSignature pipeline.
  const revNonce = crypto.randomUUID()
  const adminRow = await auth.ctx.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId: auth.authority.id })
  if (!adminRow) throw new Error('addTestElection: CurrentAdmin not found for revision signing')
  const adminEffectiveAt = adminRow.EffectiveAt as number | string
  const revTimestamp = toCanonicalDatetime(Date.now() - 1000)
  const revTags = JSON.stringify(init.revision.tags)
  const revTimeline = JSON.stringify(init.revision.timeline)

  const revDigestParams = {
    electionId: init.election.id,
    revTimestamp,
    tags: revTags,
    instructions: init.revision.instructions,
    timeline: revTimeline,
    keyholderThreshold: init.revision.keyholderThreshold,
  }
  const revDigestRow = await auth.ctx.db
    .prepare('select Digest(1, :electionId, 0, :revTimestamp, :tags, :instructions, :timeline, :keyholderThreshold) as d')
    .get(revDigestParams)
  if (!revDigestRow || revDigestRow.d == null) throw new Error('addTestElection: revision Digest() returned null')
  const revSig = signTestDigest(auth.user, revDigestRow.d as string)

  await auth.ctx.db.exec(
    `insert into AdminSigning (
      Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
    )
    with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
    values (
      :nonce, :authorityId, :adminEffectiveAt, 'mel',
      Digest(1, :electionId, 0, :revTimestamp, :tags, :instructions, :timeline, :keyholderThreshold),
      :userId, :signerKey, :signature
    )`,
    {
      ...revDigestParams,
      nonce: revNonce,
      authorityId: auth.authority.id,
      adminEffectiveAt,
      userId: auth.user.id,
      signerKey: revSig.signerKey,
      signature: revSig.signature,
      now: nowCanonicalDatetime(),
    }
  )

  const revSigning = new SigningEngine(auth.ctx)
  await revSigning.sign(revNonce, revSig)

  // Insert ElectionRevision with the signing nonce
  const nowIso = nowCanonicalDatetime()
  await auth.ctx.db.exec(
    `insert into ElectionRevision (ElectionId, Revision, RevisionTimestamp, Tags, Instructions, Timeline, KeyholderThreshold)
     with context SigningNonce = :signingNonce, Tid = 1, now = :now
     values (:electionId, 0, :revTimestamp, :tags, :instructions, :timeline, :keyholderThreshold)`,
    {
      signingNonce: revNonce,
      electionId: init.election.id,
      revTimestamp,
      tags: revTags,
      instructions: init.revision.instructions,
      timeline: revTimeline,
      keyholderThreshold: init.revision.keyholderThreshold,
      now: nowIso,
    }
  )

  const electionEngine = await electionsEngine.openElection(init.election.id)
  return { ...auth, electionsEngine, electionEngine }
}

// ---------------------------------------------------------------------------
// Layer-2.5: TestInviteContext + seedAuthorityInvite (per D-06)
// ---------------------------------------------------------------------------

export interface TestInviteContext extends TestAuthorityContext {
  inviteShare: AuthorityInviteShare
  inviteSlotCid: string
  /** Canonical ISO 8601 datetime — single source of truth shared with downstream createAuthority (Pitfall 2 mitigation) */
  adminEffectiveAt: string
  /** Officers forwarded to respondToInvite — each has `adminEffectiveAt` populated with the resolved canonical string */
  officers: Array<{ adminEffectiveAt: string; userId: string; title: string; scopes: string }>
}

/**
 * Run the full invite flow chain using real engine methods (D-01):
 *   createAuthorityInvite → saveInviteWithSigning → respondToInvite
 *
 * Returns the inviteSlotCid so callers can pass it to createAuthority()
 * via the optional invite context params added in Plan 01.
 *
 * Phase 12.3-05: accepts an optional `invokes` override so the
 * `respondToInvite` step commits a Digest over the same
 * (name, domainName, imageRef) tuple the downstream createAuthority()
 * insert will reproduce. Callers MUST pass identical values when they
 * later invoke createAuthority() — otherwise Authority.InsertValid's
 * Digest-match clause will fail.
 */
export async function seedAuthorityInvite (
  auth: TestAuthorityContext,
  invokes?: {
    name?: string
    domainName?: string | null
    /** WR-04 (12.4-REVIEW): renamed from `imageRef` to `imageUrl` to match
     * AuthorityInviteInvokes.authority.imageUrl and AuthorityInit.imageUrl
     * — both sites now serialize the same scalar string the same way. */
    imageUrl?: string | null
    admin?: { effectiveAt?: string; thresholdPolicies?: string }
    officers?: Array<{ adminEffectiveAt?: string; userId: string; title: string; scopes: string }>
  }
): Promise<TestInviteContext> {
  const authorityName = invokes?.name ?? 'Second Authority'
  // Preserve explicit null (caller signaled "no domain"); only default
  // when the caller did not supply domainName at all.
  const authorityDomainName = invokes?.domainName === undefined
    ? 'second.example.com'
    : invokes.domainName
  const authorityImageUrl = invokes?.imageUrl

  // Decision 4 (Phase 12.4): resolve a single canonical `adminEffectiveAt`
  // and re-use it everywhere downstream (Pitfall 2 mitigation — eliminates
  // timing drift between fixture and the caller's createAuthority).
  const adminEffectiveAt = invokes?.admin?.effectiveAt ?? nowCanonicalDatetime()
  const thresholdPolicies = invokes?.admin?.thresholdPolicies
    ?? JSON.stringify([{ policy: 'rad', threshold: 1 }])

  // Resolve officers. Default: single officer = the seeded admin user with
  // scope 'rad'. Callers passing officers may omit `adminEffectiveAt` —
  // the fixture fills it in from the resolved canonical adminEffectiveAt
  // (per Task 5 multi-officer test contract).
  const officers = (invokes?.officers ?? [{
    userId: auth.user.id,
    title: 'Member',
    scopes: JSON.stringify(['rad']),
  }]).map(o => ({
    adminEffectiveAt: o.adminEffectiveAt ?? adminEffectiveAt,
    userId: o.userId,
    title: o.title,
    scopes: o.scopes,
  }))

  // Step a: generate a real secp256k1 invite key pair
  const inviteShare = auth.authorityEngine.createAuthorityInvite(authorityName)

  // Step b: 999.1 R-02 — a real sign callback; saveInviteWithSigning computes the InviteSlot
  // Digest engine-side and calls this with the actual digest bytes (D-03/D-04).
  const signCallback = makeTestSignCallback(auth.user)

  // Step c: saveInviteWithSigning inserts InviteSlot + AdminSigning + AdminSignature
  await auth.authorityEngine.saveInviteWithSigning(inviteShare, 'iad' as Scope, signCallback)

  // Step d: query the InviteSlot CID back from the DB
  const slotRow = await auth.ctx.db
    .prepare('select Cid from InviteSlot where InviteKey = :inviteKey')
    .get({ inviteKey: inviteShare.inviteKey })
  if (!slotRow) throw new Error('seedAuthorityInvite: InviteSlot not found after saveInviteWithSigning')
  const inviteSlotCid = slotRow.Cid as string

  // Step e: respondToInvite inserts InviteResult with the 7-arg Digest (D-06)
  const authorityInvokes: { name: string; domainName: string | null; imageUrl?: string | null } = {
    name: authorityName,
    domainName: authorityDomainName,
  }
  if (authorityImageUrl !== undefined) {
    authorityInvokes.imageUrl = authorityImageUrl
  }
  // WR-06 (12.4-REVIEW): typed boundary — pass an explicit
  // `InviteAction<AuthorityInviteInvokes>` so the AuthorityInviteInvokes
  // contract (authority/admin/officers shape) is enforced at the test
  // seam instead of being silently bypassed by `as never`. If a future
  // schema change breaks this shape, the test suite fails at compile time.
  const inviteAction: InviteAction<AuthorityInviteInvokes> = {
    invite: inviteShare,
    isAccepted: true,
    invokes: {
      authority: authorityInvokes,
      admin: { effectiveAt: adminEffectiveAt, thresholdPolicies },
      officers,
    },
    inviteSignature: 'a'.repeat(128),
  }
  await auth.networkEngine.respondToInvite(inviteAction)

  return { ...auth, inviteShare, inviteSlotCid, adminEffectiveAt, officers }
}

// ---------------------------------------------------------------------------
// Layer-2.5: seedUserInvite primitive (Phase 12.3-03)
// ---------------------------------------------------------------------------

export interface SeedUserInviteResult {
  /** Cid of the InviteSlot row — pass to User insert as context.InviteSlotCid */
  inviteSlotCid: string
  /** InviteSignature stored on the InviteSlot row — pass to User insert as context.InviteSignature */
  inviteSignature: string
}

/**
 * Seed an officer-scope InviteSlot via real engine methods so that
 * `User.InsertValid`'s invite-bound branch is satisfied for an nth user.
 *
 * Schema reference (votetorrent.qsql User.InsertValid):
 *   exists (select 1 from InviteSlot I
 *           where I.Cid = context.InviteSlotCid
 *             and I.InviteSignature = context.InviteSignature)
 *
 * There is no `'u'` InviteType — the User row is always created off the
 * back of an officer / keyholder / registrant invite. Officer ('of') is
 * the simplest available chain because `createOfficerInvite` +
 * `saveInviteWithSigning(_, 'rad', _)` are already exposed on
 * IAuthorityEngine. This mirrors `seedAuthorityInvite` but stops at the
 * InviteSlot step (no respondToInvite required — User.InsertValid only
 * checks for an InviteSlot row, not an InviteResult row).
 *
 * Phase 12.3-07 (Group E) will compose this helper with the actual User
 * insert. If that plan surfaces a missing engine method for the user-side
 * of the invite flow, it should be addressed there — this helper provides
 * the seed half only.
 */
export async function seedUserInvite (
  auth: TestAuthorityContext,
  newUser: User,
  overrides?: { officerInit?: Partial<OfficerInit> }
): Promise<SeedUserInviteResult> {
  const officerInit: OfficerInit = {
    name: overrides?.officerInit?.name ?? newUser.name,
    title: overrides?.officerInit?.title ?? 'Member',
    scopes: (overrides?.officerInit?.scopes ?? (['rad'] as Scope[])) as Scope[],
  }

  // Step a: build an OfficerInviteShare with a real one-time secp256k1 key pair
  const officerInvite = auth.authorityEngine.createOfficerInvite(officerInit)

  // Step b: 999.1 R-02 — a real sign callback from the seeded admin user (the
  // AdminSigning.SignatureValid UDF now verifies this for real).
  const signCallback = makeTestSignCallback(auth.user)

  // Step c: saveInviteWithSigning inserts InviteSlot + AdminSigning + AdminSignature
  //         (scope 'rad' matches the seeded admin's threshold policy in makeTestNetworkInit)
  await auth.authorityEngine.saveInviteWithSigning(officerInvite, 'rad' as Scope, signCallback)

  // Step d: query the InviteSlot CID back from the DB so the caller can
  //         bind it (alongside the original InviteSignature) into the
  //         User insert's `with context InviteSlotCid = ..., InviteSignature = ...` clause.
  const slotRow = await auth.ctx.db
    .prepare('select Cid from InviteSlot where InviteKey = :inviteKey and Type = :type')
    .get({ inviteKey: officerInvite.inviteKey, type: 'of' })
  if (!slotRow) throw new Error('seedUserInvite: InviteSlot not found after saveInviteWithSigning')
  const inviteSlotCid = slotRow.Cid as string

  return { inviteSlotCid, inviteSignature: officerInvite.inviteSignature }
}

// ---------------------------------------------------------------------------
// Layer-2.5: seedKeyholderInvite primitive (Phase 19-05, SURF-05)
// ---------------------------------------------------------------------------

export interface SeedKeyholderInviteResult {
  /** Cid of the seeded Type='k' InviteSlot row */
  inviteSlotCid: string
  /** Name stored on the InviteSlot row (= SentKeyholderInvite.name) */
  name: string
}

/**
 * Seed a keyholder-scope (Type='k') InviteSlot so `getKeyholderInvite(cid)`
 * has a row to read. There is no `createKeyholderInvite` engine method, so we
 * mirror `AuthorityEngine.saveOfficerInvite` inline with `Type='k'`:
 *
 *   1. reuse `createOfficerInvite` for a real one-time secp256k1 key pair +
 *      InviteSignature (the slot's CHECKs gate on `context.Is*Valid = true`,
 *      not on re-derived field values, so the officer-shaped share is fine);
 *   2. raw-INSERT the InviteSlot with `Type='k'` under a fresh SigningNonce;
 *   3. call `startSigningSession(authorityId, null, 'rad', sig, nonce)` (D-17
 *      PATH B) so the matching AdminSigning row satisfies the batch-level
 *      `InviteSlotSigningValid` assertion (`Digest(Cid) WHERE SigningNonce`).
 *
 * Stops at the InviteSlot step (no InviteResult) — `getKeyholderInvite`'s
 * LEFT JOIN leaves `result` undefined, which is the load-only read this phase
 * proves.
 */
export async function seedKeyholderInvite (
  auth: TestAuthorityContext,
  overrides?: { name?: string }
): Promise<SeedKeyholderInviteResult> {
  const name = overrides?.name ?? 'Some Keyholder'

  // Step a: real one-time secp256k1 key material + InviteSignature.
  const share = auth.authorityEngine.createOfficerInvite({
    name,
    title: 'Keyholder',
    scopes: ['rad'] as Scope[],
  })

  // Step b: a fresh nonce the AdminSigning (step d) will sign over.
  const signing = new SigningEngine(auth.ctx)
  const nonce = signing.generateSigningNonce()

  // Step c: raw InviteSlot insert with Type='k' (mirrors saveOfficerInvite,
  // retargeting the type). Cid is the SQL Digest over the slot fields.
  await auth.ctx.db.exec(
    `insert into InviteSlot (
        Cid,
        Type,
        Name,
        Expiration,
        InviteKey,
        InviteSignature,
        SigningNonce
      )
      with context Tid = :tid, now = :now, IsSignatureValid = true, IsInsertValid = true
      values (
        cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)),
        :type,
        :name,
        :expiration,
        :inviteKey,
        :inviteSignature,
        :nonce
      )`,
    {
      type: 'k',
      name,
      expiration: share.expiration,
      inviteKey: share.inviteKey,
      inviteSignature: share.inviteSignature,
      nonce,
      tid: Date.now(),
      now: nowCanonicalDatetime(),
    }
  )

  // Step d: AdminSigning (PATH B) over the InviteSlot tagged with this nonce —
  // satisfies the InviteSlotSigningValid batch assertion.
  // 999.1 R-02: startSigningSession takes a completed Signature (no callback form), so
  // compute the real digest first (same subquery PATH B embeds) and sign it for real.
  const slotDigestRow = await auth.ctx.db
    .prepare('select Digest(Cid) as d from InviteSlot where SigningNonce = :nonce')
    .get({ nonce })
  if (!slotDigestRow || slotDigestRow.d == null) throw new Error('seedKeyholderInvite: InviteSlot Digest() returned null')
  await signing.startSigningSession(
    auth.authority.id,
    null,
    'rad' as Scope,
    signTestDigest(auth.user, slotDigestRow.d as string),
    nonce
  )

  // Step e: read the Cid back so the caller can pass it to getKeyholderInvite.
  const slotRow = await auth.ctx.db
    .prepare('select Cid from InviteSlot where InviteKey = :inviteKey and Type = :type')
    .get({ inviteKey: share.inviteKey, type: 'k' })
  if (!slotRow) throw new Error('seedKeyholderInvite: InviteSlot not found after insert')

  return { inviteSlotCid: slotRow.Cid as string, name }
}

// ---------------------------------------------------------------------------
// Layer-3: seedBallot helper (Phase 12.3-03)
// ---------------------------------------------------------------------------

export interface SeedBallotResult {
  ballotId: string
}

/**
 * Seed a `Ballot` row so that `ProposedQuestion.BallotIdValid` and
 * `ProposedOption.BallotIdValid` (both `exists (select 1 from Ballot ...)`)
 * are satisfied for downstream `addQuestion` / `addOption` calls.
 *
 * Note: `IElectionEngine.proposeBallot` only INSERTs into `ProposedBallot`,
 * not `Ballot`. The Ballot-row insert lives downstream of an accepted
 * proposal (Ballot.MutationValid requires AdminSignature scope='ceb' with
 * `Digest(Tid, Id, ElectionId, AuthorityId, Description, Districts)`).
 * No engine method currently fires that insert, so this helper composes
 * the AdminSigning ('ceb') + raw Ballot INSERT itself — mirroring how
 * `seedElectionSigning` + `addTestElection` compose the Election scope.
 *
 * Test intent stays unchanged: callers receive `{ ballotId }` and can
 * issue `addQuestion(ballotId, q)` / `addOption(ballotId, q.code, o, i)`.
 */
export async function seedBallot (
  elec: TestElectionContext,
  ballotId: string = 'ballot-1'
): Promise<SeedBallotResult> {
  // electionEngine.election is private; resolve the election id off the DB
  // via the authority's most recent Election row. addTestElection seeds
  // exactly one Election per authority so this is unambiguous.
  const authorityId = elec.authority.id
  const electionRow = await elec.ctx.db
    .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
    .get({ authorityId })
  if (!electionRow) throw new Error('seedBallot: Election not found for authority')
  const electionId = electionRow.Id as string
  const description = 'Test Ballot'
  const districts = JSON.stringify([])

  // ---- Step 1: AdminSigning (scope='ceb') with the Ballot's digest formula
  const nonce = crypto.randomUUID()

  const adminRow = await elec.ctx.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId })
  if (!adminRow) throw new Error('seedBallot: CurrentAdmin not found')
  const adminEffectiveAt = adminRow.EffectiveAt as number | string

  const ballotDigestParams = { id: ballotId, electionId, authorityId, description, districts }
  const ballotDigestRow = await elec.ctx.db
    .prepare('select Digest(1, :id, :electionId, :authorityId, :description, :districts) as d')
    .get(ballotDigestParams)
  if (!ballotDigestRow || ballotDigestRow.d == null) throw new Error('seedBallot: Digest() returned null')
  const sig = signTestDigest(elec.user, ballotDigestRow.d as string)

  await elec.ctx.db.exec(
    `insert into AdminSigning (
      Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
    )
    with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
    values (
      :nonce, :authorityId, :adminEffectiveAt, 'ceb',
      Digest(1, :id, :electionId, :authorityId, :description, :districts),
      :userId, :signerKey, :signature
    )`,
    {
      ...ballotDigestParams,
      nonce,
      adminEffectiveAt,
      userId: elec.user.id,
      signerKey: sig.signerKey,
      signature: sig.signature,
      now: nowCanonicalDatetime(),
    }
  )

  // ---- Step 2: AdminSignature (threshold=1 auto-completes via SigningEngine.sign)
  const signing = new SigningEngine(elec.ctx)
  await signing.sign(nonce, sig)

  // ---- Step 3: Ballot insert under the signed nonce.
  //              Ballot.MutationValid recomputes Digest(Tid, Id, ElectionId,
  //              AuthorityId, Description, Districts); the AdminSignature
  //              row inserted above matches that tuple verbatim.
  await elec.ctx.db.exec(
    `insert into Ballot (Id, ElectionId, AuthorityId, Description, Districts)
     with context SigningNonce = :nonce, Tid = 1, now = :now
     values (:id, :electionId, :authorityId, :description, :districts)`,
    {
      nonce,
      id: ballotId,
      electionId,
      authorityId,
      description,
      districts,
      now: nowCanonicalDatetime(),
    }
  )

  return { ballotId }
}

// ---------------------------------------------------------------------------
// Layer-3: seedQuestion helper (Phase 12.4-02)
// ---------------------------------------------------------------------------

export interface SeedQuestionInput {
  code: string
  title: string
  instructions: string
  type: string
  dependsOn?: string | null
  optionRange?: string
  scoreRange?: string | null
  grouping?: string | null
  sequence?: number | null
  required?: boolean
}

export interface SeedQuestionResult {
  questionCode: string
}

/**
 * Seed a canonical `Question` row so that `ProposedOption.QuestionCodeValid`
 * (`exists (select 1 from Question Q where Q.BallotId = new.BallotId and
 * Q.Code = new.QuestionCode)`) is satisfied for downstream `addOption`
 * calls. Layer-3 fixture, parallel to `seedBallot`.
 *
 * Why this exists: `ElectionEngine.addQuestion` writes only to
 * `ProposedQuestion`, not the canonical `Question` table. `Question.MutationValid`
 * (votetorrent.qsql:672-682) requires a full AdminSignature pipeline with
 * scope='ceb' and a 12-arg Digest over (Tid, BallotId, Code, Title,
 * Instructions, DependsOn, Type, OptionRange, ScoreRange, Grouping,
 * Sequence, Required). This helper composes the same 3-step spine as
 * `seedBallot`: AdminSigning('ceb') + SigningEngine.sign + raw Question
 * INSERT.
 *
 * Quereus 3.3.0 NULL-bug bypass: the schema declares
 * `OptionRange text default '{1, 1}'` and `Required integer default 1`
 * (37-04 / D-05b re-attach fix — was `boolean default true`).
 * Quereus 3.3.0 incorrectly rejects NULL-bound writes to default-valued
 * columns (tracked at 260528-001-quereus-not-null-text-null-column).
 * This helper resolves both defaults JS-side BEFORE building the
 * AdminSigning Digest tuple, so non-NULL explicit values are bound in
 * BOTH the Digest call and the Question INSERT — keeping the recomputed
 * Question.MutationValid Digest equal to the AdminSigning Digest.
 */
export async function seedQuestion (
  elec: TestElectionContext,
  ballotId: string,
  q: SeedQuestionInput
): Promise<SeedQuestionResult> {
  // ---- Step 0: Resolve defaults JS-side (Pitfall 1: avoids binding NULL
  //              into default-valued columns, which trips the quereus 3.3.0
  //              NULL-bug). These resolved values are the single source of
  //              truth — they must match the schema literal defaults exactly
  //              ('{1, 1}', true) and they are bound into BOTH the
  //              AdminSigning Digest call (Step 2) and the Question INSERT
  //              (Step 4) so the Digest equality in Question.MutationValid
  //              holds.
  const dependsOn = q.dependsOn ?? null
  const optionRange = q.optionRange ?? '{1, 1}'
  const scoreRange = q.scoreRange ?? null
  const grouping = q.grouping ?? null
  const sequence = q.sequence ?? null
  // Required is now `integer default 1` (37-04 / D-05b re-attach fix — was
  // `boolean default true`). Bind an integer 0/1 (not a JS boolean) into
  // BOTH the Digest call (Step 2) and the Question INSERT (Step 4) so the
  // recomputed Question.MutationValid Digest matches the AdminSigning
  // Digest — same single-source-of-truth pattern as the OptionRange/
  // ScoreRange defaults above.
  const required = (q.required ?? true) ? 1 : 0

  // ---- Step 1: Resolve CurrentAdmin.EffectiveAt for the authority
  const authorityId = elec.authority.id
  const adminRow = await elec.ctx.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId })
  if (!adminRow) throw new Error('seedQuestion: CurrentAdmin not found')
  const adminEffectiveAt = adminRow.EffectiveAt as number | string

  // ---- Step 2: AdminSigning (scope='ceb') with the 12-arg Question digest
  //              formula matching Question.MutationValid at qsql:672-682.
  const nonce = crypto.randomUUID()

  const qDigestParams = {
    ballotId,
    code: q.code,
    title: q.title,
    instructions: q.instructions,
    dependsOn,
    type: q.type,
    optionRange,
    scoreRange,
    grouping,
    sequence,
    required,
  }
  const qDigestRow = await elec.ctx.db
    .prepare(
      'select Digest(1, :ballotId, :code, :title, :instructions, :dependsOn, :type, :optionRange, :scoreRange, :grouping, :sequence, :required) as d'
    )
    .get(qDigestParams)
  if (!qDigestRow || qDigestRow.d == null) throw new Error('seedQuestion: Digest() returned null')
  const sig = signTestDigest(elec.user, qDigestRow.d as string)

  await elec.ctx.db.exec(
    `insert into AdminSigning (
      Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
    )
    with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
    values (
      :nonce, :authorityId, :adminEffectiveAt, 'ceb',
      Digest(1, :ballotId, :code, :title, :instructions, :dependsOn, :type, :optionRange, :scoreRange, :grouping, :sequence, :required),
      :userId, :signerKey, :signature
    )`,
    {
      ...qDigestParams,
      nonce,
      authorityId,
      adminEffectiveAt,
      userId: elec.user.id,
      signerKey: sig.signerKey,
      signature: sig.signature,
      now: nowCanonicalDatetime(),
    }
  )

  // ---- Step 3: AdminSignature (threshold=1 auto-completes via SigningEngine.sign)
  const signing = new SigningEngine(elec.ctx)
  await signing.sign(nonce, sig)

  // ---- Step 4: Question insert under the signed nonce.
  //              Question.MutationValid recomputes Digest(Tid, BallotId,
  //              Code, Title, Instructions, DependsOn, Type, OptionRange,
  //              ScoreRange, Grouping, Sequence, Required); the
  //              AdminSignature row inserted above matches that tuple
  //              verbatim because every default-column value comes from
  //              the shared Step-0 locals.
  await elec.ctx.db.exec(
    `insert into Question (
      BallotId, Code, Title, Instructions, DependsOn, Type,
      OptionRange, ScoreRange, Grouping, Sequence, Required
    )
    with context SigningNonce = :nonce, Tid = 1, now = :now
    values (
      :ballotId, :code, :title, :instructions, :dependsOn, :type,
      :optionRange, :scoreRange, :grouping, :sequence, :required
    )`,
    {
      nonce,
      ballotId,
      code: q.code,
      title: q.title,
      instructions: q.instructions,
      dependsOn,
      type: q.type,
      optionRange,
      scoreRange,
      grouping,
      sequence,
      required,
      now: nowCanonicalDatetime(),
    }
  )

  return { questionCode: q.code }
}

// ---------------------------------------------------------------------------
// Layer-3: seedProposedBallot helper (Phase 31-01)
// ---------------------------------------------------------------------------

export interface SeedProposedBallotResult {
  ballotId: string
}

/**
 * Seed a `ProposedBallot` draft (with a real `Questions` JSON blob) by calling
 * the engine's `proposeBallot`. Distinct from `seedBallot`, which composes
 * AdminSigning + Ballot INSERT for a FINALIZED ballot.
 *
 * This helper exercises the real propose path — tests that rely on
 * `submitBallotForConfirmation` must start here, not with `seedBallot`.
 *
 * Default question: one `'select'` question (verified-safe per Pitfall 5 /
 * quereus#21) with two options — the ≥2-option count is load-bearing for
 * 31-03 Task 3's per-option readability assertion.
 *
 * T-31-01 mitigation: Questions JSON is constructed from the canonical
 * Question[] shape so downstream digest matches. Tid is bound as a JS number
 * inside proposeBallot itself (election-engine.ts nextTid++) — callers do not
 * need to manage the Tid.
 */
export async function seedProposedBallot (
  elec: TestElectionContext,
  ballotId: string = 'proposed-ballot-1'
): Promise<SeedProposedBallotResult> {
  // Resolve the election id from the DB (electionEngine.election is private).
  const authorityId = elec.authority.id
  const electionRow = await elec.ctx.db
    .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
    .get({ authorityId })
  if (!electionRow) throw new Error('seedProposedBallot: Election not found for authority')
  const electionId = electionRow.Id as string

  // Default ballot: one 'select' question with 2 options (≥2 required by D-07 and the
  // per-option readability assertion in 31-03 Task 3).
  const ballot: import('@votetorrent/vote-core').Ballot = {
    id: ballotId,
    electionId,
    authorityId,
    description: 'Test Proposed Ballot',
    districts: [],
    questions: [
      {
        code: 'Q1',
        title: 'Test Question',
        instructions: 'Choose one option.',
        type: 'select',
        options: [
          { code: 'A', title: 'Option A' },
          { code: 'B', title: 'Option B' },
        ],
      },
    ],
  }

  await elec.electionEngine.proposeBallot(ballot)

  return { ballotId }
}
