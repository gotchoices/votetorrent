/**
 * AppProvider.isNetworkSelected.test.tsx -- the live, ref-backed "is a network selected?" accessor.
 * A screen that outlived its own render (Add Network finishing a slow create after the officer
 * left) holds a stale `hasNetwork`; this accessor must still answer with the current truth.
 */

import React from "react";

jest.mock("react-native-splash-view", () => ({ hideSplash: jest.fn() }));
jest.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock("@votetorrent/vote-engine/rn", () => ({ LocalStorageReact: class {} }));
jest.mock("../../engines/rn-db-factory", () => ({ rnDbFactory: jest.fn() }));
jest.mock("../CadreNodeProvider", () => ({
	useCadreNode: () => ({
		node: null,
		syncState: "offline",
		configFault: null,
		connectedPeers: () => 0,
		nodeSettled: Promise.resolve({ status: "failed", node: null }),
	}),
}));

jest.mock("../../engines/engine-factory", () => {
	class FakeEngineFactory {
		clearEngineCache = jest.fn();
		cancelPendingStrandWaits = jest.fn();
		setCurrentUser = jest.fn();
		setGetPeerCount = jest.fn();
		hasEngine = jest.fn(() => false);
		isAttestationVerifierProvisioned = jest.fn(() => false);
		setFirstSyncListener = jest.fn();
		setNode = jest.fn();
		getNetworksEngine() {
			return {
				getRecentNetworks: jest.fn(async () => []),
				open: jest.fn(async () => undefined),
			};
		}
		getEngine = jest.fn(async (name?: string) =>
			name === "defaultUser" ? { get: jest.fn(async () => ({ name: "x" })), set: jest.fn() } : {},
		);
	}
	return { EngineFactory: FakeEngineFactory };
});

jest.mock("../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async (name: string) => ({ id: "u1", name, activeKeys: [] })),
}));
jest.mock("../../engines/device-signer", () => ({ createDeviceSigner: jest.fn() }));
jest.mock("../../engines/registrant-dev-seed", () => ({
	maybeSeedRegistrantFixtures: jest.fn(async () => undefined),
}));
jest.mock("../../screens/registration/attach-sync-bindings", () => ({ attachSyncBindings: jest.fn() }));
const mockSweep = jest.fn(async () => "removed");
jest.mock("../../engines/retired-dashboard-code-storage", () => ({
	sweepRetiredDashboardCodeStorage: mockSweep,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const renderer = require("react-test-renderer");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Text } = require("react-native");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppProvider, useApp } = require("../AppProvider");

let captured: any;
function Probe() {
	captured = useApp();
	return <Text>probe</Text>;
}

beforeEach(() => {
	jest.clearAllMocks();
	captured = undefined;
});

describe("AppProvider.isNetworkSelected", () => {
	it("N-1: false before any selection, true right after selectNetwork resolves, readable through a stale context value", async () => {
		await renderer.act(async () => {
			renderer.create(
				<AppProvider>
					<Probe />
				</AppProvider>,
			);
			for (let i = 0; i < 10; i++) await Promise.resolve();
		});
		const stale = captured; // the context value from BEFORE the selection
		expect(typeof stale.isNetworkSelected).toBe("function");
		expect(stale.isNetworkSelected()).toBe(false);

		await renderer.act(async () => {
			await stale.selectNetwork({ hash: "h", name: "n", primaryAuthorityDomainName: "d", relays: [] });
		});

		expect(stale.isNetworkSelected()).toBe(true);
		expect(captured.isNetworkSelected()).toBe(true);
	});

	it("A1: the sweep runs exactly once on mount and the context offers no snapshot export", async () => {
		await renderer.act(async () => {
			renderer.create(
				<AppProvider>
					<Probe />
				</AppProvider>,
			);
			for (let i = 0; i < 10; i++) await Promise.resolve();
		});
		expect(mockSweep).toHaveBeenCalledTimes(1);
		const retiredName = "export" + "DashboardSnapshot";
		expect(captured).toBeDefined();
		expect(Object.prototype.hasOwnProperty.call(captured, retiredName)).toBe(false);
	});

	it("A2: a failed sweep logs one closed literal warning and nothing else", async () => {
		mockSweep.mockResolvedValueOnce("failed");
		const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await renderer.act(async () => {
				renderer.create(
					<AppProvider>
						<Probe />
					</AppProvider>,
				);
				for (let i = 0; i < 10; i++) await Promise.resolve();
			});
			expect(mockSweep).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]).toEqual(["AppProvider: retired dashboard code storage sweep failed"]);
		} finally {
			warn.mockRestore();
		}
	});
});
