/**
 * stages.ts -- binding over the shared stage list and key tables, which moved to
 * `packages/workflows/src/voter/timeline/stages.ts` (phase 67 plan 19). This path stays so existing
 * imports and tests keep working. `TIMELINE_STAGE_IDS` is still the ui-web stage-list object itself
 * (D-19), reached through the shared module.
 */
export {STAGE_TITLE_KEY, TIMELINE_KEYS, TIMELINE_STAGE_IDS} from '@votetorrent/workflows/voter';
export type {TimelineStageId} from '@votetorrent/workflows/voter';
