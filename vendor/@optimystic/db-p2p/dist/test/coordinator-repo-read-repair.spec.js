/**
 * Ticket: optimystic-coordinator-read-repair
 *
 * `CoordinatorRepo.get` now consults cluster peers not only when a block is
 * entirely missing locally, but also when the local copy might be stale —
 * gated by the `readRepairMode` policy on `ClusterConsensusConfig`. These
 * specs pin the three modes (off / lazy / paranoid) and the window+sample
 * behavior for the lazy mode, so a peer that missed the post-majority commit
 * broadcast catches up on the next read instead of serving indefinitely-stale
 * data.
 */
import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CoordinatorRepo } from '../src/repo/coordinator-repo.js';
import { toString as u8ToString } from 'uint8arrays';
const makePeerId = async () => {
    const key = await generateKeyPair('Ed25519');
    return peerIdFromPrivateKey(key);
};
const makeClusterPeers = (peerIds) => {
    const peers = {};
    for (const peerId of peerIds) {
        peers[peerId.toString()] = {
            multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
            publicKey: u8ToString(peerId.publicKey?.raw ?? new Uint8Array(), 'base64url')
        };
    }
    return peers;
};
const makeKeyNetwork = (cluster) => ({
    async findCoordinator(_key, _options) {
        throw new Error('not implemented');
    },
    async findCluster(_key) {
        return { ...cluster };
    }
});
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const makeClusterClient = ((_peerId) => ({}));
/**
 * Storage repo that reports a single block at a fixed rev. Records every
 * `get` call so specs can assert restoration paths fired with the right
 * context.
 */
const makePresentStorageRepo = (blockId, rev, actionId = 'local-action') => {
    const calls = [];
    const repo = {
        async get(blockGets, _options) {
            calls.push(blockGets);
            const result = {};
            for (const id of blockGets.blockIds) {
                if (id === blockId) {
                    result[id] = { state: { latest: { actionId, rev } } };
                }
                else {
                    result[id] = { state: {} };
                }
            }
            return result;
        },
        async pend(_request, _options) {
            return { success: true, pending: [], blockIds: [] };
        },
        async cancel(_actionRef, _options) { },
        async commit(_request, _options) {
            return { success: true };
        }
    };
    return { repo, calls };
};
describe('CoordinatorRepo read-repair', () => {
    const blockId = 'block-read-repair';
    it('paranoid mode invokes clusterLatestCallback for a present (stale) block', async () => {
        const localPeer = await makePeerId();
        const otherPeer = await makePeerId();
        const cluster = makeClusterPeers([localPeer, otherPeer]);
        const callbackInvocations = [];
        const remoteLatest = { actionId: 'remote-action', rev: 2 };
        const clusterLatestCallback = async (peerId) => {
            callbackInvocations.push(peerId.toString());
            return peerId.equals(otherPeer) ? remoteLatest : undefined;
        };
        const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, 1);
        const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, storageRepo, { clusterSize: 3, readRepairMode: 'paranoid' }, undefined, localPeer, undefined, clusterLatestCallback);
        await repo.get({ blockIds: [blockId] });
        // Callback consulted both peers (self short-circuits inside the real callback,
        // but here we count every invocation including self because we mock the
        // callback directly).
        expect(callbackInvocations).to.include.members([localPeer.toString(), otherPeer.toString()]);
        // Restoration call must have fired with the remote latest context.
        const restorationCall = calls.find(c => c.context?.rev === remoteLatest.rev);
        expect(restorationCall, 'expected restoration call with remote latest context').to.not.equal(undefined);
        expect(restorationCall.context.committed).to.deep.equal([remoteLatest]);
    });
    it('paranoid mode is a noop when cluster reports the same rev as local', async () => {
        const localPeer = await makePeerId();
        const otherPeer = await makePeerId();
        const cluster = makeClusterPeers([localPeer, otherPeer]);
        const callbackInvocations = [];
        const sameLatest = { actionId: 'local-action', rev: 5 };
        const clusterLatestCallback = async (peerId) => {
            callbackInvocations.push(peerId.toString());
            return sameLatest;
        };
        const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, 5, 'local-action');
        const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, storageRepo, { clusterSize: 3, readRepairMode: 'paranoid' }, undefined, localPeer, undefined, clusterLatestCallback);
        const result = await repo.get({ blockIds: [blockId] });
        // Callback was consulted.
        expect(callbackInvocations.length).to.be.greaterThan(0);
        // Restoration call did fire (the simple-path always re-fetches after
        // queryClusterForLatest finds a max), but the rev is unchanged.
        expect(result[blockId]?.state?.latest?.rev).to.equal(5);
        // Sanity: at least one local lookup happened.
        expect(calls.length).to.be.greaterThan(0);
    });
    it('off mode skips read-repair for present blocks', async () => {
        const localPeer = await makePeerId();
        const otherPeer = await makePeerId();
        const cluster = makeClusterPeers([localPeer, otherPeer]);
        const callbackInvocations = [];
        const clusterLatestCallback = async (peerId) => {
            callbackInvocations.push(peerId.toString());
            return { actionId: 'remote', rev: 99 };
        };
        const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
        const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, storageRepo, { clusterSize: 3, readRepairMode: 'off' }, undefined, localPeer, undefined, clusterLatestCallback);
        await repo.get({ blockIds: [blockId] });
        // 'off' restores legacy behavior: present-but-stale blocks are NOT verified.
        expect(callbackInvocations).to.deep.equal([]);
    });
    it('lazy mode honors readRepairWindowMs: skips within window, triggers after', async () => {
        const localPeer = await makePeerId();
        const otherPeer = await makePeerId();
        const cluster = makeClusterPeers([localPeer, otherPeer]);
        const callbackInvocations = [];
        const clusterLatestCallback = async (peerId) => {
            callbackInvocations.push(peerId.toString());
            return undefined;
        };
        const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
        const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, storageRepo, { clusterSize: 3, readRepairMode: 'lazy', readRepairWindowMs: 60_000 }, undefined, localPeer, undefined, clusterLatestCallback);
        // Stub the clock so the spec is deterministic.
        const baseTime = 1_000_000;
        repo.now = () => baseTime;
        // Mark the block seen "now" (simulates a successful local commit).
        repo.setLastSeenForTest(blockId, baseTime);
        // Within the window: callback must NOT fire.
        await repo.get({ blockIds: [blockId] });
        expect(callbackInvocations, 'lazy mode must not invoke the callback within window').to.deep.equal([]);
        // Advance past the window.
        repo.now = () => baseTime + 60_001;
        await repo.get({ blockIds: [blockId] });
        // Now the callback must have fired for both peers.
        expect(callbackInvocations).to.include.members([localPeer.toString(), otherPeer.toString()]);
    });
    it('lazy mode triggers for blocks that have never been marked seen', async () => {
        const localPeer = await makePeerId();
        const otherPeer = await makePeerId();
        const cluster = makeClusterPeers([localPeer, otherPeer]);
        const callbackInvocations = [];
        const clusterLatestCallback = async (peerId) => {
            callbackInvocations.push(peerId.toString());
            return undefined;
        };
        const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
        const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, storageRepo, { clusterSize: 3, readRepairMode: 'lazy', readRepairWindowMs: 60_000 }, undefined, localPeer, undefined, clusterLatestCallback);
        // No setLastSeenForTest call — block has never been marked seen, so lazy
        // must treat it as stale and trigger.
        await repo.get({ blockIds: [blockId] });
        expect(callbackInvocations).to.include.members([localPeer.toString(), otherPeer.toString()]);
    });
    it('lazy mode honors readRepairSampleRate inside the freshness window', async () => {
        const localPeer = await makePeerId();
        const otherPeer = await makePeerId();
        const cluster = makeClusterPeers([localPeer, otherPeer]);
        const callbackInvocations = [];
        const clusterLatestCallback = async (peerId) => {
            callbackInvocations.push(peerId.toString());
            return undefined;
        };
        const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
        const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, storageRepo, { clusterSize: 3, readRepairMode: 'lazy', readRepairWindowMs: 60_000, readRepairSampleRate: 0.5 }, undefined, localPeer, undefined, clusterLatestCallback);
        const baseTime = 3_000_000;
        repo.now = () => baseTime;
        repo.setLastSeenForTest(blockId, baseTime);
        // Within window, rand below threshold → triggers.
        repo.rand = () => 0.3;
        await repo.get({ blockIds: [blockId] });
        expect(callbackInvocations, 'rand=0.3 < sampleRate=0.5 within window should trigger').to.not.deep.equal([]);
        // Reset for second probe and bump lastSeen so the window-branch doesn't fire.
        callbackInvocations.length = 0;
        repo.setLastSeenForTest(blockId, baseTime);
        repo.rand = () => 0.7;
        await repo.get({ blockIds: [blockId] });
        expect(callbackInvocations, 'rand=0.7 >= sampleRate=0.5 within window should NOT trigger').to.deep.equal([]);
    });
    it('lazy mode default (no window override) treats fresh local block as fresh for 10 s', async () => {
        const localPeer = await makePeerId();
        const otherPeer = await makePeerId();
        const cluster = makeClusterPeers([localPeer, otherPeer]);
        const callbackInvocations = [];
        const clusterLatestCallback = async (peerId) => {
            callbackInvocations.push(peerId.toString());
            return undefined;
        };
        const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
        // No readRepairMode / readRepairWindowMs passed: should default to
        // 'lazy' / 10_000.
        const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, storageRepo, { clusterSize: 3 }, undefined, localPeer, undefined, clusterLatestCallback);
        const baseTime = 2_000_000;
        repo.now = () => baseTime;
        repo.setLastSeenForTest(blockId, baseTime);
        // Default window is 10_000 ms.
        repo.now = () => baseTime + 5_000;
        await repo.get({ blockIds: [blockId] });
        expect(callbackInvocations, 'within default 10s window should not trigger').to.deep.equal([]);
        repo.now = () => baseTime + 10_001;
        await repo.get({ blockIds: [blockId] });
        expect(callbackInvocations).to.include.members([localPeer.toString(), otherPeer.toString()]);
    });
});
//# sourceMappingURL=coordinator-repo-read-repair.spec.js.map