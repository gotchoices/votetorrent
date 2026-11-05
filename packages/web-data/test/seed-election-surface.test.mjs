/**
 * seed-election-surface.test.mjs -- the seed fixture's row-count and
 * negative-control assertions, split out from election-phase.test.mjs in
 * 53-05 (D-25) when election-phase.js itself moved to
 * packages/ui-web/src/lifecycle/election-phase.js. Its subject is
 * `./fixtures/seed-election-surface.js` against a real in-memory database,
 * not the moved module -- hence the honest rename: a dashboard file still
 * named election-phase.test.mjs that no longer tests election-phase.js would
 * be exactly the decoy shape D-11 rejects for a re-export shim. This file
 * (and the fixture it tests) moved from the dashboard's own `test/` into
 * this package by 54-03b, alongside the officer read modules that consume
 * the same seed via `officer-reads.test.mjs`.
 *
 * In-memory `new Database()` + `prepareDb` (no IndexedDB) -- these run
 * against the real 59-table schema, not a mock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@quereus/quereus';
import { prepareDb } from '@votetorrent/vote-engine/browser';

import { seedFoundingAuthority } from './fixtures/seed-founding-authority.js';
import { seedElectionSurface, SEED_EXPECTED_COUNTS } from './fixtures/seed-election-surface.js';

test('seedElectionSurface: row counts match SEED_EXPECTED_COUNTS on a founding-seeded database', async () => {
	const db = new Database();
	await prepareDb(db);
	await seedFoundingAuthority(db);
	await seedElectionSurface(db);

	for (const [table, expected] of Object.entries(SEED_EXPECTED_COUNTS)) {
		// eslint-disable-next-line no-await-in-loop
		const row = await db.prepare(`select count(*) as c from ${table}`).get({});
		assert.equal(row?.c, expected, `expected ${expected} rows in ${table}, got ${row?.c}`);
	}
});

test('seedElectionSurface: negative control -- a nonce-less Election insert fails naming InsertValid on the same database where the ceremony path succeeds', async () => {
	const db = new Database();
	await prepareDb(db);
	await seedFoundingAuthority(db);
	await seedElectionSurface(db);

	await assert.rejects(
		() =>
			db.exec(
				`insert into Election (Id,AuthorityId,Title,Date,RevisionDeadline,BallotDeadline,Type)
				 with context SigningNonce = null, Tid = 999, now = '2026-03-01T00:00:00'
				 values ('e2','a1','Unsigned Election','2026-11-03T00:00:00','2026-10-01T00:00:00','2026-10-01T00:00:00','o')`,
			),
		/InsertValid/,
	);

	// The ceremony path on this SAME database already succeeded above --
	// re-confirm the row is still there, proving the rejection above is
	// discriminating rather than a broken/poisoned fixture.
	const row = await db.prepare(`select count(*) as c from Election`).get({});
	assert.equal(row?.c, 1);
});
