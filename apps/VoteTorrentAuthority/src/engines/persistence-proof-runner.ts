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
  runWritePhase,
  runReadPhase,
  assertCryptoFunctions,
  getLastProofDb,
} from './persistence-proof';

/** Master switch for the boot-time proof runner. */
const PROOF_ENABLED = true;

/** Presence of this AsyncStorage key means the write phase already ran. */
const PROOF_NETWORK_REF_KEY = 'proof:networkRef';

/**
 * Boot entry point. Fire-and-forget from index.js after the app registers.
 * Never throws — any failure is logged as `[proof] FATAL` so the app still boots.
 */
export async function runPersistenceProof(): Promise<void> {
  if (!PROOF_ENABLED) {
    return;
  }

  try {
    const alreadyWritten = await AsyncStorage.getItem(PROOF_NETWORK_REF_KEY);

    if (!alreadyWritten) {
      // ---- WRITE PHASE (first launch / after `pm clear`) ----
      console.log('[proof] ========== BOOT: WRITE PHASE (no saved state) ==========');
      const engine = makeProofEngine();
      const { networkHash, networkCount, db } = await runWritePhase(engine);
      console.log(
        `[proof] WRITE COMPLETE — hash=${networkHash} Network rows=${networkCount}`,
      );
      // Crypto on the freshly-initialized on-device store (also re-run post-restart).
      await assertCryptoFunctions(db);
      console.log(
        '[proof] NEXT STEP → adb shell am force-stop org.votetorrent.authority, then relaunch the app',
      );
      console.log('[proof] ========== WRITE PHASE DONE ==========');
    } else {
      // ---- READ PHASE (after force-stop + relaunch) ----
      console.log('[proof] ========== BOOT: READ PHASE (saved state present) ==========');
      const engine = makeProofEngine();
      const result = await runReadPhase(engine);
      console.log(
        `[proof] READ COMPLETE — passed=${result.passed} pre=${result.preRestartCount} post=${result.postRestartCount}`,
      );
      // D-16 part 2: crypto assertions on the re-attached persistent store — use the
      // SAME handle open() used (a fresh rnDbFactory handle has no schema declared).
      const db = getLastProofDb();
      if (!db) {
        throw new Error('[proof] read phase: no captured db handle after open()');
      }
      const crypto = await assertCryptoFunctions(db);
      const verdict = result.passed && crypto.allPassed;
      console.log(
        `[proof] ========== D-16 VERDICT: ${verdict ? 'PASS' : 'FAIL'} ` +
          `(restart-persistence=${result.passed}, crypto=${crypto.allPassed}) ==========`,
      );
    }
  } catch (err) {
    console.error('[proof] FATAL —', err);
  }
}
