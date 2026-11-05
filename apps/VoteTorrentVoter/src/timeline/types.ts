/**
 * types.ts -- Phase 59 plan 59-06, Task 1.
 *
 * The row/view-model contracts `deriveTimeline` (Task 3) returns and that 59-07 (rail)/59-08
 * (screen) consume. `TimelineStageId` is re-exported (type-only, `isolatedModules: true`) from
 * 59-02's `@votetorrent/ui-web/lifecycle-core` -- there is exactly ONE ten-member id list in the
 * repo and this module never re-declares it (D-21, R4).
 */
import type {TimelineStageId} from '@votetorrent/ui-web/lifecycle-core';

export type {TimelineStageId};

/**
 * Per-row status (D-18's half-open, newest-first walk). `unknown` is a settle-neither-way
 * outcome for a row whose own instant is absent and no causally-adjacent event confirms it as
 * past or future -- it renders with the FUTURE de-emphasised treatment plus an em-dash where the
 * `MM/DD` rail label would go (59-07's contract, stated here so 59-07 does not have to invent
 * it). `unknown` is never `current`.
 */
export type TimelineRowStatus = 'past' | 'current' | 'future' | 'unknown';

/**
 * The rail's per-row label. `'now'` renders the literal word "Now" (bold, `colors.primary`,
 * i18n key `rail.now`); `'date'` renders the row's own `MM/DD` text (Task 2's `formatRailDate`);
 * `'unknown'` renders an em-dash (59-07's job, not this module's -- no text is carried here).
 */
export type TimelineRailLabel = {kind: 'now'} | {kind: 'date'; text: string} | {kind: 'unknown'};

/** `subtitle.today` / `subtitle.futureWeekday` carry `{{weekday}}`; the two date-shaped keys carry `{{date}}`; `subtitle.yesterday` carries no params. */
export type TimelineSubtitleParams = {weekday: string} | {date: string} | undefined;

/**
 * A relative-date subtitle as an i18n KEY plus PARAMS -- never resolved copy (D-20, project
 * pattern: `ValidationCheck.nameKey`, `STATE_DISPLAY.summaryKey`). `null` only for an `unknown`
 * row, which has no instant to describe.
 */
export type TimelineSubtitle = {key: string; params: TimelineSubtitleParams} | null;

/** One rail row: the join of an `ElectionEvent` instant to its `TimelineStageId` identity. */
export interface TimelineRow {
	stageId: TimelineStageId;
	/** Namespace-relative flat dotted i18n key, from `STAGE_TITLE_KEY` (`stages.ts`). */
	titleKey: string;
	status: TimelineRowStatus;
	/** The row's own instant, epoch-ms, or `null` when absent (`unknown` and some `past`/`future` rows). */
	instantMs: number | null;
	railLabel: TimelineRailLabel;
	subtitle: TimelineSubtitle;
}

/**
 * One diagnostic `parseTimeline` (59-02) reported while parsing/cross-checking the raw Timeline
 * blob. MACHINE DIAGNOSTICS ONLY -- `detail` embeds raw timeline values and English prose authored
 * outside the copy table. Never route a `conflicts[].detail` string (or `TimelineViewModel.reason`
 * below) through `t()` or render it directly; it is for logs and test failure messages only. 59-08
 * renders `indeterminate.heading` / `indeterminate.body` / `indeterminate.retryCta` instead, which
 * are ordinary i18n keys unrelated to this diagnostic text.
 */
export interface TimelineConflict {
	code: string;
	event: string;
	detail: string;
}

/**
 * The confident answer: exactly ten rows in D-09 order, a `currentStageId` (or `null` when the
 * election has not opened yet -- a legitimate, confident answer, not indeterminate), and the
 * earliest/latest non-null instant so 59-08's header never re-parses the timeline. `reason`/
 * `conflicts` MAY be non-empty here too -- a `MISSING_EVENT`-only input (the 7-of-10 case) does
 * NOT make the model indeterminate, but the diagnostic is still carried for logs.
 */
export interface TimelineViewModelConfident {
	indeterminate: false;
	rows: TimelineRow[];
	currentStageId: TimelineStageId | null;
	rangeStartMs: number;
	rangeEndMs: number;
	/** Machine diagnostic -- see the `TimelineConflict` doc comment. May be empty. */
	reason: string;
	/** Machine diagnostics -- see the `TimelineConflict` doc comment. May be empty. */
	conflicts: TimelineConflict[];
}

/**
 * The explicit indeterminate answer (D-03): read failure, absent/unparseable/non-monotonic
 * timeline, a non-finite `now`, or a schema cross-check conflict. Zero rows -- never a partial or
 * guessed rail.
 */
export interface TimelineViewModelIndeterminate {
	indeterminate: true;
	/** Machine diagnostic naming the trigger -- see the `TimelineConflict` doc comment. Never empty. */
	reason: string;
	/** Machine diagnostics -- see the `TimelineConflict` doc comment. */
	conflicts: TimelineConflict[];
}

/** Discriminated on `indeterminate` -- see the contracts table in `59-06-PLAN.md`. */
export type TimelineViewModel = TimelineViewModelConfident | TimelineViewModelIndeterminate;

/**
 * The schema-enforced fields `deriveTimeline` passes through untouched to 59-02's `parseTimeline`
 * for cross-checking against the unenforced JSON `Timeline` blob. Mirrors timeline-core.js's own
 * `ElectionCrossCheckFields` shape without importing it as a value (JSDoc typedefs are not
 * importable as TS types from a plain-JS module) -- both fields are optional because a caller
 * that holds no election row (a test fixture) can supply neither.
 */
export interface DeriveTimelineElectionFields {
	ballotDeadline?: unknown;
	date?: unknown;
}

/** `deriveTimeline`'s single input. `now` and every `timeline` value are normalized via 59-02's `normalizeInstant`. */
export interface DeriveTimelineInput {
	/** The raw `Timeline` column value: an object, a JSON string, `null`/`undefined`, or garbage -- `parseTimeline` (59-02) accepts all of these and never throws. */
	timeline: unknown;
	/** The instant to compare against. Epoch-ms or a canonical 19-char datetime string -- never read from the process clock (see the "No ambient clock" contract). */
	now: number | string;
	/** Optional schema-enforced cross-check fields, passed through to `parseTimeline` untouched. */
	election?: DeriveTimelineElectionFields;
	/** Active i18n language for `Intl.DateTimeFormat` (Task 2). Defaults to `'en'` when omitted. */
	language?: string;
	/** IANA timeZone for calendar-day/weekday/MM-DD presentation (Task 2). Defaults to the device-local zone when omitted -- deliberately NOT UTC, per the contracts' "a voter near midnight" rationale. */
	timeZone?: string;
}
