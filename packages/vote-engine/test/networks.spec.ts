import { expect } from 'chai';
import { NetworksEngine } from '../src/networks/networks-engine';
import { NetworkEngine } from '../src/network/network-engine';
import type {
	User,
	NetworkInit,
	INetworksEngine,
	INetworkEngine,
} from '@votetorrent/vote-core';
import { ElectionType } from '@votetorrent/vote-core';

// Using AsyncStorage shim for local storage
import { AsyncStorage } from './shims/react-native';

describe('NetworksEngine', () => {
	it('should exercise create, clearRecentNetworks, getRecentNetworks, and open', async () => {
		// Ensure recentNetworks starts as an empty array for spread operations in create()
		await AsyncStorage.setItem('recentNetworks', []);

		const engine = new NetworksEngine(
			AsyncStorage
		) as unknown as INetworksEngine;

		// getRecentNetworks (initial)
		const initialRecents = await engine.getRecentNetworks();
		expect(initialRecents).to.be.an('array').that.has.length(0);

		// clearRecentNetworks
		await engine.clearRecentNetworks();
		// Storage remove happened; do not call getRecentNetworks immediately since engine casts the result.
		expect(await AsyncStorage.getItem('recentNetworks')).to.equal(undefined);

		// Re-seed to empty for create()
		await AsyncStorage.setItem('recentNetworks', []);

		// create()
		const networkInit: NetworkInit = {
			name: 'Test Network',
			imageUrl: 'https://cdn.example.com/logo.png',
			relays: ['/dns4/relay.example.com/tcp/443/wss'],
			primaryAuthority: {
				name: 'Primary Authority',
				domainName: 'authority.example.com',
			},
			admin: {
				officers: [
					{
						init: { name: 'Admin A', title: 'Chair', scopes: 'rn,mel' },
					},
				],
				effectiveAt: Date.now(),
				thresholdPolicies: [{ policy: 'rn', threshold: 1 }],
			},
			policies: {
				timestampAuthorities: [{ url: 'https://tsa.example.com' }],
				numberRequiredTSAs: 1,
				electionType: ElectionType.adhoc,
			},
		};

		const user: User = {
			sid: 'user-1',
			name: 'Test User',
			image: { url: 'https://img.local/user.png' },
			activeKeys: [],
		};

		const returnedNetwork: INetworkEngine = await engine.create(
			networkInit,
			user
		);

		// Returned engine type
		expect(returnedNetwork).to.be.instanceOf(NetworkEngine);

		// Recent networks updated
		const recents = (await AsyncStorage.getItem('recentNetworks')) as any[];
		expect(recents).to.be.an('array').with.length(1);
		expect(recents[0]).to.include({
			name: networkInit.name,
			primaryAuthorityDomainName: networkInit.primaryAuthority.domainName,
		});
		expect(recents[0].relays).to.deep.equal(networkInit.relays);
		expect(recents[0].imageUrl).to.equal(networkInit.imageUrl);

		// getRecentNetworks after create
		const recentViaEngine = await engine.getRecentNetworks();
		expect(recentViaEngine).to.be.an('array').with.length(1);

		// open() returns a NetworkEngine and can store as recent (dedup to front)
		const ref = {
			hash: recents[0].hash,
			relays: recents[0].relays,
			imageUrl: recents[0].imageUrl,
			name: recents[0].name,
			primaryAuthorityDomainName: recents[0].primaryAuthorityDomainName,
		};
		const opened = await engine.open(ref, user, true);
		expect(opened).to.be.instanceOf(NetworkEngine);

		const recentsAfterOpen = (await AsyncStorage.getItem(
			'recentNetworks'
		)) as any[];
		expect(recentsAfterOpen).to.be.an('array').with.length(1);
		expect(recentsAfterOpen[0].hash).to.equal(ref.hash);
		// Since open stores plain NetworkReference, adornments are not guaranteed
		expect(recentsAfterOpen[0].name).to.equal(undefined);

		// open() with storeAsRecent=false does not modify recents
		const prev = JSON.stringify(recentsAfterOpen);
		const opened2 = await engine.open(
			{
				hash: 'hash-2',
				relays: [],
				name: 'name-2',
				primaryAuthorityDomainName: 'primaryAuthorityDomainName-2',
			},
			user,
			false
		);
		expect(opened2).to.be.instanceOf(NetworkEngine);
		expect(
			JSON.stringify(await AsyncStorage.getItem('recentNetworks'))
		).to.equal(prev);
	});
});
