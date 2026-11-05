/**
 * reattach.test.mjs -- tier-1 cold -> seed -> read -> re-attach suite for
 * `@votetorrent/web-data`'s `reattach.js` (moved out of the dashboard's own
 * `src/db/` by 54-03a; this test file itself moved out of the dashboard's
 * `test/node/db.test.mjs` by 54-03b, alongside the module it tests -- its
 * subject was always this package's `reattach.js`, never a dashboard file).
 *
 * Honesty note (50-VALIDATION.md, spike 076's node-suite idiom): this proves
 * the ENGINE's use of the IndexedDB API round-trips within one process via
 * `fake-indexeddb`. It says NOTHING about quota, eviction, cross-tab locking
 * or structured-clone edges — `apps/VoteTorrentDashboard/test/browser/run-headless.mjs`'s
 * two-page headless-Chrome run is the authority for those, and no assertion
 * or test name in this file may suggest otherwise. The object-store-name
 * probe below is an early-warning for mis-routing WITHIN one process, not
 * proof of persistence, and does not discharge the tier-2 obligation.
 *
 * Deliberately sequential and stateful against one shared fake IDB in one
 * process (spike 076's node-suite idiom) — do not reorder or parallelise it.
 * `import 'fake-indexeddb/auto'` first, then `node:test` + `node:assert/strict`.
 * `package.json`'s `test` script runs with `--test-concurrency=1` for
 * exactly this reason.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webDataSrc } from '../../../scripts/lib/source-paths.mjs';
import {
	createNetworkDb,
	closeNetworkDb,
	deleteNetworkDb,
	listObjectStores,
	openStoreHandle,
	attachNetworkDb,
	readRowCounts,
	assertRowCounts,
	writeRowCounts,
	readRowCountsRecord,
	clearRowCounts,
	NotBootstrappedError,
	MissingRowCountsError,
	RowCountMismatchError,
	InvalidRowCountRecordError,
} from '@votetorrent/web-data/officer';
import { GATE_NETWORK_HASH, SEED_TABLES, EXPECTED_COUNTS, seedFoundingAuthority } from './fixtures/seed-founding-authority.js';

const REATTACH_SOURCE = webDataSrc('reattach.js');

/** A tiny Map-backed localStorage-shaped fake — Node 22 has no real `localStorage`. */
function makeFakeStorage() {
	/** @type {Map<string, string>} */
	const map = new Map();
	return {
		getItem: (/** @type {string} */ key) => (map.has(key) ? /** @type {string} */ (map.get(key)) : null),
		setItem: (/** @type {string} */ key, /** @type {string} */ value) => {
			map.set(key, value);
		},
		removeItem: (/** @type {string} */ key) => {
			map.delete(key);
		},
	};
}

const HASH = GATE_NETWORK_HASH;

test('cold -> seed: readRowCounts returns the expected per-table counts', async () => {
	await deleteNetworkDb(HASH).catch(() => {});
	const db = await createNetworkDb(HASH);
	await seedFoundingAuthority(db);
	const counts = await readRowCounts(db, SEED_TABLES);
	assert.deepEqual(counts, EXPECTED_COUNTS);
	await closeNetworkDb(db);
});

test('object-store early-warning: >50 stores including __catalog__ and main.authority (NOT proof of persistence)', async () => {
	const names = await listObjectStores(HASH);
	assert.ok(names.length > 50, `expected >50 object stores, got ${names.length}`);
	assert.ok(names.includes('__catalog__'));
	assert.ok(names.includes('main.authority'));
});

test('re-attach: a brand-new handle with NO DDL re-declaration rejects Authority queries', async () => {
	const db = await openStoreHandle(HASH);
	await assert.rejects(
		async () => {
			await db.prepare('select count(*) as c from Authority').get({});
		},
		/** @param {any} err */
		(err) => {
			assert.match(String(err?.message ?? err), /not found in schema path/i);
			return true;
		},
	);
	await closeNetworkDb(db);
});

test('unsigned Election insert is rejected by the database (InsertValid), paired with the founding seed succeeding on the same store', async () => {
	const storage = makeFakeStorage();
	await writeRowCounts(HASH, EXPECTED_COUNTS, storage);
	const db = await attachNetworkDb(HASH, { expectedCounts: EXPECTED_COUNTS });

	await assert.rejects(
		() =>
			db.exec(
				`insert into Election (Id, AuthorityId, Title, Date, RevisionDeadline, BallotDeadline, Type)
				 with context SigningNonce = null, Tid = 2, now = '2026-01-01T00:00:00Z'
				 values ('e1','a1','Unauthorized','2027-01-01T00:00:00Z','2026-06-01T00:00:00Z','2026-06-01T00:00:00Z','o')`,
			),
		/InsertValid/,
	);

	// Positive control: the founding seed already succeeded on this same store
	// (the first test above) -- so the rejection above is discriminating, not
	// a broken fixture.
	const row = await db.prepare('select count(*) as c from Authority').get({});
	assert.equal(row?.c, 1);

	await closeNetworkDb(db);
});

test('attachNetworkDb with an explicit expectedCounts: resolves and adopts the persisted rows (not recreated)', async () => {
	const db = await attachNetworkDb(HASH, { expectedCounts: EXPECTED_COUNTS });
	const row = await db.prepare('select count(*) as c from Authority').get({});
	assert.equal(row?.c, 1, 'reconcile recreated the table instead of adopting the persisted one');
	await closeNetworkDb(db);
});

test('writeRowCounts/readRowCountsRecord: capturedAt is exactly 19 characters with no Z', async () => {
	const storage = makeFakeStorage();
	const record = await writeRowCounts(HASH, EXPECTED_COUNTS, storage);
	assert.equal(record.capturedAt.length, 19);
	assert.ok(!record.capturedAt.includes('Z'));

	const readBack = await readRowCountsRecord(HASH, storage);
	assert.deepEqual(readBack?.counts, EXPECTED_COUNTS);
});

test('readRowCountsRecord: a record whose capturedAt carries a Z is rejected, naming the field', async () => {
	const storage = makeFakeStorage();
	storage.setItem(
		'votetorrent.dashboard.rowcounts.' + HASH,
		JSON.stringify({ networkHash: HASH, capturedAt: '2026-01-01T00:00:00Z', counts: EXPECTED_COUNTS }),
	);
	await assert.rejects(
		() => readRowCountsRecord(HASH, storage),
		/** @param {any} err */
		(err) => {
			assert.equal(err.name, 'InvalidRowCountRecordError');
			assert.match(err.message, /capturedAt/);
			return true;
		},
	);
});

test('attachNetworkDb: a missing row-count record rejects MissingRowCountsError naming the network hash', async () => {
	const storage = makeFakeStorage(); // deliberately empty
	await assert.rejects(
		() => attachNetworkDb(HASH, { storage }),
		/** @param {any} err */
		(err) => {
			assert.equal(err.name, 'MissingRowCountsError');
			assert.ok(String(err.message).includes(HASH));
			return true;
		},
	);
});

test('attachNetworkDb: a correctly recorded store attaches via the persisted record (positive control for MissingRowCountsError)', async () => {
	const storage = makeFakeStorage();
	await writeRowCounts(HASH, EXPECTED_COUNTS, storage);
	const db = await attachNetworkDb(HASH, { storage });
	const counts = await readRowCounts(db, SEED_TABLES);
	assert.deepEqual(counts, EXPECTED_COUNTS);
	await closeNetworkDb(db);
});

test('attachNetworkDb: a row-count mismatch rejects RowCountMismatchError naming table/expected/actual', async () => {
	const mutated = { ...EXPECTED_COUNTS, Officer: 99 };
	await assert.rejects(
		() => attachNetworkDb(HASH, { expectedCounts: mutated }),
		/** @param {any} err */
		(err) => {
			assert.equal(err.name, 'RowCountMismatchError');
			assert.equal(err.table, 'Officer');
			assert.equal(err.expected, 99);
			assert.equal(err.actual, 1);
			assert.match(err.message, /Officer/);
			assert.match(err.message, /99/);
			assert.match(err.message, /\b1\b/);
			return true;
		},
	);
});

test('positive control: the ordinary attach path (correct record, no mutation) resolves with matching counts', async () => {
	const db = await attachNetworkDb(HASH, { expectedCounts: EXPECTED_COUNTS });
	const counts = await readRowCounts(db, SEED_TABLES);
	assert.deepEqual(counts, EXPECTED_COUNTS);
	await closeNetworkDb(db);
});

test('attachNetworkDb: an un-bootstrapped store rejects NotBootstrappedError', async () => {
	const freshHash = 'db-reattach-never-bootstrapped';
	await deleteNetworkDb(freshHash).catch(() => {});
	await assert.rejects(
		() => attachNetworkDb(freshHash, { expectedCounts: {} }),
		/** @param {any} err */
		(err) => {
			assert.equal(err.name, 'NotBootstrappedError');
			assert.ok(String(err.message).includes(freshHash));
			return true;
		},
	);
	await deleteNetworkDb(freshHash);
});

test('positive control for NotBootstrappedError: createNetworkDb + attachNetworkDb on the SAME fresh hash succeeds', async () => {
	const freshHash = 'db-reattach-fresh-bootstrap';
	await deleteNetworkDb(freshHash).catch(() => {});
	const created = await createNetworkDb(freshHash);
	await seedFoundingAuthority(created);
	const counts = await readRowCounts(created, SEED_TABLES);
	await closeNetworkDb(created);

	const db = await attachNetworkDb(freshHash, { expectedCounts: counts });
	assert.deepEqual(await readRowCounts(db, SEED_TABLES), counts);
	await closeNetworkDb(db);
	await deleteNetworkDb(freshHash);
});

test('clearRowCounts: removes the persisted record', async () => {
	const storage = makeFakeStorage();
	await writeRowCounts(HASH, EXPECTED_COUNTS, storage);
	assert.ok(await readRowCountsRecord(HASH, storage));
	await clearRowCounts(HASH, storage);
	assert.equal(await readRowCountsRecord(HASH, storage), undefined);
});

test('final cleanup: delete the shared gate-hash store', async () => {
	await deleteNetworkDb(HASH);
});

test('source assertion: reattach.js runs initDB before isSchemaInitialized, and never uses a floor comparison', () => {
	const source = readFileSync(REATTACH_SOURCE, 'utf8');
	const codeOnly = source
		.split('\n')
		.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
		.join('\n');
	assert.ok((codeOnly.match(/\binitDB\(/g) ?? []).length >= 1, 'expected at least one initDB( call');
	const initDBIndex = codeOnly.indexOf('initDB(db)');
	const isInitIndex = codeOnly.indexOf('isSchemaInitialized(db)');
	assert.ok(initDBIndex !== -1 && isInitIndex !== -1 && isInitIndex > initDBIndex, 'isSchemaInitialized must appear after initDB in source order');
	assert.equal((source.match(/toISOString/g) ?? []).length, 0, 'capturedAt must come only from nowCanonicalDatetime');
});
