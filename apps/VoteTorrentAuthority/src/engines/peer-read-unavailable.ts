/**
 * peer-read-unavailable.ts — thin binding. The peer-read classifier moved to
 * `packages/workflows/src/authority/peer-read-unavailable.ts` (phase 67 plan 05); this path stays so
 * existing imports and tests keep working. No logic lives here.
 */

export { classifyPeerReadFailure } from '@votetorrent/workflows/authority';
export type { PeerReadFailure } from '@votetorrent/workflows/authority';
