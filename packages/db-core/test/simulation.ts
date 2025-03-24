import { sha256 } from 'multiformats/hashes/sha2'
import { createEd25519PeerId } from '@libp2p/peer-id-factory';
import type { AbortOptions, Ed25519PeerId, PeerId, Stream } from '@libp2p/interface';
import { TestTransactor } from './test-transactor.js';
import type { ClusterPeers, FindCoordinatorOptions, IKeyNetwork } from '../src/index.js';
import { multiaddr } from '@multiformats/multiaddr';

export type Scenario = {
	nodeCount: number;
	clusterSize: number; // K value in Kademlia DHT (default 20 in libp2p)
}

export class NetworkNode {
	readonly transactor: TestTransactor;
	readonly multiaddrs: string[];

	constructor(
		public readonly peerId: PeerId,
		public readonly port: number,
	) {
		this.transactor = new TestTransactor();
		this.multiaddrs = [`/ip4/127.0.0.1/tcp/${port}/p2p/${peerId.toString()}`];
	}

	static async create(peerId: PeerId) {
		const hash = await sha256.digest(new TextEncoder().encode(peerId.toString()));
		const port = Array.from(hash.bytes).reduce((acc, byte) => acc + byte, 0) % 55535;
		return new NetworkNode(peerId, port);
	}
}

// Simple XOR distance function for Kademlia DHT simulation
function xorDistance(a: Uint8Array, b: Uint8Array): bigint {
	// Handle potentially undefined values
	if (!a || !b) {
		return BigInt(Number.MAX_SAFE_INTEGER); // Return a large distance for undefined inputs
	}

	const length = Math.min(a.length, b.length);
	let distance = 0n;

	for (let i = 0; i < length; i++) {
		const xor = a[i]! ^ b[i]!;
		distance = (distance << 8n) | BigInt(xor);
	}

	return distance;
}

export class NetworkSimulation implements IKeyNetwork {
	private readonly clusterSize: number;
	private readonly nodesByPeerId: Map<string, NetworkNode> = new Map();

	constructor(
		public readonly nodes: NetworkNode[],
		options: { clusterSize: number } = { clusterSize: 20 }
	) {
		this.clusterSize = options.clusterSize;

		// Create lookup map for efficient access
		for (const node of nodes) {
			this.nodesByPeerId.set(node.peerId.toString(), node);
		}
	}

	static async create(
		scenario: Scenario,
	) {
		const nodes = await Promise.all(Array.from({ length: scenario.nodeCount }, async () => {
			const peerId = await createEd25519PeerId();
			// Type assertion to bypass the type compatibility issue
			return await NetworkNode.create(peerId);
		}));

		return new NetworkSimulation(nodes, { clusterSize: scenario.clusterSize });
	}

	async findCoordinator<T>(key: Uint8Array, options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		// Get the closest nodes to the key
		const closestNodes = this.findClosestNodes(key, options?.excludedPeers);

		if (closestNodes.length === 0) {
			throw new Error('No coordinator found');
		}

		// Return the closest node as coordinator
		return closestNodes[0]!.peerId;
	}

	async findCluster(key: Uint8Array): Promise<ClusterPeers> {
		const closestNodes = this.findClosestNodes(key);
		const result: ClusterPeers = {};

		for (const node of closestNodes) {
			// Create the ClusterPeers entry
			result[node.peerId.toString()] = {
				multiaddrs: node.multiaddrs.map(addr => multiaddr(addr)),
				publicKey: this.getPeerPublicKeyBytes(node.peerId),
			};
		}

		return result;
	}

	/**
	 * Helper to safely extract public key bytes from a PeerId
	 * @param peerId - The peer ID to extract public key from
	 * @returns Uint8Array of public key bytes
	 */
	private getPeerPublicKeyBytes(peerId: PeerId): Uint8Array {
		if (peerId.publicKey) {
			// For Ed25519 and other key types that expose bytes directly
			if (peerId.publicKey instanceof Uint8Array) {
				return peerId.publicKey;
			}

			// Fall back to string encoding for other key types
			return new TextEncoder().encode(peerId.toString());
		}

		// No public key available, use string representation
		return new TextEncoder().encode(peerId.toString());
	}

	/**
	 * Find the closest nodes to a given key
	 * @param key - The key to find closest nodes for
	 * @param excludedPeers - Optional list of peers to exclude
	 * @returns Array of nodes sorted by XOR distance to the key
	 */
	private findClosestNodes(key: Uint8Array, excludedPeers?: PeerId[]): NetworkNode[] {
		const excludedIds = new Set(excludedPeers?.map(p => p.toString()) || []);

		// Calculate distances and sort
		const nodesWithDistances = this.nodes
			.filter(node => !excludedIds.has(node.peerId.toString()))
			.map(node => {
				// Create a byte array from the peer ID for distance calculation
				const peerIdBytes = this.getPeerPublicKeyBytes(node.peerId);

				return { node, distance: xorDistance(key, peerIdBytes) };
			})
			.sort((a, b) => a.distance < b.distance ? -1 : a.distance > b.distance ? 1 : 0);

		// Return only the closest K nodes (clusterSize)
		return nodesWithDistances.slice(0, this.clusterSize).map(item => item.node);
	}

	/**
	 * Create a view of the network with limited node awareness
	 * This allows testing scenarios with nodes having different views of the network
	 * @param visibleNodeIds - Array of node IDs that should be visible in this view
	 * @returns A new NetworkSimulation with only the visible nodes
	 */
	createPartialNetworkView(visibleNodeIds: string[]): NetworkSimulation {
		const visibleNodes = this.nodes.filter(node =>
			visibleNodeIds.includes(node.peerId.toString())
		);

		return new NetworkSimulation(visibleNodes, { clusterSize: this.clusterSize });
	}

	/**
	 * Get a node by its peer ID
	 * @param peerId - The peer ID to look up
	 * @returns The node with the given peer ID, or undefined if not found
	 */
	getNode(peerId: string | PeerId): NetworkNode | undefined {
		const id = typeof peerId === 'string' ? peerId : peerId.toString();
		return this.nodesByPeerId.get(id);
	}
}


