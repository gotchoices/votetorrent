import type {
	INetworkEngine,
	NetworkInit,
	NetworkReference,
	User,
} from '@votetorrent/vote-core';
import type { INetworksEngine } from '@votetorrent/vote-core';
import { MockNetworkEngine } from '../network/mock-network-engine';
import { MOCK_NETWORKS } from '../mock-data';

export class MockNetworksEngine implements INetworksEngine {
	protected recentNetworks: NetworkReference[] = [];

	constructor() {
		this.recentNetworks = [...MOCK_NETWORKS];
	}

	async clearRecentNetworks(): Promise<void> {
		this.recentNetworks = [];
	}

	async create(init: NetworkInit): Promise<INetworkEngine> {
		const networkRef: NetworkReference = {
			...init,
			hash: '54321',
			primaryAuthorityDomainName: 'new-network.com',
		};
		this.recentNetworks.unshift(networkRef);
		return new MockNetworkEngine(networkRef);
	}

	async discover(
		latitude: number,
		longitude: number
	): Promise<NetworkReference[]> {
		return [...MOCK_NETWORKS];
	}

	async getRecentNetworks(): Promise<NetworkReference[]> {
		return [...this.recentNetworks];
	}

	async open(
		ref: NetworkReference,
		user: User,
		storeAsRecent?: boolean
	): Promise<INetworkEngine> {
		const matchingNetwork = this.recentNetworks.find(
			(network) => network.hash === ref.hash
		);
		if (matchingNetwork) {
			this.recentNetworks = this.recentNetworks.filter(
				(n) => n.hash !== ref.hash
			);
			this.recentNetworks.unshift(matchingNetwork);
			return new MockNetworkEngine(matchingNetwork);
		} else {
			const networkRef: NetworkReference = {
				hash: ref.hash,
				imageUrl: ref.imageUrl,
				relays: ref.relays,
				name: 'Newly Opened Network',
				primaryAuthorityDomainName: 'unknown-domain.com',
			};
			if (storeAsRecent) {
				this.recentNetworks.unshift(networkRef);
			}
			return new MockNetworkEngine(networkRef);
		}
	}
}
