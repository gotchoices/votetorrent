import { TestTransactor } from './test-transactor.js';
import type { ClusterPeers, FindCoordinatorOptions, IKeyNetwork, PeerId } from '../src/index.js';
export type Scenario = {
    nodeCount: number;
    clusterSize: number;
};
export declare class NetworkNode {
    readonly peerId: PeerId;
    readonly port: number;
    readonly transactor: TestTransactor;
    readonly multiaddrs: string[];
    constructor(peerId: PeerId, port: number);
    static create(peerId: PeerId): Promise<NetworkNode>;
}
export declare class NetworkSimulation implements IKeyNetwork {
    readonly nodes: NetworkNode[];
    private readonly clusterSize;
    private readonly nodesByPeerId;
    constructor(nodes: NetworkNode[], options?: {
        clusterSize: number;
    });
    static create(scenario: Scenario): Promise<NetworkSimulation>;
    findCoordinator(key: Uint8Array, options?: Partial<FindCoordinatorOptions>): Promise<PeerId>;
    findCluster(key: Uint8Array): Promise<ClusterPeers>;
    private getPeerIdString;
    private getPeerIdBytes;
    /**
     * Find the closest nodes to a given key
     * @param key - The key to find closest nodes for
     * @param excludedPeers - Optional list of peers to exclude
     * @returns Array of nodes sorted by XOR distance to the key
     */
    private findClosestNodes;
    /**
     * Create a view of the network with limited node awareness
     * This allows testing scenarios with nodes having different views of the network
     * @param visibleNodeIds - Array of node IDs that should be visible in this view
     * @returns A new NetworkSimulation with only the visible nodes
     */
    createPartialNetworkView(visibleNodeIds: string[]): NetworkSimulation;
    /**
     * Get a node by its peer ID
     * @param peerId - The peer ID to look up
     * @returns The node with the given peer ID, or undefined if not found
     */
    getNode(peerId: string | PeerId): NetworkNode | undefined;
}
//# sourceMappingURL=simulation.d.ts.map