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
} from './persistence-proof';
import { rnDbFactory } from './rn-db-factory';

/** Master switch for the boot-time proof runner. */
const PROOF_ENABLED = true;

/** Presence of this AsyncStorage key means the write phase already ran. */
const PROOF_NETWORK_REF_KEY = 'proof:networkRef';

/**
 * Diagnostic: does an `exists(...)` CHECK constraint see a parent row on the
 * Optimystic/LevelDB vtab — within one exec() (read-your-writes) and across two
 * separate exec() calls (cross-transaction)? NetworksEngine.create() relies on
 * the cross-exec form (Admin committed in batch 1, Officer.AdminValid checks it
 * in batch 2). Runs on a clean store only. Logs under [probe].
 */
async function runVtabCheckProbe(): Promise<void> {
  console.log('[probe] ===== vtab CHECK-visibility probe =====');
  const db = await rnDbFactory('vtabprobe0000000');
  await db.exec(`create table if not exists P (Id text primary key);`);
  await db.exec(
    `create table if not exists C (Id text primary key, Pid text, constraint PValid check (exists (select 1 from P where P.Id = new.Pid)));`,
  );

  // A: two separate exec() calls — mirrors create()'s split-batch (parent then child).
  try {
    await db.exec(`insert into P (Id) values ('p1');`);
    const seen = await db.prepare(`select Id from P where Id = 'p1'`).get();
    console.log('[probe] A: parent visible after separate-exec insert =', JSON.stringify(seen));
    await db.exec(`insert into C (Id, Pid) values ('c1', 'p1');`);
    console.log('[probe] A: SEPARATE-exec child insert PASSED (cross-exec CHECK sees parent)');
  } catch (e) {
    console.log('[probe] A: SEPARATE-exec child insert FAILED —', String(e));
  }

  // B: one combined exec() — read-your-writes within a single transaction.
  try {
    await db.exec(
      `insert into P (Id) values ('p2'); insert into C (Id, Pid) values ('c2', 'p2');`,
    );
    console.log('[probe] B: SINGLE-exec parent+child PASSED (intra-txn CHECK sees parent)');
  } catch (e) {
    console.log('[probe] B: SINGLE-exec parent+child FAILED —', String(e));
  }

  // C: composite (text, datetime) PK + datetime-equality existence CHECK — mirrors
  //    Admin(AuthorityId, EffectiveAt) / Officer.AdminValid. Same canonical value
  //    passed to both inserts (as create() does).
  const dt = '2026-06-03T16:53:24'; // toCanonicalDatetime(Date.now()) shape
  try {
    await db.exec(
      `create table if not exists PA (Aid text, Eat datetime, primary key (Aid, Eat));`,
    );
    await db.exec(
      `create table if not exists OF (Id text primary key, Aid text, Eat datetime, constraint AdminValid check (exists (select 1 from PA A where A.Aid = new.Aid and A.Eat = new.Eat)));`,
    );
    await db.exec(`insert into PA (Aid, Eat) values ('auth1', :dt);`, { dt });
    const back = await db.prepare(`select Eat from PA where Aid = 'auth1'`).get();
    console.log('[probe] C: datetime stored as =', JSON.stringify(back), '(inserted', JSON.stringify(dt) + ')');
    await db.exec(`insert into OF (Id, Aid, Eat) values ('off1', 'auth1', :dt);`, { dt });
    console.log('[probe] C: datetime-PK existence CHECK PASSED');
  } catch (e) {
    console.log('[probe] C: datetime-PK existence CHECK FAILED —', String(e));
  }

  // D: identical to C but Eat is TEXT (not datetime). Discriminates datetime-type
  //    vtab key-encoding from generic composite-PK existence.
  try {
    await db.exec(
      `create table if not exists PAT (Aid text, Eat text, primary key (Aid, Eat));`,
    );
    await db.exec(
      `create table if not exists OFT (Id text primary key, Aid text, Eat text, constraint AdminValid check (exists (select 1 from PAT A where A.Aid = new.Aid and A.Eat = new.Eat)));`,
    );
    await db.exec(`insert into PAT (Aid, Eat) values ('auth1', :dt);`, { dt });
    await db.exec(`insert into OFT (Id, Aid, Eat) values ('off1', 'auth1', :dt);`, { dt });
    console.log('[probe] D: TEXT-composite-PK existence CHECK PASSED');
  } catch (e) {
    console.log('[probe] D: TEXT-composite-PK existence CHECK FAILED —', String(e));
  }

  // E: composite datetime PK but compare via a plain (non-PK) full-scan style —
  //    isolate whether the equality itself or the PK-index path is at fault.
  try {
    await db.exec(
      `create table if not exists PAD (Aid text primary key, Eat datetime);`,
    );
    await db.exec(`insert into PAD (Aid, Eat) values ('auth1', :dt);`, { dt });
    const m = await db
      .prepare(`select 1 as v from PAD where Aid = 'auth1' and Eat = :dt`)
      .get({ dt });
    console.log('[probe] E: datetime equality (non-composite-PK) match =', JSON.stringify(m));
  } catch (e) {
    console.log('[probe] E: datetime equality probe FAILED —', String(e));
  }

  // F: direct reads against the composite-PK table PAT (already has 'auth1',dt).
  try {
    const cnt = await db.prepare(`select count(*) as n from PAT`).get();
    const partial = await db.prepare(`select Aid, Eat from PAT where Aid = 'auth1'`).get();
    const full = await db.prepare(`select Aid, Eat from PAT where Aid = 'auth1' and Eat = :dt`).get({ dt });
    console.log('[probe] F: PAT count =', JSON.stringify(cnt),
      '| partial-key read =', JSON.stringify(partial),
      '| full-composite-key read =', JSON.stringify(full));
  } catch (e) {
    console.log('[probe] F: composite-PK read probe FAILED —', String(e));
  }
  // G: empty primary key () — the singleton-table pattern used by Network.
  try {
    await db.exec(`create table if not exists SG (X text, primary key ());`);
    await db.exec(`insert into SG (X) values ('one');`);
    const n = await db.prepare(`select count(*) as n from SG`).get();
    const r = await db.prepare(`select X from SG`).get();
    console.log('[probe] G: empty-PK singleton table — count =', JSON.stringify(n), 'row =', JSON.stringify(r), '=> PASSED');
  } catch (e) {
    console.log('[probe] G: empty-PK singleton table FAILED —', String(e));
  }
  // H: empty-PK table created FIRST among several in ONE exec, then inserted in a
  //    SEPARATE exec — mirrors Network (first table in the big schema exec, inserted
  //    in create() batch 3). Tests the "Table 'Network' not found" lifecycle.
  try {
    await db.exec(
      `create table if not exists HA (X text, primary key ());
       create table if not exists HB (Y text primary key);
       create table if not exists HC (Z text primary key);`,
    );
    await db.exec(`insert into HB (Y) values ('b');`); // insert other tables first
    await db.exec(`insert into HA (X) values ('a');`); // then the empty-PK first table
    const n = await db.prepare(`select count(*) as n from HA`).get();
    console.log('[probe] H: empty-PK-first-in-multiexec then separate insert — count =', JSON.stringify(n), '=> PASSED');
  } catch (e) {
    console.log('[probe] H: empty-PK-first-in-multiexec FAILED —', String(e));
  }
  console.log('[probe] ===== probe done =====');
}

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
      await runVtabCheckProbe();
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
      // D-16 part 2: crypto assertions on the re-attached persistent store.
      const db = await rnDbFactory(result.networkHash);
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
