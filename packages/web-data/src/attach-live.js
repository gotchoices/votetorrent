/**
 * attach-live.js -- open a network's local IndexedDB store as a LIVE copy
 * (contract C-7).
 *
 * SHARED BY BOTH AUDIENCES since 56-26 (2026-11-13; moved here from
 * `src/officer/`). The Public page's own peer boot creates its UI store with
 * `create: true` only after the strand has returned the addressed election,
 * and its read path checks `hasLiveStore` before any open. A public visitor's
 * browser was never "bootstrapped" by anyone, so the snapshot-era attach
 * (`../reattach.js`: registry entry + marker + row-count record) could never
 * succeed for one. Only this file's open path is shared; the pairing, change
 * channel and registry helpers stay officer-only.
 *
 * WHY THIS EXISTS. The live dashboard's local copy is fed by the strand: every
 * completed replication pass inserts, updates and deletes rows. The
 * snapshot-era open path re-declares the schema, checks the schema-init marker
 * and then asserts an EXACT per-table row-count record (contract C5). A
 * peer-fed copy changes its counts on every pass, so that assertion would
 * refuse every live store (the Public page already hit the mismatch error on a
 * peer-fed copy). This module keeps the first two steps -- the schema
 * re-declare and the init-marker gate -- and drops the row-count step
 * entirely: it never reads, writes or asserts a row-count record.
 *
 * WHAT IS GIVEN UP. The row-count record also caught a truncated store or one
 * whose tables were dropped and re-created by a bad reconcile. For a live copy
 * the next completed pass re-reads every subscribed table and repairs it. The
 * header status (contract C-9) never says Live before a completed pass, so a
 * short copy is shown as "Catching up" or "Offline · last update", never as
 * Live.
 *
 * WHY `create: false` PROBES `indexedDB.databases()` FIRST. Opening a database
 * that does not exist creates it: a deleted or never-paired network would come
 * back as an empty shell and show up in `indexedDB.databases()` again. This
 * module must never be the thing that resurrects a forgotten network, so with
 * `create: false` it refuses an unlisted name BEFORE any open. When
 * `indexedDB.databases()` is not available (some older browsers and test
 * doubles) it falls through to the open -- the same posture `listObjectStores`
 * in `../open-db.js` takes. The browser-only case where a background write
 * re-creates a database after its delete is invisible to fake-indexeddb; it is
 * the forget flow's concern and the browser gate's to prove, not this module's.
 *
 * A store opened with `create: true` that already carries the init marker
 * adopts its persisted rows unchanged. This module NEVER wipes: a caller that
 * replaces a legacy or swapped store deletes it first. It does not read the
 * networks registry either; callers route legacy (snapshot-era) networks to
 * pairing before calling it, because a legacy store is initialized and would
 * otherwise open.
 *
 * No console call: errors propagate, and callers log the error name only.
 */

import { openStoreHandle, closeNetworkDb, dbNameFor, DB_NAME_PREFIX } from './open-db.js';
import { registerDbPlugins, initDB, isSchemaInitialized, markSchemaInitialized } from '@votetorrent/vote-engine/browser';

/**
 * The live store for a network is absent (`create: false` on a name
 * `indexedDB.databases()` does not list) or was never initialized.
 */
export class LiveStoreMissingError extends Error {
	/**
	 * @param {string} networkHash
	 * @param {'absent' | 'not-initialized'} reason
	 */
	constructor(networkHash, reason) {
		super(
			reason === 'absent'
				? 'attachLiveDb: no local store exists for this network'
				: 'attachLiveDb: the local store for this network was never initialized',
		);
		this.name = 'LiveStoreMissingError';
		this.networkHash = networkHash;
		this.reason = reason;
	}
}

/** This environment has no IndexedDB at all. */
export class LiveStoreUnavailableError extends Error {
	constructor() {
		super('attachLiveDb: IndexedDB is not available in this environment');
		this.name = 'LiveStoreUnavailableError';
	}
}

/**
 * Whether this browser holds a local store for `networkHash`, decided from
 * `indexedDB.databases()` alone, with NO open: opening a name that does not
 * exist would create it, so this never opens. Throws
 * `LiveStoreUnavailableError` when IndexedDB or `databases()` is missing, so a
 * caller can report "could not be established" rather than "absent" (and never
 * falls through to an open the way `attachLiveDb` does in that case).
 *
 * @param {string} networkHash
 * @returns {Promise<boolean>}
 */
export async function hasLiveStore(networkHash) {
	if (typeof networkHash !== 'string' || networkHash.length === 0) {
		throw new TypeError('hasLiveStore: networkHash must be a non-empty string');
	}
	const idb = globalThis.indexedDB;
	if (typeof idb === 'undefined' || typeof idb.databases !== 'function') {
		throw new LiveStoreUnavailableError();
	}
	const name = dbNameFor(networkHash);
	const known = await idb.databases();
	return known.some((entry) => entry.name === name);
}

/**
 * 56-29. Every network this browser holds a local store for, decided from
 * `indexedDB.databases()` alone, with NO open (same reason as `hasLiveStore`).
 * Only names this module's own `dbNameFor` produces count (`votetorrent-`
 * prefix); the page's strand cache and anything else on the origin are
 * skipped. Sorted by hash so the result never depends on the browser's
 * listing order. Each entry carries the hash and nothing else.
 *
 * Throws `LiveStoreUnavailableError` when IndexedDB or `databases()` is
 * missing: "cannot tell" must never read as "holds nothing".
 *
 * Holding a store is not the same as holding a usable one: a caller still
 * attaches each with `create: false`, which refuses an uninitialized store.
 *
 * @returns {Promise<Array<{ networkHash: string }>>}
 */
export async function listLiveStoreNetworks() {
	const idb = globalThis.indexedDB;
	if (typeof idb === 'undefined' || typeof idb.databases !== 'function') {
		throw new LiveStoreUnavailableError();
	}
	const known = await idb.databases();
	/** @type {string[]} */
	const hashes = [];
	for (const entry of known) {
		const name = entry && typeof entry.name === 'string' ? entry.name : '';
		if (name.startsWith(DB_NAME_PREFIX) && name.length > DB_NAME_PREFIX.length) {
			hashes.push(name.slice(DB_NAME_PREFIX.length));
		}
	}
	return [...new Set(hashes)].sort().map((networkHash) => ({ networkHash }));
}

/**
 * @typedef {object} AttachLiveDbOptions
 * @property {boolean} create - true: open or create (and initialize); false: open an existing, initialized store only
 */

/**
 * Open a network's local store as a live copy.
 *
 * @param {string} networkHash
 * @param {AttachLiveDbOptions} options
 * @returns {Promise<import('@quereus/quereus').Database>}
 */
export async function attachLiveDb(networkHash, options) {
	if (typeof networkHash !== 'string' || networkHash.length === 0) {
		throw new TypeError('attachLiveDb: networkHash must be a non-empty string');
	}
	if (options === null || typeof options !== 'object' || Array.isArray(options)) {
		throw new TypeError('attachLiveDb: options must be an object');
	}
	if (typeof options.create !== 'boolean') {
		throw new TypeError('attachLiveDb: options.create must be a boolean');
	}
	const { create } = options;

	if (typeof globalThis.indexedDB === 'undefined') {
		throw new LiveStoreUnavailableError();
	}

	if (!create && typeof globalThis.indexedDB.databases === 'function') {
		const name = dbNameFor(networkHash);
		const known = await globalThis.indexedDB.databases();
		if (!known.some((entry) => entry.name === name)) {
			throw new LiveStoreMissingError(networkHash, 'absent');
		}
	}

	const db = await openStoreHandle(networkHash);

	try {
		// Always-run: per-Database-instance state, never persisted.
		await registerDbPlugins(db);

		// initDB on an already-declared handle throws (the Quereus differ
		// emits an ALTER on a primary-key column), so it runs only when this
		// handle lacks the declaration. On a fresh handle over a persisted
		// store this is the required DDL re-declaration: it reconciles against
		// the persisted catalog instead of recreating it.
		if (!db.declaredSchemaManager.hasDeclaredSchema('main')) {
			await initDB(db);
		}

		// After initDB, never before: initDB also declares the marker table,
		// so checking first would hit an undeclared table and condemn a
		// healthy store.
		const initialized = await isSchemaInitialized(db);
		if (!initialized) {
			if (create) {
				await markSchemaInitialized(db);
			} else {
				throw new LiveStoreMissingError(networkHash, 'not-initialized');
			}
		}

		return db;
	} catch (err) {
		// A failed attach must not hold the database against a later delete.
		await closeNetworkDb(db);
		throw err;
	}
}
