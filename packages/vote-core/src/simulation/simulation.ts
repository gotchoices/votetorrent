import { createEd25519PeerId } from '@libp2p/peer-id-factory';
import type { AbortOptions, Ed25519PeerId, PeerId, Stream } from '@libp2p/interface';
import { TestTransactor } from '@votetorrent/db-core/test/test-transactor.js';
import type { ClusterPeers, FindCoordinatorOptions, IKeyNetwork } from '@votetorrent/db-core';

export type Scenario = {
	nodeCount: number;
}

export class NetworkNode {
	readonly transactor: TestTransactor;
	constructor(
		public readonly peerId: Ed25519PeerId,
	) {
		this.transactor = new TestTransactor();
	}
}

export class NetworkSimulation implements IKeyNetwork {
	constructor(
		public readonly nodes: NetworkNode[],
	) {}

	static async create(
		scenario: Scenario,
	) {
		const nodes = await Promise.all(Array.from({ length: scenario.nodeCount }, async (_, i) => {
			const peerId = await createEd25519PeerId();
			return new NetworkNode(peerId);
		}));
		return new NetworkSimulation(nodes);
	}

	dialProtocol(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream> {
		throw new Error('Method not implemented.');
	}

	findCoordinator<T>(key: Uint8Array, options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error('Method not implemented.');
	}

	findCluster(key: Uint8Array): Promise<ClusterPeers> {
		throw new Error('Method not implemented.');
	}
}


