/**
 * timeline-fixtures.ts -- Phase 59 plan 59-06, Task 1.
 *
 * The canonical production-length, mockup-faithful fixture (`59-06-PLAN.md`'s `<contracts>`
 * table) plus the broken-data variants Task 3's indeterminate-matrix gate exercises. Deliberately
 * NOT under `__tests__/` -- jest's default `testMatch` treats every file under a `__tests__`
 * directory as a suite, and a fixture module there fails with "must contain at least one test".
 *
 * All ten instants are `Date.UTC(...)` calls, never hand-computed epoch literals, so the table
 * below is legible against the plan's own UTC column.
 */
import type {TimelineStageId} from '../stages';

/** The ten canonical instants (epoch-ms), matching `59-06-PLAN.md`'s fixture table exactly. */
export const CANONICAL_TIMELINE: Record<TimelineStageId, number> = {
	registrationEnds: Date.UTC(2026, 2, 20, 23, 0, 0), // 2026-03-20 23:00 UTC
	ballotsFinal: Date.UTC(2026, 2, 21, 18, 0, 0), // 2026-03-21 18:00 UTC
	votingStarts: Date.UTC(2026, 2, 22, 14, 0, 0), // 2026-03-22 14:00 UTC
	accruingVotes: Date.UTC(2026, 2, 23, 15, 0, 0), // 2026-03-23 15:00 UTC
	hashingVotes: Date.UTC(2026, 2, 23, 17, 0, 0), // 2026-03-23 17:00 UTC
	releasingKeys: Date.UTC(2026, 2, 23, 19, 0, 0), // 2026-03-23 19:00 UTC
	tallyingStarts: Date.UTC(2026, 2, 23, 21, 0, 0), // 2026-03-23 21:00 UTC
	validation: Date.UTC(2026, 2, 24, 16, 0, 0), // 2026-03-24 16:00 UTC
	certificationStarts: Date.UTC(2026, 2, 25, 16, 0, 0), // 2026-03-25 16:00 UTC
	closed: Date.UTC(2026, 2, 26, 0, 0, 0), // 2026-03-26 00:00 UTC
};

/** Production-length election title fixture (53 chars) -- proves the header wraps rather than clipping. */
export const CANONICAL_ELECTION_TITLE = 'Salt Lake County School Board Special Election 2025';

/** Production-length network name fixture (49 chars) -- proves the registration panel wraps rather than clipping. */
export const CANONICAL_NETWORK_NAME = 'Salt Lake County Unified School District Network';

/**
 * The pre-D-08 seven-key signed-row shape: the canonical fixture minus the three new events
 * (`accruingVotes`/`hashingVotes`/`releasingKeys`). Exercises Task 3's "7-of-10 regression" case
 * (D-03/D-18): the three absent stages must degrade individually, never collapse the rail.
 */
export const SEVEN_KEY_TIMELINE: Partial<Record<TimelineStageId, number>> = (() => {
	const {accruingVotes: _accruingVotes, hashingVotes: _hashingVotes, releasingKeys: _releasingKeys, ...rest} =
		CANONICAL_TIMELINE;
	return rest;
})();

/** The same ten instants, expressed as 19-character canonical VT datetime strings (no trailing `Z`). */
export const CANONICAL_STRING_TIMELINE: Record<TimelineStageId, string> = Object.fromEntries(
	(Object.entries(CANONICAL_TIMELINE) as Array<[TimelineStageId, number]>).map(([event, ms]) => [
		event,
		new Date(ms).toISOString().slice(0, 19),
	]),
) as Record<TimelineStageId, string>;

/** The whole canonical timeline object, `JSON.stringify`-ed -- the third live `Timeline` column shape. */
export const JSON_BLOB_TIMELINE: string = JSON.stringify(CANONICAL_TIMELINE);

/** A value present for every event but not a usable instant -- trips `UNPARSEABLE` for every event. */
export const UNPARSEABLE_TIMELINE: Record<TimelineStageId, string> = Object.fromEntries(
	(Object.keys(CANONICAL_TIMELINE) as TimelineStageId[]).map(event => [event, 'not-a-date']),
) as Record<TimelineStageId, string>;

/** The canonical fixture with `validation` and `tallyingStarts` swapped -- trips `OUT_OF_ORDER` on the `STRICT_CHAIN`. */
export const NON_MONOTONIC_TIMELINE: Record<TimelineStageId, number> = {
	...CANONICAL_TIMELINE,
	tallyingStarts: CANONICAL_TIMELINE.validation,
	validation: CANONICAL_TIMELINE.tallyingStarts,
};

/**
 * The three absent-timeline shapes named by `59-06-PLAN.md` ("null/undefined and `{}`") -- all
 * ten events resolve `MISSING_EVENT`, every instant `null`, for every variant. Bundled as one
 * labeled array so the indeterminate-matrix test can iterate all three from one import.
 */
export const ABSENT_TIMELINE: ReadonlyArray<{label: string; value: null | undefined | Record<string, never>}> = [
	{label: 'null', value: null},
	{label: 'undefined', value: undefined},
	{label: 'empty-object', value: {}},
];

/**
 * Cross-check fields that trip exactly one schema conflict (`EVENT_AFTER_ELECTION_DATE`):
 * `votingStarts` (2026-03-22 14:00 UTC) falls after the end of this `date`'s UTC day
 * (2026-03-21, day-end 2026-03-22 00:00 UTC).
 */
export const CONFLICTING_ELECTION: {date: string} = {
	date: new Date(Date.UTC(2026, 2, 21, 0, 0, 0)).toISOString().slice(0, 19),
};
