import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import type { PropsWithChildren } from "react";
import type { INetworksEngine } from "@votetorrent/vote-core";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { hideSplash } from "react-native-splash-view";
import { EngineFactory } from "../engines/engine-factory";
import { LocalStorageReact } from "@votetorrent/vote-engine/rn";
import { rnDbFactory } from "../engines/rn-db-factory";

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
	const [initError, setInitError] = useState<string | null>(null);

	// D-12: one app-lifetime EngineFactory via useRef (constructed once, stable across renders).
	// Pitfall 7: factory ref is stable — getEngine dep array simplifies to [].
	const engineFactoryRef = useRef<EngineFactory | null>(null);
	if (!engineFactoryRef.current) {
		engineFactoryRef.current = new EngineFactory(new LocalStorageReact(), rnDbFactory);
	}

	// Collapse the entire switch to factory delegation (SWAP-01).
	// Empty dep array: factory is stable via useRef; no stale closure risk (Pitfall 7).
	const getEngine = useCallback(
		async <T,>(engineName: string, initParams?: any): Promise<T> => {
			return engineFactoryRef.current!.getEngine<T>(engineName, initParams);
		},
		[]
	);

	// hasEngine delegates to factory's cache (SWAP-01).
	const hasEngine = useCallback((engineName: string) => {
		return engineFactoryRef.current?.hasEngine(engineName) ?? false;
	}, []);

	useEffect(() => {
		async function initialize() {
			try {
				const factory = engineFactoryRef.current!;
				const networksEng = factory.getNetworksEngine();

				// Attempt to re-attach to the most recently used network.
				const networks = await networksEng.getRecentNetworks();
				if (networks.length > 0) {
					const network = networks[0];
					try {
						// D-15: inner try/catch for re-attach; on throw → setInitError, NOT setHasNetwork.
						// NetworksEngine.open() may throw if the on-device store is corrupt/uninitialized.
						// NEVER fall back to a silent in-memory context — Phase-14 D-13 hard-fail rule.
						await networksEng.open(network, undefined);
						await factory.getEngine("network", network);
						// Pitfall 4: setHasNetwork is called by AppProvider (not the factory).
						setHasNetwork(true);
					} catch (reattachError) {
						// D-15: surface the recoverable error; spinner resolves to an error view.
						console.error("Re-attach failed:", reattachError);
						setInitError(String(reattachError));
						// fall through to setIsInitialized(true) below so the spinner never hangs.
					}
				}

				setNetworksEngine(networksEng);
				// D-15: ALWAYS reach setIsInitialized(true) + hideSplash() — no path skips this.
				setIsInitialized(true);
				hideSplash();
			} catch (fatalError) {
				// Outer catch handles failures before/after the re-attach block
				// (e.g. getRecentNetworks() failure, LocalStorageReact init failure).
				console.error("Fatal init error:", fatalError);
				setInitError(String(fatalError));
				setIsInitialized(true);
				hideSplash();
			}
		}

		initialize();
	}, []);

	// D-15: only show the spinner while initialization is truly pending.
	if (!isInitialized) {
		return (
			<View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
				<ActivityIndicator size="large" />
			</View>
		);
	}

	// D-15: recoverable boot-error state — shown INSIDE the existing loading View,
	// no new screen, no visual redesign (no-UI-design-change rule).
	// T-15-03-01: never fabricate an empty in-memory context; user must retry or start fresh.
	if (initError && !hasNetwork) {
		return (
			<View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
				<Text style={{ marginBottom: 16, textAlign: "center" }}>
					{"Failed to load network: " + initError}
				</Text>
				<TouchableOpacity
					onPress={() => {
						// Try Again: reset error state and re-run initialize().
						setInitError(null);
						setIsInitialized(false);
					}}
					style={{ marginBottom: 8 }}
				>
					<Text>{"Try Again"}</Text>
				</TouchableOpacity>
				<TouchableOpacity
					onPress={() => {
						// Start Fresh: clear the engine cache and reset to the create-network flow.
						engineFactoryRef.current?.clearEngineCache();
						setInitError(null);
						setIsInitialized(true);
					}}
				>
					<Text>{"Start Fresh"}</Text>
				</TouchableOpacity>
			</View>
		);
	}

	return (
		<AppContext.Provider
			value={{
				networksEngine: networksEngine ?? undefined,
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
