/**
 * registrations-intake.test.mjs -- C3's bucketed registration-intake series
 * (D-04). Two tiers, and neither alone is the proof:
 *
 *   - P1-P6 (this file's first section) exercise the three PURE bucket
 *     helpers directly, reached by module URL (`registrations.js` is not
 *     the barrel's own surface for these -- they are internals, see the
 *     barrel comment in `officer/index.js`).
 *   - S1-S6 (added by 60-02 Task 2) exercise `readRegistrationIntakeSeries`
 *     itself, through the barrel, against BOTH the real schema (S1/S2 --
 *     `RegistrationRequest` is unseedable against the real schema, so these
 *     only pin the SQL constants to the real table) and a scratch table
 *     (S3-S6 -- the only way to get real rows through the real SQL, since
 *     `RegistrationRequest`'s row-level SignatureValid CHECK needs a genuine
 *     secp256k1/P-256 signature this workspace cannot produce).
 *   - D1-D5 (added by 60-02 Task 3) assert D-04 by source (comment-stripped,
 *     never a comment-only ban) and prove the error path logs the class
 *     only (T-60-02).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Database } from '@quereus/quereus';
import { prepareDb } from '@votetorrent/vote-engine/browser';
import { readRegistrationIntakeSeries, IntakeSeriesReadError, REGISTRATIONS_TABLES_READ } from '@votetorrent/web-data/officer';
import { seedFoundingAuthority } from './fixtures/seed-founding-authority.js';
import { webDataSrc } from '../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../scripts/lib/strip-comments.mjs';

const registrationsModule = await import(pathToFileURL(webDataSrc('officer', 'registrations.js')).href);
const { chooseIntakeBucketUnit, densifyIntakeBuckets, foldDayBucketsIntoWeeks, INTAKE_HOUR_MAX_SPAN_MS, INTAKE_DAY_MAX_SPAN_MS } =
	registrationsModule;

// The banned column name is ASSEMBLED, never written out, so it appears in
// this file exactly once -- as the joined literal below. Otherwise this
// test file's own header/comments could satisfy the matcher it exists to
// prove is discriminating (the self-tripping-checker failure mode this repo
// has shipped before).
const BANNED_TIME_COLUMN = ['Submitted', 'At'].join('');

/** @returns {Promise<import('@quereus/quereus').Database>} */
async function foundingOnlyDb() {
	const db = new Database();
	await prepareDb(db);
	await seedFoundingAuthority(db);
	return db;
}

/**
 * A scratch two-column RegistrationRequest table -- `RegistrationRequest` is
 * unseedable against the real schema (row-level SignatureValid CHECK needs a
 * genuine secp256k1/P-256 signature this workspace has no dependency for),
 * so this is the only way to run the real frozen SQL constants over real
 * rows. Pairs with S1/S2's real-schema rungs so the proof is not
 * scratch-only.
 *
 * @param {ReadonlyArray<{id: string, receivedAt: string | null}>} rows
 * @returns {Promise<import('@quereus/quereus').Database>}
 */
async function scratchIntakeDb(rows) {
	const db = new Database();
	await db.exec('create table RegistrationRequest (Id text primary key, ReceivedAt text)');
	for (const row of rows) {
		// eslint-disable-next-line no-await-in-loop -- sequential inserts against one shared handle, this project's tier-1 discipline
		await db.exec('insert into RegistrationRequest (Id, ReceivedAt) values (:id, :receivedAt)', { id: row.id, receivedAt: row.receivedAt });
	}
	return db;
}

// ─────────────────────────────────────────────────────────────────────────
// P1-P6 -- the pure bucket core, reached by direct module URL
// ─────────────────────────────────────────────────────────────────────────

test('P1 thresholds: chooseIntakeBucketUnit flips at exactly 48h and 56d, both boundaries inclusive of the finer unit', () => {
	assert.equal(chooseIntakeBucketUnit(0), 'hour');
	assert.equal(chooseIntakeBucketUnit(INTAKE_HOUR_MAX_SPAN_MS), 'hour');
	assert.equal(chooseIntakeBucketUnit(INTAKE_HOUR_MAX_SPAN_MS + 1), 'day');
	assert.equal(chooseIntakeBucketUnit(INTAKE_DAY_MAX_SPAN_MS), 'day');
	assert.equal(chooseIntakeBucketUnit(INTAKE_DAY_MAX_SPAN_MS + 1), 'week');
});

test('P1b: the two threshold constants are pinned to their literal millisecond values', () => {
	assert.equal(INTAKE_HOUR_MAX_SPAN_MS, 172800000, '48 hours in ms');
	assert.equal(INTAKE_DAY_MAX_SPAN_MS, 4838400000, '56 days in ms');
});

test('P2 discrimination control: a stub that ignores its argument disagrees with the five-point boundary sequence', () => {
	const spans = [0, INTAKE_HOUR_MAX_SPAN_MS, INTAKE_HOUR_MAX_SPAN_MS + 1, INTAKE_DAY_MAX_SPAN_MS, INTAKE_DAY_MAX_SPAN_MS + 1];
	const real = spans.map((s) => chooseIntakeBucketUnit(s));
	/** @param {number} _spanMs @returns {string} */
	const stub = (_spanMs) => 'day';
	const stubbed = spans.map((s) => stub(s));
	assert.deepEqual(real, ['hour', 'hour', 'day', 'day', 'week']);
	assert.notDeepEqual(stubbed, real, 'a unit-ignoring stub must disagree with the real boundary sequence -- P1 must be able to fail');
});

test('P3 hour densification: two hour buckets on one UTC day densify to four rows with zero-count interior gaps', () => {
	const rows = densifyIntakeBuckets(
		[
			{ bucketStart: '2026-09-15T13:00:00', count: 1 },
			{ bucketStart: '2026-09-15T16:00:00', count: 1 },
		],
		'hour',
	);
	assert.deepEqual(rows, [
		{ bucketStart: '2026-09-15T13:00:00', count: 1 },
		{ bucketStart: '2026-09-15T14:00:00', count: 0 },
		{ bucketStart: '2026-09-15T15:00:00', count: 0 },
		{ bucketStart: '2026-09-15T16:00:00', count: 1 },
	]);
});

test('P4 day densification across a month boundary: eight rows, September into October, epoch-step not calendar arithmetic', () => {
	const rows = densifyIntakeBuckets(
		[
			{ bucketStart: '2026-09-25', count: 1 },
			{ bucketStart: '2026-10-02', count: 1 },
		],
		'day',
	);
	assert.deepEqual(rows, [
		{ bucketStart: '2026-09-25', count: 1 },
		{ bucketStart: '2026-09-26', count: 0 },
		{ bucketStart: '2026-09-27', count: 0 },
		{ bucketStart: '2026-09-28', count: 0 },
		{ bucketStart: '2026-09-29', count: 0 },
		{ bucketStart: '2026-09-30', count: 0 },
		{ bucketStart: '2026-10-01', count: 0 },
		{ bucketStart: '2026-10-02', count: 1 },
	]);
});

test('P5 densification control: an identity stub over P3s input fails the four-row expectation', () => {
	const input = [
		{ bucketStart: '2026-09-15T13:00:00', count: 1 },
		{ bucketStart: '2026-09-15T16:00:00', count: 1 },
	];
	/** @param {{bucketStart: string, count: number}[]} rows @returns {{bucketStart: string, count: number}[]} */
	const identityStub = (rows) => rows;
	const stubbedResult = identityStub(input);
	assert.notDeepEqual(
		stubbedResult,
		[
			{ bucketStart: '2026-09-15T13:00:00', count: 1 },
			{ bucketStart: '2026-09-15T14:00:00', count: 0 },
			{ bucketStart: '2026-09-15T15:00:00', count: 0 },
			{ bucketStart: '2026-09-15T16:00:00', count: 1 },
		],
		'a gap-preserving implementation must fail the four-row expectation -- the exact defect class P3 exists to catch',
	);
});

test('P6 week folding: three day buckets anchor on the earliest and fold to week indexes 0/2/21', () => {
	const dayRows = [
		{ bucketStart: '2026-01-05', count: 1 },
		{ bucketStart: '2026-01-20', count: 1 },
		{ bucketStart: '2026-06-01', count: 1 },
	];
	const weekRows = foldDayBucketsIntoWeeks(dayRows);
	assert.deepEqual(weekRows, [
		{ bucketStart: '2026-01-05', count: 1 },
		{ bucketStart: '2026-01-19', count: 1 },
		{ bucketStart: '2026-06-01', count: 1 },
	]);

	const densified = densifyIntakeBuckets(weekRows, 'week');
	assert.equal(densified.length, 22);
	for (let i = 1; i < densified.length; i += 1) {
		const stepMs = Date.parse(densified[i].bucketStart + 'T00:00:00Z') - Date.parse(densified[i - 1].bucketStart + 'T00:00:00Z');
		assert.equal(stepMs, 604800000, 'every step must be exactly WEEK_MS');
	}
	const nonZeroIndexes = new Set([0, 2, 21]);
	for (let i = 0; i < densified.length; i += 1) {
		assert.equal(densified[i].count, nonZeroIndexes.has(i) ? 1 : 0, 'index ' + i + ' count mismatch');
	}
});

// ─────────────────────────────────────────────────────────────────────────
// S1-S6 -- readRegistrationIntakeSeries through the barrel, real schema +
// scratch bucketing. RegistrationRequest is unseedable against the real
// schema, so S1/S2 pin the constants to the real table while S3-S6 exercise
// the real SQL against a scratch table. Neither rung alone is the proof.
// ─────────────────────────────────────────────────────────────────────────

test('S1 real-schema validity + anti-vacuity: an empty founding-only db returns [] and the span query returns the all-null/zero row', async () => {
	const db = await foundingOnlyDb();
	assert.deepEqual(await readRegistrationIntakeSeries(db), []);
	const span = await db.prepare(registrationsModule.INTAKE_SPAN_SQL).get({});
	assert.deepEqual(span, { earliest: null, latest: null, total: 0 });
	// 62-01 Task 3: the registrations read surface deliberately widened 13 -> 14
	// (AuthorityIntakePolicy, D-29/D-46) -- a DIFFERENT, deliberate widening than the one T-60-01
	// guards against; this pin moves in the SAME commit as the schema/capability-generator edit
	// that caused it.
	assert.equal(REGISTRATIONS_TABLES_READ.length, 14, 'the read surface did not widen beyond the deliberate 62-01 addition (T-60-01)');
	assert.ok(REGISTRATIONS_TABLES_READ.includes('RegistrationRequest'));
});

test('S2 real-schema positive control: mutating the real INTAKE_DAILY_SQL constant to a wrong column name is rejected by name', async () => {
	const db = await foundingOnlyDb();
	const mutated = registrationsModule.INTAKE_DAILY_SQL.replace('ReceivedAt', 'ReceivedAtt');
	await assert.rejects(() => db.prepare(mutated).get({}), /ReceivedAtt/, 'this is what proves S1 ran against the real table and not one Quereus invented');
});

test('S3 scratch bucketing: hour instants over one UTC day produce the P3 four-row expectation through the real SQL', async () => {
	const db = await scratchIntakeDb([
		{ id: 'a', receivedAt: '2026-09-15T13:10:00.000Z' },
		{ id: 'b', receivedAt: '2026-09-15T16:20:00.000Z' },
	]);
	assert.deepEqual(await readRegistrationIntakeSeries(db), [
		{ bucketStart: '2026-09-15T13:00:00', count: 1 },
		{ bucketStart: '2026-09-15T14:00:00', count: 0 },
		{ bucketStart: '2026-09-15T15:00:00', count: 0 },
		{ bucketStart: '2026-09-15T16:00:00', count: 1 },
	]);
});

test('S4 scratch bucketing: day instants crossing a month boundary produce the P4 eight-row expectation through the real SQL', async () => {
	const db = await scratchIntakeDb([
		{ id: 'a', receivedAt: '2026-09-25T23:00:00.000Z' },
		{ id: 'b', receivedAt: '2026-10-02T01:00:00.000Z' },
	]);
	assert.deepEqual(await readRegistrationIntakeSeries(db), [
		{ bucketStart: '2026-09-25', count: 1 },
		{ bucketStart: '2026-09-26', count: 0 },
		{ bucketStart: '2026-09-27', count: 0 },
		{ bucketStart: '2026-09-28', count: 0 },
		{ bucketStart: '2026-09-29', count: 0 },
		{ bucketStart: '2026-09-30', count: 0 },
		{ bucketStart: '2026-10-01', count: 0 },
		{ bucketStart: '2026-10-02', count: 1 },
	]);
});

test('S5 scratch bucketing: instants 147 days apart produce the P6 22-row week expectation through the real SQL', async () => {
	const db = await scratchIntakeDb([
		{ id: 'a', receivedAt: '2026-01-05T00:00:00.000Z' },
		{ id: 'b', receivedAt: '2026-01-20T12:00:00.000Z' },
		{ id: 'c', receivedAt: '2026-06-01T00:00:00.000Z' },
	]);
	const series = await readRegistrationIntakeSeries(db);
	assert.equal(series.length, 22);
	const nonZeroIndexes = new Set([0, 2, 21]);
	for (let i = 0; i < series.length; i += 1) {
		assert.equal(series[i].count, nonZeroIndexes.has(i) ? 1 : 0, 'index ' + i + ' count mismatch');
	}
	for (let i = 1; i < series.length; i += 1) {
		const stepMs = Date.parse(series[i].bucketStart + 'T00:00:00Z') - Date.parse(series[i - 1].bucketStart + 'T00:00:00Z');
		assert.equal(stepMs, 604800000);
	}
});

test('S6 shape and robustness: a malformed ReceivedAt is excluded, every row has exactly two keys, count is a number, bucketStart strictly ascends', async () => {
	const db = await scratchIntakeDb([
		{ id: 'a', receivedAt: '2026-09-25T23:00:00.000Z' },
		{ id: 'b', receivedAt: '2026-10-02T01:00:00.000Z' },
		// Lexicographically BETWEEN the two valid boundaries (deliberately, so it
		// never becomes the span query's min/max) -- proves the malformed row is
		// dropped by the grouped query's own null bucketStart, not by an
		// unrelated span-parse short-circuit.
		{ id: 'c', receivedAt: '2026-09-28-not-a-real-timestamp' },
	]);
	const series = await readRegistrationIntakeSeries(db);
	assert.ok(series.length > 0);
	let previous = '';
	for (const row of series) {
		assert.deepEqual(Object.keys(row), ['bucketStart', 'count']);
		assert.equal(typeof row.count, 'number');
		assert.doesNotMatch(row.bucketStart, /NaN|Invalid|null|undefined/);
		assert.ok(row.bucketStart > previous, 'bucketStart must be strictly ascending');
		previous = row.bucketStart;
	}
});

// ─────────────────────────────────────────────────────────────────────────
// D1-D5 -- the D-04 source assertion (with its code- and comment-position
// controls) and the T-60-02 class-only error-logging proof.
// ─────────────────────────────────────────────────────────────────────────

test('D1 D-04 source assertion: comment-stripped module source names ReceivedAt and never the submitter-supplied column', () => {
	const source = readFileSync(webDataSrc('officer', 'registrations.js'), 'utf8');
	const stripped = stripComments(source);
	assert.match(stripped, /ReceivedAt/, 'the module must reference ReceivedAt in code');
	assert.doesNotMatch(
		stripped,
		new RegExp(BANNED_TIME_COLUMN),
		'the module must never reference the submitter-supplied column in code (D-04)',
	);
});

test('D2 code-position positive control: the real INTAKE_DAILY_SQL mutated to name the banned column fires the same matcher', () => {
	const mutated = registrationsModule.INTAKE_DAILY_SQL.replace('ReceivedAt', BANNED_TIME_COLUMN);
	assert.match(mutated, new RegExp(BANNED_TIME_COLUMN), 'mutating a real constant to the banned name must be detectable by the same matcher D1 uses');
});

test('D3 comment-position inertness control: a *-prefixed comment naming the banned column stays inert after stripping', () => {
	const synthetic = ['/**', ' * ' + BANNED_TIME_COLUMN + ' is named here only as prose, never as code.', ' */', 'const keep = 1;'].join('\n');
	const stripped = stripComments(synthetic);
	assert.doesNotMatch(
		stripped,
		new RegExp(BANNED_TIME_COLUMN),
		'a comment-only mention must not trip the matcher -- D1 passes because the identifier is absent from CODE, not because the file happens to contain no prose about it',
	);
});

test('D4 error path logs the class only (T-60-02): a schema-less db logs RelationNotFoundError and nothing else', async () => {
	const db = new Database();
	const originalConsoleError = console.error;
	/** @type {unknown[][]} */
	const calls = [];
	console.error = (...args) => {
		calls.push(args);
	};
	try {
		await assert.rejects(
			() => readRegistrationIntakeSeries(db),
			(err) => {
				assert.ok(err instanceof IntakeSeriesReadError);
				assert.equal(/** @type {any} */ (err).originalName, 'RelationNotFoundError');
				assert.equal(err.cause, undefined, 'an attached cause would re-export the message the log just withheld');
				assert.doesNotMatch(err.message, /RegistrationRequest/);
				assert.doesNotMatch(err.message, /not found/);
				assert.doesNotMatch(err.message, /schema path/);
				return true;
			},
		);
	} finally {
		console.error = originalConsoleError;
	}
	assert.equal(calls.length, 1, 'exactly one console.error call');
	const joined = calls[0].join(' ');
	assert.match(joined, /RelationNotFoundError/);
	assert.match(joined, /officer\/registrations intake:/);
	assert.doesNotMatch(joined, /RegistrationRequest/, 'the raw engine message names the table -- a real leak signal');
	assert.doesNotMatch(joined, /not found/, 'the raw engine message says "not found" -- a real leak signal');
	assert.doesNotMatch(joined, /schema path/, 'the raw engine message says "schema path" -- a real leak signal');
});

test('D5 capture-harness control: the same harness around a raw engine message DOES show the table name', () => {
	const originalConsoleError = console.error;
	/** @type {unknown[][]} */
	const calls = [];
	console.error = (...args) => {
		calls.push(args);
	};
	try {
		console.error("Table 'RegistrationRequest' not found in schema path: main");
	} finally {
		console.error = originalConsoleError;
	}
	assert.equal(calls.length, 1);
	assert.match(calls[0].join(' '), /RegistrationRequest/, "without this, D4's \"no table name\" assertion would also pass on a broken, non-capturing harness");
});
