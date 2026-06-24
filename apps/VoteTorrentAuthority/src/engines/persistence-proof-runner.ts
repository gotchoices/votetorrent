/**
 * persistence-proof-runner.ts — Phase 14 dev-only boot runner (D-16 / PERSIST-03)
 *
 * Auto-drives the persistence proof from app boot so the manual on-device test
 * is just: launch → `am force-stop` → relaunch. No UI taps, no screen changes.
 *
 * Phase selection is stateful (survives force-stop via AsyncStorage):
 *   - No saved proof state  → WRITE phase  (create a Network via the real engine)
 *   - Saved proof state     → READ phase   (re-attach + assert no re-insertion)
 *                                           + on-device crypto assertions
 *
 * To re-run from scratch: clear the app's data (Settings ▸ Apps ▸ VoteTorrent
 * Authority ▸ Storage ▸ Clear data) or run
 *   adb shell pm clear org.votetorrent.authority
 *
 * Toggle off by setting PROOF_ENABLED to false (leave wired for repeat runs).
 * Everything is logged to logcat under the `[proof]` tag.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  makeProofEngine,
  runFullChainWritePhase,
  runFullChainReadPhase,
  assertCryptoFunctions,
  assertDigestParity,
  getLastProofDb,
  PROOF_CHAIN_REF_KEY,
  PROOF_WRITE_ATTEMPTED_KEY,
} from './persistence-proof';
import type { StrandHost } from './rn-db-factory';
import { getOrCreateDeviceUser } from './device-user';
import { runRnEntrySmoke } from './rn-entry-smoke';
// Static import only — dynamic require() breaks Metro (Phase 16-07 lesson).
// DIAL_PROBE_ENABLED is consumed by the dial-probe runner (plan 05); imported here
// so plans 04/05 read both flags from a single generated-file import.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { PROOF_ENABLED, DIAL_PROBE_ENABLED } from './proof-flags.generated';

// WR-05: PROOF_CHAIN_REF_KEY is imported from persistence-proof (the module
// that owns the write) so the runner's WRITE-vs-READ branch cannot desync.

/**
 * Boot entry point. Fire-and-forget from index.js after the app registers.
 * Never throws — any failure is logged as `[proof] FATAL` so the app still boots.
 *
 * @param node  Optional StrandHost (e.g. a live CadreNode from useCadreNode()).
 *              When provided, makeProofEngine(node) drives createStrandDbFactory,
 *              exercising the strand createContext path for VER-04 verification.
 *              When omitted (the default — including the index.js boot call),
 *              makeProofEngine() falls back to rnDbFactory (existing behaviour).
 *              Note: the CadreNode has not booted yet at the index.js call site,
 *              so the boot invocation correctly passes no argument.
 */
export async function runPersistenceProof(node?: StrandHost): Promise<void> {
  if (!(__DEV__ && PROOF_ENABLED)) {
    return;
  }

  // D-03 smoke: run at every boot so Metro traces rn-entry-smoke.ts in the bundle graph.
  // Logs '[rn-smoke] All /rn exports resolve on Hermes: PASS|FAIL'.
  runRnEntrySmoke();

  try {
    // WR-05: use PROOF_CHAIN_REF_KEY as the write-vs-read discriminant (full-chain proof).
    // On first boot (no saved chain ref) → WRITE phase.
    // After force-stop + relaunch (chain ref present) → READ phase → verdict.
    const alreadyWritten = await AsyncStorage.getItem(PROOF_CHAIN_REF_KEY);

    if (!alreadyWritten) {
      // WR-14 (17-REVIEW): the attempt marker without the chain ref means a previous
      // WRITE phase failed between its first store mutation and the chain-ref commit.
      // The LevelDB store may already hold Network/Authority rows — blindly re-running
      // networksEngine.create() against it fails repeatedly. Tell the operator how to
      // reset instead of wedging the harness.
      const writeAttempted = await AsyncStorage.getItem(PROOF_WRITE_ATTEMPTED_KEY);
      if (writeAttempted) {
        console.error(
          '[proof] FATAL — partial write detected (a previous WRITE phase failed mid-flight at ' +
            `${new Date(Number(writeAttempted)).toISOString()}): the store may contain rows but ` +
            'no chain ref was saved. Reset with: adb shell pm clear org.votetorrent.authority',
        );
        return;
      }

      // ---- FULL-CHAIN WRITE PHASE (first launch / after `pm clear`) ----
      console.info('[proof] ========== BOOT: WRITE PHASE (no saved state) ==========');

      // T-16-14: use the REAL device user — never the fake PROOF_USER key.
      const user = await getOrCreateDeviceUser('Proof Runner');
      const engine = makeProofEngine(node);
      const { networkRef, authorityId, electionId, db } = await runFullChainWritePhase(engine, user);
      console.info(
        `[proof] WRITE COMPLETE — hash=${networkRef.hash} authorityId=${authorityId} electionId=${electionId}`,
      );
      // Crypto on the freshly-initialized on-device store (also re-run post-restart).
      await assertCryptoFunctions(db);
      console.info(
        '[proof] NEXT STEP → adb shell am force-stop org.votetorrent.authority, then relaunch the app',
      );
      console.info('[proof] ========== WRITE PHASE DONE ==========');
    } else {
      // ---- FULL-CHAIN READ PHASE (after force-stop + relaunch) ----
      console.info('[proof] ========== BOOT: READ PHASE (saved state present) ==========');

      const user = await getOrCreateDeviceUser('Proof Runner');
      const engine = makeProofEngine(node);
      const result = await runFullChainReadPhase(engine, user);
      console.info(
        `[proof] READ COMPLETE — passed=${result.passed} network=${result.networkCount} authority=${result.authorityCount} election=${result.electionCount}`,
      );

      // D-16 part 2: crypto assertions on the re-attached persistent store — use the
      // SAME handle open() used (capturing factory single-handle guarantee, Pitfall 5).
      const db = getLastProofDb();
      if (!db) {
        throw new Error('[proof] read phase: no captured db handle after open()');
      }
      const crypto = await assertCryptoFunctions(db);

      // DEBT-04 device-side parity gate: replay golden vectors through on-device Quereus
      // Digest() and compare to Node-pinned expected base64url strings.
      const digestParity = await assertDigestParity(db);

      // Emit the single verdict line that run-vtest02.sh polls for via:
      //   VERDICT_TAG='\[proof\] ========== FULL-CHAIN VERDICT'
      // This log line is the VTEST-02 evidence (D-08) — byte-identical to the script grep target.
      // digestParity.allPassed folds into the overall verdict so a parity failure flips PASS→FAIL.
      const verdict = result.passed && crypto.allPassed && digestParity.allPassed;
      console.info(
        `[proof] ========== FULL-CHAIN VERDICT: ${verdict ? 'PASS' : 'FAIL'} ` +
          `(network=${result.networkCount},authority=${result.authorityCount},election=${result.electionCount},crypto=${crypto.allPassed},digestParity=${digestParity.allPassed}) ==========`,
      );
    }
  } catch (err) {
    console.error('[proof] FATAL —', err);
  }
}
