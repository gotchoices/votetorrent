/**
 * persistence-proof.ts — Phase 14 on-device proof routine (D-16 / PERSIST-03)
 *
 * Exports two async functions plus a crypto-assertion helper, all driven through
 * a real NetworksEngine constructed with rnDbFactory.  Wire these to dev
 * buttons or a dedicated debug screen — do NOT alter the production screen
 * visual design.
 *
 * D-16 part 1 (superseded by the D-07 full-chain phases below):
 *   runFullChainWritePhase — create Network + Authority + Election via real
 *                    engines with a REAL device user; persist the chain ref to
 *                    AsyncStorage so the read phase can find it after an
 *                    `am force-stop` relaunch.
 *   runFullChainReadPhase  — load the saved chain ref; call networksEngine.open()
 *                    (cache MISS on a fresh process → re-attach via rnDbFactory);
 *                    assert count(*) >= 1 on Network, Authority, and Election.
 *
 * IN-11 (17-REVIEW): the legacy single-table runWritePhase/runReadPhase pair
 * (and their fake PROOF_USER fixture, banned from real flows by T-16-14) were
 * removed — the runner drives only the full-chain phases above.
 *
 * D-16 part 2: on-device crypto-function assertions
 *   assertCryptoFunctions — runs SQL assertions for Digest / SignatureValid /
 *                    isISODatetime and a JS call for H16.  Per RESEARCH Pitfall 6
 *                    SQL-SELECT of H16 does NOT exist in this codebase and MUST
 *                    NOT be called here. Only the four registered functions are asserted.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Database } from '@quereus/quereus';
import type { NetworkReference, User, NetworkInit, Scope, Ballot } from '@votetorrent/vote-core';
import { ElectionType } from '@votetorrent/vote-core';
// @votetorrent/vote-engine/rn is the single sanctioned import path for real engine
// classes in the RN app layer (D-04). Metro resolves it via the `./rn` subpath in
// package.json exports + unstable_enablePackageExports: true in metro.config.js.
import { NetworksEngine, ElectionsEngine, ElectionEngine, peekNextElectionTid, H16, LocalStorageReact, DIGEST_VECTORS } from '@votetorrent/vote-engine/rn';
import type { DbFactory } from '@votetorrent/vote-engine/rn';
import { rnDbFactory, createStrandDbFactory } from './rn-db-factory';
import type { StrandHost } from './rn-db-factory';
import { getOrCreateDeviceUser, getDevicePrivKeyHex } from './device-user';
import { createDeviceSigner } from './device-signer';

// ---------------------------------------------------------------------------
// AsyncStorage keys used by the proof harness
// ---------------------------------------------------------------------------
// WR-05: single source of truth — the runner imports these same constants so a
// rename here cannot silently desync phase selection in the runner.

// Full-chain proof key: persists { networkRef, authorityId, electionId } across restarts.
// The runner uses this as the write-vs-read discriminant.
export const PROOF_CHAIN_REF_KEY = 'proof:fullChainRef';

// WR-14 (17-REVIEW): set BEFORE the first write-phase store mutation and cleared
// only after PROOF_CHAIN_REF_KEY lands. If a boot finds this marker WITHOUT the
// chain ref, a previous WRITE phase failed mid-flight: the LevelDB store may
// already contain Network/Authority rows while AsyncStorage carries no
// discriminant — re-running networksEngine.create() would fail repeatedly.
// The runner detects this and tells the operator to `pm clear` instead.
export const PROOF_WRITE_ATTEMPTED_KEY = 'proof:writeAttempted';

// MBY-260626 ballot regression check: WRITE phase records the proposed ballot's
// id + its same-process round-trip result here so the READ phase (post
// force-stop) can re-read the SAME ballot from the re-attached store and fold a
// durable cross-restart questions-persisted check into the FULL-CHAIN VERDICT.
export const PROOF_BALLOT_REF_KEY = 'proof:ballotRef';

// Phase 999.1 D-15: WRITE phase records the persisted 'elections' namespace
// TidHighWater observed right after the full-chain write's createElection() call.
// The device-attended TID-REISSUE recheck (post force-stop + backward clock jump)
// reads this baseline back and asserts the NEXT allocation strictly exceeds it —
// the real Hermes/LevelDB clock-skew no-reissue proof.
export const PROOF_TID_REISSUE_BASELINE_KEY = 'proof:tidReissueBaseline';

// ---------------------------------------------------------------------------
// Minimal LocalStorage wrapper (delegates to AsyncStorage)
// ---------------------------------------------------------------------------
function makeLocalStorage(): LocalStorageReact {
  return new LocalStorageReact();
}

// Module-level capture of the most recent Database the engine obtained from the
// factory (via makeProofEngine). The persistent vtab does NOT auto-restore the
// table catalog into a fresh handle, so queries MUST use the SAME handle the
// engine's create()/open() used — never a second rnDbFactory() handle.
let lastProofDb: Database | undefined;

/** The Database the engine last obtained via makeProofEngine's factory. */
export function getLastProofDb(): Database | undefined {
  return lastProofDb;
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

// IN-11 (17-REVIEW): the legacy single-table runWritePhase/runReadPhase pair
// and the fake PROOF_USER default (a 79-char non-hex key that T-16-14 bans
// from real flows) were removed. The full-chain phases below take a REQUIRED
// real device user (from getOrCreateDeviceUser) — there is no fixture fallback.

// ---------------------------------------------------------------------------
// D-07 full-chain write phase (plan 16-05)
// ---------------------------------------------------------------------------

/**
 * FULL-CHAIN WRITE PHASE: create Network + use primaryAuthority + create Election via
 * real engines with a REAL device user (D-07, Pitfall 7 — never PROOF_USER here).
 *
 * Steps:
 *  1. Create the network via networksEngine.create() — establishes Network + Authority rows.
 *  2. Resolve the primary authority id from getDetails().
 *  3. Get the established EngineContext (same store handle, no second factory call).
 *  4. Seed the election signing pipeline via ElectionsEngine.seedElectionSigning()
 *     using the REAL device privKeyHex (T-16-14 mitigation).
 *  5. Call createElection() with the signing nonce.
 *  6. Persist { networkRef, authorityId, electionId } under PROOF_CHAIN_REF_KEY.
 *
 * @param networksEngine  Real NetworksEngine backed by rnDbFactory (from makeProofEngine).
 * @param user            REAL device user from getOrCreateDeviceUser (NOT PROOF_USER).
 */
export async function runFullChainWritePhase(
  networksEngine: NetworksEngine,
  user: User,
): Promise<{ networkRef: NetworkReference; authorityId: string; electionId: string; db: Database }> {
  console.info('[proof] full-chain write phase: starting');

  // WR-14 (17-REVIEW): persist the attempt marker BEFORE any store mutation so a
  // partial failure (anything between step 1 and step 6 throwing) is detectable
  // on the next boot — the marker without PROOF_CHAIN_REF_KEY means "partial write".
  await AsyncStorage.setItem(PROOF_WRITE_ATTEMPTED_KEY, String(Date.now()));

  // Step 1: create the network — Network + primary Authority + Admin/Officer/User/UserKey rows.
  const networkEngine = await networksEngine.create(PROOF_NETWORK_INIT, user);
  console.info('[proof] full-chain write: network created');

  // Retrieve the NetworkReference from AsyncStorage (set by create() via recentNetworks).
  const recents: NetworkReference[] = JSON.parse(
    (await AsyncStorage.getItem('recentNetworks')) ?? '[]',
  );
  const networkRef = recents?.[0];
  if (!networkRef) {
    throw new Error('[proof] full-chain write: no NetworkReference found in recentNetworks after create()');
  }

  // Step 2: resolve the primary authority id (no extra createAuthority call needed —
  // NetworksEngine.create() already created the primary authority via PROOF_NETWORK_INIT).
  const details = await networkEngine.getDetails();
  const authorityId: string = details.network.primaryAuthorityId;
  console.info(`[proof] full-chain write: authorityId=${authorityId}`);

  // Step 3: get the same EngineContext that create() used (single store handle — Pitfall 5).
  // Never call rnDbFactory() a second time here; getEstablishedContext returns the cached handle.
  const ctx = networksEngine.getEstablishedContext(networkRef.hash);
  if (!ctx) {
    throw new Error('[proof] full-chain write: no established context for network hash=' + networkRef.hash);
  }

  // Step 4: build election fields and run the signing seam.
  // The seam owns tid + Digest computation + secp256k1.sign — screen/harness never signs (D-01).
  const now = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const electionId: string = (globalThis as any).crypto.randomUUID();

  const electionFields = {
    id: electionId,
    authorityId,
    title: 'Proof Election FC',
    date: now + 30 * 24 * 60 * 60 * 1000,          // 30 days out
    revisionDeadline: now + 25 * 24 * 60 * 60 * 1000,
    ballotDeadline: now + 28 * 24 * 60 * 60 * 1000,
    type: ElectionType.adhoc,
  };

  // T-16-14 mitigation: use the REAL device private key — never the fake PROOF_USER key.
  const privKeyHex = await getDevicePrivKeyHex();
  if (!privKeyHex) {
    throw new Error('[proof] full-chain write: device private key not found — call getOrCreateDeviceUser first');
  }
  const signerKey = user.activeKeys?.[0]?.key;
  if (!signerKey) {
    throw new Error('[proof] full-chain write: user has no active key');
  }

  // D-01 key boundary: the engine signing seams take an app-layer `sign` callback —
  // the device private key NEVER crosses into vote-engine. createDeviceSigner closes
  // over the stored key and calls secp256k1.sign with @noble v2 defaults (prehash:true,
  // WR-10). (Earlier proof-harness builds passed privKeyHex positionally, which the
  // post-Phase-21 callback signature interprets as the `sign` arg — "sign is not a
  // function".) The signature's signerUserId/signerKey are derived inside the callback.
  const sign = await createDeviceSigner('Proof Runner');

  const electionsEngine = new ElectionsEngine(ctx);
  const signingNonce = await (electionsEngine as unknown as {
    seedElectionSigning(
      electionFields: { id: string; authorityId: string; title: string; date: number; revisionDeadline: number; ballotDeadline: number; type: ElectionType },
      sign: (digest: Uint8Array) => Promise<import('@votetorrent/vote-core').Signature>,
    ): Promise<string>;
  }).seedElectionSigning(electionFields, sign);
  console.info('[proof] full-chain write: election signing seam complete, nonce=' + signingNonce);

  // Step 4b: sign the initial ElectionRevision (Revision=0).
  // revTid = election tid + 1 (createElection consumes T for Election, T+1 for revision).
  // Use a PAST revisionTimestamp so RevisionTimestampValid (< context.now AND < RevisionDeadline) passes.
  // The SAME pastRevTs value is passed to both the seam and the ElectionInit revision so
  // toCanonicalDatetime() produces byte-identical strings in both paths (T-16-21 mitigation).
  const pastRevTs = now - 1000;
  const revisionFields = {
    revision: 0,
    revisionTimestamp: pastRevTs,
    tags: ['proof'],
    instructions: '# Proof Election FC',
    timeline: {
      registrationEnds: now + 2 * 86400000,
      ballotsFinal: now + 5 * 86400000,
      votingStarts: now + 10 * 86400000,
      tallyingStarts: now + 14 * 86400000,
      validation: now + 15 * 86400000,
      certificationStarts: now + 16 * 86400000,
      closed: now + 17 * 86400000,
    },
    keyholderThreshold: 0,
  };
  // peekNextElectionTid(db) still points to T (election tid) — +1 gives the revision tid.
  // (peekNextElectionTid is imported statically from @votetorrent/vote-engine/rn above.)
  // 999.1 D-01/D-02: peekNextElectionTid is now namespace-allocator-backed — async and
  // scoped to a caller-supplied `db` handle (no more module-level zero-arg counter). Use
  // ctx.db (the SAME handle the engine's create() used — Pitfall 5, never a second handle).
  const revTid = (await peekNextElectionTid(ctx.db)) + 1;
  const revisionSigningNonce = await (electionsEngine as unknown as {
    seedElectionRevisionSigning(
      electionId: string,
      authorityId: string,
      revision: {
        revision: number;
        revisionTimestamp: number;
        tags: string[];
        instructions: string;
        timeline: Record<string, number>;
        keyholderThreshold: number;
      },
      tid: number,
      sign: (digest: Uint8Array) => Promise<import('@votetorrent/vote-core').Signature>,
    ): Promise<string>;
  }).seedElectionRevisionSigning(
    electionId, authorityId, revisionFields, revTid, sign,
  );
  console.info('[proof] full-chain write: revision signing seam complete, revNonce=' + revisionSigningNonce);

  // Step 5: create the election row + ElectionRevision (Revision=0, MutationValid satisfied).
  await electionsEngine.createElection(
    {
      election: electionFields,
      revision: {
        electionId,
        ...revisionFields,
        keyholders: [],
      },
    },
    { signingNonce, revisionSigningNonce },
  );
  console.info('[proof] full-chain write: election created, id=' + electionId);

  // Step 6: persist the full-chain reference for the read phase (survives force-stop).
  const chainRef = { networkRef, authorityId, electionId };
  await AsyncStorage.setItem(PROOF_CHAIN_REF_KEY, JSON.stringify(chainRef));
  // WR-14: write completed coherently — clear the partial-write attempt marker.
  await AsyncStorage.removeItem(PROOF_WRITE_ATTEMPTED_KEY);

  // Use the captured db handle for caller's assertions (same handle used for all inserts).
  const db = getLastProofDb();
  if (!db) {
    throw new Error('[proof] full-chain write: engine did not obtain a db via the proof factory');
  }

  const networkCount = ((await db.prepare('select count(*) as n from Network').get()) as { n: number } | undefined)?.n ?? 0;
  const authorityCount = ((await db.prepare('select count(*) as n from Authority').get()) as { n: number } | undefined)?.n ?? 0;
  const electionCount = ((await db.prepare('select count(*) as n from Election').get()) as { n: number } | undefined)?.n ?? 0;
  console.info(
    `[proof] full-chain write DONE — hash=${networkRef.hash} Network=${networkCount} Authority=${authorityCount} Election=${electionCount}`,
  );

  // Phase 999.1 D-15 baseline: record the 'elections' namespace TidHighWater right
  // after this phase's createElection() call (which reserved the T/T+1 pair via the
  // shared allocateTid(db, 'elections', ...)). This is the "prior max Tid" the
  // device-attended TID-REISSUE recheck (runTidReissueRecheckPhase, below) asserts
  // strictly exceeds after a force-stop + backward device-clock jump + relaunch.
  const tidHighWaterRow = (await db
    .prepare('select HighWater from TidHighWater where Namespace = :ns')
    .get({ ns: 'elections' })) as { HighWater: number } | undefined;
  const priorMaxTid = tidHighWaterRow?.HighWater ?? 0;
  await AsyncStorage.setItem(PROOF_TID_REISSUE_BASELINE_KEY, String(priorMaxTid));
  console.info(`[proof] full-chain write: recorded D-15 TID-REISSUE baseline (elections HighWater=${priorMaxTid})`);

  return { networkRef, authorityId, electionId, db };
}

// ---------------------------------------------------------------------------
// Ballot question round-trip proof (MBY-260626 verification)
// ---------------------------------------------------------------------------

/**
 * BALLOT QUESTION ROUND-TRIP: verify proposed-ballot questions survive the
 * write+read paths on-device (Hermes/Quereus), exercising the exact fix that
 * added ProposedBallot.Questions JSON persistence.
 *
 * Single-process (no force-stop needed): propose a ballot carrying questions
 * via the REAL ElectionEngine.proposeBallot(), then
 *   - WRITE side: raw `select Questions from ProposedBallot` confirms the JSON
 *     blob was actually persisted (proves proposeBallot no longer drops them).
 *   - READ side: ElectionEngine.getBallotDetails() must return the same
 *     questions deserialized from that blob (proves the proposed fallback path
 *     reads them back instead of only the finalized Question table).
 *
 * Emits a single `[proof] ========== BALLOT VERDICT: PASS|FAIL ...` line.
 */
export async function runBallotQuestionProof(
  networksEngine: NetworksEngine,
  networkRef: NetworkReference,
  authorityId: string,
  electionId: string,
): Promise<{ passed: boolean; details: string }> {
  console.info('[proof] ballot question round-trip: starting');

  const ctx = networksEngine.getEstablishedContext(networkRef.hash);
  if (!ctx) {
    throw new Error('[proof] ballot proof: no established context for hash=' + networkRef.hash);
  }
  // ElectionSubject is just { id, authorityId }; proposeBallot/getBallotDetails
  // operate on ctx.db only (same construction the app uses in engine-factory.ts).
  const engine = new ElectionEngine({ id: electionId, authorityId }, ctx);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ballotId: string = (globalThis as any).crypto.randomUUID();
  const ballot: Ballot = {
    id: ballotId,
    electionId,
    authorityId,
    description: 'Proof ballot — question round-trip',
    districts: ['D1'],
    questions: [
      {
        code: 'q1',
        title: 'Favorite color?',
        instructions: 'Pick one',
        type: 'select',
        options: [
          { code: 'o1', title: 'Red' },
          { code: 'o2', title: 'Blue' },
        ],
        optionRange: { min: 1, max: 1 },
        sequence: 0,
        required: true,
      },
      {
        code: 'q2',
        title: 'Any comments?',
        instructions: 'Free text',
        type: 'text',
        options: [],
        sequence: 1,
        required: false,
      },
    ],
  };
  const expectedCount = ballot.questions.length;

  // WRITE side — propose the ballot (carries the questions).
  await engine.proposeBallot(ballot);

  // Raw DB check: the Questions JSON column must hold the serialized array.
  const db = getLastProofDb();
  const rawRow = db
    ? ((await db
        .prepare('select Questions from ProposedBallot where Id = :id')
        .get({ id: ballotId })) as { Questions: string | null } | undefined)
    : undefined;
  const rawJson = rawRow?.Questions ?? null;
  const rawQuestionCount = rawJson ? (JSON.parse(rawJson) as unknown[]).length : 0;
  console.info(
    `[proof] ballot write-side: ProposedBallot.Questions persisted=${rawJson !== null} ` +
      `(${rawJson?.length ?? 0} chars, ${rawQuestionCount} questions)`,
  );

  // READ side — getBallotDetails must deserialize the questions back.
  const detailsResult = await engine.getBallotDetails(ballotId);
  const readQuestions = detailsResult.ballot.questions ?? [];
  console.info(`[proof] ballot read-side: getBallotDetails returned ${readQuestions.length} questions`);

  // Assertions.
  const writeOk = rawQuestionCount === expectedCount;
  const readLenOk = readQuestions.length === expectedCount;
  const q1 = readQuestions.find((q) => q.code === 'q1');
  const q1Ok = !!q1 && q1.title === 'Favorite color?' && (q1.options?.length ?? 0) === 2;
  const q2 = readQuestions.find((q) => q.code === 'q2');
  const q2Ok = !!q2 && q2.type === 'text';
  const passed = writeOk && readLenOk && q1Ok && q2Ok;

  const details =
    `writePersisted=${writeOk}(${rawQuestionCount}/${expectedCount}) ` +
    `readCount=${readQuestions.length}/${expectedCount} q1=${q1Ok} q2=${q2Ok}`;
  console.info(`[proof] ========== BALLOT VERDICT: ${passed ? 'PASS' : 'FAIL'} (${details}) ==========`);

  // Record the ballot id + expected count so the READ phase can re-read the SAME
  // ballot from the re-attached store (durable cross-restart check).
  await AsyncStorage.setItem(
    PROOF_BALLOT_REF_KEY,
    JSON.stringify({ ballotId, expectedCount, sameProcessPassed: passed }),
  );

  return { passed, details };
}

/**
 * BALLOT READ-BACK (post force-stop): re-read the ballot proposed during the
 * WRITE phase from the RE-ATTACHED on-device store and assert its questions
 * survived the process restart. Stronger than the same-process round-trip — it
 * proves the JSON blob is durably persisted in LevelDB, not just live in a warm
 * handle. Folds into the FULL-CHAIN VERDICT so a regression fails run-vtest02.sh.
 *
 * Must be called AFTER runFullChainReadPhase (which open()s + re-attaches the
 * store and establishes the context this reuses).
 */
export async function runBallotQuestionReadProof(
  networksEngine: NetworksEngine,
  networkRef: NetworkReference,
  authorityId: string,
  electionId: string,
): Promise<{ passed: boolean; details: string }> {
  const refJson = await AsyncStorage.getItem(PROOF_BALLOT_REF_KEY);
  if (!refJson) {
    console.error('[proof] ballot read-back: no ballot ref saved — WRITE phase did not run the ballot proof');
    return { passed: false, details: 'noBallotRef' };
  }
  const { ballotId, expectedCount } = JSON.parse(refJson) as {
    ballotId: string;
    expectedCount: number;
    sameProcessPassed: boolean;
  };

  const ctx = networksEngine.getEstablishedContext(networkRef.hash);
  if (!ctx) {
    console.error('[proof] ballot read-back: no established context after open() for hash=' + networkRef.hash);
    return { passed: false, details: 'noContext' };
  }
  const engine = new ElectionEngine({ id: electionId, authorityId }, ctx);

  const detailsResult = await engine.getBallotDetails(ballotId);
  const readQuestions = detailsResult.ballot.questions ?? [];
  const passed = readQuestions.length === expectedCount;
  const details = `durableReadCount=${readQuestions.length}/${expectedCount}`;
  console.info(
    `[proof] ballot read-back (post-restart): getBallotDetails returned ${readQuestions.length} questions — ${passed ? 'PASS' : 'FAIL'}`,
  );
  return { passed, details };
}

// ---------------------------------------------------------------------------
// D-07 full-chain read phase (post force-stop/relaunch) (plan 16-05)
// ---------------------------------------------------------------------------

/**
 * FULL-CHAIN READ PHASE: re-attach the SAME LevelDB store after force-stop/relaunch
 * and assert count(*) >= 1 on Network, Authority, and Election (D-07).
 *
 * Phase selection discriminant: `PROOF_CHAIN_REF_KEY` present in AsyncStorage → READ.
 *
 * @param networksEngine  A fresh NetworksEngine (cache empty after force-stop).
 * @param user            User passed to open() — same identity as write phase.
 * @returns               { passed, networkCount, authorityCount, electionCount }
 */
export async function runFullChainReadPhase(
  networksEngine: NetworksEngine,
  user: User,
): Promise<{ passed: boolean; networkCount: number; authorityCount: number; electionCount: number }> {
  console.info('[proof] full-chain read phase: loading chain ref from AsyncStorage');

  const chainRefJson = await AsyncStorage.getItem(PROOF_CHAIN_REF_KEY);
  if (!chainRefJson) {
    throw new Error('[proof] full-chain read phase: no chain ref found — run the full-chain write phase first');
  }
  const chainRef: { networkRef: NetworkReference; authorityId: string; electionId: string } =
    JSON.parse(chainRefJson);

  console.info(`[proof] full-chain read: re-attaching to store for hash=${chainRef.networkRef.hash}`);

  // open() on a fresh process: cache miss → factory-direct re-attach (D-05 rebind guard).
  // The engine re-declares the schema on the fresh handle, binding the persisted LevelDB data.
  await networksEngine.open(chainRef.networkRef, user);

  // Phase 14 D-05 schema-rebind lesson: MUST use the SAME handle that open() obtained
  // via the capturing factory — NOT a second rnDbFactory() call (Pitfall 5).
  const db = getLastProofDb();
  if (!db) {
    throw new Error('[proof] full-chain read: no captured db handle after open()');
  }

  // Assert count(*) >= 1 on all three tables (T-16-13 mitigation — counts on the re-attached store).
  const networkCount = ((await db.prepare('select count(*) as n from Network').get()) as { n: number } | undefined)?.n ?? 0;
  const authorityCount = ((await db.prepare('select count(*) as n from Authority').get()) as { n: number } | undefined)?.n ?? 0;
  const electionCount = ((await db.prepare('select count(*) as n from Election').get()) as { n: number } | undefined)?.n ?? 0;

  const passed = networkCount >= 1 && authorityCount >= 1 && electionCount >= 1;

  if (passed) {
    console.info(
      `[proof] full-chain read PASS — Network=${networkCount} Authority=${authorityCount} Election=${electionCount}`,
    );
  } else {
    console.error(
      `[proof] full-chain read FAIL — Network=${networkCount} Authority=${authorityCount} Election=${electionCount}`,
    );
  }

  return { passed, networkCount, authorityCount, electionCount };
}

// ---------------------------------------------------------------------------
// Phase 999.1 D-15 — on-device Tid no-reissue recheck (device-attended)
// ---------------------------------------------------------------------------

/**
 * TID-REISSUE RECHECK: the on-device, real Hermes/LevelDB confirmation of the
 * durable Tid allocator's no-reissue guarantee (D-15) across the documented real
 * clock-skew vector.
 *
 * Device-attended procedure this phase is designed to run inside:
 *  1. runFullChainWritePhase() runs first — creates a mutation (an Election via
 *     the real signing seam) and records the prior-max 'elections' TidHighWater
 *     under PROOF_TID_REISSUE_BASELINE_KEY.
 *  2. Operator force-stops the app WITHOUT clearing data (`am force-stop`, no
 *     `pm clear`) — the existing full-chain "restart" protocol.
 *  3. Operator rolls the device clock BACKWARD past the recorded prior-max Tid
 *     (the real clock-skew gotcha this proof targets).
 *  4. Operator relaunches the app; this phase runs: re-attaches to the SAME
 *     persisted LevelDB store (via networksEngine.open() → rnDbFactory, D-05
 *     rebind guard — Pitfall 5) and attempts another allocation/mutation (a
 *     second, distinct Election through the real signing seam, consuming the
 *     SAME 'elections' allocator namespace).
 *  5. Asserts the newly-observed 'elections' TidHighWater is STRICTLY GREATER
 *     than the recorded prior max — the durable allocator must never reissue a
 *     consumed Tid, even though Date.now() now reads BEFORE that prior max.
 *
 * This duplicates (rather than shares/refactors) the election-creation steps
 * from runFullChainWritePhase so this phase stays independently self-contained
 * and the existing full-chain write phase is left completely untouched
 * (additive extension, not a harness-architecture rewrite).
 *
 * Emits a single greppable verdict line (see the `passed ? 'PASS' : 'FAIL'`
 * console.info near the end of this function) so the device driver script can
 * gate on it exactly like the other proof-verdict markers in this file.
 */
export async function runTidReissueRecheckPhase(
  networksEngine: NetworksEngine,
  user: User,
): Promise<{ passed: boolean; priorMaxTid: number; newMaxTid: number }> {
  console.info('[proof] TID-REISSUE recheck: starting');

  const chainRefJson = await AsyncStorage.getItem(PROOF_CHAIN_REF_KEY);
  const baselineStr = await AsyncStorage.getItem(PROOF_TID_REISSUE_BASELINE_KEY);
  if (!chainRefJson || baselineStr === null) {
    throw new Error(
      '[proof] TID-REISSUE recheck: missing chain ref or D-15 baseline — run runFullChainWritePhase first',
    );
  }
  const chainRef: { networkRef: NetworkReference; authorityId: string; electionId: string } =
    JSON.parse(chainRefJson);
  const priorMaxTid = Number(baselineStr);

  // Re-attach to the SAME persisted LevelDB store post force-stop/clock-rollback.
  // open() is idempotent if runFullChainReadPhase already attached this boot
  // (cache hit) — safe to call again so this phase stays independently invokable.
  await networksEngine.open(chainRef.networkRef, user);
  const ctx = networksEngine.getEstablishedContext(chainRef.networkRef.hash);
  if (!ctx) {
    throw new Error(
      '[proof] TID-REISSUE recheck: no established context after open() for hash=' + chainRef.networkRef.hash,
    );
  }
  // Phase 14 D-05 schema-rebind lesson: use the captured handle, never a second
  // rnDbFactory() call (Pitfall 5).
  const db = getLastProofDb();
  if (!db) {
    throw new Error('[proof] TID-REISSUE recheck: no captured db handle after open()');
  }

  const privKeyHex = await getDevicePrivKeyHex();
  if (!privKeyHex) {
    throw new Error('[proof] TID-REISSUE recheck: device private key not found — call getOrCreateDeviceUser first');
  }
  const signerKey = user.activeKeys?.[0]?.key;
  if (!signerKey) {
    throw new Error('[proof] TID-REISSUE recheck: user has no active key');
  }
  const sign = await createDeviceSigner('Proof Runner (TID-REISSUE)');
  const electionsEngine = new ElectionsEngine(ctx);

  const now = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const secondElectionId: string = (globalThis as any).crypto.randomUUID();
  const electionFields = {
    id: secondElectionId,
    authorityId: chainRef.authorityId,
    title: 'Proof Election TID-REISSUE',
    date: now + 30 * 24 * 60 * 60 * 1000,
    revisionDeadline: now + 25 * 24 * 60 * 60 * 1000,
    ballotDeadline: now + 28 * 24 * 60 * 60 * 1000,
    type: ElectionType.adhoc,
  };

  const signingNonce = await (electionsEngine as unknown as {
    seedElectionSigning(
      electionFields: { id: string; authorityId: string; title: string; date: number; revisionDeadline: number; ballotDeadline: number; type: ElectionType },
      sign: (digest: Uint8Array) => Promise<import('@votetorrent/vote-core').Signature>,
    ): Promise<string>;
  }).seedElectionSigning(electionFields, sign);
  console.info('[proof] TID-REISSUE recheck: election signing seam complete, nonce=' + signingNonce);

  const pastRevTs = now - 1000;
  const revisionFields = {
    revision: 0,
    revisionTimestamp: pastRevTs,
    tags: ['proof', 'tid-reissue'],
    instructions: '# Proof Election TID-REISSUE',
    timeline: {
      registrationEnds: now + 2 * 86400000,
      ballotsFinal: now + 5 * 86400000,
      votingStarts: now + 10 * 86400000,
      tallyingStarts: now + 14 * 86400000,
      validation: now + 15 * 86400000,
      certificationStarts: now + 16 * 86400000,
      closed: now + 17 * 86400000,
    },
    keyholderThreshold: 0,
  };
  // peekNextElectionTid(db) points at T (this election's tid) — +1 gives the revision tid.
  // 999.1 D-01/D-02: async, namespace-allocator-backed — use the captured `db` handle
  // (Pitfall 5, never a second rnDbFactory() call).
  const revTid = (await peekNextElectionTid(db)) + 1;
  const revisionSigningNonce = await (electionsEngine as unknown as {
    seedElectionRevisionSigning(
      electionId: string,
      authorityId: string,
      revision: {
        revision: number;
        revisionTimestamp: number;
        tags: string[];
        instructions: string;
        timeline: Record<string, number>;
        keyholderThreshold: number;
      },
      tid: number,
      sign: (digest: Uint8Array) => Promise<import('@votetorrent/vote-core').Signature>,
    ): Promise<string>;
  }).seedElectionRevisionSigning(
    secondElectionId, chainRef.authorityId, revisionFields, revTid, sign,
  );
  console.info('[proof] TID-REISSUE recheck: revision signing seam complete, revNonce=' + revisionSigningNonce);

  // The actual re-allocation/mutation attempt: createElection() consumes a fresh
  // T/T+1 pair from the SAME 'elections' TidHighWater row this store already holds.
  await electionsEngine.createElection(
    {
      election: electionFields,
      revision: {
        electionId: secondElectionId,
        ...revisionFields,
        keyholders: [],
      },
    },
    { signingNonce, revisionSigningNonce },
  );
  console.info('[proof] TID-REISSUE recheck: second election created, id=' + secondElectionId);

  const newRow = (await db
    .prepare('select HighWater from TidHighWater where Namespace = :ns')
    .get({ ns: 'elections' })) as { HighWater: number } | undefined;
  const newMaxTid = newRow?.HighWater ?? 0;
  // D-15 no-reissue assertion: the newly-allocated Tid must STRICTLY exceed the
  // prior max recorded before the force-stop + backward clock jump — never a
  // repeat, even though Date.now() may now read below priorMaxTid.
  const passed = newMaxTid > priorMaxTid;

  if (passed) {
    console.info(`[proof] TID-REISSUE recheck PASS — priorMaxTid=${priorMaxTid} newMaxTid=${newMaxTid}`);
  } else {
    console.error(
      `[proof] TID-REISSUE recheck FAIL — priorMaxTid=${priorMaxTid} newMaxTid=${newMaxTid} (Tid was reissued or did not advance)`,
    );
  }
  console.info(
    `[proof] ========== TID-REISSUE VERDICT: ${passed ? 'PASS' : 'FAIL'} (priorMaxTid=${priorMaxTid}, newMaxTid=${newMaxTid}) ==========`,
  );

  return { passed, priorMaxTid, newMaxTid };
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
 * @param db  The real engine's Database instance (obtained from
 *            runFullChainWritePhase or getLastProofDb() after the engine has
 *            initialized the schema).
 */
/**
 * A digest is valid if it is a non-empty string OR a non-empty byte sequence.
 * The real on-device SQL `Digest(...)` returns raw bytes (a Uint8Array, which
 * serializes to an object with numeric keys), not a string.
 */
function isNonEmptyDigest(v: unknown): boolean {
  if (typeof v === 'string') return v.length > 0;
  if (v instanceof Uint8Array) return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v !== null && typeof v === 'object') return Object.keys(v).length > 0;
  return false;
}

export async function assertCryptoFunctions(
  db: Database,
): Promise<{
  digestOk: boolean;
  signatureValidOk: boolean;
  isISODatetimeOk: boolean;
  h16Ok: boolean;
  allPassed: boolean;
}> {
  console.info('[proof] crypto assertions: starting');

  // 1. Digest — registered custom SQL function (initialize.ts:65-85).
  //    On the real on-device SQL path Digest returns a 32-byte BLOB (Uint8Array,
  //    serialized as {"0":..,"31":..}), NOT a string. The proof passes on any
  //    non-empty digest value: a non-empty string OR a non-empty byte sequence.
  const digestRow = await db.prepare(`select Digest('a', 'b', 'c') as v`).get() as
    | { v: unknown }
    | undefined;
  const digestVal = digestRow?.v;
  const digestOk = isNonEmptyDigest(digestVal);
  console.info(`[proof] Digest('a','b','c') = ${JSON.stringify(digestVal)} — ${digestOk ? 'PASS' : 'FAIL'}`);

  // 2. SignatureValid — registered custom SQL function (initialize.ts:19-44).
  //    Invalid inputs (empty strings) must return false / 0.
  const svRow = await db.prepare(`select SignatureValid('', '', '') as v`).get() as
    | { v: unknown }
    | undefined;
  const svVal = svRow?.v;
  const signatureValidOk = svVal === false || svVal === 0;
  console.info(`[proof] SignatureValid('','','') = ${JSON.stringify(svVal)} — ${signatureValidOk ? 'PASS' : 'FAIL'}`);

  // 3. isISODatetime — registered custom SQL function (initialize.ts:46-63).
  //    A valid ISO-8601 UTC string must return true.
  const isoRow = await db.prepare(`select isISODatetime('2026-01-01T00:00:00Z') as v`).get() as
    | { v: unknown }
    | undefined;
  const isoVal = isoRow?.v;
  const isISODatetimeOk = isoVal === true || isoVal === 1;
  console.info(`[proof] isISODatetime('2026-01-01T00:00:00Z') = ${JSON.stringify(isoVal)} — ${isISODatetimeOk ? 'PASS' : 'FAIL'}`);

  // 4. H16 — JS-only utility (packages/vote-engine/src/utils.ts).
  //    NOT a SQL function — assert via JS call only.  Must return a 32-char hex string
  //    (16 bytes × 2 hex chars per byte).
  const h16Val: string = H16('test-network-id');
  const h16Ok = typeof h16Val === 'string' && h16Val.length === 32 && /^[0-9a-f]+$/.test(h16Val);
  console.info(`[proof] H16('test-network-id') = ${h16Val} — ${h16Ok ? 'PASS' : 'FAIL'}`);

  const allPassed = digestOk && signatureValidOk && isISODatetimeOk && h16Ok;
  console.info(`[proof] crypto assertions: ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);

  return { digestOk, signatureValidOk, isISODatetimeOk, h16Ok, allPassed };
}

// ---------------------------------------------------------------------------
// Golden vectors for DEBT-04 device-side parity.
// WR-15 (17-REVIEW): imported from @votetorrent/vote-engine/rn (single source
// of truth, packages/vote-engine/src/database/digest-vectors.ts) — the former
// inline copy had no drift guard against the Node-side fixture.
// Semantics: args joined with '|', null/undefined → '', numbers via String().
// ---------------------------------------------------------------------------

/**
 * DEBT-04 device-side parity gate — mirrors `assertCryptoFunctions` structure.
 *
 * Replays each golden vector through the on-device Quereus Digest() SQL scalar
 * and compares the result to the Node-pinned expected base64url string.  A
 * mismatch or throw is collected as a named failure string.  The only way to
 * confirm that Hermes `btoa`/base64url is available and byte-identical to Node
 * is to run this on the device — a Node test cannot substitute for this check.
 *
 * Quereus binding keys take NO colon prefix in bind objects (confirmed in plan 03
 * wave-1 context: { 'a0': v }, not { ':a0': v }).
 *
 * @param db  The real engine's Database instance (same handle used for crypto assertions).
 */
export async function assertDigestParity(
  db: Database,
): Promise<{ allPassed: boolean; failures: string[] }> {
  console.info('[proof] digest parity assertions: starting');
  const failures: string[] = [];

  for (const vec of DIGEST_VECTORS) {
    if (vec.args.length === 0) {
      // Digest() with zero args — call with no placeholders
      try {
        const row = (await db.prepare('select Digest() as d').get()) as { d: unknown } | undefined;
        if (row?.d !== vec.expected) {
          failures.push(`${vec.label}: got ${JSON.stringify(row?.d)}, expected ${vec.expected}`);
        }
      } catch (e) {
        failures.push(`${vec.label}: threw ${String(e)}`);
      }
    } else {
      const placeholders = vec.args.map((_, i) => `:a${i}`).join(', ');
      // Quereus binding keys take NO colon prefix in bind objects (wave-1 context note).
      const bindings = Object.fromEntries(vec.args.map((v, i) => [`a${i}`, v]));
      try {
        const row = (await db
          .prepare(`select Digest(${placeholders}) as d`)
          .get(bindings)) as { d: unknown } | undefined;
        if (row?.d !== vec.expected) {
          failures.push(`${vec.label}: got ${JSON.stringify(row?.d)}, expected ${vec.expected}`);
        }
      } catch (e) {
        failures.push(`${vec.label}: threw ${String(e)}`);
      }
    }
  }

  const allPassed = failures.length === 0;
  console.info(`[proof] digest parity: ${allPassed ? 'ALL PASSED' : `FAILED: ${failures.join('; ')}`}`);
  return { allPassed, failures };
}

// ---------------------------------------------------------------------------
// Convenience factory: construct a NetworksEngine backed by rnDbFactory.
// Use this to create the engine instance passed to runFullChainWritePhase /
// runFullChainReadPhase from a dev button without touching AppProvider.
// ---------------------------------------------------------------------------

/**
 * Create a real NetworksEngine for dev/proof invocation only.
 *
 * @param node  Optional StrandHost (e.g. a live CadreNode). When provided, the
 *              engine's DbFactory uses createStrandDbFactory(node), exercising the
 *              strand createContext path (VER-04). When omitted, falls back to
 *              rnDbFactory (existing behaviour — backward compatible).
 *
 *              Note: a node-aware caller (e.g. under useCadreNode()) may invoke
 *              makeProofEngine(node) to drive the strand path for VER-04 verification.
 *              The boot-time runPersistenceProof() call with no argument preserves
 *              the rnDbFactory path — the CadreNode has not booted yet at that point.
 */
export function makeProofEngine(node?: StrandHost): NetworksEngine {
  const factory: DbFactory = async (networkHash: string) => {
    let db: Database;
    if (node) {
      db = await createStrandDbFactory(node)(networkHash);
    } else {
      db = await rnDbFactory(networkHash);
    }
    lastProofDb = db; // capture the engine's actual handle for queries — BOTH branches (Pitfall 5)
    return db;
  };
  return new NetworksEngine(makeLocalStorage(), factory);
}
