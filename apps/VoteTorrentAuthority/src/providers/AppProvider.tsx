import React, {createContext, useContext, useEffect, useState} from 'react';
import type {PropsWithChildren} from 'react';
import type {NetworksEngine} from '@votetorrent/vote-core';
import {MockNetworksEngine} from '@votetorrent/vote-core';
import {ActivityIndicator, View} from 'react-native';
import {hideSplash} from 'react-native-splash-view';

interface AppContextType {
	networksEngine: NetworksEngine;
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
	const [networksEngine, setNetworksEngine] = useState<NetworksEngine | null>(
		null,
	);

	useEffect(() => {
		async function initialize() {
			try {
				// Initialize engines and services
				const engine = await MockNetworksEngine.create();

				// Load any stored data
				const networks = await engine.getRecentNetworks();

				setNetworksEngine(engine);
				setIsInitialized(true);
				hideSplash();
			} catch (error) {
				console.error('Failed to initialize app:', error);
			}
		}

		initialize();
	}, []);

	if (!isInitialized || !networksEngine) {
		return (
			<View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
				<ActivityIndicator size="large" />
			</View>
		);
	}

	return (
		<AppContext.Provider
			value={{
				networksEngine,
				isInitialized,
			}}>
			{children}
		</AppContext.Provider>
	);
}
