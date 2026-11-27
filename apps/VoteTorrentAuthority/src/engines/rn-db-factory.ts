/**
 * RN persistent DbFactory — LevelDB-backed Quereus Database for Android/Hermes.
 *
 * D-03: This file is the ONLY place `rn-leveldb`, `@quereus/plugin-react-native-leveldb`,
 * and (for the strand-backed path) `@optimystic/db-p2p-storage-rn` + `@serfab/cadre-core`
 * are imported for DbFactory purposes. They MUST NOT appear under packages/vote-engine/.
 *
 * Solo path: @quereus/plugin-react-native-leveldb@4.2.1 + @quereus/store@4.2.1
 *   (published, version-aligned with pinned @quereus/quereus@4.2.1; D-01/D-02).
 *   rn-leveldb@3.11: github.com/gotchoices/rn-leveldb — registry-audited Plan 14-02 (APPROVED).
 * Strand path: @optimystic/db-p2p-storage-rn@portal (unchanged; cadre-core/CadreNodeProvider).
 *
 * The strand-backed factory (createStrandDbFactory, StrandHost, StrandDbFactoryOptions) moved to
 * @votetorrent/workflows common/strand-db-factory.ts and is re-exported here; this file keeps only the
 * LevelDB solo factory.
 */

import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { ReactNativeLevelDBProvider } from '@quereus/plugin-react-native-leveldb';
import { leveldbOpenPool } from './leveldb-open-pool';
import { createIsolatedStoreModule } from '@quereus/store';
import { Database } from '@quereus/quereus';
import type { DbFactory } from '@votetorrent/vote-engine';
// Side-effect import: installs the dev-only strand-change reporter wherever the factory is reachable.
import './strand-changes';

export { createStrandDbFactory } from '@votetorrent/workflows';
export type { StrandHost, StrandDbFactoryOptions } from '@votetorrent/workflows';

/**
 * Concrete DbFactory for the RN app layer — Quereus-native LevelDB via
 * @quereus/plugin-react-native-leveldb@4.2.1 (D-01/D-02: published, version-aligned).
 *
 * D-04: store name 'votetorrent-q2-<networkHash>' provides a clean break from the
 *       old optimystic per-table layout; the 'q2' prefix signals quereus-native v2
 *       storage format. Zero collision with any old 'votetorrent-<networkHash>' stores.
 * D-06: The old optimystic DI dance (raw storage factory + plugin registration cast)
 *       is fully removed. db.registerModule accepts AnyVirtualTableModule directly
 *       — no as-unknown-as-SqlValue cast needed.
 * D-11: rn-leveldb default path = app-private internal storage (not SD card).
 * D-13: No try/catch fallback — open errors propagate. No in-memory new Database() fallback.
 * D-14: No destroyDB — on-disk store persists and re-attaches on reopen.
 */
export const rnDbFactory: DbFactory = async (networkHash: string) => {
  // D-04: version-bumped store name — zero collision with old 'votetorrent-<networkHash>'
  const databaseName = `votetorrent-q2-${networkHash}`;

  // Quereus opens one LevelDB per table and per index; the pool keeps only a few of them open at
  // once (leveldb-open-pool.ts).
  const provider = new ReactNativeLevelDBProvider({
    openFn: leveldbOpenPool.openFn((n: string, c: boolean, e: boolean) => new LevelDB(n, c, e)),
    WriteBatch: LevelDBWriteBatch,
    databaseName,
    createIfMissing: true,
  });

  // createIsolatedStoreModule wraps provider with snapshot isolation (default: true).
  // Provider owns all per-table file management; no legacy DI intermediary needed.
  const storeModule = createIsolatedStoreModule({ provider });

  // quereus 4.2.1 Database constructor takes no arguments (confirmed Plan 14-01, unchanged).
  const db = new Database();

  // No cast — db.registerModule accepts AnyVirtualTableModule (vs registerPlugin's Record<string,SqlValue>).
  db.registerModule('store', storeModule);

  // REQUIRED: VOTETORRENT_SCHEMA_SQL has zero USING clauses (grep confirmed 0 matches).
  // Without this, Quereus routes schema-less table creation to in-memory, not LevelDB.
  db.setDefaultVtabName('store');

  // NO db.setDefaultVtabArgs — 'store' module has no transactor args;
  //   isolation is handled internally by createIsolatedStoreModule.
  // NO db.setSchemaPath — that is the strand path only (D-14).

  return db;
};
