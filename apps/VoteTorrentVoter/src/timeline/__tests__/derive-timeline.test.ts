/**
 * derive-timeline.test.ts -- Phase 59 plan 59-06, Task 3.
 *
 * The plan's own gate: 41-point coverage, current-not-next (D-18), the 7-of-10 regression
 * (D-03/D-18), shape equivalence across the three live `Timeline` column shapes, the
 * indeterminate matrix (D-03), and the no-ambient-clock source scan. No hand-picked instant
 * appears anywhere below -- every `now` is either a fixture boundary (`CANONICAL_TIMELINE.<id>`,
 * optionally +/-1ms in the same style the sample generator itself uses) or a generated sample
 * point from `generateSamplePoints`.
 */
import * as fs from 'fs';
import * as path from 'path';

import {deriveTimeline} from '../derive-timeline';
import {TIMELINE_KEYS, TIMELINE_STAGE_IDS} from '../stages';
import type {TimelineStageId} from '../stages';
import {EXPECTED_SAMPLE_POINT_COUNT, generateSamplePoints} from '../__fixtures__/sample-points';
import {
	ABSENT_TIMELINE,
	CANONICAL_STRING_TIMELINE,
	CANONICAL_TIMELINE,
	CONFLICTING_ELECTION,
	JSON_BLOB_TIMELINE,
	NON_MONOTONIC_TIMELINE,
	SEVEN_KEY_TIMELINE,
	UNPARSEABLE_TIMELINE,
} from '../__fixtures__/timeline-fixtures';
import type {TimelineViewModelConfident} from '../types';

const SAMPLES = generateSamplePoints(CANONICAL_TIMELINE, TIMELINE_STAGE_IDS);

function asConfident(result: ReturnType<typeof deriveTimeline>): TimelineViewModelConfident {
	if (result.indeterminate) {
		throw new Error(`Expected a confident view-model, got indeterminate: ${result.reason}`);
	}
	return result;
}

describe('sample-point generator', () => {
	test('emits exactly 41 points, with no de-duplication applied', () => {
		expect(SAMPLES.length).toBe(EXPECTED_SAMPLE_POINT_COUNT);
		expect(SAMPLES.length).toBe(41);
	});
});

describe('41-point coverage: every stage id is current at least once', () => {
	test('the set of currentStageId values across all 41 points is a superset of the ten ids', () => {
		const seen = new Set<TimelineStageId | null>();
		for (const point of SAMPLES) {
			const result = asConfident(deriveTimeline({timeline: CANONICAL_TIMELINE, now: point, timeZone: 'America/Denver'}));
			seen.add(result.currentStageId);
		}
		const missing = TIMELINE_STAGE_IDS.filter(id => !seen.has(id));
		if (missing.length > 0) {
			throw new Error(`stage ids never reached 'current' across the 41-point sweep: ${missing.join(', ')}`);
		}
		expect(missing).toEqual([]);
	});
});

describe('current, not next (D-18): at e_i + 1, the current stage is stage i, never i + 1', () => {
	for (const stageId of TIMELINE_STAGE_IDS) {
		test(`stageId=${stageId}`, () => {
			const now = CANONICAL_TIMELINE[stageId] + 1;
			const result = asConfident(deriveTimeline({timeline: CANONICAL_TIMELINE, now, timeZone: 'America/Denver'}));
			expect(result.currentStageId).toBe(stageId);
		});
	}
});

describe('nothing open yet: at the all-future sample point, currentStageId is null and every row is future', () => {
	test('is confident, not indeterminate', () => {
		const allFuturePoint = SAMPLES[SAMPLES.length - 2]; // e1 - 86_400_000, per generateSamplePoints
		const result = asConfident(deriveTimeline({timeline: CANONICAL_TIMELINE, now: allFuturePoint, timeZone: 'America/Denver'}));
		expect(result.currentStageId).toBeNull();
		expect(result.rows.every(r => r.status === 'future')).toBe(true);
		expect(result.rows.length).toBe(10);
	});
});

describe('all past: at the all-past sample point, closed is current and the other nine are past', () => {
	test('closed is current, everything else is past', () => {
		const allPastPoint = SAMPLES[SAMPLES.length - 1]; // e10 + 86_400_000, per generateSamplePoints
		const result = asConfident(deriveTimeline({timeline: CANONICAL_TIMELINE, now: allPastPoint, timeZone: 'America/Denver'}));
		expect(result.currentStageId).toBe('closed');
		const closedRow = result.rows.find(r => r.stageId === 'closed');
		expect(closedRow?.status).toBe('current');
		const others = result.rows.filter(r => r.stageId !== 'closed');
		expect(others.every(r => r.status === 'past')).toBe(true);
	});
});

describe('7-of-10 regression: SEVEN_KEY_TIMELINE degrades individually, never collapses the rail', () => {
	test('now after closed: confident, closed is current, the three absent stages resolve past', () => {
		const now = CANONICAL_TIMELINE.closed + 1;
		const result = asConfident(deriveTimeline({timeline: SEVEN_KEY_TIMELINE, now, timeZone: 'America/Denver'}));
		expect(result.currentStageId).toBe('closed');
		for (const id of ['accruingVotes', 'hashingVotes', 'releasingKeys'] as const) {
			const row = result.rows.find(r => r.stageId === id);
			if (row?.status !== 'past') {
				throw new Error(`${id} should resolve 'past' (a causally later crossed event settles it), got '${row?.status}'`);
			}
			expect(row.status).toBe('past');
			expect(row.instantMs).toBeNull();
		}
	});

	test('now inside the voting interval: votingStarts is confidently current, the three absent stages are unknown', () => {
		const now = CANONICAL_TIMELINE.votingStarts + 1;
		const result = asConfident(deriveTimeline({timeline: SEVEN_KEY_TIMELINE, now, timeZone: 'America/Denver'}));
		expect(result.currentStageId).toBe('votingStarts');
		for (const id of ['accruingVotes', 'hashingVotes', 'releasingKeys'] as const) {
			const row = result.rows.find(r => r.stageId === id);
			expect(row?.status).toBe('unknown');
			expect(row?.instantMs).toBeNull();
			expect(row?.railLabel).toEqual({kind: 'unknown'});
			expect(row?.subtitle).toBeNull();
		}
	});
});

describe('shape equivalence: epoch-ms, canonical-string, and JSON-blob timelines produce deep-equal view-models', () => {
	test('at the same instant', () => {
		const now = SAMPLES[0]; // registrationEnds - 1, a fixture-boundary sample point
		const fromNumbers = deriveTimeline({timeline: CANONICAL_TIMELINE, now, timeZone: 'America/Denver', language: 'en'});
		const fromStrings = deriveTimeline({timeline: CANONICAL_STRING_TIMELINE, now, timeZone: 'America/Denver', language: 'en'});
		const fromJsonBlob = deriveTimeline({timeline: JSON_BLOB_TIMELINE, now, timeZone: 'America/Denver', language: 'en'});

		expect(fromStrings).toEqual(fromNumbers);
		expect(fromJsonBlob).toEqual(fromNumbers);
	});
});

describe('indeterminate matrix (D-03): each trigger yields a zero-row, non-empty-reason indeterminate model', () => {
	test('UNPARSEABLE', () => {
		const result = deriveTimeline({timeline: UNPARSEABLE_TIMELINE, now: CANONICAL_TIMELINE.registrationEnds, timeZone: 'America/Denver'});
		expect(result.indeterminate).toBe(true);
		expect('rows' in result).toBe(false);
		if (result.indeterminate) {
			expect(result.reason.length).toBeGreaterThan(0);
		}
	});

	test('OUT_OF_ORDER (non-monotonic)', () => {
		const now = CANONICAL_TIMELINE.closed + 1;
		const result = deriveTimeline({timeline: NON_MONOTONIC_TIMELINE, now, timeZone: 'America/Denver'});
		expect(result.indeterminate).toBe(true);
		expect('rows' in result).toBe(false);
		if (result.indeterminate) {
			expect(result.reason.length).toBeGreaterThan(0);
		}
	});

	for (const {label, value} of ABSENT_TIMELINE) {
		test(`absent timeline (${label})`, () => {
			const result = deriveTimeline({timeline: value, now: CANONICAL_TIMELINE.registrationEnds, timeZone: 'America/Denver'});
			expect(result.indeterminate).toBe(true);
			expect('rows' in result).toBe(false);
			if (result.indeterminate) {
				expect(result.reason.length).toBeGreaterThan(0);
			}
		});
	}

	test('a non-finite `now`', () => {
		const result = deriveTimeline({timeline: CANONICAL_TIMELINE, now: Number.NaN, timeZone: 'America/Denver'});
		expect(result.indeterminate).toBe(true);
		expect('rows' in result).toBe(false);
		if (result.indeterminate) {
			expect(result.reason.length).toBeGreaterThan(0);
		}
	});

	test('an unparseable `now` string', () => {
		const result = deriveTimeline({timeline: CANONICAL_TIMELINE, now: 'not-a-date', timeZone: 'America/Denver'});
		expect(result.indeterminate).toBe(true);
		expect('rows' in result).toBe(false);
	});

	test('a cross-check-conflicting election (EVENT_AFTER_ELECTION_DATE)', () => {
		const now = CANONICAL_TIMELINE.registrationEnds;
		const result = deriveTimeline({timeline: CANONICAL_TIMELINE, now, election: CONFLICTING_ELECTION, timeZone: 'America/Denver'});
		expect(result.indeterminate).toBe(true);
		expect('rows' in result).toBe(false);
		if (result.indeterminate) {
			expect(result.reason).toMatch(/EVENT_AFTER_ELECTION_DATE/);
		}
	});

	test('MISSING_EVENT alone does NOT make the model indeterminate (the 7-of-10 case)', () => {
		const now = CANONICAL_TIMELINE.closed + 1;
		const result = deriveTimeline({timeline: SEVEN_KEY_TIMELINE, now, timeZone: 'America/Denver'});
		expect(result.indeterminate).toBe(false);
		if (!result.indeterminate) {
			expect(result.rows.length).toBe(10);
			expect(result.conflicts.some(c => c.code === 'MISSING_EVENT')).toBe(true);
		}
	});
});

describe('closed-key-set assertion: every titleKey and subtitle.key emitted across all 41 points is a TIMELINE_KEYS member', () => {
	test('across the full sample sweep', () => {
		for (const point of SAMPLES) {
			const result = asConfident(deriveTimeline({timeline: CANONICAL_TIMELINE, now: point, timeZone: 'America/Denver'}));
			for (const row of result.rows) {
				expect(TIMELINE_KEYS).toContain(row.titleKey);
				if (row.subtitle !== null) {
					expect(TIMELINE_KEYS).toContain(row.subtitle.key);
				}
			}
		}
	});
});

describe('no ambient clock: no source file under src/timeline/ reads the process clock', () => {
	function stripComments(source: string): string {
		return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	}

	function walk(dir: string): string[] {
		return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === '__tests__' || entry.name === '__fixtures__') return [];
				return walk(full);
			}
			return /\.ts$/.test(entry.name) ? [full] : [];
		});
	}

	test('no zero-argument Date construction or a live-clock read anywhere under src/timeline/ (excluding __tests__/__fixtures__)', () => {
		const timelineDir = path.resolve(__dirname, '..');
		const sourceFiles = walk(timelineDir);
		expect(sourceFiles.length).toBeGreaterThan(0); // non-vacuity: the walk itself must find files

		// Built from parts so this file's own source text never contains the literal patterns it
		// scans for -- a checker whose own text matches its own pattern is permanently green
		// regardless of the code under test (a recurring trap on this project).
		const clockReadPattern = new RegExp(['Date', '\\s*\\.\\s*now', '\\s*\\('].join(''));
		const zeroArgDatePattern = new RegExp(['new', '\\s+Date', '\\s*\\(', '\\s*\\)'].join(''));

		const offenders: string[] = [];
		for (const file of sourceFiles) {
			const stripped = stripComments(fs.readFileSync(file, 'utf8'));
			if (clockReadPattern.test(stripped) || zeroArgDatePattern.test(stripped)) {
				offenders.push(path.relative(timelineDir, file));
			}
		}
		expect(offenders).toEqual([]);
	});
});
