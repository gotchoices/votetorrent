import type { ClusterRecord } from '@optimystic/db-core';
/** Evidence a validator collects during transaction re-execution */
export type ValidationEvidence = {
    /** Operations hash the validator computed */
    computedHash: string;
    /** Engine used for validation */
    engineId: string;
    /** Schema hash at time of validation */
    schemaHash: string;
    /** Snapshot of block states during validation */
    blockStateHashes: {
        [blockId: string]: {
            revision: number;
            contentHash: string;
        };
    };
};
/** A challenge initiated by an overridden minority peer */
export type DisputeChallenge = {
    /** Hash of (messageHash + challengerPeerId + timestamp) */
    disputeId: string;
    /** References the disputed ClusterRecord */
    originalMessageHash: string;
    /** Full record including all promises */
    originalRecord: ClusterRecord;
    /** Peer ID of the challenger */
    challengerPeerId: string;
    /** Challenger's validation evidence */
    challengerEvidence: ValidationEvidence;
    /** Challenger signs the dispute */
    signature: string;
    /** Timestamp of dispute creation */
    timestamp: number;
    /** TTL for arbitration (default: 2 × transaction TTL) */
    expiration: number;
};
/** An arbitrator's independent assessment */
export type ArbitrationVote = {
    /** Dispute being voted on */
    disputeId: string;
    /** Peer ID of the arbitrator */
    arbitratorPeerId: string;
    /** The arbitrator's verdict */
    vote: 'agree-with-challenger' | 'agree-with-majority' | 'inconclusive';
    /** Arbitrator's own re-execution results */
    evidence: ValidationEvidence;
    /** Arbitrator signs the vote */
    signature: string;
};
/** Final resolution of a dispute */
export type DisputeResolution = {
    /** Dispute being resolved */
    disputeId: string;
    /** Outcome of the dispute */
    outcome: 'challenger-wins' | 'majority-wins' | 'inconclusive';
    /** All votes collected */
    votes: ArbitrationVote[];
    /** Peers receiving reputation adjustments */
    affectedPeers: {
        peerId: string;
        reason: DisputePenaltyReason;
    }[];
    /** Timestamp of resolution */
    timestamp: number;
};
/** Dispute-specific penalty reasons (mapped to PenaltyReason for reputation) */
export type DisputePenaltyReason = 'false-approval' | 'dispute-lost';
/** Dispute protocol message types */
export type DisputeMessage = {
    type: 'challenge';
    challenge: DisputeChallenge;
} | {
    type: 'vote';
    vote: ArbitrationVote;
} | {
    type: 'resolution';
    resolution: DisputeResolution;
};
/** Dispute status for transaction queries */
export type DisputeStatus = 'committed-disputed' | 'committed-validated' | 'committed-invalidated';
/** Engine health state */
export type EngineHealthState = {
    /** Number of disputes lost in the tracking window */
    disputesLost: number;
    /** Timestamps of recent dispute losses */
    recentLosses: number[];
    /** Whether the engine is flagged as unhealthy */
    unhealthy: boolean;
    /** When the unhealthy flag was set */
    unhealthySince?: number;
};
/** Dispute configuration */
export interface DisputeConfig {
    /** Enable/disable dispute protocol */
    disputeEnabled: boolean;
    /** Timeout for arbitration in milliseconds (default: 60000) */
    disputeArbitrationTimeoutMs: number;
    /** Number of arbitrators to select (default: same as cluster size) */
    arbitratorCount?: number;
    /** Engine health: max disputes lost in window before marking unhealthy */
    engineHealthDisputeThreshold: number;
    /** Engine health: window in ms for counting disputes (default: 600000 = 10 min) */
    engineHealthWindowMs: number;
}
export declare const DEFAULT_DISPUTE_CONFIG: DisputeConfig;
//# sourceMappingURL=types.d.ts.map