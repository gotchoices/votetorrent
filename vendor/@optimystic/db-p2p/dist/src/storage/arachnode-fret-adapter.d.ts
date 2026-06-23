import type { FretService } from 'p2p-fret';
/**
 * Arachnode ring membership information.
 * Stored in FRET's generic metadata field.
 */
export interface ArachnodeInfo {
    /** Ring depth: 0 = full keyspace, N = 2^N partitions */
    ringDepth: number;
    /** Partition this node covers (undefined if ringDepth = 0) */
    partition?: {
        prefixBits: number;
        prefixValue: number;
    };
    /** Storage capacity in bytes */
    capacity: {
        total: number;
        used: number;
        available: number;
    };
    /** Ring membership status */
    status: 'joining' | 'active' | 'moving' | 'leaving';
}
/**
 * Adapter that provides Arachnode-specific methods on top of FRET's generic metadata.
 *
 * FRET remains a pure DHT, while this adapter layers Arachnode semantics.
 */
export declare class ArachnodeFretAdapter {
    private readonly fret;
    private static readonly ARACHNODE_KEY;
    constructor(fret: FretService);
    /**
     * Set this node's Arachnode ring membership.
     */
    setArachnodeInfo(info: ArachnodeInfo): void;
    /**
     * Get Arachnode info for a specific peer.
     */
    getArachnodeInfo(peerId: string): ArachnodeInfo | undefined;
    /**
     * Get my own Arachnode info.
     */
    getMyArachnodeInfo(): ArachnodeInfo | undefined;
    /**
     * Find all peers at a specific ring depth.
     */
    findPeersAtRing(ringDepth: number): string[];
    /**
     * Find all known storage rings (unique ring depths).
     */
    getKnownRings(): number[];
    /**
     * Get statistics about discovered rings.
     */
    getRingStats(): Array<{
        ringDepth: number;
        peerCount: number;
        avgCapacity: number;
    }>;
    /**
     * Update the status field of this node's ArachnodeInfo.
     * No-op if no ArachnodeInfo has been set yet.
     */
    setStatus(status: ArachnodeInfo['status']): void;
    /**
     * Access the underlying FRET service.
     */
    getFret(): FretService;
}
//# sourceMappingURL=arachnode-fret-adapter.d.ts.map