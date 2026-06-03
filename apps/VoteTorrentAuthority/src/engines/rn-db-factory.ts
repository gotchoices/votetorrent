/**
 * RN persistent DbFactory — LevelDB-backed Quereus Database for Android/Hermes.
 *
 * D-03: This file is the ONLY place `rn-leveldb` and `@optimystic/db-p2p-storage-rn`
 * are imported in the entire project. They MUST NOT appear under packages/vote-engine/.
 *
 * Both packages are pre-installed in apps/VoteTorrentAuthority/package.json and
 * spike-validated on-device (spikes 005 + 008). Registry-audited in Plan 14-02
 * legitimacy checkpoint (APPROVED):
 *   - rn-leveldb@3.11.0: github.com/gotchoices/rn-leveldb, author GreenTriangle
 *   - @optimystic/db-p2p-storage-rn@0.13.5: github.com/gotchoices/optimystic,
 *     author Got Choices Foundation — same gotchoices org as VoteTorrent
 */

import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { openOptimysticRNDb, LevelDBRawStorage } from '@optimystic/db-p2p-storage-rn';
import { Database, registerPlugin } from '@quereus/quereus';
import { register as optimysticPlugin } from '@optimystic/quereus-plugin-optimystic';
import type { DbFactory } from '@votetorrent/vote-engine';

/**
 * Concrete DbFactory for the RN app layer.
 *
 * Opens a per-network LevelDB store named `votetorrent-<networkHash>` using the
 * spike-008 validated openOptimysticRNDb recipe, then wires the resulting
 * LevelDBRawStorage as the backing store of the Quereus Database via the
 * quereus-plugin-optimystic `register()` function with `rawStorageFactory`
 * and `transactor: 'local'`. This is the direct store-vtab path confirmed by
 * the quereus 3.3.0 API in Plan 14-01 (db.registerModule post-construction
 * via registerPlugin + db.setDefaultVtabName + db.setDefaultVtabArgs).
 *
 * D-04/D-11: Store name derived from network hash; rn-leveldb default = app-private
 *            internal storage (not SD card / world-readable).
 * D-13: No try/catch fallback — open errors propagate to the engine's error handler.
 *       There is intentionally NO silent fallback to a bare in-memory new Database().
 * D-14: No destroyDB call — the on-disk store stays on disk and re-attaches if
 *       re-opened; forget-network / recents removal does NOT delete the LevelDB store.
 */
export const rnDbFactory: DbFactory = async (networkHash: string) => {
  // D-04/D-11: store name keyed by network hash; fixed-length hex output → safe as store key
  const storeName = `votetorrent-${networkHash}`;

  // Spike-008 VALIDATED recipe (cadre-runtime-ondevice.md §1)
  const rnDb = openOptimysticRNDb({
    openFn: (n: string, c: boolean, e: boolean) => new LevelDB(n, c, e),
    WriteBatch: LevelDBWriteBatch,
    name: storeName,
  });

  const rawStorage = new LevelDBRawStorage(rnDb);

  // quereus 3.3.0 Database constructor takes no arguments (Plan 14-01 confirmed).
  // Vtab registration is post-construction:
  //   1. registerPlugin wires the OptimysticModule with rawStorageFactory → auxData
  //   2. setDefaultVtabName tells Quereus to use 'optimystic' for schema-less tables
  //   3. setDefaultVtabArgs tells the module to use the 'local' (single-node) transactor
  const db = new Database();

  // Register the optimystic vtab module with the LevelDB-backed rawStorageFactory.
  // The 'local' transactor uses rawStorageFactory when supplied (per plugin source
  // line 124: `options.rawStorageFactory?.() ?? new MemoryRawStorage()`).
  // rawStorageFactory is a function (not a SqlValue), so it must be cast through
  // `unknown` — the plugin extracts it at runtime via `typeof aux["rawStorageFactory"]
  // === "function"` (plugin chunk line 1892). The registerPlugin config type is
  // Record<string,SqlValue> for simple primitives, but the optimystic plugin
  // intentionally accepts function-valued auxData for DI.
  await registerPlugin(db, optimysticPlugin, {
    rawStorageFactory: () => rawStorage,
  } as unknown as Record<string, import('@quereus/quereus').SqlValue>);

  db.setDefaultVtabName('optimystic');
  db.setDefaultVtabArgs({ transactor: 'local' });

  return db;
};
