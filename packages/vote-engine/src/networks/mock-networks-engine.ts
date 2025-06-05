import type {
	AdornedNetworkReference,
	INetworkEngine,
	NetworkInit,
	NetworkReference,
} from '@votetorrent/vote-core';
import type { INetworksEngine } from '@votetorrent/vote-core';
import { MockNetworkEngine } from '../network/mock-network-engine';
import { MOCK_NETWORKS } from '../mock-data';

export class MockNetworksEngine implements INetworksEngine {
	protected recentNetworks: AdornedNetworkReference[] = [];

	constructor() {
		this.recentNetworks = [...MOCK_NETWORKS];
	}

	async clearRecentNetworks(): Promise<void> {
		this.recentNetworks = [];
	}

	async create(init: NetworkInit): Promise<INetworkEngine> {
		const adornedRef: AdornedNetworkReference = {
			...init,
			hash: '54321',
			primaryAuthorityDomainName: 'new-network.com',
		};
		this.recentNetworks.unshift(adornedRef);
		return new MockNetworkEngine(adornedRef);
	}

	async discover(
		latitude: number,
		longitude: number
	): Promise<AdornedNetworkReference[]> {
		return [...MOCK_NETWORKS];
	}

	async getRecentNetworks(): Promise<AdornedNetworkReference[]> {
		return [...this.recentNetworks];
	}

	async open(
		ref: NetworkReference,
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
			const adornedRef: AdornedNetworkReference = {
				hash: ref.hash,
				imageUrl: ref.imageUrl,
				relays: ref.relays,
				name: 'Newly Opened Network',
				primaryAuthorityDomainName: 'unknown-domain.com',
			};
			if (storeAsRecent !== false) {
				this.recentNetworks.unshift(adornedRef);
			}
			return new MockNetworkEngine(adornedRef);
		}
	}
}
