/**
 * derive-timeline.ts -- binding over the shared `deriveTimeline`, which moved to
 * `packages/workflows/src/voter/timeline/derive-timeline.ts` (phase 67 plan 19). This path stays so
 * existing imports and tests keep working; the no-ambient-clock scan in
 * `__tests__/derive-timeline.test.ts` walks the shared directory.
 */
export {deriveTimeline} from '@votetorrent/workflows/voter';
