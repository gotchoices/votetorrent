/**
 * timeline-core-resolution.test.ts -- Phase 59 plan 59-02, Task 3.
 *
 * This is BOTH the Wave-0 item 59-VALIDATION.md names ("Jest moduleNameMapper
 * resolves the extracted module from the RN app") AND the D-21
 * TypeScript-consumability proof, in one file:
 *
 *   - Importing real VALUES (never types alone) from
 *     `@votetorrent/ui-web/lifecycle-core` and exercising them proves Jest
 *     genuinely resolves and executes the subpath -- a type-only import would
 *     resolve at typecheck time and prove nothing about Jest.
 *   - `STAGE_INDEX: Record<TimelineStageId, number>` is the D-21 drift pin:
 *     a missing or extra key in the ten-id union is a TypeScript error, and
 *     asserting `ELECTION_EVENT_ORDER` equals `Object.keys(STAGE_INDEX)`
 *     pins the RUNTIME array to the same ten ids in the same order -- so the
 *     typedef and the frozen array cannot drift apart.
 *
 * `@votetorrent/ui-web/lifecycle`, `/components` and `/facts` are never
 * imported anywhere in this file, or anywhere else in the voter app: the
 * voter must reach ONLY the zero-import `./lifecycle-core` half (D-19).
 */
import {
	ELECTION_EVENT_ORDER,
	finestStage,
	parseTimeline,
	normalizeInstant,
} from '@votetorrent/ui-web/lifecycle-core';
import type {TimelineStageId} from '@votetorrent/ui-web/lifecycle-core';

import {LIFECYCLE_ORDER} from '../src/providers/types';

// The D-21 drift pin: a `Record<TimelineStageId, number>` literal with all
// ten ids as keys. A missing key or an extra key is a TypeScript error at
// compile time; `Object.keys(STAGE_INDEX)` pins the RUNTIME array to the
// same ten ids in the same order below.
const STAGE_INDEX: Record<TimelineStageId, number> = {
	registrationEnds: 0,
	ballotsFinal: 1,
	votingStarts: 2,
	accruingVotes: 3,
	hashingVotes: 4,
	releasingKeys: 5,
	tallyingStarts: 6,
	validation: 7,
	certificationStarts: 8,
	closed: 9,
};

describe('@votetorrent/ui-web/lifecycle-core resolves from the voter app under Jest (D-19/D-21)', () => {
	test('ELECTION_EVENT_ORDER deep-equals Object.keys(STAGE_INDEX) -- the typedef and the frozen array cannot drift apart', () => {
		expect([...ELECTION_EVENT_ORDER]).toEqual(Object.keys(STAGE_INDEX));
		expect(ELECTION_EVENT_ORDER.length).toBe(10);
	});

	test('finestStage and parseTimeline are real, executable functions resolved through the subpath -- fails if it resolved to something inert', () => {
		const timeline: Record<string, number> = {
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
		};

		const {at, conflicts} = parseTimeline(timeline);
		expect(conflicts).toEqual([]);

		const nowMs = Date.UTC(2026, 10, 3, 11, 0, 0); // between accruingVotes and hashingVotes
		expect(finestStage(at, nowMs)).toBe('accruingVotes');
	});

	test('normalizeInstant handles both a canonical 19-character datetime and an epoch-ms number', () => {
		expect(normalizeInstant('2026-11-03T08:00:00')).toBe(Date.UTC(2026, 10, 3, 8, 0, 0));
		expect(normalizeInstant(1_700_000_000_000)).toBe(1_700_000_000_000);
	});
});

describe('LifecycleState is untouched by this plan (D-21)', () => {
	test('LIFECYCLE_ORDER still has exactly seven members -- D-21 forbids growing LifecycleState to ten', () => {
		expect(LIFECYCLE_ORDER.length).toBe(7);
	});
});
