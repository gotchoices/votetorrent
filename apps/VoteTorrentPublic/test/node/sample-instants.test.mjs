/**
 * sample-instants.test.mjs — D-25's proof for `deriveSampleInstants`:
 * derived-not-literal, all four phases covered, at least one instant inside
 * an 8-of-1000-step `voting` window, timezone invariance, and the
 * no-circular-oracle scan. Every path is resolved through
 * `scripts/lib/source-paths.mjs` (D-25/53-01).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { publicRoot, moduleUrl } from '../../../../scripts/lib/source-paths.mjs';
import { PHASE_IDS, derivePhase } from '../../../../packages/ui-web/src/lifecycle/election-phase.js';
import { FIXTURE_ELECTION, FIXTURE_ELECTION_TIMELINE_JSON } from '../fixtures/election-fixture.js';
import { deriveSampleInstants, STEP_MS } from '../fixtures/sample-instants.js';

/** @param {string} source @returns {string} */
function stripCommentLines(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}

// ---------------------------------------------------------------------------
// 1. Shape and count.
// ---------------------------------------------------------------------------

test('shape and count: 4 interval midpoints + 3 boundaries * 3 offsets, canonical, strictly increasing, no duplicates, frozen, kind counts 4/3/3/3', () => {
	const entries = deriveSampleInstants(FIXTURE_ELECTION.timeline);

	const PHASE_INTERVAL_COUNT = 4;
	const BOUNDARY_COUNT = 3;
	const OFFSETS_PER_BOUNDARY = 3;
	assert.equal(entries.length, PHASE_INTERVAL_COUNT + BOUNDARY_COUNT * OFFSETS_PER_BOUNDARY, 'expected count derived as an expression, never the literal 13');

	assert.ok(Object.isFrozen(entries), 'the returned array must be frozen');
	for (const entry of entries) {
		assert.ok(Object.isFrozen(entry), `entry ${entry.label} must be frozen`);
		assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, `entry ${entry.label}'s "at" must be canonical`);
	}

	for (let i = 1; i < entries.length; i += 1) {
		assert.ok(entries[i].at > entries[i - 1].at, `entries must be strictly increasing and duplicate-free: ${entries[i - 1].at} (${entries[i - 1].label}) then ${entries[i].at} (${entries[i].label})`);
	}

	/** @type {Record<string, number>} */
	const kindCounts = {};
	for (const entry of entries) kindCounts[entry.kind] = (kindCounts[entry.kind] ?? 0) + 1;
	assert.deepEqual(kindCounts, { midpoint: 4, 'boundary-minus-step': 3, boundary: 3, 'boundary-plus-step': 3 });
});

// ---------------------------------------------------------------------------
// 2. All four phases covered.
// ---------------------------------------------------------------------------

test('all four PHASE_IDS members are covered by at least one derived expectedPhase (D-25\'s totality claim)', () => {
	const entries = deriveSampleInstants(FIXTURE_ELECTION.timeline);
	const covered = new Set(entries.map((e) => e.expectedPhase));
	assert.deepEqual([...covered].sort(), [...PHASE_IDS].sort());
});

// ---------------------------------------------------------------------------
// 3. The 8-of-1000-step proof.
// ---------------------------------------------------------------------------

test('D-25: a voting window occupying roughly 8/1000 of a 70-day span still gets at least one sampled instant (hand-picked instants would silently never sample this window)', () => {
	const DAY_MS = 86_400_000;
	const votingStartsMs = Date.UTC(2027, 0, 1, 0, 0, 0);
	const tallyingStartsMs = votingStartsMs + 13 * 60 * 60 * 1000; // 13 hours
	const closedMs = votingStartsMs + 70 * DAY_MS;

	/** @param {number} ms @returns {string} */
	const toCanonical = (ms) => new Date(ms).toISOString().slice(0, 19);

	const synthetic = {
		votingStarts: toCanonical(votingStartsMs),
		tallyingStarts: toCanonical(tallyingStartsMs),
		closed: toCanonical(closedMs),
	};

	const entries = deriveSampleInstants(synthetic);

	const insideWindow = entries.some((e) => {
		const ms = Date.parse(`${e.at}Z`);
		return ms >= votingStartsMs && ms < tallyingStartsMs;
	});
	assert.ok(insideWindow, 'expected at least one derived instant to fall inside [votingStarts, tallyingStarts)');
	assert.ok(entries.some((e) => e.expectedPhase === 'voting'), 'expected at least one entry to carry expectedPhase === "voting"');
});

// ---------------------------------------------------------------------------
// 4. Agreement with the real derivation, over BOTH live timeline shapes.
// ---------------------------------------------------------------------------

test('every derived entry agrees with the real derivePhase, over both the object and JSON-string timeline shapes', () => {
	const entries = deriveSampleInstants(FIXTURE_ELECTION.timeline);
	/** @type {Array<[string, unknown]>} */
	const shapes = [
		['object', FIXTURE_ELECTION.timeline],
		['json-string', FIXTURE_ELECTION_TIMELINE_JSON],
	];
	for (const [shapeLabel, timeline] of shapes) {
		for (const entry of entries) {
			const result = derivePhase(FIXTURE_ELECTION, timeline, entry.at);
			assert.equal(
				result.phase,
				entry.expectedPhase,
				`[${shapeLabel}] ${entry.label} (${entry.at}): expected "${entry.expectedPhase}", derivePhase returned "${result.phase}"`,
			);
		}
	}
});

// ---------------------------------------------------------------------------
// 5. The throw list.
// ---------------------------------------------------------------------------

test('throws a named error for a JSON-string timeline (the object-only contract, diagnosed rather than silently treated as empty)', () => {
	assert.throws(() => deriveSampleInstants(FIXTURE_ELECTION_TIMELINE_JSON), /must be an already-parsed object, got string/);
});

test('throws a named error for a timeline missing "closed"', () => {
	const { closed, ...rest } = FIXTURE_ELECTION.timeline;
	assert.throws(() => deriveSampleInstants(rest), /"closed"/);
});

test('throws a named error when the three boundaries are not strictly increasing', () => {
	const scrambled = { ...FIXTURE_ELECTION.timeline, votingStarts: FIXTURE_ELECTION.timeline.closed };
	assert.throws(() => deriveSampleInstants(scrambled), /strictly increasing/);
});

test('throws a named error when the voting interval is narrower than 4*STEP_MS', () => {
	// votingStarts is 2026-11-03T08:00:00; 3 seconds later is well under
	// 4 * STEP_MS (4000ms).
	const narrow = { ...FIXTURE_ELECTION.timeline, tallyingStarts: '2026-11-03T08:00:03' };
	assert.throws(() => deriveSampleInstants(narrow), /voting interval/);
});

// ---------------------------------------------------------------------------
// 6. Timezone invariance (D-26).
// ---------------------------------------------------------------------------

test('the derivation is timezone-invariant under TZ=Asia/Kathmandu (+05:45)', () => {
	const inProcess = deriveSampleInstants(FIXTURE_ELECTION.timeline).map((e) => e.at);

	const modulePath = moduleUrl(publicRoot('test', 'fixtures', 'sample-instants.js'));
	const script =
		`import(${JSON.stringify(modulePath)}).then(({ deriveSampleInstants }) => {` +
		`const timeline = ${JSON.stringify(FIXTURE_ELECTION.timeline)};` +
		`process.stdout.write(JSON.stringify(deriveSampleInstants(timeline).map((e) => e.at)));` +
		`});`;

	const out = execFileSync(process.execPath, ['-e', script], {
		env: { ...process.env, TZ: 'Asia/Kathmandu' },
		encoding: 'utf8',
	});
	const child = JSON.parse(out.trim());
	assert.deepEqual(child, inProcess, 'the derived "at" values must be byte-identical under a +05:45 zone');
});

// ---------------------------------------------------------------------------
// 7. No circular oracle.
// ---------------------------------------------------------------------------

const CIRCULAR_ORACLE_RE = /derivePhase|computeElectionPhase|election-phase/;

test('positive control: the circular-oracle matcher fires on a planted derivePhase reference', () => {
	assert.match("import { derivePhase } from './election-phase.js';", CIRCULAR_ORACLE_RE);
});

test('sample-instants.js contains no import statement and no reference to derivePhase/computeElectionPhase/election-phase (the expected-phase oracle is independent of the code it tests)', () => {
	const source = readFileSync(publicRoot('test', 'fixtures', 'sample-instants.js'), 'utf8');
	const stripped = stripCommentLines(source);
	assert.doesNotMatch(stripped, /^import\b/m, 'expected zero import statements in sample-instants.js');
	assert.doesNotMatch(stripped, CIRCULAR_ORACLE_RE, 'expected zero references to derivePhase/computeElectionPhase/election-phase in sample-instants.js');
});
