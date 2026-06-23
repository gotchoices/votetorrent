import type { AbortOptions, Libp2p, PeerId, Stream } from "@libp2p/interface";
import type { ClusterPeers, FindCoordinatorOptions, IKeyNetwork, IPeerNetwork } from "@optimystic/db-core";
import type { SerializedTable } from 'p2p-fret';
import type { IPeerReputation } from './reputation/types.js';
export type NetworkMode = 'forming' | 'joining';
/**
 * Error codes surfaced by {@link Libp2pKeyPeerNetwork.findCoordinator}. Callers
 * (notably the batch-retry logic in `NetworkTransactor`) can inspect `.code`
 * to distinguish between "transient — try again with different excludes" and
 * "terminal — stop retrying".
 */
export declare const FIND_COORDINATOR_ERROR_CODES: {
    /**
     * Last-resort self-coordination was blocked by the self-coordination guard
     * (e.g. partition detected, suspicious shrinkage). Retrying is unlikely to help.
     */
    readonly SELF_COORDINATION_BLOCKED: "SELF_COORDINATION_BLOCKED";
    /**
     * Self-coordination was already attempted and self is now excluded. On a solo
     * or bootstrap node with no other peers, this means retries are exhausted and
     * the original error from the prior attempt should be surfaced instead.
     */
    readonly SELF_COORDINATION_EXHAUSTED: "SELF_COORDINATION_EXHAUSTED";
    /** No peer (including self) is an eligible coordinator. */
    readonly NO_COORDINATOR_AVAILABLE: "NO_COORDINATOR_AVAILABLE";
};
export type FindCoordinatorErrorCode = typeof FIND_COORDINATOR_ERROR_CODES[keyof typeof FIND_COORDINATOR_ERROR_CODES];
export declare class FindCoordinatorError extends Error {
    readonly code: FindCoordinatorErrorCode;
    constructor(code: FindCoordinatorErrorCode, message: string);
}
export interface PersistedNetworkState {
    version: 1;
    networkHighWaterMark: number;
    lastConnectedTimestamp: number;
    consecutiveIsolatedSessions: number;
    fretTable?: SerializedTable;
}
export interface NetworkStatePersistence {
    load(): Promise<PersistedNetworkState | undefined>;
    save(state: PersistedNetworkState): Promise<void>;
}
/**
 * Configuration options for self-coordination behavior
 */
export interface SelfCoordinationConfig {
    /** Time (ms) after last connection before allowing self-coordination. Default: 30000 */
    gracePeriodMs?: number;
    /** Threshold for suspicious network shrinkage (0-1). >50% drop is suspicious. Default: 0.5 */
    shrinkageThreshold?: number;
    /** Allow self-coordination at all. Default: true (for testing). Set false in production. */
    allowSelfCoordination?: boolean;
}
/**
 * Decision result from self-coordination guard
 */
export interface SelfCoordinationDecision {
    allow: boolean;
    reason: 'bootstrap-node' | 'partition-detected' | 'suspicious-shrinkage' | 'grace-period-not-elapsed' | 'extended-isolation' | 'hwm-decay' | 'disabled';
    warn?: boolean;
}
export declare class Libp2pKeyPeerNetwork implements IKeyNetwork, IPeerNetwork {
    private readonly libp2p;
    private readonly clusterSize;
    private readonly reputation?;
    private readonly selfCoordinationConfig;
    private networkHighWaterMark;
    private lastConnectedTime;
    private consecutiveIsolatedSessions;
    private readonly networkMode;
    private readonly persistence?;
    constructor(libp2p: Libp2p, clusterSize?: number, selfCoordinationConfig?: SelfCoordinationConfig, networkMode?: NetworkMode, persistence?: NetworkStatePersistence, reputation?: IPeerReputation | undefined);
    private readonly coordinatorCache;
    private static readonly MAX_CACHE_ENTRIES;
    private readonly log;
    private toCacheKey;
    /**
     * Set up connection event tracking to update high water mark and last connected time.
     */
    private setupConnectionTracking;
    /**
     * Update network high water mark and last connected time.
     * Called on new connections.
     */
    private updateNetworkObservations;
    initFromPersistedState(): Promise<void>;
    private canRetryImprove;
    private persistState;
    /**
     * Determine if self-coordination should be allowed based on network observations.
     *
     * Principle: If we've ever seen a larger network, assume our connectivity is the problem,
     * not the network shrinking.
     */
    shouldAllowSelfCoordination(): SelfCoordinationDecision;
    recordCoordinator(key: Uint8Array, peerId: PeerId, ttlMs?: number): void;
    private getCachedCoordinator;
    connect(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream>;
    private getFret;
    private getNeighborIdsForKey;
    findCoordinator(key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId>;
    private getConnectedAddrsByPeer;
    private parseMultiaddrs;
    findCluster(key: Uint8Array): Promise<ClusterPeers>;
}
//# sourceMappingURL=libp2p-key-network.d.ts.map