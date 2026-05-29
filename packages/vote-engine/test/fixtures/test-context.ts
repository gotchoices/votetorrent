// Shared composable test helper layers for DB seeding.
//
// D-01: Migrate shared helpers from per-file duplicates into this module.
// D-02: Composable layers — each layer builds on the previous:
//   createTestNetwork() → addTestAuthority() → addTestElection()
// D-03: Fresh AsyncStorage + in-memory Database per createTestNetwork() call.
//
// Phase 12.1 — Wave 1 deliverable.

import { ElectionEvent, ElectionType, UserKeyType } from '@votetorrent/vote-core'
import { nowCanonicalDatetime, toCanonicalDatetime } from '../../src/utils.js'
import { ElectionsEngine, peekNextElectionTid } from '../../src/elections/elections-engine.js'
import { SigningEngine } from '../../src/signing/signing-engine.js'
import { NetworksEngine } from '../../src/networks/networks-engine.js'
import { randomTestKeyPair } from './keys.js'
import { AsyncStorage } from '../shims/react-native.js'
import type { EngineContext } from '../../src/types.js'
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
// Layer-0: fixture factories
// ---------------------------------------------------------------------------

/**
 * Create a User fixture with a real secp256k1 hex-encoded public key.
 * Uses randomTestKeyPair() so the key passes the DB's secp256k1 CHECK.
 */
export function makeTestUser (overrides?: Partial<User>): User {
  const { publicHex } = randomTestKeyPair()
  return {
    id: 'user-1',
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
 * Create a Signature fixture from the given user's first active key.
 * Uses a dummy 128-char hex signature since the DB bypasses crypto
 * validation via IsSignatureValid = true context (D-02).
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
  const { publicHex } = randomTestKeyPair()
  return {
    id: crypto.randomUUID(),
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
  const sig = makeTestSignature(user)

  // Resolve CurrentAdmin.EffectiveAt for the authority
  const adminRow = await ctx.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId })
  if (!adminRow) throw new Error('seedElectionSigning: CurrentAdmin not found')
  const adminEffectiveAt = adminRow.EffectiveAt as number | string

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
    with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
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
      nonce,
      authorityId,
      adminEffectiveAt,
      tid: String(tid),
      id: e.id,
      title: e.title,
      date: toCanonicalDatetime(e.date),
      revisionDeadline: toCanonicalDatetime(e.revisionDeadline),
      ballotDeadline: toCanonicalDatetime(e.ballotDeadline),
      type: e.type,
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
}): Promise<TestNetworkContext> {
  await AsyncStorage.clear()
  await AsyncStorage.setItem('recentNetworks', [])
  const networksEngine = new NetworksEngine(AsyncStorage)
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
  const tid = peekNextElectionTid()
  const { nonce } = await seedElectionSigning(auth.ctx, auth.authority.id, init, auth.user, tid)
  await electionsEngine.createElection(init, { signingNonce: nonce })

  // Also seed ElectionRevision (revision 0) so tests that need getElectionDetails work.
  // The ElectionRevision.MutationValid CHECK requires its own AdminSignature pipeline.
  const revNonce = crypto.randomUUID()
  const revSig = makeTestSignature(auth.user)
  const adminRow = await auth.ctx.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId: auth.authority.id })
  if (!adminRow) throw new Error('addTestElection: CurrentAdmin not found for revision signing')
  const adminEffectiveAt = adminRow.EffectiveAt as number | string
  const revTimestamp = toCanonicalDatetime(Date.now() - 1000)
  const revTags = JSON.stringify(init.revision.tags)
  const revTimeline = JSON.stringify(init.revision.timeline)

  await auth.ctx.db.exec(
    `insert into AdminSigning (
      Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
    )
    with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
    values (
      :nonce, :authorityId, :adminEffectiveAt, 'mel',
      Digest(1, :electionId, 0, :revTimestamp, :tags, :instructions, :timeline, :keyholderThreshold),
      :userId, :signerKey, :signature
    )`,
    {
      nonce: revNonce,
      authorityId: auth.authority.id,
      adminEffectiveAt,
      electionId: init.election.id,
      revTimestamp,
      tags: revTags,
      instructions: init.revision.instructions,
      timeline: revTimeline,
      keyholderThreshold: init.revision.keyholderThreshold,
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

  // Step b: build signature from the test user
  const sig = makeTestSignature(auth.user)

  // Step c: saveInviteWithSigning inserts InviteSlot + AdminSigning + AdminSignature
  await auth.authorityEngine.saveInviteWithSigning(inviteShare, 'iad' as Scope, sig)

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

  // Step b: signature from the seeded admin user (validated via context.IsSignatureValid)
  const sig = makeTestSignature(auth.user)

  // Step c: saveInviteWithSigning inserts InviteSlot + AdminSigning + AdminSignature
  //         (scope 'rad' matches the seeded admin's threshold policy in makeTestNetworkInit)
  await auth.authorityEngine.saveInviteWithSigning(officerInvite, 'rad' as Scope, sig)

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
  const sig = makeTestSignature(elec.user)

  const adminRow = await elec.ctx.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId })
  if (!adminRow) throw new Error('seedBallot: CurrentAdmin not found')
  const adminEffectiveAt = adminRow.EffectiveAt as number | string

  await elec.ctx.db.exec(
    `insert into AdminSigning (
      Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
    )
    with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
    values (
      :nonce, :authorityId, :adminEffectiveAt, 'ceb',
      Digest(1, :id, :electionId, :authorityId, :description, :districts),
      :userId, :signerKey, :signature
    )`,
    {
      nonce,
      authorityId,
      adminEffectiveAt,
      id: ballotId,
      electionId,
      description,
      districts,
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
 * `OptionRange text default '{1, 1}'` and `Required boolean default true`.
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
  const required = q.required ?? true

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
  const sig = makeTestSignature(elec.user)

  await elec.ctx.db.exec(
    `insert into AdminSigning (
      Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
    )
    with context now = :now, IsSignatureValid = true, IsSignerKeyValid = true
    values (
      :nonce, :authorityId, :adminEffectiveAt, 'ceb',
      Digest(1, :ballotId, :code, :title, :instructions, :dependsOn, :type, :optionRange, :scoreRange, :grouping, :sequence, :required),
      :userId, :signerKey, :signature
    )`,
    {
      nonce,
      authorityId,
      adminEffectiveAt,
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
