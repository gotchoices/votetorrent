import type { NetworkInit, NetworkReference } from '../network/models';
import type { INetworkEngine } from '../network/types';
import type { User } from '../user/models';

export type INetworksEngine = {
	clearRecentNetworks(): Promise<void>;
	create(networkInit: NetworkInit, user: User): Promise<INetworkEngine>;
	discover(latitude: number, longitude: number): Promise<NetworkReference[]>;
	getRecentNetworks(): Promise<NetworkReference[]>;
	open(
		ref: NetworkReference,
		user: User | undefined,
		storeAsRecent?: boolean
	): Promise<INetworkEngine>;
};
