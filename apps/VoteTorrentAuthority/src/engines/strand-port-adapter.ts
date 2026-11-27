/**
 * strand-port-adapter.ts — binding. The code moved to
 * `packages/workflows/src/authority/strand-port-adapter.ts` (phase 67 plan 07) so the vt CLI shares
 * it. This path stays so existing imports (engine-factory.ts) and tests keep working; it holds no
 * logic of its own, and `close()` is still the shared no-op that never touches the strand Database.
 */
export { createStrandPort } from '@votetorrent/workflows/authority';
export type { StrandSqlDatabase, StagingStrandPort } from '@votetorrent/workflows/authority';
