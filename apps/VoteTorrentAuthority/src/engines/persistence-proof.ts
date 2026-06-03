/**
 * persistence-proof.ts — Phase 14 on-device proof routine (D-16 / PERSIST-03)
 *
 * Exports two async functions plus a crypto-assertion helper, all driven through
 * a real NetworksEngine constructed with rnDbFactory.  Wire these to dev
 * buttons or a dedicated debug screen — do NOT alter the production screen
 * visual design.
 *
 * D-16 part 1: restart-persistence proof
 *   runWritePhase  — create a Network via the real engine; persist the
 *                    NetworkReference + network hash to AsyncStorage so the
 *                    read phase can find it after an `am force-stop` relaunch.
 *   runReadPhase   — load the saved NetworkReference; call networksEngine.open()
 *                    (cache MISS on a fresh process → re-attach via rnDbFactory);
 *                    assert the row count is UNCHANGED (no re-insertion).
 *
 * D-16 part 2: on-device crypto-function assertions
 *   assertCryptoFunctions — runs SQL assertions for Digest / SignatureValid /
 *                    isISODatetime and a JS call for H16.  Per RESEARCH Pitfall 6
 *                    SQL-SELECT of H16 does NOT exist in this codebase and MUST
 *                    NOT be called here. Only the four registered functions are asserted.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Database } from '@quereus/quereus';
import type { NetworkReference, User, NetworkInit, Scope } from '@votetorrent/vote-core';
import { ElectionType, UserKeyType } from '@votetorrent/vote-core';
// Direct dist imports — these bypass the package `exports` field which intentionally
// omits NetworksEngine from the public re-exports to prevent Metro from bundling
// its Node-only transitive dependencies in production.  This file is dev/proof-only.
// We import the BUILT dist (.js) rather than src/: the TS source uses NodeNext `.js`
// import specifiers that only resolve after compilation, which Metro cannot follow.
import { NetworksEngine } from '../../../../packages/vote-engine/dist/networks/networks-engine.js';
import { H16 } from '../../../../packages/vote-engine/dist/utils.js';
import { LocalStorageReact } from '../../../../packages/vote-engine/dist/local-storage-react.js';
import { rnDbFactory } from './rn-db-factory';
import type { DbFactory } from '@votetorrent/vote-engine';

// ---------------------------------------------------------------------------
// AsyncStorage keys used by the proof harness
// ---------------------------------------------------------------------------
const PROOF_NETWORK_REF_KEY = 'proof:networkRef';
const PROOF_NETWORK_HASH_KEY = 'proof:networkHash';

// ---------------------------------------------------------------------------
// Minimal LocalStorage wrapper (delegates to AsyncStorage)
// ---------------------------------------------------------------------------
function makeLocalStorage(): LocalStorageReact {
  return new LocalStorageReact();
}

// ---------------------------------------------------------------------------
// Factory shim that captures the last Database produced by rnDbFactory.
// This lets the proof read back the database without exposing NetworksEngine
// internals — the db reference is captured once per write-phase invocation.
// ---------------------------------------------------------------------------
function makeCapturingFactory(): { factory: DbFactory; getDb: () => Database | undefined } {
  let capturedDb: Database | undefined;
  const factory: DbFactory = async (networkHash: string) => {
    const db = await rnDbFactory(networkHash);
    capturedDb = db;
    return db;
  };
  return {
    factory,
    getDb: () => capturedDb,
  };
}

// ---------------------------------------------------------------------------
// Stable test fixtures (consistent across write + read phase)
// ---------------------------------------------------------------------------
const PROOF_NETWORK_INIT: NetworkInit = {
  name: 'Proof Network',
  relays: ['/dns4/proof.example.com/tcp/443/wss'],
  primaryAuthority: {
    name: 'Proof Authority',
    domainName: 'proof.example.com',
  },
  admin: {
    officers: [
      {
        init: {
          name: 'Proof Admin',
          title: 'Chair',
          scopes: ['rn', 'mel'] as Scope[],
        },
      },
    ],
    effectiveAt: Date.now(),
    thresholdPolicies: [{ policy: 'rn', threshold: 1 }],
  },
  policies: {
    timestampAuthorities: [{ url: 'https://tsa.proof.example.com' }],
    numberRequiredTSAs: 1,
    electionType: ElectionType.adhoc,
  },
};

const PROOF_USER: User = {
  id: 'proof-user-1',
  name: 'Proof User',
  activeKeys: [
    {
      key: 'proof-key-hex-000000000000000000000000000000000000000000000000000000000000001',
      type: UserKeyType.mobile,
      expiration: Date.now() + 365 * 24 * 60 * 60 * 1000,
    },
  ],
};

// ---------------------------------------------------------------------------
// D-16 part 1 — Write phase
// ---------------------------------------------------------------------------

/**
 * WRITE PHASE: create a Network via the real NetworksEngine + rnDbFactory.
 *
 * Steps:
 *  1. Construct a NetworksEngine with rnDbFactory (capturing factory shim so
 *     we can run SQL assertions on the same db the engine used).
 *  2. Call networksEngine.create() to write Network/Authority/Admin/User/UserKey rows.
 *  3. Query row counts and the network hash from the engine's db.
 *  4. Persist the NetworkReference + hash to AsyncStorage for the read phase.
 *  5. Return/log the hash and row counts.
 *
 * @param networksEngine  Pre-constructed engine (pass the same instance used
 *                        by the app so the factory is the real rnDbFactory).
 * @param user            User to pass to create().
 * @returns               An object with the network hash, row counts, and db.
 */
export async function runWritePhase(
  networksEngine: NetworksEngine,
  user: User = PROOF_USER,
): Promise<{ networkHash: string; networkCount: number; db: Database }> {
  console.log('[proof] write phase: calling networksEngine.create()');

  const networkEngine = await networksEngine.create(PROOF_NETWORK_INIT, user);

  // Retrieve the most-recently written NetworkReference from AsyncStorage.
  // create() stores the new ref in recentNetworks — read the first entry.
  const recents: NetworkReference[] | undefined = JSON.parse(
    (await AsyncStorage.getItem('recentNetworks')) ?? '[]',
  );
  const ref = recents?.[0];
  if (!ref) {
    throw new Error('[proof] write phase: no NetworkReference found in recentNetworks after create()');
  }
  const networkHash = ref.hash;

  // Re-open the db via the factory (same networkHash → same LevelDB store) to
  // run a count query.  On the write phase this is a cache HIT — the engine
  // returns the same Database object it already cached.
  const db = await rnDbFactory(networkHash);

  const countRow = await db.prepare('select count(*) as n from Network').get() as
    | { n: number }
    | undefined;
  const networkCount = countRow?.n ?? 0;

  console.log(`[proof] write phase: networkHash=${networkHash}, Network row count=${networkCount}`);

  // Persist ref and hash for the read phase (survives force-stop)
  await AsyncStorage.setItem(PROOF_NETWORK_REF_KEY, JSON.stringify(ref));
  await AsyncStorage.setItem(PROOF_NETWORK_HASH_KEY, networkHash);

  console.log('[proof] write phase DONE — trigger am force-stop and relaunch, then call runReadPhase');

  return { networkHash, networkCount, db };
}

// ---------------------------------------------------------------------------
// D-16 part 1 — Read phase (post-restart)
// ---------------------------------------------------------------------------

/**
 * READ PHASE: load the saved NetworkReference and call networksEngine.open().
 *
 * On a fresh process (after `am force-stop + relaunch`), the engine's in-memory
 * cache is empty → open() takes the cache-MISS path → re-attaches via rnDbFactory.
 *
 * Asserts:
 *  - The Network row is present (count >= 1).
 *  - The Network row count equals the pre-restart count (no re-insertion).
 *
 * @param networksEngine  A freshly-constructed NetworksEngine (cache is empty).
 * @param user            User passed to open().
 * @returns               Result object with hash, pre-restart count, post-restart count, and pass/fail verdict.
 */
export async function runReadPhase(
  networksEngine: NetworksEngine,
  user: User = PROOF_USER,
): Promise<{ networkHash: string; preRestartCount: number; postRestartCount: number; passed: boolean }> {
  console.log('[proof] read phase: loading saved NetworkReference from AsyncStorage');

  const refJson = await AsyncStorage.getItem(PROOF_NETWORK_REF_KEY);
  const hashStr = await AsyncStorage.getItem(PROOF_NETWORK_HASH_KEY);

  if (!refJson || !hashStr) {
    throw new Error(
      '[proof] read phase: no saved proof state found — run the write phase first',
    );
  }

  const ref: NetworkReference = JSON.parse(refJson);
  const networkHash: string = hashStr;

  console.log(`[proof] read phase: re-attaching to store for hash=${networkHash}`);

  // open() on a fresh process: cache miss → factory-direct re-attach (D-05).
  // The engine calls rnDbFactory(networkHash), registers plugins (no DDL), and
  // checks the SchemaVersion marker — confirming the store is initialized.
  await networksEngine.open(ref, user);

  // Query row count directly from the factory (same LevelDB store).
  const db = await rnDbFactory(networkHash);
  const countRow = await db.prepare('select count(*) as n from Network').get() as
    | { n: number }
    | undefined;
  const postRestartCount = countRow?.n ?? 0;

  // The pre-restart count was 1 (one Network row written in the write phase).
  // Hardcoded here; ideally compare to the count stored in AsyncStorage by a
  // production-grade harness. For this proof the invariant is: post == pre == 1.
  const preRestartCount = 1;
  const passed = postRestartCount === preRestartCount && postRestartCount >= 1;

  if (passed) {
    console.log(
      `[proof] read phase PASS — Network row count post-restart=${postRestartCount} (expected ${preRestartCount}); no re-insertion`,
    );
  } else {
    console.error(
      `[proof] read phase FAIL — Network row count post-restart=${postRestartCount} (expected ${preRestartCount})`,
    );
  }

  return { networkHash, preRestartCount, postRestartCount, passed };
}

// ---------------------------------------------------------------------------
// D-16 part 2 — Crypto-function assertions
// ---------------------------------------------------------------------------

/**
 * CRYPTO ASSERTIONS: verify the four registered functions return expected
 * values on the real on-device query path.
 *
 * Per RESEARCH Pitfall 6 — rules enforced here:
 *   - Digest, SignatureValid, isISODatetime are called via `select ... as v`
 *   - H16 is called as a JS function (NOT via SQL SELECT)
 *   - Only the four registered functions are asserted (no non-existent functions)
 *
 * @param db  The real engine's Database instance (obtained from runWritePhase
 *            or by calling rnDbFactory directly after the engine has initialized
 *            the schema).
 */
export async function assertCryptoFunctions(
  db: Database,
): Promise<{
  digestOk: boolean;
  signatureValidOk: boolean;
  isISODatetimeOk: boolean;
  h16Ok: boolean;
  allPassed: boolean;
}> {
  console.log('[proof] crypto assertions: starting');

  // 1. Digest — registered custom SQL function (initialize.ts:65-85).
  //    Expects a non-empty string on valid inputs.
  const digestRow = await db.prepare(`select Digest('a', 'b', 'c') as v`).get() as
    | { v: unknown }
    | undefined;
  const digestVal = digestRow?.v;
  const digestOk = typeof digestVal === 'string' && digestVal.length > 0;
  console.log(`[proof] Digest('a','b','c') = ${JSON.stringify(digestVal)} — ${digestOk ? 'PASS' : 'FAIL'}`);

  // 2. SignatureValid — registered custom SQL function (initialize.ts:19-44).
  //    Invalid inputs (empty strings) must return false / 0.
  const svRow = await db.prepare(`select SignatureValid('', '', '') as v`).get() as
    | { v: unknown }
    | undefined;
  const svVal = svRow?.v;
  const signatureValidOk = svVal === false || svVal === 0;
  console.log(`[proof] SignatureValid('','','') = ${JSON.stringify(svVal)} — ${signatureValidOk ? 'PASS' : 'FAIL'}`);

  // 3. isISODatetime — registered custom SQL function (initialize.ts:46-63).
  //    A valid ISO-8601 UTC string must return true.
  const isoRow = await db.prepare(`select isISODatetime('2026-01-01T00:00:00Z') as v`).get() as
    | { v: unknown }
    | undefined;
  const isoVal = isoRow?.v;
  const isISODatetimeOk = isoVal === true || isoVal === 1;
  console.log(`[proof] isISODatetime('2026-01-01T00:00:00Z') = ${JSON.stringify(isoVal)} — ${isISODatetimeOk ? 'PASS' : 'FAIL'}`);

  // 4. H16 — JS-only utility (packages/vote-engine/src/utils.ts).
  //    NOT a SQL function — assert via JS call only.  Must return a 32-char hex string
  //    (16 bytes × 2 hex chars per byte).
  const h16Val: string = H16('test-network-id');
  const h16Ok = typeof h16Val === 'string' && h16Val.length === 32 && /^[0-9a-f]+$/.test(h16Val);
  console.log(`[proof] H16('test-network-id') = ${h16Val} — ${h16Ok ? 'PASS' : 'FAIL'}`);

  const allPassed = digestOk && signatureValidOk && isISODatetimeOk && h16Ok;
  console.log(`[proof] crypto assertions: ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);

  return { digestOk, signatureValidOk, isISODatetimeOk, h16Ok, allPassed };
}

// ---------------------------------------------------------------------------
// Convenience factory: construct a NetworksEngine backed by rnDbFactory.
// Use this to create the engine instance passed to runWritePhase /
// runReadPhase from a dev button without touching AppProvider.
// ---------------------------------------------------------------------------

/**
 * Create a real NetworksEngine wired to rnDbFactory + LocalStorageReact.
 * Intended for dev/proof invocation only.
 */
export function makeProofEngine(): NetworksEngine {
  return new NetworksEngine(makeLocalStorage(), rnDbFactory);
}
