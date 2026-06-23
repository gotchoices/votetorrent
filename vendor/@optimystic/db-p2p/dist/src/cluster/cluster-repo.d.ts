import type { IRepo, ClusterRecord, ITransactionValidator, ClusterConsensusConfig } from "@optimystic/db-core";
import type { ICluster } from "@optimystic/db-core";
import type { IPeerNetwork } from "@optimystic/db-core";
import type { PeerId, PrivateKey } from "@libp2p/interface";
import type { PartitionDetector } from "./partition-detector.js";
import type { FretService } from "p2p-fret";
import type { IPeerReputation } from "../reputation/types.js";
import type { ITransactionStateStore } from "./i-transaction-state-store.js";
interface ClusterMemberComponents {
    storageRepo: IRepo;
    peerNetwork: IPeerNetwork;
    peerId: PeerId;
    privateKey: PrivateKey;
    protocolPrefix?: string;
    partitionDetector?: PartitionDetector;
    fretService?: FretService;
    validator?: ITransactionValidator;
    reputation?: IPeerReputation;
    consensusConfig?: ClusterConsensusConfig;
    stateStore?: ITransactionStateStore;
}
export declare function clusterMember(components: ClusterMemberComponents): ClusterMember;
/**
 * Handles cluster-side operations, managing promises and commits for cluster updates
 * and coordinating with the local storage repo.
 */
export declare class ClusterMember implements ICluster {
    private readonly storageRepo;
    private readonly peerNetwork;
    private readonly peerId;
    private readonly privateKey;
    private readonly protocolPrefix?;
    private readonly fretService?;
    private readonly validator?;
    private readonly reputation?;
    private readonly stateStore?;
    private activeTransactions;
    private executedTransactions;
    private cleanupQueue;
    private pendingUpdates;
    private currentValidationRecord?;
    private readonly expirationInterval;
    private readonly cleanupInterval;
    /** Effective super-majority threshold. Defaults to 1.0 (unanimity) for backward compatibility. */
    private readonly superMajorityThreshold;
    constructor(storageRepo: IRepo, peerNetwork: IPeerNetwork, peerId: PeerId, privateKey: PrivateKey, protocolPrefix?: string | undefined, _partitionDetector?: PartitionDetector, fretService?: FretService | undefined, validator?: ITransactionValidator | undefined, reputation?: IPeerReputation | undefined, consensusConfig?: ClusterConsensusConfig, stateStore?: ITransactionStateStore | undefined);
    /**
     * Clears all interval and timeout handles and empties active state.
     * Called during node shutdown to prevent leaked timers.
     */
    dispose(): void;
    /**
     * Checks if a transaction's operations were already executed during consensus.
     * Used by the coordinator to avoid duplicate execution in CoordinatorRepo.
     */
    wasTransactionExecuted(messageHash: string): boolean;
    /**
     * Handles an incoming cluster update, managing the two-phase commit process
     * and coordinating with the local storage repo
     */
    update(record: ClusterRecord): Promise<ClusterRecord>;
    private processUpdate;
    /**
     * Merges two records, validating that non-signature fields match.
     * Detects equivocation (same peer changing vote type) and applies penalties.
     */
    private mergeRecords;
    /**
     * Compares existing vs incoming signatures for the same peers.
     * If a peer's vote type changed (approve↔reject), that's equivocation:
     * report a penalty and keep the first-seen signature.
     * New peers are accepted normally.
     */
    private detectEquivocation;
    private validateRecord;
    /**
     * Compute message hash using the same algorithm as the coordinator.
     * Must match cluster-coordinator.ts createMessageHash().
     */
    private computeMessageHash;
    private validateSignatures;
    /** Deterministic JSON: sorts object keys so hash is order-independent */
    private static canonicalJson;
    private computePromiseHash;
    private computeCommitHash;
    private computeSigningPayload;
    private signVote;
    private verifySignature;
    private getTransactionPhase;
    private hasMajority;
    private handlePromiseNeeded;
    /**
     * Validates pend operations in a cluster record using the transaction validator.
     * Also checks for stale revisions to prevent consensus on operations that would fail.
     * Returns success if no validator is configured (backwards compatibility).
     */
    private validatePendOperations;
    private handleCommitNeeded;
    /**
     * Executes operations after consensus is reached.
     *
     * @warning This method executes on ALL cluster peers, not just the coordinator.
     * Each peer independently applies the operations to its local storage.
     *
     * @pitfall **Check-then-act race** - Must check AND mark as executed atomically
     * (before any `await`) to prevent duplicate execution. JavaScript's single-threaded
     * nature makes synchronous check-and-set atomic.
     *
     * @pitfall **Independent node storage** - Each node has its own storage. After consensus,
     * each node applies operations locally. Nodes must fetch missing blocks from cluster
     * peers via `restoreCallback` if they don't have prior revisions.
     *
     * @see docs/internals.md "Check-Then-Act Race in Consensus" and "Independent Node Storage" pitfalls
     */
    private handleConsensus;
    private handleRejection;
    private setupTimeouts;
    private hasConflict;
    /**
     * Resolve race between two conflicting transactions.
     * Transaction with more promises wins. If tied, higher hash wins.
     */
    private resolveRace;
    private operationsConflict;
    private getActionId;
    private getAffectedBlockIds;
    private propagateIfNeeded;
    private handleExpiration;
    private resolveWithPeers;
    private queueExpiredTransactions;
    private processCleanupQueue;
    private hasLocalCommit;
    private clearTransaction;
    /** Fire-and-forget persist — errors are logged, never thrown. */
    private persistParticipantState;
    /**
     * Recover member transactions from persistent store after a restart.
     * Called during node startup, before accepting new requests.
     */
    recoverTransactions(): Promise<void>;
    /**
     * Checks if a transaction's operations were already executed during consensus.
     * Falls back to the persistent store when the in-memory map misses.
     */
    wasTransactionExecutedAsync(messageHash: string): Promise<boolean>;
}
export {};
//# sourceMappingURL=cluster-repo.d.ts.map