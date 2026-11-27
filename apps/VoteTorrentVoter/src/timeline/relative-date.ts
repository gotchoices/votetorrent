/**
 * relative-date.ts -- binding over the shared relative-date helpers, which moved to
 * `packages/workflows/src/voter/timeline/relative-date.ts` (phase 67 plan 19). This path stays so
 * existing imports and tests keep working; the copy-word scan in `__tests__/relative-date.test.ts`
 * reads the shared file.
 */
export {calendarDayDiff, formatRailDate, relativeDateSubtitle} from '@votetorrent/workflows/voter';
