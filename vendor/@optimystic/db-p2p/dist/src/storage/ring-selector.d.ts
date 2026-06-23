import type { StorageMonitor } from './storage-monitor.js';
import type { ArachnodeInfo, ArachnodeFretAdapter } from './arachnode-fret-adapter.js';
export interface RingSelectorConfig {
    /** Minimum storage capacity in bytes */
    minCapacity: number;
    /** Thresholds for ring transitions */
    thresholds: {
        /** Move to outer ring when used > this % */
        moveOut: number;
        /** Move to inner ring when used < this % */
        moveIn: number;
    };
}
/**
 * Determines appropriate ring depth based on storage capacity and network demand.
 *
 * Ring depth represents keyspace partitioning:
 * - Ring 0: Full keyspace (1 partition)
 * - Ring N: 2^N partitions
 *
 * A node selects its ring based on: available_capacity / estimated_neighborhood_demand
 */
export declare class RingSelector {
    private readonly fretAdapter;
    private readonly storageMonitor;
    private readonly config;
    constructor(fretAdapter: ArachnodeFretAdapter, storageMonitor: StorageMonitor, config: RingSelectorConfig);
    /**
     * Determine appropriate ring depth based on capacity and demand.
     */
    determineRing(): Promise<number>;
    /**
     * Calculate partition for a given ring depth and peer ID.
     */
    calculatePartition(ringDepth: number, peerId: string): Promise<{
        prefixBits: number;
        prefixValue: number;
    } | undefined>;
    /**
     * Create Arachnode info for this node.
     */
    createArachnodeInfo(peerId: string): Promise<ArachnodeInfo>;
    /**
     * Monitor capacity and determine if ring transition is needed.
     */
    shouldTransition(): Promise<{
        shouldMove: boolean;
        direction?: 'in' | 'out';
        newRingDepth?: number;
    }>;
    /**
     * Extract first N bits from byte array as a number.
     */
    private extractPrefix;
}
//# sourceMappingURL=ring-selector.d.ts.map