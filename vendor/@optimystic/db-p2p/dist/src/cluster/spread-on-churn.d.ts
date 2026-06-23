import type { Startable, Libp2p } from '@libp2p/interface';
import type { IRepo, IPeerNetwork } from '@optimystic/db-core';
import type { FretService } from 'p2p-fret';
import type { PartitionDetector } from './partition-detector.js';
export interface SpreadOnChurnConfig {
    /** Enable the churn-resilient spread protocol. Default: true */
    enabled: boolean;
    /** Number of middle-closest peers eligible to spread (d). Default: 3 */
    spreadDistance: number;
    /** Enable dynamic d scaling based on cluster health. Default: true */
    dynamicSpreadDistance: boolean;
    /** Cluster size ratio below which spread becomes more aggressive. Default: 0.6 */
    healthThreshold: number;
    /** Debounce window for departure detection (ms). Default: 5000 */
    departureDebounceMs: number;
    /** Number of peers beyond cluster boundary to target. Default: 4 */
    expansionStep: number;
}
export interface SpreadOnChurnDeps {
    libp2p: Libp2p;
    fret: FretService;
    partitionDetector: PartitionDetector;
    repo: IRepo;
    peerNetwork: IPeerNetwork;
    clusterSize: number;
    protocolPrefix?: string;
}
export interface SpreadEvent {
    /** Blocks that were spread */
    spread: Array<{
        blockId: string;
        targets: string[];
        succeeded: string[];
        failed: string[];
    }>;
    /** Current effective d */
    effectiveD: number;
    /** Timestamp of the departure that triggered this */
    triggeredAt: number;
}
type SpreadHandler = (event: SpreadEvent) => void;
export declare class SpreadOnChurnMonitor implements Startable {
    private readonly deps;
    private running;
    private readonly trackedBlocks;
    private readonly handlers;
    private debounceTimer;
    private departureTimestamps;
    private departureTimestamp;
    private readonly config;
    private readonly onConnectionClose;
    constructor(deps: SpreadOnChurnDeps, config?: Partial<SpreadOnChurnConfig>);
    start(): Promise<void>;
    stop(): Promise<void>;
    onSpread(handler: SpreadHandler): void;
    trackBlock(blockId: string): void;
    untrackBlock(blockId: string): void;
    getTrackedBlockCount(): number;
    /** Force an immediate spread check (useful for testing). */
    checkNow(): Promise<SpreadEvent | null>;
    private handleDeparture;
    private performSpread;
    private computeEffectiveD;
    private emitEvent;
}
export {};
//# sourceMappingURL=spread-on-churn.d.ts.map