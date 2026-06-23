import type { NodeProfile, ArachnodeConfig } from './types.js';
/**
 * Ring configuration for a storage node
 */
export interface RingConfig {
    /** Ring number (0 = full keyspace, higher = more partitions) */
    ring: number;
    /** Partition within the ring (depends on ring level) */
    partition: number;
    /** Keyspace range this node is responsible for */
    keyspaceStart: Uint8Array;
    keyspaceEnd: Uint8Array;
}
/**
 * Stub implementation of Arachnode ring participation.
 *
 * Arachnode uses a concentric ring system where:
 * - Ring Zulu (transaction ring): All nodes participate for transaction verification
 * - Storage rings (0, 1, 2, 3...): Nodes join based on their storage capacity
 *   - Ring 0: Full keyspace (requires most storage)
 *   - Ring 1: 2 partitions
 *   - Ring 2: 4 partitions
 *   - Ring 3: 8 partitions
 *   - etc.
 *
 * This is a stub that will be replaced when arachnode is fully implemented.
 */
export declare class ArachnodeStub {
    private readonly profile;
    private readonly config;
    private ringConfig?;
    private running;
    constructor(profile: NodeProfile, config: ArachnodeConfig);
    /**
     * Start participating in rings
     */
    start(): Promise<void>;
    /**
     * Stop participating in rings
     */
    stop(): Promise<void>;
    /**
     * Get current ring configuration
     */
    getRingConfig(): RingConfig | undefined;
    /**
     * Check if participating in Ring Zulu
     */
    isInRingZulu(): boolean;
    /**
     * Check if participating in a storage ring
     */
    isInStorageRing(): boolean;
    private calculateKeyspaceStart;
    private calculateKeyspaceEnd;
}
/**
 * Create an arachnode instance for a strand
 */
export declare function createArachnodeStub(profile: NodeProfile, config?: Partial<ArachnodeConfig>): ArachnodeStub;
