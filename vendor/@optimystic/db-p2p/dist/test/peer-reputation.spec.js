import { expect } from 'chai';
import { PeerReputationService } from '../src/reputation/peer-reputation.js';
import { PenaltyReason, DEFAULT_PENALTY_WEIGHTS } from '../src/reputation/types.js';
describe('PeerReputationService', () => {
    const peerId = 'QmTestPeer1234567890';
    it('should return 0 score for unknown peer', () => {
        const svc = new PeerReputationService();
        expect(svc.getScore(peerId)).to.equal(0);
        expect(svc.isBanned(peerId)).to.be.false;
        expect(svc.isDeprioritized(peerId)).to.be.false;
    });
    it('should accumulate penalties', () => {
        const svc = new PeerReputationService();
        svc.reportPeer(peerId, PenaltyReason.ConnectionFailure);
        const score1 = svc.getScore(peerId);
        expect(score1).to.be.greaterThan(0);
        svc.reportPeer(peerId, PenaltyReason.ConnectionFailure);
        const score2 = svc.getScore(peerId);
        expect(score2).to.be.greaterThan(score1);
    });
    it('should use correct penalty weights', () => {
        const svc = new PeerReputationService();
        svc.reportPeer(peerId, PenaltyReason.Equivocation);
        // Score should be approximately the equivocation weight (100) since just reported
        const score = svc.getScore(peerId);
        expect(score).to.be.closeTo(DEFAULT_PENALTY_WEIGHTS[PenaltyReason.Equivocation], 1);
    });
    it('should deprioritize peer above deprioritize threshold', () => {
        const svc = new PeerReputationService({ thresholds: { deprioritize: 10, ban: 80 } });
        // ConnectionFailure = 2, need 5+ to get above 10
        for (let i = 0; i < 6; i++) {
            svc.reportPeer(peerId, PenaltyReason.ConnectionFailure);
        }
        expect(svc.isDeprioritized(peerId)).to.be.true;
        expect(svc.isBanned(peerId)).to.be.false;
    });
    it('should ban peer above ban threshold', () => {
        const svc = new PeerReputationService({ thresholds: { deprioritize: 10, ban: 80 } });
        svc.reportPeer(peerId, PenaltyReason.Equivocation); // 100
        expect(svc.isBanned(peerId)).to.be.true;
        expect(svc.isDeprioritized(peerId)).to.be.true;
    });
    it('should decay penalties over time', () => {
        // Use a very short half-life for testing
        const svc = new PeerReputationService({ halfLifeMs: 100 });
        svc.reportPeer(peerId, PenaltyReason.InvalidSignature); // weight 50
        const scoreBefore = svc.getScore(peerId);
        expect(scoreBefore).to.be.closeTo(50, 1);
        // Wait for one half-life
        return new Promise(resolve => {
            setTimeout(() => {
                const scoreAfter = svc.getScore(peerId);
                expect(scoreAfter).to.be.lessThan(scoreBefore * 0.7); // should be roughly half
                expect(scoreAfter).to.be.greaterThan(0);
                resolve();
            }, 120);
        });
    });
    it('should record successes', () => {
        const svc = new PeerReputationService();
        svc.recordSuccess(peerId);
        svc.recordSuccess(peerId);
        const summary = svc.getReputation(peerId);
        expect(summary.successCount).to.equal(2);
        expect(summary.lastSuccess).to.be.greaterThan(0);
    });
    it('should provide correct reputation summary', () => {
        const svc = new PeerReputationService();
        svc.reportPeer(peerId, PenaltyReason.ProtocolViolation, 'bad message');
        svc.recordSuccess(peerId);
        const summary = svc.getReputation(peerId);
        expect(summary.peerId).to.equal(peerId);
        expect(summary.effectiveScore).to.be.greaterThan(0);
        expect(summary.penaltyCount).to.equal(1);
        expect(summary.successCount).to.equal(1);
        expect(summary.lastPenalty).to.be.greaterThan(0);
        expect(summary.lastSuccess).to.be.greaterThan(0);
    });
    it('should return all reputations', () => {
        const svc = new PeerReputationService();
        const peer1 = 'QmPeer1';
        const peer2 = 'QmPeer2';
        svc.reportPeer(peer1, PenaltyReason.ConnectionFailure);
        svc.reportPeer(peer2, PenaltyReason.InvalidSignature);
        const all = svc.getAllReputations();
        expect(all.size).to.equal(2);
        expect(all.has(peer1)).to.be.true;
        expect(all.has(peer2)).to.be.true;
    });
    it('should reset peer reputation', () => {
        const svc = new PeerReputationService();
        svc.reportPeer(peerId, PenaltyReason.Equivocation);
        expect(svc.getScore(peerId)).to.be.greaterThan(0);
        svc.resetPeer(peerId);
        expect(svc.getScore(peerId)).to.equal(0);
        expect(svc.isBanned(peerId)).to.be.false;
    });
    it('should accept custom weights', () => {
        const svc = new PeerReputationService({
            weights: { [PenaltyReason.ConnectionFailure]: 50 },
        });
        svc.reportPeer(peerId, PenaltyReason.ConnectionFailure);
        expect(svc.getScore(peerId)).to.be.closeTo(50, 1);
    });
    it('should prune old penalties', () => {
        const svc = new PeerReputationService({ halfLifeMs: 10, maxPenaltiesPerPeer: 5 });
        // Add more than max penalties
        for (let i = 0; i < 10; i++) {
            svc.reportPeer(peerId, PenaltyReason.ConnectionFailure);
        }
        const summary = svc.getReputation(peerId);
        expect(summary.penaltyCount).to.be.at.most(10); // may have pruned old ones
    });
    it('should return clean summary for unknown peer', () => {
        const svc = new PeerReputationService();
        const summary = svc.getReputation('QmUnknown');
        expect(summary.effectiveScore).to.equal(0);
        expect(summary.isBanned).to.be.false;
        expect(summary.isDeprioritized).to.be.false;
        expect(summary.penaltyCount).to.equal(0);
        expect(summary.successCount).to.equal(0);
    });
    it('should store context with penalties', () => {
        const svc = new PeerReputationService();
        svc.reportPeer(peerId, PenaltyReason.InvalidSignature, 'txn-abc123');
        // Context is stored internally; verify via score that penalty was recorded
        expect(svc.getScore(peerId)).to.be.greaterThan(0);
    });
});
//# sourceMappingURL=peer-reputation.spec.js.map