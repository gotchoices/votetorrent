/**
 * seed-bound-keyholder.test.mjs — 62-02 Task 2.
 *
 * Dedicated tier-1 proof for `seed-bound-keyholder.js`, independent of
 * `public-fixtures.test.mjs`'s broader surface: seeds the full public surface
 * (the keyrelease path, which runs through `seedKeyholderPrerequisites`/
 * `insertBoundKeyholder` for all five keyholders), then asserts each of the
 * `EXPECTED_KEYHOLDERS` `Keyholder` rows has EXACTLY one `KeyholderDkgBinding`
 * whose `SignerKey` is a real `UserKey` of that same user — not just that the
 * row counts match.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkDb, closeNetworkDb, deleteNetworkDb } from '@votetorrent/web-data/public';
import { EXPECTED_KEYHOLDERS } from '../fixtures/keyrelease-fixture.js';
import { FIXTURE_NETWORK_HASH, FIXTURE_ELECTION_DB_ID, FIXTURE_REVISION, seedPublicSurface } from '../fixtures/seed-public-surface.js';

/** @type {import('@quereus/quereus').Database} */
let db;

test('setup: seed the full public surface (the keyrelease path mints all five bound keyholders)', async () => {
	try {
		await deleteNetworkDb(FIXTURE_NETWORK_HASH);
	} catch {
		// first-run case
	}
	db = await createNetworkDb(FIXTURE_NETWORK_HASH);
	await seedPublicSurface(db);
});

test(`every one of the ${EXPECTED_KEYHOLDERS} Keyholder rows has exactly one KeyholderDkgBinding whose SignerKey is a UserKey of that user`, async () => {
	const keyholders = [];
	for await (const row of db.eval(
		'select UserId from Keyholder where ElectionId = :eid and ElectionRevision = :rev',
		{ eid: FIXTURE_ELECTION_DB_ID, rev: FIXTURE_REVISION },
	)) {
		keyholders.push(row.UserId);
	}
	assert.equal(keyholders.length, EXPECTED_KEYHOLDERS, `expected ${EXPECTED_KEYHOLDERS} Keyholder rows, got ${keyholders.length}`);

	for (const userId of keyholders) {
		const bindingRows = [];
		for await (const row of db.eval(
			'select SignerKey from KeyholderDkgBinding where ElectionId = :eid and ElectionRevision = :rev and UserId = :uid',
			{ eid: FIXTURE_ELECTION_DB_ID, rev: FIXTURE_REVISION, uid: userId },
		)) {
			bindingRows.push(row.SignerKey);
		}
		assert.equal(bindingRows.length, 1, `userId=${userId} must have exactly one KeyholderDkgBinding row, got ${bindingRows.length}`);

		const signerKey = bindingRows[0];
		const userKeyRow = await db.prepare('select PubKey from UserKey where UserId = :uid and PubKey = :pk').get({ uid: userId, pk: signerKey });
		assert.ok(userKeyRow, `userId=${userId}'s binding SignerKey (${signerKey}) must be a real UserKey row of that same user`);
	}
});

test('teardown: close the shared handle', async () => {
	await closeNetworkDb(db);
});
