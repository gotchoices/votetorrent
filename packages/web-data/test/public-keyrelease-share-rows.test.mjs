/**
 * public-keyrelease-share-rows.test.mjs -- 62-126: the public "N of M keyholders have released a
 * key" figure counts PUBLISHED KeyholderShareRelease rows for the election revision, not completed
 * release-key Tasks. Real Quereus DB, real schema CHECKs (signed DKG round-4 rows, a published
 * ElectionKey, signed release rows).
 *
 * The seeding helpers are the Public app's keyrelease fixture, imported by file path: they need
 * @noble/curves and @noble/hashes, which this package does not depend on but that app does.
 * TEST-ONLY cross-package read, same posture as vote-engine's release-count-readers.spec.ts.
 *
 * W1 a share published with NO completed task is counted.
 * W2 a completed task with NO share is not counted.
 * W3 other revisions/elections are not counted; zero rows is the number 0, never null.
 * W4 the module's SQL selects no identifying column and binds every value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@quereus/quereus';
import { prepareDb } from '@votetorrent/vote-engine/browser';

import { readKeyReleaseProgress, KEYRELEASE_AGGREGATE_SQL, KEYHOLDER_COUNT_SQL } from '../src/public/read-keyrelease.js';
import { seedFoundingAuthority } from './fixtures/seed-founding-authority.js';
import { seedElectionSurface, SEED_ELECTION, SEED_NOW } from './fixtures/seed-election-surface.js';
import {
	seedKeyReleaseKeyholders,
	seedKeyReleaseTaskRows,
	seedKeyReleaseShares,
} from '../../../apps/VoteTorrentPublic/test/fixtures/keyrelease-fixture.js';

const REVISION = 0;

/** @param {{ shares?: string[], tasks?: boolean }} [opts] */
async function freshDb(opts = {}) {
	const db = new Database();
	await prepareDb(db);
	await seedFoundingAuthority(db);
	await seedElectionSurface(db);
	await seedKeyReleaseKeyholders(db, { electionId: SEED_ELECTION.id, revision: REVISION, seedNow: SEED_NOW });
	if (opts.tasks) await seedKeyReleaseTaskRows(db, { electionId: SEED_ELECTION.id, revision: REVISION });
	if (opts.shares?.length || opts.shares) {
		await seedKeyReleaseShares(db, { electionId: SEED_ELECTION.id, revision: REVISION, userIds: opts.shares ?? [] });
	}
	return db;
}

test('W1: one published share row and NO release-key task counts as 1 of 5', async () => {
	const db = await freshDb({ shares: ['u-kh-2'] });
	const tasks = await db.prepare('select count(*) as c from Task').get({});
	assert.equal(Number(tasks?.c ?? 0), 0, 'precondition: no task rows exist');
	const progress = await readKeyReleaseProgress(db, SEED_ELECTION.id, REVISION);
	assert.equal(progress.released, 1);
	assert.equal(progress.keyholderCount, 5);
});

test('W2: five release-key tasks (three completed) and NO share row counts as 0 released', async () => {
	const db = await freshDb({ tasks: true, shares: [] });
	const completed = await db.prepare('select count(*) as c from Task where IsCompleted = 1').get({});
	assert.equal(Number(completed?.c ?? 0), 3, 'precondition: three tasks are completed');
	const progress = await readKeyReleaseProgress(db, SEED_ELECTION.id, REVISION);
	assert.equal(progress.released, 0);
	assert.equal(progress.keyholderCount, 5);
});

test('W3: shares of another revision or election are not counted; zero rows is the number 0', async () => {
	const db = await freshDb({ tasks: true, shares: ['u1', 'u-kh-3'] });
	assert.equal((await readKeyReleaseProgress(db, SEED_ELECTION.id, REVISION)).released, 2);
	const otherRevision = await readKeyReleaseProgress(db, SEED_ELECTION.id, 7);
	assert.equal(otherRevision.released, 0);
	assert.strictEqual(typeof otherRevision.released, 'number');
	const otherElection = await readKeyReleaseProgress(db, 'no-such-election', REVISION);
	assert.deepEqual({ ...otherElection }, { released: 0, total: 0, keyholderCount: 0 });
});

test('W4: the aggregate selects only count(...), reads no identifying column, and binds every value', () => {
	for (const sql of [KEYRELEASE_AGGREGATE_SQL, KEYHOLDER_COUNT_SQL]) {
		const list = sql.slice(sql.indexOf('select') + 6, sql.indexOf(' from '));
		for (const item of list.split(',').map((i) => i.trim())) {
			assert.ok(/^count\s*\(/i.test(item), `select item "${item}" is not a count(...)`);
		}
		assert.ok(!sql.includes('${'), 'the SQL interpolates');
		for (const banned of ['UserId', 'Identifier', 'SigningShare', 'SignerKey', 'Signature', 'ReleasedAt']) {
			assert.ok(!new RegExp(`\\b${banned}\\b`).test(list), `${banned} appears in a select list`);
		}
		const binds = [...sql.matchAll(/:([A-Za-z_]\w*)/g)].map((m) => m[1]);
		assert.deepEqual([...new Set(binds)].sort(), ['electionId', 'revision']);
	}
	assert.ok(/from KeyholderShareRelease where ElectionId = :electionId and ElectionRevision = :revision/.test(KEYRELEASE_AGGREGATE_SQL));
});
