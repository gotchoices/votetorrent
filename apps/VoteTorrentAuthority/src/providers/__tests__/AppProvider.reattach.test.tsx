/**
 * AppProvider.reattach.test.tsx — R2 unit coverage (58-05, D-08/D-09/D-10).
 *
 * Proves the cold-start re-attach race is REMOVED (not survived): the init
 * effect awaits CadreNodeProvider's `nodeSettled` (Task 1) before its first
 * `factory.setNode(...)` / `NetworksEngine.open()` call, bounded by
 * `NODE_SETTLE_TIMEOUT_MS` and resolving (never rejecting) to a solo
 * default. Five behaviours, each run against the UNCHANGED AppProvider.tsx
 * first and recorded RED in the SUMMARY (see the plan's acceptance
 * criteria) before being trusted green.
 *
 * `EngineFactory` is faked so the whole instrument is "which node did the
 * factory hold at the moment NetworksEngine.open() was actually called" —
 * the ONLY way to observe which DbFactory backend a real dispatch would
 * have chosen (mirrors the lazy-dispatch shape in engine-factory.ts).
 *
 * House mocking style: named `mock*` module-scope jest.fns behind
 * `jest.mock` factories (AddNetworkScreen.provisioning.test.tsx), with the
 * module under test `require()`'d after all mock setup (rn-db-factory.test.ts
 * / CadreNodeProvider.test.tsx) so mock-prefixed config variables are
 * guaranteed initialized before the mocked modules are first required.
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
let mockOpenShouldReject = false;
// When true, getNetworksEngine().open() returns a promise the test resolves/rejects
// itself via mockOpenController — lets a test observe the PENDING (syncing) state and
// control exactly when/how the boot re-attach settles (escape / cleanup cases).
let mockOpenDeferred = false;
let mockOpenController: { resolve: () => void; reject: (err: unknown) => void } | null = null;
// When true, open() on the SOLO backend (factory node null) rejects the way the real
// NetworksEngine does for a network whose store lives only in a strand: the D-05
// isSchemaInitialized gate finds no marker in the empty solo store.
let mockOpenRejectsOnSolo = false;
// When true, getRecentNetworks() returns a promise the test resolves itself, so a test can land
// the node's settlement BETWEEN the recent-networks read and the open.
let mockRecentDeferred = false;
let mockRecentController: { resolve: () => void } | null = null;

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
				if (mockRecentDeferred) {
					await new Promise<void>((resolve) => {
						mockRecentController = { resolve };
					});
				}
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
				if (mockOpenShouldReject) {
					throw new Error("open failed");
				}
				if (mockOpenRejectsOnSolo && this.currentNode === null) {
					throw new Error("Network not opened in this session — use create() first");
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
const { Text, TouchableOpacity } = require("react-native");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppProvider, useApp } = require("../AppProvider");

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

function findByTestId(tr: import("react-test-renderer").ReactTestRenderer, id: string) {
	return tr.root.findAll(
		(n: import("react-test-renderer").ReactTestInstance) => n.props.testID === id && typeof n.type !== "string",
	)[0];
}

function findTryAgainButton(tr: import("react-test-renderer").ReactTestRenderer) {
	return findByTestId(tr, "boot-error-try-again");
}

function findStartFreshButton(tr: import("react-test-renderer").ReactTestRenderer) {
	return findByTestId(tr, "boot-syncing-start-fresh");
}

/** True when the boot error view is rendered (non-vacuous replacement for the old copy absence checks). */
function hasBootErrorView(tr: import("react-test-renderer").ReactTestRenderer): boolean {
	return findByTestId(tr, "boot-error-view") !== undefined;
}

function findTouchableWithText(tr: import("react-test-renderer").ReactTestRenderer, text: string) {
	const touchables = tr.root.findAllByType(TouchableOpacity);
	return touchables.find(
		(t: import("react-test-renderer").ReactTestInstance) =>
			t.findAll((n: import("react-test-renderer").ReactTestInstance) => n.type === Text && n.props.children === text)
				.length > 0,
	);
}

/** True if the localized Syncing label (echoed key 'syncSyncing') is rendered anywhere. */
function hasSyncingLabel(tr: import("react-test-renderer").ReactTestRenderer): boolean {
	return JSON.stringify(tr.toJSON()).includes("syncSyncing");
}

beforeEach(() => {
	jest.clearAllMocks();
	mockEngineFactoryInstances.length = 0;
	mockNetworksToReturn = [{ id: "net1" }];
	mockOpenShouldReject = false;
	mockOpenDeferred = false;
	mockOpenController = null;
	mockOpenRejectsOnSolo = false;
	mockRecentDeferred = false;
	mockRecentController = null;
	mockCadreHook.current = defaultCadreHookValue();
});

afterEach(() => {
	jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AppProvider cold-start re-attach — D-08/D-09/D-10 (58-05)", () => {
	it(
		'boot settles "ready": the first (and only) open() observes the live node already ' +
			"dispatched into the factory — never null ahead of it (RED today: opens with null)",
		async () => {
			const fakeNode: FakeNode = { tag: "live-node" };
			mockCadreHook.current = {
				...defaultCadreHookValue(),
				nodeSettled: Promise.resolve({ status: "ready", node: fakeNode }),
			};

			renderApp();
			await flushMicrotasks();

			const factory = mockEngineFactoryInstances[0];
			expect(factory.openCalls.length).toBe(1);
			expect(factory.openCalls[0].node).toBe(fakeNode);
			expect(mockHideSplash).toHaveBeenCalledTimes(1);
		},
	);

	it('boot settles "failed": setNode(null), open() still runs on the solo backend, init completes (no hang)', async () => {
		mockCadreHook.current = {
			...defaultCadreHookValue(),
			nodeSettled: Promise.resolve({ status: "failed", node: null }),
		};

		renderApp();
		await flushMicrotasks();

		const factory = mockEngineFactoryInstances[0];
		expect(factory.openCalls.length).toBe(1);
		expect(factory.openCalls[0].node).toBeNull();
		expect(mockHideSplash).toHaveBeenCalledTimes(1);
	});

	it(
		"nodeSettled never settles: no open() before the bound elapses (RED today: opens immediately); " +
			"after NODE_SETTLE_TIMEOUT_MS, init completes on the solo default",
		async () => {
			jest.useFakeTimers();
			mockCadreHook.current = {
				...defaultCadreHookValue(),
				// eslint-disable-next-line @typescript-eslint/no-empty-function
				nodeSettled: new Promise<{ status: "ready" | "failed"; node: FakeNode | null }>(() => {}),
			};

			renderApp();
			await renderer.act(async () => {
				await Promise.resolve();
				await Promise.resolve();
			});

			const factory = mockEngineFactoryInstances[0];
			expect(factory.openCalls.length).toBe(0);
			expect(mockHideSplash).not.toHaveBeenCalled();

			// NODE_SETTLE_TIMEOUT_MS = 15000 (AppProvider.tsx, module-scope, not exported).
			await renderer.act(async () => {
				await jest.advanceTimersByTimeAsync(15000);
			});

			expect(factory.openCalls.length).toBe(1);
			expect(factory.openCalls[0].node).toBeNull();
			expect(mockHideSplash).toHaveBeenCalledTimes(1);
		},
	);

	it(
		"a re-render in which node changes from null to a live node produces no second open() " +
			"(RED today: the [initNonce, node] dep array fires a second init)",
		async () => {
			const fakeNode: FakeNode = { tag: "live-node" };
			mockCadreHook.current = {
				...defaultCadreHookValue(),
				nodeSettled: Promise.resolve({ status: "ready", node: fakeNode }),
			};

			function Harness({ generation }: { generation: number }) {
				// `generation` exists only to force React to re-render this subtree —
				// AppProvider reads the mocked hook fresh on every render.
				void generation;
				return (
					<AppProvider>
						<Text>child-rendered</Text>
					</AppProvider>
				);
			}

			let tr: import("react-test-renderer").ReactTestRenderer;
			renderer.act(() => {
				tr = renderer.create(<Harness generation={0} />);
			});
			await flushMicrotasks();

			const factory = mockEngineFactoryInstances[0];
			expect(factory.openCalls.length).toBe(1);

			// Simulate CadreNode boot completing AFTER the settle already ran: the
			// hook's `node` transitions null -> live, forcing AppProvider to
			// re-render (mirrors the real peer-count effect committing `node`).
			mockCadreHook.current = { ...mockCadreHook.current, node: fakeNode };
			renderer.act(() => {
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				tr!.update(<Harness generation={1} />);
			});
			await flushMicrotasks();

			expect(factory.openCalls.length).toBe(1);
		},
	);

	it('CR-02 "Try Again" survives: when open() rejects, the error view renders, and pressing it runs a second init (second open())', async () => {
		mockOpenShouldReject = true;
		mockCadreHook.current = {
			...defaultCadreHookValue(),
			nodeSettled: Promise.resolve({ status: "failed", node: null }),
		};

		const tr = renderApp();
		await flushMicrotasks();

		const factory = mockEngineFactoryInstances[0];
		expect(factory.openCalls.length).toBe(1);

		const tryAgain = findTryAgainButton(tr);
		expect(tryAgain).toBeDefined();

		renderer.act(() => {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			tryAgain!.props.onPress();
		});
		await flushMicrotasks();

		expect(factory.openCalls.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Quick task 260928-kkf — "Syncing + escape button" (locked decision).
//
// A pending boot re-attach (open() deferred via mockOpenDeferred) surfaces the
// localized Syncing label as soon as syncState is 'syncing', and — ONLY once the
// factory's first-sync listener has fired once (simulating the first
// StrandAwaitingFirstSyncError budget elapsing) — the existing Start Fresh action
// under it. Pressing that escape marks the run cancelled and runs the SAME
// clearEngineCache()-based handler as the error view.
// ---------------------------------------------------------------------------
describe("AppProvider boot 'still syncing' surface + escape — quick task 260928-kkf", () => {
	it("hides the splash and shows the Syncing label while a boot re-attach is pending; resolves to isInitialized with no error once open() settles", async () => {
		mockOpenDeferred = true;
		mockCadreHook.current = {
			...defaultCadreHookValue(),
			syncState: "syncing",
			nodeSettled: Promise.resolve({ status: "failed", node: null }),
		};

		const tr = renderApp();
		await flushMicrotasks();

		expect(mockHideSplash).toHaveBeenCalledTimes(1);
		expect(hasSyncingLabel(tr)).toBe(true);
		expect(findStartFreshButton(tr)).toBeUndefined();

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		mockOpenController!.resolve();
		await flushMicrotasks();

		const factory = mockEngineFactoryInstances[0];
		expect(factory.openCalls.length).toBe(1);
		expect(JSON.stringify(tr.toJSON())).toContain("child-rendered");
		expect(hasBootErrorView(tr)).toBe(false);
	});

	it("(d) hides Start Fresh until the first-sync listener fires once, then shows it under the Syncing label", async () => {
		mockOpenDeferred = true;
		mockCadreHook.current = {
			...defaultCadreHookValue(),
			syncState: "syncing",
			nodeSettled: Promise.resolve({ status: "failed", node: null }),
		};

		const tr = renderApp();
		await flushMicrotasks();

		expect(findStartFreshButton(tr)).toBeUndefined();

		const factory = mockEngineFactoryInstances[0];
		renderer.act(() => {
			factory.triggerFirstSync("networkhash123");
		});
		await flushMicrotasks();

		expect(hasSyncingLabel(tr)).toBe(true);
		expect(findStartFreshButton(tr)).toBeDefined();
	});

	it("(e) pressing the syncing-view Start Fresh runs clearEngineCache and resolves to isInitialized with no error, even if the pending open() later rejects", async () => {
		mockOpenDeferred = true;
		mockCadreHook.current = {
			...defaultCadreHookValue(),
			syncState: "syncing",
			nodeSettled: Promise.resolve({ status: "failed", node: null }),
		};

		const tr = renderApp();
		await flushMicrotasks();

		const factory = mockEngineFactoryInstances[0];
		renderer.act(() => {
			factory.triggerFirstSync("networkhash123");
		});
		await flushMicrotasks();

		const startFresh = findStartFreshButton(tr);
		expect(startFresh).toBeDefined();

		renderer.act(() => {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			startFresh!.props.onPress();
		});
		await flushMicrotasks();

		expect(factory.clearEngineCache).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(tr.toJSON())).toContain("child-rendered");
		expect(hasBootErrorView(tr)).toBe(false);

		// The superseded open() rejecting AFTER the escape must write no state —
		// no error view, no console noise.
		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
		renderer.act(() => {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			mockOpenController!.reject(new Error("open failed after escape"));
		});
		await flushMicrotasks();

		expect(hasBootErrorView(tr)).toBe(false);
		for (const call of errorSpy.mock.calls) {
			expect(String(call[0])).not.toContain("not wrapped in act");
		}
		errorSpy.mockRestore();
	});

	it("(c) unmounting while open() is pending cancels the wait and deregisters the listener; a later rejection writes no state", async () => {
		mockOpenDeferred = true;
		mockCadreHook.current = {
			...defaultCadreHookValue(),
			syncState: "syncing",
			nodeSettled: Promise.resolve({ status: "failed", node: null }),
		};

		const tr = renderApp();
		await flushMicrotasks();

		const factory = mockEngineFactoryInstances[0];
		expect(factory.openCalls.length).toBe(1);

		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
		renderer.act(() => {
			tr.unmount();
		});

		expect(factory.cancelPendingStrandWaits).toHaveBeenCalledTimes(1);
		// The listener registration effect's cleanup deregisters LAST with undefined.
		expect(
			factory.setFirstSyncListenerCalls[factory.setFirstSyncListenerCalls.length - 1],
		).toBeUndefined();

		renderer.act(() => {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			mockOpenController!.reject(new Error("open failed after unmount"));
		});
		await flushMicrotasks();

		for (const call of errorSpy.mock.calls) {
			expect(String(call[0])).not.toContain("not wrapped in act");
		}
		errorSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// Late settle after the bounded wait (debug authority-reattach-after-settle-timeout).
//
// On a loaded device the CadreNode can settle AFTER NODE_SETTLE_TIMEOUT_MS: 64-53's
// relaunched keyholder logged `node settle: timeout 24387`, and the Redmi in 64-52
// logged `timeout 16957` after its control-store recreate. The timed-out run dispatches
// solo, a strand-only network cannot open solo ("Network not opened in this session"),
// and nothing re-ran init once the node was live — the app sat on the boot error view
// until the officer pressed Try Again or relaunched.
// ---------------------------------------------------------------------------
describe("AppProvider — a node that settles after the bounded wait", () => {
	function deferredSettle() {
		let resolve!: (v: { status: "ready" | "failed"; node: FakeNode | null }) => void;
		const promise = new Promise<{ status: "ready" | "failed"; node: FakeNode | null }>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}

	const seen: { hasNetwork: boolean | null } = { hasNetwork: null };
	function HasNetworkProbe() {
		seen.hasNetwork = useApp().hasNetwork;
		return null;
	}

	function renderWithProbe() {
		let tr: import("react-test-renderer").ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(
				<AppProvider>
					<HasNetworkProbe />
				</AppProvider>,
			);
		});
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		return tr!;
	}

	beforeEach(() => {
		seen.hasNetwork = null;
	});

	it("re-attaches on the live node once it settles ready after a timed-out, failed solo attempt", async () => {
		jest.useFakeTimers();
		const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
		mockOpenRejectsOnSolo = true;
		const settle = deferredSettle();
		mockCadreHook.current = { ...defaultCadreHookValue(), nodeSettled: settle.promise };

		const tr = renderWithProbe();
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(15000);
		});

		const factory = mockEngineFactoryInstances[0];
		expect(factory.openCalls.length).toBe(1);
		expect(factory.openCalls[0].node).toBeNull();
		expect(hasBootErrorView(tr)).toBe(true);

		const liveNode: FakeNode = { tag: "late-live-node" };
		await renderer.act(async () => {
			settle.resolve({ status: "ready", node: liveNode });
			await jest.advanceTimersByTimeAsync(0);
		});
		await flushMicrotasks(20);

		expect(factory.openCalls.length).toBe(2);
		expect(factory.openCalls[1].node).toBe(liveNode);
		expect(hasBootErrorView(tr)).toBe(false);
		expect(seen.hasNetwork).toBe(true);
		errSpy.mockRestore();
		infoSpy.mockRestore();
	});

	it("abandons a solo attempt still in flight when the node settles ready, and re-attaches on the live node", async () => {
		jest.useFakeTimers();
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
		mockOpenDeferred = true;
		const settle = deferredSettle();
		mockCadreHook.current = { ...defaultCadreHookValue(), nodeSettled: settle.promise };

		const tr = renderWithProbe();
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(15000);
		});
		const factory = mockEngineFactoryInstances[0];
		expect(factory.openCalls.length).toBe(1);
		expect(factory.openCalls[0].node).toBeNull();
		const staleOpen = mockOpenController!;

		const liveNode: FakeNode = { tag: "late-live-node" };
		await renderer.act(async () => {
			settle.resolve({ status: "ready", node: liveNode });
			await jest.advanceTimersByTimeAsync(0);
		});
		await flushMicrotasks(20);

		expect(factory.openCalls.length).toBe(2);
		expect(factory.openCalls[1].node).toBe(liveNode);
		// The re-run's own open is pending; let it succeed.
		await renderer.act(async () => {
			mockOpenController!.resolve();
			await Promise.resolve();
		});
		await flushMicrotasks(20);
		expect(seen.hasNetwork).toBe(true);

		// The superseded solo open failing later writes nothing.
		await renderer.act(async () => {
			staleOpen.reject(new Error("Network not opened in this session — use create() first"));
			await Promise.resolve();
		});
		await flushMicrotasks();
		expect(hasBootErrorView(tr)).toBe(false);
		expect(seen.hasNetwork).toBe(true);
		infoSpy.mockRestore();
	});

	it("a settle that lands before the re-attach reaches the open dispatches that one open on the live node (no solo attempt)", async () => {
		jest.useFakeTimers();
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
		mockOpenRejectsOnSolo = true;
		mockRecentDeferred = true;
		const settle = deferredSettle();
		// The hook's `node` stays null: on a starved device the provider's passive
		// [connectedPeers, node] effect lags the settlement, so it cannot be what tells the factory.
		mockCadreHook.current = { ...defaultCadreHookValue(), nodeSettled: settle.promise };

		renderWithProbe();
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(15000);
		});
		const factory = mockEngineFactoryInstances[0];
		expect(factory.openCalls.length).toBe(0);

		const liveNode: FakeNode = { tag: "late-live-node" };
		await renderer.act(async () => {
			settle.resolve({ status: "ready", node: liveNode });
			await jest.advanceTimersByTimeAsync(0);
		});
		await renderer.act(async () => {
			mockRecentController!.resolve();
			await jest.advanceTimersByTimeAsync(0);
		});
		await flushMicrotasks(20);

		expect(factory.openCalls.length).toBe(1);
		expect(factory.openCalls[0].node).toBe(liveNode);
		expect(seen.hasNetwork).toBe(true);
		infoSpy.mockRestore();
	});

	it("a late 'failed' settle does not re-run: one open, the error view and Try Again stay", async () => {
		jest.useFakeTimers();
		const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
		mockOpenRejectsOnSolo = true;
		const settle = deferredSettle();
		mockCadreHook.current = { ...defaultCadreHookValue(), nodeSettled: settle.promise };

		const tr = renderWithProbe();
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(15000);
		});
		await renderer.act(async () => {
			settle.resolve({ status: "failed", node: null });
			await jest.advanceTimersByTimeAsync(0);
		});
		await flushMicrotasks(20);

		const factory = mockEngineFactoryInstances[0];
		expect(factory.openCalls.length).toBe(1);
		expect(hasBootErrorView(tr)).toBe(true);
		expect(findTryAgainButton(tr)).toBeDefined();
		errSpy.mockRestore();
		infoSpy.mockRestore();
	});

	it("a timed-out run that attached (or had nothing to attach) is left alone when the node settles ready later", async () => {
		jest.useFakeTimers();
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
		const settle = deferredSettle();
		mockCadreHook.current = { ...defaultCadreHookValue(), nodeSettled: settle.promise };

		renderWithProbe();
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(15000);
		});
		expect(seen.hasNetwork).toBe(true);

		await renderer.act(async () => {
			settle.resolve({ status: "ready", node: { tag: "late-live-node" } });
			await jest.advanceTimersByTimeAsync(0);
		});
		await flushMicrotasks(20);

		const factory = mockEngineFactoryInstances[0];
		expect(factory.openCalls.length).toBe(1);
		expect(seen.hasNetwork).toBe(true);
		infoSpy.mockRestore();
	});

	it("a fresh install with no recent network is not re-run when the node settles ready later", async () => {
		jest.useFakeTimers();
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
		mockNetworksToReturn = [];
		const settle = deferredSettle();
		mockCadreHook.current = { ...defaultCadreHookValue(), nodeSettled: settle.promise };

		const tr = renderWithProbe();
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(15000);
		});
		await renderer.act(async () => {
			settle.resolve({ status: "ready", node: { tag: "late-live-node" } });
			await jest.advanceTimersByTimeAsync(0);
		});
		await flushMicrotasks(20);

		const factory = mockEngineFactoryInstances[0];
		expect(factory.openCalls.length).toBe(0);
		const networksEngine = (factory as unknown as { getNetworksEngine(): { getRecentNetworks: jest.Mock } }).getNetworksEngine();
		expect(networksEngine.getRecentNetworks).toHaveBeenCalledTimes(1);
		expect(seen.hasNetwork).toBe(false);
		expect(hasBootErrorView(tr)).toBe(false);
		infoSpy.mockRestore();
	});
});
