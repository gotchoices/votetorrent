/**
 * reactivity-bridge.js -- the officer dashboard's replication: a wake from the strand's collection
 * watches -> a full re-read of every replicated officer table through the strand reader -> the rows
 * applied into the ONE local store handle the dashboard reads -> one change notice per changed
 * (table, kind). The officer copy of the Public page's bridge, restated here for this setting.
 *
 * 1. THE SEAM THAT EXISTS FOR EXACTLY THIS. `applyExternalRowChanges` is the store's documented path
 *    for trusted replication-style writes, and it runs no constraint validation. SQL DML is not an
 *    alternative: the schema's signature-gated insert checks, its signing-context columns and its
 *    expiry checks on historical rows would all refuse a row this browser never signed and has no
 *    signing context for. A replicated officer row is exactly that shape.
 *
 * 2. WHY THE TRUST POSTURE HOLDS. The rows applied here are never taken from what woke the bridge.
 *    Every wake (a cohort notification, a landing in the strand node's storage, the watch service's
 *    tick, or this module's quiet tick) leads to the same re-read of every table through the member
 *    node's own strand database, whose resolved transactor the reader asserts is 'network'. The rows
 *    have one provenance whatever woke the page: the cohort's committed blocks. A false wake costs one
 *    extra read and nothing else, because a value-identical re-apply reports no change. What this does
 *    NOT buy: nothing on this path re-runs a CHECK, UNIQUE or FK constraint (accepted residual,
 *    T-66-13-08; the rows were checked by consensus when written).
 *
 * 3. THE STANDING RULE AND ITS BOUNDARY. "Write through vote-engine, never the raw handle" governs
 *    authority actions, writes that represent someone doing something. A replication represents
 *    nobody doing anything on this device; it re-materialises rows the strand already committed. The
 *    browser holds no authority key and makes no authority write.
 *
 * 4. THIS MODULE OWNS THE DATA EVENTS. The ingest seam on the Database emits no module data events;
 *    the external writer owns them. The single `notifyOfficerPeerWrite(...)` line below is that
 *    ownership discharged, and the only place in this flow a change notice is raised.
 *
 * THIRD SEAM SITE. This is the third production site of the external-write seam in this repo. The
 * other two are the Public page's `src/peer/reactivity-bridge.js` and this app's
 * `src/lifecycle/snapshot-restore.js`. A third is correct now because the officer dashboard's member
 * device replicates its tables the same way the Public page does. The snapshot restore leaves when the
 * snapshot path is retired, which takes the pin back to two. All sites are pinned by set equality in
 * the Public app's `test/node/external-write-seam-sites.test.mjs`.
 *
 * ONE HANDLE, RECEIVED NEVER CONSTRUCTED. The local store's routing trap means a second opener call
 * would give a differently-routed handle whose writes the panels never see. So `db` is a REQUIRED
 * option: this module never opens, attaches or builds a store handle, and never wipes one. A failed
 * pass leaves the local copy exactly as readable as it was.
 *
 * ONE RUN AT A TIME. A pass re-reads the whole table list, so a wake from any collection is a wake
 * for all. Wakes are folded: a burst of wakes in one turn starts one pass, and any number of wakes
 * during a pass cause exactly one more pass after it.
 *
 * WHY A QUIET TICK. The watch service wakes the bridge only when a tail changed. The status reducer
 * (`src/live/status.js`) shows Live only while a pass COMPLETES at least every 40 s. On a quiet strand
 * no tail changes, so without a tick Live would decay to "Catching up" with nothing wrong. The bridge
 * therefore runs a pass at most 20 s after the previous one ended, wake or not.
 *
 * THE STRAND NODE, NOT THE IDENTITY. The member node has two libp2p peers: the identity (control)
 * node and the per-strand node. The tail reader's "self" and every collection watch belong to the
 * STRAND node. When the caller passes `strandPeerId`, the bridge refuses a strand node whose peer id
 * differs (an identity id passed by mistake), and the network name must be the strand's protocol
 * name, `strand-<id>` (a bare hash is refused).
 *
 * NOTICES. They come from the EFFECTIVE change kinds the store returns (insert, update, delete), never
 * from the submitted op kind, and go out once per distinct (table, kind) per pass. A value-identical
 * pass sends none.
 *
 * PASS EVENTS. `onPass` receives `pass-start`, then `pass-complete` (with `at`, the end of the pass in
 * epoch ms: "last update" means the end of the last completed pass) or `pass-failed` (the error NAME
 * only). They are the inputs of `src/live/status.js`.
 *
 * `afterPass` runs inside the pass loop after each COMPLETED pass, never after a failed one, so it
 * must never await `whenIdle()` (that would wait for itself). It may call `stop()`.
 *
 * ERROR HYGIENE. Logs are a fixed prefix plus an error's name. Errors carry a subject (a table, an
 * option or a module name), never a row value.
 */

import {
	OFFICER_SUBSCRIBED_TABLES,
	PAIRING_TABLES,
	ADMIN_PANEL_AND_GATE_TABLES,
	OFFICER_CHANGE_OPS,
	STORE_MODULE_NAME,
	notifyOfficerPeerWrite as realNotify,
} from '@votetorrent/web-data/officer';
import { createPageTailReader } from './tail-reader.js';
import { collectionIdForTable } from './collection-id.js';
import { STRAND_READ_ROW_LIMIT } from './strand-read.js';

/** The one prefix every log line in this module carries. */
const LOG_PREFIX = 'peer/reactivity-bridge:';

/**
 * Chunk size for the external-write batches: bounds peak memory for a large table.
 * @type {500}
 */
export const PEER_ROW_BATCH_ROWS = 500;

/**
 * The longest gap between the end of one pass and the start of the next, wake or not. Twice this
 * stays inside the status reducer's 40 s Live window, and it equals its background retry interval.
 * @type {20000}
 */
export const QUIET_PASS_INTERVAL_MS = 20_000;

/**
 * The tables the dashboard replicates: every officer table (the same frozen reference web-data
 * derives). It includes every advisory-gate and pairing table (D-12).
 * @type {ReadonlyArray<string>}
 */
export const OFFICER_REPLICATION_TABLES = OFFICER_SUBSCRIBED_TABLES;

/** A replication failure naming a table, an option or a module, never a row value. */
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
 * @param {unknown} err
 * @returns {string}
 */
function nameOf(err) {
	return err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
}

/**
 * The error's name and nothing else.
 * @param {unknown} err
 * @returns {void}
 */
function logFailure(err) {
	console.error(LOG_PREFIX, nameOf(err));
}

/**
 * The module registered under `STORE_MODULE_NAME` that exposes `getTableForExternalWrite`, directly
 * or through an isolation wrapper's `underlying`. Throws naming `STORE_MODULE_NAME` otherwise: the
 * handle was built without the mandatory store routing.
 * @param {any} db
 * @returns {{ getTableForExternalWrite(db: any, schemaName: string, tableName: string): (undefined | { applyExternalRowChanges(ops: readonly any[]): Promise<any[]> }) }}
 */
export function resolveOfficerStoreModule(db) {
	const registered = db?.schemaManager?.getModule?.(STORE_MODULE_NAME);
	const candidate = /** @type {any} */ (registered?.module);
	if (candidate && typeof candidate.getTableForExternalWrite === 'function') return candidate;
	const underlying = candidate?.underlying;
	if (underlying && typeof underlying.getTableForExternalWrite === 'function') return underlying;
	throw new PeerReplicationError(
		STORE_MODULE_NAME,
		'no externally writable store module is registered under this name (directly or through an isolation wrapper)',
	);
}

/**
 * The strand node's collection watch service. Present exactly when the node was built with the
 * cohort topic enabled; a missing one is a node-construction defect, named here.
 * @param {any} node
 * @returns {any}
 */
export function resolveWatchService(node) {
	const watch = node ? node.reactivityWatch : undefined;
	if (!watch || typeof watch.watch !== 'function') {
		throw new PeerReplicationError('reactivityWatch', 'node.reactivityWatch is absent: the node was not built with the cohort topic enabled');
	}
	return watch;
}

/**
 * The local copy's primary keys for one table, each an array in PK-definition order.
 * Bounded by `STRAND_READ_ROW_LIMIT` (throws, never truncates).
 * @param {any} db
 * @param {string} table
 * @returns {Promise<any[][]>}
 */
export async function readLocalPrimaryKeys(db, table) {
	if (typeof table !== 'string' || !OFFICER_SUBSCRIBED_TABLES.includes(table)) {
		throw new PeerReplicationError(String(table), 'the table is outside OFFICER_SUBSCRIBED_TABLES');
	}
	const schema = db.schemaManager.getTable(db.schemaManager.getCurrentSchemaName(), table);
	if (!schema) throw new PeerReplicationError(table, 'the local schema declares no such table');
	/** @type {string[]} */
	const pkNames = schema.primaryKeyDefinition.map((/** @type {{ index: number }} */ d) => schema.columns[d.index].name);
	// Identifiers only: the table passed the allowlist check, the columns come from the schema. A table
	// with an empty key (a singleton) selects a constant, and each row's key is the empty array.
	const selectList = pkNames.length > 0 ? pkNames.join(', ') : '1 as present';

	/** @type {any[][]} */
	const keys = [];
	try {
		for await (const row of db.eval(`select ${selectList} from ${table}`)) {
			keys.push(pkNames.map((name) => /** @type {any} */ (row)[name]));
			if (keys.length > STRAND_READ_ROW_LIMIT) {
				throw new PeerReplicationError(table, `the local key read exceeded STRAND_READ_ROW_LIMIT (${STRAND_READ_ROW_LIMIT}), refusing to truncate`);
			}
		}
	} catch (err) {
		if (err instanceof PeerReplicationError) throw err;
		throw new PeerReplicationError(table, `the local key read failed (${nameOf(err)})`);
	}
	return keys;
}

/**
 * Apply one replicated batch to `db` through the trusted-replication seam, in chunks.
 *
 * The allowlist gate runs FIRST: a table outside `OFFICER_SUBSCRIBED_TABLES`, or outside this run's
 * `allowed` list, is refused WHOLE with zero rows applied. Returns the EFFECTIVE changes the store
 * reported, never the submitted ops.
 *
 * @param {any} db
 * @param {string} table
 * @param {readonly any[]} ops
 * @param {ReadonlyArray<string>} [allowed]
 * @returns {Promise<any[]>}
 */
export async function applyOfficerRowBatch(db, table, ops, allowed = OFFICER_SUBSCRIBED_TABLES) {
	if (typeof table !== 'string' || !OFFICER_SUBSCRIBED_TABLES.includes(table) || !allowed.includes(table)) {
		throw new PeerReplicationError(String(table), 'the table is outside the replicated allowlist: the allowlist bounds what may be written');
	}

	const module = resolveOfficerStoreModule(db);
	const schemaName = db.schemaManager.getCurrentSchemaName();
	const storeTable = module.getTableForExternalWrite(db, schemaName, table);
	if (!storeTable) throw new PeerReplicationError(table, 'the store module has no externally writable table under this name');

	/** @type {any[]} */
	const allChanges = [];
	const rows = Array.isArray(ops) ? ops : [];
	for (let start = 0; start < rows.length; start += PEER_ROW_BATCH_ROWS) {
		const changes = await storeTable.applyExternalRowChanges(rows.slice(start, start + PEER_ROW_BATCH_ROWS));
		allChanges.push(...changes);
	}

	if (allChanges.length > 0) {
		// No module data events, no commit-time assertions over the inbound rows and no re-run of
		// cascade effects (they are already in the replicated rows): the same options the snapshot
		// restore and the Public bridge use.
		await db.ingestExternalRowChanges(
			allChanges.map((change) => ({ schemaName, tableName: table, change })),
			{ captureChanges: false, applyForeignKeyActions: false },
		);
	}
	return allChanges;
}

/**
 * @typedef {{ type: 'pass-start' }
 *   | { type: 'pass-complete', at: number, changedTables: ReadonlyArray<string>, changes: ReadonlyArray<{ table: string, op: string }> }
 *   | { type: 'pass-failed', name: string, changedTables: ReadonlyArray<string> }} PassEvent
 */

/**
 * @typedef {object} OfficerReplicationDeps
 * @property {(strandNode: any, networkName: string) => any} [createTailReader]
 * @property {(fn: () => void, ms: number) => any} [setTimeout]
 * @property {(handle: any) => void} [clearTimeout]
 * @property {() => number} [now]
 * @property {(db: any, networkHash: string, table: string, op: string) => boolean} [notifyOfficerPeerWrite]
 */

/**
 * @typedef {object} StartOfficerReplicationOptions
 * @property {any} db - the local store handle the panels read. RECEIVED, never constructed here.
 * @property {string} networkHash
 * @property {{ readRows: (table: string, localPks: any[][], opts: { uiDb: any }) => Promise<ReadonlyArray<any>> }} strandReader
 * @property {any} strandNode - the member node's strand libp2p node (it carries `reactivityWatch`)
 * @property {string} networkName - `strand-<strandId>`
 * @property {ReadonlyArray<string>} tables
 * @property {(event: PassEvent) => void} onPass
 * @property {(info: { at: number, changedTables: ReadonlyArray<string> }) => (void | Promise<void>)} [afterPass]
 * @property {string} [strandPeerId]
 * @property {OfficerReplicationDeps} [deps]
 */

/**
 * @typedef {object} OfficerReplicationHandle
 * @property {() => Promise<void>} stop - idempotent; closes every watch and the quiet timer. No pass starts after it.
 * @property {() => Promise<void>} whenIdle - resolves once no pass is running or queued.
 * @property {() => void} wake - asks for a pass (folded).
 */

/**
 * Watch every replicated table's collection on the strand node and, on any wake or the quiet tick,
 * re-read and apply every table into `db`. Every option error throws `PeerReplicationError` naming
 * the option, and nothing is watched on a refusal. Returns at once.
 *
 * @param {StartOfficerReplicationOptions} options
 * @returns {OfficerReplicationHandle}
 */
export function startOfficerReplication(options) {
	if (!options || typeof options !== 'object') {
		throw new PeerReplicationError('options', 'an options object is required');
	}
	const { db, networkHash, strandReader, strandNode, networkName, tables, onPass, afterPass, strandPeerId, deps } = options;

	if (!db) throw new PeerReplicationError('db', 'db is required: the bridge receives its handle and never constructs one');
	if (typeof networkHash !== 'string' || networkHash.length === 0) {
		throw new PeerReplicationError('networkHash', 'networkHash must be a non-empty string');
	}
	if (!strandReader || typeof strandReader.readRows !== 'function') {
		throw new PeerReplicationError('strandReader', 'a strand reader with readRows is required');
	}
	if (!strandNode || typeof strandNode !== 'object') {
		throw new PeerReplicationError('strandNode', 'the strand libp2p node is required');
	}
	if (typeof networkName !== 'string' || !networkName.startsWith('strand-') || networkName.length <= 'strand-'.length) {
		throw new PeerReplicationError('networkName', 'networkName must be the strand network name, strand-<id>');
	}
	if (!Array.isArray(tables) || tables.length === 0) {
		throw new PeerReplicationError('tables', 'at least one table is required');
	}
	for (const table of tables) {
		if (typeof table !== 'string' || !OFFICER_SUBSCRIBED_TABLES.includes(table)) {
			throw new PeerReplicationError('tables', 'every table must be a member of OFFICER_SUBSCRIBED_TABLES');
		}
	}
	const missing = [...PAIRING_TABLES, ...ADMIN_PANEL_AND_GATE_TABLES].find((t) => !tables.includes(t));
	if (missing !== undefined) {
		throw new PeerReplicationError('tables', `the list omits a pairing or admin/gate table, ${missing} (D-12)`);
	}
	if (typeof onPass !== 'function') throw new PeerReplicationError('onPass', 'onPass must be a function');
	if (afterPass !== undefined && typeof afterPass !== 'function') {
		throw new PeerReplicationError('afterPass', 'afterPass must be a function when given');
	}

	// Fail fast on a handle without the store routing.
	resolveOfficerStoreModule(db);

	if (strandPeerId !== undefined) {
		let actual;
		try {
			actual = strandNode.peerId?.toString();
		} catch {
			actual = undefined;
		}
		if (typeof strandPeerId !== 'string' || strandPeerId !== actual) {
			throw new PeerReplicationError('strandNode', 'the node is not the strand node (its peer id differs from strandPeerId)');
		}
	}

	const watchService = resolveWatchService(strandNode);

	const createTailReader = deps?.createTailReader ?? createPageTailReader;
	const timers = {
		setTimeout: deps?.setTimeout ?? ((/** @type {() => void} */ fn, /** @type {number} */ ms) => globalThis.setTimeout(fn, ms)),
		clearTimeout: deps?.clearTimeout ?? ((/** @type {any} */ handle) => globalThis.clearTimeout(handle)),
	};
	const now = deps?.now ?? Date.now;
	const notifyOfficerPeerWrite = deps?.notifyOfficerPeerWrite ?? realNotify;

	let tails;
	try {
		tails = createTailReader(strandNode, networkName);
	} catch (err) {
		throw new PeerReplicationError('strandNode', `the tail reader could not be built (${nameOf(err)})`);
	}

	/** @type {ReadonlyArray<string>} */
	const runTables = Object.freeze([...new Set(tables)].sort());

	/** @param {PassEvent} event */
	function emit(event) {
		try {
			const result = /** @type {any} */ (onPass(event));
			if (result && typeof result.then === 'function') result.then(undefined, logFailure);
		} catch (err) {
			logFailure(err);
		}
	}

	/**
	 * One pass: for each table, the local keys, the strand rows, the batch applied; then one notice
	 * per distinct effective (table, kind); then the pass event.
	 * @returns {Promise<void>}
	 */
	async function replicateOnce() {
		emit({ type: 'pass-start' });

		/** @type {Set<string>} */
		const changed = new Set();
		/** @type {Map<string, { table: string, op: string }>} */
		const distinctPairs = new Map();
		/** @type {unknown} */
		let failure = null;
		let failed = false;

		try {
			for (const table of runTables) {
				const localPks = await readLocalPrimaryKeys(db, table);
				const ops = await strandReader.readRows(table, localPks, { uiDb: db });
				if (!Array.isArray(ops)) throw new PeerReplicationError(table, 'the strand reader returned no op list');
				if (ops.length === 0) continue;
				const changes = await applyOfficerRowBatch(db, table, ops, runTables);
				for (const change of changes) {
					changed.add(table);
					const op = change?.op;
					// Any other kind is a store defect: the table still counts as changed, but no notice names it.
					if (typeof op === 'string' && OFFICER_CHANGE_OPS.includes(op)) {
						const key = `${table}:${op}`;
						if (!distinctPairs.has(key)) distinctPairs.set(key, { table, op });
					}
				}
			}
		} catch (err) {
			failed = true;
			failure = err;
		}

		// Rows applied before a failure stay applied, so their notices go out too. The call below is
		// one self-contained line, once per distinct effective (table, kind) of this pass.
		try {
			for (const { table, op } of distinctPairs.values()) {
				notifyOfficerPeerWrite(db, networkHash, table, op);
			}
		} catch (err) {
			logFailure(err);
		}

		const changedTables = Object.freeze([...changed].sort());

		if (failed) {
			logFailure(failure);
			emit({ type: 'pass-failed', name: nameOf(failure), changedTables });
			return;
		}

		const changes = Object.freeze(
			[...distinctPairs.values()]
				.sort((a, b) => (a.table === b.table ? (a.op < b.op ? -1 : a.op > b.op ? 1 : 0) : a.table < b.table ? -1 : 1))
				.map((pair) => Object.freeze({ table: pair.table, op: pair.op })),
		);
		const at = now();
		emit({ type: 'pass-complete', at, changedTables, changes });

		if (afterPass) {
			try {
				await afterPass({ at, changedTables });
			} catch (err) {
				logFailure(err);
			}
		}
	}

	let stopped = false;
	/** @type {Promise<void> | null} */
	let running = null;
	let again = false;
	/** @type {any} */
	let timer = null;

	function rearmQuietTimer() {
		if (timer !== null) timers.clearTimeout(timer);
		timer = null;
		if (stopped) return;
		timer = timers.setTimeout(wake, QUIET_PASS_INTERVAL_MS);
	}

	/** Fold wakes: one pass at a time, and one more after it however many wakes arrived meanwhile. */
	function wake() {
		if (stopped) return;
		if (running) {
			again = true;
			return;
		}
		running = (async () => {
			// One turn's yield folds a synchronous burst of wakes (every watch firing on the same
			// tail read) into this pass.
			await Promise.resolve();
			while (!stopped) {
				again = false;
				await replicateOnce();
				rearmQuietTimer();
				if (!again) break;
			}
		})().finally(() => {
			running = null;
		});
	}

	// Open every watch BEFORE any read it keeps fresh: the service wakes each watcher on its first
	// committed-tail read, and that wake is the first pass.
	/** @type {any[]} */
	const handles = [];
	try {
		for (const table of runTables) {
			handles.push(watchService.watch({ collectionId: collectionIdForTable(table), tails, onChange: wake }));
		}
	} catch (err) {
		for (const handle of handles) {
			Promise.resolve()
				.then(() => handle?.close())
				.catch(logFailure);
		}
		throw new PeerReplicationError('reactivityWatch', `a collection watch could not be opened (${nameOf(err)})`);
	}

	rearmQuietTimer();

	/** Idempotent; never throws. A pass in progress finishes; none starts after. */
	async function stop() {
		if (stopped) return;
		stopped = true;
		if (timer !== null) timers.clearTimeout(timer);
		timer = null;
		const results = await Promise.allSettled(handles.map((handle) => Promise.resolve().then(() => handle?.close())));
		for (const result of results) {
			if (result.status === 'rejected') logFailure(result.reason);
		}
	}

	async function whenIdle() {
		while (running) await running;
	}

	return Object.freeze({ stop, whenIdle, wake });
}
