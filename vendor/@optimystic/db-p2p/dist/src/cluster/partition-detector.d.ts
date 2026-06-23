export interface PeerStatus {
    peerId: string;
    lastSeen: number;
    lastGoodbye?: number;
    consecutiveFailures: number;
}
/**
 * Detects potential network partitions by tracking peer health,
 * goodbye messages, and sudden mass unreachability events.
 */
export declare class PartitionDetector {
    private peerStatuses;
    private readonly unreachableThreshold;
    private readonly rapidChurnThreshold;
    private readonly rapidChurnWindow;
    private readonly peerTimeoutMs;
    /**
     * Record successful communication with a peer
     */
    recordSuccess(peerId: string): void;
    /**
     * Record failed communication attempt with a peer
     */
    recordFailure(peerId: string): void;
    /**
     * Record explicit goodbye message from a peer
     */
    recordGoodbye(peerId: string): void;
    /**
     * Detect if we're likely in a network partition
     * Returns true if sudden mass unreachability or rapid goodbye rate
     */
    detectPartition(): boolean;
    /**
     * Get list of currently unreachable peers
     */
    getUnreachablePeers(): string[];
    /**
     * Get recent goodbye messages within the specified window
     */
    private getRecentGoodbyes;
    /**
     * Clean up peer records that haven't been seen recently
     */
    private cleanupOldPeers;
    /**
     * Get statistics for monitoring
     */
    getStatistics(): {
        totalPeers: number;
        unreachable: number;
        recentGoodbyes: number;
    };
    /**
     * Reset all tracked peer states (useful for testing)
     */
    reset(): void;
}
//# sourceMappingURL=partition-detector.d.ts.map