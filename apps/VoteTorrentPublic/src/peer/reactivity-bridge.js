/**
 * reactivity-bridge.js — a network wake (node.reactivityWatch) -> one injected `Database`
 * handle -> `notifyPeerWrite`. `56-09`'s replication seam, restated in this
 * module's own words for this module's own setting (do not import
 * `snapshot-restore.js`'s argument by analogy):
 *
 * 1. THE SEAM THAT EXISTS FOR EXACTLY THIS. `applyExternalRowChanges` is
 *    documented for "trusted replication-style writes" and runs NO
 *    constraint validation (no PK / UNIQUE / CHECK / FK). The whole
 *    `votetorrent.qsql` argument `snapshot-restore.js` makes for why SQL DML
 *    is not an alternative applies here VERBATIM: the signature-gated
 *    `InsertValid` families, `context.SigningNonce`, and the expiration
 *    CHECKs on historical rows would all reject a row this browser never
 *    signed and has no signing context for. A peer-replicated row is
 *    exactly that shape.
 *
 * 2. WHY THE TRUST POSTURE IS SATISFIED HERE. The rows this module applies
 *    are never taken from what woke it. Every wake -- a notification, a
 *    landing in this node's storage, or the watch service's tick -- leads to
 *    the same `readRows()`, which re-reads every public table through the
 *    strand read handle's NETWORK transactor (`strand-read.js` asserts it
 *    resolved to `'network'`), from the cohort that serves the strand. So the
 *    rows have one provenance whatever woke the page: the serving cohort's
 *    committed blocks. The wake is checked too, as far as a wake can be:
 *    `node.reactivityWatch` builds one `ReactivitySubscriptionManager` per
 *    collection, and a socket-delivered notification reaches no watcher until
 *    that manager has verified its THRESHOLD SIGNATURE against the cached
 *    root-group membership. A tick or a local landing that wakes the page
 *    falsely costs one extra re-read and nothing else: a value-identical
 *    re-apply reports no change (T-56-09-05). What none of this buys, stated
 *    plainly: nothing on this path re-runs a CHECK, UNIQUE or FK constraint.
 *    T-56-09-03 records that residual as accepted, not overlooked.
 *
 * 3. THE STANDING RULE AND ITS BOUNDARY. "Write through `vote-engine`,
 *    never the raw Quereus `Database` handle" governs AUTHORITY ACTIONS — a
 *    write that represents someone doing something, where 26 of the 41
 *    authorization sites are engine-delegated `context.Is*Valid`
 *    constraints a raw handle silently loses. A peer replication represents
 *    NOBODY DOING ANYTHING on this device; it re-materialises rows the
 *    strand already committed. This app holds no key and performs no
 *    authority action at all, so the two-tier authorization argument has no
 *    purchase here — there is no engine API for "apply a replicated row"
 *    and, per point 1, there cannot be a SQL one either.
 *
 * 4. THIS MODULE OWNS THE DATA EVENTS. `Database.ingestExternalRowChanges`'s
 *    own docstring states the division of responsibility verbatim: the seam
 *    "does NOT emit module data events (the external writer owns those,
 *    including the `remote` flag)". The single `notifyPeerWrite(...)` call
 *    below is that ownership discharged — not defensive belt-and-braces,
 *    but the ONLY place in this flow a data event is ever raised.
 *
 * THE SECOND PRODUCTION SITE. This is the second production site of the
 * external-write seam in this repo; the first is
 * `apps/VoteTorrentDashboard/src/lifecycle/snapshot-restore.js`. Both are
 * pinned by `test/node/external-write-seam-sites.test.mjs` (Task 3).
 * `resolvePublicStoreModule` below is a deliberate re-implementation of
 * `snapshot-restore.js`'s `resolveStoreModule`, not a shared import: the two
 * apps do not import each other, and D-22 forbids growing
 * `@votetorrent/web-data/public`'s surface with an external-write helper.
 *
 * ONE HANDLE, RECEIVED NEVER CONSTRUCTED. `open-db.js`'s `setDefaultVtabName`
 * routing trap means a second call to the connection layer's own
 * store-handle opener (keyed on this network) would yield a second,
 * differently-routed handle whose writes the UI's read handle would never
 * see — same-session-invisible, per `Skill("spike-findings-votetorrent")`.
 * `startPeerReplication` therefore takes `db` as a REQUIRED option; this
 * module never opens, attaches or constructs a handle of its own — see the
 * grep this plan's acceptance criteria runs for the exact identifiers this
 * paragraph deliberately does not repeat, to keep that grep meaningful
 * rather than self-tripping.
 *
 * THE SUBSCRIPTION IS THE NODE'S, NOT THIS MODULE'S (step 3 of the
 * 2026-11-02 recommended order). This module used to build its own
 * `ReactivitySubscriptionManager` per table, register it on the node's
 * subscriber registry, retry `register()` against `CohortBackoffError` and
 * drive its own ttl/3 renewal timer -- and the page failed to boot when the
 * cohort never accepted. `node.reactivityWatch` (`@optimystic/db-p2p`
 * `ReactivityCollectionWatch`, the surface `optimystic-node.d.ts` names for
 * hosts) now does all of that: one subscription per collection, renewed at
 * the profile's cadence, following the tail on a rotation, and retried in the
 * background when a registration fails. It also runs a tick that reads each
 * watched collection's committed tail, so a lost notification, a failed
 * registration or an unannounced commit costs at most one tick of delay
 * instead of a page that silently stops updating. The tick reads through the
 * page's one tail reader (`tail-reader.js`). A node built without
 * `cohortTopic.enabled` has no watch service; that is a node-construction
 * defect and fails `startPeerReplication` by name (`resolveWatchService`),
 * never a page that quietly never updates.
 *
 * ONE RUN AT A TIME. `readRows` re-reads the whole allowlist, so a wake from
 * any table is a wake for all of them. Wakes are folded: while a run is in
 * progress, any number of further wakes cause exactly one more run after it.
 *
 * WHY `readRows` TAKES NO ARGUMENT. A wake carries no payload (the watch
 * service's `onChange` is coarse by design), and `NotificationV1` carries no
 * rows either (`db-core` `wire.d.ts`). Reading the changed collections is the
 * injected `readRows` contract, which `strand-read.js` implements. It is a
 * REQUIRED option with no default: a bridge that silently replicated nothing
 * would be the exact failure this module exists to prevent.
 *
 * ERROR HYGIENE, same discipline as `subscribe.js` and
 * `snapshot-restore.js`: only an error's `name` is ever logged, never its
 * message and never a row.
 *
 * DOES NOT PROVE: the browser page re-renders (`56-11`'s liveness proof) or
 * the D-16 production-variant inversion (`56-13`, which rebuilds a
 * genuinely mutated bundle rather than transforming a source copy -- see
 * Task 3's isolation control). Nothing in this module is imported from
 * `main.tsx`.
 */

import { PUBLIC_SUBSCRIBED_TABLES, STORE_MODULE_NAME, notifyPeerWrite } from '@votetorrent/web-data/public';

/** The one prefix every log line in this module carries. @type {string} */
const LOG_PREFIX = 'peer/reactivity-bridge:';

/**
 * Chunk size for `applyExternalRowChanges` batches — bounds peak memory for a
 * large replicated batch rather than holding one call's worth of ops for the
 * whole table. Mirrors `snapshot-restore.js`'s `RESTORE_BATCH_ROWS` rationale
 * exactly; the two constants are not shared because the two apps do not
 * import each other (see the module header).
 * @type {500}
 */
export const PEER_ROW_BATCH_ROWS = 500;

/**
 * A replication-time failure naming a table, option or module — NEVER a row
 * value. Same discipline as `SnapshotRestoreError`: a peer-replicated row can
 * carry registrant PII and must never reach an error string.
 */
export class PeerReplicationError extends Error {
	/**
	 * @param {string} subject - the table, option or module name this error concerns
	 * @param {string} reason
	 */
	constructor(subject, reason) {
		super(`reactivity-bridge: ${reason} (subject: "${subject}")`);
		this.name = 'PeerReplicationError';
		this.subject = subject;
	}
}

/**
 * The error's `name` and nothing else — see this file's header.
 * @param {unknown} err
 * @returns {void}
 */
function logFailure(err) {
	const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
	console.error(LOG_PREFIX, name);
}

/**
 * Resolve the module registered under `STORE_MODULE_NAME` (imported from
 * `@votetorrent/web-data/public`, never re-derived) as something that
 * exposes `getTableForExternalWrite` — either directly, or through an
 * `IsolationModule`'s public `underlying` property, exactly the resolution
 * `snapshot-restore.js:resolveStoreModule` performs (re-implemented here
 * rather than shared — see the module header). Throws `PeerReplicationError`
 * naming `STORE_MODULE_NAME`, never returning `undefined` for a caller to
 * trip over: a missing/incompatible module here means the handle was built
 * without the mandatory `setDefaultVtabName` path, `open-db.js`'s
 * same-session-invisible trap.
 * @param {import('@quereus/quereus').Database} db
 * @returns {{ getTableForExternalWrite(db: import('@quereus/quereus').Database, schemaName: string, tableName: string): (undefined | { applyExternalRowChanges(ops: readonly any[]): Promise<import('@quereus/quereus').BackingRowChange[]> }) }}
 */
export function resolvePublicStoreModule(db) {
	const registered = db.schemaManager.getModule(STORE_MODULE_NAME);
	const candidate = /** @type {any} */ (registered?.module);

	if (candidate && typeof candidate.getTableForExternalWrite === 'function') {
		return candidate;
	}
	const underlying = candidate?.underlying;
	if (underlying && typeof underlying.getTableForExternalWrite === 'function') {
		return underlying;
	}

	throw new PeerReplicationError(
		STORE_MODULE_NAME,
		'no externally-writable store module is registered under this name (directly, or via an isolation wrapper) -- the handle was built without the mandatory setDefaultVtabName path',
	);
}

/**
 * Apply one peer-replicated batch to `db` through the trusted-replication
 * seam, in chunks of `PEER_ROW_BATCH_ROWS`.
 *
 * `table` is checked against `PUBLIC_SUBSCRIBED_TABLES` BEFORE anything else
 * runs: the allowlist bounds WHAT MAY BE WRITTEN, not only what may be
 * announced (T-56-09-02). A batch naming a table outside the allowlist is
 * refused WHOLE — zero rows applied — with a named error.
 *
 * Returns the accumulated EFFECTIVE `BackingRowChange[]`
 * `applyExternalRowChanges` reported back, never the number of ops
 * submitted: `backing-host.d.ts:32-35` pins that an op that changes
 * nothing — a delete of an absent key, a value-identical upsert — "reports
 * nothing", and that emptiness is what makes T-56-09-05 hold (a replayed
 * batch produces no notice).
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {string} table
 * @param {readonly ({ op: 'upsert', row: import('@quereus/quereus').SqlValue[] } | { op: 'delete', pk: import('@quereus/quereus').SqlValue[] })[]} ops
 * @returns {Promise<import('@quereus/quereus').BackingRowChange[]>}
 */
export async function applyPeerRowBatch(db, table, ops) {
	if (!PUBLIC_SUBSCRIBED_TABLES.includes(table)) {
		throw new PeerReplicationError(
			table,
			'table is outside PUBLIC_SUBSCRIBED_TABLES -- the allowlist bounds what may be WRITTEN, not only what may be announced',
		);
	}

	const module = resolvePublicStoreModule(db);
	const schemaName = db.schemaManager.getCurrentSchemaName();
	const storeTable = module.getTableForExternalWrite(db, schemaName, table);
	if (!storeTable) {
		throw new PeerReplicationError(table, 'the store module has no externally-writable table under this name');
	}

	/** @type {import('@quereus/quereus').BackingRowChange[]} */
	const allChanges = [];
	const rows = Array.isArray(ops) ? ops : [];
	for (let start = 0; start < rows.length; start += PEER_ROW_BATCH_ROWS) {
		const chunk = rows.slice(start, start + PEER_ROW_BATCH_ROWS);
		const changes = await storeTable.applyExternalRowChanges(chunk);
		allChanges.push(...changes);
	}

	if (allChanges.length > 0) {
		// Same options `snapshot-restore.js` uses, and right here for the same
		// reason: the public app registers no `Database.watch` watcher, and
		// this seam emits no data events under either setting -- `captureChanges`
		// is what makes commit-time global assertions fire over the inbound
		// batch, re-introducing exactly the validation this seam bypasses, and
		// the origin's cascade effects (if any) are already IN the replicated
		// batch, so re-running them would double-apply.
		await db.ingestExternalRowChanges(
			allChanges.map((change) => ({ schemaName, tableName: table, change })),
			{ captureChanges: false, applyForeignKeyActions: false },
		);
	}

	return allChanges;
}

/**
 * Resolve `node.reactivityWatch`, the node's collection watch service. It is present exactly when the
 * node was built with `cohortTopic.enabled` (`@optimystic/db-p2p` `optimystic-node.d.ts`); a missing
 * one is a node-construction defect and must surface HERE as a named error, never as a page that
 * quietly never updates.
 * @param {any} node
 * @returns {import('@optimystic/db-p2p').ReactivityCollectionWatch}
 */
export function resolveWatchService(node) {
	const watch = node ? node.reactivityWatch : undefined;
	if (!watch || typeof watch.watch !== 'function') {
		throw new PeerReplicationError('reactivityWatch', 'node.reactivityWatch is absent -- the node was not built with cohortTopic.enabled');
	}
	return watch;
}

/**
 * @typedef {object} PeerRowBatch
 * @property {string} table
 * @property {readonly ({ op: 'upsert', row: import('@quereus/quereus').SqlValue[] } | { op: 'delete', pk: import('@quereus/quereus').SqlValue[] })[]} ops
 */

/**
 * @typedef {object} WatchedCollection
 * @property {string} table - a member of `PUBLIC_SUBSCRIBED_TABLES`
 * @property {string} collectionId - the table's collection id exactly as its blocks carry it
 */

/**
 * @typedef {object} StartPeerReplicationOptions
 * @property {import('@quereus/quereus').Database} db - the handle the UI reads. RECEIVED, never constructed here.
 * @property {string} networkHash
 * @property {any} node - a running `OptimysticNode`; only its `reactivityWatch` attachment is read.
 * @property {ReadonlyArray<WatchedCollection>} collections - one entry per watched table; at least one.
 * @property {import('@optimystic/db-p2p').CollectionTailReader} tails - the page's one tail reader (`tail-reader.js`).
 * @property {() => Promise<ReadonlyArray<PeerRowBatch>>} readRows
 *   REQUIRED. No default, no stub, no static variant -- see the module header.
 */

/**
 * @typedef {object} PeerReplicationHandle
 * @property {() => Promise<void>} stop idempotent; closes every watch. A run in progress finishes; no run starts after.
 * @property {() => Promise<void>} whenIdle resolves once no run is in progress or pending.
 */

/**
 * Watch every collection in `options.collections` through `node.reactivityWatch`, and on any wake
 * re-read and apply the public tables into the injected `db`. Every required option throws
 * `PeerReplicationError` naming the option when missing -- there is no partial start. Returns at once:
 * the watch service registers with the cohort, and retries, in the background.
 * @param {StartPeerReplicationOptions} options
 * @returns {PeerReplicationHandle}
 */
export function startPeerReplication(options) {
	if (!options || typeof options !== 'object') {
		throw new PeerReplicationError('options', 'startPeerReplication: an options object is required');
	}
	const { db, networkHash, node, collections, tails, readRows } = options;

	if (!db) throw new PeerReplicationError('db', 'startPeerReplication: db is required -- the bridge receives its handle, it never constructs one');
	if (!networkHash) throw new PeerReplicationError('networkHash', 'startPeerReplication: networkHash is required');
	if (!node) throw new PeerReplicationError('node', 'startPeerReplication: node is required');
	if (!Array.isArray(collections) || collections.length === 0) {
		throw new PeerReplicationError('collections', 'startPeerReplication: at least one collection to watch is required');
	}
	if (!tails || typeof tails.readTails !== 'function') {
		throw new PeerReplicationError('tails', 'startPeerReplication: tails (a CollectionTailReader) is required');
	}
	if (typeof readRows !== 'function') {
		// No default, no in-module stub, no "static for now" fallback -- see
		// the module header. A silently-replicating-nothing bridge is the exact
		// failure this module exists to prevent.
		throw new PeerReplicationError('readRows', 'startPeerReplication: readRows is required and has no default');
	}
	for (const entry of collections) {
		if (!entry || !PUBLIC_SUBSCRIBED_TABLES.includes(entry.table)) {
			throw new PeerReplicationError(String(entry?.table), 'startPeerReplication: a watched table must be in PUBLIC_SUBSCRIBED_TABLES');
		}
		if (typeof entry.collectionId !== 'string' || entry.collectionId.length === 0) {
			throw new PeerReplicationError(entry.table, 'startPeerReplication: the table has no collectionId');
		}
	}

	const watchService = resolveWatchService(node);

	/**
	 * One replication pass. Reads top to bottom: `readRows` once -> apply each
	 * returned batch -> collect the DISTINCT `(table, op)` pairs from the
	 * RETURNED EFFECTIVE changes (never from the ops submitted, so a
	 * value-identical replay announces nothing) -> one `notifyPeerWrite` call
	 * per distinct pair.
	 * @returns {Promise<void>}
	 */
	async function replicateOnce() {
		try {
			const batches = await readRows();

			/** @type {Map<string, { table: string, op: string }>} */
			const distinctPairs = new Map();
			for (const batch of Array.isArray(batches) ? batches : []) {
				if (!batch || typeof batch.table !== 'string') continue;
				const changes = await applyPeerRowBatch(db, batch.table, batch.ops);
				for (const change of changes) {
					const key = `${batch.table}:${change.op}`;
					if (!distinctPairs.has(key)) distinctPairs.set(key, { table: batch.table, op: change.op });
				}
			}

			// Driven by the RETURNED EFFECTIVE changes, never by the ops that were
			// submitted -- T-56-09-05. The single `notifyPeerWrite(...)` call below
			// is one complete statement on one line with no other work on that
			// line, so `56-13`'s source-transform inversion (Task 3) can delete
			// exactly it and nothing else. It is deliberately not behind a flag,
			// an option or an injected collaborator -- see
			// `project_esbuild_minifier_defeats_naive_dist_controls`.
			for (const { table, op } of distinctPairs.values()) {
				notifyPeerWrite(db, networkHash, table, op);
			}
		} catch (err) {
			// A throwing readRows, or a refused/failed batch: log the NAME only,
			// fire no notice for this pass, and keep watching for the next wake.
			logFailure(err);
		}
	}

	let stopped = false;
	/** @type {Promise<void> | null} */
	let running = null;
	let again = false;

	/** Fold wakes: one run at a time, and one more after it however many wakes arrived meanwhile. */
	const wake = () => {
		if (stopped) return;
		if (running) {
			again = true;
			return;
		}
		running = (async () => {
			do {
				again = false;
				await replicateOnce();
			} while (again && !stopped);
		})().finally(() => {
			running = null;
		});
	};

	// Open each watch BEFORE any read it keeps fresh (the watch service's own rule): the service wakes
	// every watcher once on its first committed-tail read, and that wake is this page's first pass.
	/** @type {import('@optimystic/db-p2p').CollectionWatchHandle[]} */
	const handles = collections.map(({ collectionId }) => watchService.watch({ collectionId, tails, onChange: wake }));

	/** Idempotent; never throws. @returns {Promise<void>} */
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await Promise.all(handles.map((handle) => handle.close().catch(logFailure)));
	};

	/** @returns {Promise<void>} */
	const whenIdle = async () => {
		while (running) await running;
	};

	return { stop, whenIdle };
}
