import { NetworkTransactor } from '@optimystic/db-core';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { clusterMember } from '../cluster/cluster-repo.js';
import { StorageRepo } from '../storage/storage-repo.js';
import { MemoryRawStorage } from '../storage/memory-storage.js';
import { BlockStorage } from '../storage/block-storage.js';
import { coordinatorRepo } from '../repo/coordinator-repo.js';
import { sortPeersByDistance } from '../routing/responsibility.js';
import { toString as u8ToString } from 'uint8arrays';
class MockPeerNetwork {
    async connect(_peerId, _protocol) {
        return {};
    }
}
/**
 * Mock IKeyNetwork that returns peers based on XOR distance.
 * With responsibilityK >= nodeCount, all nodes are returned.
 * Otherwise, K-nearest by XOR distance are returned.
 */
class MockMeshKeyNetwork {
    nodes;
    responsibilityK;
    failures;
    constructor(nodes, responsibilityK, failures = {}) {
        this.nodes = nodes;
        this.responsibilityK = responsibilityK;
        this.failures = failures;
    }
    async findCoordinator(key, options) {
        const excluded = new Set((options?.excludedPeers ?? []).map(p => p.toString()));
        const sorted = this.sortedByDistance(key);
        const pick = sorted.find(n => !excluded.has(n.peerId.toString()));
        if (!pick) {
            throw new Error('No coordinator available for key (all candidates excluded)');
        }
        return pick.peerId;
    }
    async findCluster(key) {
        if (this.failures.findClusterFails) {
            return {};
        }
        const sorted = this.sortedByDistance(key);
        const k = Math.min(this.responsibilityK, sorted.length);
        const selected = sorted.slice(0, k);
        const peers = {};
        for (const node of selected) {
            peers[node.peerId.toString()] = {
                multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
                publicKey: u8ToString(node.peerId.publicKey.raw, 'base64url')
            };
        }
        return peers;
    }
    sortedByDistance(key) {
        const knownPeers = this.nodes.map(n => ({
            id: n.peerId,
            addrs: ['/ip4/127.0.0.1/tcp/8000']
        }));
        const sorted = sortPeersByDistance(knownPeers, key);
        return sorted.map(kp => this.nodes.find(n => n.peerId.equals(kp.id)));
    }
}
/**
 * Creates N interconnected mesh nodes with real components and mock transport.
 * ClusterClient calls route directly to target ClusterMember instances.
 */
export async function createMesh(nodeCount, options) {
    const failures = {};
    // Generate key pairs for all nodes
    const keyPairs = await Promise.all(Array.from({ length: nodeCount }, async () => {
        const privateKey = await generateKeyPair('Ed25519');
        return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
    }));
    // Build nodes array (partially — coordinatorRepo added after keyNetwork is ready)
    const nodes = [];
    const peerNetwork = new MockPeerNetwork();
    // Map peerId → rawStorage for data sync simulation in clusterLatestCallback
    const rawStorages = new Map();
    // Phase 1: create storage + cluster members
    let nodeIndex = 0;
    for (const { peerId, privateKey } of keyPairs) {
        const rawStorage = options.rawStorageFactory
            ? options.rawStorageFactory(nodeIndex)
            : new MemoryRawStorage();
        rawStorages.set(peerId.toString(), rawStorage);
        nodeIndex++;
        const storageRepo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage));
        const consensusConfig = {
            superMajorityThreshold: options.superMajorityThreshold ?? 0.75,
            simpleMajorityThreshold: 0.51,
            minAbsoluteClusterSize: 2,
            allowClusterDownsize: options.allowClusterDownsize ?? true,
            clusterSizeTolerance: 0.5,
            partitionDetectionWindow: 60000
        };
        const member = clusterMember({
            storageRepo,
            peerNetwork,
            peerId,
            privateKey,
            consensusConfig
        });
        nodes.push({
            peerId,
            privateKey,
            storageRepo,
            clusterMember: member,
            coordinatorRepo: undefined // filled in phase 2
        });
    }
    // Phase 2: create key network and coordinator repos (needs all nodes for routing)
    const keyNetwork = new MockMeshKeyNetwork(nodes, options.responsibilityK, failures);
    const createClusterClient = (targetPeerId) => {
        const target = nodes.find(n => n.peerId.equals(targetPeerId));
        if (!target) {
            throw new Error(`Unknown peer: ${targetPeerId.toString()}`);
        }
        return {
            async update(record) {
                if (failures.failingPeers?.has(targetPeerId.toString())) {
                    throw new Error(`Peer ${targetPeerId.toString()} is unreachable`);
                }
                return target.clusterMember.update(record);
            }
        };
    };
    for (const node of nodes) {
        const localRawStorage = rawStorages.get(node.peerId.toString());
        // Per-node callback: queries remote peer and replicates committed data locally
        // (simulates what SyncClient does in production)
        const clusterLatestCallback = async (peerId, blockId, context) => {
            const target = nodes.find(n => n.peerId.equals(peerId));
            if (!target)
                return undefined;
            const result = await target.storageRepo.get({ blockIds: [blockId], context }, { skipClusterFetch: true });
            const entry = result[blockId];
            const latest = entry?.state?.latest;
            // Simulate data sync: replicate committed block data to local storage
            if (latest && entry?.block) {
                const localBlockStorage = new BlockStorage(blockId, localRawStorage);
                const localLatest = await localBlockStorage.getLatest();
                if (!localLatest || localLatest.rev < latest.rev) {
                    // Ensure metadata exists
                    const meta = await localRawStorage.getMetadata(blockId);
                    if (!meta) {
                        await localRawStorage.saveMetadata(blockId, { latest: undefined, ranges: [[0]] });
                    }
                    await localBlockStorage.saveMaterializedBlock(latest.actionId, entry.block);
                    await localBlockStorage.saveRevision(latest.rev, latest.actionId);
                    await localBlockStorage.setLatest(latest);
                }
            }
            return latest;
        };
        // Wrap key network to include self in findCluster (matches real Libp2pKeyPeerNetwork behavior)
        const nodeKeyNetwork = {
            findCoordinator: (key, opts) => keyNetwork.findCoordinator(key, opts),
            async findCluster(key) {
                const peers = await keyNetwork.findCluster(key);
                const selfStr = node.peerId.toString();
                if (!(selfStr in peers)) {
                    peers[selfStr] = {
                        multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
                        publicKey: u8ToString(node.peerId.publicKey.raw, 'base64url')
                    };
                }
                return peers;
            }
        };
        const factory = coordinatorRepo(nodeKeyNetwork, (peerId) => createClusterClient(peerId), {
            clusterSize: options.clusterSize ?? nodeCount,
            superMajorityThreshold: options.superMajorityThreshold ?? 0.75,
            allowClusterDownsize: options.allowClusterDownsize ?? true
        });
        node.coordinatorRepo = factory({
            storageRepo: node.storageRepo,
            localCluster: node.clusterMember,
            localPeerId: node.peerId,
            clusterLatestCallback
        });
    }
    return { nodes, failures, keyNetwork };
}
/**
 * Builds a NetworkTransactor over a mesh. All nodes share the same mock
 * infrastructure so a single transactor routes to every peer via `getRepo`.
 * Suitable for solo-mesh tests; for multi-node tests prefer
 * `buildNetworkTransactors` to label "which node is driving".
 */
export const buildNetworkTransactor = (mesh, options = {}) => {
    const repoByPeer = new Map();
    for (const node of mesh.nodes) {
        repoByPeer.set(node.peerId.toString(), node.coordinatorRepo);
    }
    return new NetworkTransactor({
        timeoutMs: options.timeoutMs ?? 5_000,
        abortOrCancelTimeoutMs: options.abortOrCancelTimeoutMs ?? 5_000,
        keyNetwork: mesh.keyNetwork,
        getRepo: (peerId) => {
            const repo = repoByPeer.get(peerId.toString());
            if (!repo)
                throw new Error(`Unknown peer ${peerId.toString()}`);
            return repo;
        }
    });
};
/**
 * Builds one NetworkTransactor per mesh node, keyed by peer-id string. Each
 * transactor shares the mesh's key network and peer→repo map — the separate
 * instances exist so tests can semantically say "driven by node A".
 */
export const buildNetworkTransactors = (mesh, options = {}) => {
    const transactors = new Map();
    for (const node of mesh.nodes) {
        transactors.set(node.peerId.toString(), buildNetworkTransactor(mesh, options));
    }
    return transactors;
};
//# sourceMappingURL=mesh-harness.js.map