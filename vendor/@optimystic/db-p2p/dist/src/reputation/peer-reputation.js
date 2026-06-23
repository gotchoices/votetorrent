import { DEFAULT_PENALTY_WEIGHTS, DEFAULT_THRESHOLDS, } from './types.js';
import { createLogger } from '../logger.js';
const log = createLogger('peer-reputation');
export class PeerReputationService {
    peers = new Map();
    halfLifeMs;
    thresholds;
    weights;
    maxPenaltiesPerPeer;
    constructor(config) {
        this.halfLifeMs = config?.halfLifeMs ?? 30 * 60_000;
        this.thresholds = {
            ...DEFAULT_THRESHOLDS,
            ...config?.thresholds,
        };
        this.weights = {
            ...DEFAULT_PENALTY_WEIGHTS,
            ...config?.weights,
        };
        this.maxPenaltiesPerPeer = config?.maxPenaltiesPerPeer ?? 100;
    }
    reportPeer(peerId, reason, context) {
        const record = this.getOrCreateRecord(peerId);
        const weight = this.weights[reason];
        const penalty = {
            reason,
            weight,
            timestamp: Date.now(),
            context,
        };
        record.penalties.push(penalty);
        record.lastPenalty = penalty.timestamp;
        this.pruneRecord(record);
        const score = this.computeScore(record);
        log('report peerId=%s reason=%s weight=%d score=%d context=%s', peerId.substring(0, 12), reason, weight, Math.round(score), context ?? '');
    }
    recordSuccess(peerId) {
        const record = this.getOrCreateRecord(peerId);
        record.successCount++;
        record.lastSuccess = Date.now();
    }
    getScore(peerId) {
        const record = this.peers.get(peerId);
        if (!record)
            return 0;
        return this.computeScore(record);
    }
    isBanned(peerId) {
        return this.getScore(peerId) >= this.thresholds.ban;
    }
    isDeprioritized(peerId) {
        return this.getScore(peerId) >= this.thresholds.deprioritize;
    }
    getReputation(peerId) {
        const score = this.getScore(peerId);
        const record = this.peers.get(peerId);
        return {
            peerId,
            effectiveScore: score,
            isBanned: score >= this.thresholds.ban,
            isDeprioritized: score >= this.thresholds.deprioritize,
            penaltyCount: record?.penalties.length ?? 0,
            successCount: record?.successCount ?? 0,
            lastPenalty: record?.lastPenalty ?? 0,
            lastSuccess: record?.lastSuccess ?? 0,
        };
    }
    getAllReputations() {
        const result = new Map();
        for (const peerId of this.peers.keys()) {
            result.set(peerId, this.getReputation(peerId));
        }
        return result;
    }
    resetPeer(peerId) {
        this.peers.delete(peerId);
        log('reset peerId=%s', peerId.substring(0, 12));
    }
    getOrCreateRecord(peerId) {
        let record = this.peers.get(peerId);
        if (!record) {
            record = {
                penalties: [],
                successCount: 0,
                lastSuccess: 0,
                lastPenalty: 0,
            };
            this.peers.set(peerId, record);
        }
        return record;
    }
    computeScore(record) {
        const now = Date.now();
        let score = 0;
        for (const penalty of record.penalties) {
            score += penalty.weight * this.decayFactor(now, penalty.timestamp);
        }
        return score;
    }
    decayFactor(now, timestamp) {
        const elapsed = now - timestamp;
        if (elapsed <= 0)
            return 1;
        return Math.pow(0.5, elapsed / this.halfLifeMs);
    }
    /** Remove penalties that have decayed below significance (< 1% of original weight) */
    pruneRecord(record) {
        const now = Date.now();
        const cutoff = this.halfLifeMs * 7; // 2^-7 ≈ 0.8% — below significance
        record.penalties = record.penalties.filter(p => (now - p.timestamp) < cutoff);
        // Hard cap to prevent unbounded growth
        if (record.penalties.length > this.maxPenaltiesPerPeer) {
            record.penalties = record.penalties.slice(-this.maxPenaltiesPerPeer);
        }
        // Remove peer records with no significant penalties
        if (record.penalties.length === 0 && record.successCount === 0) {
            // Don't remove — the caller may still be using this record
        }
    }
}
//# sourceMappingURL=peer-reputation.js.map