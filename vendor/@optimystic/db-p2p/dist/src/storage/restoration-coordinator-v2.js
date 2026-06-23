import { hashKey } from 'p2p-fret';
import { peerIdFromString } from '@libp2p/peer-id';
import { SyncClient } from '../sync/client.js';
import { createLogger } from '../logger.js';
/**
 * Coordinates block restoration across discovered Arachnode storage rings.
 *
 * Queries rings in order of broader coverage (inner rings first):
 * 1. Transaction ring peers (my ring)
 * 2. Inner storage rings (Ring N-1, N-2, ..., Ring 0)
 *
 * Each ring is discovered dynamically via FRET neighbor snapshots.
 */
export class RestorationCoordinator {
    fretAdapter;
    peerNetwork;
    protocolPrefix;
    selfPeerId;
    metrics = {
        totalRequests: 0,
        successByRing: new Map(),
        failureByRing: new Map(),
        averageDurationMs: 0
    };
    constructor(fretAdapter, peerNetwork, protocolPrefix, 
    /** Optional self peer id — used to skip dialing self on solo/bootstrap nodes. */
    selfPeerId) {
        this.fretAdapter = fretAdapter;
        this.peerNetwork = peerNetwork;
        this.protocolPrefix = protocolPrefix;
        this.selfPeerId = selfPeerId;
    }
    log = createLogger('storage:restoration');
    /**
     * Restore a block by querying discovered storage rings.
     */
    async restore(blockId, rev) {
        const startTime = Date.now();
        this.metrics.totalRequests++;
        // 1. Try my transaction ring peers first
        const myPeers = await this.getMyRingPeers(blockId);
        const myRingDepth = this.getMyRingDepth();
        // Avoid dialing self: on a solo/bootstrap node with no listenAddrs, dialing self
        // either hangs or fails noisily. Filter self out of the ring-peer list so the loop
        // below can no-op cleanly when self is the only candidate.
        const nonSelfMyPeers = this.selfPeerId
            ? myPeers.filter(p => p !== this.selfPeerId)
            : myPeers;
        if (nonSelfMyPeers.length === 0 && myRingDepth <= 0) {
            this.log('restore:solo-node-skip blockId=%s', blockId);
            return undefined;
        }
        for (const peerId of nonSelfMyPeers) {
            const archive = await this.queryPeer(peerId, blockId, rev);
            if (archive) {
                this.recordSuccess(myRingDepth, blockId, Date.now() - startTime);
                return archive;
            }
        }
        // 2. Try inner storage rings (broader coverage)
        for (let ringDepth = myRingDepth - 1; ringDepth >= 0; ringDepth--) {
            const storagePeers = this.fretAdapter.findPeersAtRing(ringDepth);
            // Filter to peers responsible for this block's partition (skip self — cannot dial self).
            const responsiblePeers = this.filterByPartition(storagePeers, blockId, ringDepth)
                .filter(p => !this.selfPeerId || p !== this.selfPeerId);
            for (const peerIdStr of responsiblePeers) {
                const archive = await this.queryPeer(peerIdStr, blockId, rev);
                if (archive) {
                    this.recordSuccess(ringDepth, blockId, Date.now() - startTime);
                    return archive;
                }
            }
        }
        // No ring had the data
        const duration = Date.now() - startTime;
        this.log('restore failed for block %s after %dms', blockId, duration);
        return undefined;
    }
    /**
     * Create a RestoreCallback function that uses this coordinator.
     */
    createRestoreCallback() {
        return async (blockId, rev) => {
            return await this.restore(blockId, rev);
        };
    }
    /**
     * Get peers in my transaction ring for a given block.
     */
    async getMyRingPeers(blockId) {
        const blockIdBytes = new TextEncoder().encode(blockId);
        const coord = await hashKey(blockIdBytes);
        return this.fretAdapter.getFret().assembleCohort(coord, 10);
    }
    /**
     * Get my own ring depth from Arachnode info.
     */
    getMyRingDepth() {
        const myInfo = this.fretAdapter.getMyArachnodeInfo();
        return myInfo?.ringDepth ?? 8; // Default to Ring 8
    }
    /**
     * Filter peers by partition responsibility.
     */
    filterByPartition(peers, blockId, ringDepth) {
        if (ringDepth === 0) {
            return peers; // Ring 0 covers all blocks
        }
        const blockPrefix = this.extractBlockPrefix(blockId, ringDepth);
        return peers.filter(peerId => {
            const info = this.fretAdapter.getArachnodeInfo(peerId);
            if (!info || !info.partition)
                return false;
            return info.partition.prefixValue === blockPrefix;
        });
    }
    /**
     * Extract prefix bits from block ID for partition matching.
     */
    extractBlockPrefix(blockId, bits) {
        const bytes = new TextEncoder().encode(blockId);
        // Hash the block ID to get uniform distribution
        const hash = new Uint8Array(32);
        for (let i = 0; i < Math.min(bytes.length, hash.length); i++) {
            hash[i] = bytes[i];
        }
        // Extract first N bits
        let value = 0;
        for (let i = 0; i < bits; i++) {
            const byteIndex = Math.floor(i / 8);
            const bitIndex = 7 - (i % 8);
            const bit = (hash[byteIndex] >> bitIndex) & 1;
            value = (value << 1) | bit;
        }
        return value;
    }
    /**
     * Query a specific peer for a block.
     */
    async queryPeer(peerIdStr, blockId, rev) {
        try {
            const peerId = peerIdFromString(peerIdStr);
            const client = new SyncClient(peerId, this.peerNetwork, this.protocolPrefix);
            const response = await client.requestBlock({ blockId, rev });
            return response.success ? response.archive : undefined;
        }
        catch (error) {
            this.log('queryPeer failed for %s - %o', peerIdStr, error);
            return undefined;
        }
    }
    /**
     * Record successful restoration from a ring.
     */
    recordSuccess(ringDepth, blockId, durationMs) {
        const count = this.metrics.successByRing.get(ringDepth) ?? 0;
        this.metrics.successByRing.set(ringDepth, count + 1);
        // Update rolling average duration
        const totalSuccesses = Array.from(this.metrics.successByRing.values())
            .reduce((sum, c) => sum + c, 0);
        const prevTotal = this.metrics.averageDurationMs * (totalSuccesses - 1);
        this.metrics.averageDurationMs = (prevTotal + durationMs) / totalSuccesses;
        console.log(`[Ring ${ringDepth}] Successfully restored block ${blockId} in ${durationMs}ms`);
    }
    /**
     * Get restoration metrics for monitoring.
     */
    getMetrics() {
        return { ...this.metrics };
    }
}
//# sourceMappingURL=restoration-coordinator-v2.js.map