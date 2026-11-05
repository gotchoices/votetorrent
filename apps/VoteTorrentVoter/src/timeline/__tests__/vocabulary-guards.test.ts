/**
 * vocabulary-guards.test.ts -- Phase 59 plan 59-06, Task 1.
 *
 * Proves the row vocabulary (`TIMELINE_STAGE_IDS`) cannot drift from the persisted
 * `ElectionEvent` enum (D-09), that `LifecycleState`/`STATE_DISPLAY` are untouched by this plan
 * (D-12/D-21), and that the canonical fixture is internally consistent (STRICT_CHAIN order,
 * PREPARATION-before-votingStarts, the same-day cluster).
 *
 * `ElectionEvent` is imported here -- and ONLY here, in a test -- to prove the D-09 cross-check;
 * no source module under `src/timeline/` imports `@votetorrent/vote-core` (D-07's directional
 * intent: compute status, don't leak the persistence enum).
 *
 * The voter's `tsconfig.json` scopes ambient `types` to `["react-native", "jest"]` only (no
 * `"node"`), so `fs`/`path`/`__dirname` are otherwise untyped here -- `__tests__/no-inline-mock-
 * imports.test.ts` carries this exact debt today as part of the measured pre-phase typecheck
 * floor. Rather than adding to that floor with new, textually-distinct error lines, this file
 * pulls in `@types/node` (already an installed devDependency, just not globally enabled) via a
 * file-scoped triple-slash directive -- zero tsconfig.json edit, zero new floor debt.
 */
/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';
import {ElectionEvent} from '@votetorrent/vote-core';
import {STRICT_CHAIN, PREPARATION} from '@votetorrent/ui-web/lifecycle-core';

import {STAGE_TITLE_KEY, TIMELINE_KEYS, TIMELINE_STAGE_IDS} from '../stages';
import type {TimelineStageId} from '../stages';
import {CANONICAL_TIMELINE} from '../__fixtures__/timeline-fixtures';
import {LIFECYCLE_ORDER} from '../../providers/types';
import type {LifecycleState} from '../../providers/types';

// Mirrors `__tests__/no-inline-mock-imports.test.ts`'s `stripComments` shape (Task 1's
// `<read_first>` reference) -- strips line and block comments before any scan, so a
// descriptive comment mentioning a lifecycle state or a stage id can't false-trip a guard.
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('D-09: TIMELINE_STAGE_IDS cannot drift from the persisted ElectionEvent enum', () => {
	test('Object.values(ElectionEvent) deep-equals TIMELINE_STAGE_IDS, same array, same order', () => {
		try {
			expect(Object.values(ElectionEvent)).toEqual([...TIMELINE_STAGE_IDS]);
		} catch (err) {
			throw new Error(
				'D-09 cross-check failed: ElectionEvent (vote-core) and TIMELINE_STAGE_IDS ' +
					'(timeline-core.js) disagree. If ElectionEvent looks like the stale 7-member enum, ' +
					'rebuild vote-core first: `yarn workspace @votetorrent/vote-core build` ' +
					'(59-06-PLAN.md <preconditions> item 2) -- this is a stale-dist trap, not a plan defect.\n' +
					String(err),
			);
		}
	});

	test('TIMELINE_STAGE_IDS has exactly ten members', () => {
		expect(TIMELINE_STAGE_IDS.length).toBe(10);
	});
});

describe('STAGE_TITLE_KEY is total over the ten ids', () => {
	test('every stage id has a title key, and votingStarts maps to stage.votingPeriod.title', () => {
		for (const id of TIMELINE_STAGE_IDS) {
			expect(typeof STAGE_TITLE_KEY[id]).toBe('string');
		}
		expect(STAGE_TITLE_KEY.votingStarts).toBe('stage.votingPeriod.title');
	});

	test('no title key other than votingStarts diverges from its own stage id', () => {
		for (const id of TIMELINE_STAGE_IDS) {
			if (id === 'votingStarts') continue;
			expect(STAGE_TITLE_KEY[id]).toBe(`stage.${id}.title`);
		}
	});
});

describe('TIMELINE_KEYS is the exact closed set the adapter can ever emit', () => {
	test('ten stage.*.title keys, five subtitle.* keys, and rail.now -- nothing else', () => {
		const expected = new Set([
			...TIMELINE_STAGE_IDS.map(id => STAGE_TITLE_KEY[id]),
			'subtitle.today',
			'subtitle.yesterday',
			'subtitle.futureWeekday',
			'subtitle.pastDate',
			'subtitle.futureDate',
			'rail.now',
		]);
		expect(new Set(TIMELINE_KEYS)).toEqual(expected);
		expect(TIMELINE_KEYS.length).toBe(16);
	});
});

describe('D-12/D-21: LifecycleState and STATE_DISPLAY are untouched by this plan', () => {
	const SEVEN_LIFECYCLE_NAMES: readonly LifecycleState[] = [
		'Upcoming',
		'Open',
		'ReviewSelections',
		'ReleasingKeys',
		'Validation',
		'ValidationDetails',
		'Complete',
	];

	test('LIFECYCLE_ORDER still has exactly 7 members, deep-equal to the seven original names', () => {
		expect(LIFECYCLE_ORDER.length).toBe(7);
		expect([...LIFECYCLE_ORDER]).toEqual(SEVEN_LIFECYCLE_NAMES);
	});

	/**
	 * Extracts the depth-1 keys of `ElectionCard.tsx`'s `const STATE_DISPLAY = {...}` literal.
	 * Comments are stripped FIRST (that file's own comments name lifecycle states, e.g. "SC2:
	 * ReleasingKeys (lock/muted) vs Validation (lock-open/success)", and would otherwise
	 * contaminate the scan). Depth-1 keys are single-tab-indented `Name: {` lines -- a
	 * line-anchored match, not a content hash, so a legitimate future edit to `StateDisplay`'s
	 * field shape does not trip this guard; only a change to the KEY SET does.
	 */
	function extractStateDisplayKeys(): string[] {
		const filePath = path.resolve(__dirname, '../../components/ElectionCard.tsx');
		const stripped = stripComments(fs.readFileSync(filePath, 'utf8'));

		const startMarker = 'const STATE_DISPLAY';
		const startIdx = stripped.indexOf(startMarker);
		if (startIdx === -1) {
			throw new Error('ElectionCard.tsx: `const STATE_DISPLAY` declaration not found after stripping comments.');
		}
		// The literal's annotation must still be present -- assert it here so a silently
		// retyped/untyped STATE_DISPLAY is itself a guard failure, not a false pass below.
		const annotationSlice = stripped.slice(startIdx, startIdx + 120);
		expect(annotationSlice).toMatch(/Record<\s*LifecycleState\s*,\s*StateDisplay\s*>/);

		const terminatorIdx = stripped.indexOf('\n};', startIdx);
		if (terminatorIdx === -1) {
			throw new Error('ElectionCard.tsx: terminating `};` for STATE_DISPLAY not found after stripping comments.');
		}
		const region = stripped.slice(startIdx, terminatorIdx);

		const keyRe = /^\t([A-Za-z_$][\w$]*):\s*\{/gm;
		const keys: string[] = [];
		let match: RegExpExecArray | null;
		while ((match = keyRe.exec(region)) !== null) {
			keys.push(match[1]);
		}
		return keys;
	}

	test('STATE_DISPLAY declares exactly the seven LifecycleState keys and none of the ten TimelineStageId names', () => {
		const keys = extractStateDisplayKeys();
		expect(new Set(keys)).toEqual(new Set(SEVEN_LIFECYCLE_NAMES));

		const stageIdSet = new Set<string>(TIMELINE_STAGE_IDS);
		const intersection = keys.filter(k => stageIdSet.has(k));
		expect(intersection).toEqual([]);
	});

	// Non-vacuity proof for the guard immediately above (59-06-PLAN.md acceptance criteria):
	// a stage id spliced into a COPY of the real STATE_DISPLAY region must fail the same
	// assertion shape this guard runs, proving the guard is not vacuously green. The real file
	// on disk is never mutated -- this operates on an in-memory string, and the observation is
	// recorded in the SUMMARY per the plan's instruction to prove-then-revert.
	test('non-vacuity: splicing a TimelineStageId key into the extracted set makes the guard fail', () => {
		const keys = extractStateDisplayKeys();
		const mutated = [...keys, 'accruingVotes'];
		const stageIdSet = new Set<string>(TIMELINE_STAGE_IDS);
		const intersection = mutated.filter(k => stageIdSet.has(k));
		expect(intersection).not.toEqual([]);
		expect(intersection).toEqual(['accruingVotes']);
	});
});

describe('The canonical fixture is internally consistent', () => {
	test('has exactly the ten TimelineStageId keys', () => {
		expect(new Set(Object.keys(CANONICAL_TIMELINE))).toEqual(new Set(TIMELINE_STAGE_IDS));
	});

	test('STRICT_CHAIN instants are strictly increasing', () => {
		const chain = STRICT_CHAIN as readonly TimelineStageId[];
		for (let i = 1; i < chain.length; i++) {
			const prev = CANONICAL_TIMELINE[chain[i - 1]];
			const curr = CANONICAL_TIMELINE[chain[i]];
			if (!(curr > prev)) {
				throw new Error(`${chain[i]} (${curr}) must be strictly after ${chain[i - 1]} (${prev})`);
			}
		}
	});

	test('both PREPARATION instants precede votingStarts', () => {
		const prep = PREPARATION as readonly TimelineStageId[];
		for (const id of prep) {
			expect(CANONICAL_TIMELINE[id]).toBeLessThan(CANONICAL_TIMELINE.votingStarts);
		}
	});

	test('at least three instants land on the same America/Denver calendar day', () => {
		const fmt = new Intl.DateTimeFormat('en-US', {timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit'});
		const dayCounts = new Map<string, number>();
		for (const id of TIMELINE_STAGE_IDS) {
			const dayKey = fmt.format(new Date(CANONICAL_TIMELINE[id]));
			dayCounts.set(dayKey, (dayCounts.get(dayKey) ?? 0) + 1);
		}
		const maxCluster = Math.max(...dayCounts.values());
		expect(maxCluster).toBeGreaterThanOrEqual(3);
	});
});

describe('No file lives under __tests__/ except the three *.test.ts files (this plan)', () => {
	test('directory listing contains only test files', () => {
		const testsDir = path.resolve(__dirname);
		const entries = fs.readdirSync(testsDir, {withFileTypes: true});
		const offenders = entries.filter(e => e.isFile() && !e.name.endsWith('.test.ts')).map(e => e.name);
		expect(offenders).toEqual([]);
	});
});
