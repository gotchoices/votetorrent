/**
 * Per-network IndexedDB-backed Quereus handle factory — the dashboard's browser
 * analog of `apps/VoteTorrentAuthority/src/engines/rn-db-factory.ts` (the proven
 * RN/LevelDB factory). This is the dashboard's ONLY place that constructs a
 * `Database`.
 *
 * The load-bearing call is `db.setDefaultVtabName(STORE_MODULE_NAME)`:
 * `VOTETORRENT_SCHEMA_SQL` has ZERO `using` clauses (grep-confirmed: 0 matches
 * in `packages/vote-core/schema/votetorrent.qsql`), so without it Quereus routes
 * every table to the in-memory module and persistence silently becomes a no-op
 * that still passes every same-session assertion — schema applies, seed
 * succeeds, every read returns correct data, and nothing was ever written. The
 * only mechanism in this phase that can catch that trap is the tier-2 two-page
 * gate, `test/browser/run-headless.mjs`, which carries a baked-in `--prove-trap`
 * mode that deliberately omits this call and requires the run to fail.
 *
 * Import-cycle note: `deleteNetworkDb` below also needs to clear the contract-C5
 * row-count record that `./reattach.js` owns. `./reattach.js` imports
 * `openStoreHandle`/`dbNameFor` FROM this file, so a static top-level import of
 * `./reattach.js` here would form a cycle. This file resolves it with a lazy
 * `await import('./reattach.js')` inside `deleteNetworkDb`, not with an injected
 * option — the row-count clear is not optional or swappable per call site the
 * way `options.db` is, so an injected parameter would just move the same
 * dependency to every caller instead of removing it. WHICH STORAGE that clear
 * writes to IS per-call-site, though, and arrives as `options.storage`; see
 * `deleteNetworkDb`'s own note.
 */

import { Database, registerPlugin } from '@quereus/quereus';
import indexeddbPlugin from '@quereus/plugin-indexeddb/plugin';
import { registerDbPlugins, prepareDb } from '@votetorrent/vote-engine/browser';

/**
 * The frozen store-module routing name. Every reference to the IndexedDB vtab
 * module — in this file and in `reattach.js` — uses this constant, so the
 * routing name exists in exactly one place.
 * @type {'store'}
 */
export const STORE_MODULE_NAME = 'store';

/** @type {'votetorrent-'} */
export const DB_NAME_PREFIX = 'votetorrent-';

/**
 * The per-network IndexedDB database name. Outline contract 3: no `q2` prefix
 * (that prefix exists in `rn-db-factory.ts` only to break from a legacy RN
 * store layout the dashboard never had) — one IndexedDB database IS one
 * network (D-07/D-08).
 *
 * @param {string} networkHash
 * @returns {string}
 */
export function dbNameFor(networkHash) {
	if (typeof networkHash !== 'string' || networkHash.length === 0) {
		throw new TypeError(
			`dbNameFor: networkHash must be a non-empty string, got ${JSON.stringify(networkHash)}`,
		);
	}
	return `${DB_NAME_PREFIX}${networkHash}`;
}

/**
 * Open a raw, routed Quereus `Database` handle for a network: register the
 * IndexedDB store module and apply the mandatory default-vtab routing. This
 * function registers NO crypto plugin, NO UDFs and applies NO DDL — it is the
 * raw handle both `createNetworkDb` (this file) and `attachNetworkDb`
 * (`./reattach.js`) build on, which is what keeps the mandatory call in one
 * place instead of two.
 *
 * No try/catch, no fallback: an open error propagates. A dashboard that
 * silently substitutes an in-memory database is exactly the failure mode this
 * file exists to prevent (mirrors `rn-db-factory.ts`'s D-13 discipline).
 *
 * @param {string} networkHash
 * @returns {Promise<import('@quereus/quereus').Database>}
 */
export async function openStoreHandle(networkHash) {
	const db = new Database();
	await registerPlugin(db, indexeddbPlugin, {
		databaseName: dbNameFor(networkHash),
		moduleName: STORE_MODULE_NAME,
		isolation: true,
	});

	// MANDATORY — see file header. VOTETORRENT_SCHEMA_SQL has zero `using`
	// clauses, so without this call every table this handle ever declares
	// routes to the in-memory module instead of the IndexedDB-backed store
	// module just registered above, and persistence becomes a silent no-op.
	// The argument is written as the literal 'store' (equal to
	// STORE_MODULE_NAME above) rather than the constant reference, so this
	// single mandatory call stays mechanically grep-provable by both the
	// tier-1 source assertion — a cross-workspace one since 54-03a moved this
	// file: `apps/VoteTorrentDashboard/test/node/db-delete.test.mjs`, the
	// consumer-side proof that the mandatory call is present in the module
	// the dashboard actually resolves — and the tier-2 gate's trap-proof mode.
	db.setDefaultVtabName('store');

	return db;
}

/**
 * First-bootstrap path only: open a routed handle and apply the schema,
 * registering the crypto plugin and UDFs and marking the store initialized.
 * Called by 50-08 after its snapshot verification passes. A reload goes
 * through `attachNetworkDb` in `./reattach.js`, not this function — calling
 * both `registerDbPlugins` and `prepareDb` (which itself calls
 * `registerDbPlugins`) on one handle would register the same UDFs twice.
 *
 * @param {string} networkHash
 * @returns {Promise<import('@quereus/quereus').Database>}
 */
export async function createNetworkDb(networkHash) {
	const db = await openStoreHandle(networkHash);
	await prepareDb(db);
	return db;
}

/**
 * Close a handle, tolerating an already-closed one. Quereus's own `close()`
 * already no-ops when the handle is not open (`if (!this.isOpen) return;`),
 * so no extra try/catch is needed here — this wrapper exists so callers never
 * have to special-case a possibly-`undefined`/already-closed `db`.
 *
 * Needed because `indexedDB.deleteDatabase` blocks while a connection to the
 * same database name is open.
 *
 * @param {import('@quereus/quereus').Database | undefined | null} db
 * @returns {Promise<void>}
 */
export async function closeNetworkDb(db) {
	if (!db) return;
	await db.close();
}

/**
 * The observable signature of correct store routing: the raw IndexedDB object
 * store names for a network's database, read directly via the global
 * `indexedDB.open` (not through Quereus). Spike 076 measured 76 stores = 54
 * tables + 13 index stores + `__catalog__` + `__stats__`. Both the tier-1 node
 * suite and the tier-2 browser gate use this.
 *
 * A PROBE MUST NOT CREATE WHAT IT PROBES. `indexedDB.open(name)` with no
 * version CREATES the database when it does not exist: per the WHATWG
 * IndexedDB spec's "opening a database" steps
 * (https://www.w3.org/TR/IndexedDB/#opening — "if db was not found ... let db
 * be a new database" — mirrored by MDN's `IDBFactory.open()` docs, "if the
 * database does not exist ... it is created"), an omitted `version` argument
 * does not exempt this: the algorithm creates the database record first and
 * only then resolves the requested version against it. This function is
 * exported from `src/`, so calling it for a network that was deleted, or was
 * never bootstrapped, used to resurrect an empty shell that then showed up in
 * `indexedDB.databases()` — precisely the condition `deleteNetworkDb`'s
 * post-delete confirmation and `assertNetworkForgotten` both treat as a hard
 * failure. The existence check below is what makes an absent database read as
 * "no stores" instead of "no stores, and now it exists" — it is LOAD-BEARING,
 * not an optimisation, because both of those callers ask this question
 * specifically about databases that are supposed to be gone.
 *
 * Absent `indexedDB.databases()` (a handful of older browsers, some test
 * doubles) is non-fatal and falls through to the open — the same posture
 * `deleteNetworkDb` and `assertNetworkForgotten` already take.
 *
 * @param {string} networkHash
 * @returns {Promise<string[]>}
 */
export async function listObjectStores(networkHash) {
	const name = dbNameFor(networkHash);

	if (typeof indexedDB.databases === 'function') {
		const known = await indexedDB.databases();
		if (!known.some((entry) => entry.name === name)) {
			return [];
		}
	}

	return new Promise((resolve, reject) => {
		const request = indexedDB.open(name);
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const names = [...request.result.objectStoreNames];
			request.result.close();
			resolve(names);
		};
	});
}

/**
 * @typedef {object} DeleteNetworkDbOptions
 * @property {import('@quereus/quereus').Database} [db] - an already-open handle to close first
 * @property {number} [timeoutMs] - how long to wait out an `onblocked` delete before giving up (default 5000)
 * @property {import('./networks-registry.js').StorageAdapter} [storage] - which storage the
 *   row-count clear writes to. Omitting it falls back to `globalThis.localStorage`, which is
 *   correct in the browser and WRONG for any caller that injected an adapter.
 */

/**
 * The D-15 "forget this network" delete primitive (the forget-network UI
 * itself is 50-09's; this is only the mechanism it calls). Deletes the
 * network's IndexedDB database and its contract-C5 row-count record.
 *
 * This is the one place this file deliberately diverges from spike 076's
 * `deleteIdb()`, which resolves on `onblocked`. Copying that would make
 * "forget this network" report success while the officer's whole database —
 * registrant PII included — is still on the machine (T-50-05-01). A blocked
 * delete REJECTS by name (`DeleteBlockedError`) after `timeoutMs`, never
 * resolves.
 *
 * Idempotent: deleting a name that was never created resolves without error.
 *
 * @param {string} networkHash
 * @param {DeleteNetworkDbOptions} [options]
 * @returns {Promise<void>}
 */
export async function deleteNetworkDb(networkHash, options = {}) {
	const { db, timeoutMs = 5000, storage } = options;

	if (db) {
		await closeNetworkDb(db);
	}

	const name = dbNameFor(networkHash);

	await new Promise((resolve, reject) => {
		let settled = false;
		const request = indexedDB.deleteDatabase(name);

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			const err = new Error(
				`deleteNetworkDb: delete of "${name}" is still blocked after ${timeoutMs}ms — ` +
					'another tab or an unclosed handle is holding the database open',
			);
			err.name = 'DeleteBlockedError';
			reject(err);
		}, timeoutMs);

		request.onsuccess = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(undefined);
		};
		request.onerror = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(request.error ?? new Error(`deleteNetworkDb: failed to delete "${name}"`));
		};
		// Deliberately NOT resolved here — see the file header's divergence note.
		// onblocked means another connection still holds the database; we keep
		// waiting for a later success/error event until timeoutMs elapses.
		request.onblocked = () => {
			// no-op: wait for success/error or the timeout above.
		};
	});

	if (typeof indexedDB.databases === 'function') {
		const remaining = await indexedDB.databases();
		if (remaining.some((entry) => entry.name === name)) {
			const err = new Error(
				`deleteNetworkDb: "${name}" is still listed by indexedDB.databases() after a reported-successful delete`,
			);
			err.name = 'DeleteBlockedError';
			throw err;
		}
	}
	// indexedDB.databases() absence is non-fatal — just skip the confirmation.

	// THE CLEAR RUNS LAST, AND ONLY AFTER A CONFIRMED DELETE. It used to run
	// FIRST. If the delete then blocked or errored, this function threw —
	// correctly — but the integrity record was already gone: the network was
	// still listed (`forgetNetwork`'s registry removal never ran), its data
	// including registrant information was still on disk, and it was now
	// permanently un-attachable, because `attachNetworkDb` raises
	// `MissingRowCountsError` on every subsequent load. That is the opposite
	// of `forget-network.js`'s own stated rule — prefer the recoverable
	// inconsistency over the invisible one — so the ordering now matches it.
	//
	// `storage` is threaded through rather than defaulted here: called with no
	// adapter, `clearRowCounts` falls back to `globalThis.localStorage`, so
	// every caller that injected one silently failed to clear the record it
	// believed it had cleared.
	//
	// Lazy import — see the file-header import-cycle note.
	const { clearRowCounts } = await import('./reattach.js');
	await clearRowCounts(networkHash, storage);
}
