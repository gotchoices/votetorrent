/**
 * timeline-core.test.mjs -- D-19 (dependency-free, twice-proven) and D-18
 * (newest-first "current, not next") gates for
 * `src/lifecycle/timeline-core.js` (Phase 59 plan 59-02).
 *
 * Three groups:
 *   A. D-19 at the source level -- a comment-and-string-stripped zero-import
 *      scan, mirroring `facts.test.mjs` rung 14 exactly, with a planted-import
 *      positive control and a grep-shaped CLI-equivalent rung.
 *   B. D-19 at runtime -- an isolated-child-process module-graph recorder
 *      (`fixtures/record-module-graph.mjs`), proven live by a `./lifecycle`
 *      positive control that DOES record `vote-engine`.
 *   C. D-18 -- the newest-first "current, not next" walk, proven over a
 *      41-point sample set DERIVED from a well-formed ten-event fixture's own
 *      boundaries, against an independent oracle, with Authority
 *      `Timeline.tsx:83`'s rejected `statusOf` walk standing by as a negative
 *      control. Plus the pre-D-08 seven-key regression: an older, seven-key
 *      signed timeline is an expected input, not a broken one.
 *
 * Every fixture in this file uses epoch-ms -- never a canonical string with a
 * trailing `Z` (`toCanonicalDatetime` silently strips it, so a `Z`-suffixed
 * fixture would test nothing it appears to test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { uiWebSrc } from '../../../scripts/lib/source-paths.mjs';
import { ELECTION_EVENT_ORDER, parseTimeline, finestStage, CONFLICT } from '../src/lifecycle/timeline-core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');
const RECORDER = path.join(HERE, 'fixtures', 'record-module-graph.mjs');

const TIMELINE_CORE_SOURCE = readFileSync(uiWebSrc('lifecycle', 'timeline-core.js'), 'utf8');

// ===========================================================================
// Group A -- D-19, dependency-free, at the source level (mirrors
// facts.test.mjs rung 14 exactly).
// ===========================================================================

/**
 * Strips `/** ... *\/` block comments.
 * @param {string} source
 * @returns {string}
 */
function stripBlockComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Strips `//` line comments on top of block comments.
 * @param {string} source
 * @returns {string}
 */
function stripAllComments(source) {
	return stripBlockComments(source).replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Strips string literals on top of comments, so a string mentioning an
 * import-shaped token cannot masquerade as source-level code the matcher
 * below would need to see.
 * @param {string} source
 * @returns {string}
 */
function stripCommentsAndStrings(source) {
	return stripAllComments(source).replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
}

// The matcher's own regex literal is kept OUT of any comment in this file --
// this repo's self-tripping-checker trap (a checker whose own comment quotes
// the pattern it greps for is permanently green) has been paid for three
// times in Phase 53 alone.
const IMPORT_OR_REQUIRE_RE = /(^|[^.\w])import\s*[({]|(^|[^.\w])import\s+[\w{*]|(^|[^.\w])require\s*\(/;

test('group A: timeline-core.js contains zero ES import statements and zero dynamic import(/require( calls, after stripping comments and strings', () => {
	const stripped = stripCommentsAndStrings(TIMELINE_CORE_SOURCE);
	assert.equal(IMPORT_OR_REQUIRE_RE.test(stripped), false, 'timeline-core.js must import nothing');
});

test('group A (positive control): the same matcher matches an inline fixture string containing an import statement', () => {
	const fixture = "// pretend comment\nimport { PHASE_IDS } from './phase-ids.js';\nexport const x = 1;";
	const strippedFixture = stripCommentsAndStrings(fixture);
	assert.equal(IMPORT_OR_REQUIRE_RE.test(strippedFixture), true, 'the matcher must be able to fail (detect an import)');
});

test('group A (CLI-equivalent): grep-shaped check -- zero lines matching ^import in timeline-core.js', () => {
	const lines = TIMELINE_CORE_SOURCE.split('\n');
	const importLines = lines.filter((line) => /^\s*import\b/.test(line));
	assert.deepEqual(importLines, []);
});

// ===========================================================================
// Group B -- D-19, dependency-free, at runtime, with a positive control.
// ===========================================================================

/**
 * Runs the recorder as its own child process against `specifier`, resolved
 * with `cwd` set to the package root so bare specifiers self-resolve, and
 * returns the recorded module-graph URL list.
 * @param {string} specifier
 * @returns {string[]}
 */
function recordModuleGraph(specifier) {
	const stdout = execFileSync(process.execPath, [RECORDER, specifier], {
		cwd: PACKAGE_ROOT,
		encoding: 'utf8',
	});
	return JSON.parse(stdout);
}

test('group B: @votetorrent/ui-web/lifecycle-core records a module graph of exactly one module, containing zero vote-engine/react-dom/react URLs', () => {
	const urls = recordModuleGraph('@votetorrent/ui-web/lifecycle-core');
	assert.equal(urls.length, 1, `expected exactly one recorded URL, got ${urls.length}: ${JSON.stringify(urls)}`);
	assert.ok(urls[0].endsWith('/timeline-core.js'), `expected the sole recorded URL to be timeline-core.js, got ${urls[0]}`);
	for (const forbidden of [/vote-engine/, /react-dom/, /[/\\]react[/\\]/]) {
		assert.ok(!urls.some((u) => forbidden.test(u)), `recorded graph must not contain a URL matching ${forbidden}, got ${JSON.stringify(urls)}`);
	}
});

test('group B (positive control): @votetorrent/ui-web/lifecycle DOES record a vote-engine URL -- proves the recorder is live, not silently inert', () => {
	const urls = recordModuleGraph('@votetorrent/ui-web/lifecycle');
	assert.ok(
		urls.some((u) => /vote-engine/.test(u)),
		`expected at least one recorded URL to match vote-engine (the recorder must be proven live), got ${JSON.stringify(urls)}`,
	);
});

// ===========================================================================
// Group C -- D-18, the newest-first "current, not next" walk.
// ===========================================================================

// A well-formed, strictly monotonic ten-event fixture (epoch-ms). Every
// sample point below is DERIVED from these ten instants -- no hand-picked
// instant appears anywhere in this group.
const TEN_EVENT_AT = Object.freeze({
	registrationEnds: Date.UTC(2026, 9, 1, 0, 0, 0),
	ballotsFinal: Date.UTC(2026, 9, 5, 0, 0, 0),
	votingStarts: Date.UTC(2026, 10, 3, 8, 0, 0),
	accruingVotes: Date.UTC(2026, 10, 3, 10, 0, 0),
	hashingVotes: Date.UTC(2026, 10, 3, 12, 0, 0),
	releasingKeys: Date.UTC(2026, 10, 3, 14, 0, 0),
	tallyingStarts: Date.UTC(2026, 10, 3, 20, 0, 0),
	validation: Date.UTC(2026, 10, 4, 8, 0, 0),
	certificationStarts: Date.UTC(2026, 10, 5, 8, 0, 0),
	closed: Date.UTC(2026, 10, 6, 8, 0, 0),
});

test('fixture sanity: TEN_EVENT_AT is strictly increasing in ELECTION_EVENT_ORDER order, and names all ten ids', () => {
	assert.deepEqual(Object.keys(TEN_EVENT_AT).sort(), [...ELECTION_EVENT_ORDER].sort());
	let prev = -Infinity;
	for (const event of ELECTION_EVENT_ORDER) {
		assert.ok(TEN_EVENT_AT[event] > prev, `${event} must be strictly after the previous event`);
		prev = TEN_EVENT_AT[event];
	}
});

/**
 * @typedef {object} Sample
 * @property {number} now
 * @property {'boundary' | 'midpoint' | 'outside'} kind
 * @property {string} [event] the event this sample is derived from (boundary kind)
 * @property {number} [offset] -1 | 0 | 1 (boundary kind)
 */

/**
 * Derive the 41-point sample set from `TEN_EVENT_AT`'s own boundaries: for
 * each event `e_i`, push `e_i - 1`, `e_i`, `e_i + 1`; for each adjacent pair,
 * push the integer midpoint; then push one point 24h before the first event
 * and one point 24h after the last. 3*10 + 9 + 2 = 41 for a ten-event
 * fixture.
 * @returns {Sample[]}
 */
function deriveSampleSet() {
	/** @type {Sample[]} */
	const samples = [];
	const events = [...ELECTION_EVENT_ORDER];
	const values = events.map((e) => TEN_EVENT_AT[e]);

	for (let i = 0; i < events.length; i++) {
		const ms = values[i];
		for (const offset of [-1, 0, 1]) {
			samples.push({ now: ms + offset, kind: 'boundary', event: events[i], offset });
		}
	}
	for (let i = 0; i < events.length - 1; i++) {
		const midpoint = Math.floor((values[i] + values[i + 1]) / 2);
		samples.push({ now: midpoint, kind: 'midpoint' });
	}
	samples.push({ now: values[0] - 86_400_000, kind: 'outside' });
	samples.push({ now: values[values.length - 1] + 86_400_000, kind: 'outside' });

	return samples;
}

const SAMPLES = deriveSampleSet();

test('sample-set sanity: deriveSampleSet() produces exactly 41 points for a ten-event fixture', () => {
	assert.equal(SAMPLES.length, 41);
});

/**
 * The independent oracle: a plain filter-and-last over the sorted
 * `[event, ms]` pairs -- NEVER a second call into `finestStage`,
 * `derivePhase` or `parseTimeline`.
 * @param {number} nowMs
 * @returns {string | null}
 */
function oracleFinestStage(nowMs) {
	const pairs = Object.entries(TEN_EVENT_AT).sort((a, b) => a[1] - b[1]);
	const passed = pairs.filter(([, ms]) => ms <= nowMs);
	if (passed.length === 0) return null;
	return passed[passed.length - 1][0];
}

/**
 * Authority `Timeline.tsx:83`'s REJECTED walk, implemented inline as the
 * negative control D-18 requires: `currentIdx` is the index of the FIRST
 * milestone whose date is `>= now` -- this lights the row one stage AHEAD of
 * the one the election is actually in, which is exactly why it is rejected.
 * @param {number} nowMs
 * @returns {string | null}
 */
function statusOfWalk(nowMs) {
	for (const event of ELECTION_EVENT_ORDER) {
		const ms = TEN_EVENT_AT[event];
		if (ms >= nowMs) return event;
	}
	return null;
}

test('group C (i): finestStage agrees with the independent oracle at every one of the 41 derived samples', () => {
	for (const sample of SAMPLES) {
		const actual = finestStage(TEN_EVENT_AT, sample.now);
		const expected = oracleFinestStage(sample.now);
		assert.equal(actual, expected, `mismatch at now=${sample.now} (${sample.kind}${sample.event ? `/${sample.event}` : ''})`);
	}
});

test('group C (ii): at each boundary instant e_i exactly, the current stage is event_i, never event_{i+1} -- D-18 half-open property', () => {
	const exactBoundarySamples = SAMPLES.filter((s) => s.kind === 'boundary' && s.offset === 0);
	assert.equal(exactBoundarySamples.length, ELECTION_EVENT_ORDER.length, 'expected one exact-boundary sample per event');
	for (const sample of exactBoundarySamples) {
		const stage = finestStage(TEN_EVENT_AT, sample.now);
		assert.equal(stage, sample.event, `at exactly ${sample.event}'s own instant, the stage must be ${sample.event}, not something else`);
	}
});

test('group C (iii): each of the ten stage ids is current for at least one sample', () => {
	const seen = new Set();
	for (const sample of SAMPLES) {
		const stage = finestStage(TEN_EVENT_AT, sample.now);
		if (stage !== null) seen.add(stage);
	}
	for (const event of ELECTION_EVENT_ORDER) {
		assert.ok(seen.has(event), `expected ${event} to be current for at least one of the 41 samples`);
	}
});

test('group C negative control: statusOf disagrees with finestStage on at least one boundary-adjacent sample and at least one midpoint sample', () => {
	const boundaryDisagreements = SAMPLES.filter(
		(s) => s.kind === 'boundary' && s.offset !== 0 && statusOfWalk(s.now) !== finestStage(TEN_EVENT_AT, s.now),
	);
	const midpointDisagreements = SAMPLES.filter((s) => s.kind === 'midpoint' && statusOfWalk(s.now) !== finestStage(TEN_EVENT_AT, s.now));
	assert.ok(
		boundaryDisagreements.length > 0,
		'expected statusOf to disagree with finestStage on at least one boundary-adjacent sample -- if this control ever goes silent, the two walks have converged and the assertion above has stopped proving anything',
	);
	assert.ok(
		midpointDisagreements.length > 0,
		'expected statusOf to disagree with finestStage on at least one midpoint sample -- if this control ever goes silent, the two walks have converged and the assertion above has stopped proving anything',
	);
});

// --- pre-D-08 seven-key regression -------------------------------------------

const { accruingVotes: _av, hashingVotes: _hv, releasingKeys: _rk, ...SEVEN_KEY_AT } = TEN_EVENT_AT;

test('pre-D-08 regression: a seven-key timeline (the three new events absent) parses to exactly three named MISSING_EVENT conflicts, never a guessed stage', () => {
	const { at, conflicts } = parseTimeline(SEVEN_KEY_AT);
	assert.equal(at.accruingVotes, null);
	assert.equal(at.hashingVotes, null);
	assert.equal(at.releasingKeys, null);

	const missing = conflicts.filter((c) => c.code === CONFLICT.MISSING_EVENT);
	assert.deepEqual(
		missing.map((c) => c.event).sort(),
		['accruingVotes', 'hashingVotes', 'releasingKeys'].sort(),
	);
	assert.equal(conflicts.length, missing.length, `expected only the three MISSING_EVENT conflicts, got ${JSON.stringify(conflicts)}`);
});

test('pre-D-08 regression: finestStage over the seven-key timeline still derives the correct stage at every sample outside the deleted window', () => {
	const { at: sevenAt } = parseTimeline(SEVEN_KEY_AT);
	const deletedStages = new Set(['accruingVotes', 'hashingVotes', 'releasingKeys']);
	let checkedAtLeastOne = false;
	for (const sample of SAMPLES) {
		const tenStage = finestStage(TEN_EVENT_AT, sample.now);
		if (tenStage !== null && deletedStages.has(tenStage)) continue; // inside the deleted window -- expected to differ
		checkedAtLeastOne = true;
		const sevenStage = finestStage(sevenAt, sample.now);
		assert.equal(sevenStage, tenStage, `at now=${sample.now}, a seven-key timeline must still derive ${tenStage} (outside the deleted window)`);
	}
	assert.ok(checkedAtLeastOne, 'expected at least one sample outside the deleted window to actually be checked');
});
