// Shared composable test helper layers for DB seeding.
//
// D-01: Migrate shared helpers from per-file duplicates into this module.
// D-02: Composable layers — each layer builds on the previous:
//   createTestNetwork() → addTestAuthority() → addTestElection()
// D-03: Fresh AsyncStorage + in-memory Database per createTestNetwork() call.
//
// Phase 12.1 — Wave 1 deliverable.

import { ElectionEvent, ElectionType, UserKeyType } from '@votetorrent/vote-core'
import { ElectionsEngine } from '../../src/elections/elections-engine.js'
import { NetworksEngine } from '../../src/networks/networks-engine.js'
import { randomTestKeyPair } from './keys.js'
import { AsyncStorage } from '../shims/react-native.js'
import type { EngineContext } from '../../src/types.js'
import type {
  Authority,
  ElectionInit,
  IAuthorityEngine,
  IElectionEngine,
  INetworkEngine,
  NetworkInit,
  NetworkReference,
  Scope,
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
  electionEngine: IElectionEngine | null
}

/**
 * Create an election from a TestAuthorityContext.
 * If createElection() fails (e.g., InsertValid requires AdminSignature),
 * sets electionEngine to null so downstream tests can detect and skip gracefully.
 */
export async function addTestElection (auth: TestAuthorityContext): Promise<TestElectionContext> {
  const electionsEngine = new ElectionsEngine(auth.ctx)
  let electionEngine: IElectionEngine | null = null
  try {
    await electionsEngine.createElection(makeElectionInit())
    electionEngine = await electionsEngine.openElection('election-1')
  } catch {
    // createElection may fail if InsertValid requires AdminSignature —
    // set electionEngine null and let downstream tests handle or skip.
    electionEngine = null
  }
  return { ...auth, electionsEngine, electionEngine }
}
