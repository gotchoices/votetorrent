/**
 * pool-rendezvous-host.ts — binding. The code moved to
 * `packages/workflows/src/authority/pool-rendezvous-host.ts` (phase 67 plan 07) so the vt CLI shares
 * it. This path stays so existing imports, tests and jest mocks (CadreNodeProvider.test.tsx mocks it
 * wholesale) keep working; it holds no logic of its own.
 */
export { hostPoolRendezvous } from '@votetorrent/workflows/authority';
