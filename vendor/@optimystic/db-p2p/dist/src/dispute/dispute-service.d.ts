import type { ClusterRecord, ITransactionValidator } from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import type { ValidationEvidence, DisputeChallenge, ArbitrationVote, DisputeResolution, DisputeConfig, DisputeStatus } from './types.js';
import { EngineHealthMonitor } from './engine-health-monitor.js';
import type { IPeerReputation } from '../reputation/types.js';
import type { IPeerNetwork } from '@optimystic/db-core';
import type { DisputeClient } from './client.js';
/** Callback to create a DisputeClient for a given peer */
export type CreateDisputeClient = (peerId: PeerId) => DisputeClient;
/** Callback to re-execute a transaction and produce validation evidence */
export type RevalidateTransaction = (record: ClusterRecord) => Promise<ValidationEvidence | undefined>;
export interface DisputeServiceInit {
    peerId: PeerId;
    privateKey: PrivateKey;
    peerNetwork: IPeerNetwork;
    createDisputeClient: CreateDisputeClient;
    reputation?: IPeerReputation;
    validator?: ITransactionValidator;
    revalidate?: RevalidateTransaction;
    config?: Partial<DisputeConfig>;
    /** Select arbitrators for a dispute (next K peers beyond the original cluster) */
    selectArbitrators: (blockId: string, excludePeers: string[], count: number) => Promise<PeerId[]>;
}
/**
 * Manages the dispute escalation protocol.
 *
 * When a transaction proceeds despite minority rejections, the overridden
 * minority can escalate to independent arbitrators. The service coordinates
 * challenge initiation, arbitration vote collection, and resolution.
 */
export declare class DisputeService {
    private readonly peerId;
    private readonly privateKey;
    private readonly createDisputeClient;
    private readonly reputation?;
    private readonly revalidate?;
    private readonly config;
    private readonly engineHealth;
    private readonly selectArbitrators;
    /** Active disputes initiated by this node */
    private activeDisputes;
    /** Resolved disputes (disputeId -> resolution) */
    private resolvedDisputes;
    /** Challenges retained after resolution for status lookups */
    private resolvedChallenges;
    /** Track which transactions we've already disputed (prevent spam) */
    private disputedTransactions;
    constructor(init: DisputeServiceInit);
    /** Get the engine health monitor */
    getEngineHealth(): EngineHealthMonitor;
    /** Check if disputes are enabled */
    isEnabled(): boolean;
    /** Get the dispute status for a transaction, if any */
    getDisputeStatus(messageHash: string): DisputeStatus | undefined;
    /**
     * Initiate a dispute when this node's rejection was overridden.
     * Called by ClusterMember when it detects a disputed commit.
     */
    initiateDispute(record: ClusterRecord, evidence: ValidationEvidence): Promise<DisputeResolution | undefined>;
    /**
     * Handle an incoming dispute challenge (when this node is selected as arbitrator).
     * Re-executes the transaction and returns a vote.
     */
    handleChallenge(challenge: DisputeChallenge): Promise<ArbitrationVote>;
    /**
     * Handle an incoming dispute resolution (broadcast from the dispute initiator).
     */
    handleResolution(resolution: DisputeResolution): void;
    /** Collect votes from arbitrators with a timeout */
    private collectVotes;
    /** Determine dispute resolution from collected votes */
    resolveDispute(challenge: DisputeChallenge, votes: ArbitrationVote[]): DisputeResolution;
    /** Apply reputation effects based on dispute resolution */
    private applyReputationEffects;
    /** Broadcast resolution to all interested parties */
    private broadcastResolution;
    private makeVote;
    private computeDisputeId;
    private signDispute;
    private verifyDisputeSignature;
    private findChallengeForDispute;
}
//# sourceMappingURL=dispute-service.d.ts.map