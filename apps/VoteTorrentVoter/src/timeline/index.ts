/**
 * index.ts -- Phase 59 plan 59-06.
 *
 * The public surface of `src/timeline/` -- the one path 59-07 (rail) and 59-08 (screen) import.
 * No component, no screen, no navigation, no i18n resource edits live here or anywhere else in
 * this module (59-05 owns the `timeline` i18n namespace).
 */
export {deriveTimeline} from './derive-timeline';
export {STAGE_TITLE_KEY, TIMELINE_KEYS, TIMELINE_STAGE_IDS} from './stages';
export type {
	DeriveTimelineElectionFields,
	DeriveTimelineInput,
	TimelineConflict,
	TimelineRailLabel,
	TimelineRow,
	TimelineRowStatus,
	TimelineStageId,
	TimelineSubtitle,
	TimelineSubtitleParams,
	TimelineViewModel,
	TimelineViewModelConfident,
	TimelineViewModelIndeterminate,
} from './types';
