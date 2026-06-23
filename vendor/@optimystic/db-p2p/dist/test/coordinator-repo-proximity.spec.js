import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CoordinatorRepo } from '../src/repo/coordinator-repo.js';
import { toString as u8ToString } from 'uint8arrays';
const makePeerId = async () => {
    const key = await generateKeyPair('Ed25519');
    return peerIdFromPrivateKey(key);
};
/** Build ClusterPeers from an array of PeerIds */
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
/** Stub IKeyNetwork that returns a fixed cluster */
const makeKeyNetwork = (cluster) => ({
    async findCoordinator(_key, _options) {
        throw new Error('not implemented');
    },
    async findCluster(_key) {
        return { ...cluster };
    }
});
/** No-op storage repo for testing */
const makeStorageRepo = () => ({
    async get(_blockGets, _options) {
        return {};
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
describe('CoordinatorRepo proximity verification', () => {
    const blockId = 'test-block-id-1';
    describe('when localPeerId is not set (backward compatibility)', () => {
        it('allows all operations without verification', async () => {
            const singlePeer = await makePeerId();
            // Single-peer cluster → fast path (no consensus needed)
            const cluster = makeClusterPeers([singlePeer]);
            const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, makeStorageRepo());
            // get should work
            const getResult = await repo.get({ blockIds: [blockId] });
            expect(getResult).to.deep.equal({});
            // pend should work (peerCount=1 → fast path to storageRepo)
            const pendResult = await repo.pend({
                actionId: 'action-1',
                transforms: { inserts: {}, updates: { [blockId]: [] }, deletes: [] },
                blockIds: [blockId]
            });
            expect(pendResult.success).to.equal(true);
        });
    });
    describe('when node IS in cluster (responsible)', () => {
        it('allows get, pend, commit via fast path', async () => {
            const localPeer = await makePeerId();
            // Cluster includes only localPeer → fast path (peerCount=1, no consensus needed)
            const cluster = makeClusterPeers([localPeer]);
            const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, makeStorageRepo(), { clusterSize: 3 }, undefined, localPeer);
            // get should succeed
            const getResult = await repo.get({ blockIds: [blockId] });
            expect(getResult).to.deep.equal({});
            // pend should succeed (peerCount=1 → fast path to storageRepo)
            const pendResult = await repo.pend({
                actionId: 'action-1',
                transforms: { inserts: {}, updates: { [blockId]: [] }, deletes: [] },
                blockIds: [blockId]
            });
            expect(pendResult.success).to.equal(true);
            // commit should succeed (peerCount=1 → fast path to storageRepo)
            const commitResult = await repo.commit({
                actionId: 'action-1',
                blockIds: [blockId]
            });
            expect(commitResult.success).to.equal(true);
        });
    });
    describe('when node is NOT in cluster (not responsible)', () => {
        let localPeer;
        let cluster;
        beforeEach(async () => {
            localPeer = await makePeerId();
            const otherPeers = await Promise.all([1, 2, 3].map(() => makePeerId()));
            // Cluster does NOT include localPeer
            cluster = makeClusterPeers(otherPeers);
        });
        it('allows get with warning (soft check)', async () => {
            const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, makeStorageRepo(), { clusterSize: 3 }, undefined, localPeer);
            // get should still succeed (soft check — warns but serves)
            const result = await repo.get({ blockIds: [blockId] });
            expect(result).to.deep.equal({});
        });
        it('throws on pend', async () => {
            const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, makeStorageRepo(), { clusterSize: 3 }, undefined, localPeer);
            try {
                await repo.pend({
                    actionId: 'action-1',
                    transforms: { inserts: {}, updates: { [blockId]: [] }, deletes: [] },
                    blockIds: [blockId]
                });
                expect.fail('should have thrown');
            }
            catch (err) {
                expect(err.message).to.include('Not responsible for block');
            }
        });
        it('throws on cancel', async () => {
            const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, makeStorageRepo(), { clusterSize: 3 }, undefined, localPeer);
            try {
                await repo.cancel({ actionId: 'action-1', blockIds: [blockId] });
                expect.fail('should have thrown');
            }
            catch (err) {
                expect(err.message).to.include('Not responsible for block');
            }
        });
        it('throws on commit', async () => {
            const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, makeStorageRepo(), { clusterSize: 3 }, undefined, localPeer);
            try {
                await repo.commit({ actionId: 'action-1', blockIds: [blockId] });
                expect.fail('should have thrown');
            }
            catch (err) {
                expect(err.message).to.include('Not responsible for block');
            }
        });
        it('lists all non-responsible block IDs in error', async () => {
            const repo = new CoordinatorRepo(makeKeyNetwork(cluster), makeClusterClient, makeStorageRepo(), { clusterSize: 3 }, undefined, localPeer);
            try {
                await repo.pend({
                    actionId: 'action-1',
                    transforms: { inserts: {}, updates: { 'block-a': [], 'block-b': [] }, deletes: [] },
                    blockIds: ['block-a', 'block-b']
                });
                expect.fail('should have thrown');
            }
            catch (err) {
                expect(err.message).to.include('block-a');
                expect(err.message).to.include('block-b');
            }
        });
    });
    describe('caching', () => {
        it('caches cluster membership result and reuses it', async () => {
            const localPeer = await makePeerId();
            const otherPeers = await Promise.all([1, 2].map(() => makePeerId()));
            let findClusterCalls = 0;
            const keyNetwork = {
                async findCoordinator() { throw new Error('not used'); },
                async findCluster() {
                    findClusterCalls++;
                    return makeClusterPeers([localPeer, ...otherPeers]);
                }
            };
            const repo = new CoordinatorRepo(keyNetwork, makeClusterClient, makeStorageRepo(), { clusterSize: 3 }, undefined, localPeer);
            // First call populates cache
            await repo.get({ blockIds: [blockId] });
            expect(findClusterCalls).to.equal(1);
            // Second call should use cache
            await repo.get({ blockIds: [blockId] });
            expect(findClusterCalls).to.equal(1);
        });
    });
    describe('error handling', () => {
        it('assumes responsible when findCluster fails (fail-open)', async () => {
            const localPeer = await makePeerId();
            const keyNetwork = {
                async findCoordinator() { throw new Error('not used'); },
                async findCluster() { throw new Error('network failure'); }
            };
            const repo = new CoordinatorRepo(keyNetwork, makeClusterClient, makeStorageRepo(), { clusterSize: 3 }, undefined, localPeer);
            // Should not throw — assumes responsible on error
            const result = await repo.get({ blockIds: [blockId] });
            expect(result).to.deep.equal({});
            // Write operations should also succeed on error (fail-open)
            const pendResult = await repo.pend({
                actionId: 'action-1',
                transforms: { inserts: {}, updates: { [blockId]: [] }, deletes: [] },
                blockIds: [blockId]
            });
            expect(pendResult.success).to.equal(true);
        });
    });
    describe('mixed blocks (some responsible, some not)', () => {
        it('throws when any block is not in cluster', async () => {
            const localPeer = await makePeerId();
            const otherPeer = await makePeerId();
            const responsibleBlockId = 'block-alpha';
            const nonResponsibleBlockId = 'block-beta';
            // Return different clusters per block key
            const keyNetwork = {
                async findCoordinator() { throw new Error('not used'); },
                async findCluster(key) {
                    const keyStr = new TextDecoder().decode(key);
                    if (keyStr === responsibleBlockId) {
                        return makeClusterPeers([localPeer, otherPeer]);
                    }
                    return makeClusterPeers([otherPeer]); // localPeer not in cluster
                }
            };
            const repo = new CoordinatorRepo(keyNetwork, makeClusterClient, makeStorageRepo(), { clusterSize: 3 }, undefined, localPeer);
            try {
                await repo.pend({
                    actionId: 'action-1',
                    transforms: {
                        inserts: {},
                        updates: {
                            [responsibleBlockId]: [],
                            [nonResponsibleBlockId]: []
                        },
                        deletes: []
                    },
                    blockIds: [responsibleBlockId, nonResponsibleBlockId]
                });
                expect.fail('should have thrown');
            }
            catch (err) {
                expect(err.message).to.include(nonResponsibleBlockId);
                expect(err.message).to.not.include(responsibleBlockId);
            }
        });
    });
    describe('pend block id extraction (regression for Object.keys(transforms) bug)', () => {
        it('uses actual block ids from transforms, not the literal keys "inserts"/"updates"/"deletes"', async () => {
            const localPeer = await makePeerId();
            const insertedBlockId = 'inserted-block';
            const updatedBlockId = 'updated-block';
            const deletedBlockId = 'deleted-block';
            const verified = [];
            const keyNetwork = {
                async findCoordinator() { throw new Error('not used'); },
                async findCluster(key) {
                    const keyStr = new TextDecoder().decode(key);
                    verified.push(keyStr);
                    return makeClusterPeers([localPeer]);
                }
            };
            const repo = new CoordinatorRepo(keyNetwork, makeClusterClient, makeStorageRepo(), { clusterSize: 3 }, undefined, localPeer);
            const result = await repo.pend({
                actionId: 'action-multi',
                transforms: {
                    inserts: { [insertedBlockId]: { header: { id: insertedBlockId } } },
                    updates: { [updatedBlockId]: [] },
                    deletes: [deletedBlockId]
                },
                blockIds: [insertedBlockId, updatedBlockId, deletedBlockId]
            });
            expect(result.success).to.equal(true);
            // Only real block ids should have been passed to findCluster — never the literal
            // Transforms container keys.
            expect(verified).to.not.include('inserts');
            expect(verified).to.not.include('updates');
            expect(verified).to.not.include('deletes');
            expect(verified).to.include.members([insertedBlockId, updatedBlockId, deletedBlockId]);
        });
    });
});
//# sourceMappingURL=coordinator-repo-proximity.spec.js.map