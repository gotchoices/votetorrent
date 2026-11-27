/**
 * BulkImportSyncScreen.test.tsx — D-01/D-04/D-28/D-31 proofs for the Bulk Import / Sync screen.
 *
 * DECLARED BLIND SPOT: this suite proves the screen's composition, ordering, seam invocation, and
 * PII discipline (T-48-20-01, T-48-20-02, T-48-20-05). It proves NOTHING about the peer-cluster
 * transport itself, whose leg ships **code-complete, unverified** (D-23) — a green run here must
 * never be cited as verification for it. It also proves nothing about whether an approving officer
 * actually holds `'vrg'`: that gate is a legibility control, not enforcement (Phase 999.1), and
 * this suite's "disabled, not hidden" assertions describe presentation only.
 *
 * 62-21 UPDATE (S1-S7): the peer card is now `PeerTransportStatusCard` (D-31, live numeric
 * counts), and a new `OfficerIntakeKeyCard` (D-04) sits above it. `useApp`, `officer-intake-key`
 * and `useDeviceSigningErrorHandler` are now mocked at module scope.
 *
 * PATTERN SOURCE: `RegistrantsListScreen.test.tsx` (mock preamble, press/present/absent/treeText
 * helpers) and `TransportStatusCard.test.tsx` (sentinel color palette, host-node testID filtering,
 * serializeSubtree for substring assertions against an arbitrary rendered subtree).
 */

import React from "react";
import renderer from "react-test-renderer";

jest.setTimeout(30_000);

// ---------------------------------------------------------------------------
// Mutable module-level slots. Prefixed `mock` so babel-plugin-jest-hoist allows the jest.mock()
// factories below to close over them despite being declared outside the factory's own scope.
// ---------------------------------------------------------------------------

let mockRouteParams: { authorityId: string } = { authorityId: "auth-1" };

let mockScopesResult: { scopes: string[] | undefined; loading: boolean } = {
	scopes: ["vrg"],
	loading: false,
};

// Sentinel palette — visually impossible, uniquely greppable color strings so a color assertion is
// an exact substring match rather than a judgement call (mirrors TransportStatusCard.test.tsx).
const SENTINEL_COLORS = {
	primary: "#PRIMAR0",
	background: "#BACKGR0",
	card: "#CARD000",
	text: "#TEXT000",
	border: "#BORDER0",
	notification: "#NOTIFY0",
	error: "#ERROR00",
	textSecondary: "#MUTED00",
	important: "#IMPORT0",
	success: "#SUCCES0",
	accent: "#ACCENT0",
	warning: "#WARN000",
	dark: "#DARK000",
	light: "#LIGHT00",
};

// ---------------------------------------------------------------------------
// Module mocks — module scope, before any import of the screen.
// ---------------------------------------------------------------------------

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({ colors: SENTINEL_COLORS }),
	useRoute: () => ({ params: mockRouteParams }),
}));

// t() echoes its key, and `key + "|" + "k1=v1,k2=v2"` (unquoted) when an options object is
// present — the rendered string is itself embedded inside JSON.stringify(tr.toJSON()) for
// tree-text assertions, and a quoted value would be double-escaped by that outer stringify.
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && Object.keys(options).length > 0
				? key +
				  "|" +
				  Object.entries(options)
						.map(([k, v]) => k + "=" + String(v))
						.join(",")
				: key,
	}),
}));

jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: () => mockScopesResult,
}));

const mockGetEngine = jest.fn(async () => ({}));
const mockResolveDeviceSigner = jest.fn(async () => async () => ({
	signerUserId: "u1",
	signerKey: "k1",
	signature: "sig1",
}));
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine, resolveDeviceSigner: mockResolveDeviceSigner }),
}));

type OfficerIntakeKeyDepsLike = { getEngine: unknown; createSigner: unknown };
const mockReadOfficerIntakeKeyState = jest.fn<Promise<string>, [OfficerIntakeKeyDepsLike, string]>(
	async () => "not-enabled",
);
const mockEnableOfficerEncryptedIntake = jest.fn<Promise<string>, [OfficerIntakeKeyDepsLike, string]>(
	async () => "enabled",
);
jest.mock("../officer-intake-key", () => ({
	readOfficerIntakeKeyState: (...args: unknown[]) => mockReadOfficerIntakeKeyState(...(args as [OfficerIntakeKeyDepsLike, string])),
	enableOfficerEncryptedIntake: (...args: unknown[]) => mockEnableOfficerEncryptedIntake(...(args as [OfficerIntakeKeyDepsLike, string])),
}));

interface DeviceSigningErrorOutcomeLike {
	handled: boolean;
	message?: string;
}
const mockHandleDeviceSigningError = jest.fn<DeviceSigningErrorOutcomeLike, [unknown]>(
	(_err: unknown) => ({ handled: false, message: undefined }),
);
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => mockHandleDeviceSigningError,
}));

// 62-25 (D-29): registration-bridge-config, device-signer and device-user are mocked at module
// scope — the screen now resolves the device signer directly for the bridge-URL save action.
// Default state: a saved https URL already exists (bridgeReady === true), so every PRE-EXISTING
// test in this file that presses `transport-sync-now-rest` keeps working unchanged; S8 overrides
// this per-case to exercise the unset/loading states.
interface BridgeConfigDepsLike {
	getEngine: unknown;
}
const mockReadRegistrationBridgeConfig = jest.fn<Promise<{ savedUrl: string | null; revision: number | undefined }>, [BridgeConfigDepsLike, string]>(
	async () => ({ savedUrl: "https://bridge.example/intake", revision: 1 }),
);
const mockSaveRegistrationBridgeUrl = jest.fn<
	Promise<{ outcome: string; config?: { savedUrl: string | null; revision: number | undefined } }>,
	[BridgeConfigDepsLike, string, string, unknown, number | undefined]
>(async (_deps, _authorityId, url) => ({ outcome: "saved", config: { savedUrl: url, revision: 2 } }));
jest.mock("../registration-bridge-config", () => ({
	// The model mock's isSaveableBridgeUrl: startsWith('https://') — a deliberately simpler rule
	// than the real 62-14 validator, sufficient for this screen's own gating assertions.
	isSaveableBridgeUrl: (url: string) => url.startsWith("https://"),
	readRegistrationBridgeConfig: (...args: unknown[]) =>
		mockReadRegistrationBridgeConfig(...(args as [BridgeConfigDepsLike, string])),
	saveRegistrationBridgeUrl: (...args: unknown[]) =>
		mockSaveRegistrationBridgeUrl(...(args as [BridgeConfigDepsLike, string, string, unknown, number | undefined])),
}));

const mockCreateDeviceSigner = jest.fn(async (_name: string) => async () => ({
	signerUserId: "u1",
	signerKey: "k1",
	signature: "sig1",
}));
jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: (name: string) => mockCreateDeviceSigner(name),
}));

const mockGetOrCreateDeviceUser = jest.fn(async (name: string) => ({ id: "u1", name, activeKeys: [] }));
jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: (name: string) => mockGetOrCreateDeviceUser(name),
}));

// ---------------------------------------------------------------------------
// The model — plain TypeScript, no mocked dependency of its own, safe to import directly.
// ---------------------------------------------------------------------------

import {
	clearSyncBindings,
	registerSyncBinding,
	resolveSyncBinding,
	resolveTransportCardState,
	toSyncErrorRefs,
	INERT_PEER_SYNC,
	type SyncBindingHandle,
	type TransportSyncReport,
} from "../bulk-import-sync-model";
import { OfficerIntakeKeyCard } from "../components/OfficerIntakeKeyCard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flushTicks(count: number): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < count; i++) {
			await Promise.resolve();
		}
	});
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { BulkImportSyncScreen } = require("../BulkImportSyncScreen");

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<BulkImportSyncScreen />);
	});
	await flushTicks(4);
	return tr;
}

/** Fires the real handler on a control reachable under `testID`. Asserting a non-empty candidate
 * list BEFORE firing turns a renamed/restructured control into a loud failure instead of a
 * silent no-op pass. */
async function press(tr: renderer.ReactTestRenderer, testID: string): Promise<void> {
	const wrapper = tr.root.findByProps({ testID });
	const candidates = wrapper.findAll((node) => typeof node.props.onPress === "function");
	expect(candidates.length).toBeGreaterThan(0);
	await renderer.act(async () => {
		candidates[0]!.props.onPress();
	});
	await flushTicks(4);
}

function present(tr: renderer.ReactTestRenderer, testID: string): void {
	expect(() => tr.root.findByProps({ testID })).not.toThrow();
}

function absent(tr: renderer.ReactTestRenderer, testID: string): void {
	expect(() => tr.root.findByProps({ testID })).toThrow();
}

function treeText(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}

/** `ReactTestInstance` has no `.toJSON()` (only the top-level renderer does) — walks a subtree and
 * concatenates each node's non-`children` props (JSON-stringified) plus leaf text, so substring
 * assertions can run against an arbitrary subtree. Mirrors TransportStatusCard.test.tsx. */
function serializeSubtree(node: renderer.ReactTestInstance): string {
	const parts: string[] = [];
	function visit(n: renderer.ReactTestInstance | string): void {
		if (typeof n === "string") {
			parts.push(n);
			return;
		}
		const { children: _children, ...rest } = n.props;
		try {
			parts.push(JSON.stringify(rest));
		} catch {
			// Non-serializable prop bag — skip, the leaf text/other props still get walked.
		}
		n.children.forEach(visit);
	}
	visit(node);
	return parts.join("|");
}

const BLOCK_TEST_IDS = [
	"bulk-import-sync-error",
	"rest-bridge-config-card",
	"transport-status-card-filesystem",
	"transport-status-card-rest",
	"officer-intake-key-card",
	"transport-status-card-p2p",
	"bulk-import-sync-errors-section",
];

/** Collects, IN RENDER ORDER, every host-node testID from `BLOCK_TEST_IDS` present in the tree. */
function orderedBlockIds(tr: renderer.ReactTestRenderer): string[] {
	return tr.root
		.findAll((node) => typeof node.type === "string" && BLOCK_TEST_IDS.includes(node.props.testID))
		.map((n) => n.props.testID as string);
}

function report(overrides: Partial<TransportSyncReport> = {}): TransportSyncReport {
	return {
		syncedAt: "2026-08-05T12:00:00Z",
		imported: 3,
		pending: 1,
		errorItemIds: [],
		...overrides,
	};
}

beforeEach(() => {
	// Deliberately NOT jest.resetModules(): the screen is required lazily inside renderScreen()
	// and, un-reset, resolves through the SAME cached `bulk-import-sync-model` module instance
	// this file imports at the top — so a binding registered here is visible to the screen's own
	// `resolveSyncBinding` calls. Resetting modules would split that into two separate registries.
	clearSyncBindings();
	mockRouteParams = { authorityId: "auth-1" };
	mockScopesResult = { scopes: ["vrg"], loading: false };
	mockGetEngine.mockClear();
	mockResolveDeviceSigner.mockClear();
	mockReadOfficerIntakeKeyState.mockClear();
	mockReadOfficerIntakeKeyState.mockImplementation(async () => "not-enabled");
	mockEnableOfficerEncryptedIntake.mockClear();
	mockEnableOfficerEncryptedIntake.mockImplementation(async () => "enabled");
	mockHandleDeviceSigningError.mockClear();
	mockHandleDeviceSigningError.mockImplementation(() => ({ handled: false, message: undefined }));
	mockReadRegistrationBridgeConfig.mockClear();
	mockReadRegistrationBridgeConfig.mockImplementation(async () => ({
		savedUrl: "https://bridge.example/intake",
		revision: 1,
	}));
	mockSaveRegistrationBridgeUrl.mockClear();
	mockSaveRegistrationBridgeUrl.mockImplementation(async (_deps, _authorityId, url) => ({
		outcome: "saved",
		config: { savedUrl: url, revision: 2 },
	}));
	mockCreateDeviceSigner.mockClear();
	mockCreateDeviceSigner.mockImplementation(async () => async () => ({
		signerUserId: "u1",
		signerKey: "k1",
		signature: "sig1",
	}));
	mockGetOrCreateDeviceUser.mockClear();
});

// ---------------------------------------------------------------------------
// S1 — the fixed render order.
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen — fixed render order (S1b, 62-25)", () => {
	it("error slot, rest-bridge-config-card, filesystem, rest, officer-intake-key-card, transport-status-card-p2p — the peer card is last", async () => {
		registerSyncBinding({
			id: "filesystem",
			syncNow: jest.fn(async () => report({ errorItemIds: ["req-0001"] })),
		});
		registerSyncBinding({
			id: "rest",
			syncNow: jest.fn(async () => report({ errorItemIds: ["req-0009"] })),
		});
		const tr = await renderScreen();
		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-rest");

		expect(orderedBlockIds(tr)).toEqual(BLOCK_TEST_IDS);
	});

	it("ordering holds even when nothing has anything to say yet", async () => {
		const tr = await renderScreen();

		expect(orderedBlockIds(tr)).toEqual([
			"bulk-import-sync-error",
			"rest-bridge-config-card",
			"transport-status-card-filesystem",
			"transport-status-card-rest",
			"officer-intake-key-card",
			"transport-status-card-p2p",
		]);
	});

	it("the unset-bridge hint sits directly under the REST card when no URL is saved", async () => {
		mockReadRegistrationBridgeConfig.mockImplementation(async () => ({ savedUrl: null, revision: 0 }));
		const tr = await renderScreen();

		const ids = tr.root
			.findAll(
				(node) =>
					typeof node.type === "string" &&
					["transport-status-card-rest", "registration-bridge-config-unset-hint", "officer-intake-key-card"].includes(
						node.props.testID,
					),
			)
			.map((n) => n.props.testID as string);
		expect(ids).toEqual([
			"transport-status-card-rest",
			"registration-bridge-config-unset-hint",
			"officer-intake-key-card",
		]);
	});
});

// ---------------------------------------------------------------------------
// Suite B — the Filesystem and REST cards are wired to real bindings.
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen — Filesystem/REST cards invoke a real attached binding", () => {
	for (const id of ["filesystem", "rest"] as const) {
		it(`Sync Now (${id}) calls the attached binding exactly once and drives the card to success`, async () => {
			const syncNow = jest.fn(async () => report());
			registerSyncBinding({ id, syncNow });
			const tr = await renderScreen();

			await press(tr, `transport-sync-now-${id}`);

			expect(syncNow).toHaveBeenCalledTimes(1);
			present(tr, `transport-status-${id}-success-heading`);
			present(tr, `transport-status-counts-${id}`);
		});

		it(`Sync Now (${id}) moves the card to error and swallows the rejection's text (T-48-20-02)`, async () => {
			const syncNow = jest.fn(async () => {
				throw new Error("SSN-123-45-6789-LEAKED");
			});
			registerSyncBinding({ id, syncNow });
			const tr = await renderScreen();

			await press(tr, `transport-sync-now-${id}`);

			present(tr, `transport-status-${id}-error-heading`);
			expect(treeText(tr)).not.toContain("SSN-123-45-6789-LEAKED");
		});

		it(`Sync Now (${id}) renders a bridge-listing failure as the error state, never a healthy sync, and never its text (S-3)`, async () => {
			const syncNow = jest.fn(async () => {
				throw new Error("registration bridge listing failed (status 401)");
			});
			registerSyncBinding({ id, syncNow });
			const tr = await renderScreen();

			await press(tr, `transport-sync-now-${id}`);

			present(tr, `transport-status-${id}-error-heading`);
			expect(treeText(tr)).not.toContain("registration bridge listing failed");
		});

		it(`Sync Now (${id}) with no binding registered renders the error variant without throwing`, async () => {
			const tr = await renderScreen();

			await expect(press(tr, `transport-sync-now-${id}`)).resolves.not.toThrow();

			present(tr, `transport-status-${id}-error-heading`);
		});
	}
});

// ---------------------------------------------------------------------------
// WR-16 in-flight guard — unchanged behaviour, testIDs unchanged.
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen — WR-16 in-flight guard", () => {
	it("(WR-16) repeated presses on one binding launch exactly ONE syncNow, and the control renders disabled while it is in flight", async () => {
		let release!: (r: any) => void;
		const filesystemSyncNow = jest.fn(
			() =>
				new Promise<any>((resolve) => {
					release = resolve;
				}),
		);
		registerSyncBinding({ id: "filesystem", syncNow: filesystemSyncNow });
		const tr = await renderScreen();

		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-filesystem");
		expect(filesystemSyncNow).toHaveBeenCalledTimes(1);

		const card = tr.root.findByProps({ testID: "transport-status-card-filesystem" });
		const disabledNode = card.findAll((node) => "disabled" in node.props)[0];
		expect(disabledNode!.props.disabled).toBe(true);

		await renderer.act(async () => {
			release(report({ imported: 3 }));
		});
		await flushTicks(4);

		await press(tr, "transport-sync-now-filesystem");
		expect(filesystemSyncNow).toHaveBeenCalledTimes(2);
	});

	it("(WR-16) the guard is PER BINDING — an in-flight filesystem sync does not block the REST control", async () => {
		let releaseFs!: (r: any) => void;
		const filesystemSyncNow = jest.fn(
			() =>
				new Promise<any>((resolve) => {
					releaseFs = resolve;
				}),
		);
		const restSyncNow = jest.fn(async () => report());
		registerSyncBinding({ id: "filesystem", syncNow: filesystemSyncNow });
		registerSyncBinding({ id: "rest", syncNow: restSyncNow });
		const tr = await renderScreen();

		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-rest");

		expect(filesystemSyncNow).toHaveBeenCalledTimes(1);
		expect(restSyncNow).toHaveBeenCalledTimes(1);

		await renderer.act(async () => {
			releaseFs(report());
		});
		await flushTicks(4);
	});

	it("(WR-16) a REJECTED sync releases the guard — the control must not latch permanently on failure", async () => {
		const filesystemSyncNow = jest.fn(async () => {
			throw new Error("transport unavailable");
		});
		registerSyncBinding({ id: "filesystem", syncNow: filesystemSyncNow });
		const tr = await renderScreen();

		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-filesystem");

		expect(filesystemSyncNow).toHaveBeenCalledTimes(2);
	});

	it("(WR-16) the no-binding path starts nothing and therefore must NOT latch the control", async () => {
		const tr = await renderScreen();
		await press(tr, "transport-sync-now-filesystem");
		const card = tr.root.findByProps({ testID: "transport-status-card-filesystem" });
		const disabledNode = card.findAll((node) => "disabled" in node.props)[0];
		expect(disabledNode!.props.disabled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// S2-S4 — the peer card: live counts, syncNow context, rejection handling, errors label.
// ---------------------------------------------------------------------------

function peerHandle(opts: { syncNow?: jest.Mock; readCounts?: jest.Mock }): SyncBindingHandle {
	return {
		id: "peer",
		syncNow: opts.syncNow ?? jest.fn(async () => report()),
		readCounts: opts.readCounts,
	};
}

describe("BulkImportSyncScreen — peer card live counts and sync (S2-S4, D-31)", () => {
	it("S2: readCounts is called on mount with {authorityId}, the counts render, and a press drives syncNow + a fresh readCounts", async () => {
		const readCounts = jest
			.fn()
			.mockResolvedValueOnce({ pending: 3, synced: 2, failed: 1 })
			.mockResolvedValueOnce({ pending: 0, synced: 5, failed: 0 });
		const syncNow = jest.fn(async () => report());
		registerSyncBinding(peerHandle({ syncNow, readCounts }));
		const tr = await renderScreen();

		expect(readCounts).toHaveBeenCalledWith({ authorityId: "auth-1" });
		let serialized = serializeSubtree(tr.root.findByProps({ testID: "transport-status-counts-p2p" }));
		expect(serialized).toContain("peerSyncCardPendingLabel|count=3");
		expect(serialized).toContain("peerSyncCardSyncedLabel|count=2");
		expect(serialized).toContain("peerSyncCardFailedLabel|count=1");

		await press(tr, "transport-try-peer-sync-p2p");

		expect(syncNow).toHaveBeenCalledWith({ authorityId: "auth-1" });
		expect(readCounts).toHaveBeenCalledTimes(2);
		serialized = serializeSubtree(tr.root.findByProps({ testID: "transport-status-counts-p2p" }));
		expect(serialized).toContain("peerSyncCardSyncedLabel|count=5");
	});

	it("S3: a readCounts rejection leaves the counts row absent and the thrown message appears nowhere in the tree", async () => {
		const readCounts = jest.fn(async () => {
			throw new Error("peer-count-secret-leak");
		});
		registerSyncBinding(peerHandle({ readCounts }));
		const tr = await renderScreen();

		absent(tr, "transport-status-counts-p2p");
		expect(treeText(tr)).not.toContain("peer-count-secret-leak");
	});

	it("S4: a peer error report renders an error row with peerSyncCardHeading and the identifier, not bulkImportSyncRestHeading", async () => {
		registerSyncBinding(
			peerHandle({ syncNow: jest.fn(async () => report({ errorItemIds: ["req-9"] })) }),
		);
		const tr = await renderScreen();
		await press(tr, "transport-try-peer-sync-p2p");

		present(tr, "bulk-import-sync-errors-section");
		const row = serializeSubtree(tr.root.findByProps({ testID: "bulk-import-sync-error-row-0" }));
		expect(row).toContain("peerSyncCardHeading");
		expect(row).toContain("req-9");
		expect(row).not.toContain("bulkImportSyncRestHeading");
	});

	it("the peer card renders when both real transports are unregistered, and its warning treatment survives a success", async () => {
		registerSyncBinding({ id: "filesystem", syncNow: jest.fn(async () => report()) });
		registerSyncBinding({ id: "rest", syncNow: jest.fn(async () => report()) });
		const tr = await renderScreen();
		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-rest");
		await press(tr, "transport-try-peer-sync-p2p");

		const peerCard = tr.root.findByProps({ testID: "transport-status-card-p2p" });
		const serialized = serializeSubtree(peerCard);
		expect(serialized).toContain(SENTINEL_COLORS.warning);
		expect(serialized).toContain("peerSyncCardCaveat");
	});

	it("the ordered block-testID array equality still holds with a peer binding attached", async () => {
		registerSyncBinding({
			id: "filesystem",
			syncNow: jest.fn(async () => report({ errorItemIds: ["req-0001"] })),
		});
		registerSyncBinding({
			id: "rest",
			syncNow: jest.fn(async () => report({ errorItemIds: ["req-0009"] })),
		});
		registerSyncBinding(peerHandle({}));
		const tr = await renderScreen();
		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-rest");
		await press(tr, "transport-try-peer-sync-p2p");

		expect(orderedBlockIds(tr)).toEqual(BLOCK_TEST_IDS);
	});

	it("INERT_PEER_SYNC itself is a no-op that returns undefined and throws nothing", () => {
		expect(() => expect(INERT_PEER_SYNC()).toBeUndefined()).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// S5 — the officer intake-key card.
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen — officer intake-key card (S5, D-04)", () => {
	it("a mocked 'not-enabled' state renders the enable button; pressing calls enableOfficerEncryptedIntake once with createSigner === mockResolveDeviceSigner", async () => {
		const tr = await renderScreen();
		present(tr, "officer-intake-key-enable");

		await press(tr, "officer-intake-key-enable");

		expect(mockEnableOfficerEncryptedIntake).toHaveBeenCalledTimes(1);
		const [deps, authorityId] = mockEnableOfficerEncryptedIntake.mock.calls[0]!;
		expect(authorityId).toBe("auth-1");
		expect((deps as { createSigner: unknown }).createSigner).toBe(mockResolveDeviceSigner);
		// The screen itself never calls the thunk — only the model layer does.
		expect(mockResolveDeviceSigner).not.toHaveBeenCalled();
	});

	it("a double press in one tick calls enableOfficerEncryptedIntake once (ref guard)", async () => {
		let resolveEnable!: (v: "enabled") => void;
		mockEnableOfficerEncryptedIntake.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveEnable = resolve;
				}),
		);
		const tr = await renderScreen();
		const wrapper = tr.root.findByProps({ testID: "officer-intake-key-enable" });
		const onPress = wrapper.findAll((node) => typeof node.props.onPress === "function")[0]!.props.onPress;
		await renderer.act(async () => {
			onPress();
			onPress();
		});
		await flushTicks(2);
		expect(mockEnableOfficerEncryptedIntake).toHaveBeenCalledTimes(1);
		await renderer.act(async () => {
			resolveEnable("enabled");
		});
		await flushTicks(4);
	});

	it("a rejection the handler marks { handled: true } shows no error", async () => {
		mockEnableOfficerEncryptedIntake.mockRejectedValueOnce(new Error("device-signing-cancel"));
		mockHandleDeviceSigningError.mockReturnValueOnce({ handled: true, message: undefined });
		const tr = await renderScreen();
		await press(tr, "officer-intake-key-enable");

		absent(tr, "officer-intake-key-error");
	});

	it("a handler result { handled: false, message: 'mapped-copy' } shows 'mapped-copy' instead of officerIntakeKeyError", async () => {
		mockEnableOfficerEncryptedIntake.mockRejectedValueOnce(new Error("raw"));
		mockHandleDeviceSigningError.mockReturnValueOnce({ handled: false, message: "mapped-copy" });
		const tr = await renderScreen();
		await press(tr, "officer-intake-key-enable");

		present(tr, "officer-intake-key-error");
		const row = serializeSubtree(tr.root.findByProps({ testID: "officer-intake-key-error" }));
		expect(row).toContain("mapped-copy");
		expect(row).not.toContain("officerIntakeKeyError");
	});

	it("a plain Error with { handled: false } shows officerIntakeKeyError, and the raw message appears nowhere in the tree", async () => {
		mockEnableOfficerEncryptedIntake.mockRejectedValueOnce(new Error("raw-text"));
		mockHandleDeviceSigningError.mockReturnValueOnce({ handled: false, message: undefined });
		const tr = await renderScreen();
		await press(tr, "officer-intake-key-enable");

		present(tr, "officer-intake-key-error");
		const row = serializeSubtree(tr.root.findByProps({ testID: "officer-intake-key-error" }));
		expect(row).toContain("officerIntakeKeyError");
		expect(treeText(tr)).not.toContain("raw-text");
	});

	it("a successful resolution switches the card to 'enabled' and refreshes the peer counts", async () => {
		const readCounts = jest
			.fn()
			.mockResolvedValueOnce({ pending: 0, synced: 0, failed: 0 })
			.mockResolvedValueOnce({ pending: 1, synced: 1, failed: 0 });
		registerSyncBinding(peerHandle({ readCounts }));
		const tr = await renderScreen();
		await press(tr, "officer-intake-key-enable");

		present(tr, "officer-intake-key-enabled");
		absent(tr, "officer-intake-key-enable");
		expect(readCounts).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// S6 — gating: disabled, not hidden (D-04 any-scope enable; D-31 'vrg'-gated peer control).
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen — S6 gating (disabled, not hidden)", () => {
	it("with scopes undefined (not an officer), both the enable button and the peer control are present and disabled", async () => {
		mockScopesResult = { scopes: undefined, loading: false };
		const tr = await renderScreen();

		for (const id of ["officer-intake-key-enable", "transport-try-peer-sync-p2p"]) {
			present(tr, id);
			const wrapper = tr.root.findByProps({ testID: id });
			const disabledNodes = wrapper.findAll((node) => node.props.disabled === true);
			expect(disabledNodes.length).toBeGreaterThanOrEqual(1);
		}
	});

	it("with scopes ['mel'] (an officer, no 'vrg'), the enable button is ENABLED (D-04: every current officer is a recipient) and the peer control stays disabled (needs 'vrg')", async () => {
		mockScopesResult = { scopes: ["mel"], loading: false };
		const tr = await renderScreen();

		const enableWrapper = tr.root.findByProps({ testID: "officer-intake-key-enable" });
		const enableDisabled = enableWrapper.findAll((node) => "disabled" in node.props)[0];
		expect(enableDisabled!.props.disabled).toBe(false);

		const peerWrapper = tr.root.findByProps({ testID: "transport-try-peer-sync-p2p" });
		const peerDisabled = peerWrapper.findAll((node) => "disabled" in node.props)[0];
		expect(peerDisabled!.props.disabled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// S8-S14 — the RestBridgeConfigCard integration (62-25, D-29).
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen — RestBridgeConfigCard integration (S8-S14, D-29)", () => {
	it("S8: while loading, the REST control is disabled and no hint renders; with savedUrl null it is present+disabled with the hint; with a saved URL and 'vrg' it is enabled and the hint is absent", async () => {
		mockReadRegistrationBridgeConfig.mockImplementation(
			() => new Promise(() => {}), // never resolves -> stays loading
		);
		let tr = await renderScreen();
		let wrapper = tr.root.findByProps({ testID: "transport-sync-now-rest" });
		let disabledNode = wrapper.findAll((node) => "disabled" in node.props)[0]!;
		expect(disabledNode.props.disabled).toBe(true);
		absent(tr, "registration-bridge-config-unset-hint");

		mockReadRegistrationBridgeConfig.mockReset();
		mockReadRegistrationBridgeConfig.mockImplementation(async () => ({ savedUrl: null, revision: 0 }));
		tr = await renderScreen();
		wrapper = tr.root.findByProps({ testID: "transport-sync-now-rest" });
		disabledNode = wrapper.findAll((node) => "disabled" in node.props)[0]!;
		expect(disabledNode.props.disabled).toBe(true);
		present(tr, "registration-bridge-config-unset-hint");

		mockReadRegistrationBridgeConfig.mockReset();
		mockReadRegistrationBridgeConfig.mockImplementation(async () => ({
			savedUrl: "https://bridge.example/intake",
			revision: 1,
		}));
		tr = await renderScreen();
		wrapper = tr.root.findByProps({ testID: "transport-sync-now-rest" });
		disabledNode = wrapper.findAll((node) => "disabled" in node.props)[0]!;
		expect(disabledNode.props.disabled).toBe(false);
		absent(tr, "registration-bridge-config-unset-hint");
	});

	it("S9: Save resolves the device signer then calls saveRegistrationBridgeUrl({getEngine}, authorityId, url, sign, revision) exactly once; two presses in one tick call it once; 'saved' shows SavedConfirm and enables the REST control without remounting", async () => {
		mockReadRegistrationBridgeConfig.mockImplementation(async () => ({ savedUrl: null, revision: 0 }));
		const tr = await renderScreen();
		const input = tr.root.findByProps({ testID: "registration-bridge-config-url" });
		await renderer.act(async () => {
			input.props.onChangeText("https://new-bridge.example");
		});
		await flushTicks(2);

		const saveWrapper = tr.root.findByProps({ testID: "registration-bridge-config-save" });
		const onPress = saveWrapper.findAll((node) => typeof node.props.onPress === "function")[0]!.props.onPress;
		await renderer.act(async () => {
			onPress();
			onPress();
		});
		await flushTicks(4);

		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
		expect(mockSaveRegistrationBridgeUrl).toHaveBeenCalledTimes(1);
		const call = mockSaveRegistrationBridgeUrl.mock.calls[0]!;
		expect(call[1]).toBe("auth-1");
		expect(call[2]).toBe("https://new-bridge.example");
		expect(typeof call[3]).toBe("function");
		expect(call[4]).toBe(0);

		present(tr, "rest-bridge-config-card");
		expect(treeText(tr)).toContain("registrationBridgeConfigSavedConfirm");
		const wrapper = tr.root.findByProps({ testID: "transport-sync-now-rest" });
		const disabledNode = wrapper.findAll((node) => "disabled" in node.props)[0]!;
		expect(disabledNode.props.disabled).toBe(false);
	});

	it("S10: 'co-sign-required' renders the co-sign line, keeps Save disabled for the rest of the mount (a second press calls nothing more), and leaves the REST control's state unchanged", async () => {
		mockReadRegistrationBridgeConfig.mockImplementation(async () => ({ savedUrl: null, revision: 0 }));
		mockSaveRegistrationBridgeUrl.mockImplementation(async () => ({ outcome: "co-sign-required" }));
		const tr = await renderScreen();
		const input = tr.root.findByProps({ testID: "registration-bridge-config-url" });
		await renderer.act(async () => {
			input.props.onChangeText("https://new-bridge.example");
		});
		await flushTicks(2);

		const saveWrapper = tr.root.findByProps({ testID: "registration-bridge-config-save" });
		let onPress = saveWrapper.findAll((node) => typeof node.props.onPress === "function")[0]!.props.onPress;
		await renderer.act(async () => {
			onPress();
		});
		await flushTicks(4);

		expect(mockSaveRegistrationBridgeUrl).toHaveBeenCalledTimes(1);
		present(tr, "registration-bridge-config-co-sign");

		const saveWrapper2 = tr.root.findByProps({ testID: "registration-bridge-config-save" });
		const button = saveWrapper2.findByType(require("react-native").TouchableOpacity);
		expect(button.props.disabled).toBe(true);
		onPress = button.props.onPress;
		await renderer.act(async () => {
			onPress();
		});
		await flushTicks(2);
		expect(mockSaveRegistrationBridgeUrl).toHaveBeenCalledTimes(1);

		const restWrapper = tr.root.findByProps({ testID: "transport-sync-now-rest" });
		const restDisabled = restWrapper.findAll((node) => "disabled" in node.props)[0]!;
		expect(restDisabled.props.disabled).toBe(true); // bridgeReady stayed false
	});

	it("S11: 'conflict' and 'failed' render SaveError and re-read the config (called twice)", async () => {
		for (const outcome of ["conflict", "failed"] as const) {
			mockReadRegistrationBridgeConfig.mockClear();
			mockReadRegistrationBridgeConfig.mockImplementation(async () => ({ savedUrl: null, revision: 0 }));
			mockSaveRegistrationBridgeUrl.mockImplementation(async () => ({ outcome }));
			const tr = await renderScreen();
			const input = tr.root.findByProps({ testID: "registration-bridge-config-url" });
			await renderer.act(async () => {
				input.props.onChangeText("https://new-bridge.example");
			});
			await flushTicks(2);
			const saveWrapper = tr.root.findByProps({ testID: "registration-bridge-config-save" });
			const onPress = saveWrapper.findAll((node) => typeof node.props.onPress === "function")[0]!.props.onPress;
			await renderer.act(async () => {
				onPress();
			});
			await flushTicks(4);

			expect(treeText(tr)).toContain("registrationBridgeConfigSaveError");
			expect(mockReadRegistrationBridgeConfig).toHaveBeenCalledTimes(2);
		}
	});

	it("S12: signer errors route through useDeviceSigningErrorHandler — handled:true sets no notice; handled:false with a message shows it in InlineError; handled:false with no message shows SaveError; the raw message never appears", async () => {
		mockReadRegistrationBridgeConfig.mockImplementation(async () => ({ savedUrl: null, revision: 0 }));

		mockCreateDeviceSigner.mockRejectedValueOnce(new Error("device-signing-cancel-secret"));
		mockHandleDeviceSigningError.mockReturnValueOnce({ handled: true, message: undefined });
		let tr = await renderScreen();
		let input = tr.root.findByProps({ testID: "registration-bridge-config-url" });
		await renderer.act(async () => {
			input.props.onChangeText("https://new-bridge.example");
		});
		await flushTicks(2);
		let saveWrapper = tr.root.findByProps({ testID: "registration-bridge-config-save" });
		let onPress = saveWrapper.findAll((node) => typeof node.props.onPress === "function")[0]!.props.onPress;
		await renderer.act(async () => {
			onPress();
		});
		await flushTicks(4);
		expect(treeText(tr)).not.toContain("registrationBridgeConfigSaveError");
		expect(treeText(tr)).not.toContain("device-signing-cancel-secret");

		mockCreateDeviceSigner.mockRejectedValueOnce(new Error("raw-2"));
		mockHandleDeviceSigningError.mockReturnValueOnce({ handled: false, message: "mapped-copy" });
		tr = await renderScreen();
		input = tr.root.findByProps({ testID: "registration-bridge-config-url" });
		await renderer.act(async () => {
			input.props.onChangeText("https://new-bridge.example");
		});
		await flushTicks(2);
		saveWrapper = tr.root.findByProps({ testID: "registration-bridge-config-save" });
		onPress = saveWrapper.findAll((node) => typeof node.props.onPress === "function")[0]!.props.onPress;
		await renderer.act(async () => {
			onPress();
		});
		await flushTicks(4);
		expect(treeText(tr)).toContain("mapped-copy");
		expect(treeText(tr)).not.toContain("raw-2");

		mockCreateDeviceSigner.mockRejectedValueOnce(new Error("raw-3-secret"));
		mockHandleDeviceSigningError.mockReturnValueOnce({ handled: false, message: undefined });
		tr = await renderScreen();
		input = tr.root.findByProps({ testID: "registration-bridge-config-url" });
		await renderer.act(async () => {
			input.props.onChangeText("https://new-bridge.example");
		});
		await flushTicks(2);
		saveWrapper = tr.root.findByProps({ testID: "registration-bridge-config-save" });
		onPress = saveWrapper.findAll((node) => typeof node.props.onPress === "function")[0]!.props.onPress;
		await renderer.act(async () => {
			onPress();
		});
		await flushTicks(4);
		expect(treeText(tr)).toContain("registrationBridgeConfigSaveError");
		expect(treeText(tr)).not.toContain("raw-3-secret");
	});

	it("S13: with scopes undefined or ['mel'], the bridge field and Save are present and disabled", async () => {
		for (const scopes of [undefined, ["mel"]] as (string[] | undefined)[]) {
			mockScopesResult = { scopes, loading: false };
			const tr = await renderScreen();
			const input = tr.root.findByProps({ testID: "registration-bridge-config-url" });
			expect(input.props.editable).toBe(false);
			const saveWrapper = tr.root.findByProps({ testID: "registration-bridge-config-save" });
			const button = saveWrapper.findByType(require("react-native").TouchableOpacity);
			expect(button.props.disabled).toBe(true);
		}
	});

	it("S14: the bundling gate still passes, and the filesystem card still renders and dispatches runSync('filesystem') unchanged", async () => {
		const syncNow = jest.fn(async () => report());
		registerSyncBinding({ id: "filesystem", syncNow });
		const tr = await renderScreen();
		await press(tr, "transport-sync-now-filesystem");
		expect(syncNow).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Suite D — the errors section renders identifiers only (T-48-20-02).
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen — the errors section is identifier-only", () => {
	it("renders exactly three rows, filesystem before rest, identifier + heading only", async () => {
		registerSyncBinding({
			id: "filesystem",
			syncNow: jest.fn(async () => report({ errorItemIds: ["req-0001", "req-0002"] })),
		});
		registerSyncBinding({
			id: "rest",
			syncNow: jest.fn(async () => report({ errorItemIds: ["req-0009"] })),
		});
		const tr = await renderScreen();
		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-rest");

		present(tr, "bulk-import-sync-errors-section");

		const rowIds = ["bulk-import-sync-error-row-0", "bulk-import-sync-error-row-1", "bulk-import-sync-error-row-2"];
		for (const id of rowIds) present(tr, id);
		absent(tr, "bulk-import-sync-error-row-3");

		const row0 = serializeSubtree(tr.root.findByProps({ testID: "bulk-import-sync-error-row-0" }));
		const row1 = serializeSubtree(tr.root.findByProps({ testID: "bulk-import-sync-error-row-1" }));
		const row2 = serializeSubtree(tr.root.findByProps({ testID: "bulk-import-sync-error-row-2" }));

		expect(row0).toContain("req-0001");
		expect(row0).toContain("bulkImportSyncFilesystemHeading");
		expect(row1).toContain("req-0002");
		expect(row1).toContain("bulkImportSyncFilesystemHeading");
		expect(row2).toContain("req-0009");
		expect(row2).toContain("bulkImportSyncRestHeading");

		expect(row0).not.toContain("bulkImportSyncRestHeading");
		expect(row1).not.toContain("bulkImportSyncRestHeading");
		expect(row2).not.toContain("bulkImportSyncFilesystemHeading");

		for (const row of [row0, row1, row2]) {
			expect(row).not.toContain("2026-08-05T12:00:00Z");
			expect(row).not.toContain("bulkImportSyncImportedCountLabel");
			expect(row).not.toContain("bulkImportSyncPendingCountLabel");
		}
	});

	it("(WR-15) an attached peer binding's error identifiers reach the errors section, still identifier-only", async () => {
		registerSyncBinding(
			peerHandle({ syncNow: jest.fn(async () => report({ errorItemIds: ["req-peer-0001"] })) }),
		);
		const tr = await renderScreen();
		await press(tr, "transport-try-peer-sync-p2p");

		present(tr, "bulk-import-sync-errors-section");
		const row0 = serializeSubtree(tr.root.findByProps({ testID: "bulk-import-sync-error-row-0" }));
		expect(row0).toContain("req-peer-0001");
		expect(row0).not.toContain("2026-08-05T12:00:00Z");
		expect(row0).not.toContain("bulkImportSyncImportedCountLabel");
		expect(row0).not.toContain("bulkImportSyncPendingCountLabel");

		const peerCard = serializeSubtree(tr.root.findByProps({ testID: "transport-status-card-p2p" }));
		expect(peerCard).toContain(SENTINEL_COLORS.warning);
		expect(peerCard).toContain("peerSyncCardCaveat");
		expect(peerCard).not.toContain("req-peer-0001");
	});

	it("is absent when both transports report empty errorItemIds", async () => {
		registerSyncBinding({ id: "filesystem", syncNow: jest.fn(async () => report()) });
		registerSyncBinding({ id: "rest", syncNow: jest.fn(async () => report()) });
		const tr = await renderScreen();
		await press(tr, "transport-sync-now-filesystem");
		await press(tr, "transport-sync-now-rest");

		absent(tr, "bulk-import-sync-errors-section");
	});
});

// ---------------------------------------------------------------------------
// Suite E — disabled, not hidden for the proven bindings (legacy coverage, Phase 999.1).
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen — write controls render disabled, not hidden", () => {
	it("a real officer without 'vrg' (scopes: []) sees the filesystem/rest/peer controls disabled, and the scoped banner", async () => {
		mockScopesResult = { scopes: [], loading: false };
		const filesystemSyncNow = jest.fn(async () => report());
		registerSyncBinding({ id: "filesystem", syncNow: filesystemSyncNow });
		const tr = await renderScreen();

		for (const id of ["transport-sync-now-filesystem", "transport-sync-now-rest", "transport-try-peer-sync-p2p"]) {
			present(tr, id);
			const wrapper = tr.root.findByProps({ testID: id });
			const disabledNodes = wrapper.findAll((node) => node.props.disabled === true);
			expect(disabledNodes.length).toBeGreaterThanOrEqual(1);
		}

		expect(treeText(tr)).toContain("registrationRequestScopeReadOnlyBanner");
		expect(treeText(tr)).not.toContain("registrationRequestScopeReadOnlyNoOfficerBanner");

		const wrapper = tr.root.findByProps({ testID: "transport-sync-now-filesystem" });
		const disabledNode = wrapper.findAll((node) => node.props.disabled === true)[0]!;
		await renderer.act(async () => {
			disabledNode.props.onPress?.();
		});
		await flushTicks(4);
		expect(filesystemSyncNow).not.toHaveBeenCalled();
	});

	it("a device that is not a registered officer (scopes: undefined) sees the no-officer banner, controls disabled", async () => {
		mockScopesResult = { scopes: undefined, loading: false };
		const tr = await renderScreen();

		for (const id of ["transport-sync-now-filesystem", "transport-sync-now-rest", "transport-try-peer-sync-p2p"]) {
			present(tr, id);
			const wrapper = tr.root.findByProps({ testID: id });
			const disabledNodes = wrapper.findAll((node) => node.props.disabled === true);
			expect(disabledNodes.length).toBeGreaterThanOrEqual(1);
		}

		expect(treeText(tr)).toContain("registrationRequestScopeReadOnlyNoOfficerBanner");
		expect(treeText(tr)).not.toContain("registrationRequestScopeReadOnlyBanner|");
	});
});

// ---------------------------------------------------------------------------
// Suite F — bulk-import-sync-model as a pure unit (no rendering).
// ---------------------------------------------------------------------------

describe("bulk-import-sync-model — pure unit", () => {
	afterEach(() => {
		clearSyncBindings();
	});

	describe("resolveTransportCardState", () => {
		it("{} -> never, every other member undefined", () => {
			expect(resolveTransportCardState({})).toEqual({ syncState: "never" });
		});

		it("{ failed: true } -> error, undefined counts", () => {
			expect(resolveTransportCardState({ failed: true })).toEqual({
				syncState: "error",
				lastSyncedAt: undefined,
				importedCount: undefined,
				pendingCount: undefined,
				errorCount: undefined,
			});
		});

		it("{ failed: true, report } -> error, retaining the report's values", () => {
			const r = report({ errorItemIds: ["a", "b"] });
			expect(resolveTransportCardState({ failed: true, report: r })).toEqual({
				syncState: "error",
				lastSyncedAt: r.syncedAt,
				importedCount: r.imported,
				pendingCount: r.pending,
				errorCount: 2,
			});
		});

		it("{ report } -> success, errorCount === report.errorItemIds.length", () => {
			const r = report({ errorItemIds: ["a"] });
			expect(resolveTransportCardState({ report: r })).toEqual({
				syncState: "success",
				lastSyncedAt: r.syncedAt,
				importedCount: r.imported,
				pendingCount: r.pending,
				errorCount: 1,
			});
		});
	});

	describe("toSyncErrorRefs", () => {
		it("fixed filesystem-before-rest ordering across both transports", () => {
			const refs = toSyncErrorRefs({
				rest: report({ errorItemIds: ["r1"] }),
				filesystem: report({ errorItemIds: ["f1"] }),
			});
			expect(refs.map((r) => r.transport)).toEqual(["filesystem", "rest"]);
		});

		it("preserves within-transport order", () => {
			const refs = toSyncErrorRefs({
				filesystem: report({ errorItemIds: ["f1", "f2", "f3"] }),
			});
			expect(refs.map((r) => r.itemId)).toEqual(["f1", "f2", "f3"]);
		});

		it("returns [] for empty input", () => {
			expect(toSyncErrorRefs({})).toEqual([]);
		});

		it("(WR-15) the order array is exhaustive over SyncBindingId — a peer report's errorItemIds are NOT dropped, and peer sorts last", () => {
			const refs = toSyncErrorRefs({
				peer: report({ errorItemIds: ["p1", "p2"] }),
				rest: report({ errorItemIds: ["r1"] }),
				filesystem: report({ errorItemIds: ["f1"] }),
			});
			expect(refs.map((r) => r.transport)).toEqual(["filesystem", "rest", "peer", "peer"]);
			expect(refs.map((r) => r.itemId)).toEqual(["f1", "r1", "p1", "p2"]);
			for (const ref of refs) {
				expect(Object.keys(ref).sort()).toEqual(["itemId", "transport"]);
			}
		});

		it("every returned ref has exactly the keys transport and itemId (the runtime PII gate)", () => {
			const refs = toSyncErrorRefs({ filesystem: report({ errorItemIds: ["f1"] }) });
			expect(Object.keys(refs[0]!).sort()).toEqual(["itemId", "transport"]);
		});
	});

	describe("registerSyncBinding / resolveSyncBinding / clearSyncBindings", () => {
		it("round-trips a registration", () => {
			const handle = { id: "filesystem" as const, syncNow: jest.fn(async () => report()) };
			registerSyncBinding(handle);
			expect(resolveSyncBinding("filesystem")).toBe(handle);
		});

		it("clearSyncBindings makes a previously registered id resolve undefined", () => {
			registerSyncBinding({ id: "rest", syncNow: jest.fn(async () => report()) });
			clearSyncBindings();
			expect(resolveSyncBinding("rest")).toBeUndefined();
		});
	});

	describe("INERT_PEER_SYNC", () => {
		it("returns undefined and throws nothing", () => {
			expect(INERT_PEER_SYNC()).toBeUndefined();
		});
	});
});

// ---------------------------------------------------------------------------
// Suite G (S7) — source-level bundling gates.
// ---------------------------------------------------------------------------

describe("BulkImportSyncScreen / bulk-import-sync-model — source-level bundling gates", () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const fs = require("fs");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const path = require("path");

	function stripComments(source: string): string {
		return source
			.split("\n")
			.filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
			.join("\n");
	}

	const FILES = {
		screen: path.join(__dirname, "..", "BulkImportSyncScreen.tsx"),
		model: path.join(__dirname, "..", "bulk-import-sync-model.ts"),
	};

	it("BUNDLING-GATE-OK: neither file imports @votetorrent/vote-engine, node:, require(, or either transport module", () => {
		for (const [, filePath] of Object.entries(FILES)) {
			const code = stripComments(fs.readFileSync(filePath as string, "utf8"));
			for (const bad of [
				"@votetorrent/vote-engine",
				"node:",
				"require(",
				"filesystem-registration-transport",
				"rest-registration-transport",
			]) {
				expect(code).not.toContain(bad);
			}
		}
	});

	it("the screen contains no console.* call (a transport error message must never reach a log)", () => {
		const code = stripComments(fs.readFileSync(FILES.screen, "utf8"));
		expect(code).not.toContain("console.");
	});
});

// ---------------------------------------------------------------------------
// OfficerIntakeKeyCard — O1-O5, mounted directly.
// ---------------------------------------------------------------------------

describe("OfficerIntakeKeyCard (O1-O5, D-04)", () => {
	function renderCard(props: Partial<React.ComponentProps<typeof OfficerIntakeKeyCard>> = {}) {
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(
				<OfficerIntakeKeyCard state="not-enabled" onEnable={jest.fn()} {...props} />,
			);
		});
		return tr;
	}

	it("O1: 'not-enabled' renders heading/body/enable button; disabled keeps it present and disabled; pressing an enabled button calls onEnable once", () => {
		const onEnable = jest.fn();
		const tr = renderCard({ state: "not-enabled", onEnable });
		present(tr, "officer-intake-key-enable");

		const tr2 = renderCard({ state: "not-enabled", disabled: true, onEnable });
		const wrapper = tr2.root.findByProps({ testID: "officer-intake-key-enable" });
		const disabledNode = wrapper.findAll((node) => "disabled" in node.props)[0]!;
		expect(disabledNode.props.disabled).toBe(true);

		const enabledWrapper = tr.root.findByProps({ testID: "officer-intake-key-enable" });
		const candidates = enabledWrapper.findAll((node) => typeof node.props.onPress === "function");
		renderer.act(() => {
			candidates[0]!.props.onPress();
		});
		expect(onEnable).toHaveBeenCalledTimes(1);
	});

	it("O2: 'enabled' renders officerIntakeKeyEnabledConfirm and omits the enable button", () => {
		const tr = renderCard({ state: "enabled" });
		present(tr, "officer-intake-key-enabled");
		absent(tr, "officer-intake-key-enable");
	});

	it("O3: 'loading' renders heading/body, and the button is present and disabled", () => {
		const tr = renderCard({ state: "loading" });
		const wrapper = tr.root.findByProps({ testID: "officer-intake-key-enable" });
		const disabledNode = wrapper.findAll((node) => "disabled" in node.props)[0]!;
		expect(disabledNode.props.disabled).toBe(true);
	});

	it("O4: showError renders officerIntakeKeyError by default; with errorMessage it shows that instead", () => {
		const trDefault = renderCard({ showError: true });
		present(trDefault, "officer-intake-key-error");
		expect(serializeSubtree(trDefault.root.findByProps({ testID: "officer-intake-key-error" }))).toContain(
			"officerIntakeKeyError",
		);

		const trMapped = renderCard({ showError: true, errorMessage: "mapped-copy" });
		const row = serializeSubtree(trMapped.root.findByProps({ testID: "officer-intake-key-error" }));
		expect(row).toContain("mapped-copy");
		expect(row).not.toContain("officerIntakeKeyError");
	});

	it("O5: no numberOfLines on the body, and no ancestor up to the card root sets height/maxHeight/overflow hidden", () => {
		const tr = renderCard({ state: "not-enabled" });
		const card = tr.root.findByProps({ testID: "officer-intake-key-card" });
		const texts = card.findAll((node) => typeof node.type === "string" && (node.type as string) === "Text");
		for (const txt of texts) {
			expect(txt.props.numberOfLines).toBeUndefined();
		}
		function flatten(style: unknown): Record<string, unknown> {
			if (Array.isArray(style)) return Object.assign({}, ...style.filter(Boolean).map(flatten));
			return (style as Record<string, unknown>) ?? {};
		}
		const views = card.findAll((node) => typeof node.type === "string");
		for (const v of views) {
			const flat = flatten(v.props.style);
			expect(flat.height).toBeUndefined();
			expect(flat.maxHeight).toBeUndefined();
			expect(flat.overflow).not.toBe("hidden");
		}
	});
});
