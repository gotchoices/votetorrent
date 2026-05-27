// Shared composable test helper layers for DB seeding.
//
// D-01: Migrate shared helpers from per-file duplicates into this module.
// D-02: Composable layers — each layer builds on the previous:
//   createTestNetwork() → addTestAuthority() → addTestElection()
// D-03: Fresh AsyncStorage + in-memory Database per createTestNetwork() call.
//
// Phase 12.1 — Wave 1 deliverable.

import { Temporal } from 'temporal-polyfill'
import { ElectionEvent, ElectionType, UserKeyType } from '@votetorrent/vote-core'
import { ElectionsEngine, peekNextElectionTid } from '../../src/elections/elections-engine.js'
import { SigningEngine } from '../../src/signing/signing-engine.js'
import { NetworksEngine } from '../../src/networks/networks-engine.js'
import { randomTestKeyPair } from './keys.js'
import { AsyncStorage } from '../shims/react-native.js'
import type { EngineContext } from '../../src/types.js'
import type {
  Authority,
  AuthorityInviteShare,
  ElectionInit,
  IAuthorityEngine,
  IElectionEngine,
  INetworkEngine,
  NetworkInit,
  NetworkReference,
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
      date: Temporal.Instant.fromEpochMilliseconds(e.date).toString(),
      revisionDeadline: Temporal.Instant.fromEpochMilliseconds(e.revisionDeadline).toString(),
      ballotDeadline: Temporal.Instant.fromEpochMilliseconds(e.ballotDeadline).toString(),
      type: e.type,
      userId: user.id,
      signerKey: sig.signerKey,
      signature: sig.signature,
      now: Date.now(),
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
  const electionEngine = await electionsEngine.openElection(init.election.id)
  return { ...auth, electionsEngine, electionEngine }
}
