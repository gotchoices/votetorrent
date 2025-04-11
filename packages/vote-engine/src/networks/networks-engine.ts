import type { AuthorityNetwork } from '@votetorrent/vote-core';
import type { INetworksEngine } from '@votetorrent/vote-core';

export function createNetworksEngine(): INetworksEngine {
	return new NetworksEngine();
}

export class NetworksEngine implements INetworksEngine {
	protected recentNetworks: AuthorityNetwork[] = [];

	constructor() {}

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
		let networks: AuthorityNetwork[] = [];
		return networks;
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
