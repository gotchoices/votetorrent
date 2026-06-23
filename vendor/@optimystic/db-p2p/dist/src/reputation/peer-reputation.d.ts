import { type IPeerReputation, type PeerReputationSummary, type ReputationConfig, PenaltyReason } from './types.js';
export declare class PeerReputationService implements IPeerReputation {
    private readonly peers;
    private readonly halfLifeMs;
    private readonly thresholds;
    private readonly weights;
    private readonly maxPenaltiesPerPeer;
    constructor(config?: ReputationConfig);
    reportPeer(peerId: string, reason: PenaltyReason, context?: string): void;
    recordSuccess(peerId: string): void;
    getScore(peerId: string): number;
    isBanned(peerId: string): boolean;
    isDeprioritized(peerId: string): boolean;
    getReputation(peerId: string): PeerReputationSummary;
    getAllReputations(): Map<string, PeerReputationSummary>;
    resetPeer(peerId: string): void;
    private getOrCreateRecord;
    private computeScore;
    private decayFactor;
    /** Remove penalties that have decayed below significance (< 1% of original weight) */
    private pruneRecord;
}
//# sourceMappingURL=peer-reputation.d.ts.map