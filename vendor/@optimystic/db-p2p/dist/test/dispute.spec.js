import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { DisputeService } from '../src/dispute/dispute-service.js';
import { EngineHealthMonitor } from '../src/dispute/engine-health-monitor.js';
import { PeerReputationService } from '../src/reputation/peer-reputation.js';
import { PenaltyReason } from '../src/reputation/types.js';
import { selectArbitrators } from '../src/dispute/arbitrator-selection.js';
import { sortPeersByDistance } from '../src/routing/responsibility.js';
// ─── Canonical JSON for deterministic hashing ───
function canonicalJson(value) {
    return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
        ? Object.keys(v).sort().reduce((o, k) => { o[k] = v[k]; return o; }, {})
        : v);
}
// Helpers
async function makeKeyPair() {
    const privateKey = await generateKeyPair('Ed25519');
    const peerId = peerIdFromPrivateKey(privateKey);
    return { peerId, privateKey };
}
async function computeMessageHash(message) {
    const msgBytes = new TextEncoder().encode(canonicalJson(message));
    const hashBytes = await sha256.digest(msgBytes);
    return base58btc.encode(hashBytes.digest);
}
function makeRepoMessage(blockId = 'block-1') {
    return {
        operations: [{
                pend: {
                    actionId: 'action-1',
                    transforms: { [blockId]: { inserts: { 'doc-1': { value: 1 } } } },
                }
            }],
        coordinatingBlockIds: [blockId],
        expiration: Date.now() + 60000,
    };
}
async function makeClusterRecord(peers, blockId = 'block-1', options) {
    const message = makeRepoMessage(blockId);
    const messageHash = await computeMessageHash(message);
    const clusterPeers = {};
    for (const { peerId } of peers) {
        clusterPeers[peerId.toString()] = {
            multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
            publicKey: uint8ArrayToString(peerId.publicKey.raw, 'base64url'),
        };
    }
    // Build promises - some approve, some reject
    const promiseHashInput = messageHash + canonicalJson(message);
    const promiseHashBytes = await sha256.digest(new TextEncoder().encode(promiseHashInput));
    const promiseHash = uint8ArrayToString(promiseHashBytes.digest, 'base64url');
    const promises = {};
    for (const { peerId, privateKey } of peers) {
        const isRejector = options?.rejectPeers?.has(peerId.toString());
        const type = isRejector ? 'reject' : 'approve';
        const rejectReason = isRejector ? 'validation-mismatch' : undefined;
        const payload = promiseHash + ':' + type + (rejectReason ? ':' + rejectReason : '');
        const sigBytes = await privateKey.sign(new TextEncoder().encode(payload));
        promises[peerId.toString()] = {
            type,
            signature: uint8ArrayToString(sigBytes, 'base64url'),
            ...(rejectReason ? { rejectReason } : {}),
        };
    }
    // Build commits (from approving peers only)
    const commitHashInput = messageHash + canonicalJson(message) + canonicalJson(promises);
    const commitHashBytes = await sha256.digest(new TextEncoder().encode(commitHashInput));
    const commitHash = uint8ArrayToString(commitHashBytes.digest, 'base64url');
    const commits = {};
    for (const { peerId, privateKey } of peers) {
        if (options?.rejectPeers?.has(peerId.toString()))
            continue;
        const payload = commitHash + ':approve';
        const sigBytes = await privateKey.sign(new TextEncoder().encode(payload));
        commits[peerId.toString()] = {
            type: 'approve',
            signature: uint8ArrayToString(sigBytes, 'base64url'),
        };
    }
    return {
        messageHash,
        peers: clusterPeers,
        message: message,
        coordinatingBlockIds: [blockId],
        promises,
        commits,
    };
}
function makeEvidence(computedHash = 'hash-A') {
    return {
        computedHash,
        engineId: 'test-engine',
        schemaHash: 'schema-abc',
        blockStateHashes: {
            'block-1': { revision: 1, contentHash: 'content-abc' },
        },
    };
}
class MockPeerNetwork {
    async connect(_peerId, _protocol) {
        return {};
    }
}
// Mock DisputeClient that directly calls the target service
function createMockClientFactory(services) {
    return (peerId) => ({
        async sendChallenge(challenge, _timeoutMs) {
            const svc = services.get(peerId.toString());
            if (!svc)
                throw new Error(`No dispute service for ${peerId.toString()}`);
            return svc.handleChallenge(challenge);
        },
        async sendResolution(resolution) {
            const svc = services.get(peerId.toString());
            if (!svc)
                throw new Error(`No dispute service for ${peerId.toString()}`);
            svc.handleResolution(resolution);
        },
    });
}
// Tests
describe('EngineHealthMonitor', () => {
    it('should start healthy', () => {
        const monitor = new EngineHealthMonitor();
        expect(monitor.isUnhealthy()).to.be.false;
        expect(monitor.getState().disputesLost).to.equal(0);
    });
    it('should track dispute losses', () => {
        const monitor = new EngineHealthMonitor();
        monitor.recordDisputeLoss();
        expect(monitor.getState().disputesLost).to.equal(1);
        expect(monitor.isUnhealthy()).to.be.false;
    });
    it('should flag unhealthy when threshold exceeded', () => {
        const monitor = new EngineHealthMonitor({
            engineHealthDisputeThreshold: 3,
            engineHealthWindowMs: 60_000,
        });
        monitor.recordDisputeLoss();
        monitor.recordDisputeLoss();
        expect(monitor.isUnhealthy()).to.be.false;
        monitor.recordDisputeLoss();
        expect(monitor.isUnhealthy()).to.be.true;
    });
    it('should auto-recover when losses fall below threshold', () => {
        const monitor = new EngineHealthMonitor({
            engineHealthDisputeThreshold: 3,
            engineHealthWindowMs: 25, // window large enough that 3 synchronous recordDisputeLoss() calls can't outrun it
        });
        monitor.recordDisputeLoss();
        monitor.recordDisputeLoss();
        monitor.recordDisputeLoss();
        expect(monitor.isUnhealthy()).to.be.true;
        // Wait for losses to expire
        return new Promise((resolve) => {
            setTimeout(() => {
                expect(monitor.isUnhealthy()).to.be.false;
                resolve();
            }, 100);
        });
    });
    it('should reset state', () => {
        const monitor = new EngineHealthMonitor({ engineHealthDisputeThreshold: 1 });
        monitor.recordDisputeLoss();
        expect(monitor.isUnhealthy()).to.be.true;
        monitor.reset();
        expect(monitor.isUnhealthy()).to.be.false;
        expect(monitor.getState().disputesLost).to.equal(0);
    });
});
describe('DisputeService', () => {
    let clusterPeers;
    let arbitratorPeers;
    let allServices;
    beforeEach(async () => {
        // 3 cluster peers + 3 arbitrator peers
        clusterPeers = await Promise.all(Array.from({ length: 3 }, () => makeKeyPair()));
        arbitratorPeers = await Promise.all(Array.from({ length: 3 }, () => makeKeyPair()));
        allServices = new Map();
    });
    function createDisputeService(peer, options) {
        const clientFactory = createMockClientFactory(allServices);
        const svc = new DisputeService({
            peerId: peer.peerId,
            privateKey: peer.privateKey,
            peerNetwork: new MockPeerNetwork(),
            createDisputeClient: clientFactory,
            reputation: new PeerReputationService(),
            config: {
                disputeEnabled: options?.enabled ?? true,
                disputeArbitrationTimeoutMs: 5000,
                engineHealthDisputeThreshold: 3,
                engineHealthWindowMs: 600_000,
            },
            revalidate: async (_record) => {
                return makeEvidence(options?.evidenceHash ?? 'hash-default');
            },
            selectArbitrators: async (_blockId, _exclude, count) => {
                return arbitratorPeers.slice(0, count).map(p => p.peerId);
            },
        });
        allServices.set(peer.peerId.toString(), svc);
        return svc;
    }
    describe('initiateDispute', () => {
        it('should return undefined when disputes are disabled', async () => {
            const challenger = clusterPeers[0];
            const svc = createDisputeService(challenger, { enabled: false });
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const result = await svc.initiateDispute(record, makeEvidence());
            expect(result).to.be.undefined;
        });
        it('should prevent duplicate disputes for the same transaction', async () => {
            const challenger = clusterPeers[0];
            const svc = createDisputeService(challenger, { evidenceHash: 'hash-A' });
            // Setup arbitrator services that agree with challenger
            for (const arb of arbitratorPeers) {
                createDisputeService(arb, { evidenceHash: 'hash-A' });
            }
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const result1 = await svc.initiateDispute(record, makeEvidence('hash-A'));
            expect(result1).to.not.be.undefined;
            const result2 = await svc.initiateDispute(record, makeEvidence('hash-A'));
            expect(result2).to.be.undefined;
        });
        it('should skip dispute when engine is unhealthy', async () => {
            const challenger = clusterPeers[0];
            const svc = createDisputeService(challenger);
            // Force unhealthy
            const health = svc.getEngineHealth();
            health.recordDisputeLoss();
            health.recordDisputeLoss();
            health.recordDisputeLoss();
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const result = await svc.initiateDispute(record, makeEvidence());
            expect(result).to.be.undefined;
        });
        it('should resolve challenger-wins when arbitrators agree with challenger', async () => {
            const challenger = clusterPeers[0];
            // Challenger and arbitrators agree on the same hash
            const svc = createDisputeService(challenger, { evidenceHash: 'hash-A' });
            for (const arb of arbitratorPeers) {
                createDisputeService(arb, { evidenceHash: 'hash-A' });
            }
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
            expect(result).to.not.be.undefined;
            expect(result.outcome).to.equal('challenger-wins');
            // Majority peers should be in affected list
            expect(result.affectedPeers.length).to.be.greaterThan(0);
            expect(result.affectedPeers.every(p => p.reason === 'false-approval')).to.be.true;
        });
        it('should resolve majority-wins when arbitrators agree with majority', async () => {
            const challenger = clusterPeers[0];
            // Challenger has hash-A, arbitrators compute hash-B (different)
            const svc = createDisputeService(challenger, { evidenceHash: 'hash-A' });
            for (const arb of arbitratorPeers) {
                createDisputeService(arb, { evidenceHash: 'hash-B' });
            }
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
            expect(result).to.not.be.undefined;
            expect(result.outcome).to.equal('majority-wins');
            expect(result.affectedPeers.some(p => p.peerId === challenger.peerId.toString() && p.reason === 'dispute-lost')).to.be.true;
        });
        it('should resolve inconclusive when arbitrators cannot re-execute', async () => {
            const challenger = clusterPeers[0];
            // Arbitrators have no revalidate capability (returns undefined evidence)
            const svc = createDisputeService(challenger, { evidenceHash: 'hash-A' });
            for (const arb of arbitratorPeers) {
                const arbSvc = new DisputeService({
                    peerId: arb.peerId,
                    privateKey: arb.privateKey,
                    peerNetwork: new MockPeerNetwork(),
                    createDisputeClient: createMockClientFactory(allServices),
                    reputation: new PeerReputationService(),
                    config: { disputeEnabled: true, disputeArbitrationTimeoutMs: 5000, engineHealthDisputeThreshold: 3, engineHealthWindowMs: 600_000 },
                    // No revalidate callback — will return inconclusive
                    selectArbitrators: async () => [],
                });
                allServices.set(arb.peerId.toString(), arbSvc);
            }
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
            expect(result).to.not.be.undefined;
            expect(result.outcome).to.equal('inconclusive');
            expect(result.affectedPeers.length).to.equal(0);
        });
    });
    describe('handleChallenge', () => {
        it('should return agree-with-challenger when evidence matches', async () => {
            const arb = arbitratorPeers[0];
            const challenger = clusterPeers[0];
            const svc = createDisputeService(arb, { evidenceHash: 'hash-A' });
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            // Sign the dispute
            const disputeId = 'test-dispute-id';
            const sigBytes = await challenger.privateKey.sign(new TextEncoder().encode(disputeId));
            const signature = uint8ArrayToString(sigBytes, 'base64url');
            const challenge = {
                disputeId,
                originalMessageHash: record.messageHash,
                originalRecord: record,
                challengerPeerId: challenger.peerId.toString(),
                challengerEvidence: makeEvidence('hash-A'),
                signature,
                timestamp: Date.now(),
                expiration: Date.now() + 60000,
            };
            const vote = await svc.handleChallenge(challenge);
            expect(vote.vote).to.equal('agree-with-challenger');
            expect(vote.disputeId).to.equal(disputeId);
            expect(vote.arbitratorPeerId).to.equal(arb.peerId.toString());
        });
        it('should return agree-with-majority when evidence differs', async () => {
            const arb = arbitratorPeers[0];
            const challenger = clusterPeers[0];
            const svc = createDisputeService(arb, { evidenceHash: 'hash-B' });
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const disputeId = 'test-dispute-id-2';
            const sigBytes = await challenger.privateKey.sign(new TextEncoder().encode(disputeId));
            const signature = uint8ArrayToString(sigBytes, 'base64url');
            const challenge = {
                disputeId,
                originalMessageHash: record.messageHash,
                originalRecord: record,
                challengerPeerId: challenger.peerId.toString(),
                challengerEvidence: makeEvidence('hash-A'),
                signature,
                timestamp: Date.now(),
                expiration: Date.now() + 60000,
            };
            const vote = await svc.handleChallenge(challenge);
            expect(vote.vote).to.equal('agree-with-majority');
        });
        it('should return inconclusive for invalid challenge signature', async () => {
            const arb = arbitratorPeers[0];
            const challenger = clusterPeers[0];
            const svc = createDisputeService(arb, { evidenceHash: 'hash-A' });
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const challenge = {
                disputeId: 'test-dispute-id-3',
                originalMessageHash: record.messageHash,
                originalRecord: record,
                challengerPeerId: challenger.peerId.toString(),
                challengerEvidence: makeEvidence('hash-A'),
                signature: 'invalid-signature',
                timestamp: Date.now(),
                expiration: Date.now() + 60000,
            };
            const vote = await svc.handleChallenge(challenge);
            expect(vote.vote).to.equal('inconclusive');
        });
    });
    describe('resolveDispute', () => {
        it('should determine challenger-wins with super-majority', async () => {
            const challenger = clusterPeers[0];
            const svc = createDisputeService(challenger);
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const challenge = {
                disputeId: 'test-resolve-1',
                originalMessageHash: record.messageHash,
                originalRecord: record,
                challengerPeerId: challenger.peerId.toString(),
                challengerEvidence: makeEvidence('hash-A'),
                signature: 'sig',
                timestamp: Date.now(),
                expiration: Date.now() + 60000,
            };
            const votes = [
                { disputeId: 'test-resolve-1', arbitratorPeerId: 'arb-1', vote: 'agree-with-challenger', evidence: makeEvidence(), signature: 's1' },
                { disputeId: 'test-resolve-1', arbitratorPeerId: 'arb-2', vote: 'agree-with-challenger', evidence: makeEvidence(), signature: 's2' },
                { disputeId: 'test-resolve-1', arbitratorPeerId: 'arb-3', vote: 'agree-with-majority', evidence: makeEvidence(), signature: 's3' },
            ];
            const resolution = svc.resolveDispute(challenge, votes);
            expect(resolution.outcome).to.equal('challenger-wins');
            // Should penalize the 2 majority peers who approved
            expect(resolution.affectedPeers.length).to.equal(2);
        });
        it('should determine majority-wins with super-majority', async () => {
            const challenger = clusterPeers[0];
            const svc = createDisputeService(challenger);
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const challenge = {
                disputeId: 'test-resolve-2',
                originalMessageHash: record.messageHash,
                originalRecord: record,
                challengerPeerId: challenger.peerId.toString(),
                challengerEvidence: makeEvidence('hash-A'),
                signature: 'sig',
                timestamp: Date.now(),
                expiration: Date.now() + 60000,
            };
            const votes = [
                { disputeId: 'test-resolve-2', arbitratorPeerId: 'arb-1', vote: 'agree-with-majority', evidence: makeEvidence(), signature: 's1' },
                { disputeId: 'test-resolve-2', arbitratorPeerId: 'arb-2', vote: 'agree-with-majority', evidence: makeEvidence(), signature: 's2' },
                { disputeId: 'test-resolve-2', arbitratorPeerId: 'arb-3', vote: 'agree-with-challenger', evidence: makeEvidence(), signature: 's3' },
            ];
            const resolution = svc.resolveDispute(challenge, votes);
            expect(resolution.outcome).to.equal('majority-wins');
            expect(resolution.affectedPeers.length).to.equal(1);
            expect(resolution.affectedPeers[0].peerId).to.equal(challenger.peerId.toString());
            expect(resolution.affectedPeers[0].reason).to.equal('dispute-lost');
        });
        it('should determine inconclusive without super-majority', async () => {
            const challenger = clusterPeers[0];
            const svc = createDisputeService(challenger);
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const challenge = {
                disputeId: 'test-resolve-3',
                originalMessageHash: record.messageHash,
                originalRecord: record,
                challengerPeerId: challenger.peerId.toString(),
                challengerEvidence: makeEvidence('hash-A'),
                signature: 'sig',
                timestamp: Date.now(),
                expiration: Date.now() + 60000,
            };
            const votes = [
                { disputeId: 'test-resolve-3', arbitratorPeerId: 'arb-1', vote: 'agree-with-challenger', evidence: makeEvidence(), signature: 's1' },
                { disputeId: 'test-resolve-3', arbitratorPeerId: 'arb-2', vote: 'agree-with-majority', evidence: makeEvidence(), signature: 's2' },
                { disputeId: 'test-resolve-3', arbitratorPeerId: 'arb-3', vote: 'inconclusive', evidence: makeEvidence(), signature: 's3' },
            ];
            const resolution = svc.resolveDispute(challenge, votes);
            expect(resolution.outcome).to.equal('inconclusive');
            expect(resolution.affectedPeers.length).to.equal(0);
        });
        it('should determine inconclusive when all votes are inconclusive', async () => {
            const challenger = clusterPeers[0];
            const svc = createDisputeService(challenger);
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const challenge = {
                disputeId: 'test-resolve-4',
                originalMessageHash: record.messageHash,
                originalRecord: record,
                challengerPeerId: challenger.peerId.toString(),
                challengerEvidence: makeEvidence('hash-A'),
                signature: 'sig',
                timestamp: Date.now(),
                expiration: Date.now() + 60000,
            };
            const votes = [
                { disputeId: 'test-resolve-4', arbitratorPeerId: 'arb-1', vote: 'inconclusive', evidence: makeEvidence(), signature: 's1' },
                { disputeId: 'test-resolve-4', arbitratorPeerId: 'arb-2', vote: 'inconclusive', evidence: makeEvidence(), signature: 's2' },
            ];
            const resolution = svc.resolveDispute(challenge, votes);
            expect(resolution.outcome).to.equal('inconclusive');
        });
    });
    describe('handleResolution', () => {
        it('should track engine health when penalized with false-approval', async () => {
            const peer = clusterPeers[1];
            const svc = createDisputeService(peer);
            const resolution = {
                disputeId: 'res-1',
                outcome: 'challenger-wins',
                votes: [],
                affectedPeers: [
                    { peerId: peer.peerId.toString(), reason: 'false-approval' },
                ],
                timestamp: Date.now(),
            };
            svc.handleResolution(resolution);
            expect(svc.getEngineHealth().getState().disputesLost).to.equal(1);
        });
        it('should not affect engine health for dispute-lost', async () => {
            const peer = clusterPeers[0];
            const svc = createDisputeService(peer);
            const resolution = {
                disputeId: 'res-2',
                outcome: 'majority-wins',
                votes: [],
                affectedPeers: [
                    { peerId: peer.peerId.toString(), reason: 'dispute-lost' },
                ],
                timestamp: Date.now(),
            };
            svc.handleResolution(resolution);
            expect(svc.getEngineHealth().getState().disputesLost).to.equal(0);
        });
    });
    describe('getDisputeStatus', () => {
        it('should return undefined for unknown transactions', async () => {
            const peer = clusterPeers[0];
            const svc = createDisputeService(peer);
            expect(svc.getDisputeStatus('unknown-hash')).to.be.undefined;
        });
        it('should return committed-invalidated after challenger wins', async () => {
            const challenger = clusterPeers[0];
            const svc = createDisputeService(challenger, { evidenceHash: 'hash-A' });
            for (const arb of arbitratorPeers) {
                createDisputeService(arb, { evidenceHash: 'hash-A' });
            }
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
            expect(result.outcome).to.equal('challenger-wins');
            expect(svc.getDisputeStatus(record.messageHash)).to.equal('committed-invalidated');
        });
        it('should return committed-validated after majority wins', async () => {
            const challenger = clusterPeers[0];
            const svc = createDisputeService(challenger, { evidenceHash: 'hash-A' });
            for (const arb of arbitratorPeers) {
                createDisputeService(arb, { evidenceHash: 'hash-B' });
            }
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
            expect(result.outcome).to.equal('majority-wins');
            expect(svc.getDisputeStatus(record.messageHash)).to.equal('committed-validated');
        });
    });
    describe('reputation effects', () => {
        it('should apply FalseApproval penalty when challenger wins', async () => {
            const reputation = new PeerReputationService();
            const challenger = clusterPeers[0];
            const clientFactory = createMockClientFactory(allServices);
            const svc = new DisputeService({
                peerId: challenger.peerId,
                privateKey: challenger.privateKey,
                peerNetwork: new MockPeerNetwork(),
                createDisputeClient: clientFactory,
                reputation,
                config: {
                    disputeEnabled: true,
                    disputeArbitrationTimeoutMs: 5000,
                    engineHealthDisputeThreshold: 3,
                    engineHealthWindowMs: 600_000,
                },
                revalidate: async () => makeEvidence('hash-A'),
                selectArbitrators: async (_blockId, _exclude, count) => arbitratorPeers.slice(0, count).map(p => p.peerId),
            });
            allServices.set(challenger.peerId.toString(), svc);
            // Arbitrators agree with challenger
            for (const arb of arbitratorPeers) {
                createDisputeService(arb, { evidenceHash: 'hash-A' });
            }
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
            expect(result.outcome).to.equal('challenger-wins');
            // Check that majority peers got FalseApproval penalties
            for (const peer of clusterPeers.slice(1)) {
                const score = reputation.getScore(peer.peerId.toString());
                expect(score).to.be.greaterThan(0);
            }
        });
        it('should apply DisputeLost penalty when majority wins', async () => {
            const reputation = new PeerReputationService();
            const challenger = clusterPeers[0];
            const clientFactory = createMockClientFactory(allServices);
            const svc = new DisputeService({
                peerId: challenger.peerId,
                privateKey: challenger.privateKey,
                peerNetwork: new MockPeerNetwork(),
                createDisputeClient: clientFactory,
                reputation,
                config: {
                    disputeEnabled: true,
                    disputeArbitrationTimeoutMs: 5000,
                    engineHealthDisputeThreshold: 3,
                    engineHealthWindowMs: 600_000,
                },
                revalidate: async () => makeEvidence('hash-A'),
                selectArbitrators: async (_blockId, _exclude, count) => arbitratorPeers.slice(0, count).map(p => p.peerId),
            });
            allServices.set(challenger.peerId.toString(), svc);
            // Arbitrators disagree with challenger
            for (const arb of arbitratorPeers) {
                createDisputeService(arb, { evidenceHash: 'hash-B' });
            }
            const record = await makeClusterRecord(clusterPeers, 'block-1', {
                rejectPeers: new Set([challenger.peerId.toString()]),
            });
            const result = await svc.initiateDispute(record, makeEvidence('hash-A'));
            expect(result.outcome).to.equal('majority-wins');
            // Challenger should have a penalty
            const score = reputation.getScore(challenger.peerId.toString());
            expect(score).to.be.greaterThan(0);
        });
    });
});
describe('selectArbitrators', () => {
    it('should select peers beyond the original cluster', async () => {
        const allPeerKeys = await Promise.all(Array.from({ length: 6 }, () => makeKeyPair()));
        const blockId = new TextEncoder().encode('test-block');
        // Sort all by XOR distance
        const knownPeers = allPeerKeys.map(p => ({
            id: p.peerId,
            addrs: ['/ip4/127.0.0.1/tcp/8000'],
        }));
        const sorted = sortPeersByDistance(knownPeers, blockId);
        // First 3 are in the cluster
        const clusterPeerIds = new Set(sorted.slice(0, 3).map(p => p.id.toString()));
        // Select 3 arbitrators
        const arbitrators = selectArbitrators(knownPeers, blockId, clusterPeerIds, 3);
        // Should get exactly 3 arbitrators
        expect(arbitrators.length).to.equal(3);
        // None should be in the original cluster
        for (const arb of arbitrators) {
            expect(clusterPeerIds.has(arb.toString())).to.be.false;
        }
    });
    it('should return fewer arbitrators if not enough peers available', async () => {
        const allPeerKeys = await Promise.all(Array.from({ length: 4 }, () => makeKeyPair()));
        const blockId = new TextEncoder().encode('test-block-2');
        const knownPeers = allPeerKeys.map(p => ({
            id: p.peerId,
            addrs: ['/ip4/127.0.0.1/tcp/8000'],
        }));
        const sorted = sortPeersByDistance(knownPeers, blockId);
        // First 3 are in the cluster, only 1 available as arbitrator
        const clusterPeerIds = new Set(sorted.slice(0, 3).map(p => p.id.toString()));
        const arbitrators = selectArbitrators(knownPeers, blockId, clusterPeerIds, 3);
        expect(arbitrators.length).to.equal(1);
    });
    it('should return empty array if all peers are in cluster', async () => {
        const allPeerKeys = await Promise.all(Array.from({ length: 3 }, () => makeKeyPair()));
        const blockId = new TextEncoder().encode('test-block-3');
        const knownPeers = allPeerKeys.map(p => ({
            id: p.peerId,
            addrs: ['/ip4/127.0.0.1/tcp/8000'],
        }));
        const clusterPeerIds = new Set(allPeerKeys.map(p => p.peerId.toString()));
        const arbitrators = selectArbitrators(knownPeers, blockId, clusterPeerIds, 3);
        expect(arbitrators.length).to.equal(0);
    });
});
describe('PenaltyReason dispute values', () => {
    it('should have FalseApproval with weight 40', async () => {
        const { DEFAULT_PENALTY_WEIGHTS } = await import('../src/reputation/types.js');
        expect(DEFAULT_PENALTY_WEIGHTS[PenaltyReason.FalseApproval]).to.equal(40);
    });
    it('should have DisputeLost with weight 30', async () => {
        const { DEFAULT_PENALTY_WEIGHTS } = await import('../src/reputation/types.js');
        expect(DEFAULT_PENALTY_WEIGHTS[PenaltyReason.DisputeLost]).to.equal(30);
    });
});
//# sourceMappingURL=dispute.spec.js.map