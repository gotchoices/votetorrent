import type {
	AdornedNetworkReference,
	INetworkEngine,
	NetworkInit,
	NetworkReference,
} from '@votetorrent/vote-core';
import type { INetworksEngine } from '@votetorrent/vote-core';

export class NetworksEngine implements INetworksEngine {
	protected recentNetworks: AdornedNetworkReference[] = [];

	constructor() {}

	async clearRecentNetworks(): Promise<void> {
		this.recentNetworks = [];
	}

	async create(init: NetworkInit): Promise<INetworkEngine> {
		throw new Error('Not implemented');
	}

	async discover(
		latitude: number,
		longitude: number
	): Promise<AdornedNetworkReference[]> {
		let networks: AdornedNetworkReference[] = [];
		return networks;
	}

	async getRecentNetworks(): Promise<AdornedNetworkReference[]> {
		return this.recentNetworks;
	}

	async open(ref: NetworkReference, storeAsRecent?: boolean): Promise<INetworkEngine> {
		throw new Error('Not implemented');
	}
}
