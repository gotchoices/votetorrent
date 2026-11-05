/**
 * derive-timeline.ts -- Phase 59 plan 59-06, Task 3.
 *
 * `deriveTimeline`: the `ElectionEvent`-instants-to-`TimelineStageId`-rows join. Imports 59-02's
 * `normalizeInstant` / `parseTimeline` / `finestStage` / `STRICT_CHAIN` / `PREPARATION` / `CONFLICT`
 * and never reimplements or "improves" any of their loops (D-19). Takes `now` only as an argument
 * -- no source file under `src/timeline/` reads the process clock anywhere (see the no-ambient-
 * clock scan in `__tests__/derive-timeline.test.ts`).
 */
import {
	CONFLICT,
	PREPARATION,
	finestStage,
	normalizeInstant,
	parseTimeline,
} from '@votetorrent/ui-web/lifecycle-core';
import {STRICT_CHAIN} from '@votetorrent/ui-web/lifecycle-core';
import type {TimelineStageId} from '@votetorrent/ui-web/lifecycle-core';

import {STAGE_TITLE_KEY, TIMELINE_STAGE_IDS} from './stages';
import {formatRailDate, relativeDateSubtitle} from './relative-date';
import type {
	DeriveTimelineInput,
	TimelineConflict,
	TimelineRailLabel,
	TimelineRow,
	TimelineRowStatus,
	TimelineSubtitle,
	TimelineViewModel,
} from './types';

const STRICT_CHAIN_ORDER = STRICT_CHAIN as readonly TimelineStageId[];
const PREPARATION_MEMBERS = PREPARATION as readonly TimelineStageId[];

/** Conflict codes that make the WHOLE view-model indeterminate (D-03). `MISSING_EVENT` is deliberately absent -- it degrades per-row, never the whole rail. */
const INDETERMINATE_CONFLICT_CODES: ReadonlySet<string> = new Set([
	CONFLICT.UNPARSEABLE,
	CONFLICT.OUT_OF_ORDER,
	CONFLICT.BALLOTS_FINAL_AFTER_DEADLINE,
	CONFLICT.EVENT_AFTER_ELECTION_DATE,
	CONFLICT.CLOSED_BEFORE_ELECTION_DATE,
]);

function summarizeConflicts(conflicts: TimelineConflict[]): string {
	return conflicts.map(c => `${c.code}(${c.event}): ${c.detail}`).join('; ');
}

/**
 * Settle the status of a row whose own instant is ABSENT, driven by `STRICT_CHAIN`/`PREPARATION`
 * membership rather than array index (`59-06-PLAN.md`'s status-resolution contract):
 *
 * - A `PREPARATION` row's settling set is the WHOLE `STRICT_CHAIN`: if any present `STRICT_CHAIN`
 *   instant has already been crossed, both preparation events (which causally precede all of
 *   `STRICT_CHAIN`) must already be past too. Otherwise it stays `unknown` -- a missing
 *   preparation event can never be settled as `future` by causality alone, because nothing is
 *   declared to causally precede it.
 * - A `STRICT_CHAIN` row's settling set is the `STRICT_CHAIN` members strictly AFTER it (a
 *   crossed later event proves this one is over) union the `STRICT_CHAIN` members strictly
 *   BEFORE it plus both `PREPARATION` events (an uncrossed earlier event proves this one hasn't
 *   happened yet). A crossed `ballotsFinal` never settles a missing `registrationEnds` and vice
 *   versa -- they are independent preparation tracks, not chained to each other.
 */
function resolveAbsentStatus(stageId: TimelineStageId, at: Record<string, number | null>, nowMs: number): 'past' | 'future' | 'unknown' {
	const crossed = (id: TimelineStageId): boolean => {
		const ms = at[id];
		return ms !== null && nowMs >= ms;
	};
	const notYetCrossed = (id: TimelineStageId): boolean => {
		const ms = at[id];
		return ms !== null && nowMs < ms;
	};

	if (PREPARATION_MEMBERS.includes(stageId)) {
		const anyStrictChainCrossed = STRICT_CHAIN_ORDER.some(crossed);
		return anyStrictChainCrossed ? 'past' : 'unknown';
	}

	const idx = STRICT_CHAIN_ORDER.indexOf(stageId);
	const laterMembers = STRICT_CHAIN_ORDER.slice(idx + 1);
	const earlierMembers: readonly TimelineStageId[] = [...PREPARATION_MEMBERS, ...STRICT_CHAIN_ORDER.slice(0, idx)];

	if (laterMembers.some(crossed)) return 'past';
	if (earlierMembers.some(notYetCrossed)) return 'future';
	return 'unknown';
}

function buildRow(
	stageId: TimelineStageId,
	at: Record<string, number | null>,
	nowMs: number,
	currentStageId: TimelineStageId | null,
	language: string,
	timeZone: string,
): TimelineRow {
	const instantMs = at[stageId];
	let status: TimelineRowStatus;

	if (stageId === currentStageId) {
		status = 'current';
	} else if (instantMs !== null) {
		status = nowMs >= instantMs ? 'past' : 'future';
	} else {
		status = resolveAbsentStatus(stageId, at, nowMs);
	}

	const railLabel: TimelineRailLabel =
		status === 'current'
			? {kind: 'now'}
			: instantMs !== null
				? {kind: 'date', text: formatRailDate(instantMs, timeZone, language)}
				: {kind: 'unknown'};

	const subtitle: TimelineSubtitle = instantMs !== null ? relativeDateSubtitle(instantMs, nowMs, {language, timeZone}) : null;

	return {
		stageId,
		titleKey: STAGE_TITLE_KEY[stageId],
		status,
		instantMs,
		railLabel,
		subtitle,
	};
}

/**
 * Join `ElectionEvent` instants to `TimelineStageId` rows (D-07's directional intent: compute
 * past/current/future with an interval-style, newest-first walk over the ten stage ids -- never
 * expose raw persisted `ElectionEvent` booleans to the view). Never throws -- a broken `Timeline`
 * blob is an expected input (the column carries zero CHECK constraints), not an exception.
 */
export function deriveTimeline(input: DeriveTimelineInput): TimelineViewModel {
	const language = input.language ?? 'en';
	const timeZone = input.timeZone ?? 'UTC';

	const nowMs = normalizeInstant(input.now);
	if (nowMs === null) {
		return {
			indeterminate: true,
			reason: `\`now\` does not normalize to a finite instant: ${JSON.stringify(input.now)}`,
			conflicts: [],
		};
	}

	const {at, conflicts} = parseTimeline(input.timeline, input.election ?? {});

	const blockingConflicts = conflicts.filter(c => INDETERMINATE_CONFLICT_CODES.has(c.code));
	const allTenNull = TIMELINE_STAGE_IDS.every(id => at[id] === null);

	if (blockingConflicts.length > 0) {
		return {
			indeterminate: true,
			reason: `Timeline has ${blockingConflicts.length} blocking conflict(s): ${summarizeConflicts(blockingConflicts)}`,
			conflicts,
		};
	}
	if (allTenNull) {
		return {
			indeterminate: true,
			reason: 'All ten Timeline instants are null/absent -- nothing to render.',
			conflicts,
		};
	}

	const currentStageId = finestStage(at, nowMs);

	const rows: TimelineRow[] = TIMELINE_STAGE_IDS.map(stageId => buildRow(stageId, at, nowMs, currentStageId, language, timeZone));

	const presentInstants = TIMELINE_STAGE_IDS.map(id => at[id]).filter((ms): ms is number => ms !== null);
	const rangeStartMs = Math.min(...presentInstants);
	const rangeEndMs = Math.max(...presentInstants);

	return {
		indeterminate: false,
		rows,
		currentStageId,
		rangeStartMs,
		rangeEndMs,
		reason: conflicts.length > 0 ? summarizeConflicts(conflicts) : '',
		conflicts,
	};
}
