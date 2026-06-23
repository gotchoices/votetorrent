import type { ClusterRecord, IKeyNetwork, RepoMessage, BlockId, MessageOptions, ClusterConsensusConfig } from "@optimystic/db-core";
import { ClusterClient } from "../cluster/client.js";
import type { PeerId } from "@libp2p/interface";
import type { FretService } from "p2p-fret";
import type { IPeerReputation } from "../reputation/types.js";
import type { ITransactionStateStore } from "../cluster/i-transaction-state-store.js";
/** Manages distributed transactions across clusters */
export declare class ClusterCoordinator {
    private readonly keyNetwork;
    private readonly createClusterClient;
    private readonly cfg;
    private readonly localCluster?;
    private readonly fretService?;
    private readonly reputation?;
    private readonly stateStore?;
    private transactions;
    private readonly retryInitialIntervalMs;
    private readonly retryBackoffFactor;
    private readonly retryMaxIntervalMs;
    private readonly retryMaxAttempts;
    private readonly commitBroadcastImmediateRetries;
    constructor(keyNetwork: IKeyNetwork, createClusterClient: (peerId: PeerId) => ClusterClient, cfg: ClusterConsensusConfig & {
        clusterSize: number;
    }, localCluster?: {
        update: (record: ClusterRecord) => Promise<ClusterRecord>;
        peerId: PeerId;
        wasTransactionExecuted?: (messageHash: string) => boolean;
    } | undefined, fretService?: FretService | undefined, reputation?: IPeerReputation | undefined, stateStore?: ITransactionStateStore | undefined);
    /**
     * Creates a base 58 BTC string hash for a message to uniquely identify a transaction
     */
    /** Deterministic JSON: sorts object keys so hash is order-independent */
    private static canonicalJson;
    private createMessageHash;
    /**
     * Gets all peers in the cluster for a specific block ID
     */
    private getClusterForBlock;
    private makeRecord;
    /**
     * Initiates a 2-phase transaction for a specific block ID.
     * Returns the cluster record and whether the local cluster already executed the operations.
     */
    executeClusterTransaction(blockId: BlockId, message: RepoMessage, _options?: MessageOptions): Promise<{
        record: ClusterRecord;
        localExecuted: boolean;
    }>;
    /**
     * Executes the full transaction process
     */
    private executeTransaction;
    getClusterSize(blockId: BlockId): Promise<number>;
    /**
     * Validate that a small cluster size is legitimate by querying remote peers
     * for their network size estimates. Returns true if estimates roughly agree.
     */
    private validateSmallCluster;
    /**
     * Collects promises from all peers in the cluster
     */
    private collectPromises;
    /**
     * Commits the transaction to all peers in the cluster
     */
    private commitTransaction;
    /**
     * Broadcast the merged commit record to every peer, with `commitBroadcastImmediateRetries`
     * in-line re-attempts per peer before giving up. The libp2p connection used during
     * the prior commit phase is typically still warm, so a single immediate retry recovers
     * most transient stream errors without falling back to the scheduled retry timer.
     * Local cluster is invoked exactly once — local failures are fatal, not transient.
     */
    private broadcastMergedRecord;
    private updateTransactionRecord;
    private scheduleCommitRetry;
    private retryCommits;
    private clearRetry;
    /** Fire-and-forget persist — errors are logged, never thrown. */
    private persistCoordinatorState;
    /** Fire-and-forget delete — errors are logged, never thrown. */
    private deleteCoordinatorState;
    /**
     * Recover coordinator transactions from persistent store after a restart.
     * Called during node startup, before accepting new requests.
     */
    recoverTransactions(): Promise<void>;
}
//# sourceMappingURL=cluster-coordinator.d.ts.map