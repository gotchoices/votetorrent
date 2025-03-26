import type { ElectionEngineInit, NetworksEngine } from "../index.js";

const MOCK_NETWORKS: ElectionEngineInit[] = [
    {
        name: "Utah State Network",
        imageUrl: "https://picsum.photos/500/500?random=1",
        bootstrap: [
            "/dns/utah.gov/tcp/443/p2p/QmZjkls123",
            "/dns/slco.gov/tcp/443/p2p/QmZjkls456"
        ],
        primaryAuthoritySid: "1"
    },
    {
        name: "Idaho State Network",
        imageUrl: "https://picsum.photos/500/500?random=2",
        bootstrap: [
            "/dns/idaho.gov/tcp/443/p2p/QmZjkls789"
        ],
        primaryAuthoritySid: "2"
    }
];

export class MockNetworksEngine implements NetworksEngine {
    private recentNetworks: ElectionEngineInit[] = [];

    constructor() {
        this.recentNetworks = MOCK_NETWORKS;
    }

    static async create(): Promise<MockNetworksEngine> {
        return new MockNetworksEngine();
    }

    async getRecentNetworks(): Promise<ElectionEngineInit[]> {
        return this.recentNetworks;
    }

    async clearRecentNetworks(): Promise<void> {
        this.recentNetworks = [];
    }

    async discoverNetworks(latitude: number, longitude: number): Promise<ElectionEngineInit[]> {
        return MOCK_NETWORKS;
    }

    async connect(init: ElectionEngineInit): Promise<void> {
        this._setRecentNetwork(init);
    }

    async _setRecentNetwork(init: ElectionEngineInit): Promise<void> {
        this.recentNetworks = this.recentNetworks.filter(
            network => network.primaryAuthoritySid !== init.primaryAuthoritySid
        );
        this.recentNetworks.unshift(init);
    }
} 