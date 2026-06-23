import { expect } from 'chai';
import { ClusterCoordinator } from '../src/repo/cluster-coordinator.js';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as u8ToString } from 'uint8arrays';
/**
 * Locks the super-majority threshold rounding behaviour so the next regression
 * is obvious. `executeTransaction` computes `Math.ceil(peerCount * threshold)`
 * — with a 3-peer cluster and the default 0.67 that rounds to 3, which leaves
 * zero slack and demands unanimity. The web-e2e fixture drops to 0.51 so
 * `ceil(3 * 0.51) = 2` and one missing promise no longer sinks consensus.
 *
 * The mock client either approves or rejects when asked to add its promise;
 * once present, the commit phase always succeeds so the test isolates the
 * promise-phase threshold check.
 */
const makePeerId = async () => {
    const pk = await generateKeyPair('Ed25519');
    return peerIdFromPrivateKey(pk);
};
class MockClusterClient {
    peerIdStr;
    verdict;
    constructor(peerIdStr, verdict) {
        this.peerIdStr = peerIdStr;
        this.verdict = verdict;
    }
    async update(record) {
        if (!(this.peerIdStr in record.promises)) {
            if (this.verdict === 'silent') {
                return record;
            }
            return {
                ...record,
                promises: {
                    ...record.promises,
                    [this.peerIdStr]: { type: 'approve', signature: `psig-${this.peerIdStr.substring(0, 8)}` }
                }
            };
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
const baseCfg = {
    clusterSize: 3,
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
const scenarios = [
    { threshold: 0.67, approvals: 3, expected: { kind: 'commit' } },
    { threshold: 0.67, approvals: 2, expected: { kind: 'supermajority-failed' } },
    { threshold: 0.51, approvals: 2, expected: { kind: 'commit' } }
];
describe('ClusterCoordinator super-majority threshold math (web-e2e-tier2-cluster-supermajority)', function () {
    this.timeout(10000);
    let peerIds;
    let clusterPeers;
    beforeEach(async () => {
        peerIds = await Promise.all([makePeerId(), makePeerId(), makePeerId()]);
        clusterPeers = {};
        for (const pid of peerIds) {
            const idStr = pid.toString();
            clusterPeers[idStr] = {
                multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
                publicKey: u8ToString(pid.publicKey.raw, 'base64url')
            };
        }
    });
    for (const scenario of scenarios) {
        const label = `threshold=${scenario.threshold} approvals=${scenario.approvals}/3 → ${scenario.expected.kind}`;
        it(label, async () => {
            const verdicts = peerIds.map((_, idx) => idx < scenario.approvals ? 'approve' : 'silent');
            const mocks = new Map();
            peerIds.forEach((pid, idx) => {
                mocks.set(pid.toString(), new MockClusterClient(pid.toString(), verdicts[idx]));
            });
            const mockKeyNetwork = {
                async findCoordinator() { return peerIds[0]; },
                async findCluster() { return { ...clusterPeers }; }
            };
            const createClient = (peerId) => {
                const mock = mocks.get(peerId.toString());
                if (!mock)
                    throw new Error(`No mock for ${peerId.toString()}`);
                return mock;
            };
            const coordinator = new ClusterCoordinator(mockKeyNetwork, createClient, { ...baseCfg, superMajorityThreshold: scenario.threshold });
            if (scenario.expected.kind === 'commit') {
                const result = await coordinator.executeClusterTransaction('block-1', makeMessage());
                const approvals = Object.values(result.record.promises).filter(s => s.type === 'approve').length;
                expect(approvals).to.equal(scenario.approvals);
                expect(Object.keys(result.record.commits).length).to.be.greaterThan(0);
            }
            else {
                let caught = null;
                try {
                    await coordinator.executeClusterTransaction('block-1', makeMessage());
                }
                catch (err) {
                    caught = err;
                }
                expect(caught, 'expected supermajority-failed rejection').to.be.instanceOf(Error);
                expect(caught.message).to.match(/super-majority/i);
            }
        });
    }
});
//# sourceMappingURL=cluster-coordinator-supermajority.spec.js.map