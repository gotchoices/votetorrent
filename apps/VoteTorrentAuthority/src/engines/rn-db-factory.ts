/**
 * RN persistent DbFactory — LevelDB-backed Quereus Database for Android/Hermes.
 *
 * D-03: This file is the ONLY place `rn-leveldb`, `@optimystic/db-p2p-storage-rn`,
 * and (for the strand-backed path) `@serfab/cadre-core` are imported for DbFactory
 * purposes. They MUST NOT appear under packages/vote-engine/.
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
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/rn';
import type { DbFactory } from '@votetorrent/vote-engine';
import type { StrandConfig, StrandInstance } from '@serfab/cadre-core';

// cadre-core's StrandDatabase.executeSchema() wraps the sApp schema as
// `declare schema App { ${schema} } apply schema App;`. VOTETORRENT_SCHEMA_SQL is
// itself wrapped in `declare schema main { ... } apply schema main;`, so passing it
// verbatim nests invalidly and Quereus throws `got '}'`. Strip the outer wrapper so
// only the inner DDL is handed to addStrand; cadre-core re-wraps it under `App` and
// setSchemaPath(['App','main']) resolves bare engine table names (D-14). qsql has no
// `main.`-qualified references, so the strip is clean.
const VOTETORRENT_INNER_DDL = VOTETORRENT_SCHEMA_SQL
	.replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
	.replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
	.trim();

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

/**
 * Minimal addStrand-capable seam — satisfied structurally by `CadreNode`.
 *
 * Injected (rather than reaching for a module-level singleton) so the
 * strand-backed factory is unit-testable with a fake node. CadreNode's
 * `getControlNode()` returns `Libp2p | null`; we only read `getConnections()`.
 */
export interface StrandHost {
	addStrand(config: StrandConfig): Promise<StrandInstance>;
	getControlNode(): { getConnections(): readonly unknown[] } | null;
}

/**
 * Strand-backed DbFactory (P2P-03 / D-07 / D-14).
 *
 * Returns a `DbFactory` that, instead of opening a standalone LevelDB-backed
 * Quereus Database, attaches a CadreNode strand for the network and hands back
 * the strand's Quereus Database. The strand owns the vtab + transactor, so there
 * is NO registerPlugin / setDefaultVtab call on this path — cadre-core applies
 * the sApp schema (wrapped in `declare schema App { ... }`) during addStrand.
 *
 * D-05: strandId is derived directly from the network hash — already unique per
 *       network, so it doubles as the strandId with no extra mapping structure.
 * D-07: mode is peer-gated EXPLICITLY. Omitting it defaults to 'networked', which
 *       hangs a solo node (the network transactor waits for peer round-trips).
 *       'bootstrap' routes schema apply + writes through the local transactor.
 * D-14: after `getDatabase()`, `setSchemaPath(['App','main'])` makes bare engine
 *       SQL table names (e.g. `Network`) resolve to `App.Network` first, with
 *       `main` as the fallback for SchemaVersion / TidSequence. One call fixes
 *       the entire SQL tier — zero engine query rewrites.
 *
 * Ordering (Pitfall 3): never read `strand.database` before `await addStrand`
 * resolves — cadre-core awaits the strand DB's internal initialize() and returns
 * only once the database is safe to access.
 */
export function createStrandDbFactory(node: StrandHost): DbFactory {
	return async (networkHash: string) => {
		// D-05: the network hash is already unique per network — use it as the strandId.
		const strandId = networkHash;

		// D-07: check for peers BEFORE addStrand and pass the mode literal explicitly.
		const hasPeers = (node.getControlNode()?.getConnections().length ?? 0) > 0;

		const strand = await node.addStrand({
			strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
			sAppConfig: {
				id: 'org.votetorrent',
				version: '1.0.0',
				schema: VOTETORRENT_INNER_DDL,
				latencyHint: 'interactive',
			},
			mode: hasPeers ? 'networked' : 'bootstrap',
		});

		// Safe only after addStrand resolves (Pitfall 3). `database` is present once
		// the strand is active/idle, which addStrand guarantees on return.
		const db = strand.database!.getDatabase();
		db.setSchemaPath(['App', 'main']); // D-14 transparency — never omit (Pitfall 2).

		return db;
	};
}
