/**
 * RN persistent DbFactory — LevelDB-backed Quereus Database for Android/Hermes.
 *
 * D-03: This file is the ONLY place `rn-leveldb`, `@quereus/plugin-react-native-leveldb`,
 * and (for the strand-backed path) `@optimystic/db-p2p-storage-rn` + `@serfab/cadre-core`
 * are imported for DbFactory purposes. They MUST NOT appear under packages/vote-engine/.
 *
 * Verbatim port of the authority app's `rn-db-factory.ts` (Phase 44-02) — see
 * `apps/VoteTorrentAuthority/src/engines/rn-db-factory.ts` for the original.
 *
 * Solo path: @quereus/plugin-react-native-leveldb@4.3.1 + @quereus/store@4.3.1
 *   (published, version-aligned with pinned @quereus/quereus@4.3.1; D-01/D-02).
 *   rn-leveldb@3.11: github.com/gotchoices/rn-leveldb — registry-audited Plan 14-02 (APPROVED).
 * Strand path: @optimystic/db-p2p-storage-rn@0.14.1 (unchanged; cadre-core/CadreNodeProvider).
 */

import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { ReactNativeLevelDBProvider } from '@quereus/plugin-react-native-leveldb';
import { createIsolatedStoreModule } from '@quereus/store';
import { Database } from '@quereus/quereus';
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
 * Concrete DbFactory for the RN app layer — Quereus-native LevelDB via
 * @quereus/plugin-react-native-leveldb@4.3.1 (D-01/D-02: published, version-aligned).
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

  const provider = new ReactNativeLevelDBProvider({
    openFn: (n: string, c: boolean, e: boolean) => new LevelDB(n, c, e),
    WriteBatch: LevelDBWriteBatch,
    databaseName,
    createIfMissing: true,
  });

  // createIsolatedStoreModule wraps provider with snapshot isolation (default: true).
  // Provider owns all per-table file management; no legacy DI intermediary needed.
  const storeModule = createIsolatedStoreModule({ provider });

  // quereus 4.3.1 Database constructor takes no arguments (confirmed Plan 14-01, unchanged).
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
 *       `main` as the fallback for SchemaInit / TidSequence. One call fixes
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
