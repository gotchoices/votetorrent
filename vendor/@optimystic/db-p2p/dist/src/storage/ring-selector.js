import { hashPeerId } from 'p2p-fret';
/**
 * Determines appropriate ring depth based on storage capacity and network demand.
 *
 * Ring depth represents keyspace partitioning:
 * - Ring 0: Full keyspace (1 partition)
 * - Ring N: 2^N partitions
 *
 * A node selects its ring based on: available_capacity / estimated_neighborhood_demand
 */
export class RingSelector {
    fretAdapter;
    storageMonitor;
    config;
    constructor(fretAdapter, storageMonitor, config) {
        this.fretAdapter = fretAdapter;
        this.storageMonitor = storageMonitor;
        this.config = config;
    }
    /**
     * Determine appropriate ring depth based on capacity and demand.
     */
    async determineRing() {
        const capacity = await this.storageMonitor.getCapacity();
        if (capacity.available < this.config.minCapacity) {
            // Not enough capacity for any ring
            return -1;
        }
        // Estimate total network spare capacity by aggregating observed per-ring stats.
        // See docs/arachnode.md §"Capacity Management and Ring Adjustment": ring selection
        // should reflect observed network demand, not a hard-coded constant. We treat
        // Σ (peerCount × avgCapacity) over known rings as a proxy for total network spare
        // capacity, so `coverage` becomes our share of it. More peers (or richer peers) →
        // smaller share → higher ring depth (more specialization). On bootstrap, when no
        // ring stats are observed yet, we fall back to a conservative fixed estimate so
        // first-boot behavior is deterministic.
        const ringStats = this.fretAdapter.getRingStats();
        let estimatedTotalData;
        if (ringStats.length > 0) {
            estimatedTotalData = ringStats.reduce((sum, stat) => sum + stat.peerCount * stat.avgCapacity, 0);
        }
        else {
            const avgBlockSize = 100 * 1024; // 100KB typical block
            const estimatedTotalBlocks = 1000; // Conservative estimate
            estimatedTotalData = estimatedTotalBlocks * avgBlockSize;
        }
        // Guard against pathological zero-aggregate (e.g. all peers report 0 available);
        // fall back to local capacity so coverage = 1.0 (ring 0).
        if (estimatedTotalData <= 0) {
            estimatedTotalData = capacity.available;
        }
        // Calculate what fraction of keyspace we can cover
        const coverage = capacity.available / estimatedTotalData;
        // Ring depth: 0 = full keyspace, N = 2^N partitions
        // If coverage = 0.01 (1%), we need ~100 partitions ≈ Ring 7
        // If coverage = 1.0 (100%), we can handle full keyspace = Ring 0
        const ringDepth = Math.max(0, Math.ceil(-Math.log2(Math.max(0.001, coverage))));
        return Math.min(ringDepth, 16); // Cap at Ring 16 (65536 partitions)
    }
    /**
     * Calculate partition for a given ring depth and peer ID.
     */
    async calculatePartition(ringDepth, peerId) {
        if (ringDepth === 0) {
            return undefined; // Full keyspace, no partition
        }
        // Hash peer ID to get coordinate
        const coord = await hashPeerId({ toString: () => peerId });
        // Extract prefix bits from coordinate
        const prefixBits = ringDepth;
        const prefixValue = this.extractPrefix(coord, prefixBits);
        return { prefixBits, prefixValue };
    }
    /**
     * Create Arachnode info for this node.
     */
    async createArachnodeInfo(peerId) {
        const capacity = await this.storageMonitor.getCapacity();
        const ringDepth = await this.determineRing();
        const partition = ringDepth >= 0
            ? await this.calculatePartition(ringDepth, peerId)
            : undefined;
        return {
            ringDepth: Math.max(0, ringDepth),
            partition,
            capacity: {
                total: capacity.total,
                used: capacity.used,
                available: capacity.available
            },
            status: 'active'
        };
    }
    /**
     * Monitor capacity and determine if ring transition is needed.
     */
    async shouldTransition() {
        const capacity = await this.storageMonitor.getCapacity();
        const usedPercent = capacity.used / capacity.total;
        if (usedPercent > this.config.thresholds.moveOut) {
            // Move to outer ring (more granular partition)
            const currentRingDepth = await this.determineRing();
            return {
                shouldMove: true,
                direction: 'out',
                newRingDepth: currentRingDepth + 1
            };
        }
        if (usedPercent < this.config.thresholds.moveIn) {
            // Move to inner ring (broader coverage)
            const currentRingDepth = await this.determineRing();
            if (currentRingDepth > 0) {
                return {
                    shouldMove: true,
                    direction: 'in',
                    newRingDepth: currentRingDepth - 1
                };
            }
        }
        return { shouldMove: false };
    }
    /**
     * Extract first N bits from byte array as a number.
     */
    extractPrefix(bytes, bits) {
        let value = 0;
        for (let i = 0; i < bits; i++) {
            const byteIndex = Math.floor(i / 8);
            const bitIndex = 7 - (i % 8);
            const bit = (bytes[byteIndex] >> bitIndex) & 1;
            value = (value << 1) | bit;
        }
        return value;
    }
}
//# sourceMappingURL=ring-selector.js.map