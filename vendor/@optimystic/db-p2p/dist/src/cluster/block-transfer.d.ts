import type { IRepo, IPeerNetwork } from '@optimystic/db-core';
import type { PartitionDetector } from './partition-detector.js';
import type { RestorationCoordinator } from '../storage/restoration-coordinator-v2.js';
import type { RebalanceEvent } from './rebalance-monitor.js';
export interface BlockTransferConfig {
    /** Max concurrent transfers. Default: 4 */
    maxConcurrency?: number;
    /** Timeout per block transfer (ms). Default: 30000 */
    transferTimeoutMs?: number;
    /** Retry attempts for failed transfers. Default: 2 */
    maxRetries?: number;
    /** Whether to push blocks to new owners proactively. Default: true */
    enablePush?: boolean;
}
/**
 * Coordinates block transfers in response to rebalance events.
 *
 * For gained blocks: delegates to RestorationCoordinator.restore() which
 * already handles ring-based discovery and fetching.
 *
 * For lost blocks: proactively pushes block data to new responsible peers
 * via the BlockTransfer protocol.
 */
export declare class BlockTransferCoordinator {
    private readonly repo;
    private readonly peerNetwork;
    private readonly restorationCoordinator;
    private readonly partitionDetector;
    private readonly protocolPrefix;
    private readonly maxConcurrency;
    private readonly transferTimeoutMs;
    private readonly maxRetries;
    private readonly enablePush;
    private inFlight;
    private concurrency;
    private readonly waitQueue;
    constructor(repo: IRepo, peerNetwork: IPeerNetwork, restorationCoordinator: RestorationCoordinator, partitionDetector: PartitionDetector, protocolPrefix?: string, config?: BlockTransferConfig);
    /**
     * Pull blocks that this node has gained responsibility for.
     * Uses RestorationCoordinator to discover holders and fetch block data.
     */
    pullBlocks(blockIds: string[]): Promise<{
        succeeded: string[];
        failed: string[];
    }>;
    /**
     * Push blocks that this node has lost responsibility for to new owners.
     */
    pushBlocks(blockIds: string[], newOwners: Map<string, string[]>): Promise<{
        succeeded: string[];
        failed: string[];
    }>;
    /**
     * Handle a complete rebalance event — pull gained, push lost.
     */
    handleRebalanceEvent(event: RebalanceEvent): Promise<void>;
    private executePull;
    private executePush;
    private acquireSemaphore;
    private releaseSemaphore;
    private backoffMs;
    private delay;
    private withTimeout;
}
//# sourceMappingURL=block-transfer.d.ts.map