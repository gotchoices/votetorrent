/**
 * attach-live.test.mjs -- tier-1 suite for `src/officer/attach-live.js`, the
 * live-copy store open (contract C-7).
 *
 * What it proves: a live store opens with the schema re-declared and the
 * init marker checked, with NO row-count record anywhere -- including on a
 * store whose rows moved since the last open, where the snapshot-era attach
 * on the SAME store rejects (the contrast controls A2/A3). `create: false`
 * never creates an absent store (A4), and a failed attach releases its
 * handle so a later delete is not blocked (A5).
 *
 * Honesty note: fake-indexeddb proves the API round-trip inside one process.
 * It cannot show the browser-only case where a background write re-creates a
 * deleted database; that belongs to the browser gate.
 *
 * Sequential and stateful against one shared fake IDB, like
 * `reattach.test.mjs`; each test uses its own network hash.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VOTETORRENT_SCHEMA_SQL, isSchemaInitialized } from '@votetorrent/vote-engine/browser';
import { attachLiveDb, LiveStoreMissingError, LiveStoreUnavailableError } from '../src/officer/attach-live.js';
import { closeNetworkDb, dbNameFor, deleteNetworkDb } from '../src/open-db.js';
import {
	attachNetworkDb,
	writeRowCounts,
	MissingRowCountsError,
	RowCountMismatchError,
} from '../src/reattach.js';
import { stripComments } from './lib/source-scan.mjs';
import { webDataSrc } from '../../../scripts/lib/source-paths.mjs';
import { SEED_TABLES, EXPECTED_COUNTS, seedFoundingAuthority } from './fixtures/seed-founding-authority.js';

const H_A1 = 'live-a1';
const H_SEEDED = 'live-a2';
const H_ABSENT = 'absent-4';
const H_BARE = 'live-a5';
const ALL_HASHES = [H_A1, H_SEEDED, H_ABSENT, H_BARE];

/** The 66-04 revocation table, read out of the schema so this file never spells it. */
const REVOCATION_TABLE = (() => {
	const match = /\btable\s+(Dashboard[A-Za-z]+)\s*\(/.exec(VOTETORRENT_SCHEMA_SQL);
	if (!match) throw new Error('attach-live.test: no Dashboard table declared in the schema');
	return match[1];
})();

/** A Map-backed storage fake that counts writes. */
function makeStorage() {
	/** @type {Map<string, string>} */
	const map = new Map();
	const calls = { setItem: 0 };
	return {
		calls,
		getItem: (/** @type {string} */ key) => (map.has(key) ? /** @type {string} */ (map.get(key)) : null),
		setItem: (/** @type {string} */ key, /** @type {string} */ value) => {
			calls.setItem += 1;
			map.set(key, value);
		},
		removeItem: (/** @type {string} */ key) => {
			map.delete(key);
		},
	};
}

/** @param {string} name */
async function isListed(name) {
	const known = await indexedDB.databases();
	return known.some((entry) => entry.name === name);
}

/**
 * Per-table counts for the seed tables. The names come from the fixture's
 * closed list, never from input.
 *
 * @param {import('@quereus/quereus').Database} db
 */
async function seedCounts(db) {
	/** @type {Record<string, number>} */
	const counts = {};
	for (const table of SEED_TABLES) {
		const row = await db.prepare(`select count(*) as c from ${table}`).get({});
		counts[table] = Number(row?.c ?? 0);
	}
	return counts;
}

test('A1: create true on an absent hash initializes the store, declares the revocation table, writes no web storage', async () => {
	await deleteNetworkDb(H_A1).catch(() => {});
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	const spy = makeStorage();
	Object.defineProperty(globalThis, 'localStorage', { value: spy, configurable: true, writable: true });
	let db;
	try {
		db = await attachLiveDb(H_A1, { create: true });
		assert.equal(await isSchemaInitialized(db), true);
		assert.equal(await isListed(dbNameFor(H_A1)), true);
		const row = await db.prepare(`select count(*) as c from ${REVOCATION_TABLE}`).get({});
		assert.equal(Number(row?.c), 0);
		assert.equal(spy.calls.setItem, 0);
	} finally {
		await closeNetworkDb(db);
		if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
		else delete globalThis.localStorage;
	}
});

test('A2: create false opens a seeded store with no row-count record; the snapshot attach on the same store rejects', async () => {
	await deleteNetworkDb(H_SEEDED).catch(() => {});
	const seeding = await attachLiveDb(H_SEEDED, { create: true });
	await seedFoundingAuthority(seeding);
	await closeNetworkDb(seeding);

	const db = await attachLiveDb(H_SEEDED, { create: false });
	try {
		assert.deepEqual(await seedCounts(db), EXPECTED_COUNTS);
	} finally {
		await closeNetworkDb(db);
	}

	await assert.rejects(attachNetworkDb(H_SEEDED, { storage: makeStorage() }), (err) => {
		assert.ok(err instanceof MissingRowCountsError);
		return true;
	});
});

test('A3: a stale row-count record makes the snapshot attach reject while the live attach opens the same store', async () => {
	const storage = makeStorage();
	await writeRowCounts(H_SEEDED, { ...EXPECTED_COUNTS, User: 99 }, storage);
	await assert.rejects(attachNetworkDb(H_SEEDED, { storage }), (err) => {
		assert.ok(err instanceof RowCountMismatchError);
		return true;
	});
	const db = await attachLiveDb(H_SEEDED, { create: false });
	try {
		assert.deepEqual(await seedCounts(db), EXPECTED_COUNTS);
	} finally {
		await closeNetworkDb(db);
	}
});

test('A4: create false on an absent hash rejects absent and creates nothing', async () => {
	const name = dbNameFor(H_ABSENT);
	assert.equal(await isListed(name), false);
	await assert.rejects(attachLiveDb(H_ABSENT, { create: false }), (err) => {
		assert.ok(err instanceof LiveStoreMissingError);
		assert.equal(err.name, 'LiveStoreMissingError');
		assert.equal(err.reason, 'absent');
		assert.equal(err.networkHash, H_ABSENT);
		return true;
	});
	assert.equal(await isListed(name), false);
});

test('A5: create false on a bare store with no init marker rejects not-initialized and releases its handle', async () => {
	await deleteNetworkDb(H_BARE).catch(() => {});
	await new Promise((resolve, reject) => {
		const request = indexedDB.open(dbNameFor(H_BARE));
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			request.result.close();
			resolve(undefined);
		};
	});
	assert.equal(await isListed(dbNameFor(H_BARE)), true);

	await assert.rejects(attachLiveDb(H_BARE, { create: false }), (err) => {
		assert.ok(err instanceof LiveStoreMissingError);
		assert.equal(err.reason, 'not-initialized');
		return true;
	});
	await deleteNetworkDb(H_BARE, { timeoutMs: 1000 });
	assert.equal(await isListed(dbNameFor(H_BARE)), false);
});

test('A6: create true on an initialized store adopts its rows unchanged, twice', async () => {
	for (let round = 0; round < 2; round += 1) {
		const db = await attachLiveDb(H_SEEDED, { create: true });
		try {
			assert.equal(await isSchemaInitialized(db), true);
			assert.deepEqual(await seedCounts(db), EXPECTED_COUNTS);
		} finally {
			await closeNetworkDb(db);
		}
	}
});

test('A7: with no IndexedDB the call rejects LiveStoreUnavailableError', async () => {
	const saved = globalThis.indexedDB;
	try {
		globalThis.indexedDB = undefined;
		await assert.rejects(attachLiveDb(H_SEEDED, { create: false }), (err) => {
			assert.ok(err instanceof LiveStoreUnavailableError);
			assert.equal(err.name, 'LiveStoreUnavailableError');
			return true;
		});
	} finally {
		globalThis.indexedDB = saved;
	}
	assert.equal(typeof globalThis.indexedDB, 'object');
});

test('A8: invalid arguments reject TypeError', async () => {
	await assert.rejects(attachLiveDb(H_SEEDED, /** @type {any} */ ({})), TypeError);
	await assert.rejects(attachLiveDb(H_SEEDED, /** @type {any} */ ({ create: 'yes' })), TypeError);
	await assert.rejects(attachLiveDb('', { create: true }), TypeError);
	await assert.rejects(attachLiveDb(H_SEEDED, /** @type {any} */ (undefined)), TypeError);
});

test('A9: the module source carries no row-count call or import and keeps the marker gate', () => {
	const source = stripComments(readFileSync(webDataSrc('officer', 'attach-live.js'), 'utf8'));
	const banned = [
		['write', 'Row', 'Counts'],
		['read', 'Row', 'Counts', 'Record'],
		['assert', 'Row', 'Counts'],
		['read', 'Row', 'Counts'],
		['Row', 'Count', 'Mismatch', 'Error'],
		['Missing', 'Row', 'Counts', 'Error'],
		['re', 'attach', '.js'],
		['local', 'Storage'],
	].map((parts) => parts.join(''));
	const present = banned.filter((token) => source.includes(token));
	assert.deepEqual(present, []);
	for (const required of ['openStoreHandle', 'markSchemaInitialized', 'isSchemaInitialized', 'hasDeclaredSchema']) {
		assert.ok(source.includes(required), 'a required call is missing from the module');
	}
	// Matcher control: the same token list does fire on a source that has one.
	const control = 'const x = ' + banned[0] + '(h, c);';
	assert.equal(banned.filter((token) => control.includes(token)).length >= 1, true);
});

test('cleanup: delete every store this suite created', async () => {
	for (const hash of ALL_HASHES) {
		await deleteNetworkDb(hash, { timeoutMs: 2000 });
		assert.equal(await isListed(dbNameFor(hash)), false);
	}
});
