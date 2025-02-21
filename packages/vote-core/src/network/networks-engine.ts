import type { ElectionEngineInit } from "../index.js";

export type NetworksEngine = {
	getRecentNetworks(): Promise<ElectionEngineInit[]>;
	setRecentNetwork(init: ElectionEngineInit): Promise<void>;
	clearRecentNetworks(): Promise<void>;
	discoverNetworks(latitude: number, longitude: number): Promise<ElectionEngineInit[]>;
}
