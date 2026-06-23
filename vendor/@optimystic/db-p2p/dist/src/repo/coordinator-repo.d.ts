import type { PendRequest, ActionBlocks, IRepo, MessageOptions, CommitResult, GetBlockResults, PendResult, BlockGets, CommitRequest, IKeyNetwork, ICluster, ClusterConsensusConfig, BlockId, ActionRev, ActionContext } from "@optimystic/db-core";
import type { ClusterClient } from "../cluster/client.js";
import type { PeerId } from "@libp2p/interface";
import type { FretService } from "p2p-fret";
import type { IPeerReputation } from "../reputation/types.js";
import type { ITransactionStateStore } from "../cluster/i-transaction-state-store.js";
/**
 * Extended cluster interface that includes the ability to check if a transaction was executed.
 * This is used by CoordinatorRepo to avoid duplicate execution.
 */
interface LocalClusterWithExecutionTracking extends ICluster {
    wasTransactionExecuted?(messageHash: string): boolean;
}
/**
 * Callback to query a cluster peer for their latest revision of a block.
 * Returns the peer's latest ActionRev if they have the block, undefined otherwise.
 */
export type ClusterLatestCallback = (peerId: PeerId, blockId: BlockId, context?: ActionContext) => Promise<ActionRev | undefined>;
interface CoordinatorRepoComponents {
    storageRepo: IRepo;
    localCluster?: LocalClusterWithExecutionTracking;
    localPeerId?: PeerId;
    /**
     * Optional callback to query cluster peers for their latest block revision.
     * Used for read-path cluster verification to discover unknown revisions.
     */
    clusterLatestCallback?: ClusterLatestCallback;
}
export declare function coordinatorRepo(keyNetwork: IKeyNetwork, createClusterClient: (peerId: PeerId) => ClusterClient, cfg?: Partial<ClusterConsensusConfig> & {
    clusterSize?: number;
}, fretService?: FretService, reputation?: IPeerReputation, stateStore?: ITransactionStateStore): (components: CoordinatorRepoComponents) => CoordinatorRepo;
/** Cluster coordination repo - uses local store, as well as distributes changes to other nodes using cluster consensus. */
export declare class CoordinatorRepo implements IRepo {
    readonly keyNetwork: IKeyNetwork;
    readonly createClusterClient: (peerId: PeerId) => ClusterClient;
    private readonly storageRepo;
    private readonly clusterLatestCallback?;
    private coordinator;
    private readonly DEFAULT_TIMEOUT;
    private readonly localPeerId?;
    private readonly responsibilityCache;
    private static readonly RESPONSIBILITY_TTL_MS;
    private readonly lastSeenCommitMs;
    private readonly readRepairMode;
    private readonly readRepairWindowMs;
    private readonly readRepairSampleRate;
    /** Test seam: overridable clock for window-based read-repair gating. */
    now: () => number;
    /** Test seam: overridable RNG (0..1) for sample-rate gating. */
    rand: () => number;
    constructor(keyNetwork: IKeyNetwork, createClusterClient: (peerId: PeerId) => ClusterClient, storageRepo: IRepo, cfg?: Partial<ClusterConsensusConfig> & {
        clusterSize?: number;
    }, localCluster?: LocalClusterWithExecutionTracking, localPeerId?: PeerId, fretService?: FretService, clusterLatestCallback?: ClusterLatestCallback | undefined, reputation?: IPeerReputation, stateStore?: ITransactionStateStore);
    /** Recover coordinator transactions from persistent store after a restart. */
    recoverTransactions(): Promise<void>;
    /**
     * Check if this node is in the cluster for a given block.
     * Uses findCluster membership — in the real network layer, self is always
     * included in the cohort when this node is responsible. This serves as a
     * defense-in-depth guard for requests that arrive at the wrong node.
     * Returns true if localPeerId is not set (backward compat for single-node/test setups).
     */
    private isResponsibleForBlock;
    /**
     * Verify this node is responsible for all given block IDs. Throws if not.
     */
    private verifyResponsibility;
    get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults>;
    /** Decide whether the read-repair policy wants us to consult the cluster for a present-but-possibly-stale block. */
    private shouldReadRepair;
    /** Milliseconds since we last marked this block fresh, or undefined if never. */
    private ageMs;
    /** Mark blocks as freshly observed from cluster authority (post-commit or post-fetch). */
    private markBlocksSeen;
    /**
     * Test seam: directly set the last-seen timestamp for a block. Used by read-repair
     * specs to simulate "the local commit happened at time T" without needing to drive
     * a full pend/commit cycle through the cluster coordinator.
     */
    setLastSeenForTest(blockId: BlockId, ts: number): void;
    private fetchBlockFromCluster;
    /**
     * Query cluster peers to find the maximum latest revision for a block.
     */
    private queryClusterForLatest;
    pend(request: PendRequest, options?: MessageOptions): Promise<PendResult>;
    cancel(actionRef: ActionBlocks, options?: MessageOptions): Promise<void>;
    commit(request: CommitRequest, options?: MessageOptions): Promise<CommitResult>;
}
export {};
//# sourceMappingURL=coordinator-repo.d.ts.map