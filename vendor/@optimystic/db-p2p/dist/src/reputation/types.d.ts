/** Categories of peer misbehavior with associated severity */
export declare enum PenaltyReason {
    /** Peer sent a signature that failed cryptographic verification */
    InvalidSignature = "invalid-signature",
    /** Peer promised conflicting transactions (equivocation) */
    Equivocation = "equivocation",
    /** Peer's validation logic rejected a valid transaction (repeated false rejections) */
    FalseRejection = "false-rejection",
    /** Peer failed to respond within timeout during consensus */
    ConsensusTimeout = "consensus-timeout",
    /** Peer sent a message with mismatched hash */
    InvalidMessageHash = "invalid-message-hash",
    /** Peer sent an expired transaction */
    ExpiredTransaction = "expired-transaction",
    /** Generic protocol violation */
    ProtocolViolation = "protocol-violation",
    /** Connection-level failures (lighter weight) */
    ConnectionFailure = "connection-failure",
    /** Majority peer approved a transaction that was later found invalid via dispute */
    FalseApproval = "false-approval",
    /** Challenger lost a dispute (their rejection was wrong) */
    DisputeLost = "dispute-lost"
}
/** Default penalty weights by reason */
export declare const DEFAULT_PENALTY_WEIGHTS: Record<PenaltyReason, number>;
/** Thresholds controlling graduated reputation responses */
export interface ReputationThresholds {
    /** Score above which peer is deprioritized in coordinator selection. Default: 20 */
    deprioritize: number;
    /** Score above which peer is excluded from cluster operations. Default: 80 */
    ban: number;
}
export declare const DEFAULT_THRESHOLDS: ReputationThresholds;
/** Configuration for the reputation service */
export interface ReputationConfig {
    /** Half-life for exponential decay of penalties (ms). Default: 30 minutes */
    halfLifeMs?: number;
    /** Thresholds for deprioritize/ban. Uses DEFAULT_THRESHOLDS if not provided */
    thresholds?: Partial<ReputationThresholds>;
    /** Custom penalty weights. Merged with DEFAULT_PENALTY_WEIGHTS */
    weights?: Partial<Record<PenaltyReason, number>>;
    /** Maximum penalty records per peer before pruning. Default: 100 */
    maxPenaltiesPerPeer?: number;
}
/** A single recorded penalty event */
export interface PenaltyRecord {
    reason: PenaltyReason;
    weight: number;
    timestamp: number;
    context?: string;
}
/** Internal record for a tracked peer */
export interface PeerRecord {
    penalties: PenaltyRecord[];
    successCount: number;
    lastSuccess: number;
    lastPenalty: number;
}
/** Summary of a peer's reputation for diagnostics */
export interface PeerReputationSummary {
    peerId: string;
    effectiveScore: number;
    isBanned: boolean;
    isDeprioritized: boolean;
    penaltyCount: number;
    successCount: number;
    lastPenalty: number;
    lastSuccess: number;
}
/** Interface for reputation scoring consumed by other components */
export interface IPeerReputation {
    /** Record a misbehavior incident */
    reportPeer(peerId: string, reason: PenaltyReason, context?: string): void;
    /** Record successful interaction */
    recordSuccess(peerId: string): void;
    /** Get effective score for a peer (0 = clean) */
    getScore(peerId: string): number;
    /** Check if peer should be excluded from operations */
    isBanned(peerId: string): boolean;
    /** Check if peer should be deprioritized */
    isDeprioritized(peerId: string): boolean;
    /** Get summary for diagnostics */
    getReputation(peerId: string): PeerReputationSummary;
    /** Get all tracked peers and their statuses */
    getAllReputations(): Map<string, PeerReputationSummary>;
    /** Reset a peer's reputation (admin/testing) */
    resetPeer(peerId: string): void;
}
//# sourceMappingURL=types.d.ts.map