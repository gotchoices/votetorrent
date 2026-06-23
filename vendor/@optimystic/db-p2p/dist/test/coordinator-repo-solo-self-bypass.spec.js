/**
 * Ticket: optimystic-solo-cluster-self-sync-bypass
 *
 * When a block's cluster resolves to only the local peer, `CoordinatorRepo`
 * must skip the cluster-latest callback entirely. Querying oneself is a
 * pointless round trip at best; in production it dials self via `SyncClient`,
 * which on nodes without listen addresses (solo bare-RN, WebSocket-only) can
 * hang the libp2p dial queue. This spec pins the bypass behavior.
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
/** Storage repo that reports the given block as missing on get (so fetchBlockFromCluster runs). */
const makeMissingStorageRepo = () => ({
    async get(blockGets, _options) {
        const results = {};
        for (const blockId of blockGets.blockIds) {
            results[blockId] = { state: {} };
        }
        return results;
    },
    async pend(_request, _options) {
        return { success: true, pending: [], blockIds: [] };
    },
    async cancel(_actionRef, _options) { },
    async commit(_request, _options) {
        return { success: true };
    }
});
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const makeClusterClient = ((_peerId) => ({}));
describe('CoordinatorRepo solo-cluster self-sync bypass', () => {
    const blockId = 'block-solo-self-bypass';
    it('skips clusterLatestCallback when the cluster is [self] only', async () => {
        const localPeer = await makePeerId();
        const cluster = makeClusterPeers([localPeer]);
        const callbackInvocations = [];
        const clusterLatestCallback = async (peerId) => {
            callbackInvocations.push(peerId.toString());
            return undefined;
        };
        const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, makeMissingStorageRepo(), { clusterSize: 3 }, undefined, localPeer, undefined, clusterLatestCallback);
        const result = await repo.get({ blockIds: [blockId] });
        // Block is missing locally (state: {}) and remains missing — no sync happened.
        expect(result[blockId]).to.deep.equal({ state: {} });
        // Critical: the callback must not have been invoked for self.
        expect(callbackInvocations).to.deep.equal([]);
    });
    it('still invokes clusterLatestCallback when the cluster includes a remote peer', async () => {
        const localPeer = await makePeerId();
        const otherPeer = await makePeerId();
        const cluster = makeClusterPeers([localPeer, otherPeer]);
        const callbackInvocations = [];
        const clusterLatestCallback = async (peerId) => {
            callbackInvocations.push(peerId.toString());
            return undefined;
        };
        const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, makeMissingStorageRepo(), { clusterSize: 3 }, undefined, localPeer, undefined, clusterLatestCallback);
        await repo.get({ blockIds: [blockId] });
        expect(callbackInvocations).to.have.members([
            localPeer.toString(),
            otherPeer.toString()
        ]);
    });
    it('skips callback when localPeerId is unset but the cluster is empty', async () => {
        // Guard against regressions in the empty-cluster guard — the short-circuit
        // is in addition to, not instead of, the empty-peers guard.
        const cluster = makeClusterPeers([]);
        const callbackInvocations = [];
        const clusterLatestCallback = async (peerId) => {
            callbackInvocations.push(peerId.toString());
            return undefined;
        };
        const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, makeMissingStorageRepo(), undefined, undefined, undefined, undefined, clusterLatestCallback);
        await repo.get({ blockIds: [blockId] });
        expect(callbackInvocations).to.deep.equal([]);
    });
    it('does not short-circuit when the single peer is NOT self', async () => {
        // Edge case: responsibilityK=1 and the responsible peer is someone else.
        // We must still query them (via callback) — just not self.
        const localPeer = await makePeerId();
        const otherPeer = await makePeerId();
        const cluster = makeClusterPeers([otherPeer]);
        const callbackInvocations = [];
        const clusterLatestCallback = async (peerId) => {
            callbackInvocations.push(peerId.toString());
            return undefined;
        };
        const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, makeMissingStorageRepo(), { clusterSize: 3 }, undefined, localPeer, undefined, clusterLatestCallback);
        await repo.get({ blockIds: [blockId] });
        expect(callbackInvocations).to.deep.equal([otherPeer.toString()]);
    });
    it('returns sync result when a remote peer reports a newer revision', async () => {
        // Sanity: the multi-peer path is unchanged — if a remote has a newer
        // revision, the callback result feeds into storageRepo.get with context.
        const localPeer = await makePeerId();
        const otherPeer = await makePeerId();
        const cluster = makeClusterPeers([localPeer, otherPeer]);
        const remoteLatest = { actionId: 'remote-action', rev: 7 };
        const clusterLatestCallback = async (peerId) => peerId.equals(otherPeer) ? remoteLatest : undefined;
        const storageCalls = [];
        const storageRepo = {
            async get(blockGets, _options) {
                storageCalls.push(blockGets);
                return { [blockId]: { state: {} } };
            },
            async pend() { return { success: true, pending: [], blockIds: [] }; },
            async cancel() { },
            async commit() { return { success: true }; }
        };
        const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, storageRepo, { clusterSize: 3 }, undefined, localPeer, undefined, clusterLatestCallback);
        await repo.get({ blockIds: [blockId] });
        // First call: the initial local lookup with the caller's (absent) context.
        // Second call: a restoration lookup with the discovered remote latest.
        const restorationCall = storageCalls.find(c => c.context?.rev === remoteLatest.rev);
        expect(restorationCall, 'expected restoration call with remote latest context').to.not.equal(undefined);
        expect(restorationCall.context.committed).to.deep.equal([remoteLatest]);
    });
});
//# sourceMappingURL=coordinator-repo-solo-self-bypass.spec.js.map