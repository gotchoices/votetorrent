import React, {createContext, useContext, useEffect, useState} from 'react';
import type {PropsWithChildren} from 'react';
import type {AuthorityNetwork, INetworkEngine, NetworkReference, INetworksEngine} from '@votetorrent/vote-core';
import {MockNetworksEngine, MockNetworkEngine} from '@votetorrent/vote-engine';
import {ActivityIndicator, View} from 'react-native';
import {hideSplash} from 'react-native-splash-view';

interface AppContextType {
	currentNetwork?: AuthorityNetwork;
	networksEngine?: INetworksEngine;
	networkEngine?: INetworkEngine;
	isInitialized: boolean;
}

const AppContext = createContext<AppContextType | null>(null);

export function useApp() {
	const context = useContext(AppContext);
	if (!context) {
		throw new Error('useApp must be used within an AppProvider');
	}
	return context;
}

export function AppProvider({children}: PropsWithChildren) {
	const [isInitialized, setIsInitialized] = useState(false);
	const [networksEngine, setNetworksEngine] = useState<INetworksEngine | null>(null);
	const [networkEngine, setNetworkEngine] = useState<INetworkEngine | null>(null);
	const [currentNetwork, setCurrentNetwork] = useState<AuthorityNetwork | undefined>(undefined);

	useEffect(() => {
		async function initialize() {
			try {
				// Initialize engines and services
				const networksEngine = await MockNetworksEngine.create();

				// Load any stored data
				const networks = await networksEngine.getRecentNetworks();
				const network = networks[0];

				// Initialize election engine with current network
				if (network) {
					const networkReference: NetworkReference = {
						hash: network.hash,
						imageUrl: network.imageRef.url,
						relays: network.relays
					};
					const networkEngine = await MockNetworkEngine.create(networkReference);
					setNetworkEngine(networkEngine);
				}

				setNetworksEngine(networksEngine);
				setCurrentNetwork(network);
				setIsInitialized(true);
				hideSplash();
			} catch (error) {
				console.error('Failed to initialize app:', error);
			}
		}

		initialize();
	}, []);

	// Update election engine when network changes
	useEffect(() => {
		async function updateNetworkEngine() {
			if (!currentNetwork) return;

			try {
				const networkReference: NetworkReference = {
					hash: currentNetwork.hash,
					imageUrl: currentNetwork.imageRef.url,
					relays: currentNetwork.relays
				};
				const engine = await MockNetworkEngine.create(networkReference);
				setNetworkEngine(engine);
			} catch (error) {
				console.error('Failed to update election engine:', error);
			}
		}

		updateNetworkEngine();
	}, [currentNetwork]);

	if (!isInitialized || !networksEngine || !networkEngine) {
		return (
			<View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
				<ActivityIndicator size="large" />
			</View>
		);
	}

	return (
		<AppContext.Provider
			value={{
				currentNetwork,
				networksEngine,
				networkEngine,
				isInitialized
			}}>
			{children}
		</AppContext.Provider>
	);
}
