/**
 * officer-keyholder-release.test.mjs -- 62-29 (D-17): the officer keyholder roster carries each
 * keyholder's `ReleasedAt` from `KeyholderShareRelease`. The roster field means PUBLISHED, not
 * VALID (SQL cannot run `validateReleasedShare`). W1 SQL shape, W2 the declared table set, W3
 * real-schema execution.
 *
 * Rows-present proof is NOT here: a valid `KeyholderShareRelease` row needs an ElectionKey, signed
 * round-4 DKG rows and a signed release, which only vote-engine's DKG fixtures can build cheaply.
 * That proof lives in `packages/vote-engine/test/release-count-readers.spec.ts`, which imports this
 * module by file path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@quereus/quereus';
import { prepareDb } from '@votetorrent/vote-engine/browser';

import { classOf } from '../src/classification.js';
import { KEYHOLDER_ROSTER_SQL, TABLES_READ, readKeyholders } from '../src/officer/read-keyholders.js';
import { seedFoundingAuthority } from './fixtures/seed-founding-authority.js';
import { seedElectionSurface, SEED_ELECTION } from './fixtures/seed-election-surface.js';

test('W1: the roster SQL names KeyholderShareRelease, is one line, interpolates nothing, binds only :electionId and :revision, and still selects a Name', () => {
	assert.ok(/KeyholderShareRelease/.test(KEYHOLDER_ROSTER_SQL), 'the roster no longer reads KeyholderShareRelease');
	assert.ok(/left join KeyholderShareRelease/.test(KEYHOLDER_ROSTER_SQL), 'unreleased keyholders would vanish without a left join');
	assert.ok(!/\n/.test(KEYHOLDER_ROSTER_SQL), 'the roster SQL is no longer one line');
	assert.ok(!KEYHOLDER_ROSTER_SQL.includes('${'), 'the roster SQL interpolates');
	const binds = [...KEYHOLDER_ROSTER_SQL.matchAll(/:([A-Za-z_]\w*)/g)].map((m) => m[1]);
	assert.deepEqual([...new Set(binds)].sort(), ['electionId', 'revision']);
	const selectList = KEYHOLDER_ROSTER_SQL.slice(KEYHOLDER_ROSTER_SQL.indexOf('select') + 6, KEYHOLDER_ROSTER_SQL.indexOf(' from '));
	const items = selectList.split(',').map((i) => i.trim());
	assert.ok(items.some((i) => /Name/.test(i)), `no Name item in the select list: ${selectList}`);
	assert.ok(items.some((i) => /ReleasedAt/.test(i)), `no ReleasedAt item in the select list: ${selectList}`);
});

test('W2: TABLES_READ is exactly Keyholder, User, KeyholderShareRelease and every entry is classified', () => {
	assert.deepEqual([...TABLES_READ], ['Keyholder', 'User', 'KeyholderShareRelease']);
	for (const table of TABLES_READ) {
		assert.doesNotThrow(() => classOf(table), `${table} is not classified`);
	}
});

test('W3: against the real schema the roster prepares and runs; every row carries ReleasedAt null with no release rows', async () => {
	const db = new Database();
	await prepareDb(db);
	await seedFoundingAuthority(db);
	await seedElectionSurface(db);

	const rows = await readKeyholders(db, SEED_ELECTION.id, 0);
	const counted = await db.prepare('select count(*) as c from Keyholder where ElectionId = :e and ElectionRevision = 0').get({ e: SEED_ELECTION.id });
	assert.equal(rows.length, Number(counted?.c ?? 0));
	for (const row of rows) {
		assert.ok(Object.prototype.hasOwnProperty.call(row, 'ReleasedAt'), 'a roster row has no ReleasedAt property');
		assert.equal(row.ReleasedAt, null);
	}
	const releases = await db.prepare('select count(*) as c from KeyholderShareRelease').get({});
	assert.equal(Number(releases?.c ?? 0), 0);
});
