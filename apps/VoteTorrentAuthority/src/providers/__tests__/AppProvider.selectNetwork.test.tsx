/**
 * AppProvider.selectNetwork.test.tsx -- selectNetwork writes a DefaultUser when none exists
 * (boot re-attach parity), and never overwrites an existing one. Without it, Settings reads
 * "No default user found" after a first create until the next restart.
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

const mockDefaultUserGet = jest.fn();
const mockDefaultUserSet = jest.fn(async (_u: unknown) => undefined);
const mockOpen = jest.fn(async (_n: unknown, _u: unknown) => undefined);

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
				open: (n: unknown, u: unknown) => mockOpen(n, u),
			};
		}
		getEngine = jest.fn(async (name?: string) =>
			name === "defaultUser" ? { get: mockDefaultUserGet, set: mockDefaultUserSet } : {},
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
jest.mock("../../engines/retired-dashboard-code-storage", () => ({
	sweepRetiredDashboardCodeStorage: jest.fn(async () => "removed"),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const renderer = require("react-test-renderer");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Text } = require("react-native");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppProvider, useApp } = require("../AppProvider");

let captured: { selectNetwork: (ref: unknown) => Promise<void> } | undefined;
function Probe() {
	captured = useApp();
	return <Text>probe</Text>;
}

async function mountAndSelect() {
	await renderer.act(async () => {
		renderer.create(
			<AppProvider>
				<Probe />
			</AppProvider>,
		);
		for (let i = 0; i < 10; i++) await Promise.resolve();
	});
	mockDefaultUserSet.mockClear();
	await renderer.act(async () => {
		await captured!.selectNetwork({ hash: "h", name: "n", primaryAuthorityDomainName: "d", relays: [] });
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	captured = undefined;
});

describe("AppProvider.selectNetwork DefaultUser parity", () => {
	it("writes { name } once when no DefaultUser exists", async () => {
		mockDefaultUserGet.mockResolvedValue(undefined);
		await mountAndSelect();
		expect(mockDefaultUserSet).toHaveBeenCalledTimes(1);
		expect(mockDefaultUserSet).toHaveBeenCalledWith({ name: "Device User" });
	});

	it("never overwrites an existing DefaultUser", async () => {
		mockDefaultUserGet.mockResolvedValue({ name: "Edited Name" });
		await mountAndSelect();
		expect(mockDefaultUserSet).not.toHaveBeenCalled();
	});
});
