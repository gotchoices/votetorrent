/**
 * Relay seed moved to @votetorrent/workflows common/strand-relay-seed.ts; this path stays so the
 * relay-seed tests import it unchanged. Pure re-export, by identity.
 */
export { normalizeRelaySeed, seedStrandWithRelays } from '@votetorrent/workflows';
export type { StrandSeedHost, RelaySeedOutcome } from '@votetorrent/workflows';
