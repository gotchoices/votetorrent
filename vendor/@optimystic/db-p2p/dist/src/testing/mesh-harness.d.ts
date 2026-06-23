import type { PeerId, PrivateKey } from '@libp2p/interface';
import type { IKeyNetwork, ITransactor } from '@optimystic/db-core';
import { ClusterMember } from '../cluster/cluster-repo.js';
import { StorageRepo } from '../storage/storage-repo.js';
import type { IRawStorage } from '../storage/i-raw-storage.js';
import type { CoordinatorRepo } from '../repo/coordinator-repo.js';
export interface MeshNode {
    peerId: PeerId;
    privateKey: PrivateKey;
    storageRepo: StorageRepo;
    clusterMember: ClusterMember;
    coordinatorRepo: CoordinatorRepo;
}
export interface MeshOptions {
    responsibilityK: number;
    clusterSize?: number;
    superMajorityThreshold?: number;
    allowClusterDownsize?: boolean;
    /**
     * Optional per-node raw-storage factory. Invoked once per node (indexed from 0)
     * to supply the IRawStorage that backs StorageRepo. If omitted, each node gets
     * a fresh `MemoryRawStorage`. Used by fault-injection tests to wrap the store
     * with a crashing proxy, or by restart tests to rebuild over preserved state.
     */
    rawStorageFactory?: (index: number) => IRawStorage;
}
export interface MeshFailureConfig {
    /** Peers that should fail on cluster update (simulate unreachable) */
    failingPeers?: Set<string>;
    /** Make findCluster return empty (simulate DHT failure) */
    findClusterFails?: boolean;
}
export interface Mesh {
    nodes: MeshNode[];
    failures: MeshFailureConfig;
    keyNetwork: IKeyNetwork;
}
/**
 * Creates N interconnected mesh nodes with real components and mock transport.
 * ClusterClient calls route directly to target ClusterMember instances.
 */
export declare function createMesh(nodeCount: number, options: MeshOptions): Promise<Mesh>;
export interface BuildTransactorOptions {
    timeoutMs?: number;
    abortOrCancelTimeoutMs?: number;
}
/**
 * Builds a NetworkTransactor over a mesh. All nodes share the same mock
 * infrastructure so a single transactor routes to every peer via `getRepo`.
 * Suitable for solo-mesh tests; for multi-node tests prefer
 * `buildNetworkTransactors` to label "which node is driving".
 */
export declare const buildNetworkTransactor: (mesh: Mesh, options?: BuildTransactorOptions) => ITransactor;
/**
 * Builds one NetworkTransactor per mesh node, keyed by peer-id string. Each
 * transactor shares the mesh's key network and peer→repo map — the separate
 * instances exist so tests can semantically say "driven by node A".
 */
export declare const buildNetworkTransactors: (mesh: Mesh, options?: BuildTransactorOptions) => Map<string, ITransactor>;
//# sourceMappingURL=mesh-harness.d.ts.map