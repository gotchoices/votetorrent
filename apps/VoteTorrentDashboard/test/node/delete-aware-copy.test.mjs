/**
 * delete-aware-copy.test.mjs -- behaviour contract for `src/peer/strand-read.js`, the officer strand
 * reader (66-13 Task 2).
 *
 * The LOCAL store is real: `attachLiveDb(hash, { create: true })` over fake-indexeddb, seeded by the
 * shared `seedFoundingAuthority` fixture, with a distinct network hash per test. The STRAND side is a
 * fake of cadre-core's `StrandDatabase` seam (`getTransactor`, `getDatabase`), whose Database's `eval`
 * yields row objects from a per-table map captured from the seeded store. The member node is a fake of
 * the 66-08 accessor `getStrandDatabase(strandId)`.
 *
 * One group (O7) hands the reader a REAL in-memory Quereus Database carrying only the Optimystic
 * crypto plugin, the way cadre-core's database arrives, and proves the reader puts vote-engine's own
 * SQL functions on it.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Database, registerPlugin } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import { attachLiveDb, closeNetworkDb, OFFICER_SUBSCRIBED_TABLES } from '@votetorrent/web-data/officer';
import { seedFoundingAuthority, SEED_TABLES, EXPECTED_COUNTS } from '../../../../packages/web-data/test/fixtures/seed-founding-authority.js';
import { dashboardSrc, moduleUrl } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../packages/web-data/test/lib/source-scan.mjs';
import {
	openOfficerStrandReader,
	StrandReadError,
	STRAND_READ_ROW_LIMIT,
	STRAND_DB_STALL_MS,
	STRAND_DB_CAP_MS,
	primaryKeyIdentity,
} from '../../src/peer/strand-read.js';

const STRAND_ID = 'strand-fixture-0123456789abcdef';
const SECRET = 'PLANTED-ROW-SECRET-MUST-NOT-ESCAPE-0123456789';

let hashCounter = 0;
/** A distinct network hash per test, so no two tests share an IndexedDB database. */
function nextHash() {
	hashCounter += 1;
	return `dacopy${hashCounter}x${Date.now().toString(36)}`;
}

/**
 * A call-recording spy.
 * @param {(...args: any[]) => any} [impl]
 */
function spy(impl = () => undefined) {
	/** @type {any[][]} */
	const calls = [];
	/** @type {any} */
	const fn = (/** @type {any[]} */ ...args) => {
		calls.push(args);
		return impl(...args);
	};
	fn.calls = calls;
	return fn;
}

/** @param {any} db @param {string} table */
function tableSchemaOf(db, table) {
	const schema = db.schemaManager.getTable(db.schemaManager.getCurrentSchemaName(), table);
	assert.ok(schema, 'the local schema lacks a table the test needs');
	return schema;
}

/** @param {any} db @param {string} table @returns {string[]} */
function pkNamesOf(db, table) {
	const schema = tableSchemaOf(db, table);
	return schema.primaryKeyDefinition.map((/** @type {any} */ d) => schema.columns[d.index].name);
}

/** @param {any} db @param {string} table @returns {Promise<Record<string, any>[]>} */
async function captureRows(db, table) {
	const rows = [];
	for await (const row of db.eval(`select * from ${table}`)) rows.push({ ...row });
	return rows;
}

/** Local PK arrays in PK-definition order, read with the schema's primaryKeyDefinition. */
async function localPksOf(/** @type {any} */ db, /** @type {string} */ table) {
	const names = pkNamesOf(db, table);
	const rows = await captureRows(db, table);
	return rows.map((row) => names.map((n) => row[n]));
}

/** @param {any} db @param {string} table @returns {Promise<number>} */
async function countOf(db, table) {
	for await (const row of db.eval(`select count(*) as n from ${table}`)) return Number(/** @type {any} */ (row).n);
	return 0;
}

/** A seeded local store plus the strand row map captured from it. */
async function seededStore() {
	const hash = nextHash();
	const db = await attachLiveDb(hash, { create: true });
	await seedFoundingAuthority(db);
	/** @type {Map<string, Record<string, any>[]>} */
	const strandRows = new Map();
	for (const table of SEED_TABLES) strandRows.set(table, await captureRows(db, table));
	return { hash, db, strandRows };
}

/**
 * A fake cadre-core StrandDatabase. `eval` yields rows from `rowsByTable` for the table the query names.
 * @param {Map<string, Record<string, any>[]>} rowsByTable
 * @param {{ transactor?: string, evalImpl?: (table: string) => AsyncIterable<any> }} [opts]
 */
function makeFakeStrandDb(rowsByTable, opts = {}) {
	/** @type {string[]} */
	const evalCalls = [];
	const setSchemaPath = spy();
	const database = {
		setSchemaPath,
		eval: (/** @type {string} */ sql) => {
			evalCalls.push(sql);
			const match = /from\s+(\w+)/.exec(sql);
			const table = match ? match[1] : '';
			if (opts.evalImpl) return opts.evalImpl(table);
			return (async function* () {
				for (const row of rowsByTable.get(table) ?? []) yield row;
			})();
		},
	};
	const strandDatabase = {
		getTransactor: spy(() => opts.transactor ?? 'network'),
		getDatabase: spy(() => database),
		close: spy(async () => undefined),
	};
	return { strandDatabase, database, evalCalls, setSchemaPath };
}

/** A fake member node whose accessor returns whatever `holder.current` is. */
function makeMemberNode(/** @type {{ current: any }} */ holder) {
	return {
		getStrandDatabase: spy((/** @type {string} */ id) => (id === STRAND_ID ? holder.current : null)),
		waitForStrand: spy(async () => {
			throw new Error('the reader must never call waitForStrand');
		}),
	};
}

/** Deps that never wait on a real timer: sleep resolves at once, and the clock moves one poll per sleep. */
function fastDeps(/** @type {Record<string, any>} */ extra = {}) {
	let clock = 0;
	return {
		sleep: async (/** @type {number} */ ms) => {
			clock += ms;
		},
		now: () => clock,
		stallMs: 2_000,
		pollMs: 500,
		registerDbPlugins: async () => undefined,
		...extra,
	};
}

/** @param {() => Promise<any>} fn @param {string} subject */
async function rejectsWith(fn, subject) {
	await assert.rejects(fn, (/** @type {any} */ err) => {
		assert.ok(err instanceof StrandReadError, 'not a StrandReadError');
		assert.equal(err.subject, subject);
		return true;
	});
}

// ---------------------------------------------------------------------------
// readRows over a real local store
// ---------------------------------------------------------------------------

test('S1: identical sides give one upsert per strand row in the LOCAL column order, and no removal op', async () => {
	const { db, strandRows } = await seededStore();
	try {
		const fake = makeFakeStrandDb(strandRows);
		const reader = await openOfficerStrandReader({ memberNode: makeMemberNode({ current: fake.strandDatabase }), strandId: STRAND_ID, deps: fastDeps() });
		const localPks = await localPksOf(db, 'Officer');
		const ops = await reader.readRows('Officer', localPks, { uiDb: db });
		const columns = tableSchemaOf(db, 'Officer').columns;
		const expected = /** @type {Record<string, any>[]} */ (strandRows.get('Officer'));
		assert.equal(ops.length, expected.length);
		assert.ok(expected.length >= 1);
		ops.forEach((op, i) => {
			assert.equal(op.op, 'upsert');
			assert.deepEqual(/** @type {any} */ (op).row, columns.map((/** @type {any} */ c) => expected[i][c.name]));
		});
	} finally {
		await closeNetworkDb(db);
	}
});

test('S2 (D-02): a table emptied on the strand while the local copy holds a row gives exactly one removal op with the LOCAL pk', async () => {
	const { db, strandRows } = await seededStore();
	try {
		strandRows.set('Officer', []);
		const fake = makeFakeStrandDb(strandRows);
		const reader = await openOfficerStrandReader({ memberNode: makeMemberNode({ current: fake.strandDatabase }), strandId: STRAND_ID, deps: fastDeps() });
		const localPks = await localPksOf(db, 'Officer');
		assert.equal(localPks.length, 1);
		const ops = await reader.readRows('Officer', localPks, { uiDb: db });
		assert.deepEqual(ops, [{ op: 'delete', pk: localPks[0] }]);
		assert.equal(/** @type {any} */ (ops[0]).pk, localPks[0], 'the removal op must carry the local pk array verbatim');
	} finally {
		await closeNetworkDb(db);
	}
});

test('S3: a composite-key table whose strand row has a different key gives its upsert plus a removal of the local key', async () => {
	const { db, strandRows } = await seededStore();
	try {
		const table = SEED_TABLES.find((t) => tableSchemaOf(db, t).primaryKeyDefinition.length >= 2);
		assert.ok(table, 'no composite-key table among the seeded tables');
		const pkNames = pkNamesOf(db, table);
		const textKey = pkNames.find((n) => typeof (/** @type {any} */ (strandRows.get(table))[0][n]) === 'string');
		assert.ok(textKey, 'the composite key has no text column to vary');
		const local = /** @type {Record<string, any>[]} */ (strandRows.get(table))[0];
		strandRows.set(table, [{ ...local, [textKey]: `${local[textKey]}-other` }]);
		const fake = makeFakeStrandDb(strandRows);
		const reader = await openOfficerStrandReader({ memberNode: makeMemberNode({ current: fake.strandDatabase }), strandId: STRAND_ID, deps: fastDeps() });
		const localPks = await localPksOf(db, table);
		const ops = await reader.readRows(table, localPks, { uiDb: db });
		assert.equal(ops.length, 2);
		assert.equal(ops[0].op, 'upsert');
		assert.deepEqual(ops[1], { op: 'delete', pk: localPks[0] });
	} finally {
		await closeNetworkDb(db);
	}
});

test('S4: a table empty on both sides returns no ops', async () => {
	const { db, strandRows } = await seededStore();
	try {
		const table = OFFICER_SUBSCRIBED_TABLES.find((t) => !SEED_TABLES.includes(t) && tableSchemaOf(db, t).primaryKeyDefinition.length > 0);
		assert.ok(table);
		assert.equal(await countOf(db, table), 0);
		const fake = makeFakeStrandDb(strandRows);
		const reader = await openOfficerStrandReader({ memberNode: makeMemberNode({ current: fake.strandDatabase }), strandId: STRAND_ID, deps: fastDeps() });
		assert.deepEqual(await reader.readRows(table, [], { uiDb: db }), []);
	} finally {
		await closeNetworkDb(db);
	}
});

test('S5: a strand table above STRAND_READ_ROW_LIMIT rejects naming the table and the limit, never truncating', async () => {
	const { db, strandRows } = await seededStore();
	try {
		const fake = makeFakeStrandDb(strandRows, {
			evalImpl: () =>
				(async function* () {
					for (let i = 0; i < STRAND_READ_ROW_LIMIT + 1; i++) yield { Id: `r${i}` };
				})(),
		});
		const reader = await openOfficerStrandReader({ memberNode: makeMemberNode({ current: fake.strandDatabase }), strandId: STRAND_ID, deps: fastDeps() });
		await assert.rejects(
			() => reader.readRows('Officer', [], { uiDb: db }),
			(/** @type {any} */ err) =>
				err instanceof StrandReadError && err.subject === 'Officer' && err.message.includes(String(STRAND_READ_ROW_LIMIT)),
		);
	} finally {
		await closeNetworkDb(db);
	}
});

test('S6: an off-list table rejects before any strand read, and a missing uiDb or non-array localPks are refused by name', async () => {
	const { db, strandRows } = await seededStore();
	try {
		const fake = makeFakeStrandDb(strandRows);
		const reader = await openOfficerStrandReader({ memberNode: makeMemberNode({ current: fake.strandDatabase }), strandId: STRAND_ID, deps: fastDeps() });
		const offList = ['Zz', 'Not', 'Officer', 'Table'].join('');
		assert.ok(!OFFICER_SUBSCRIBED_TABLES.includes(offList));
		await assert.rejects(() => reader.readRows(offList, [], { uiDb: db }), StrandReadError);
		assert.equal(fake.evalCalls.length, 0, 'an off-list table reached the strand read');
		await rejectsWith(() => reader.readRows('Officer', [], /** @type {any} */ ({})), 'uiDb');
		await rejectsWith(() => reader.readRows('Officer', /** @type {any} */ ('x'), { uiDb: db }), 'localPks');
		assert.equal(fake.evalCalls.length, 0);
	} finally {
		await closeNetworkDb(db);
	}
});

test('S7 (R-10): a failing strand read is reduced to its error name, with no secret in the message or the log', async () => {
	const { db, strandRows } = await seededStore();
	const original = console.error;
	/** @type {any[][]} */
	const logged = [];
	console.error = (...args) => logged.push(args);
	try {
		const fake = makeFakeStrandDb(strandRows, {
			evalImpl: () =>
				(async function* () {
					const err = new Error(`${SECRET} constraint failed for value`);
					err.name = 'QuereusError';
					throw err;
				})(),
		});
		const reader = await openOfficerStrandReader({ memberNode: makeMemberNode({ current: fake.strandDatabase }), strandId: STRAND_ID, deps: fastDeps() });
		await assert.rejects(
			() => reader.readRows('Officer', [], { uiDb: db }),
			(/** @type {any} */ err) => {
				assert.ok(err instanceof StrandReadError);
				assert.ok(err.message.includes('QuereusError'));
				assert.ok(!err.message.includes(SECRET));
				return true;
			},
		);
		assert.ok(!JSON.stringify(logged).includes(SECRET));
	} finally {
		console.error = original;
		await closeNetworkDb(db);
	}
});

test('S8: primaryKeyIdentity is type-tagged, order-sensitive and name-only on an unsupported value', () => {
	assert.equal(primaryKeyIdentity([5]), primaryKeyIdentity([5n]));
	assert.notEqual(primaryKeyIdentity([5]), primaryKeyIdentity(['5']));
	assert.equal(primaryKeyIdentity([new Uint8Array([1, 2, 255])]), primaryKeyIdentity([new Uint8Array([1, 2, 255])]));
	assert.notEqual(primaryKeyIdentity([new Uint8Array([1, 2])]), primaryKeyIdentity([new Uint8Array([1, 3])]));
	assert.notEqual(primaryKeyIdentity([null]), primaryKeyIdentity(['']));
	assert.notEqual(primaryKeyIdentity(['a', 'b']), primaryKeyIdentity(['b', 'a']));
	assert.notEqual(primaryKeyIdentity([1.5]), primaryKeyIdentity([1]));
	assert.throws(
		() => primaryKeyIdentity([{ secret: SECRET }]),
		(/** @type {any} */ err) => err instanceof StrandReadError && err.message.includes('object') && !err.message.includes(SECRET),
	);
});

// S9 used to assert every officer key column was BINARY. It never was: the store keys a text primary key that
// declares no collation under its default, NOCASE (64 key columns here). Quereus before 5.2 left
// primaryKeyDefinition saying BINARY while the column and the key bytes said NOCASE, and S9 read the stale
// field. From 5.2 the two agree (quereus SCH-006), so the identity now follows the key column's collation.
test('S9: every officer key column resolves to a key normalizer, and its definition agrees with its column', async () => {
	const { db } = await seededStore();
	try {
		const resolve = db.getKeyNormalizerResolver();
		/** @type {string[]} */
		const offenders = [];
		/** @type {Set<string>} */
		const seen = new Set();
		for (const table of OFFICER_SUBSCRIBED_TABLES) {
			const schema = db.schemaManager.getTable(db.schemaManager.getCurrentSchemaName(), table);
			if (!schema) {
				offenders.push(`${table} (missing from the local schema)`);
				continue;
			}
			for (const def of schema.primaryKeyDefinition) {
				const column = schema.columns[def.index];
				const collation = String(column.collation ?? 'BINARY').toUpperCase();
				seen.add(collation);
				if (String(def.collation ?? 'BINARY').toUpperCase() !== collation) offenders.push(`${table}.${column.name} definition`);
				try {
					resolve(collation);
				} catch {
					offenders.push(`${table}.${column.name} ${collation}`);
				}
			}
		}
		assert.deepEqual(offenders, []);
		assert.ok(seen.has('NOCASE'), 'the store keys at least one officer text key NOCASE (its default)');
	} finally {
		await closeNetworkDb(db);
	}
});

test('S10: a strand key that differs from the local key only in case is the same row: one upsert, no removal', async () => {
	const { db, strandRows } = await seededStore();
	try {
		const resolve = db.getKeyNormalizerResolver();
		/** @type {{ table: string, name: string } | undefined} */
		let pick;
		for (const table of SEED_TABLES) {
			const schema = tableSchemaOf(db, table);
			const row = /** @type {Record<string, any>[]} */ (strandRows.get(table))[0];
			if (!row) continue;
			for (const def of schema.primaryKeyDefinition) {
				const column = schema.columns[def.index];
				const value = row[column.name];
				if (String(column.collation).toUpperCase() === 'NOCASE' && typeof value === 'string' && value.toUpperCase() !== value) {
					pick = { table, name: column.name };
					break;
				}
			}
			if (pick) break;
		}
		assert.ok(pick, 'no seeded NOCASE text key with a lower-case letter to flip');
		const local = /** @type {Record<string, any>[]} */ (strandRows.get(pick.table))[0];
		const flipped = String(local[pick.name]).toUpperCase();
		assert.equal(resolve('NOCASE')(flipped), resolve('NOCASE')(local[pick.name]), 'the store treats the two keys as one');
		let found = 0;
		for await (const _ of db.eval(`select 1 from ${pick.table} where ${pick.name} = ?`, [flipped])) found += 1;
		assert.ok(found >= 1, 'positive control: the store finds the local row by the case-flipped key');

		strandRows.set(pick.table, [{ ...local, [pick.name]: flipped }]);
		const fake = makeFakeStrandDb(strandRows);
		const reader = await openOfficerStrandReader({ memberNode: makeMemberNode({ current: fake.strandDatabase }), strandId: STRAND_ID, deps: fastDeps() });
		const localPks = await localPksOf(db, pick.table);
		assert.equal(localPks.length, 1);
		const ops = await reader.readRows(pick.table, localPks, { uiDb: db });
		assert.deepEqual(ops.map((op) => op.op), ['upsert'], `a case-only key change in ${pick.table}.${pick.name} must not remove the row it upserts`);
	} finally {
		await closeNetworkDb(db);
	}
});

test('S11: primaryKeyIdentity applies a per-position normalizer to text only, and refuses a length mismatch by name', () => {
	const lower = (/** @type {string} */ s) => s.toLowerCase();
	const exact = (/** @type {string} */ s) => s;
	assert.equal(primaryKeyIdentity(['AbC', 'x'], [lower, exact]), primaryKeyIdentity(['abc', 'x'], [lower, exact]));
	assert.notEqual(primaryKeyIdentity(['a', 'X'], [lower, exact]), primaryKeyIdentity(['a', 'x'], [lower, exact]));
	assert.notEqual(primaryKeyIdentity(['AbC']), primaryKeyIdentity(['abc']), 'without normalizers text stays exact');
	assert.equal(primaryKeyIdentity([5], [lower]), primaryKeyIdentity([5n], [lower]));
	assert.throws(
		() => primaryKeyIdentity(['a', 'b'], [lower]),
		(/** @type {any} */ err) => err instanceof StrandReadError && err.message.includes('normalizer'),
	);
});

// ---------------------------------------------------------------------------
// The opener and the db getter
// ---------------------------------------------------------------------------

test('O1: the open resolves once the strand database is published (third poll), with the schema path set', async () => {
	const fake = makeFakeStrandDb(new Map());
	let polls = 0;
	const memberNode = {
		getStrandDatabase: () => {
			polls += 1;
			return polls >= 3 ? fake.strandDatabase : null;
		},
		waitForStrand: spy(),
	};
	const reader = await openOfficerStrandReader({ memberNode, strandId: STRAND_ID, deps: fastDeps() });
	assert.equal(polls, 3);
	assert.deepEqual(fake.setSchemaPath.calls, [[['App', 'main']]]);
	assert.equal(reader.db, fake.database);
	assert.equal(STRAND_DB_STALL_MS, 60_000);
	assert.equal(STRAND_DB_CAP_MS, 600_000);
});

test('O2: the open refuses by name on timeout, abort, a missing accessor and an empty strand id', async () => {
	await rejectsWith(() => openOfficerStrandReader({ memberNode: makeMemberNode({ current: null }), strandId: STRAND_ID, deps: fastDeps() }), 'strandDatabase');
	const controller = new AbortController();
	controller.abort();
	await rejectsWith(
		() => openOfficerStrandReader({ memberNode: makeMemberNode({ current: null }), strandId: STRAND_ID, signal: controller.signal, deps: fastDeps() }),
		'signal',
	);
	await rejectsWith(() => openOfficerStrandReader({ memberNode: /** @type {any} */ ({}), strandId: STRAND_ID, deps: fastDeps() }), 'memberNode');
	await rejectsWith(() => openOfficerStrandReader({ memberNode: makeMemberNode({ current: null }), strandId: '', deps: fastDeps() }), 'strandId');
	await rejectsWith(() => openOfficerStrandReader(), 'memberNode');
});

test('O3: a strand database that does not read through the network transactor is refused and never closed', async () => {
	const fake = makeFakeStrandDb(new Map(), { transactor: 'local' });
	await rejectsWith(() => openOfficerStrandReader({ memberNode: makeMemberNode({ current: fake.strandDatabase }), strandId: STRAND_ID, deps: fastDeps() }), 'transactor');
	assert.equal(fake.strandDatabase.close.calls.length, 0);
});

test('O4: close() is idempotent, never closes cadre-core database, and a later readRows is refused', async () => {
	const { db, strandRows } = await seededStore();
	try {
		const fake = makeFakeStrandDb(strandRows);
		const reader = await openOfficerStrandReader({ memberNode: makeMemberNode({ current: fake.strandDatabase }), strandId: STRAND_ID, deps: fastDeps() });
		await reader.close();
		await reader.close();
		assert.equal(fake.strandDatabase.close.calls.length, 0);
		await rejectsWith(() => reader.readRows('Officer', [], { uiDb: db }), 'reader');
	} finally {
		await closeNetworkDb(db);
	}
});

test('O5: a rebuilt strand database is re-asserted, re-pathed and read; a vanished one is refused after the wait with the local copy unchanged', async () => {
	const { db, strandRows } = await seededStore();
	try {
		const first = makeFakeStrandDb(strandRows);
		const second = makeFakeStrandDb(strandRows);
		const holder = { current: /** @type {any} */ (first.strandDatabase) };
		const register = spy(async () => undefined);
		const reader = await openOfficerStrandReader({ memberNode: makeMemberNode(holder), strandId: STRAND_ID, deps: fastDeps({ registerDbPlugins: register }) });
		holder.current = second.strandDatabase;
		const localPks = await localPksOf(db, 'Officer');
		await reader.readRows('Officer', localPks, { uiDb: db });
		assert.equal(first.evalCalls.length, 0);
		assert.equal(second.evalCalls.length, 1);
		assert.ok(second.strandDatabase.getTransactor.calls.length >= 1);
		assert.deepEqual(second.setSchemaPath.calls, [[['App', 'main']]]);
		assert.equal(register.calls.length, 2, 'one registration per Database object');

		holder.current = null;
		await rejectsWith(() => reader.readRows('Officer', localPks, { uiDb: db }), 'strandDatabase');
		for (const [table, count] of Object.entries(EXPECTED_COUNTS)) assert.equal(await countOf(db, table), count);
	} finally {
		await closeNetworkDb(db);
	}
});

test('O10: the db getter re-resolves on every access, and current() prepares a rebuilt database', async () => {
	const first = makeFakeStrandDb(new Map());
	const second = makeFakeStrandDb(new Map());
	const holder = { current: /** @type {any} */ (null) };
	let polls = 0;
	const memberNode = {
		getStrandDatabase: () => {
			polls += 1;
			// Null on the first two polls after waitForStrand: the strand header arrives late.
			return polls <= 2 ? null : holder.current;
		},
	};
	holder.current = first.strandDatabase;
	const register = spy(async () => undefined);
	const reader = await openOfficerStrandReader({ memberNode, strandId: STRAND_ID, deps: fastDeps({ registerDbPlugins: register }) });
	assert.equal(polls, 3);
	assert.equal(reader.db, first.database);

	holder.current = null;
	assert.throws(() => reader.db, (/** @type {any} */ err) => err instanceof StrandReadError && err.subject === 'strandDatabase');
	holder.current = first.strandDatabase;
	assert.equal(reader.db, first.database);
	assert.equal(register.calls.length, 1, 'restoring the same object must not register again');

	holder.current = second.strandDatabase;
	assert.throws(() => reader.db, (/** @type {any} */ err) => err instanceof StrandReadError && err.subject === 'strandDatabase' && err.code === 'rebuilt');
	assert.equal(await reader.current(), second.database);
	assert.equal(reader.db, second.database);
	assert.equal(register.calls.length, 2);
	assert.deepEqual(second.setSchemaPath.calls, [[['App', 'main']]]);
});

test('O7 (66-14 item 4): vote-engine SQL functions resolve on the reader db; once per Database; a registration throw is refused by name', async () => {
	/** @param {any} db */
	async function callP256(db) {
		const rows = [];
		for await (const row of db.eval(`select SignatureValidP256('a', 'b', 'c') as v`)) rows.push(row);
		return rows;
	}
	const strandSideDb = new Database();
	await registerPlugin(strandSideDb, cryptoPlugin, { algorithm: 'sha256', encoding: 'base64url' });
	const strandDatabase = { getTransactor: () => 'network', getDatabase: () => strandSideDb };
	const reader = await openOfficerStrandReader({ memberNode: makeMemberNode({ current: strandDatabase }), strandId: STRAND_ID });
	const rows = await callP256(reader.db);
	assert.equal(rows.length, 1, 'the vote-engine function did not resolve on the reader db');

	// Control: the same query on a database that skipped registration fails as an unknown function.
	const bare = new Database();
	await registerPlugin(bare, cryptoPlugin, { algorithm: 'sha256', encoding: 'base64url' });
	await assert.rejects(() => callP256(bare), (/** @type {any} */ err) => /SignatureValidP256|function/i.test(String(err?.message)));

	// Once per Database object across several reads; once more for a rebuilt one.
	const { db, strandRows } = await seededStore();
	try {
		const one = makeFakeStrandDb(strandRows);
		const two = makeFakeStrandDb(strandRows);
		const holder = { current: one.strandDatabase };
		const register = spy(async () => undefined);
		const r2 = await openOfficerStrandReader({ memberNode: makeMemberNode(holder), strandId: STRAND_ID, deps: fastDeps({ registerDbPlugins: register }) });
		await r2.readRows('Officer', [], { uiDb: db });
		await r2.readRows('User', [], { uiDb: db });
		await r2.readRows('Admin', [], { uiDb: db });
		assert.equal(register.calls.length, 1);
		holder.current = two.strandDatabase;
		await r2.readRows('Officer', [], { uiDb: db });
		assert.equal(register.calls.length, 2);
	} finally {
		await closeNetworkDb(db);
	}

	const failing = makeFakeStrandDb(new Map());
	await rejectsWith(
		() =>
			openOfficerStrandReader({
				memberNode: makeMemberNode({ current: failing.strandDatabase }),
				strandId: STRAND_ID,
				deps: fastDeps({
					registerDbPlugins: async () => {
						throw new Error(SECRET);
					},
				}),
			}),
		'functions',
	);
});

test('O8 (66-14 item 4): the reader never calls waitForStrand across open, readRows and close', async () => {
	const { db, strandRows } = await seededStore();
	try {
		const fake = makeFakeStrandDb(strandRows);
		const memberNode = makeMemberNode({ current: fake.strandDatabase });
		const reader = await openOfficerStrandReader({ memberNode, strandId: STRAND_ID, deps: fastDeps() });
		await reader.readRows('Officer', await localPksOf(db, 'Officer'), { uiDb: db });
		await reader.current();
		await reader.close();
		assert.equal(memberNode.waitForStrand.calls.length, 0);
	} finally {
		await closeNetworkDb(db);
	}
});

test('O9 (66-14 item 4): importing the module has no side effects', () => {
	const url = moduleUrl(dashboardSrc('peer', 'strand-read.js'));
	const code = `delete globalThis.indexedDB; delete globalThis.BroadcastChannel; await import(${JSON.stringify(url)});`;
	const env = { ...process.env };
	delete env.FORCE_COLOR;
	const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env });
	assert.equal(child.status, 0, 'the import exited non-zero');
	assert.equal(child.stdout, '');
	assert.equal(child.stderr, '');

	const stripped = stripComments(readFileSync(dashboardSrc('peer', 'strand-read.js'), 'utf8'));
	const lines = stripped.split('\n');
	assert.equal(lines.filter((l) => /^await\b/.test(l)).length, 0, 'a top-level await');
	assert.equal(lines.filter((l) => /^\S.*registerDbPlugins\(/.test(l)).length, 0, 'a registration call at module scope');
});

test('O6: the comment-stripped source reads only through the accessor and names none of the banned tokens', () => {
	const stripped = stripComments(readFileSync(dashboardSrc('peer', 'strand-read.js'), 'utf8'));
	const banned = [
		['wait', 'For', 'Strand'].join(''),
		['new ', 'Strand', 'Database'].join(''),
		['apply', 'External', 'Row', 'Changes'].join(''),
		['ingest', 'External', 'Row', 'Changes'].join(''),
		['attach', 'Live', 'Db'].join(''),
		['open', 'Store', 'Handle'].join(''),
		['setDefault', 'Vtab', 'Name'].join(''),
		['.clo', 'se()'].join(''),
	];
	for (const token of banned) assert.ok(!stripped.includes(token), 'a banned token is in the source');
	for (const token of ['getStrandDatabase', 'getTransactor', 'registerDbPlugins', 'STRAND_READ_ROW_LIMIT']) {
		assert.ok(stripped.includes(token), 'a required token is missing from the source');
	}
	assert.doesNotMatch(stripped, /\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i);
});

// ---------------------------------------------------------------------------
// G-3: the progress-aware wait for the strand database (stall window + hard cap)
// ---------------------------------------------------------------------------

const REPO_PROTOCOL = `/optimystic/strand-${STRAND_ID}/repo/1.0.0`;
const PING_PROTOCOL = `/optimystic/strand-${STRAND_ID}/fret/1.0.0/ping`;

/**
 * A fake libp2p stream: a real EventTarget with a protocol. `finish(error)` fires its one `close` event,
 * with `error` set the way libp2p's StreamCloseEvent carries it for an abort or a reset.
 * @param {string} protocol
 */
function fakeStream(protocol) {
	const stream = /** @type {any} */ (new EventTarget());
	stream.protocol = protocol;
	stream.finish = (/** @type {Error | undefined} */ error) => {
		const event = /** @type {any} */ (new Event('close'));
		if (error) event.error = error;
		stream.dispatchEvent(event);
	};
	return stream;
}

/**
 * A strand node the build is talking to. Each exchange is one stream that is open for one poll and then
 * closes (cleanly unless `closeWith` says otherwise); `push()` lands a block through the store's feed.
 * @param {{ protocol?: string, closeWith?: () => Error | undefined }} [opts]
 */
function makeStrandWire(opts = {}) {
	/** @type {any[]} */
	let open = [];
	/** @type {Set<() => void>} */
	const feed = new Set();
	const node = {
		getConnections: () => [{ streams: [...open] }],
		storageRepo: {
			onAnyCollectionChange: (/** @type {() => void} */ cb) => {
				feed.add(cb);
				return () => feed.delete(cb);
			},
		},
	};
	return {
		node,
		feed,
		/** Close what is open (each one exchange done), then open the next request. */
		exchange() {
			for (const stream of open) stream.finish(opts.closeWith?.());
			open = [fakeStream(opts.protocol ?? REPO_PROTOCOL)];
		},
		push() {
			for (const cb of [...feed]) cb();
		},
		get open() {
			return open;
		},
	};
}

/**
 * A fake clock world. `script(clockMs)` runs after every poll's sleep; the database appears at `dbAtMs`.
 * @param {{ dbAtMs?: number, script?: (clock: number, wire: ReturnType<typeof makeStrandWire>) => void, wire?: ReturnType<typeof makeStrandWire> | null, deps?: Record<string, any> }} opts
 */
function makeWaitWorld({ dbAtMs = Number.POSITIVE_INFINITY, script = () => undefined, wire = makeStrandWire(), deps = {} }) {
	const fake = makeFakeStrandDb(new Map());
	const world = { clock: 0, sleeps: 0 };
	const memberNode = {
		getStrandDatabase: (/** @type {string} */ id) => (id === STRAND_ID && world.clock >= dbAtMs ? fake.strandDatabase : null),
		...(wire ? { getStrandNode: () => wire.node } : {}),
	};
	const open = () =>
		openOfficerStrandReader({
			memberNode,
			strandId: STRAND_ID,
			deps: {
				sleep: async (/** @type {number} */ ms) => {
					world.clock += ms;
					world.sleeps += 1;
					if (wire) script(world.clock, wire);
				},
				now: () => world.clock,
				pollMs: 500,
				registerDbPlugins: async () => undefined,
				...deps,
			},
		});
	return { world, fake, open, wire };
}

/** @param {() => Promise<any>} fn @param {RegExp} reason */
async function rejectsTimeout(fn, reason) {
	await assert.rejects(fn, (/** @type {any} */ err) => {
		assert.ok(err instanceof StrandReadError, 'not a StrandReadError');
		assert.equal(err.subject, 'strandDatabase');
		assert.equal(err.code, 'timeout');
		assert.match(err.reason, reason);
		return true;
	});
}

/** Test (1)'s world: a build answering one block request every 2 s, its database published at 300 s. */
function slowBuildWorld(/** @type {Record<string, any>} */ deps = {}) {
	return makeWaitWorld({ dbAtMs: 300_000, script: (clock, wire) => clock % 2_000 === 0 && wire.exchange(), deps });
}

test('W1 (G-3): a build that keeps receiving data is waited for past 120 s, and opens when its database appears', async () => {
	const { world, fake, open } = slowBuildWorld();
	const reader = await open();
	assert.equal(reader.db, fake.database);
	assert.ok(world.clock > 120_000, 'the wait did not run past the old fixed 120 s');
	assert.equal(world.clock, 300_000);
});

test('W1 positive control: the old fixed 120 s deadline (stall window = cap = 120 s) refuses the same build', async () => {
	const { world, open } = slowBuildWorld({ stallMs: 120_000, capMs: 120_000 });
	await rejectsTimeout(open, /hard cap/);
	assert.equal(world.clock, 120_000);
});

test('W1b (G-3): blocks landing through the store feed alone are progress too', async () => {
	const { world, open } = makeWaitWorld({ dbAtMs: 250_000, script: (clock, wire) => clock % 5_000 === 0 && wire.push() });
	await open();
	assert.equal(world.clock, 250_000);
});

test('W2 (G-3): a build that stops receiving fails at the stall window after its last progress, by name', async () => {
	const { world, open, wire } = makeWaitWorld({ script: (clock, w) => clock <= 100_000 && clock % 2_000 === 0 && w.exchange() });
	await rejectsTimeout(open, /stall window/);
	// The exchange at 100 s closed the request opened at 98 s (the last progress) and opened one that never
	// closes; the stall window runs from 100 s.
	assert.equal(world.clock, 100_000 + STRAND_DB_STALL_MS);
	assert.equal(wire?.feed.size, 0, 'the store feed is still subscribed after the wait ended');
});

test('W2b (G-3): no strand node, unanswered requests and liveness pings are not progress; each fails at the stall window', async () => {
	const none = makeWaitWorld({ wire: null });
	await rejectsTimeout(none.open, /stall window/);
	assert.equal(none.world.clock, STRAND_DB_STALL_MS);

	const timedOut = makeWaitWorld({
		wire: makeStrandWire({ closeWith: () => new Error('response timeout') }),
		script: (clock, w) => clock % 2_000 === 0 && w.exchange(),
	});
	await rejectsTimeout(timedOut.open, /stall window/);
	assert.equal(timedOut.world.clock, STRAND_DB_STALL_MS);

	const pings = makeWaitWorld({ wire: makeStrandWire({ protocol: PING_PROTOCOL }), script: (clock, w) => clock % 2_000 === 0 && w.exchange() });
	await rejectsTimeout(pings.open, /stall window/);
	assert.equal(pings.world.clock, STRAND_DB_STALL_MS);
});

test('W3 (G-3): the hard cap ends a wait that only trickles, however steadily', async () => {
	// A request opened at the first poll, then one answered every 50 s: always inside the 60 s stall
	// window, never a database.
	const { world, open } = makeWaitWorld({ script: (clock, w) => (clock === 500 || clock % 50_000 === 0) && w.exchange() });
	await rejectsTimeout(open, /hard cap/);
	assert.equal(world.clock, STRAND_DB_CAP_MS);
});

test('W3b (G-3): the stall window and the cap are injectable through deps', async () => {
	const stall = makeWaitWorld({ deps: { stallMs: 5_000 } });
	await rejectsTimeout(stall.open, /stall window/);
	assert.equal(stall.world.clock, 5_000);
	const cap = makeWaitWorld({ script: (clock, w) => w.exchange(), deps: { capMs: 7_000 } });
	await rejectsTimeout(cap.open, /hard cap/);
	assert.equal(cap.world.clock, 7_000);
});

test('W4 (G-3): the open resolves on the first poll that finds the database, with no further sleep', async () => {
	const { world, open } = makeWaitWorld({ dbAtMs: 200_250, script: (clock, w) => clock % 2_000 === 0 && w.exchange() });
	await open();
	assert.equal(world.clock, 200_500, 'not the first poll at or after the database appeared');
	assert.equal(world.sleeps, 200_500 / 500);
	const published = makeWaitWorld({ dbAtMs: 0 });
	await published.open();
	assert.equal(published.world.sleeps, 0, 'a published database still slept');
	assert.equal(published.wire?.feed.size, 0, 'a published database still subscribed the store feed');
});

test('W5 (G-3): no timer, store subscription or counting outlives the wait (real timers)', async () => {
	const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
	const before = timers();
	const fake = makeFakeStrandDb(new Map());
	/** @param {{ dbAfterMs?: number, signal?: AbortSignal }} opts */
	const run = async ({ dbAfterMs = Number.POSITIVE_INFINITY, signal }) => {
		const wire = makeStrandWire();
		wire.exchange();
		const started = Date.now();
		const memberNode = {
			getStrandDatabase: () => (Date.now() - started >= dbAfterMs ? fake.strandDatabase : null),
			getStrandNode: () => wire.node,
		};
		const outcome = openOfficerStrandReader({
			memberNode,
			strandId: STRAND_ID,
			signal,
			deps: { stallMs: 120, capMs: 2_000, pollMs: 10, registerDbPlugins: async () => undefined },
		}).then(
			(reader) => ({ ok: true, reader }),
			(err) => ({ ok: false, err }),
		);
		return { wire, outcome };
	};

	const success = await run({ dbAfterMs: 40 });
	assert.equal((await success.outcome).ok, true);
	const stalled = await run({});
	const stalledOutcome = /** @type {any} */ (await stalled.outcome);
	assert.equal(stalledOutcome.ok, false);
	assert.equal(stalledOutcome.err.code, 'timeout');
	const controller = new AbortController();
	const cancelled = await run({ signal: controller.signal });
	setTimeout(() => controller.abort(), 30);
	const cancelledOutcome = /** @type {any} */ (await cancelled.outcome);
	assert.equal(cancelledOutcome.err.subject, 'signal');

	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(timers(), before, 'a timer outlived the wait');
	for (const { wire } of [success, stalled, cancelled]) {
		assert.equal(wire.feed.size, 0, 'the store feed is still subscribed');
		// A stream still open when the wait ended closes later: its listener must neither throw nor count.
		assert.doesNotThrow(() => wire.exchange());
	}
});
