import type { Startable, Logger, PeerId, Libp2p } from '@libp2p/interface';
import type { IPeerReputation } from '../reputation/types.js';
import { PenaltyReason } from '../reputation/types.js';
import { RebalanceMonitor, type RebalanceMonitorConfig } from '../cluster/rebalance-monitor.js';
import { SpreadOnChurnMonitor, type SpreadOnChurnConfig, type SpreadOnChurnDeps } from '../cluster/spread-on-churn.js';
import type { PartitionDetector } from '../cluster/partition-detector.js';
import type { ArachnodeFretAdapter } from '../storage/arachnode-fret-adapter.js';
export type NetworkManagerServiceInit = {
    clusterSize?: number;
    seedKeys?: Uint8Array[];
    estimation?: {
        samples: number;
        kth: number;
        timeoutMs: number;
        ttlMs: number;
    };
    readiness?: {
        minPeers: number;
        maxWaitMs: number;
    };
    cacheTTLs?: {
        coordinatorMs: number;
        clusterMs: number;
    };
    expectedRemotes?: boolean;
    allowClusterDownsize?: boolean;
    clusterSizeTolerance?: number;
};
type Components = {
    logger: {
        forComponent: (name: string) => Logger;
    };
    registrar: {
        handle: (...args: any[]) => Promise<void>;
        unhandle: (...args: any[]) => Promise<void>;
    };
    libp2p?: Libp2p;
};
export declare class NetworkManagerService implements Startable {
    private readonly components;
    private running;
    private readonly log;
    private readonly cfg;
    private readyPromise;
    private readonly coordinatorCache;
    private readonly clusterCache;
    private lastEstimate;
    private reputation?;
    private libp2pRef;
    private rebalanceMonitor?;
    private spreadOnChurnMonitor?;
    constructor(components: Components, init?: NetworkManagerServiceInit);
    setLibp2p(libp2p: Libp2p): void;
    setReputation(reputation: IPeerReputation): void;
    /**
     * Initialize the rebalance monitor. Call after libp2p, FRET, and adapter are available.
     */
    initRebalanceMonitor(partitionDetector: PartitionDetector, fretAdapter: ArachnodeFretAdapter, config?: RebalanceMonitorConfig): RebalanceMonitor;
    getRebalanceMonitor(): RebalanceMonitor | undefined;
    /**
     * Initialize the spread-on-churn monitor. Call after libp2p, FRET are available.
     * Caller provides repo and peerNetwork (not held by NetworkManagerService directly).
     */
    initSpreadOnChurnMonitor(partitionDetector: PartitionDetector, repo: SpreadOnChurnDeps['repo'], peerNetwork: SpreadOnChurnDeps['peerNetwork'], clusterSize: number, config?: Partial<SpreadOnChurnConfig>): SpreadOnChurnMonitor;
    getSpreadOnChurnMonitor(): SpreadOnChurnMonitor | undefined;
    private getLibp2p;
    private getFret;
    get [Symbol.toStringTag](): string;
    start(): Promise<void>;
    stop(): Promise<void>;
    ready(): Promise<void>;
    private seedKey;
    private toCacheKey;
    private getKnownPeers;
    getStatus(): {
        mode: 'alone' | 'healthy' | 'degraded';
        connections: number;
    };
    awaitHealthy(minRemotes: number, timeoutMs: number): Promise<boolean>;
    /**
     * Record a misbehaving peer. Delegates to IPeerReputation if available.
     */
    reportBadPeer(peerId: PeerId, reason?: PenaltyReason): void;
    private isBlacklisted;
    recordCoordinator(key: Uint8Array, peerId: PeerId): void;
    /**
     * Find the nearest peer to the provided content key using FRET,
     * falling back to self if FRET is unavailable.
     */
    private findNearestPeerToKey;
    /**
     * Compute cluster using FRET's assembleCohort for content-addressed peer selection.
     */
    getCluster(key: Uint8Array): Promise<PeerId[]>;
    getCoordinator(key: Uint8Array): Promise<PeerId>;
    private xor;
    private lexLess;
}
export declare function networkManagerService(init?: NetworkManagerServiceInit): (components: Components) => NetworkManagerService;
export {};
//# sourceMappingURL=network-manager-service.d.ts.map