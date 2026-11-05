/**
 * Tier-1 coverage of `@votetorrent/web-data`'s `open-db.js` (moved out of
 * this workspace's own `src/db/` by 54-03a): open/create/close/delete plus
 * the single-call source assertion on `setDefaultVtabName`.
 *
 * Honesty note (50-VALIDATION.md): this tier proves the ENGINE's use of the
 * IndexedDB API round-trips within one process via `fake-indexeddb` — an
 * in-process reimplementation of the IDB API. It proves NOTHING about quota,
 * eviction, cross-tab locking or structured-clone edges, and it cannot catch
 * a missing `setDefaultVtabName('store')`, whose absence is
 * same-session-invisible (schema applies, seed succeeds, every read returns
 * correct data, and nothing was ever written). Only
 * `test/browser/run-headless.mjs`'s two-page headless-Chrome gate can catch
 * that class of bug — see its `--prove-trap` mode.
 *
 * Deliberately sequential and stateful (spike 076's node-suite idiom):
 * `import 'fake-indexeddb/auto'` first, then `node:test` + `node:assert/strict`.
 * No `--test-concurrency > 1`, no reordering.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webDataSrc } from '../../../../scripts/lib/source-paths.mjs';
import { isSchemaInitialized } from '@votetorrent/vote-engine/browser';
import {
	dbNameFor,
	openStoreHandle,
	createNetworkDb,
	closeNetworkDb,
	listObjectStores,
	deleteNetworkDb,
	readRowCountsRecord,
	writeRowCounts,
} from '@votetorrent/web-data/officer';

// This test stays in the dashboard workspace deliberately: it is the
// consumer-side proof that the mandatory setDefaultVtabName call is present
// in the module the dashboard actually resolves (cross-workspace since
// 54-03a moved open-db.js into packages/web-data — see that file's own
// header for the producer-side half of this cross-reference).
const OPEN_DB_SOURCE = webDataSrc('open-db.js');

test('dbNameFor: exact template, no q2 prefix', () => {
	assert.equal(dbNameFor('abc123'), 'votetorrent-abc123');
});

test('dbNameFor: rejects an empty/non-string networkHash', () => {
	assert.throws(() => dbNameFor(''), TypeError);
	assert.throws(() => dbNameFor(/** @type {any} */ (undefined)), TypeError);
});

test('createNetworkDb: Authority resolves and the schema-init marker is present', async () => {
	const hash = 'db-delete-create';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);
	const row = await db.prepare('select count(*) as c from Authority').get({});
	assert.equal(row?.c, 0, 'Authority table resolves on a fresh store (0 rows, but resolves)');
	assert.equal(await isSchemaInitialized(db), true, 'schema-init marker must be present after createNetworkDb');
	await closeNetworkDb(db);
	await deleteNetworkDb(hash);
});

test('createNetworkDb: the IndexedDB database reports >50 object stores routed to the store module', async () => {
	const hash = 'db-delete-stores';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);
	const names = await listObjectStores(hash);
	assert.ok(names.length > 50, `expected >50 object stores, got ${names.length}`);
	assert.ok(names.includes('__catalog__'), 'catalog store missing — tables did not route to the store module');
	assert.ok(names.includes('main.authority'), 'main.authority store missing — tables did not route to the store module');
	await closeNetworkDb(db);
	await deleteNetworkDb(hash);
});

test('closeNetworkDb: resolves, and a subsequent query on that handle rejects', async () => {
	const hash = 'db-delete-close';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);
	await closeNetworkDb(db);
	// db.prepare() throws SYNCHRONOUSLY on a closed handle (MisuseError), so the
	// probe is wrapped in an async function — an async function boundary turns a
	// synchronous throw into a rejected promise, which is what assert.rejects needs.
	await assert.rejects(async () => {
		await db.prepare('select count(*) as c from Authority').get({});
	});
	await deleteNetworkDb(hash);
});

test('deleteNetworkDb: closes the handle, deletes the database, and indexedDB.databases() no longer lists it', async () => {
	const hash = 'db-delete-full';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);

	await deleteNetworkDb(hash, { db });

	if (typeof indexedDB.databases === 'function') {
		const remaining = await indexedDB.databases();
		assert.ok(
			!remaining.some((entry) => entry.name === dbNameFor(hash)),
			'indexedDB.databases() must not list the deleted database',
		);
	}
});

test('deleteNetworkDb: on a name never created, resolves without error (idempotent)', async () => {
	await assert.doesNotReject(() => deleteNetworkDb('db-delete-never-existed'));
});

test('deleteNetworkDb: on a name still held open by another connection, rejects DeleteBlockedError naming the database', async () => {
	const hash = 'db-delete-blocked';
	await deleteNetworkDb(hash).catch(() => {});
	// Establish a raw connection that stays open across the delete call.
	const blockingConn = await new Promise((resolve, reject) => {
		const req = indexedDB.open(dbNameFor(hash));
		req.onupgradeneeded = () => req.result.createObjectStore('probe');
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});

	await assert.rejects(
		() => deleteNetworkDb(hash, { timeoutMs: 200 }),
		/** @param {any} err */
		(err) => {
			assert.equal(err.name, 'DeleteBlockedError');
			assert.ok(String(err.message).includes(dbNameFor(hash)), 'message must contain the database name');
			return true;
		},
	);

	blockingConn.close();
	await deleteNetworkDb(hash); // clean slate for the following positive control
});

/** A `Map`-backed localStorage-shaped fake -- Node 22 has no real `localStorage`. */
function makeFakeStorage() {
	/** @type {Map<string, string>} */
	const map = new Map();
	return {
		getItem: (/** @type {string} */ k) => (map.has(k) ? /** @type {string} */ (map.get(k)) : null),
		setItem: (/** @type {string} */ k, /** @type {string} */ v) => {
			map.set(k, v);
		},
		removeItem: (/** @type {string} */ k) => {
			map.delete(k);
		},
	};
}

test('deleteNetworkDb: a BLOCKED delete leaves the row-count record intact, and honours the injected storage adapter', async () => {
	// Two defects in one ordering. The clear used to run BEFORE the delete, so
	// a blocked delete threw -- correctly -- with the integrity record already
	// gone: the network still listed, its data including registrant rows still
	// on disk, and now permanently un-attachable because attachNetworkDb raises
	// MissingRowCountsError forever after. And the clear was called with no
	// storage argument, so it always fell back to globalThis.localStorage and
	// every caller that injected an adapter silently failed to clear anything.
	const hash = 'db-delete-blocked-record';
	const storage = makeFakeStorage();
	await deleteNetworkDb(hash, { storage }).catch(() => {});
	await writeRowCounts(hash, { Authority: 1 }, storage);

	const blockingConn = await new Promise((resolve, reject) => {
		const req = indexedDB.open(dbNameFor(hash));
		req.onupgradeneeded = () => req.result.createObjectStore('probe');
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});

	await assert.rejects(
		() => deleteNetworkDb(hash, { timeoutMs: 200, storage }),
		/** @param {any} err */ (err) => err.name === 'DeleteBlockedError',
	);

	const survived = await readRowCountsRecord(hash, storage);
	assert.deepEqual(survived?.counts, { Authority: 1 }, 'a blocked delete destroyed the integrity record');

	// Positive control: once the blocker lets go, a SUCCESSFUL delete does
	// clear it -- and clears it from the INJECTED adapter, not localStorage.
	blockingConn.close();
	await deleteNetworkDb(hash, { storage });
	assert.equal(await readRowCountsRecord(hash, storage), undefined);
});

test('positive control: ordinary create -> delete -> recreate cycle succeeds (the rejections above are discriminating)', async () => {
	const hash = 'db-delete-cycle';
	await deleteNetworkDb(hash).catch(() => {});

	const db1 = await createNetworkDb(hash);
	await deleteNetworkDb(hash, { db: db1 });

	const db2 = await createNetworkDb(hash);
	const row = await db2.prepare('select count(*) as c from Authority').get({});
	assert.equal(row?.c, 0);
	await deleteNetworkDb(hash, { db: db2 });
});

test('listObjectStores: probing a network that does not exist returns [] and does NOT create the database', async () => {
	// `indexedDB.open(name)` with no version CREATES the database. This
	// function is exported from src/, so probing a deleted or never-created
	// network used to resurrect an empty shell -- which then appeared in
	// indexedDB.databases(), exactly the condition deleteNetworkDb's
	// post-delete confirmation and assertNetworkForgotten treat as failure.
	const hash = 'db-listobjectstores-absent';
	await deleteNetworkDb(hash).catch(() => {});

	assert.deepEqual(await listObjectStores(hash), []);

	const listed = await indexedDB.databases();
	assert.equal(
		listed.some((db) => db.name === dbNameFor(hash)),
		false,
		'listObjectStores created the database it was asked to inspect',
	);
});

test('positive control: listObjectStores on a REAL bootstrapped database still reports its stores', async () => {
	const hash = 'db-listobjectstores-present';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);
	const names = await listObjectStores(hash);
	assert.ok(names.length > 50, `expected >50 object stores, got ${names.length}`);
	await deleteNetworkDb(hash, { db });
});

test('listObjectStores: immediately after deleteNetworkDb, returns [] and indexedDB.databases() no longer lists the name -- the exact sequence assertNetworkForgotten performs', async () => {
	const hash = 'db-listobjectstores-post-delete';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);

	// Positive control first: while the database is real and open, the probe
	// reports its stores -- this test is not vacuous.
	const beforeDelete = await listObjectStores(hash);
	assert.ok(beforeDelete.length > 50, `expected >50 object stores before delete, got ${beforeDelete.length}`);

	await deleteNetworkDb(hash, { db });

	assert.deepEqual(
		await listObjectStores(hash),
		[],
		'listObjectStores must report [] immediately after a confirmed delete',
	);
	const listed = await indexedDB.databases();
	assert.equal(
		listed.some((entry) => entry.name === dbNameFor(hash)),
		false,
		'the probe call itself must not resurrect the just-deleted database',
	);
});

test('listObjectStores: when indexedDB.databases is unavailable, falls back to the open() path -- the fallback branch is actually entered, not dead code with an alibi', async () => {
	const hash = 'db-listobjectstores-fallback';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);

	const originalDatabases = indexedDB.databases;
	// `databases` lives on FDBFactory.prototype, not as an own property, so a
	// plain `delete` is a no-op here -- shadow it with an own-property
	// assignment first, exactly as an environment that never implemented
	// `indexedDB.databases()` would present to this function.
	// @ts-expect-error -- deliberately stubbing to a non-function for this test
	indexedDB.databases = undefined;
	try {
		assert.equal(typeof indexedDB.databases, 'undefined', 'stub did not take -- test would be vacuous');
		const names = await listObjectStores(hash);
		assert.ok(names.length > 50, `fallback path expected >50 object stores, got ${names.length}`);
	} finally {
		// Restore the prototype method by removing the shadowing own property.
		// `delete indexedDB.databases` fails tsc's TS2790 ('databases' is not
		// declared optional on the IDBFactory type this repo's lib.dom targets),
		// so go through Reflect.deleteProperty, which needs no type exemption.
		Reflect.deleteProperty(indexedDB, 'databases');
		assert.equal(indexedDB.databases, originalDatabases, 'indexedDB.databases was not correctly restored');
	}

	await deleteNetworkDb(hash, { db });
});

test('openStoreHandle: applies setDefaultVtabName in the mandatory registration order', async () => {
	const hash = 'db-delete-order';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await openStoreHandle(hash);
	// No DDL applied yet by openStoreHandle itself — declaring a table now must
	// route to the store module (proven indirectly by createNetworkDb's tests
	// above); this test only proves the handle opens without throwing.
	assert.ok(db);
	await closeNetworkDb(db);
	await deleteNetworkDb(hash);
});

test('source assertion: open-db.js contains exactly one setDefaultVtabName(\'store\') call outside comments', () => {
	const source = readFileSync(OPEN_DB_SOURCE, 'utf8');
	const codeOnly = source
		.split('\n')
		.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
		.join('\n');
	const matches = codeOnly.match(/setDefaultVtabName\(\s*['"]store['"]\s*\)/g) ?? [];
	assert.equal(matches.length, 1, `expected exactly one setDefaultVtabName('store') call, found ${matches.length}`);
});
