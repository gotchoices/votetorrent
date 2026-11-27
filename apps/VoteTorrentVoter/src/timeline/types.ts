/**
 * types.ts -- binding over the shared timeline contracts, which moved to
 * `packages/workflows/src/voter/timeline/types.ts` (phase 67 plan 19). This path stays so existing
 * imports and tests keep working. Type-only, re-exported by name.
 */
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
} from '@votetorrent/workflows/voter';
