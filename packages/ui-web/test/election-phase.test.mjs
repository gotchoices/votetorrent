/**
 * election-phase.test.mjs -- exhaustive boundary, indeterminate, fail-closed
 * and positive-control tests for `src/lifecycle/election-phase.js`.
 *
 * Rewritten in Phase 54 (D-06/D-07/D-10) against spike 086's four-phase
 * `derivePhase` newest-first boundary walk, replacing the three-phase
 * (`organizing`/`running`/`released`) interval-walk suite 53-05 moved
 * verbatim from the dashboard. The 32 pre-existing `ELECTION_EVENT_ORDER`,
 * `assertCanonicalDatetime` and `resolveComparisonInstant` cases are kept
 * unchanged -- those three exports are untouched by this plan.
 *
 * This file adds no in-process database and no fixture import of any kind --
 * none of these cases needs one, and adding one would give this package a
 * dependency the moved module does not have.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
	ELECTION_EVENT_ORDER,
	PHASE_IDS,
	PHASE_OPENED_BY,
	CONFLICT,
	assertCanonicalDatetime,
	resolveComparisonInstant,
	derivePhase,
	parseTimeline,
	normalizeInstant,
	phaseCopyKey,
} from '../src/lifecycle/election-phase.js';
import { INDETERMINATE_PHASE } from '../src/lifecycle/phase-ids.js';
import { uiWebSrc } from '../../../scripts/lib/source-paths.mjs';
import { t } from '../src/copy.js';

// A well-formed ten-event timeline (canonical string form), spanning all
// four phases. Grown from the original seven (Phase 59, D-08/D-09): the
// three new events (accruingVotes/hashingVotes/releasingKeys) sit between
// votingStarts (08:00) and tallyingStarts (20:00), on the same day.
const FULL_TIMELINE = Object.freeze({
	registrationEnds: '2026-10-01T00:00:00',
	ballotsFinal: '2026-10-05T00:00:00',
	votingStarts: '2026-11-03T08:00:00',
	accruingVotes: '2026-11-03T12:00:00',
	hashingVotes: '2026-11-03T14:00:00',
	releasingKeys: '2026-11-03T16:00:00',
	tallyingStarts: '2026-11-03T20:00:00',
	validation: '2026-11-04T08:00:00',
	certificationStarts: '2026-11-05T08:00:00',
	closed: '2026-11-06T08:00:00',
});

const FULL_TIMELINE_NUMBERS = Object.freeze(
	Object.fromEntries(Object.entries(FULL_TIMELINE).map(([k, v]) => [k, Date.parse(v + 'Z')])),
);

// --- ELECTION_EVENT_ORDER, unchanged (D-25 carry-forward) -------------------

test('ELECTION_EVENT_ORDER deep-equals the ten ElectionEvent values in schema order (D-08/D-09)', () => {
	assert.deepEqual(ELECTION_EVENT_ORDER, [
		'registrationEnds',
		'ballotsFinal',
		'votingStarts',
		'accruingVotes',
		'hashingVotes',
		'releasingKeys',
		'tallyingStarts',
		'validation',
		'certificationStarts',
		'closed',
	]);
});

// --- PHASE_IDS / PHASE_OPENED_BY vocabulary-drift guards --------------------

test('PHASE_IDS is the frozen four-element array in chronological order', () => {
	assert.deepEqual(PHASE_IDS, ['pre', 'voting', 'settling', 'closed']);
	assert.ok(Object.isFrozen(PHASE_IDS));
});

test("PHASE_IDS does NOT contain 'indeterminate'", () => {
	assert.ok(!(/** @type {ReadonlyArray<string>} */ (PHASE_IDS)).includes(INDETERMINATE_PHASE));
});

test('Object.keys(PHASE_OPENED_BY) deep-equals PHASE_IDS.slice(1) -- the walk and the vocabulary cannot diverge', () => {
	assert.deepEqual(Object.keys(PHASE_OPENED_BY), PHASE_IDS.slice(1));
});

test('PHASE_OPENED_BY names the correct opening event for each phase', () => {
	assert.deepEqual(PHASE_OPENED_BY, {
		voting: 'votingStarts',
		settling: 'tallyingStarts',
		closed: 'closed',
	});
});

// --- derivePhase: boundary walk, string-valued timeline ---------------------

test('derivePhase: one second before votingStarts is pre, indeterminate: false', () => {
	const result = derivePhase({}, FULL_TIMELINE, '2026-11-03T07:59:59');
	assert.equal(result.phase, 'pre');
	assert.equal(result.indeterminate, false);
});

test('derivePhase: exactly at votingStarts is voting (half-open [start, next))', () => {
	const result = derivePhase({}, FULL_TIMELINE, '2026-11-03T08:00:00');
	assert.equal(result.phase, 'voting');
	assert.equal(result.indeterminate, false);
});

test('derivePhase: exactly at tallyingStarts is settling', () => {
	const result = derivePhase({}, FULL_TIMELINE, '2026-11-03T20:00:00');
	assert.equal(result.phase, 'settling');
	assert.equal(result.indeterminate, false);
});

test('derivePhase: one second before the closed event is still settling', () => {
	// one second before closed (2026-11-06T08:00:00) is 2026-11-06T07:59:59
	const before = derivePhase({}, FULL_TIMELINE, '2026-11-06T07:59:59');
	assert.equal(before.phase, 'settling');
	assert.equal(before.indeterminate, false);
});

test('derivePhase: exactly at the closed event, and any instant after, is closed', () => {
	const atClosed = derivePhase({}, FULL_TIMELINE, '2026-11-06T08:00:00');
	assert.equal(atClosed.phase, 'closed');
	assert.equal(atClosed.indeterminate, false);
	const afterClosed = derivePhase({}, FULL_TIMELINE, '2027-01-01T00:00:00');
	assert.equal(afterClosed.phase, 'closed');
	assert.equal(afterClosed.indeterminate, false);
});

// --- derivePhase: the same boundaries, epoch-millisecond timeline -----------

test('derivePhase (number timeline): boundary walk agrees with the string form at every sampled instant', () => {
	const instants = [
		'2026-11-03T07:59:59',
		'2026-11-03T08:00:00',
		'2026-11-03T20:00:00',
		'2026-11-06T07:59:59',
		'2026-11-06T08:00:00',
		'2027-01-01T00:00:00',
	];
	for (const at of instants) {
		const fromString = derivePhase({}, FULL_TIMELINE, at);
		const fromNumbers = derivePhase({}, FULL_TIMELINE_NUMBERS, at);
		assert.equal(fromNumbers.phase, fromString.phase, `phase mismatch at ${at}`);
		assert.equal(fromNumbers.indeterminate, fromString.indeterminate, `indeterminate mismatch at ${at}`);
	}
});

// --- derivePhase: indeterminate cases ----------------------------------------

test('derivePhase: a timeline missing closed, with now after tallyingStarts, is indeterminate with firedRule "closed"', () => {
	const { closed: _closed, ...timeline } = FULL_TIMELINE;
	const result = derivePhase({}, timeline, '2026-11-04T00:00:00');
	assert.equal(result.phase, INDETERMINATE_PHASE);
	assert.equal(result.indeterminate, true);
	assert.equal(result.firedRule, 'closed');
});

test('derivePhase: a timeline missing votingStarts, with now after tallyingStarts, is a CONFIDENT settling (rung 5)', () => {
	const { votingStarts: _votingStarts, ...timeline } = FULL_TIMELINE;
	const result = derivePhase({}, timeline, '2026-11-04T00:00:00');
	assert.equal(result.phase, 'settling');
	assert.equal(result.indeterminate, false);
});

test('derivePhase: a timeline missing votingStarts, with now BEFORE tallyingStarts, is indeterminate with firedRule "votingStarts"', () => {
	const { votingStarts: _votingStarts, ...timeline } = FULL_TIMELINE;
	const result = derivePhase({}, timeline, '2026-11-03T10:00:00');
	assert.equal(result.phase, INDETERMINATE_PHASE);
	assert.equal(result.indeterminate, true);
	assert.equal(result.firedRule, 'votingStarts');
});

test('derivePhase: an unparseable `now` is indeterminate with firedRule: null', () => {
	const result = derivePhase({}, FULL_TIMELINE, 'not-a-date');
	assert.equal(result.phase, INDETERMINATE_PHASE);
	assert.equal(result.indeterminate, true);
	assert.equal(result.firedRule, null);
});

test('derivePhase never throws for null / undefined / "" / a non-object / an array timeline, nor for foreign `now` values', () => {
	const foreignTimelines = [null, undefined, '', '{not json', 42, [], 'not-a-date'];
	for (const timeline of foreignTimelines) {
		assert.doesNotThrow(() => derivePhase({}, timeline, '2026-11-03T08:00:00'));
		assert.doesNotThrow(() => derivePhase({}, timeline, 'not-a-date'));
		assert.doesNotThrow(() => derivePhase({}, timeline, null));
		assert.doesNotThrow(() => derivePhase({}, timeline, undefined));
	}
});

// --- derivePhase: JSON-string timeline (deviation (e)) -----------------------

test('derivePhase accepts the timeline as a JSON string and derives the identical phase as the parsed-object form', () => {
	const asString = JSON.stringify(FULL_TIMELINE);
	const instants = ['2026-11-03T07:59:59', '2026-11-03T08:00:00', '2026-11-03T20:00:00', '2026-11-06T08:00:00'];
	for (const at of instants) {
		const fromObject = derivePhase({}, FULL_TIMELINE, at);
		const fromString = derivePhase({}, asString, at);
		assert.equal(fromString.phase, fromObject.phase, `phase mismatch at ${at}`);
		assert.equal(fromString.indeterminate, fromObject.indeterminate, `indeterminate mismatch at ${at}`);
	}
});

test('derivePhase: a JSON string that does not parse degrades to indeterminate, never a confident phase', () => {
	const result = derivePhase({}, '{not json', '2026-11-03T08:00:00');
	assert.equal(result.phase, INDETERMINATE_PHASE);
	assert.equal(result.indeterminate, true);
});

// --- normalizeInstant --------------------------------------------------------

test("normalizeInstant('2026-11-03T08:00:00') strictly equals Date.UTC(2026, 10, 3, 8, 0, 0) -- explicit UTC (D-26)", () => {
	assert.equal(normalizeInstant('2026-11-03T08:00:00'), Date.UTC(2026, 10, 3, 8, 0, 0));
});

test('normalizeInstant accepts a finite number unchanged', () => {
	assert.equal(normalizeInstant(1_700_000_000_000), 1_700_000_000_000);
});

test('normalizeInstant returns null for NaN, a non-finite number, a non-string non-number, and an empty/whitespace string', () => {
	assert.equal(normalizeInstant(NaN), null);
	assert.equal(normalizeInstant(Infinity), null);
	assert.equal(normalizeInstant(-Infinity), null);
	assert.equal(normalizeInstant({}), null);
	assert.equal(normalizeInstant([]), null);
	assert.equal(normalizeInstant(true), null);
	assert.equal(normalizeInstant(''), null);
	assert.equal(normalizeInstant('   '), null);
	assert.equal(normalizeInstant(null), null);
	assert.equal(normalizeInstant(undefined), null);
});

// --- parseTimeline: conflict classification ----------------------------------

test('parseTimeline reports MISSING_EVENT for an absent event', () => {
	const { conflicts } = parseTimeline({ ...FULL_TIMELINE, registrationEnds: undefined });
	assert.ok(
		conflicts.some((c) => c.code === CONFLICT.MISSING_EVENT && c.event === 'registrationEnds'),
	);
});

test('parseTimeline reports UNPARSEABLE for a present-but-unreadable event', () => {
	const { conflicts } = parseTimeline({ ...FULL_TIMELINE, votingStarts: 'not-a-date' });
	assert.ok(conflicts.some((c) => c.code === CONFLICT.UNPARSEABLE && c.event === 'votingStarts'));
});

test('parseTimeline reports OUT_OF_ORDER only across the strict post-voting chain -- ballotsFinal preceding registrationEnds is NOT a conflict', () => {
	const timeline = {
		...FULL_TIMELINE,
		registrationEnds: '2026-10-05T00:00:00',
		ballotsFinal: '2026-10-01T00:00:00', // earlier than registrationEnds, on purpose
	};
	const { conflicts } = parseTimeline(timeline);
	assert.ok(
		!conflicts.some((c) => c.code === CONFLICT.OUT_OF_ORDER && (c.event === 'ballotsFinal' || c.event === 'registrationEnds')),
		`expected no OUT_OF_ORDER conflict between ballotsFinal/registrationEnds, got: ${JSON.stringify(conflicts)}`,
	);
});

test('parseTimeline reports OUT_OF_ORDER for the strict post-voting chain out of order', () => {
	const timeline = { ...FULL_TIMELINE, tallyingStarts: '2026-11-02T00:00:00' }; // before votingStarts
	const { conflicts } = parseTimeline(timeline);
	assert.ok(conflicts.some((c) => c.code === CONFLICT.OUT_OF_ORDER && c.event === 'tallyingStarts'));
});

// --- derivePhase's phase is always a member of the vocabulary ---------------

test('every phase derivePhase can return is a member of PHASE_IDS or is INDETERMINATE_PHASE', () => {
	const samples = [
		derivePhase({}, FULL_TIMELINE, '2026-11-03T07:59:59'),
		derivePhase({}, FULL_TIMELINE, '2026-11-03T08:00:00'),
		derivePhase({}, FULL_TIMELINE, '2026-11-03T20:00:00'),
		derivePhase({}, FULL_TIMELINE, '2026-11-06T08:00:00'),
		derivePhase({}, null, '2026-11-03T08:00:00'),
		derivePhase({}, FULL_TIMELINE, 'not-a-date'),
	];
	for (const { phase } of samples) {
		assert.ok(
			(/** @type {ReadonlyArray<string>} */ (PHASE_IDS)).includes(phase) || phase === INDETERMINATE_PHASE,
			`unexpected phase: ${phase}`,
		);
	}
});

// --- phaseCopyKey -------------------------------------------------------------

test('phaseCopyKey resolves all four frozen lifecycle copy keys to non-empty strings via t()', () => {
	for (const phase of PHASE_IDS) {
		const key = phaseCopyKey(phase);
		assert.equal(key, `lifecycle.${phase}`);
		const resolved = t(key);
		assert.equal(typeof resolved, 'string');
		assert.ok(resolved.length > 0);
	}
});

test('phaseCopyKey(null) returns null', () => {
	assert.equal(phaseCopyKey(null), null);
});

test("phaseCopyKey(INDETERMINATE_PHASE) returns null -- 'indeterminate' resolves through INDETERMINATE_COPY_KEY, not phaseCopyKey", () => {
	assert.equal(phaseCopyKey(/** @type {any} */ (INDETERMINATE_PHASE)), null);
});

// --- assertCanonicalDatetime, unchanged (D-25 carry-forward) -----------------

test('assertCanonicalDatetime accepts a canonical 19-character value', () => {
	assert.equal(assertCanonicalDatetime('2026-11-03T08:00:00', 'x'), '2026-11-03T08:00:00');
});

test('positive control: assertCanonicalDatetime throws naming the label and the exact Z-suffixed value', () => {
	assert.throws(() => assertCanonicalDatetime('2026-11-03T08:00:00Z', 'myLabel'), (err) => {
		assert.ok(err instanceof Error);
		assert.match(err.message, /myLabel/);
		assert.match(err.message, /2026-11-03T08:00:00Z/);
		return true;
	});
});

test('assertCanonicalDatetime throws for a non-string value', () => {
	assert.throws(() => assertCanonicalDatetime(12345, 'x'));
});

// --- resolveComparisonInstant, unchanged (D-25 carry-forward) ----------------

test('resolveComparisonInstant returns a canonical value unchanged', () => {
	assert.equal(resolveComparisonInstant('2026-11-03T08:00:00'), '2026-11-03T08:00:00');
});

test('resolveComparisonInstant falls back to nowCanonicalDatetime() for null', () => {
	const result = resolveComparisonInstant(null);
	assert.match(result, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

test('resolveComparisonInstant falls back to nowCanonicalDatetime() for undefined', () => {
	const result = resolveComparisonInstant(undefined);
	assert.match(result, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

test('resolveComparisonInstant throws via assertCanonicalDatetime for a non-canonical non-nullish value', () => {
	assert.throws(() => resolveComparisonInstant('2026-11-03T08:00:00Z'));
});

// --- D-07 header restatement assertion ---------------------------------------

const ELECTION_PHASE_SOURCE = readFileSync(uiWebSrc('lifecycle', 'election-phase.js'), 'utf8');
const D07_RESTATEMENT_RE = /no longer byte-for-byte verbatim/;

test("D-07: the raw (un-stripped) header states the 086 lift is no longer byte-for-byte verbatim, and names threeBucket", () => {
	assert.match(ELECTION_PHASE_SOURCE, D07_RESTATEMENT_RE);
	assert.match(ELECTION_PHASE_SOURCE, /threeBucket/);
});

test('positive control: the D-07 matcher fires on a fixture carrying the sentence', () => {
	const fixture = 'This lift is no longer byte-for-byte verbatim, and threeBucket() is omitted.';
	assert.match(fixture, D07_RESTATEMENT_RE);
});

test('inertness control: the D-07 matcher REJECTS a fixture lacking the sentence -- the assertion above cannot pass vacuously', () => {
	const fixture = 'This lift is a verbatim transcription with no changes of any kind.';
	assert.doesNotMatch(fixture, D07_RESTATEMENT_RE);
});

test("threeBucket appears nowhere in the file's non-comment source -- only in the header comment", () => {
	const nonCommentLines = ELECTION_PHASE_SOURCE.split('\n').filter((line) => {
		const trimmed = line.trim();
		return !(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'));
	});
	assert.ok(!nonCommentLines.join('\n').includes('threeBucket'));
});
