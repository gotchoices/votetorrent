/**
 * AppProvider.bootError.test.tsx — boot error classification on the re-attach path (gap 4).
 *
 * What this file asserts, against a faked `EngineFactory` whose `NetworksEngine.open()` replays a
 * queue of errors:
 *  - B-1: a peer-unavailable open failure is retried twice (5 s, then 15 s) and then shows the
 *    translated peer-unavailable view with Try Again and Start Fresh; the log carries the reason
 *    token only.
 *  - B-2: a generic failure is not retried, shows the generic translated copy, and still logs
 *    `Re-attach failed:` through console.error.
 *  - B-3: two peer-unavailable failures followed by a success heal with no error view.
 *  - B-4: unmounting during a retry delay stops further open() calls.
 *  - B-4b: Start Fresh from the syncing view during a retry delay cancels the retry.
 *  - B-5: the outer fatal path (the recent-networks read fails) shows generic copy.
 * Every view is checked for raw engine text (`expectNoRaw`): no Quereus message, table name, block
 * id or reason token ever reaches the screen.
 *
 * Mocking style: named `mock*` module-scope jest.fns behind `jest.mock` factories, with the module
 * under test `require()`'d after all mock setup so the mock-prefixed variables are initialised
 * before the mocked modules are first required.
 */

import React from "react";

// ---------------------------------------------------------------------------
// react-native-splash-view — native TurboModule, mocked inert (App.test.tsx
// convention).
// ---------------------------------------------------------------------------
const mockHideSplash = jest.fn();
jest.mock("react-native-splash-view", () => ({
	hideSplash: (...args: unknown[]) => mockHideSplash(...args),
}));

// ---------------------------------------------------------------------------
// react-i18next — AppProvider now calls useTranslation() for the Syncing label
// (quick task 260928-kkf). Echo the key (label copy is incidental; the KEY is
// what a real translation resource resolves) — same convention as
// NetworksScreen.bootstrap.test.tsx.
// ---------------------------------------------------------------------------
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

// ---------------------------------------------------------------------------
// @votetorrent/vote-engine/rn — only LocalStorageReact is touched by
// AppProvider's construction path; a bare class stub is enough.
// ---------------------------------------------------------------------------
jest.mock("@votetorrent/vote-engine/rn", () => ({
	LocalStorageReact: class {},
}));

// ---------------------------------------------------------------------------
// rn-db-factory — never actually invoked (EngineFactory is faked below and
// ignores the ctor arg), but the real module pulls in rn-leveldb / native
// LevelDB bindings at import time, so it must be mocked to load at all.
// ---------------------------------------------------------------------------
jest.mock("../../engines/rn-db-factory", () => ({
	rnDbFactory: jest.fn(),
}));

// ---------------------------------------------------------------------------
// ../CadreNodeProvider — the seam under test. `mockCadreHook.current` is
// mutated per-test (and once per re-render in the node-changes case) so the
// SAME test can drive different useCadreNode() return values across renders
// while keeping referential identity where the plan requires it.
// ---------------------------------------------------------------------------
interface FakeNode {
	tag: string;
}

interface CadreHookMockValue {
	node: FakeNode | null;
	syncState: "connected" | "syncing" | "offline";
	configFault: null;
	connectedPeers: (strandId: string) => number;
	nodeSettled: Promise<{ status: "ready" | "failed"; node: FakeNode | null }> | undefined;
}

function defaultCadreHookValue(): CadreHookMockValue {
	return {
		node: null,
		syncState: "offline",
		configFault: null,
		connectedPeers: () => 0,
		nodeSettled: Promise.resolve({ status: "failed", node: null }),
	};
}

const mockCadreHook: { current: CadreHookMockValue } = { current: defaultCadreHookValue() };

jest.mock("../CadreNodeProvider", () => ({
	useCadreNode: () => mockCadreHook.current,
}));

// ---------------------------------------------------------------------------
// ../engines/engine-factory — the whole instrument. FakeEngineFactory records
// every setNode() argument (in order) and, for every NetworksEngine.open()
// call, the node the factory held AT CALL TIME — that recording is the only
// way to observe which backend a real lazy DbFactory dispatch would have
// chosen (see engine-factory.ts:203-206's real dispatch this mirrors).
// ---------------------------------------------------------------------------
interface FakeEngineFactoryInstance {
	currentNode: FakeNode | null;
	setNodeCalls: Array<FakeNode | null>;
	openCalls: Array<{ node: FakeNode | null }>;
	clearEngineCache: jest.Mock;
	cancelPendingStrandWaits: jest.Mock;
	setFirstSyncListenerCalls: Array<((strandId: string) => void) | undefined>;
	/** Fires whatever listener is CURRENTLY registered — simulates the factory's own
	 * onAwaitingFirstSync callback firing once the first wait budget has elapsed. */
	triggerFirstSync: (strandId: string) => void;
}

const mockEngineFactoryInstances: FakeEngineFactoryInstance[] = [];
let mockNetworksToReturn: unknown[] = [{ id: "net1" }];
// Queue of errors open() throws; the LAST entry repeats forever.
let mockOpenErrors: unknown[] = [];
// When true, getNetworksEngine().open() returns a promise the test resolves/rejects
// itself via mockOpenController — lets a test observe the PENDING (syncing) state and
// control exactly when/how the boot re-attach settles (escape / cleanup cases).
let mockRecentNetworksError: unknown = null;
let mockOpenDeferred = false;
let mockOpenController: { resolve: () => void; reject: (err: unknown) => void } | null = null;

jest.mock("../../engines/engine-factory", () => {
	class FakeEngineFactory {
		currentNode: FakeNode | null = null;
		setNodeCalls: Array<FakeNode | null> = [];
		openCalls: Array<{ node: FakeNode | null }> = [];
		clearEngineCache = jest.fn();
		cancelPendingStrandWaits = jest.fn();
		setCurrentUser = jest.fn();
		setGetPeerCount = jest.fn();
		hasEngine = jest.fn(() => false);
		isAttestationVerifierProvisioned = jest.fn(() => false);

		private firstSyncListener: ((strandId: string) => void) | undefined;
		setFirstSyncListenerCalls: Array<((strandId: string) => void) | undefined> = [];

		setFirstSyncListener(listener: ((strandId: string) => void) | undefined) {
			this.firstSyncListener = listener;
			this.setFirstSyncListenerCalls.push(listener);
		}

		triggerFirstSync(strandId: string) {
			this.firstSyncListener?.(strandId);
		}

		private fakeNetworksEngine = {
			getRecentNetworks: jest.fn(async () => {
				if (mockRecentNetworksError) throw mockRecentNetworksError;
				return mockNetworksToReturn;
			}),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			open: jest.fn(async (_network: any, _user: any) => {
				// Record the node the factory holds RIGHT NOW — the whole point of
				// this fake: proves which backend a real lazy DbFactory dispatch
				// would have chosen at THIS call.
				this.openCalls.push({ node: this.currentNode });
				if (mockOpenDeferred) {
					return new Promise<void>((resolve, reject) => {
						mockOpenController = { resolve, reject };
					});
				}
				if (mockOpenErrors.length > 0) {
					throw mockOpenErrors.length === 1 ? mockOpenErrors[0] : mockOpenErrors.shift();
				}
			}),
		};

		constructor(_localStorage: unknown, _dbFactory: unknown) {
			mockEngineFactoryInstances.push(this as unknown as FakeEngineFactoryInstance);
		}

		setNode(node: FakeNode | null) {
			this.currentNode = node;
			this.setNodeCalls.push(node);
		}

		getNetworksEngine() {
			return this.fakeNetworksEngine;
		}

		getEngine = jest.fn(async (name?: string) => {
			// Dispatch by name (mirrors AddNetworkScreen.provisioning.test.tsx's
			// mockGetEngine — a single catch-all cannot serve both callers).
			if (name === "defaultUser") {
				return { get: jest.fn(async () => ({ name: "Device User" })), set: jest.fn() };
			}
			return {};
		});
	}

	return { EngineFactory: FakeEngineFactory };
});

// ---------------------------------------------------------------------------
// The remaining native/heavy modules AppProvider imports — every one is
// __DEV__-gated or fire-and-forget in the init path, mocked inert so import
// resolves and nothing throws mid-effect.
// ---------------------------------------------------------------------------
const mockGetOrCreateDeviceUser = jest.fn(async (name: string) => ({ id: "u1", name, activeKeys: [] }));
jest.mock("../../engines/device-user", () => ({
	getOrCreateDeviceUser: (name: string) => mockGetOrCreateDeviceUser(name),
}));

jest.mock("../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(),
}));

const mockMaybeSeedRegistrantFixtures = jest.fn(async () => undefined);
jest.mock("../../engines/registrant-dev-seed", () => ({
	maybeSeedRegistrantFixtures: () => mockMaybeSeedRegistrantFixtures(),
}));

jest.mock("../../screens/registration/attach-sync-bindings", () => ({
	attachSyncBindings: jest.fn(),
}));

jest.mock("../../engines/retired-dashboard-code-storage", () => ({
	sweepRetiredDashboardCodeStorage: jest.fn(async () => "removed"),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const renderer = require("react-test-renderer");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Text } = require("react-native");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppProvider } = require("../AppProvider");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderApp() {
	let tr: import("react-test-renderer").ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<AppProvider>
				<Text>child-rendered</Text>
			</AppProvider>,
		);
	});
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	return tr!;
}

/** Flush queued microtasks (settle races, awaited engine calls) without advancing any timer. */
async function flushMicrotasks(turns = 10) {
	await renderer.act(async () => {
		for (let i = 0; i < turns; i++) {
			// eslint-disable-next-line no-await-in-loop
			await Promise.resolve();
		}
	});
}

function byTestId(tr: import("react-test-renderer").ReactTestRenderer, id: string) {
	return tr.root.findAll((n: import("react-test-renderer").ReactTestInstance) => n.props.testID === id && typeof n.type !== "string");
}

/** True if the localized Syncing label (echoed key 'syncSyncing') is rendered anywhere. */
function hasSyncingLabel(tr: import("react-test-renderer").ReactTestRenderer): boolean {
	return JSON.stringify(tr.toJSON()).includes("syncSyncing");
}


const TEST19 =
	"QuereusError: Module 'optimystic' connect failed for table 'TidHighWater': Failed to initialize Optimystic table: Block default/app/TidHighWater is unavailable (cohort-unreachable): the repo could not determine whether it exists";

beforeEach(() => {
	jest.clearAllMocks();
	mockEngineFactoryInstances.length = 0;
	mockNetworksToReturn = [{ id: "net1" }];
	mockOpenErrors = [];
	mockRecentNetworksError = null;
	mockOpenDeferred = false;
	mockOpenController = null;
	mockCadreHook.current = defaultCadreHookValue();
	jest.useFakeTimers();
});

afterEach(() => {
	jest.useRealTimers();
});

async function advance(ms: number) {
	await renderer.act(async () => {
		jest.advanceTimersByTime(ms);
		for (let i = 0; i < 20; i++) await Promise.resolve();
	});
}

const RAW = ["QuereusError", "TidHighWater", "Block ", "cohort-unreachable", "disk corrupt", "Failed to load network"];
function expectNoRaw(tr: import("react-test-renderer").ReactTestRenderer) {
	const json = JSON.stringify(tr.toJSON());
	for (const s of RAW) expect(json).not.toContain(s);
}

describe("AppProvider boot error classification (gap 4)", () => {
	it("B-1: peer-unavailable after two retries shows the translated peer view", async () => {
		mockOpenErrors = [new Error(TEST19)];
		const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
		const tr = renderApp();
		await flushMicrotasks();
		expect(byTestId(tr, "boot-error-view").length).toBe(0);
		await advance(5000);
		await advance(15000);
		const factory = mockEngineFactoryInstances[0];
		expect(factory.openCalls.length).toBe(3);
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("peerReadUnavailableTitle");
		expect(json).toContain("peerReadUnavailableBody");
		expect(json).toContain("peerReadUnavailableRetry");
		expect(json).toContain("bootStartFresh");
		expectNoRaw(tr);
		expect(warn).toHaveBeenCalledWith("[AppProvider] re-attach peer read unavailable:", "cohort-unreachable");
		warn.mockRestore();
	});

	it("B-2: a generic failure is not retried and shows generic translated copy", async () => {
		mockOpenErrors = [new Error("disk corrupt")];
		const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
		const tr = renderApp();
		await flushMicrotasks();
		await advance(30000);
		expect(mockEngineFactoryInstances[0].openCalls.length).toBe(1);
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("bootNetworkLoadFailed");
		expect(json).toContain("bootTryAgain");
		expect(json).toContain("bootStartFresh");
		expectNoRaw(tr);
		// B-6: generic keeps console.error with the error object
		expect(err.mock.calls.some((c) => c[0] === "Re-attach failed:")).toBe(true);
		err.mockRestore();
	});

	it("B-7: an app-schema refusal (through open()'s cause) is not retried and shows the update copy, never raw text", async () => {
		const refusal = new Error("sApp schema cannot be applied to this strand's tables: ALTER TABLE App.TidHighWater ADD COLUMN");
		refusal.name = "AppSchemaRefusedError";
		mockOpenErrors = [new Error("Network not opened in this session — use create() first: x", { cause: refusal })];
		const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
		const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
		const tr = renderApp();
		await flushMicrotasks();
		await advance(30000);
		expect(mockEngineFactoryInstances[0].openCalls.length).toBe(1);
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("bootAppUpdateNeededTitle");
		expect(json).toContain("bootAppUpdateNeededBody");
		expect(json).toContain("bootTryAgain");
		expect(json).not.toContain("bootNetworkLoadFailed");
		expectNoRaw(tr);
		expect(json).not.toContain("sApp schema");
		expect(warn).toHaveBeenCalledWith("[AppProvider] re-attach refused: app schema");
		expect(err.mock.calls.some((c) => c[0] === "Re-attach failed:")).toBe(false);
		warn.mockRestore();
		err.mockRestore();
	});

	it("B-3: peer-unavailable twice then success heals with no error view", async () => {
		mockOpenErrors = [new Error(TEST19)];
		const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
		const tr = renderApp();
		await flushMicrotasks();
		expect(byTestId(tr, "boot-error-view").length).toBe(0);
		expect(JSON.stringify(tr.toJSON())).not.toContain("child-rendered");
		await advance(5000); // second call fails too
		expect(mockEngineFactoryInstances[0].openCalls.length).toBe(2);
		mockOpenErrors = []; // third call succeeds
		await advance(15000);
		expect(mockEngineFactoryInstances[0].openCalls.length).toBe(3);
		expect(byTestId(tr, "boot-error-view").length).toBe(0);
		expect(JSON.stringify(tr.toJSON())).toContain("child-rendered");
		warn.mockRestore();
	});

	it("B-4: unmount during a retry delay stops further open() calls", async () => {
		mockOpenErrors = [new Error(TEST19)];
		const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
		const tr = renderApp();
		await flushMicrotasks();
		const factory = mockEngineFactoryInstances[0];
		expect(factory.openCalls.length).toBe(1);
		renderer.act(() => tr.unmount());
		await advance(30000);
		expect(factory.openCalls.length).toBe(1);
		for (const c of err.mock.calls) expect(String(c[0])).not.toContain("not wrapped in act");
		err.mockRestore();
	});

	it("B-4b: Start Fresh from the syncing view during a delay cancels the retry", async () => {
		mockOpenErrors = [new Error(TEST19)];
		mockCadreHook.current = { ...defaultCadreHookValue(), syncState: "syncing" };
		const tr = renderApp();
		await flushMicrotasks();
		const factory = mockEngineFactoryInstances[0];
		renderer.act(() => {
			factory.triggerFirstSync("h");
		});
		await flushMicrotasks();
		const btn = byTestId(tr, "boot-syncing-start-fresh")[0];
		expect(btn).toBeDefined();
		renderer.act(() => btn.props.onPress());
		await advance(30000);
		expect(factory.openCalls.length).toBe(1);
		expect(byTestId(tr, "boot-error-view").length).toBe(0);
	});

	it("B-5: the outer fatal path shows generic copy, never raw text", async () => {
		mockRecentNetworksError = new Error(TEST19);
		const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
		const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
		const tr = renderApp();
		await flushMicrotasks();
		expectNoRaw(tr);
		expect(byTestId(tr, "boot-error-view").length).toBeGreaterThan(0);
		err.mockRestore();
		warn.mockRestore();
	});
});
