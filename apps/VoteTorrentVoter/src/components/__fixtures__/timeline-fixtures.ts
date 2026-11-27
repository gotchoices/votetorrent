/**
 * timeline-fixtures.ts -- Phase 59 plan 59-07, Task 1.
 *
 * Production-length strings + the ten-row view-model builder shared by `TimelineRow.test.tsx`
 * and `TimelineRail.test.tsx`. Deliberately under `__fixtures__/`, NOT `__tests__/` -- jest's
 * default `testMatch` treats every file under a `__tests__` directory as a suite, and a helper
 * module there fails with "must contain at least one test".
 *
 * `buildTenRowFixture` calls the REAL `deriveTimeline` adapter (59-06) rather than hand-rolling a
 * join -- this plan consumes 59-06's derivation, it never reimplements it. `buildRowFixture` is a
 * lighter single-row builder for `TimelineRow.test.tsx`'s per-stage/per-status behavior
 * assertions, which do not need a full, mutually-consistent ten-row rail.
 *
 * Trap (D-23(f)): this file is a plain `.ts` under `src/`, so
 * `src/__tests__/no-vrg-ceremony.gate.test.ts`'s source walk scans it -- it must never contain a
 * real `register(`, `associate(`, `seedSignedMutation` or `issueAttestationChallenge` call. It
 * does not.
 */
import {deriveTimeline, STAGE_TITLE_KEY} from '../../timeline';
import type {TimelineRow, TimelineRowStatus, TimelineStageId} from '../../timeline';

/** Production-length election title fixture (53 chars) -- the phase's DEFAULT header fixture, not
 * an edge-case addenda. Proves the `h2` title wraps rather than clipping. */
export const PRODUCTION_ELECTION_TITLE = 'Salt Lake County School Board Special Election 2025';

/** Production-length network name fixture (49 chars) -- the phase's DEFAULT registration-panel
 * fixture. Proves the panel wraps its bold run without clipping. */
export const PRODUCTION_NETWORK_NAME = 'Salt Lake County Unified School District Network';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A fixed anchor instant so the same-day cluster and MM/DD labels are deterministic across test
 * runs and CI hosts (no `Date.now()` dependency anywhere in this module). */
export const FIXTURE_NOW_MS = Date.UTC(2026, 2, 23, 12, 0, 0);

/**
 * Builds a full ten-instant Timeline object anchored to `nowMs`: `registrationEnds`/
 * `ballotsFinal` sit in the past, `votingStarts` has JUST been crossed (making it the `current`
 * row), and `accruingVotes`/`hashingVotes`/`releasingKeys`/`tallyingStarts`/`validation`/
 * `certificationStarts`/`closed` sit in the future -- with `accruingVotes`/`hashingVotes`/
 * `releasingKeys` landing on the SAME calendar day, exercising the mockup's same-day cluster
 * (D-09).
 */
function buildAnchoredTimeline(nowMs: number): Record<TimelineStageId, number> {
	return {
		registrationEnds: nowMs - 3 * DAY_MS,
		ballotsFinal: nowMs - 2 * DAY_MS,
		votingStarts: nowMs - HOUR_MS,
		accruingVotes: nowMs + 2 * HOUR_MS,
		hashingVotes: nowMs + 4 * HOUR_MS,
		releasingKeys: nowMs + 6 * HOUR_MS,
		tallyingStarts: nowMs + 8 * HOUR_MS,
		validation: nowMs + DAY_MS + 2 * HOUR_MS,
		certificationStarts: nowMs + 2 * DAY_MS,
		closed: nowMs + 3 * DAY_MS,
	};
}

/**
 * Countdown variant of `buildAnchoredTimeline` (61-01, D2/D-07) -- starts from the same anchored
 * instant map and moves `tallyingStarts` out to `nowMs + remainingMs`, shifting `validation`,
 * `certificationStarts` and `closed` LATER by the same delta so the whole chain stays
 * monotonically ordered. `deriveTimeline` treats `OUT_OF_ORDER` as a blocking conflict that makes
 * the WHOLE view-model indeterminate (D-03), so a countdown fixture can never move
 * `tallyingStarts` alone -- the three events causally after it must move with it.
 * `registrationEnds`/`ballotsFinal`/`votingStarts`/`accruingVotes`/`hashingVotes`/`releasingKeys`
 * are left exactly as `buildAnchoredTimeline` produced them, so `votingStarts` stays the
 * `current` row and the same-day cluster is preserved.
 */
function buildCountdownTimeline(nowMs: number, remainingMs: number): Record<TimelineStageId, number> {
	const base = buildAnchoredTimeline(nowMs);
	const newTallyingStarts = nowMs + remainingMs;
	const delta = newTallyingStarts - base.tallyingStarts;
	return {
		...base,
		tallyingStarts: newTallyingStarts,
		validation: base.validation + delta,
		certificationStarts: base.certificationStarts + delta,
		closed: base.closed + delta,
	};
}

/**
 * The ten `TimelineRow` view-models in D-09 order, anchored to `nowMs` (default
 * `FIXTURE_NOW_MS`) -- `votingStarts` is `current`; `registrationEnds`/`ballotsFinal` are `past`;
 * everything else is `future`, including the same-day `accruingVotes`/`hashingVotes`/
 * `releasingKeys` cluster. Built by calling the real `deriveTimeline()` adapter, never a
 * hand-rolled join.
 */
export function buildTenRowFixture(nowMs: number = FIXTURE_NOW_MS, timeZone = 'UTC', language = 'en'): TimelineRow[] {
	const result = deriveTimeline({
		timeline: buildAnchoredTimeline(nowMs),
		now: nowMs,
		timeZone,
		language,
	});
	if (result.indeterminate) {
		throw new Error(`buildTenRowFixture: fixture timeline unexpectedly indeterminate -- ${result.reason}`);
	}
	return result.rows;
}

/**
 * The pre-D-08 seven-key slice of `buildTenRowFixture`'s output (drops `accruingVotes`/
 * `hashingVotes`/`releasingKeys`) -- `TimelineRail`'s partial-rail-refusal test input.
 */
export function buildSevenRowFixture(nowMs: number = FIXTURE_NOW_MS): TimelineRow[] {
	const excluded: ReadonlySet<TimelineStageId> = new Set(['accruingVotes', 'hashingVotes', 'releasingKeys']);
	return buildTenRowFixture(nowMs).filter(row => !excluded.has(row.stageId));
}

/**
 * A single `TimelineRow` view-model for ONE stage in ONE status, for `TimelineRow.test.tsx`'s
 * per-stage/per-status action-surface assertions, which exercise one row in isolation rather
 * than a full mutually-consistent ten-row rail. `instantMs`/`railLabel`/`subtitle` default to
 * plausible, self-consistent values a caller can override piece by piece.
 */
export function buildRowFixture(overrides: {stageId: TimelineStageId} & Partial<Omit<TimelineRow, 'stageId'>>): TimelineRow {
	const {stageId} = overrides;
	const status: TimelineRowStatus = overrides.status ?? 'past';
	const instantMs = 'instantMs' in overrides ? (overrides.instantMs ?? null) : FIXTURE_NOW_MS - DAY_MS;

	return {
		stageId,
		titleKey: STAGE_TITLE_KEY[stageId],
		status,
		instantMs,
		railLabel:
			overrides.railLabel ??
			(status === 'current' ? {kind: 'now'} : instantMs !== null ? {kind: 'date', text: '03/20'} : {kind: 'unknown'}),
		subtitle:
			overrides.subtitle !== undefined
				? overrides.subtitle
				: instantMs !== null
					? {key: 'subtitle.pastDate', params: {date: '03/20'}}
					: null,
	};
}

/**
 * A countdown-fixture result (61-01, D2/D-07): the ten-row rail plus the countdown target and its
 * exact remainder, so a consumer can either pin the clock (`nowMs`) or assert the render
 * directly (`remainingSeconds`) without recomputing either from the other.
 */
export interface TimelineCountdownFixture {
	/** The anchor instant the fixture was built against. Exposed so a consumer that asserts
	 * rendered digits can pin the clock with `jest.setSystemTime(nowMs)`. 61-06 asserts wrapper
	 * and card style rather than digits and does not need to pin it; the field still ships,
	 * because a fixture that hides its own anchor is how anchors get mixed. */
	nowMs: number;
	/** The countdown target, named to mirror the prop `TimelineRail` already computes and passes
	 * (`TimelineRail.tsx:75`/`:135`) -- drops straight into either `CountdownTimer targetIso=` or
	 * `TimelineRow countdownTargetIso=`. */
	countdownTargetIso: string;
	/** The exact remainder at `nowMs`. The discriminant Shared Contract 2's `totalSeconds >=
	 * 86400` branch test asserts against. */
	remainingSeconds: number;
	/** The ten mutually-consistent rows, derived through the real `deriveTimeline()` adapter, with
	 * `tallyingStarts` landing on `countdownTargetIso`. */
	rows: TimelineRow[];
}

/**
 * 179 days + 8 hours. `15_494_400 / 3600 = 4304` exactly -- the value in this phase's
 * `evidence/D2-countdown-overflow.png`. The unfixed `format()` renders `4304 : 00 : 00` against
 * this fixture; the fixed one renders `179 : 08 : 00`. This is the phase's positive control for
 * D2, and the production-length row 61-06's Tier-1 assertions render. `179` is three digits, the
 * `> 2 digits` arm of Shared Contract 2's shrink-to-fit step function.
 *
 * The `86400` half of the D2 boundary pair is reached by calling THIS (long) builder with
 * `remainingSeconds: 86_400`, not by a third builder. Two builders, not three.
 */
export const LONG_COUNTDOWN_REMAINING_SECONDS = 15_494_400;

/** Options for the countdown builder. All members optional; unset members take the documented
 * default. */
interface TimelineCountdownFixtureOptions {
	nowMs?: number;
	remainingSeconds?: number;
	timeZone?: string;
	language?: string;
}

/** Construction path for the countdown builder (61-01). `validateBranch` is kept as a parameter
 * rather than inlined: it was the one piece of behaviour that differed between the long and short
 * builders, and the short builder (`buildRowFixtureWithShortCountdown`) was deleted in 2026-09-17's
 * review-todo sweep as dead code -- exported, imported by nothing. The <24h branch is covered at the
 * component level by CountdownTimer.test.tsx's CR-01 block. Restore from git if a ROW-level sub-24h
 * fixture is ever wanted. */
function buildCountdownFixture(
	builderName: string,
	defaultRemainingSeconds: number,
	validateBranch: (remainingSeconds: number) => void,
	options?: TimelineCountdownFixtureOptions,
): TimelineCountdownFixture {
	const nowMs = options?.nowMs ?? FIXTURE_NOW_MS;
	const remainingSeconds = options?.remainingSeconds ?? defaultRemainingSeconds;
	const timeZone = options?.timeZone ?? 'UTC';
	const language = options?.language ?? 'en';

	if (remainingSeconds <= 0) {
		throw new Error(`${builderName}: remainingSeconds must be > 0, got ${remainingSeconds}`);
	}
	validateBranch(remainingSeconds);

	const timeline = buildCountdownTimeline(nowMs, remainingSeconds * 1000);
	const result = deriveTimeline({timeline, now: nowMs, timeZone, language});
	if (result.indeterminate) {
		throw new Error(`${builderName}: fixture timeline unexpectedly indeterminate -- ${result.reason}`);
	}

	return {
		nowMs,
		countdownTargetIso: new Date(nowMs + remainingSeconds * 1000).toISOString(),
		remainingSeconds,
		rows: result.rows,
	};
}

/**
 * Ten-row countdown fixture on the `>= 86400`-second (multi-day) side of the D2 branch boundary
 * (61-01, D2/D-07). Default `remainingSeconds` is `LONG_COUNTDOWN_REMAINING_SECONDS`
 * (`15_494_400`, the evidence screenshot's exact `4304`-hour case). Throws if handed a
 * `remainingSeconds` on the short side (`< 86_400`) or `<= 0` -- the guard that lets a caller
 * write `buildRowFixtureWithLongCountdown({remainingSeconds: 86_400})` and be certain it landed on
 * this branch, not the short one.
 */
export function buildRowFixtureWithLongCountdown(options?: TimelineCountdownFixtureOptions): TimelineCountdownFixture {
	return buildCountdownFixture(
		'buildRowFixtureWithLongCountdown',
		LONG_COUNTDOWN_REMAINING_SECONDS,
		remainingSeconds => {
			if (remainingSeconds < 86_400) {
				throw new Error(`buildRowFixtureWithLongCountdown: remainingSeconds must be >= 86400 (got ${remainingSeconds})`);
			}
		},
		options,
	);
}
