import type { BlockId } from '@optimystic/db-core';
import type { BlockArchive, RestoreCallback } from './struct.js';
import type { IPeerNetwork } from '@optimystic/db-core';
import type { ArachnodeFretAdapter } from './arachnode-fret-adapter.js';
/**
 * Coordinates block restoration across discovered Arachnode storage rings.
 *
 * Queries rings in order of broader coverage (inner rings first):
 * 1. Transaction ring peers (my ring)
 * 2. Inner storage rings (Ring N-1, N-2, ..., Ring 0)
 *
 * Each ring is discovered dynamically via FRET neighbor snapshots.
 */
export declare class RestorationCoordinator {
    private readonly fretAdapter;
    private readonly peerNetwork;
    private readonly protocolPrefix;
    /** Optional self peer id — used to skip dialing self on solo/bootstrap nodes. */
    private readonly selfPeerId?;
    private readonly metrics;
    constructor(fretAdapter: ArachnodeFretAdapter, peerNetwork: IPeerNetwork, protocolPrefix: string, 
    /** Optional self peer id — used to skip dialing self on solo/bootstrap nodes. */
    selfPeerId?: string | undefined);
    private readonly log;
    /**
     * Restore a block by querying discovered storage rings.
     */
    restore(blockId: BlockId, rev?: number): Promise<BlockArchive | undefined>;
    /**
     * Create a RestoreCallback function that uses this coordinator.
     */
    createRestoreCallback(): RestoreCallback;
    /**
     * Get peers in my transaction ring for a given block.
     */
    private getMyRingPeers;
    /**
     * Get my own ring depth from Arachnode info.
     */
    private getMyRingDepth;
    /**
     * Filter peers by partition responsibility.
     */
    private filterByPartition;
    /**
     * Extract prefix bits from block ID for partition matching.
     */
    private extractBlockPrefix;
    /**
     * Query a specific peer for a block.
     */
    private queryPeer;
    /**
     * Record successful restoration from a ring.
     */
    private recordSuccess;
    /**
     * Get restoration metrics for monitoring.
     */
    getMetrics(): {
        totalRequests: number;
        successByRing: Map<number, number>;
        failureByRing: Map<number, number>;
        averageDurationMs: number;
    };
}
//# sourceMappingURL=restoration-coordinator-v2.d.ts.map