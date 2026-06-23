import type { Startable, Libp2p } from '@libp2p/interface';
import type { FretService } from 'p2p-fret';
import type { PartitionDetector } from './partition-detector.js';
import type { ArachnodeFretAdapter, ArachnodeInfo } from '../storage/arachnode-fret-adapter.js';
export interface RebalanceEvent {
    /** Block IDs this node has gained responsibility for */
    gained: string[];
    /** Block IDs this node has lost responsibility for */
    lost: string[];
    /** Peers that are now closer for the lost blocks: blockId → peerId[] */
    newOwners: Map<string, string[]>;
    /** Timestamp of the topology change that triggered this */
    triggeredAt: number;
}
export interface RebalanceMonitorConfig {
    /** Debounce window for topology changes (ms). Default: 5000 */
    debounceMs?: number;
    /** Maximum frequency of full rebalance scans (ms). Default: 60000 */
    minRebalanceIntervalMs?: number;
    /** Whether to suppress rebalancing during detected partitions. Default: true */
    suppressDuringPartition?: boolean;
}
export interface RebalanceMonitorDeps {
    libp2p: Libp2p;
    fret: FretService;
    partitionDetector: PartitionDetector;
    fretAdapter: ArachnodeFretAdapter;
}
type RebalanceHandler = (event: RebalanceEvent) => void;
export declare class RebalanceMonitor implements Startable {
    private readonly deps;
    private running;
    private readonly trackedBlocks;
    private readonly responsibilitySnapshot;
    private readonly handlers;
    private debounceTimer;
    private lastRebalanceAt;
    private pendingTopologyChange;
    private topologyChangeTimestamp;
    private readonly debounceMs;
    private readonly minRebalanceIntervalMs;
    private readonly suppressDuringPartition;
    private readonly onConnectionOpen;
    private readonly onConnectionClose;
    constructor(deps: RebalanceMonitorDeps, config?: RebalanceMonitorConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    onRebalance(handler: RebalanceHandler): void;
    trackBlock(blockId: string): void;
    untrackBlock(blockId: string): void;
    getTrackedBlockCount(): number;
    checkNow(): Promise<RebalanceEvent | null>;
    private handleTopologyChange;
    private maybeRebalance;
    private performRebalanceCheck;
    private getCohortSize;
    private emitEvent;
    /**
     * Update ArachnodeInfo status through the fret adapter.
     */
    setStatus(status: ArachnodeInfo['status']): void;
}
export {};
//# sourceMappingURL=rebalance-monitor.d.ts.map