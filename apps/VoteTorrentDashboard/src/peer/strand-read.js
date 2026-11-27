/**
 * strand-read.js -- the officer dashboard's strand reader: every replicated officer table, read
 * through the member node's OWN strand database, returned as row ops for the local copy.
 *
 * It is the officer twin of the Public page's `src/peer/strand-read.js`, copied in structure and not
 * imported (the apps never import each other). It differs from that file in three ways:
 *
 * 1. ONE DATABASE PER STRAND, AND IT IS CADRE-CORE'S. The Public page has no cadre membership, so it
 *    builds its own `StrandDatabase` over its edge node. The dashboard's member node has already
 *    claimed the strand through cadre-core, and cadre-core keeps exactly one `StrandDatabase` for it
 *    (`StrandInstance.database`). This file reads through that one, as handed out by
 *    `memberNode.getStrandDatabase(strandId)`. That is the path the pair-mint harness leg PM-7 proved
 *    on a storage-withdrawn edge node. cadre-core owns that database's lifecycle (it builds it when
 *    the strand header arrives, rebuilds it, and closes it when the node stops), so this file never
 *    closes it and never builds a second one.
 *
 * 2. THE OFFICER ALLOWLIST. Tables come only from `OFFICER_SUBSCRIBED_TABLES`, which web-data derives
 *    from the officer read modules, the advisory gate's tables and the pairing tables. It is imported,
 *    never restated here.
 *
 * 3. DELETE-AWARE. The Public reader skips a table whose strand read returned zero rows. That cannot
 *    work for a copy that must converge: when the last row of a table is removed on the strand, the
 *    read is empty, and a skipped table would keep the removed row locally for ever. So `readRows`
 *    takes the local primary keys and returns a removal op for every local key the strand no longer
 *    holds. A table is skipped (returns no ops) only when it is empty on BOTH sides.
 *
 * READING IS THIS FILE'S WHOLE JOB. It never writes and never opens a local store handle. The
 * reactivity bridge owns applying the ops.
 *
 * THE NETWORK TRANSACTOR. A strand database whose resolved transactor is not 'network' would read
 * this node's own raw storage with no peer consulted, a page that looks right while replicating
 * nothing. The reader asserts 'network' on every strand database object it prepares, including one
 * cadre-core rebuilt after the reader opened.
 *
 * THE VOTE-ENGINE SQL FUNCTIONS. cadre-core registers its own crypto plugin on the strand database,
 * which does not provide vote-engine's custom functions (`SignatureValidP256` and the others). The
 * pairing checks read through this reader and need them, so the reader runs vote-engine's
 * `registerDbPlugins` once per Database object it prepares.
 *
 * A PROGRESS-AWARE WAIT (gap G-3). cadre-core publishes the strand database only when a joining
 * machine's first build is done, and over the relay to slow phones that build was measured running for
 * minutes while it fetched block after block. A fixed deadline refused it while it was still working. So
 * the wait for the database ends on a STALL, `STRAND_DB_STALL_MS` with no progress, or at a HARD CAP,
 * `STRAND_DB_CAP_MS` in all, whichever comes first. Progress is what the strand node receives, as
 * `strand-progress.js` counts it (answered data streams, blocks landing in its store). A strand node that
 * receives nothing fails at the stall window, sooner than the old fixed wait did. Both endings throw the
 * same `StrandReadError` (subject `strandDatabase`, code `'timeout'`); the reason text says which.
 *
 * NO IMPORT-TIME WORK. The pairing code reaches this module through a lazy `import()`. Module scope
 * holds only imports, constants, the error class and function declarations.
 *
 * SQL IDENTIFIER NOTE. The one query this file builds interpolates a TABLE NAME, and that name is
 * always a member of the frozen allowlist (checked before the query is built). Column names come only
 * from the local schema, and there are no bound values to interpolate.
 *
 * ACCEPTED RESIDUAL (threat T-66-13-07). A strand read that returns zero rows for a table that holds
 * local rows removes those rows locally. That is required for a real last-row removal to be seen. If
 * the empty read was wrong, the next pass (at most 20 s later) restores anything still on the strand,
 * and the panels' change marks show the removal and the return.
 *
 * ERROR HYGIENE. Errors carry a subject (a table or option name) and never a row value, a key value
 * or Quereus message text. An underlying error is reduced to its name.
 */

import { OFFICER_SUBSCRIBED_TABLES } from '@votetorrent/web-data/officer';
import { registerDbPlugins as realRegisterDbPlugins } from '@votetorrent/vote-engine/browser';
import { watchStrandProgress } from './strand-progress.js';

/**
 * A strand-read failure naming a table, an option or a limit, never a row value.
 * `code` is a closed tag for the cases a caller may act on: `'unavailable'` (the strand database is
 * not published right now), `'rebuilt'` (cadre-core replaced it; `await reader.current()` prepares
 * the new one), `'timeout'` (not published before the stall window or the hard cap ran out), or null.
 */
export class StrandReadError extends Error {
	/**
	 * @param {string} subject - the option, table or resolved-value name this error concerns
	 * @param {string} reason
	 * @param {'unavailable'|'rebuilt'|'timeout'|null} [code]
	 */
	constructor(subject, reason, code = null) {
		super(`strand-read: ${reason} (subject: "${subject}")`);
		this.name = 'StrandReadError';
		this.subject = subject;
		this.reason = reason;
		this.code = code;
	}
}

/**
 * The per-table row ceiling. Exceeding it THROWS rather than truncating: a silently short read gives
 * a stale copy that looks complete. A DoS bound, not a product ceiling.
 * @type {50000}
 */
export const STRAND_READ_ROW_LIMIT = 50_000;

/**
 * The stall window: the wait for cadre-core to publish the strand database (it is unset until the
 * joining machine's first build is done, which can be long after `waitForStrand` resolved) gives up when
 * the strand node has received nothing for this long.
 *
 * Why 60 s: in the G-3 diagnostic (fresh, slow phones over the relay) the build answered a block request
 * at least every few seconds, and the longest gap between two of its index trees opening was 26 s, so a
 * build that is working clears 60 s by more than 2x. One cohort read at the supported 3 s link round trip
 * takes about 6 s (cadre-core's first-sync measurements), so 60 s is about ten of them with nothing back.
 * A strand node that receives nothing at all is refused at 60 s, where the old fixed wait took 120 s.
 * @type {60000}
 */
export const STRAND_DB_STALL_MS = 60_000;

/**
 * The hard cap: the wait gives up after this long in all, however steadily data arrives.
 *
 * Why 10 min: cadre-core's own first-sync budget is 360 s, sized at 3x its worst harness attach (105.9 s);
 * the slowest device sample it records is a Galaxy S7 joining through a relay in 178 s. 600 s clears that
 * device sample by more than 3x and cadre-core's budget by 1.6x, and still ends a pairing that only trickles.
 * @type {600000}
 */
export const STRAND_DB_CAP_MS = 600_000;

/** How often the reader looks again while waiting. */
const STRAND_DB_POLL_MS = 500;

/** The schema path that makes bare table names resolve to the sApp schema first, then `main`. */
const SCHEMA_PATH = Object.freeze(['App', 'main']);

/**
 * The error's name and nothing else.
 * @param {unknown} err
 * @returns {string}
 */
function nameOf(err) {
	return err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
}

/**
 * Lowercase hex of a byte array.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toHex(bytes) {
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

/**
 * A type-tagged identity for a primary key, so a strand key and a local key compare equal exactly when
 * the store would treat them as the same key. Integer-valued numbers and bigints are equal (`5` and
 * `5n`), bytes compare by value, and null is its own tag. Text goes through the key column's collation
 * normalizer when one is given: the store keys a text key that declares no collation under NOCASE, so
 * two keys that differ only in case are one row there and must be one identity here. Without
 * normalizers, text is exact.
 *
 * @param {ReadonlyArray<unknown>} values - the key's values in PK-definition order
 * @param {ReadonlyArray<(s: string) => string>} [normalizers] - one per key position, from the store
 *   database's `getKeyNormalizerResolver()` applied to each key column's collation
 * @returns {string}
 */
export function primaryKeyIdentity(values, normalizers) {
	if (!Array.isArray(values)) {
		throw new StrandReadError('primaryKey', 'a primary key must be an array of values');
	}
	if (normalizers !== undefined && normalizers.length !== values.length) {
		throw new StrandReadError('primaryKey', 'one key normalizer per key value is required');
	}
	const tagged = values.map((value, position) => {
		if (typeof value === 'string' && normalizers) return `s:${normalizers[position](value)}`;
		if (value === null || value === undefined) return 'n';
		if (typeof value === 'boolean') return value ? 'i:1' : 'i:0';
		if (typeof value === 'bigint') return `i:${value.toString()}`;
		if (typeof value === 'number') {
			if (Number.isInteger(value)) return `i:${BigInt(value).toString()}`;
			if (Number.isFinite(value)) return `r:${String(value)}`;
			throw new StrandReadError('primaryKey', 'unsupported key value type non-finite number');
		}
		if (typeof value === 'string') return `s:${value}`;
		if (value instanceof Uint8Array) return `b:${toHex(value)}`;
		throw new StrandReadError('primaryKey', `unsupported key value type ${typeof value}`);
	});
	return JSON.stringify(tagged);
}

/**
 * Read-side ordering of a strand row against the LOCAL schema, never the strand handle's. The two
 * schemas come from the same source today, which is exactly why an implicit order would usually work
 * and why relying on it is the bug that stays invisible until a schema edit changes one side's
 * column order. A column the strand row lacks becomes null.
 *
 * @param {{ columns: ReadonlyArray<{ name: string }> }} uiTableSchema
 * @param {Record<string, any>} strandRow - a row image read from the strand database, keyed by column name
 * @returns {any[]}
 */
function toUiOrderedRow(uiTableSchema, strandRow) {
	return uiTableSchema.columns.map((column) => {
		if (!(column.name in strandRow)) return null;
		return strandRow[column.name];
	});
}

/**
 * @typedef {object} StrandReaderDeps
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep]
 * @property {() => number} [now]
 * @property {number} [stallMs] - the stall window, `STRAND_DB_STALL_MS` by default
 * @property {number} [capMs] - the hard cap, `STRAND_DB_CAP_MS` by default
 * @property {number} [pollMs]
 * @property {(db: any) => Promise<void>} [registerDbPlugins]
 */

/**
 * @typedef {object} ReaderState
 * @property {any} object - the cadre-core strand database last prepared, or null
 * @property {any} db - its prepared Database, or null
 * @property {WeakSet<object>} registered - Database objects that already carry vote-engine's functions
 */

/**
 * The default sleep: a timer that also ends early when `signal` aborts.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function defaultSleep(ms, signal) {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		}
		signal?.addEventListener('abort', done, { once: true });
	});
}

/**
 * Look up the strand database once, synchronously.
 * @param {any} memberNode
 * @param {string} strandId
 * @returns {any}
 */
function lookUp(memberNode, strandId) {
	let found;
	try {
		found = memberNode.getStrandDatabase(strandId);
	} catch (err) {
		throw new StrandReadError('memberNode', `getStrandDatabase failed (${nameOf(err)})`);
	}
	if (!found) {
		throw new StrandReadError('strandDatabase', 'the strand database is not available', 'unavailable');
	}
	return found;
}

/**
 * Resolve the current strand database and prepare it when it is a new object: assert the network
 * transactor, set the schema path and register vote-engine's SQL functions (once per Database).
 * Never calls `waitForStrand` (the caller brought the strand up) and never closes anything.
 *
 * @param {any} memberNode
 * @param {string} strandId
 * @param {ReaderState} state
 * @param {StrandReaderDeps} deps
 * @returns {Promise<any>} the prepared Database
 */
async function resolveCurrent(memberNode, strandId, state, deps) {
	const strandDatabase = lookUp(memberNode, strandId);
	if (strandDatabase === state.object && state.db) return state.db;

	let transactor;
	try {
		transactor = strandDatabase.getTransactor();
	} catch (err) {
		throw new StrandReadError('transactor', `the transactor could not be read (${nameOf(err)})`);
	}
	if (transactor !== 'network') {
		// Refused, and deliberately NOT closed: cadre-core owns this database.
		throw new StrandReadError('transactor', 'the strand database does not read through the network transactor');
	}

	let db;
	try {
		db = strandDatabase.getDatabase();
		db.setSchemaPath([...SCHEMA_PATH]);
	} catch (err) {
		throw new StrandReadError('strandDatabase', `the strand database could not be prepared (${nameOf(err)})`);
	}

	if (!state.registered.has(db)) {
		try {
			await (deps.registerDbPlugins ?? realRegisterDbPlugins)(db);
		} catch {
			throw new StrandReadError('functions', 'the vote-engine SQL functions could not be registered');
		}
		state.registered.add(db);
	}

	state.object = strandDatabase;
	state.db = db;
	return db;
}

/**
 * The member node's strand libp2p node, or null when it has none (or no accessor).
 * @param {any} memberNode
 * @returns {any}
 */
function strandNodeOf(memberNode) {
	if (typeof memberNode.getStrandNode !== 'function') return null;
	try {
		return memberNode.getStrandNode() ?? null;
	} catch {
		return null;
	}
}

/**
 * Poll `resolveCurrent` until the strand database is published, `signal` aborts, the strand node has
 * received nothing for the stall window, or the hard cap runs out. Only "not available" is retried;
 * every other refusal is final. The progress watch lives for this one wait and is stopped on every exit.
 *
 * @param {any} memberNode
 * @param {string} strandId
 * @param {ReaderState} state
 * @param {StrandReaderDeps} deps
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
async function waitForCurrent(memberNode, strandId, state, deps, signal) {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? defaultSleep;
	const stallMs = deps.stallMs ?? STRAND_DB_STALL_MS;
	const capMs = deps.capMs ?? STRAND_DB_CAP_MS;
	const pollMs = deps.pollMs ?? STRAND_DB_POLL_MS;
	if (signal?.aborted) throw new StrandReadError('signal', 'the wait for the strand database was cancelled');
	// The fast path, taken by every read of a published database, starts no watch.
	try {
		return await resolveCurrent(memberNode, strandId, state, deps);
	} catch (err) {
		if (!(err instanceof StrandReadError) || err.code !== 'unavailable') throw err;
	}
	const progress = watchStrandProgress({ strandId });
	try {
		const started = now();
		let lastProgressAt = started;
		let seen = progress.sample(strandNodeOf(memberNode));
		for (;;) {
			const count = progress.sample(strandNodeOf(memberNode));
			const at = now();
			if (count !== seen) {
				seen = count;
				lastProgressAt = at;
			}
			if (at - started >= capMs) {
				throw new StrandReadError('strandDatabase', 'the strand database was not published within the hard cap', 'timeout');
			}
			if (at - lastProgressAt >= stallMs) {
				throw new StrandReadError('strandDatabase', 'the strand database was not published and the strand node received nothing for the stall window', 'timeout');
			}
			await sleep(pollMs, signal);
			if (signal?.aborted) throw new StrandReadError('signal', 'the wait for the strand database was cancelled');
			try {
				return await resolveCurrent(memberNode, strandId, state, deps);
			} catch (err) {
				if (!(err instanceof StrandReadError) || err.code !== 'unavailable') throw err;
			}
		}
	} finally {
		progress.stop();
	}
}

/**
 * @typedef {object} OfficerStrandReader
 * @property {any} db - the prepared strand Database, re-resolved on every access (throws when unavailable or rebuilt)
 * @property {(options?: { signal?: AbortSignal }) => Promise<any>} current - re-resolve, wait and prepare
 * @property {(table: string, localPks: ReadonlyArray<ReadonlyArray<any>>, opts: { uiDb: any }) => Promise<ReadonlyArray<{ op: 'upsert', row: any[] } | { op: 'delete', pk: any[] }>>} readRows
 * @property {() => Promise<void>} close - idempotent; never closes cadre-core's database
 */

/**
 * Open the officer strand reader over the member node's own strand database.
 *
 * @param {{ memberNode: any, strandId: string, signal?: AbortSignal, deps?: StrandReaderDeps }} [options]
 * @returns {Promise<OfficerStrandReader>}
 */
export async function openOfficerStrandReader({ memberNode, strandId, signal, deps } = /** @type {any} */ ({})) {
	if (!memberNode || typeof memberNode.getStrandDatabase !== 'function') {
		throw new StrandReadError('memberNode', 'a member node with getStrandDatabase is required');
	}
	if (typeof strandId !== 'string' || strandId.length === 0) {
		throw new StrandReadError('strandId', 'strandId must be a non-empty string');
	}
	const resolvedDeps = deps ?? {};

	/** @type {ReaderState} */
	const state = { object: null, db: null, registered: new WeakSet() };
	let closed = false;

	await waitForCurrent(memberNode, strandId, state, resolvedDeps, signal);

	/**
	 * @param {{ signal?: AbortSignal }} [options]
	 * @returns {Promise<any>}
	 */
	async function current(options) {
		if (closed) throw new StrandReadError('reader', 'the reader is closed');
		return waitForCurrent(memberNode, strandId, state, resolvedDeps, options?.signal);
	}

	/**
	 * Every strand row of `table` as an upsert (in the LOCAL column order), then one removal op per
	 * local key the strand no longer holds. `[]` only when both sides are empty.
	 *
	 * @param {string} table - a member of OFFICER_SUBSCRIBED_TABLES
	 * @param {ReadonlyArray<ReadonlyArray<any>>} localPks - local key value arrays, PK-definition order
	 * @param {{ uiDb: any }} opts - the local store handle, read for its schema only
	 */
	async function readRows(table, localPks, opts) {
		if (closed) throw new StrandReadError('reader', 'the reader is closed');
		if (typeof table !== 'string' || !OFFICER_SUBSCRIBED_TABLES.includes(table)) {
			throw new StrandReadError(String(table), 'the table is outside OFFICER_SUBSCRIBED_TABLES');
		}
		if (!Array.isArray(localPks)) throw new StrandReadError('localPks', 'localPks must be an array of key arrays');
		const uiDb = opts?.uiDb;
		if (!uiDb || !uiDb.schemaManager) throw new StrandReadError('uiDb', 'the local store handle is required to order rows');

		const uiTableSchema = uiDb.schemaManager.getTable(uiDb.schemaManager.getCurrentSchemaName(), table);
		if (!uiTableSchema) throw new StrandReadError(table, 'the local schema declares no such table');
		const pkNames = uiTableSchema.primaryKeyDefinition.map(
			(/** @type {{ index: number }} */ d) => uiTableSchema.columns[d.index].name,
		);
		if (typeof uiDb.getKeyNormalizerResolver !== 'function') {
			throw new StrandReadError('uiDb', 'the local store handle has no key normalizer resolver');
		}
		const resolveNormalizer = uiDb.getKeyNormalizerResolver();
		/** @type {Array<(s: string) => string>} */
		let pkNormalizers;
		try {
			pkNormalizers = uiTableSchema.primaryKeyDefinition.map(
				(/** @type {{ index: number }} */ d) => resolveNormalizer(uiTableSchema.columns[d.index].collation ?? 'BINARY'),
			);
		} catch (err) {
			throw new StrandReadError(table, `a key column's collation has no key normalizer (${nameOf(err)})`);
		}

		const strandDb = await current();

		/** @type {Record<string, any>[]} */
		const rawRows = [];
		try {
			// Identifier interpolation only: `table` passed the allowlist check above.
			for await (const row of strandDb.eval(`select * from ${table}`)) {
				rawRows.push(/** @type {any} */ (row));
				if (rawRows.length > STRAND_READ_ROW_LIMIT) {
					throw new StrandReadError(table, `exceeded STRAND_READ_ROW_LIMIT (${STRAND_READ_ROW_LIMIT}), refusing to truncate`);
				}
			}
		} catch (err) {
			if (err instanceof StrandReadError) throw err;
			throw new StrandReadError(table, `the strand read failed (${nameOf(err)})`);
		}

		/** @type {Set<string>} */
		const onStrand = new Set();
		/** @type {Array<{ op: 'upsert', row: any[] } | { op: 'delete', pk: any[] }>} */
		const ops = [];
		for (const row of rawRows) {
			ops.push({ op: 'upsert', row: toUiOrderedRow(uiTableSchema, row) });
			onStrand.add(primaryKeyIdentity(pkNames.map((/** @type {string} */ n) => row[n]), pkNormalizers));
		}
		for (const localPk of localPks) {
			if (!Array.isArray(localPk)) throw new StrandReadError('localPks', 'every local key must be an array of values');
			if (!onStrand.has(primaryKeyIdentity(localPk, pkNormalizers))) ops.push({ op: 'delete', pk: /** @type {any[]} */ (localPk) });
		}
		return ops;
	}

	async function close() {
		closed = true;
	}

	return Object.freeze({
		get db() {
			if (closed) throw new StrandReadError('reader', 'the reader is closed');
			const found = lookUp(memberNode, strandId);
			if (found !== state.object || !state.db) {
				throw new StrandReadError('strandDatabase', 'rebuilt: await reader.current() to prepare the new strand database', 'rebuilt');
			}
			return state.db;
		},
		current,
		readRows,
		close,
	});
}
