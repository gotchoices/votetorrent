import type { AuthorityNetwork } from '@votetorrent/vote-core';
import type { INetworksEngine } from '@votetorrent/vote-core';

const MOCK_NETWORKS: AuthorityNetwork[] = [
	{
		name: 'Utah State Network',
		imageRef: {
			url: 'https://picsum.photos/500/500?random=1',
			cid: 'QmHash',
		},
		hash: '1234567890',
		primaryAuthoritySid: '1',
		signature: '1234567890',
		relays: ['/ip4/127.0.0.1/tcp/8080/p2p/QmHash'],
	},
	{
		name: 'Idaho State Network',
		imageRef: {
			url: 'https://picsum.photos/500/500?random=2',
			cid: 'QmHash',
		},
		hash: '1234567890',
		primaryAuthoritySid: '2',
		signature: '1234567890',
		relays: ['/ip4/127.0.0.1/tcp/8080/p2p/QmHash'],
	},
];

export class MockNetworksEngine implements INetworksEngine {
	protected recentNetworks: AuthorityNetwork[] = [];

	constructor() {
		this.recentNetworks = MOCK_NETWORKS;
	}

	static async create(): Promise<MockNetworksEngine> {
		return new MockNetworksEngine();
	}

	async getRecentNetworks(): Promise<AuthorityNetwork[]> {
		return this.recentNetworks;
	}

	async clearRecentNetworks(): Promise<void> {
		this.recentNetworks = [];
	}

	async discoverNetworks(
		latitude: number,
		longitude: number
	): Promise<AuthorityNetwork[]> {
		return MOCK_NETWORKS;
	}

	async connect(init: AuthorityNetwork): Promise<void> {
		this.setRecentNetwork(init);
	}

	private async setRecentNetwork(init: AuthorityNetwork): Promise<void> {
		this.recentNetworks = this.recentNetworks.filter(
			(network) => network.primaryAuthoritySid !== init.primaryAuthoritySid
		);
		this.recentNetworks.unshift(init);
	}
}
