/**
 * O-06 (F5): the boot re-attach and selectNetwork both run the forked-identity repair after the
 * network is open; a repaired user is bound into the factory, the network re-opened with it and the
 * cached engines dropped. The repair rules themselves are covered in device-identity-repair.test.ts.
 */
import React from "react";

jest.mock("react-native-splash-view", () => ({ hideSplash: jest.fn() }));
// Read through a stable object (fresh-t mocks loop effects otherwise).
const mockT = { t: (key: string) => key };
jest.mock("react-i18next", () => ({ useTranslation: () => mockT }));
jest.mock("@votetorrent/vote-engine/rn", () => ({
	LocalStorageReact: class {},
	UserEngine: class {},
}));
jest.mock("../../engines/rn-db-factory", () => ({ rnDbFactory: jest.fn() }));
const mockCadre = {
	node: null,
	syncState: "offline",
	configFault: null,
	connectedPeers: () => 0,
	nodeSettled: Promise.resolve({ status: "failed", node: null }),
};
jest.mock("../CadreNodeProvider", () => ({ useCadreNode: () => mockCadre }));

const NETWORK = { hash: "h", name: "n", primaryAuthorityDomainName: "d", relays: [] };
let mockRecent: unknown[] = [];
const mockOpen = jest.fn(async (_n: unknown, _u: unknown) => undefined);
const mockSetCurrentUser = jest.fn();
const mockClearEngineCache = jest.fn();
const mockGetEngineCalls: string[] = [];

jest.mock("../../engines/engine-factory", () => {
	class FakeEngineFactory {
		clearEngineCache = (...a: unknown[]) => mockClearEngineCache(...a);
		cancelPendingStrandWaits = jest.fn();
		setCurrentUser = (...a: unknown[]) => mockSetCurrentUser(...a);
		setGetPeerCount = jest.fn();
		hasEngine = jest.fn(() => false);
		isAttestationVerifierProvisioned = jest.fn(() => false);
		setFirstSyncListener = jest.fn();
		setNode = jest.fn();
		private networks = {
			getRecentNetworks: async () => mockRecent,
			open: (n: unknown, u: unknown) => mockOpen(n, u),
			getEstablishedContext: () => ({ db: {} }),
		};
		getNetworksEngine() {
			return this.networks;
		}
		getEngine = async (name?: string) => {
			mockGetEngineCalls.push(String(name));
			return name === "defaultUser" ? { get: async () => ({ name: "Device User" }), set: jest.fn() } : {};
		};
	}
	return { EngineFactory: FakeEngineFactory };
});

const mockStoredUser = { id: "forked-r", name: "Device User", activeKeys: [] };
const REPAIRED_USER = { id: "network-x", name: "Device User", activeKeys: [] };
jest.mock("../../engines/device-user", () => ({
	getOrCreateDeviceUser: async () => mockStoredUser,
}));
const mockRepair = jest.fn<Promise<{ outcome: string; user?: unknown }>, [unknown]>();
jest.mock("../../engines/device-identity-repair", () => ({
	repairDeviceIdentityForkIfNeeded: (deps: unknown) => mockRepair(deps),
}));
jest.mock("../../engines/device-signer", () => ({ createDeviceSigner: jest.fn() }));
jest.mock("../../engines/registrant-dev-seed", () => ({ maybeSeedRegistrantFixtures: jest.fn(async () => undefined) }));
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

let captured: { selectNetwork: (ref: unknown) => Promise<void>; hasNetwork: boolean } | undefined;
function Probe() {
	captured = useApp();
	return <Text>probe</Text>;
}

async function mount() {
	let tr: any;
	await renderer.act(async () => {
		tr = renderer.create(
			<AppProvider>
				<Probe />
			</AppProvider>,
		);
		for (let i = 0; i < 20; i++) await Promise.resolve();
	});
	return tr;
}

beforeEach(() => {
	jest.clearAllMocks();
	mockGetEngineCalls.length = 0;
	mockRecent = [];
	captured = undefined;
	jest.spyOn(console, "info").mockImplementation(() => {});
});

describe("AppProvider forked identity repair (F5)", () => {
	it("boot: a repaired identity is bound, the network re-opened with it and engines rebuilt", async () => {
		mockRecent = [NETWORK];
		mockRepair.mockResolvedValue({ outcome: "repaired", user: REPAIRED_USER });
		await mount();
		expect(mockRepair).toHaveBeenCalledTimes(1);
		expect(mockSetCurrentUser).toHaveBeenLastCalledWith(REPAIRED_USER);
		expect(mockOpen).toHaveBeenLastCalledWith(NETWORK, REPAIRED_USER);
		expect(mockClearEngineCache).toHaveBeenCalledTimes(1);
		expect(mockGetEngineCalls.filter((n) => n === "network").length).toBe(2);
	});

	it("boot: not-forked calls the repair once and changes nothing", async () => {
		mockRecent = [NETWORK];
		mockRepair.mockResolvedValue({ outcome: "not-forked" });
		await mount();
		expect(mockRepair).toHaveBeenCalledTimes(1);
		expect(mockSetCurrentUser).toHaveBeenCalledTimes(1);
		expect(mockSetCurrentUser).toHaveBeenLastCalledWith(mockStoredUser);
		expect(mockClearEngineCache).not.toHaveBeenCalled();
	});

	it("boot: a throwing repair never blocks boot", async () => {
		// WR-R6-03: assert that boot COMPLETED, not only that the stored user was bound (that bind runs
		// before the repair, so it held even when the repair's rejection failed the re-attach).
		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
		try {
			mockRecent = [NETWORK];
			mockRepair.mockRejectedValue(new Error("boom"));
			const tr = await mount();
			// Positive anchor: the repair ran and its failure was absorbed.
			expect(mockRepair).toHaveBeenCalledTimes(1);
			expect(warnSpy).toHaveBeenCalledWith("[identity-repair] outcome=failed");
			// Boot completed onto the network.
			expect(captured!.hasNetwork).toBe(true);
			expect(tr.root.findAll((n: { props?: { testID?: string } }) => n.props?.testID === "boot-error-view")).toHaveLength(0);
			expect(mockOpen).toHaveBeenCalledTimes(1);
			expect(mockOpen).toHaveBeenCalledWith(NETWORK, mockStoredUser);
			expect(mockSetCurrentUser).toHaveBeenLastCalledWith(mockStoredUser);
			expect(mockClearEngineCache).not.toHaveBeenCalled();
			expect(errorSpy).not.toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	it("selectNetwork: repaired identity is bound and the network re-opened with it", async () => {
		mockRepair.mockResolvedValue({ outcome: "repaired", user: REPAIRED_USER });
		await mount();
		expect(mockRepair).not.toHaveBeenCalled();
		await renderer.act(async () => {
			await captured!.selectNetwork(NETWORK);
		});
		expect(mockRepair).toHaveBeenCalledTimes(1);
		expect(mockSetCurrentUser).toHaveBeenLastCalledWith(REPAIRED_USER);
		expect(mockOpen).toHaveBeenLastCalledWith(NETWORK, REPAIRED_USER);
		expect(mockClearEngineCache).toHaveBeenCalledTimes(1);
	});

	it("selectNetwork: not-forked changes nothing", async () => {
		mockRepair.mockResolvedValue({ outcome: "not-forked" });
		await mount();
		await renderer.act(async () => {
			await captured!.selectNetwork(NETWORK);
		});
		expect(mockRepair).toHaveBeenCalledTimes(1);
		expect(mockClearEngineCache).not.toHaveBeenCalled();
	});
});
