/**
 * public-fixtures.test.mjs — tier-1 proof that the public surface's fixtures
 * satisfy the schema, and that 54-06's public reads return the rows those
 * fixtures describe.
 *
 * HONESTY NOTE. This proves two things and no more: (1) the seed satisfies
 * every schema constraint on the path it walks, and (2) `readRegistrantRoll`
 * and `readKeyReleaseProgress` return the expected rows WITHIN ONE PROCESS
 * against `fake-indexeddb`. It says NOTHING about rendering — not that the roll
 * appears, not that it scrolls rather than clips, not that `ExtraFields` stays
 * off the page. Those are the browser-tier gate's obligation
 * (`test/browser/render-fidelity-gate.mjs`), and no assertion or test name here
 * may suggest otherwise.
 *
 * WHY IT MATTERS. Before this file, no fixture in this repo seeded
 * `RegistrantPublic`, so `readRegistrantRoll` had only ever been observed
 * returning `[]`; its `RP.Cid = R.PublicCid` fan-out pin was asserted by source
 * scan alone, and a scan proves the column list, not that the join returns the
 * rows the list describes.
 *
 * Deliberately sequential and stateful against ONE shared fake IndexedDB in one
 * process (the idiom `packages/web-data/test/reattach.test.mjs` documents) — do
 * not reorder or parallelise it. `import 'fake-indexeddb/auto'` first, then
 * `node:test` + `node:assert/strict`. `package.json`'s `test:node` script
 * already runs with `--test-concurrency=1` for exactly this reason.
 *
 * IMPORT NOTE (measured, not assumed): `@votetorrent/web-data` declares NO root
 * export — its `exports` map has exactly `./public` and `./officer`. The
 * connection layer (`createNetworkDb`, `closeNetworkDb`, `deleteNetworkDb`) and
 * the re-attach layer (`assertRowCounts`, `RowCountMismatchError`) are
 * re-exported from `./public`, which is the audience this app belongs to, so
 * every import below comes from that one subpath.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	createNetworkDb,
	closeNetworkDb,
	deleteNetworkDb,
	readRegistrantRoll,
	readKeyReleaseProgress,
	assertRowCounts,
	RowCountMismatchError,
} from '@votetorrent/web-data/public';
import {
	ROLL_REGISTRANTS,
	ROLL_SUPERSEDED,
	EXPECTED_ROLL_LAST_NAMES,
	EXTRA_FIELDS_MARKER,
	ROLL_EXPECTED_COUNTS,
} from '../fixtures/registrant-roll-fixture.js';
import {
	EXPECTED_RELEASED,
	EXPECTED_TOTAL,
	EXPECTED_KEYHOLDERS,
} from '../fixtures/keyrelease-fixture.js';
import {
	FIXTURE_NETWORK_HASH,
	FIXTURE_ELECTION_DB_ID,
	FIXTURE_REVISION,
	FIXTURE_SETTLING_INSTANT,
	PUBLIC_SURFACE_EXPECTED_COUNTS,
	SEED_TIMELINE,
	seedPublicSurface,
} from '../fixtures/seed-public-surface.js';

/** @type {import('@quereus/quereus').Database} */
let db;

/** @type {Array<Record<string, unknown>>} */
let rollRows;

test('the fixture data is production-length before anything is seeded (D-19)', () => {
	for (const entry of ROLL_REGISTRANTS) {
		assert.ok(
			entry.lastName.length >= 12,
			`${entry.id}: lastName "${entry.lastName}" is ${entry.lastName.length} chars, needs >= 12`,
		);
		assert.ok(
			entry.firstName.length >= 12,
			`${entry.id}: firstName "${entry.firstName}" is ${entry.firstName.length} chars, needs >= 12`,
		);
		assert.ok(
			entry.district.length >= 20,
			`${entry.id}: district "${entry.district}" is ${entry.district.length} chars, needs >= 20`,
		);
		assert.ok(entry.district.includes('vtx-fixture'), `${entry.id}: district must carry the synthetic-data marker`);
	}
});

test('the superseded name cannot match a current one by accident, in either direction', () => {
	for (const entry of ROLL_REGISTRANTS) {
		assert.ok(
			!entry.lastName.includes(ROLL_SUPERSEDED.lastName),
			`current lastName "${entry.lastName}" contains the superseded name — the absence probe would be unfalsifiable`,
		);
		assert.ok(
			!ROLL_SUPERSEDED.lastName.includes(entry.lastName),
			`superseded name contains current lastName "${entry.lastName}" — the absence probe would be unfalsifiable`,
		);
	}
});

test('seed: the whole public surface through the one composition both tiers call', async () => {
	await deleteNetworkDb(FIXTURE_NETWORK_HASH).catch(() => {});
	db = await createNetworkDb(FIXTURE_NETWORK_HASH);
	await seedPublicSurface(db);

	for (const [table, expected] of Object.entries(ROLL_EXPECTED_COUNTS)) {
		// eslint-disable-next-line no-await-in-loop -- sequential against one shared handle
		const row = await db.prepare(`select count(*) as c from ${table}`).get({});
		assert.equal(Number(row?.c ?? 0), expected, `${table} row count`);
	}
});

test('the reissued registrant genuinely fans out to two public records (D-18)', async () => {
	const row = await db
		.prepare('select count(*) as c from RegistrantPublic where RegistrantId = :rid')
		.get({ rid: ROLL_SUPERSEDED.id });
	assert.equal(Number(row?.c ?? 0), 2, 'r-roll-3 must have both a superseded and a current public record');
});

test('readRegistrantRoll returns exactly the current registrants', async () => {
	rollRows = await readRegistrantRoll(db, FIXTURE_ELECTION_DB_ID);
	assert.equal(rollRows.length, ROLL_REGISTRANTS.length);
	assert.deepEqual(
		rollRows.map((r) => r.LastName).sort(),
		[...EXPECTED_ROLL_LAST_NAMES].sort(),
	);
});

test('every returned row carries exactly LastName, FirstName, District (D-19)', () => {
	for (const row of rollRows) {
		assert.deepEqual(
			Object.keys(row).sort(),
			['District', 'FirstName', 'LastName'],
			`unexpected key set: ${JSON.stringify(Object.keys(row))}`,
		);
	}
});

test('the RP.Cid = R.PublicCid pin keeps the superseded record off the roll (D-18)', () => {
	const matches = rollRows.filter(
		(r) => r.LastName === ROLL_SUPERSEDED.lastName || r.District === ROLL_SUPERSEDED.district,
	);
	assert.equal(matches.length, 0, `superseded record leaked onto the roll: ${JSON.stringify(matches)}`);
});

test('positive control: without the Cid pin the same join publishes one row more than the roll returns (D-18)', async () => {
	// The assertion above ("the superseded record is absent") is only meaningful
	// if the join could have produced it. This runs the SAME three-table join
	// with `RP.Cid = R.PublicCid` REMOVED and requires the leak to appear — so
	// the pin is proven load-bearing against real rows, not merely present in a
	// source scan. This is a locally-authored control string, deliberately NOT
	// `REGISTRANT_ROLL_SQL` with a substring edit: the point is to reproduce the
	// join the read performs minus one predicate, and to fail loudly if that
	// unpinned form ever stops fanning out.
	const unpinned =
		"select RP.LastName from ElectionRegistrant ER join Registrant R on R.Id = ER.RegistrantId join RegistrantPublic RP on RP.RegistrantId = R.Id where ER.ElectionId = :electionId and R.Status = 'a'";
	/** @type {string[]} */
	const names = [];
	for await (const r of db.eval(unpinned, { electionId: FIXTURE_ELECTION_DB_ID })) {
		names.push(String(r.LastName));
	}
	assert.equal(
		names.length,
		ROLL_REGISTRANTS.length + 1,
		'the unpinned join must fan out to one row more than the roll returns — the reissued registrant is the extra row',
	);
	assert.ok(
		names.includes(ROLL_SUPERSEDED.lastName),
		'the unpinned join must surface the superseded name — otherwise the pinned read proves nothing',
	);
});

test('ExtraFields never reaches the read result, though it is seeded non-null (D-19)', async () => {
	const seeded = await db
		.prepare('select count(*) as c from RegistrantPublic where ExtraFields is not null')
		.get({});
	assert.equal(
		Number(seeded?.c ?? 0),
		ROLL_REGISTRANTS.length + 1,
		'every seeded public record must carry a non-null ExtraFields',
	);
	assert.ok(
		!JSON.stringify(rollRows).includes(EXTRA_FIELDS_MARKER),
		'the ExtraFields marker reached the roll read result',
	);
});

test('every returned District carries the synthetic-data marker', () => {
	for (const row of rollRows) {
		assert.ok(String(row.District).includes('vtx-fixture'), `District "${row.District}" is not obviously synthetic`);
	}
});

// ---------------------------------------------------------------------------
// D-14 — the key-release aggregate, and the row-count contract over every table
// these fixtures newly seed.
// ---------------------------------------------------------------------------

test('the fixture revision matches the revision the election surface actually inserted', async () => {
	// `FIXTURE_REVISION` is re-declared in `seed-public-surface.js` because
	// `seed-election-surface.js` does not export it. This is what makes that
	// re-declaration a checked mirror rather than a guess: a divergence fails
	// here instead of surfacing as a silently empty aggregate downstream.
	const row = await db
		.prepare('select Revision from ElectionRevision where ElectionId = :eid')
		.get({ eid: FIXTURE_ELECTION_DB_ID });
	assert.equal(Number(row?.Revision), FIXTURE_REVISION);
});

test('the settling instant sits strictly inside the timeline it claims to (D-14)', () => {
	assert.ok(
		FIXTURE_SETTLING_INSTANT > SEED_TIMELINE.tallyingStarts,
		`${FIXTURE_SETTLING_INSTANT} must follow tallyingStarts ${SEED_TIMELINE.tallyingStarts}`,
	);
	assert.ok(
		FIXTURE_SETTLING_INSTANT < SEED_TIMELINE.closed,
		`${FIXTURE_SETTLING_INSTANT} must precede closed ${SEED_TIMELINE.closed}`,
	);
});

test('readKeyReleaseProgress reports a non-zero released strictly below total (D-14)', async () => {
	const progress = await readKeyReleaseProgress(db, FIXTURE_ELECTION_DB_ID, FIXTURE_REVISION);
	// 62-126: `released` is the number of PUBLISHED KeyholderShareRelease rows (3), and `total` is the
	// keyholders of record. The completed-task count (also 3, a different set of users) no longer
	// feeds it.
	const shares = await db
		.prepare('select count(*) as c from KeyholderShareRelease where ElectionId = :eid and ElectionRevision = :rev')
		.get({ eid: FIXTURE_ELECTION_DB_ID, rev: FIXTURE_REVISION });
	assert.equal(progress.released, Number(shares?.c ?? -1), 'released must equal the published share-row count');
	assert.equal(progress.released, EXPECTED_RELEASED);
	assert.equal(progress.total, EXPECTED_TOTAL);
	assert.equal(progress.keyholderCount, EXPECTED_KEYHOLDERS);

	// The two facts that actually matter, asserted RELATIONALLY rather than as
	// the literals above: `0 of 0` and `N of N` each render a degenerate
	// sentence that hides an aggregate bug, so a fixture that drifted into
	// either extreme must fail here even if the literals were updated to match.
	assert.ok(progress.released > 0, 'released must be non-zero — a stuck-at-zero aggregate would look correct at 0 of 0');
	assert.ok(
		progress.released < progress.total,
		'released must be strictly below total — an aggregate counting every row instead of the released ones looks correct at N of N',
	);
});

test('the aggregate leaks no key that could identify a keyholder (D-14)', async () => {
	const progress = await readKeyReleaseProgress(db, FIXTURE_ELECTION_DB_ID, FIXTURE_REVISION);
	assert.deepEqual(
		Object.keys(progress).sort(),
		['keyholderCount', 'released', 'total'],
		`unexpected key set: ${JSON.stringify(Object.keys(progress))}`,
	);
});

test('the merged row-count expectation puts User at 5, not the founding fixture 1', () => {
	// The spread order in `seed-public-surface.js` is load-bearing. Asserted
	// here so a wrongly-ordered spread fails at its cause rather than as a
	// mystery count mismatch below.
	assert.equal(PUBLIC_SURFACE_EXPECTED_COUNTS.User, 5);
});

test('assertRowCounts holds over every table the public surface seeds', async () => {
	// This is how the row-count integrity contract learns about
	// RegistrantPublic, Task, ReleaseKeyTaskExtension, Keyholder and InviteSlot
	// without editing `packages/web-data/test/reattach.test.mjs`, which belongs
	// to another plan.
	const live = await assertRowCounts(db, PUBLIC_SURFACE_EXPECTED_COUNTS);
	assert.deepEqual(live, { ...PUBLIC_SURFACE_EXPECTED_COUNTS });
});

test('positive control: assertRowCounts rejects a deliberately wrong RegistrantPublic count', async () => {
	// Without this, an expectation object that silently lost its new keys would
	// still report green — the check would simply have less to check.
	await assert.rejects(
		() => assertRowCounts(db, { ...PUBLIC_SURFACE_EXPECTED_COUNTS, RegistrantPublic: 4 }),
		RowCountMismatchError,
	);
});

test('teardown: close the shared handle', async () => {
	await closeNetworkDb(db);
});
