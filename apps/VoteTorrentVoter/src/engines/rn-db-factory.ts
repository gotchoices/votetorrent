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
import { leveldbOpenPool } from './leveldb-open-pool';
import { createIsolatedStoreModule } from '@quereus/store';
import { Database } from '@quereus/quereus';
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/rn';
import type { DbFactory } from '@votetorrent/vote-engine';
import type { StrandConfig, StrandInstance } from '@serfab/cadre-core';
import {
	failOnStrandError,
	isStrandAwaitingFirstSyncError,
	StrandLaunchFailedError,
	waitForStrandWritable,
} from './strand-first-sync';
import { takeFounderIntent, resolveFounderFlag } from './founder-intent';
import { strandChanges } from './strand-changes';

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
	whenStrandWritable(strandId: string, options?: { timeoutMs?: number }): Promise<StrandInstance>;
	/** Read for `'error'` while an open waits (see `StrandLaunchFailedError`). Optional for test fakes. */
	getStrand?(strandId: string): { status: string } | undefined;
	/** Releases a strand that failed to start, so the next open launches it afresh. */
	stopStrand?(strandId: string): Promise<void>;
}

/**
 * Options for the first-sync gate (quick task 260928-kkf — see strand-first-sync.ts).
 *
 * `signal` cancels a pending `whenStrandWritable` wait (node change, network switch /
 * Start Fresh, provider unmount). `onAwaitingFirstSync` fires once, BEFORE the wait
 * begins, so a caller can surface a "still syncing" state — it does not fire again on
 * subsequent retry attempts within the same wait.
 */
export interface StrandDbFactoryOptions {
	signal?: AbortSignal;
	onAwaitingFirstSync?: (strandId: string) => void;
	/**
	 * Spike 100: true for a network this phone JOINED (an authority founded it). Such a strand is
	 * never opened as founder, even with no peer connected yet (a cold restart opens it before the
	 * control connection is up): a founder would write membership rows of its own and fork the
	 * network. It waits for its first sync instead, through the gate below.
	 */
	isJoinedNetwork?: (strandId: string) => boolean | Promise<boolean>;
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
 * D-07: SUPERSEDED by cadre-core 0.11.0 (spike 064). `StrandMode` and
 *       `StrandConfig.mode` were DELETED upstream — a deliberate breaking change
 *       ("the repo carries no backwards compatibility"). The solo/networked
 *       transactor split is gone: every strand now uses the shared path, and the
 *       backfill gate is armed for every stored strand, which is what upstream
 *       says closes the "founded alone, never replicates" hole.
 *       The surviving knob is `founder?: boolean` — whether THIS node provisioned
 *       the strand. The founder runs the one-time membership bootstrap (writes
 *       `Strand.Header`, and for a closed strand the founding Member+Manager); a
 *       joiner leaves it false and receives those rows via Optimystic sync.
 *       The existing peer probe carries over with its meaning intact: no control
 *       peers ⇒ nobody else can have provisioned this strand ⇒ we are the founder.
 *       Reference: sereus v0.11.0 `scripts/lib/published-smoke-scenario.mjs:439`
 *       passes `founder: true` on the create path.
 * D-14: after `getDatabase()`, `setSchemaPath(['App','main'])` makes bare engine
 *       SQL table names (e.g. `Network`) resolve to `App.Network` first, with
 *       `main` as the fallback for SchemaInit / TidSequence. One call fixes
 *       the entire SQL tier — zero engine query rewrites.
 *
 * Ordering (Pitfall 3): never read `strand.database` before `await addStrand`
 * resolves (or, on the first-sync gate path below, before `waitForStrandWritable`
 * resolves) — `database` is present once the strand is active/idle, which EITHER
 * resolution guarantees.
 *
 * First-sync gate (quick task 260928-kkf): since cadre-core 1.1.0, a JOINER's
 * `addStrand` can block for its configured `strandFirstSync.timeoutMs` (default
 * 360 s, cadre-core 1.19.x `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS = 360000`) and then REJECT with the retryable `StrandAwaitingFirstSyncError` — "no
 * sibling has been reachable since this node joined" — rather than resolving. That is
 * NOT a failure to open the network: the strand stays launched and keeps probing on
 * its own, so this catches exactly that one error (name-marker + strandId match, see
 * `strand-first-sync.ts`) and waits for `strand:writable` via `waitForStrandWritable`
 * instead of failing the open. `addStrand` is called at most once per factory call —
 * the wait only ever calls `whenStrandWritable`. See `strand-first-sync.ts`'s module
 * doc comment for the full class-identity-detection and indefinite-wait rationale.
 */
export function createStrandDbFactory(node: StrandHost, options?: StrandDbFactoryOptions): DbFactory {
	return async (networkHash: string) => {
		// D-05: the network hash is already unique per network — use it as the strandId.
		const strandId = networkHash;

		// D-30 (the Authority's, ported): the one-shot intent read is the FIRST statement, before any
		// await, so a founding window is claimed by the open it was installed for and by no other.
		const intent = takeFounderIntent(strandId);

		// D-07 (0.11.0): check for peers BEFORE addStrand — no peers ⇒ we are the founder (the default).
		// Spike 100: unless this phone joined the network, in which case it never is.
		const controlConnections = node.getControlNode()?.getConnections().length ?? 0;
		let joined = false;
		try {
			joined = (await options?.isJoinedNetwork?.(strandId)) === true;
		} catch {
			// An unreadable joined-list must not make a joiner a founder: refuse to open instead.
			throw new Error('could not read the joined-network list; not opening the network as its founder');
		}

		let strand: StrandInstance;
		try {
			strand = await openStrand();
		} catch (error) {
			if (error instanceof StrandLaunchFailedError) {
				// Best effort: a strand that cannot be stopped leaves the next open failing the same way.
				await node.stopStrand?.(strandId).catch(() => undefined);
			}
			throw error;
		}

		// Safe only after addStrand OR waitForStrandWritable resolves (Pitfall 3).
		// `database` is present once the strand is active/idle, which either
		// resolution guarantees.
		const db = strand.database!.getDatabase();
		db.setSchemaPath(['App', 'main']); // D-14 transparency — never omit (Pitfall 2).
		// Screens hear this strand's table changes through the app's one hub (useStrandChanges).
		strandChanges.attach(strandId, strand.database!);

		return db;

		async function openStrand(): Promise<StrandInstance> {
			try {
				const launch = node.addStrand({
					// FounderOwnerKey is new and REQUIRED in cadre-core 0.13.0: the owner key of the machine
					// that published the row, used to derive "am I the founder?" for a launch that supplies
					// no explicit flag. We DO supply `founder` explicitly just below, so null is correct
					// here rather than merely tolerated — and it is provenance, not content, so
					// `strandRowMismatches` excludes it from the identical-content comparison.
					// cadre-core 1.18 adds `FounderPeerId` (the machine that runs the founder bootstrap,
					// read only when no explicit `founder` flag is given). Same reasoning, so null.
					strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
					sAppConfig: {
						id: 'org.votetorrent',
						version: '1.0.0',
						schema: VOTETORRENT_INNER_DDL,
						latencyHint: 'interactive',
					},
					founder: resolveFounderFlag({ intent, joined, controlConnections }),
				});
				// A launch that loses the race below still settles later; never as an unhandled rejection.
				launch.catch(() => undefined);
				return await failOnStrandError(node, strandId, launch);
			} catch (error) {
				// Only the first-sync gate error, FOR THIS strand, is retryable — every other
				// error (including the same gate error for a different strand) rejects unchanged.
				if (!isStrandAwaitingFirstSyncError(error, strandId)) {
					throw error;
				}
				options?.onAwaitingFirstSync?.(strandId);
				// Never re-calls addStrand — loops on whenStrandWritable only (see the doc
				// comment above and strand-first-sync.ts). cadre-core's default
				// `awaitFirstSync: true` is left untouched, so a non-gated/fast join is
				// unaffected and resolves exactly as before this catch was added.
				return await waitForStrandWritable(node, strandId, { signal: options?.signal });
			}
		}
	};
}
