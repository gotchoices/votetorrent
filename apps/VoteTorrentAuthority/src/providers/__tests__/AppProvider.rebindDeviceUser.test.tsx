/**
 * rebindDeviceUser: after Replace Signing Key commits, the session is re-bound to the device user as
 * stored NOW. Before it, the factory user, the open network's ctx.user and every cached engine kept
 * the key minted at network creation, so Propose ballot failed `UserValid` until a relaunch (62
 * session 1, observation 1). Harness copied from AppProvider.identityRepair.test.tsx.
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

const OLD_USER = { id: "u1", name: "Device User", activeKeys: [{ key: "old-key", type: "P", expiration: 1 }] };
const NEW_USER = { id: "u1", name: "Device User", activeKeys: [{ key: "new-key", type: "P", expiration: 1 }] };
let mockStoredUser: unknown = OLD_USER;
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

let captured:
	| { selectNetwork: (ref: unknown) => Promise<void>; hasNetwork: boolean; rebindDeviceUser?: () => Promise<void> }
	| undefined;
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
	mockStoredUser = OLD_USER;
	mockRepair.mockResolvedValue({ outcome: "not-forked" });
	captured = undefined;
	jest.spyOn(console, "info").mockImplementation(() => {});
});

describe("AppProvider rebindDeviceUser (key replacement)", () => {
	it("boot network: binds the stored user, re-opens the network with it and rebuilds the engines", async () => {
		mockRecent = [NETWORK];
		await mount();
		expect(captured!.hasNetwork).toBe(true);
		expect(mockOpen).toHaveBeenLastCalledWith(NETWORK, OLD_USER);
		mockOpen.mockClear();
		mockSetCurrentUser.mockClear();
		mockGetEngineCalls.length = 0;

		mockStoredUser = NEW_USER; // what persistProvisionedDeviceUser wrote
		await renderer.act(async () => {
			await captured!.rebindDeviceUser!();
		});
		expect(mockSetCurrentUser).toHaveBeenCalledTimes(1);
		expect(mockSetCurrentUser).toHaveBeenLastCalledWith(NEW_USER);
		expect(mockOpen).toHaveBeenCalledTimes(1);
		expect(mockOpen).toHaveBeenLastCalledWith(NETWORK, NEW_USER);
		expect(mockClearEngineCache).toHaveBeenCalledTimes(1);
		// Order: re-open (writes ctx.user) before the cache drop, then the network engine is rebuilt.
		expect(mockOpen.mock.invocationCallOrder[0]!).toBeLessThan(mockClearEngineCache.mock.invocationCallOrder[0]!);
		expect(mockGetEngineCalls[mockGetEngineCalls.length - 1]).toBe("network");
	});

	it("selected network: re-opens the network selectNetwork opened", async () => {
		const SELECTED = { ...NETWORK, hash: "selected" };
		await mount();
		await renderer.act(async () => {
			await captured!.selectNetwork(SELECTED);
		});
		mockOpen.mockClear();
		mockStoredUser = NEW_USER;
		await renderer.act(async () => {
			await captured!.rebindDeviceUser!();
		});
		expect(mockOpen).toHaveBeenCalledTimes(1);
		expect(mockOpen).toHaveBeenLastCalledWith(SELECTED, NEW_USER);
		expect(mockClearEngineCache).toHaveBeenCalledTimes(1);
	});

	it("no open network: binds the user for the next open and opens nothing", async () => {
		await mount();
		expect(captured!.hasNetwork).toBe(false);
		mockStoredUser = NEW_USER;
		await renderer.act(async () => {
			await captured!.rebindDeviceUser!();
		});
		expect(mockSetCurrentUser).toHaveBeenLastCalledWith(NEW_USER);
		expect(mockOpen).not.toHaveBeenCalled();
		expect(mockClearEngineCache).not.toHaveBeenCalled();
	});

	it("a failed re-open rejects and leaves the cached engines alone", async () => {
		mockRecent = [NETWORK];
		await mount();
		mockOpen.mockRejectedValueOnce(new Error("peer unavailable"));
		mockStoredUser = NEW_USER;
		let caught: unknown;
		await renderer.act(async () => {
			await captured!.rebindDeviceUser!().catch((e: unknown) => {
				caught = e;
			});
		});
		expect(caught).toBeInstanceOf(Error);
		expect(mockClearEngineCache).not.toHaveBeenCalled();
	});
});
