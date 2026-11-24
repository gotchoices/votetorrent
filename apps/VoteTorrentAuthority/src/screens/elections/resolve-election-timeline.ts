/**
 * resolve-election-timeline.ts: the D-16 shared timeline construction site moved to
 * `packages/workflows/src/authority/resolve-election-timeline.ts` (phase 67 plan 10). This path stays so
 * every existing import, test and the lean rig's hook import keep working; it is a thin binding with the
 * same export names and no logic.
 */
export {
  TIMELINE_FIELD_ORDER,
  CREATE_FALLBACK_DAYS,
  EDIT_FALLBACK_DAYS,
  resolveElectionTimeline,
  TIMELINE_STRICT_CHAIN,
  findTimelineOrderViolation,
} from '@votetorrent/workflows/authority'
export type { TimelineFormDates, TimelineFallbackDays, TimelineOrderViolation } from '@votetorrent/workflows/authority'
