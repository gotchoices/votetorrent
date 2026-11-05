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
	STRAND_DB_WAIT_MS,
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
		waitMs: 2_000,
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

test('S9: no officer table key column declares a collation other than BINARY, so byte-exact identity matches the store', async () => {
	const { db } = await seededStore();
	try {
		/** @type {string[]} */
		const offenders = [];
		for (const table of OFFICER_SUBSCRIBED_TABLES) {
			const schema = db.schemaManager.getTable(db.schemaManager.getCurrentSchemaName(), table);
			if (!schema) {
				offenders.push(`${table} (missing from the local schema)`);
				continue;
			}
			for (const def of schema.primaryKeyDefinition) {
				const collation = def.collation ?? schema.columns[def.index].collation;
				if (collation !== undefined && String(collation).toUpperCase() !== 'BINARY') offenders.push(table);
			}
		}
		assert.deepEqual(offenders, []);
	} finally {
		await closeNetworkDb(db);
	}
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
	assert.equal(STRAND_DB_WAIT_MS, 120_000);
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
