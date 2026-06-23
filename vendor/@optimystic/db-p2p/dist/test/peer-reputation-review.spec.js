/**
 * Review tests for IPeerReputation contract.
 * Written independently against the interface, not the implementation.
 */
import { expect } from 'chai';
import { PeerReputationService } from '../src/reputation/peer-reputation.js';
import { PenaltyReason, DEFAULT_PENALTY_WEIGHTS, DEFAULT_THRESHOLDS, } from '../src/reputation/types.js';
describe('IPeerReputation contract (review)', () => {
    let svc;
    const peerA = 'QmPeerA_000000000000';
    const peerB = 'QmPeerB_111111111111';
    beforeEach(() => {
        svc = new PeerReputationService();
    });
    // --- Clean-slate behavior ---
    it('unknown peer has score 0, not banned, not deprioritized', () => {
        expect(svc.getScore('QmNonexistent')).to.equal(0);
        expect(svc.isBanned('QmNonexistent')).to.be.false;
        expect(svc.isDeprioritized('QmNonexistent')).to.be.false;
    });
    it('getReputation for unknown peer returns clean summary', () => {
        const summary = svc.getReputation('QmNonexistent');
        expect(summary.peerId).to.equal('QmNonexistent');
        expect(summary.effectiveScore).to.equal(0);
        expect(summary.isBanned).to.be.false;
        expect(summary.isDeprioritized).to.be.false;
        expect(summary.penaltyCount).to.equal(0);
        expect(summary.successCount).to.equal(0);
    });
    it('getAllReputations is initially empty', () => {
        const all = svc.getAllReputations();
        expect(all.size).to.equal(0);
    });
    // --- Threshold boundary conditions ---
    it('score above deprioritize threshold is deprioritized', () => {
        // ProtocolViolation = 30, threshold = 20 => clearly above
        const svc2 = new PeerReputationService({ thresholds: { deprioritize: 20, ban: 80 } });
        svc2.reportPeer(peerA, PenaltyReason.ProtocolViolation); // weight = 30
        expect(svc2.getScore(peerA)).to.be.greaterThan(20);
        expect(svc2.isDeprioritized(peerA)).to.be.true;
    });
    it('score well below deprioritize threshold is NOT deprioritized', () => {
        // ConnectionFailure = 2, threshold = 20 => clearly below
        const svc2 = new PeerReputationService({ thresholds: { deprioritize: 20, ban: 80 } });
        svc2.reportPeer(peerA, PenaltyReason.ConnectionFailure); // weight = 2
        expect(svc2.getScore(peerA)).to.be.lessThan(20);
        expect(svc2.isDeprioritized(peerA)).to.be.false;
    });
    it('score above ban threshold is banned AND deprioritized', () => {
        // Equivocation = 100, ban threshold = 80 => clearly above
        const svc2 = new PeerReputationService({ thresholds: { deprioritize: 20, ban: 80 } });
        svc2.reportPeer(peerA, PenaltyReason.Equivocation); // weight = 100
        expect(svc2.isBanned(peerA)).to.be.true;
        expect(svc2.isDeprioritized(peerA)).to.be.true;
    });
    it('banned implies deprioritized (ban > deprioritize)', () => {
        // Equivocation = 100, well above default ban=80
        svc.reportPeer(peerA, PenaltyReason.Equivocation);
        expect(svc.isBanned(peerA)).to.be.true;
        expect(svc.isDeprioritized(peerA)).to.be.true;
    });
    // --- Peer isolation ---
    it('penalties for peerA do not affect peerB', () => {
        svc.reportPeer(peerA, PenaltyReason.Equivocation);
        expect(svc.getScore(peerA)).to.be.greaterThan(0);
        expect(svc.getScore(peerB)).to.equal(0);
        expect(svc.isBanned(peerB)).to.be.false;
    });
    it('resetPeer only clears the target peer', () => {
        svc.reportPeer(peerA, PenaltyReason.InvalidSignature);
        svc.reportPeer(peerB, PenaltyReason.InvalidSignature);
        svc.resetPeer(peerA);
        expect(svc.getScore(peerA)).to.equal(0);
        expect(svc.getScore(peerB)).to.be.greaterThan(0);
    });
    // --- recordSuccess ---
    it('recordSuccess does not lower penalty score', () => {
        svc.reportPeer(peerA, PenaltyReason.InvalidSignature);
        const scoreBefore = svc.getScore(peerA);
        svc.recordSuccess(peerA);
        svc.recordSuccess(peerA);
        svc.recordSuccess(peerA);
        const scoreAfter = svc.getScore(peerA);
        // Score should not decrease due to successes (successes are separate from penalty score)
        expect(scoreAfter).to.be.closeTo(scoreBefore, 1);
    });
    it('recordSuccess increments successCount in summary', () => {
        svc.recordSuccess(peerA);
        svc.recordSuccess(peerA);
        svc.recordSuccess(peerA);
        const summary = svc.getReputation(peerA);
        expect(summary.successCount).to.equal(3);
    });
    // --- getAllReputations consistency ---
    it('getAllReputations includes all reported peers', () => {
        svc.reportPeer(peerA, PenaltyReason.ConnectionFailure);
        svc.reportPeer(peerB, PenaltyReason.ConsensusTimeout);
        const all = svc.getAllReputations();
        expect(all.size).to.equal(2);
        expect(all.get(peerA).effectiveScore).to.equal(svc.getScore(peerA));
        expect(all.get(peerB).effectiveScore).to.equal(svc.getScore(peerB));
    });
    it('getAllReputations includes peers only known through recordSuccess', () => {
        svc.recordSuccess(peerA);
        const all = svc.getAllReputations();
        expect(all.size).to.equal(1);
        expect(all.get(peerA).successCount).to.equal(1);
        expect(all.get(peerA).effectiveScore).to.equal(0);
    });
    // --- Weight customization ---
    it('custom weight for one reason does not affect other reasons', () => {
        const svc2 = new PeerReputationService({
            weights: { [PenaltyReason.ConnectionFailure]: 999 },
        });
        // ConnectionFailure is now 999
        svc2.reportPeer(peerA, PenaltyReason.ConnectionFailure);
        expect(svc2.getScore(peerA)).to.be.closeTo(999, 1);
        // InvalidSignature should still use default weight (50)
        svc2.reportPeer(peerB, PenaltyReason.InvalidSignature);
        expect(svc2.getScore(peerB)).to.be.closeTo(50, 1);
    });
    // --- Decay semantics ---
    it('score approaches zero as time passes well beyond half-life', () => {
        // Use a very short half-life
        const svc2 = new PeerReputationService({ halfLifeMs: 10 });
        svc2.reportPeer(peerA, PenaltyReason.Equivocation); // weight = 100
        return new Promise(resolve => {
            setTimeout(() => {
                // After ~100ms = 10 half-lives, decay = 2^-10 ≈ 0.001, score ≈ 0.1
                const score = svc2.getScore(peerA);
                expect(score).to.be.lessThan(1);
                resolve();
            }, 100);
        });
    });
    // --- Context tracking ---
    it('context string is accepted and does not affect scoring', () => {
        svc.reportPeer(peerA, PenaltyReason.InvalidSignature, 'txn-abc');
        svc.reportPeer(peerB, PenaltyReason.InvalidSignature);
        // Both should have same score (context is metadata, not weight)
        expect(svc.getScore(peerA)).to.be.closeTo(svc.getScore(peerB), 1);
    });
    // --- All PenaltyReason values have weights ---
    it('every PenaltyReason enum value has a default weight > 0', () => {
        for (const reason of Object.values(PenaltyReason)) {
            expect(DEFAULT_PENALTY_WEIGHTS[reason], `Missing weight for ${reason}`).to.be.a('number');
            expect(DEFAULT_PENALTY_WEIGHTS[reason], `Zero weight for ${reason}`).to.be.greaterThan(0);
        }
    });
    // --- Default thresholds sanity ---
    it('default ban threshold is higher than deprioritize threshold', () => {
        expect(DEFAULT_THRESHOLDS.ban).to.be.greaterThan(DEFAULT_THRESHOLDS.deprioritize);
    });
    // --- Pruning does not lose significant recent penalties ---
    it('maxPenaltiesPerPeer keeps most recent penalties', () => {
        const svc2 = new PeerReputationService({ maxPenaltiesPerPeer: 3 });
        // Report 5 penalties; only the last 3 should remain
        for (let i = 0; i < 5; i++) {
            svc2.reportPeer(peerA, PenaltyReason.ConnectionFailure); // weight = 2
        }
        const summary = svc2.getReputation(peerA);
        expect(summary.penaltyCount).to.be.at.most(3);
        // But score should reflect the kept penalties (~6 with minimal decay)
        expect(svc2.getScore(peerA)).to.be.greaterThan(0);
    });
    // --- resetPeer makes peer fully clean ---
    it('resetPeer clears all state: score, summaries, bans', () => {
        svc.reportPeer(peerA, PenaltyReason.Equivocation); // high penalty
        svc.recordSuccess(peerA);
        expect(svc.isBanned(peerA)).to.be.true;
        svc.resetPeer(peerA);
        expect(svc.getScore(peerA)).to.equal(0);
        expect(svc.isBanned(peerA)).to.be.false;
        expect(svc.isDeprioritized(peerA)).to.be.false;
        const summary = svc.getReputation(peerA);
        expect(summary.effectiveScore).to.equal(0);
        expect(summary.penaltyCount).to.equal(0);
        expect(summary.successCount).to.equal(0);
    });
    // --- Additive scoring ---
    it('multiple light penalties can cross ban threshold cumulatively', () => {
        // ConsensusTimeout = 5, ban = 80, need 16+ for ban
        for (let i = 0; i < 20; i++) {
            svc.reportPeer(peerA, PenaltyReason.ConsensusTimeout);
        }
        // 20 * 5 = 100, with slight decay still well above 80
        expect(svc.isBanned(peerA)).to.be.true;
    });
});
//# sourceMappingURL=peer-reputation-review.spec.js.map