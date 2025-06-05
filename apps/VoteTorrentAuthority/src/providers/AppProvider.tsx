import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import type { PropsWithChildren } from "react";
import type { NetworkReference, INetworksEngine } from "@votetorrent/vote-core";
import {
	MockNetworksEngine,
	MockNetworkEngine,
	MockDefaultUserEngine,
	MockKeysTasksEngine,
	MockSignatureTasksEngine,
	MockOnboardingTasksEngine,
	MockElectionsEngine,
	MockElectionEngine,
} from "@votetorrent/vote-engine";
import { ActivityIndicator, View } from "react-native";
import { hideSplash } from "react-native-splash-view";

interface AppContextType {
	networksEngine?: INetworksEngine;
	getEngine: <T>(engineName: string, initParams?: any) => Promise<T>;
	hasEngine: (engineName: string) => boolean;
	isInitialized: boolean;
	hasNetwork: boolean;
}

const AppContext = createContext<AppContextType | null>(null);

export function useApp() {
	const context = useContext(AppContext);
	if (!context) {
		throw new Error("useApp must be used within an AppProvider");
	}
	return context;
}

export function AppProvider({ children }: PropsWithChildren) {
	const [isInitialized, setIsInitialized] = useState(false);
	const [hasNetwork, setHasNetwork] = useState(false);
	const [networksEngine, setNetworksEngine] = useState<INetworksEngine | null>(null);
	const enginesRef = useRef<Record<string, any>>({});

	const getEngine = useCallback(
		async <T,>(engineName: string, initParams?: any): Promise<T> => {
			if (!enginesRef.current[engineName]) {
				let engine;
				switch (engineName) {
					case "network":
						if (hasNetwork && initParams === undefined) {
							engine = enginesRef.current["network"];
							break;
						}
						engine = new MockNetworkEngine(initParams as NetworkReference);
						setHasNetwork(true);
						break;
					case "defaultUser":
						engine = new MockDefaultUserEngine();
						break;
					case "user":
						if (!enginesRef.current["network"]) {
							throw new Error("Network engine not initialized");
						}
						engine = await enginesRef.current["network"].getCurrentUser();
						break;
					case "authority":
						if (!enginesRef.current["network"]) {
							throw new Error("Network engine not initialized");
						}
						engine = await enginesRef.current["network"].openAuthority(initParams as string);
						break;
					case "keysTasksEngine":
						engine = new MockKeysTasksEngine();
						break;
					case "signatureTasksEngine":
						engine = new MockSignatureTasksEngine();
						break;
					case "onboardingTasksEngine":
						engine = new MockOnboardingTasksEngine();
						break;
					case "elections":
						engine = new MockElectionsEngine();
						break;
					case "election":
						engine = new MockElectionEngine();
						break;
					default:
						throw new Error(`Unknown engine type: ${engineName}`);
				}
				enginesRef.current = { ...enginesRef.current, [engineName]: engine };
				return engine as T;
			}
			return enginesRef.current[engineName] as T;
		},
		[hasNetwork]
	);

	const hasEngine = useCallback((engineName: string) => {
		return enginesRef.current[engineName] !== undefined;
	}, []);

	useEffect(() => {
		async function initialize() {
			try {
				// Initialize core engines
				const networksEngine = new MockNetworksEngine();

				// Load any stored data
				const networks = await networksEngine.getRecentNetworks();
				if (networks.length > 0) {
					const network = networks[0];
					await getEngine("network", network as NetworkReference);
				}

				setNetworksEngine(networksEngine);
				setIsInitialized(true);
				hideSplash();
			} catch (error) {
				console.error("Failed to initialize app:", error);
			}
		}

		initialize();
	}, []);

	if (!isInitialized || !networksEngine) {
		return (
			<View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
				<ActivityIndicator size="large" />
			</View>
		);
	}

	return (
		<AppContext.Provider
			value={{
				networksEngine,
				getEngine,
				hasEngine,
				isInitialized,
				hasNetwork,
			}}
		>
			{children}
		</AppContext.Provider>
	);
}
