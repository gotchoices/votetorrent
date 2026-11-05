/**
 * D-11 re-attach: re-declare the DDL, gate on the schema-init marker, and
 * prove adoption of the persisted rows by asserting EXACT per-table row
 * counts — never a nonzero-floor comparison, which would pass a store that
 * lost most of its registrants.
 *
 * A fresh `Database` does NOT auto-restore the catalog. `packages/vote-engine
 * /src/database/initialize.ts`'s `initDB` says this for LevelDB and it holds
 * for IndexedDB too: re-attach must re-run the declarative DDL, which
 * reconciles against the persisted catalog rather than recreating it
 * (measured warm ~104 ms vs ~211 ms cold — spike 076). A reconcile that
 * dropped and recreated a table also makes `select count(*)` resolve, with
 * ZERO rows — a table resolving is not proof of anything; only the count is.
 *
 * Contract C5's honest limit (state this verbatim, per D-16): the row-count
 * record below is an INTEGRITY check against truncation, partial reconcile
 * and local accident. It is NOT an anti-tamper control — anyone who can edit
 * the browser's IndexedDB can also edit its web storage. Do not let a later
 * plan describe it as protection it is not.
 */

import { openStoreHandle, closeNetworkDb } from './open-db.js';
import { registerDbPlugins, initDB, isSchemaInitialized, nowCanonicalDatetime } from '@votetorrent/vote-engine/browser';
import { classOf, UnknownTableError } from './classification.js';

/** A network has no schema-init marker — `createNetworkDb()` was never called for it. */
export class NotBootstrappedError extends Error {
	/** @param {string} networkHash */
	constructor(networkHash) {
		super(
			`attachNetworkDb: network "${networkHash}" has no schema-init marker — use createNetworkDb() first`,
		);
		this.name = 'NotBootstrappedError';
		this.networkHash = networkHash;
	}
}

/** No contract-C5 row-count record exists for this network — the store is unverifiable. */
export class MissingRowCountsError extends Error {
	/** @param {string} networkHash */
	constructor(networkHash) {
		super(
			`attachNetworkDb: no row-count record found for network "${networkHash}" (key "${rowCountsKeyFor(networkHash)}") — the store is unverifiable, re-bootstrap required`,
		);
		this.name = 'MissingRowCountsError';
		this.networkHash = networkHash;
	}
}

/** A live per-table row count diverges from the persisted contract-C5 record. */
export class RowCountMismatchError extends Error {
	/**
	 * @param {string} table
	 * @param {number} expected
	 * @param {number} actual
	 */
	constructor(table, expected, actual) {
		super(
			`attachNetworkDb: row-count mismatch on table "${table}" — expected ${expected}, got ${actual}`,
		);
		this.name = 'RowCountMismatchError';
		this.table = table;
		this.expected = expected;
		this.actual = actual;
	}
}

/** A persisted row-count record's shape failed validation. */
export class InvalidRowCountRecordError extends Error {
	/**
	 * @param {string} field
	 * @param {string} reason
	 */
	constructor(field, reason) {
		super(`reattach: row-count record field "${field}" is invalid — ${reason}`);
		this.name = 'InvalidRowCountRecordError';
		this.field = field;
	}
}

/** @type {'votetorrent.dashboard.rowcounts.'} */
export const ROW_COUNTS_KEY_PREFIX = 'votetorrent.dashboard.rowcounts.';

/**
 * @param {string} networkHash
 * @returns {string}
 */
export function rowCountsKeyFor(networkHash) {
	return `${ROW_COUNTS_KEY_PREFIX}${networkHash}`;
}

/**
 * @typedef {{ getItem(key: string): string | null | undefined, setItem(key: string, value: string): void, removeItem(key: string): void }} StorageAdapter
 */

/**
 * Resolve the storage adapter to use: the injected one, else
 * `globalThis.localStorage`. Node 22 has no `localStorage` without an
 * experimental flag, so a tier-1 test injects a `Map`-backed fake; the
 * browser uses the real thing.
 *
 * @param {StorageAdapter} [storage]
 * @returns {StorageAdapter | undefined}
 */
function resolveStorage(storage) {
	if (storage) return storage;
	return typeof globalThis !== 'undefined' ? /** @type {StorageAdapter | undefined} */ (globalThis.localStorage) : undefined;
}

/**
 * Like {@link resolveStorage}, but throws when no adapter is available —
 * used by the read/write paths, where a missing adapter is a real failure
 * to surface rather than something to silently skip.
 *
 * @param {StorageAdapter} [storage]
 * @returns {StorageAdapter}
 */
function requireStorage(storage) {
	const s = resolveStorage(storage);
	if (!s || typeof s.getItem !== 'function' || typeof s.setItem !== 'function' || typeof s.removeItem !== 'function') {
		throw new TypeError(
			'reattach.js: no storage adapter available — pass one explicitly (e.g. a Map-backed fake in a Node test) or run in an environment with localStorage',
		);
	}
	return s;
}

/**
 * @typedef {{ networkHash: string, capturedAt: string, counts: Record<string, number> }} RowCountsRecord
 */

/**
 * Persist the contract-C5 row-count record for a network. `capturedAt` is
 * stamped with `nowCanonicalDatetime()` — never a raw ISO-8601 Date-string
 * conversion (Landmine 3: canonical datetimes are 19 characters, no `Z`).
 *
 * @param {string} networkHash
 * @param {Record<string, number>} counts
 * @param {StorageAdapter} [storage]
 * @returns {Promise<RowCountsRecord>}
 */
export async function writeRowCounts(networkHash, counts, storage) {
	const s = requireStorage(storage);
	/** @type {RowCountsRecord} */
	const record = { networkHash, capturedAt: nowCanonicalDatetime(), counts: { ...counts } };
	s.setItem(rowCountsKeyFor(networkHash), JSON.stringify(record));
	return record;
}

/**
 * Read and shape-validate the persisted row-count record for a network.
 * Returns `undefined` when no record exists (a missing record is a normal,
 * expected outcome the caller decides how to react to — see
 * `attachNetworkDb`'s `MissingRowCountsError`). Throws
 * `InvalidRowCountRecordError` naming the offending field when a record
 * exists but is corrupt or hand-mangled.
 *
 * @param {string} networkHash
 * @param {StorageAdapter} [storage]
 * @returns {Promise<RowCountsRecord | undefined>}
 */
export async function readRowCountsRecord(networkHash, storage) {
	const s = requireStorage(storage);
	const raw = s.getItem(rowCountsKeyFor(networkHash));
	if (raw === null || raw === undefined) return undefined;

	/** @type {any} */
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new InvalidRowCountRecordError('(record)', 'stored value is not valid JSON');
	}

	if (typeof parsed?.capturedAt !== 'string') {
		throw new InvalidRowCountRecordError('capturedAt', 'must be a string');
	}
	if (parsed.capturedAt.length !== 19) {
		throw new InvalidRowCountRecordError(
			'capturedAt',
			`must be exactly 19 characters, got ${parsed.capturedAt.length} ("${parsed.capturedAt}")`,
		);
	}
	if (parsed.capturedAt.includes('Z')) {
		throw new InvalidRowCountRecordError(
			'capturedAt',
			`must not contain "Z" — canonical datetimes carry no timezone suffix, got "${parsed.capturedAt}"`,
		);
	}
	if (typeof parsed?.counts !== 'object' || parsed.counts === null || Array.isArray(parsed.counts)) {
		throw new InvalidRowCountRecordError('counts', 'must be an object of table name to count');
	}
	for (const [table, count] of Object.entries(parsed.counts)) {
		if (!Number.isInteger(count) || count < 0) {
			throw new InvalidRowCountRecordError(
				`counts.${table}`,
				`must be a non-negative integer, got ${JSON.stringify(count)}`,
			);
		}
	}

	return /** @type {RowCountsRecord} */ (parsed);
}

/**
 * Remove the persisted row-count record for a network. Called by
 * `deleteNetworkDb` (`./open-db.js`) and by 50-09's refresh/forget flows.
 * Best-effort: if no storage adapter is available at all (e.g. a Node
 * environment with no injected fake and no `localStorage` global), this is a
 * silent no-op rather than a throw — there is nothing to clear in that
 * environment, and `deleteNetworkDb`'s IndexedDB deletion must not be
 * blocked by the absence of an unrelated storage layer.
 *
 * @param {string} networkHash
 * @param {StorageAdapter} [storage]
 * @returns {Promise<void>}
 */
export async function clearRowCounts(networkHash, storage) {
	const s = resolveStorage(storage);
	if (!s || typeof s.removeItem !== 'function') return;
	s.removeItem(rowCountsKeyFor(networkHash));
}

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Read live per-table row counts. `tableNames` is an allow-list the caller
 * already controls (e.g. `SEED_TABLES`, or `Object.keys(expected)`) — never
 * an arbitrary string interpolated into SQL.
 *
 * Each name passes TWO guards before it is interpolated: `TABLE_NAME_RE`'s
 * identifier shape, then membership in the schema's classified-table set via
 * `classOf` (`./classification.js`). The interpolation itself is unavoidable
 * and stays: a table name in `from` position is an identifier, and
 * identifiers are not bindable as parameters in any SQL engine, Quereus
 * included — there is no `:table` bind form. The alternative would be 61
 * hand-written per-table `count(*)` constants, one per schema table, which
 * would silently drift from `votetorrent.qsql` the moment a table is added
 * and would defeat `classOf`'s design intent that the schema growing a table
 * must BREAK this gate rather than quietly bypass a stale constant list. What
 * makes the interpolation defensible is therefore not the shape check alone
 * but that the value is drawn from a CLOSED ENUMERATION, not merely from
 * something identifier-shaped — see the allow-list entry keyed to this
 * function in `packages/web-data/test/connection-layer-shape.test.mjs`,
 * which a reader who finds this interpolation should read next.
 *
 * `classOf`'s `UnknownTableError` is caught and re-thrown as a `TypeError`
 * naming the table — the thrown TYPE must stay `TypeError`, unchanged from
 * before this guard existed, because `public-election-source.js` routes
 * faults to `NOT_HELD` vs `UNREADABLE` by constructor name, and only three
 * names route to `NOT_HELD`. An unclassified name continues to surface as a
 * fault exactly as a non-identifier name always has.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {string[]} tableNames
 * @returns {Promise<Record<string, number>>}
 */
export async function readRowCounts(db, tableNames) {
	/** @type {Record<string, number>} */
	const counts = {};
	for (const table of tableNames) {
		if (!TABLE_NAME_RE.test(table)) {
			throw new TypeError(`readRowCounts: refusing non-identifier table name "${table}"`);
		}
		try {
			classOf(table);
		} catch (err) {
			if (err instanceof UnknownTableError) {
				throw new TypeError(`readRowCounts: refusing table "${table}" — not a classified schema table (see packages/web-data/src/classification.js)`);
			}
			throw err;
		}
		const row = await db.prepare(`select count(*) as c from ${table}`).get({});
		counts[table] = Number(row?.c ?? 0);
	}
	return counts;
}

/**
 * Read live counts for exactly the keys of `expected` and throw
 * `RowCountMismatchError` on the first divergence, naming table/expected/
 * actual. Exact equality — D-11 says assert row counts, and a nonzero-floor
 * comparison would pass a store that lost 90% of its registrants.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {Record<string, number>} expected
 * @returns {Promise<Record<string, number>>}
 */
export async function assertRowCounts(db, expected) {
	const tableNames = Object.keys(expected);
	const live = await readRowCounts(db, tableNames);
	for (const table of tableNames) {
		if (live[table] !== expected[table]) {
			throw new RowCountMismatchError(table, expected[table], live[table]);
		}
	}
	return live;
}

/**
 * @typedef {object} AttachNetworkDbOptions
 * @property {Record<string, number>} [expectedCounts] - freshly-verified counts (50-08/50-09 pass these directly)
 * @property {StorageAdapter} [storage] - injected storage adapter, else `globalThis.localStorage`
 */

/**
 * The D-11 re-attach path, mirroring `networks-engine.ts`'s `open()` minus
 * the strand branch (the dashboard is local-only — there is no strand path
 * here).
 *
 * @param {string} networkHash
 * @param {AttachNetworkDbOptions} [options]
 * @returns {Promise<import('@quereus/quereus').Database>}
 */
export async function attachNetworkDb(networkHash, options = {}) {
	const { expectedCounts, storage } = options;

	const db = await openStoreHandle(networkHash);

	try {
		// Always-run: per-Database-instance state, never persisted.
		await registerDbPlugins(db);

		// Running initDB on an already-declared handle triggers the Quereus
		// differ's ALTER COLUMN DROP NOT NULL on a PK column and throws — so
		// initDB must ONLY run when the handle lacks the declaration. On a
		// genuinely fresh handle over a persisted IndexedDB store, this is
		// exactly the DDL re-declaration D-11 requires: it reconciles against
		// the persisted catalog instead of recreating it. votetorrent.qsql
		// declares no `boolean default` column (grep-confirmed — the only
		// matches are comments warning about exactly this), so the known 4.x
		// re-attach ALTER COLUMN coercion class is not live here; if it ever
		// surfaces, the fix belongs in the schema, not in this file.
		if (!db.declaredSchemaManager.hasDeclaredSchema('main')) {
			await initDB(db);
		}

		// After initDB, never before: initDB also declares the SchemaInit
		// catalog (with no row), so checking this gate before initDB would hit
		// an undeclared table on a fresh handle over a persisted store and
		// wrongly return false, condemning a healthy store.
		const initialized = await isSchemaInitialized(db);
		if (!initialized) {
			throw new NotBootstrappedError(networkHash);
		}

		let expected = expectedCounts;
		if (!expected) {
			const record = await readRowCountsRecord(networkHash, storage);
			if (!record) {
				throw new MissingRowCountsError(networkHash);
			}
			expected = record.counts;
		}

		await assertRowCounts(db, expected);

		return db;
	} catch (err) {
		// A failed attach must not leave a connection holding the database
		// against a later deleteNetworkDb.
		await closeNetworkDb(db);
		throw err;
	}
}
