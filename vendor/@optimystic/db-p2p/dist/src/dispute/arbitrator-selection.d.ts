import type { PeerId } from '@libp2p/interface';
import { type KnownPeer } from '../routing/responsibility.js';
/**
 * Select arbitrators for a dispute using XOR-distance from the block ID.
 * Selects the next K peers beyond the original cluster (positions K+1 through 2K).
 * This ensures independence (arbitrators are not in the original cluster)
 * and determinism (all parties agree on who arbitrates).
 */
export declare function selectArbitrators(allPeers: KnownPeer[], blockIdBytes: Uint8Array, excludePeerIds: Set<string>, count: number): PeerId[];
//# sourceMappingURL=arbitrator-selection.d.ts.map