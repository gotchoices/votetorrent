/**
 * O-06 failure paths of the boot / select identity repair (harness copied from
 * AppProvider.identityRepair.test.tsx):
 *  - B-1 (REVIEW WR-R4-03): a repair that persisted but whose re-bind fails is rolled back, so
 *    storage, factory, network ctx and engine cache all end on the old id together.
 *  - B-2 (REVIEW WR-R4-04): the repair's reads are bounded by IDENTITY_REPAIR_BUDGET_MS; past it
 *    boot / select go on and the late repair is told not to write. A repair already writing is
 *    waited for.
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
const mockRollback = jest.fn(async (_pair: unknown) => true);
jest.mock("../../engines/device-identity-repair", () => ({
	repairDeviceIdentityForkIfNeeded: (deps: unknown) => mockRepair(deps),
	rollbackDeviceIdentityRepair: (pair: unknown) => mockRollback(pair),
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
const { AppProvider, useApp, IDENTITY_REPAIR_BUDGET_MS } = require("../AppProvider");

let captured: { selectNetwork: (ref: unknown) => Promise<void>; hasNetwork: boolean } | undefined;
function Probe() {
	captured = useApp();
	return <Text>probe</Text>;
}

async function mount() {
	await renderer.act(async () => {
		renderer.create(
			<AppProvider>
				<Probe />
			</AppProvider>,
		);
		for (let i = 0; i < 20; i++) await Promise.resolve();
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	mockGetEngineCalls.length = 0;
	mockRecent = [];
	captured = undefined;
	jest.spyOn(console, "info").mockImplementation(() => {});
});

describe("AppProvider identity repair failure paths", () => {
	beforeEach(() => {
		mockOpen.mockImplementation(async () => undefined);
	});

	it("B-1 boot: a repaired id whose re-open fails is rolled back everywhere (WR-R4-03)", async () => {
		mockRecent = [NETWORK];
		mockRepair.mockResolvedValue({ outcome: "repaired", user: REPAIRED_USER });
		mockOpen.mockImplementation(async (_n: unknown, u: unknown) => {
			if (u === REPAIRED_USER) throw new Error("cohort-unreachable");
			return undefined;
		});
		jest.spyOn(console, "warn").mockImplementation(() => {});
		await mount();
		expect(mockRepair).toHaveBeenCalledTimes(1);
		expect(mockRollback).toHaveBeenCalledWith({ fromUserId: mockStoredUser.id, toUserId: REPAIRED_USER.id });
		expect(mockSetCurrentUser).toHaveBeenLastCalledWith(mockStoredUser);
		expect(mockOpen).toHaveBeenLastCalledWith(NETWORK, mockStoredUser);
		expect(mockClearEngineCache).toHaveBeenCalledTimes(1);
		// the network engine is rebuilt (against the old user) after the cache was dropped
		expect(mockGetEngineCalls.filter((n) => n === "network").length).toBe(2);
	});

	it("B-1 selectNetwork: the same rollback, and the select still completes", async () => {
		mockRepair.mockResolvedValue({ outcome: "repaired", user: REPAIRED_USER });
		mockOpen.mockImplementation(async (_n: unknown, u: unknown) => {
			if (u === REPAIRED_USER) throw new Error("cohort-unreachable");
			return undefined;
		});
		jest.spyOn(console, "warn").mockImplementation(() => {});
		await mount();
		await renderer.act(async () => {
			await captured!.selectNetwork(NETWORK);
		});
		expect(mockRollback).toHaveBeenCalledTimes(1);
		expect(mockSetCurrentUser).toHaveBeenLastCalledWith(mockStoredUser);
		expect(mockOpen).toHaveBeenLastCalledWith(NETWORK, mockStoredUser);
	});

	it("B-1 control: a successful re-bind never rolls back", async () => {
		mockRecent = [NETWORK];
		mockOpen.mockImplementation(async () => undefined);
		mockRepair.mockResolvedValue({ outcome: "repaired", user: REPAIRED_USER });
		await mount();
		expect(mockRollback).not.toHaveBeenCalled();
		expect(mockSetCurrentUser).toHaveBeenLastCalledWith(REPAIRED_USER);
	});
});

describe("AppProvider identity repair time budget (WR-R4-04)", () => {
	type Deps = { shouldPersist?: () => boolean };
	let gate: { release: (v: { outcome: string; user?: unknown }) => void } | undefined;
	let seenDeps: Deps | undefined;

	beforeEach(() => {
		jest.useFakeTimers();
		mockOpen.mockImplementation(async () => undefined);
		gate = undefined;
		seenDeps = undefined;
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	function hangingRepair(persistFirst: boolean) {
		mockRepair.mockImplementation((deps: unknown) => {
			seenDeps = deps as Deps;
			if (persistFirst) expect(seenDeps.shouldPersist?.()).toBe(true);
			return new Promise((resolve) => {
				gate = { release: resolve };
			});
		});
	}

	// The provider renders its children only once boot settles, so no probe yet means not selected.
	const networkSelected = () => captured?.hasNetwork === true;

	async function advance(ms: number) {
		await renderer.act(async () => {
			jest.advanceTimersByTime(ms);
			for (let i = 0; i < 20; i++) await Promise.resolve();
		});
	}

	it("B-2 boot: a repair still reading when the budget is spent no longer holds boot, and may not write", async () => {
		mockRecent = [NETWORK];
		hangingRepair(false);
		await mount();
		expect(mockRepair).toHaveBeenCalledTimes(1);
		expect(networkSelected()).toBe(false);

		await advance(IDENTITY_REPAIR_BUDGET_MS - 1);
		expect(networkSelected()).toBe(false);
		await advance(1);
		expect(networkSelected()).toBe(true);

		// the late repair finishes its reads: it is told not to write
		expect(seenDeps!.shouldPersist!()).toBe(false);
		await renderer.act(async () => {
			gate!.release({ outcome: "abandoned" });
			for (let i = 0; i < 20; i++) await Promise.resolve();
		});
		expect(mockSetCurrentUser).toHaveBeenLastCalledWith(mockStoredUser);
		expect(mockClearEngineCache).not.toHaveBeenCalled();
	});

	it("B-2 boot: a repair that already began writing is waited for past the budget", async () => {
		mockRecent = [NETWORK];
		hangingRepair(true);
		await mount();
		await advance(IDENTITY_REPAIR_BUDGET_MS * 2);
		expect(networkSelected()).toBe(false);
		await renderer.act(async () => {
			gate!.release({ outcome: "repaired", user: REPAIRED_USER });
			for (let i = 0; i < 20; i++) await Promise.resolve();
		});
		expect(networkSelected()).toBe(true);
		expect(mockSetCurrentUser).toHaveBeenLastCalledWith(REPAIRED_USER);
	});

	it("B-2 selectNetwork: resolves once the budget is spent, with the repair still reading", async () => {
		hangingRepair(false);
		await mount();
		let settled = false;
		await renderer.act(async () => {
			captured!.selectNetwork(NETWORK).then(() => (settled = true));
			for (let i = 0; i < 20; i++) await Promise.resolve();
		});
		expect(settled).toBe(false);
		await advance(IDENTITY_REPAIR_BUDGET_MS);
		expect(settled).toBe(true);
		expect(networkSelected()).toBe(true);
		expect(seenDeps!.shouldPersist!()).toBe(false);
	});
});
