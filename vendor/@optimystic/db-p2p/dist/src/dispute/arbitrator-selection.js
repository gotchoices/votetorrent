import { sortPeersByDistance } from '../routing/responsibility.js';
/**
 * Select arbitrators for a dispute using XOR-distance from the block ID.
 * Selects the next K peers beyond the original cluster (positions K+1 through 2K).
 * This ensures independence (arbitrators are not in the original cluster)
 * and determinism (all parties agree on who arbitrates).
 */
export function selectArbitrators(allPeers, blockIdBytes, excludePeerIds, count) {
    // Sort all peers by XOR distance to the block ID
    const sorted = sortPeersByDistance(allPeers, blockIdBytes);
    // Skip peers in the original cluster (and self), select the next K
    const arbitrators = [];
    for (const peer of sorted) {
        if (arbitrators.length >= count)
            break;
        if (excludePeerIds.has(peer.id.toString()))
            continue;
        arbitrators.push(peer.id);
    }
    return arbitrators;
}
//# sourceMappingURL=arbitrator-selection.js.map