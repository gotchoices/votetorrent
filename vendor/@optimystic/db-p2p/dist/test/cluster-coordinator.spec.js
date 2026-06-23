import { expect } from 'chai';
import { ClusterCoordinator } from '../src/repo/cluster-coordinator.js';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as u8ToString } from 'uint8arrays';
const makePeerId = async () => {
    const pk = await generateKeyPair('Ed25519');
    return peerIdFromPrivateKey(pk);
};
/**
 * Mock cluster client for testing ClusterCoordinator retry behavior.
 * Determines phase by checking whether our promise is already in the record:
 * - Not present → promise phase (add our promise)
 * - Present → commit phase (add our commit, or fail if configured)
 */
class MockClusterClient {
    updateCalls = 0;
    commitPhaseCalls = 0;
    failCommit = false;
    /** Throw on the Nth commit-phase call (1-indexed). null = never fail this way. */
    failOnCommitCall = null;
    peerIdStr;
    constructor(peerIdStr) {
        this.peerIdStr = peerIdStr;
    }
    async update(record) {
        this.updateCalls++;
        // Promise phase: our promise is not yet in the record
        if (!(this.peerIdStr in record.promises)) {
            return {
                ...record,
                promises: {
                    ...record.promises,
                    [this.peerIdStr]: { type: 'approve', signature: `psig-${this.peerIdStr.substring(0, 8)}` }
                }
            };
        }
        // Commit phase (initial commit, post-majority broadcast, or scheduled retry)
        this.commitPhaseCalls++;
        const failByCounter = this.failOnCommitCall !== null && this.commitPhaseCalls === this.failOnCommitCall;
        if (this.failCommit || failByCounter) {
            throw new Error(`Peer ${this.peerIdStr.substring(0, 8)} unreachable`);
        }
        return {
            ...record,
            commits: {
                ...record.commits,
                [this.peerIdStr]: { type: 'approve', signature: `csig-${this.peerIdStr.substring(0, 8)}` }
            }
        };
    }
}
describe('ClusterCoordinator retry logic (TEST-5.2.1)', function () {
    // Retry scenarios below use real setTimeout delays totaling up to ~4.5s per case;
    // budget above the 10s package default to accommodate multiple sequential retry windows.
    this.timeout(15000);
    let peerIds;
    let mockClusters;
    let coordinator;
    const cfg = {
        clusterSize: 3,
        superMajorityThreshold: 0.75,
        simpleMajorityThreshold: 0.51,
        minAbsoluteClusterSize: 2,
        allowClusterDownsize: true,
        clusterSizeTolerance: 0.5,
        partitionDetectionWindow: 60000
    };
    const makeMessage = () => ({
        operations: [{ get: { blockIds: ['block-1'] } }],
        expiration: Date.now() + 30000
    });
    beforeEach(async () => {
        peerIds = await Promise.all([makePeerId(), makePeerId(), makePeerId()]);
        const clusterPeers = {};
        mockClusters = new Map();
        for (const pid of peerIds) {
            const idStr = pid.toString();
            clusterPeers[idStr] = {
                multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
                publicKey: u8ToString(pid.publicKey.raw, 'base64url')
            };
            mockClusters.set(idStr, new MockClusterClient(idStr));
        }
        const mockKeyNetwork = {
            async findCoordinator() { return peerIds[0]; },
            async findCluster() { return { ...clusterPeers }; }
        };
        const createClient = (peerId) => {
            const mock = mockClusters.get(peerId.toString());
            if (!mock)
                throw new Error(`No mock for ${peerId.toString()}`);
            return mock;
        };
        coordinator = new ClusterCoordinator(mockKeyNetwork, createClient, cfg);
    });
    it('completes without retry when all peers commit', async () => {
        const result = await coordinator.executeClusterTransaction('block-1', makeMessage());
        // All 3 commits present
        expect(Object.keys(result.record.commits)).to.have.length(3);
        // Each mock called exactly three times (promise + commit + consensus broadcast)
        for (const [_, mock] of mockClusters) {
            expect(mock.updateCalls).to.equal(3);
        }
        // No retry in background — wait briefly and verify no extra calls
        await new Promise(r => setTimeout(r, 300));
        for (const [_, mock] of mockClusters) {
            expect(mock.updateCalls).to.equal(3);
        }
    });
    it('returns success with simple-majority commits despite one failure', async () => {
        const failingId = peerIds[2].toString();
        mockClusters.get(failingId).failCommit = true;
        const result = await coordinator.executeClusterTransaction('block-1', makeMessage());
        // 2/3 commits = simple majority (floor(3*0.51)+1 = 2)
        expect(Object.keys(result.record.commits)).to.have.length(2);
        expect(result.record.commits[failingId]).to.equal(undefined);
    });
    it('retries failed commit peer in the background', async () => {
        const failingId = peerIds[2].toString();
        const failingMock = mockClusters.get(failingId);
        failingMock.failCommit = true;
        await coordinator.executeClusterTransaction('block-1', makeMessage());
        // Initially: 1 promise call + 1 failed commit + 2 broadcast attempts
        // (initial + 1 immediate in-line retry, both fail) = 4
        expect(failingMock.updateCalls).to.equal(4);
        // Wait for first scheduled retry (default initial interval is 250ms)
        await new Promise(r => setTimeout(r, 500));
        // Scheduled retry should have fired: at least 1 additional call
        expect(failingMock.updateCalls).to.be.greaterThanOrEqual(5);
    });
    it('retry succeeds when peer recovers', async () => {
        const failingId = peerIds[2].toString();
        const failingMock = mockClusters.get(failingId);
        failingMock.failCommit = true;
        await coordinator.executeClusterTransaction('block-1', makeMessage());
        // Fix the peer before the retry fires
        failingMock.failCommit = false;
        // Wait for retry
        await new Promise(r => setTimeout(r, 2500));
        // Peer should have been retried and succeeded (no further retries scheduled)
        expect(failingMock.updateCalls).to.be.greaterThanOrEqual(3);
        // Wait another interval to confirm no further retries after success
        const callsAfterRecovery = failingMock.updateCalls;
        await new Promise(r => setTimeout(r, 2500));
        expect(failingMock.updateCalls).to.equal(callsAfterRecovery);
    });
    it('continues retrying with exponential backoff on persistent failure', async () => {
        const failingId = peerIds[2].toString();
        const failingMock = mockClusters.get(failingId);
        failingMock.failCommit = true;
        await coordinator.executeClusterTransaction('block-1', makeMessage());
        // First retry at ~2s
        await new Promise(r => setTimeout(r, 2500));
        const callsAfterFirst = failingMock.updateCalls;
        expect(callsAfterFirst).to.be.greaterThanOrEqual(3);
        // Second retry at ~4s after first (backoff factor 2)
        await new Promise(r => setTimeout(r, 4500));
        const callsAfterSecond = failingMock.updateCalls;
        expect(callsAfterSecond).to.be.greaterThan(callsAfterFirst);
    });
});
describe('ClusterCoordinator broadcast in-line retry', function () {
    this.timeout(15000);
    let peerIds;
    let mockClusters;
    const baseCfg = {
        clusterSize: 3,
        superMajorityThreshold: 0.75,
        simpleMajorityThreshold: 0.51,
        minAbsoluteClusterSize: 2,
        allowClusterDownsize: true,
        clusterSizeTolerance: 0.5,
        partitionDetectionWindow: 60000
    };
    const makeMessage = () => ({
        operations: [{ get: { blockIds: ['block-1'] } }],
        expiration: Date.now() + 30000
    });
    const setupCluster = async (cfg) => {
        peerIds = await Promise.all([makePeerId(), makePeerId(), makePeerId()]);
        const clusterPeers = {};
        mockClusters = new Map();
        for (const pid of peerIds) {
            const idStr = pid.toString();
            clusterPeers[idStr] = {
                multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
                publicKey: u8ToString(pid.publicKey.raw, 'base64url')
            };
            mockClusters.set(idStr, new MockClusterClient(idStr));
        }
        const mockKeyNetwork = {
            async findCoordinator() { return peerIds[0]; },
            async findCluster() { return { ...clusterPeers }; }
        };
        const createClient = (peerId) => {
            const mock = mockClusters.get(peerId.toString());
            if (!mock)
                throw new Error(`No mock for ${peerId.toString()}`);
            return mock;
        };
        return new ClusterCoordinator(mockKeyNetwork, createClient, cfg);
    };
    it('recovers when first broadcast attempt fails but in-line retry succeeds', async () => {
        const coordinator = await setupCluster(baseCfg);
        const failingId = peerIds[2].toString();
        const failingMock = mockClusters.get(failingId);
        // commit phase = call 1 (succeeds), broadcast attempt 1 = call 2 (fails),
        // broadcast in-line retry = call 3 (succeeds)
        failingMock.failOnCommitCall = 2;
        const result = await coordinator.executeClusterTransaction('block-1', makeMessage());
        expect(Object.keys(result.record.commits)).to.have.length(3);
        expect(failingMock.commitPhaseCalls).to.equal(3);
        // Inspect internal state: no scheduled retry timer was created for that peer
        const txState = coordinator.transactions.get(result.record.messageHash);
        expect(txState?.retry, 'expected no scheduled retry after successful in-line retry').to.equal(undefined);
        // Wait past the default 250ms initial timer; no extra calls should fire
        const callsAfterBroadcast = failingMock.updateCalls;
        await new Promise(r => setTimeout(r, 400));
        expect(failingMock.updateCalls).to.equal(callsAfterBroadcast);
    });
    it('schedules a 250ms retry when both broadcast attempts fail', async () => {
        const coordinator = await setupCluster(baseCfg);
        const failingId = peerIds[2].toString();
        const failingMock = mockClusters.get(failingId);
        failingMock.failCommit = true;
        const result = await coordinator.executeClusterTransaction('block-1', makeMessage());
        // 1 promise + 1 commit-fail + 2 broadcast attempts (both fail) = 4
        expect(failingMock.updateCalls).to.equal(4);
        const txState = coordinator.transactions.get(result.record.messageHash);
        expect(txState?.retry, 'expected a scheduled retry').to.not.equal(undefined);
        expect(txState.retry.intervalMs).to.equal(250);
        expect(Array.from(txState.retry.pendingPeers)).to.deep.equal([failingId]);
    });
    it('honors custom commitBroadcastImmediateRetries and commitBroadcastRetryInitialMs', async () => {
        const customCfg = {
            ...baseCfg,
            commitBroadcastRetryInitialMs: 100,
            commitBroadcastImmediateRetries: 2
        };
        const coordinator = await setupCluster(customCfg);
        const failingId = peerIds[2].toString();
        const failingMock = mockClusters.get(failingId);
        failingMock.failCommit = true;
        const result = await coordinator.executeClusterTransaction('block-1', makeMessage());
        // 1 promise + 1 commit-fail + 3 broadcast attempts (initial + 2 immediate retries) = 5
        expect(failingMock.updateCalls).to.equal(5);
        const txState = coordinator.transactions.get(result.record.messageHash);
        expect(txState?.retry?.intervalMs).to.equal(100);
    });
});
//# sourceMappingURL=cluster-coordinator.spec.js.map