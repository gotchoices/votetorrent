/**
 * keyholder-session.ts — thin binding. The keyholder session seam moved to
 * `packages/workflows/src/authority/keyholder-session.ts` (phase 67 plan 05); this path stays so
 * existing imports and tests keep working. No logic lives here.
 */

export { withKeyholderSession } from '@votetorrent/workflows/authority';
export type { KeyholderSessionVault } from '@votetorrent/workflows/authority';
