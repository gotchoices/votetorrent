import type { PeerId } from '@libp2p/interface';
export interface SimpleClusterCoordinator {
    selectCoordinator(key: Uint8Array, peers: PeerId[]): Promise<PeerId>;
    selectReplicas(key: Uint8Array, peers: PeerId[], replicationFactor: number): Promise<PeerId[]>;
}
/**
 * Simple consistent hashing for small clusters
 * Uses modulo arithmetic instead of XOR distance
 */
export declare class ModuloCoordinator implements SimpleClusterCoordinator {
    hashPeer(peerId: PeerId): Promise<bigint>;
    hashKey(key: Uint8Array): Promise<bigint>;
    selectCoordinator(key: Uint8Array, peers: PeerId[]): Promise<PeerId>;
    selectReplicas(key: Uint8Array, peers: PeerId[], replicationFactor: number): Promise<PeerId[]>;
}
/**
 * For very small clusters, just replicate everywhere
 */
export declare class FullReplicationCoordinator implements SimpleClusterCoordinator {
    selectCoordinator(_key: Uint8Array, peers: PeerId[]): Promise<PeerId>;
    selectReplicas(_key: Uint8Array, peers: PeerId[], _replicationFactor: number): Promise<PeerId[]>;
}
//# sourceMappingURL=simple-cluster-coordinator.d.ts.map