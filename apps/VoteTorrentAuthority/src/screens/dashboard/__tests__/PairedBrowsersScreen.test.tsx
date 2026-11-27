/**
 * PairedBrowsersScreen.test.tsx — the officer's paired-browsers list: cards, state words, last-seen
 * buckets, footnotes, the "+" header action and its geometry, the empty state, the inline confirm,
 * the one-prompt Remove through the engine, single flight, the reset-on-selection rule, failures,
 * load errors and pull to refresh, stale reads and unmount, hygiene, layout numbers and the copy
 * keys this screen uses.
 *
 * `t()` echoes the key, or `key|<json params>` when params are given, so params are asserted.
 *
 * DECLARED BLIND SPOT: the engine, the signer and the node are mocks (the paired-browsers engine and
 * the pairing engine are never required for real here: they reach the vote-engine dist and
 * cadre-core). This proves the screen's state machine, bindings and hygiene; the real biometric
 * prompt and the owner finishing a removal are proven on a device only.
 */
import React from "react";
import * as fs from "fs";
import * as path from "path";
import { StyleSheet } from "react-native";
import renderer, { act } from "react-test-renderer";
import { resources } from "../../../i18n";
import { captureConsole, expectNoSecretInConsole } from "../../../engines/__fixtures__/console-leak";
import { CustomButton } from "../../../components/CustomButton";
import { isBareDismissLabel } from "../../registration/components/LifecycleConfirmCard";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	SafeAreaProvider: ({ children }: { children: unknown }) => children,
	useSafeAreaInsets: () => ({ top: 0, bottom: 30, left: 0, right: 0 }),
}));

jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params ? `${key}|${JSON.stringify(params)}` : key),
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockNavigate = jest.fn();
const mockSetOptions = jest.fn();
jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { lightTheme } = require("../../../theme/themes");
		return lightTheme;
	},
	useNavigation: () => ({ navigate: mockNavigate, setOptions: mockSetOptions, goBack: jest.fn() }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const R = require("react");
		R.useEffect(() => cb(), []);
	},
}));

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));

const DB = { tag: "strand-db" };
const NODE = {
	getStrand: (_h: string) => ({ database: { getDatabase: () => DB } }),
	getControlDatabase: () => null,
	listMachines: async () => [],
};
let mockNode: unknown = NODE;
jest.mock("../../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: mockNode }),
}));

const mockList = jest.fn();
const mockRemove = jest.fn();
jest.mock("../../../engines/paired-browsers", () => ({
	listPairedBrowsers: (...a: unknown[]) => mockList(...a),
	removePairedBrowser: (...a: unknown[]) => mockRemove(...a),
}));

const mockLoadState = jest.fn();
jest.mock("../../../engines/dashboard-pairing", () => ({
	loadPairingCapabilityState: (...a: unknown[]) => mockLoadState(...a),
}));

const mockReadActiveNetworkHash = jest.fn();
jest.mock("../../../engines/pair-mint-host", () => ({
	readActiveNetworkHash: (...a: unknown[]) => mockReadActiveNetworkHash(...a),
}));

const mockGetDeviceUser = jest.fn();
jest.mock("../../../engines/device-user", () => ({
	getDeviceUser: (...a: unknown[]) => mockGetDeviceUser(...a),
}));

const mockDeviceSign = jest.fn();
const mockCreateDeviceSigner = jest.fn();
jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: (...a: unknown[]) => mockCreateDeviceSigner(...a),
}));

const mockHandleSigningError = jest.fn((_e: unknown): { handled: boolean; message?: string } => ({ handled: false }));
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => mockHandleSigningError,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const screenModule = require("../PairedBrowsersScreen") as typeof import("../PairedBrowsersScreen");
const PairedBrowsersScreen = screenModule.default as React.ComponentType;
const { lastSeenCopy, formatPairedDate, formatPairedDateTime, removeFailureKey } = screenModule;

const SRC = path.join(__dirname, "..", "..", "..");
const SCREEN_SOURCE = fs.readFileSync(path.join(__dirname, "..", "PairedBrowsersScreen.tsx"), "utf8");
const T = resources.en.translation as Record<string, string>;

// ---------------------------------------------------------------------------------------------
// Fixtures (distinctive 22+ char ids, so the hygiene scans are meaningful)

const NET = "netHashNetHashNetHashNetHash0123";
const USER_ID = "officerUserIdOfficerUserId0042";
const KEY_PUB = "02" + "7e".repeat(32);
const NONCE_A = "NonceAlphaAlphaAlpha01Q";
const NONCE_B = "NonceBravoBravoBravo02Q";
const NONCE_C = "NonceCharlieCharlie03QZ";
const NONCE_D = "NonceDeltaDeltaDelta04Q";
const INVITE_KEY = "inviteKeyInviteKeyInviteKey9876";
const SECRETS = [NONCE_A, NONCE_B, NONCE_C, NONCE_D, INVITE_KEY, USER_ID];

const MINTED_A = new Date(2026, 10, 3, 9, 5).getTime();
const MINTED_B = new Date(2026, 10, 2, 18, 40).getTime();
const MINTED_C = new Date(2026, 9, 30, 7, 0).getTime();
const MINTED_D = new Date(2026, 9, 20, 7, 0).getTime();

type Row = { nonce: string; label: string | null; mintedAt: number; state: string; lastSeenAt: number | null };
function rowsFixture(): Row[] {
	const now = Date.now();
	return [
		{ nonce: NONCE_A, label: null, mintedAt: MINTED_A, state: "waiting", lastSeenAt: null },
		{ nonce: NONCE_B, label: "Office laptop", mintedAt: MINTED_B, state: "paired", lastSeenAt: now - 20 * 60_000 },
		{ nonce: NONCE_C, label: "Old desktop", mintedAt: MINTED_C, state: "removal-pending", lastSeenAt: now - 3 * 3_600_000 },
	];
}

class PairedBrowserRemoveError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`paired browsers: ${reason} ${NONCE_A} ${INVITE_KEY}`);
		this.name = "PairedBrowserRemoveError";
		this.reason = reason;
	}
}
class PairedBrowsersUnreadableError extends Error {
	constructor() {
		super(`unreadable ${NONCE_B} ${USER_ID}`);
		this.name = "PairedBrowsersUnreadableError";
	}
}
class PairedBrowsersNetworkUnavailableError extends Error {
	constructor() {
		super(`network unavailable ${INVITE_KEY}`);
		this.name = "PairedBrowsersNetworkUnavailableError";
	}
}

// ---------------------------------------------------------------------------------------------
// Helpers

const mounted: renderer.ReactTestRenderer[] = [];

async function flush(n = 10) {
	for (let i = 0; i < n; i++) {
		// eslint-disable-next-line no-await-in-loop
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function mount(): Promise<renderer.ReactTestRenderer> {
	let tr!: renderer.ReactTestRenderer;
	act(() => {
		tr = renderer.create(<PairedBrowsersScreen />);
	});
	mounted.push(tr);
	await flush();
	return tr;
}

const all = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAll((n) => n.props.testID === id);
const has = (tr: renderer.ReactTestRenderer, id: string) => all(tr, id).length > 0;
const byId = (tr: renderer.ReactTestRenderer, id: string) => {
	const found = all(tr, id);
	if (found.length === 0) throw new Error(`no node with testID ${id}`);
	return found[0];
};
/** The text of every host Text under `node`. */
const textOf = (node: renderer.ReactTestInstance) =>
	node
		.findAll((n) => typeof n.type === "string" && (typeof n.props.children === "string" || typeof n.props.children === "number"))
		.map((n) => String(n.props.children))
		.join(" ");

async function press(tr: renderer.ReactTestRenderer, id: string) {
	await act(async () => {
		byId(tr, id).props.onPress();
	});
	await flush();
}

const confirmButton = (tr: renderer.ReactTestRenderer) =>
	byId(tr, "paired-browsers-confirm-confirm").findByType(CustomButton);
const dismissButton = (tr: renderer.ReactTestRenderer) =>
	byId(tr, "paired-browsers-confirm-dismiss").findByType(CustomButton);

async function pressConfirm(tr: renderer.ReactTestRenderer) {
	await act(async () => {
		confirmButton(tr).props.onPress();
	});
	await flush();
}

async function refresh(tr: renderer.ReactTestRenderer) {
	await act(async () => {
		byId(tr, "paired-browsers-list").props.onRefresh();
	});
	await flush();
}

/** Every Text child string and every accessibility label/hint, testID and nativeID in the tree. */
function exposedStrings(tr: renderer.ReactTestRenderer): string[] {
	const out: string[] = [];
	for (const n of tr.root.findAll(() => true)) {
		const c = n.props.children;
		if (typeof c === "string") out.push(c);
		if (Array.isArray(c)) for (const x of c) if (typeof x === "string") out.push(x);
		for (const p of ["accessibilityLabel", "accessibilityHint", "testID", "nativeID"]) {
			if (typeof n.props[p] === "string") out.push(n.props[p]);
		}
	}
	return out;
}

function expectNoSecretExposed(tr: renderer.ReactTestRenderer, extra: string[] = []) {
	const exposed = exposedStrings(tr).join("\n");
	for (const s of [...SECRETS, ...extra]) expect(exposed.includes(s)).toBe(false);
}

function deferred<V>() {
	let resolve!: (v: V) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<V>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function headerRightElement(): React.ReactElement {
	const calls = mockSetOptions.mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	const opts = calls[calls.length - 1][0] as { headerRight?: () => React.ReactElement };
	expect(typeof opts.headerRight).toBe("function");
	return opts.headerRight!();
}

beforeEach(() => {
	jest.clearAllMocks();
	mockNode = NODE;
	mockReadActiveNetworkHash.mockResolvedValue(NET);
	mockGetDeviceUser.mockResolvedValue({ id: USER_ID, name: "Officer One", activeKeys: [{ key: KEY_PUB, type: "P" }] });
	mockList.mockImplementation(async () => rowsFixture());
	mockRemove.mockResolvedValue("removal-pending");
	mockLoadState.mockResolvedValue({ signingKey: { key: KEY_PUB, type: "P" } });
	mockDeviceSign.mockResolvedValue({ signature: "sig", signerKey: KEY_PUB, signerUserId: USER_ID });
	mockCreateDeviceSigner.mockResolvedValue(mockDeviceSign);
	mockHandleSigningError.mockImplementation(() => ({ handled: false }));
});

afterEach(() => {
	while (mounted.length > 0) {
		const tr = mounted.pop()!;
		try {
			act(() => tr.unmount());
		} catch {
			// already unmounted
		}
	}
});

// ---------------------------------------------------------------------------------------------

describe("PairedBrowsersScreen", () => {
	it("P1 load: reads the active network and the device user, lists once, shows only a spinner while pending, renders rows in engine order", async () => {
		const d = deferred<Row[]>();
		mockList.mockImplementationOnce(() => d.promise);
		const tr = await mount();
		expect(has(tr, "paired-browsers-loading")).toBe(true);
		expect(has(tr, "paired-browsers-list")).toBe(false);
		expect(has(tr, "paired-browser-row-0")).toBe(false);
		expect(mockReadActiveNetworkHash).toHaveBeenCalledTimes(1);
		expect(mockGetDeviceUser).toHaveBeenCalledTimes(1);
		expect(mockList).toHaveBeenCalledTimes(1);
		const [nodeArg, storeArg, filterArg] = mockList.mock.calls[0];
		expect(nodeArg).toBe(NODE);
		expect(storeArg).toBeUndefined();
		expect(filterArg).toEqual({ userId: USER_ID, networkHash: NET });
		await act(async () => d.resolve(rowsFixture()));
		await flush();
		expect(has(tr, "paired-browsers-loading")).toBe(false);
		expect(has(tr, "paired-browsers-list")).toBe(true);
		expect(textOf(byId(tr, "paired-browser-title-1"))).toBe("Office laptop");
		expect(textOf(byId(tr, "paired-browser-title-2"))).toBe("Old desktop");
		expect(has(tr, "paired-browser-row-3")).toBe(false);
	});

	it("P2 card text: default label with the paired date, a label verbatim, the paired-at line and the state word per state", async () => {
		mockList.mockImplementation(async () => [
			...rowsFixture(),
			{ nonce: NONCE_D, label: "Gone box", mintedAt: MINTED_D, state: "removed", lastSeenAt: null },
		]);
		const tr = await mount();
		expect(textOf(byId(tr, "paired-browser-title-0"))).toBe(
			`pairedBrowsersDefaultLabel|${JSON.stringify({ date: "2026-11-03" })}`
		);
		expect(textOf(byId(tr, "paired-browser-title-1"))).toBe("Office laptop");
		expect(textOf(byId(tr, "paired-browser-paired-at-0"))).toBe(
			`pairedBrowsersPairedAt|${JSON.stringify({ date: "2026-11-03 09:05" })}`
		);
		expect(textOf(byId(tr, "paired-browser-paired-at-1"))).toBe(
			`pairedBrowsersPairedAt|${JSON.stringify({ date: "2026-11-02 18:40" })}`
		);
		expect(textOf(byId(tr, "paired-browser-state-0"))).toBe("pairedBrowsersStateWaiting");
		expect(textOf(byId(tr, "paired-browser-state-1"))).toBe("pairedBrowsersStatePaired");
		expect(textOf(byId(tr, "paired-browser-state-2"))).toBe("pairedBrowsersStateRemovalPending");
		expect(textOf(byId(tr, "paired-browser-state-3"))).toBe("pairedBrowsersStateRemoved");
		// The formatters are local-time, zero-padded and Intl-free.
		expect(formatPairedDate(new Date(2026, 0, 2, 3, 4).getTime())).toBe("2026-01-02");
		expect(formatPairedDateTime(new Date(2026, 0, 2, 3, 4).getTime())).toBe("2026-01-02 03:04");
		expect(formatPairedDateTime(new Date(2026, 11, 31, 23, 59).getTime())).toBe("2026-12-31 23:59");
	});

	it("P3 last-seen buckets (pure) and the removed row's missing last-seen line", async () => {
		const now = Date.UTC(2026, 10, 3, 12, 0, 0);
		const min = 60_000;
		const h = 60 * min;
		expect(lastSeenCopy(null, now)).toEqual({ key: "pairedBrowsersNotSeenYet" });
		expect(lastSeenCopy(now, now)).toEqual({ key: "pairedBrowsersLastSeenFewMinutes" });
		expect(lastSeenCopy(now - (15 * min - 1000), now)).toEqual({ key: "pairedBrowsersLastSeenFewMinutes" });
		expect(lastSeenCopy(now - 15 * min, now)).toEqual({ key: "pairedBrowsersLastSeenMinutes", n: 15 });
		expect(lastSeenCopy(now - (60 * min - 1000), now)).toEqual({ key: "pairedBrowsersLastSeenMinutes", n: 59 });
		expect(lastSeenCopy(now - 60 * min, now)).toEqual({ key: "pairedBrowsersLastSeenHours", n: 1 });
		expect(lastSeenCopy(now - (48 * h - 1000), now)).toEqual({ key: "pairedBrowsersLastSeenHours", n: 47 });
		expect(lastSeenCopy(now - 48 * h, now)).toEqual({ key: "pairedBrowsersLastSeenDays", n: 2 });
		expect(lastSeenCopy(now - 10 * 24 * h, now)).toEqual({ key: "pairedBrowsersLastSeenDays", n: 10 });
		expect(lastSeenCopy(now + 5 * min, now)).toEqual({ key: "pairedBrowsersLastSeenFewMinutes" });

		mockList.mockImplementation(async () => [
			...rowsFixture(),
			{ nonce: NONCE_D, label: "Gone box", mintedAt: MINTED_D, state: "removed", lastSeenAt: Date.now() },
		]);
		const tr = await mount();
		expect(textOf(byId(tr, "paired-browser-last-seen-0"))).toBe("pairedBrowsersNotSeenYet");
		expect(textOf(byId(tr, "paired-browser-last-seen-1"))).toBe(`pairedBrowsersLastSeenMinutes|${JSON.stringify({ n: 20 })}`);
		expect(textOf(byId(tr, "paired-browser-last-seen-2"))).toBe(`pairedBrowsersLastSeenHours|${JSON.stringify({ n: 3 })}`);
		expect(has(tr, "paired-browser-last-seen-3")).toBe(false);
	});

	it("P4 actions: Remove only on waiting and paired; the pending line and no Remove on removal-pending; nothing on removed; no retry anywhere", async () => {
		mockList.mockImplementation(async () => [
			...rowsFixture(),
			{ nonce: NONCE_D, label: "Gone box", mintedAt: MINTED_D, state: "removed", lastSeenAt: null },
		]);
		const tr = await mount();
		expect(has(tr, "paired-browser-remove-0")).toBe(true);
		expect(has(tr, "paired-browser-remove-1")).toBe(true);
		expect(has(tr, "paired-browser-remove-2")).toBe(false);
		expect(has(tr, "paired-browser-remove-3")).toBe(false);
		expect(textOf(byId(tr, "paired-browser-pending-2"))).toBe("pairedBrowsersRemovalPendingLine");
		expect(has(tr, "paired-browser-pending-0")).toBe(false);
		expect(has(tr, "paired-browser-pending-1")).toBe(false);
		expect(has(tr, "paired-browser-pending-3")).toBe(false);
		expect(byId(tr, "paired-browser-remove-0").props.accessibilityLabel).toBe("pairedBrowsersRemoveButton");
		const exposed = exposedStrings(tr).join("\n");
		expect(/retry|again/i.test(exposed.replace("pairedBrowsersRemovalPendingLine", ""))).toBe(false);
	});

	it("P5 footnotes and intro: the footer has the last-seen footnote then the local-labels note; the header has the intro", async () => {
		const tr = await mount();
		const list = byId(tr, "paired-browsers-list");
		const footer = list.props.ListFooterComponent as React.ReactElement;
		expect(footer).toBeTruthy();
		let footerTr!: renderer.ReactTestRenderer;
		act(() => {
			footerTr = renderer.create(footer);
		});
		const ids = footerTr.root
			.findAll((n) => typeof n.props.testID === "string" && typeof n.type !== "string")
			.map((n) => n.props.testID as string);
		const unique = ids.filter((id, i) => ids.indexOf(id) === i);
		expect(unique).toEqual(["paired-browsers-last-seen-footnote", "paired-browsers-local-labels-note"]);
		expect(textOf(footerTr.root)).toBe("pairedBrowsersLastSeenFootnote pairedBrowsersLocalLabelsNote");
		act(() => footerTr.unmount());
		expect(textOf(tr.root).includes("pairedBrowsersIntro")).toBe(true);
	});

	it("P6 empty: heading, body and a Pair a browser button that navigates once with no params; no footnotes", async () => {
		mockList.mockImplementation(async () => []);
		const tr = await mount();
		const empty = byId(tr, "paired-browsers-empty");
		// CustomButton renders its title upper-cased; the title prop carries the key.
		expect(textOf(empty)).toBe("pairedBrowsersEmptyHeading pairedBrowsersEmptyBody PAIREDBROWSERSPAIRBUTTON");
		expect(has(tr, "paired-browsers-last-seen-footnote")).toBe(false);
		expect(has(tr, "paired-browsers-local-labels-note")).toBe(false);
		expect(byId(tr, "paired-browsers-empty-pair").props.title).toBe("pairedBrowsersPairButton");
		await press(tr, "paired-browsers-empty-pair");
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate.mock.calls[0]).toEqual(["PairBrowser"]);
	});

	it("P7 header action: an icon-only 44 x 44 'Pair a browser' button that opens the pair screen", async () => {
		await mount();
		let hr!: renderer.ReactTestRenderer;
		act(() => {
			hr = renderer.create(headerRightElement());
		});
		const add = hr.root.findAll((n) => n.props.testID === "paired-browsers-add")[0];
		expect(add.props.accessibilityRole).toBe("button");
		expect(add.props.accessibilityLabel).toBe("pairedBrowsersPairButton");
		expect(add.props.hitSlop).toBe(8);
		const style = StyleSheet.flatten(add.props.style) as Record<string, unknown>;
		expect(style.minWidth as number).toBeGreaterThanOrEqual(44);
		expect(style.minHeight as number).toBeGreaterThanOrEqual(44);
		expect(style.alignItems).toBe("center");
		expect(style.justifyContent).toBe("center");
		const icons = hr.root.findAll((n) => n.type === ("FontAwesome6" as unknown));
		expect(icons.length).toBe(1);
		expect(icons[0].props.name).toBe("plus");
		expect(textOf(hr.root)).toBe("");
		await act(async () => {
			add.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate.mock.calls[0]).toEqual(["PairBrowser"]);
		act(() => hr.unmount());
	});

	it("P8 confirm: Remove opens an inline confirm and calls nothing; dismissing calls nothing; the dismiss label names what is kept", async () => {
		const tr = await mount();
		await press(tr, "paired-browser-remove-1");
		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
		expect(mockRemove).not.toHaveBeenCalled();
		expect(mockLoadState).not.toHaveBeenCalled();
		expect(all(tr, "paired-browsers-confirm-card").length).toBeGreaterThan(0);
		expect(textOf(byId(tr, "paired-browsers-confirm-title"))).toBe("pairedBrowsersRemoveConfirmHeading");
		expect(textOf(byId(tr, "paired-browsers-confirm-body"))).toBe("pairedBrowsersRemoveConfirmBody");
		expect(confirmButton(tr).props.title).toBe("pairedBrowsersRemoveConfirmButton");
		expect(dismissButton(tr).props.title).toBe("pairedBrowsersKeepButton");
		await act(async () => {
			dismissButton(tr).props.onPress();
		});
		await flush();
		expect(has(tr, "paired-browsers-confirm-card")).toBe(false);
		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
		expect(mockRemove).not.toHaveBeenCalled();
		expect(isBareDismissLabel(T.pairedBrowsersKeepButton)).toBe(false);
		expect(T.pairedBrowsersKeepButton).toBe("Keep browser");
		expect(isBareDismissLabel("Keep browser")).toBe(false);
		expect(isBareDismissLabel("pairedBrowsersKeepButton")).toBe(false);
		expect(/\bAlert\b/.test(SCREEN_SOURCE)).toBe(false);
	});

	it("P9 one prompt: confirming makes one signer and one engine call with the device user's current key; the list re-reads to Removal pending", async () => {
		const tr = await mount();
		await press(tr, "paired-browser-remove-0");
		mockList.mockImplementation(async () => {
			const rows = rowsFixture();
			rows[0] = { ...rows[0], state: "removal-pending" };
			return rows;
		});
		mockRemove.mockImplementationOnce(async (args: { signer: { sign(d: Uint8Array): Promise<unknown> } }) => {
			await args.signer.sign(new Uint8Array([1, 2, 3]));
			return "removal-pending";
		});
		await pressConfirm(tr);
		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
		expect(mockCreateDeviceSigner).toHaveBeenCalledWith("Device User");
		expect(mockLoadState).toHaveBeenCalledWith({ node: NODE, db: DB, networkHash: NET, userId: USER_ID });
		expect(mockRemove).toHaveBeenCalledTimes(1);
		const args = mockRemove.mock.calls[0][0] as Record<string, unknown> & {
			signer: { userId: string; signingPublicKey: string; sign(d: Uint8Array): Promise<unknown> };
		};
		expect(args.node).toBe(NODE);
		expect(args.db).toBe(DB);
		expect(args.entry).toEqual({ nonce: NONCE_A });
		expect(args.networkHash).toBe(NET);
		expect(args.signer.userId).toBe(USER_ID);
		expect(args.signer.signingPublicKey).toBe(KEY_PUB);
		expect(Object.keys(args).sort()).toEqual(["db", "entry", "networkHash", "node", "signer"]);
		expect(mockDeviceSign).toHaveBeenCalledTimes(1);
		expect(Array.from(mockDeviceSign.mock.calls[0][0] as Uint8Array)).toEqual([1, 2, 3]);
		expect(mockList).toHaveBeenCalledTimes(2);
		expect(textOf(byId(tr, "paired-browser-state-0"))).toBe("pairedBrowsersStateRemovalPending");
		expect(has(tr, "paired-browser-remove-0")).toBe(false);
		expect(textOf(byId(tr, "paired-browser-pending-0"))).toBe("pairedBrowsersRemovalPendingLine");
		expect(has(tr, "paired-browsers-confirm-card")).toBe(false);
		expect(has(tr, "paired-browsers-remove-error")).toBe(false);
		// The screen never builds signed bytes and sends nothing over the wire.
		expect(/pairingRevokeDigest|revokeDashboardPairing|Digest\(/.test(SCREEN_SOURCE)).toBe(false);
		expect(/pair-mint-client|requestPairMint/.test(SCREEN_SOURCE)).toBe(false);
	});

	it("P10 single flight: two confirm presses in one tick make one signer and one engine call; Remove on another row does nothing while in flight", async () => {
		const tr = await mount();
		await press(tr, "paired-browser-remove-0");
		const d = deferred<string>();
		mockRemove.mockImplementationOnce(() => d.promise);
		await act(async () => {
			const b = confirmButton(tr);
			b.props.onPress();
			b.props.onPress();
		});
		await flush();
		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
		expect(mockRemove).toHaveBeenCalledTimes(1);
		await press(tr, "paired-browser-remove-1");
		const rowWrapper1 = all(tr, "paired-browser-row-1")[0].parent!;
		expect(rowWrapper1.findAll((n) => n.props.testID === "paired-browsers-confirm-card").length).toBe(0);
		const rowWrapper0 = all(tr, "paired-browser-row-0")[0].parent!;
		expect(rowWrapper0.findAll((n) => n.props.testID === "paired-browsers-confirm-card").length).toBeGreaterThan(0);
		await act(async () => d.resolve("removal-pending"));
		await flush();
		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
		expect(mockRemove).toHaveBeenCalledTimes(1);
	});

	it("P11 reset-on-selection: another card's Remove moves the confirm and clears the error; a re-read that drops or retires the selection closes it", async () => {
		const tr = await mount();
		// An error on row 0 first.
		await press(tr, "paired-browser-remove-0");
		mockRemove.mockRejectedValueOnce(new PairedBrowserRemoveError("not-saved"));
		await pressConfirm(tr);
		expect(textOf(byId(tr, "paired-browsers-remove-error"))).toBe("pairedBrowsersRemoveFailed");
		expect(all(tr, "paired-browsers-confirm-card").length).toBeGreaterThan(0);
		// Selecting row 1 discards row 0's confirm and the error.
		await press(tr, "paired-browser-remove-1");
		expect(has(tr, "paired-browsers-remove-error")).toBe(false);
		const cards = tr.root.findAll((n) => n.props.testID === "paired-browsers-confirm-card" && typeof n.type === "string");
		expect(cards.length).toBe(1);
		const wrapper1 = all(tr, "paired-browser-row-1")[0].parent!;
		expect(wrapper1.findAll((n) => n.props.testID === "paired-browsers-confirm-card").length).toBeGreaterThan(0);
		const wrapper0 = all(tr, "paired-browser-row-0")[0].parent!;
		expect(wrapper0.findAll((n) => n.props.testID === "paired-browsers-confirm-card").length).toBe(0);

		// A re-read in which the selected pairing is now removal-pending closes the confirm.
		mockList.mockImplementation(async () => {
			const rows = rowsFixture();
			rows[1] = { ...rows[1], state: "removal-pending" };
			return rows;
		});
		await refresh(tr);
		expect(has(tr, "paired-browsers-confirm-card")).toBe(false);

		// A re-read in which the selected pairing is gone closes the confirm.
		mockList.mockImplementation(async () => rowsFixture());
		await refresh(tr);
		await press(tr, "paired-browser-remove-0");
		expect(has(tr, "paired-browsers-confirm-card")).toBe(true);
		mockList.mockImplementation(async () => rowsFixture().slice(1));
		await refresh(tr);
		expect(has(tr, "paired-browsers-confirm-card")).toBe(false);
		expect(mockRemove).toHaveBeenCalledTimes(1);
	});

	it("P12 failures: no key, key-not-current, other reasons, unreadable, plain errors and signer codes map to translated copy; the card returns to idle", async () => {
		const tr = await mount();
		await press(tr, "paired-browser-remove-0");

		// No current signing key: the key-not-current line and zero signer calls.
		mockLoadState.mockResolvedValueOnce({ signingKey: null });
		await pressConfirm(tr);
		expect(textOf(byId(tr, "paired-browsers-remove-error"))).toBe("pairedBrowsersRemoveKeyNotCurrent");
		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
		expect(mockRemove).not.toHaveBeenCalled();
		expect(confirmButton(tr).props.disabled).toBe(false);

		const cases: Array<[unknown, string]> = [
			[new PairedBrowserRemoveError("key-not-current"), "pairedBrowsersRemoveKeyNotCurrent"],
			[new PairedBrowserRemoveError("signer-mismatch"), "pairedBrowsersRemoveFailed"],
			[new PairedBrowserRemoveError("refused"), "pairedBrowsersRemoveFailed"],
			[new PairedBrowserRemoveError("not-saved"), "pairedBrowsersRemoveFailed"],
			[new PairedBrowserRemoveError("unknown-entry"), "pairedBrowsersRemoveFailed"],
			[new PairedBrowserRemoveError("wrong-network"), "pairedBrowsersRemoveFailed"],
			[new PairedBrowsersUnreadableError(), "pairedBrowsersRemoveFailed"],
			[new Error(`plain ${NONCE_A}`), "pairedBrowsersRemoveFailed"],
		];
		for (const [err, key] of cases) {
			mockRemove.mockRejectedValueOnce(err);
			// eslint-disable-next-line no-await-in-loop
			await pressConfirm(tr);
			expect(textOf(byId(tr, "paired-browsers-remove-error"))).toBe(key);
			expect(confirmButton(tr).props.disabled).toBe(false);
			expect(removeFailureKey(err)).toBe(key);
			expectNoSecretExposed(tr, [(err as Error).message]);
		}
		expect(mockHandleSigningError).not.toHaveBeenCalled();

		// A signer error with a string code goes to the signing hook first.
		const cancel = Object.assign(new Error(`cancelled ${NONCE_A}`), { code: "USER_CANCELED" });
		mockHandleSigningError.mockImplementationOnce(() => ({ handled: true }));
		mockRemove.mockRejectedValueOnce(cancel);
		await pressConfirm(tr);
		expect(mockHandleSigningError).toHaveBeenCalledWith(cancel);
		expect(has(tr, "paired-browsers-remove-error")).toBe(false);
		expect(confirmButton(tr).props.disabled).toBe(false);

		const locked = Object.assign(new Error(`locked ${NONCE_A}`), { code: "LOCKOUT" });
		mockHandleSigningError.mockImplementationOnce(() => ({ handled: false, message: "Too many attempts" }));
		mockRemove.mockRejectedValueOnce(locked);
		await pressConfirm(tr);
		expect(textOf(byId(tr, "paired-browsers-remove-error"))).toBe("Too many attempts");

		const unknownCode = Object.assign(new Error(`odd ${NONCE_A}`), { code: "SOMETHING" });
		mockHandleSigningError.mockImplementationOnce(() => ({ handled: false }));
		mockRemove.mockRejectedValueOnce(unknownCode);
		await pressConfirm(tr);
		expect(textOf(byId(tr, "paired-browsers-remove-error"))).toBe("pairedBrowsersRemoveFailed");
		expect(confirmButton(tr).props.disabled).toBe(false);
		expectNoSecretExposed(tr, ["cancelled", "locked", "odd "]);

		// The signer itself failing to load goes the same way.
		const noKey = Object.assign(new Error("no key"), { code: "NO_KEY_PROVISIONED" });
		mockCreateDeviceSigner.mockRejectedValueOnce(noKey);
		mockHandleSigningError.mockImplementationOnce(() => ({ handled: true }));
		await pressConfirm(tr);
		expect(mockHandleSigningError).toHaveBeenLastCalledWith(noKey);
		expect(has(tr, "paired-browsers-remove-error")).toBe(false);
		expect(removeFailureKey(undefined)).toBe("pairedBrowsersRemoveFailed");
		expect(removeFailureKey({ name: "PairedBrowserRemoveError", reason: "refused" })).toBe("pairedBrowsersRemoveFailed");
	});

	it("P12b a Remove with no database (strand not open) fails with the generic line and never signs", async () => {
		mockNode = { ...NODE, getStrand: () => undefined };
		const tr = await mount();
		await press(tr, "paired-browser-remove-0");
		await pressConfirm(tr);
		expect(textOf(byId(tr, "paired-browsers-remove-error"))).toBe("pairedBrowsersRemoveFailed");
		expect(mockLoadState).not.toHaveBeenCalled();
		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
		expect(mockRemove).not.toHaveBeenCalled();
		expect(confirmButton(tr).props.disabled).toBe(false);
	});

	it("P13 load errors: each error class, a null node and a null network show the load-error line; pull to refresh re-reads; a failed re-read keeps the cards", async () => {
		for (const make of [() => new PairedBrowsersUnreadableError(), () => new PairedBrowsersNetworkUnavailableError()]) {
			mockList.mockImplementationOnce(async () => {
				throw make();
			});
			// eslint-disable-next-line no-await-in-loop
			const tr = await mount();
			expect(textOf(byId(tr, "paired-browsers-load-error"))).toBe("pairedBrowsersLoadError");
			expect(has(tr, "paired-browsers-empty")).toBe(false);
			expect(has(tr, "paired-browsers-loading")).toBe(false);
			expectNoSecretExposed(tr);
			// Pull to refresh re-reads and recovers.
			const before = mockList.mock.calls.length;
			// eslint-disable-next-line no-await-in-loop
			await refresh(tr);
			expect(mockList.mock.calls.length).toBe(before + 1);
			expect(has(tr, "paired-browsers-load-error")).toBe(false);
			expect(has(tr, "paired-browser-row-0")).toBe(true);
		}

		mockNode = null;
		const noNode = await mount();
		expect(textOf(byId(noNode, "paired-browsers-load-error"))).toBe("pairedBrowsersLoadError");
		mockNode = NODE;

		mockReadActiveNetworkHash.mockResolvedValueOnce(null);
		const callsBefore = mockList.mock.calls.length;
		const noNet = await mount();
		expect(textOf(byId(noNet, "paired-browsers-load-error"))).toBe("pairedBrowsersLoadError");
		expect(mockList.mock.calls.length).toBe(callsBefore);

		// A re-read failure after a successful load keeps the cards and shows the line.
		const tr = await mount();
		expect(has(tr, "paired-browser-row-2")).toBe(true);
		expect(typeof byId(tr, "paired-browsers-list").props.onRefresh).toBe("function");
		mockList.mockImplementationOnce(async () => {
			throw new PairedBrowsersNetworkUnavailableError();
		});
		await refresh(tr);
		expect(has(tr, "paired-browsers-load-error")).toBe(true);
		expect(has(tr, "paired-browser-row-0")).toBe(true);
		expect(has(tr, "paired-browser-row-2")).toBe(true);
		expect(byId(tr, "paired-browsers-list").props.refreshing).toBe(false);
	});

	it("P14 stale and unmount: an older slow read never overwrites a newer one; reads and Removes settling after unmount set no state", async () => {
		const tr = await mount();
		const slow = deferred<Row[]>();
		mockList.mockImplementationOnce(() => slow.promise);
		mockList.mockImplementationOnce(async () => [{ nonce: NONCE_D, label: "Newest", mintedAt: MINTED_D, state: "paired", lastSeenAt: null }]);
		await refresh(tr);
		await refresh(tr);
		expect(textOf(byId(tr, "paired-browser-title-0"))).toBe("Newest");
		await act(async () => slow.resolve(rowsFixture()));
		await flush();
		expect(textOf(byId(tr, "paired-browser-title-0"))).toBe("Newest");
		expect(has(tr, "paired-browser-row-1")).toBe(false);

		// A read failing after unmount logs and sets nothing.
		const late = deferred<Row[]>();
		mockList.mockImplementationOnce(() => late.promise);
		const tr2 = await mount();
		const cap = captureConsole();
		try {
			act(() => tr2.unmount());
			await act(async () => late.reject(new PairedBrowsersNetworkUnavailableError()));
			await flush();
			expect(cap.calls().length).toBe(0);
		} finally {
			cap.restore();
		}

		// A Remove settling after unmount sets nothing.
		const tr3 = await mount();
		await press(tr3, "paired-browser-remove-0");
		const removal = deferred<string>();
		mockRemove.mockImplementationOnce(() => removal.promise);
		await act(async () => {
			confirmButton(tr3).props.onPress();
		});
		await flush();
		const listCalls = mockList.mock.calls.length;
		act(() => tr3.unmount());
		await act(async () => removal.reject(new PairedBrowserRemoveError("not-saved")));
		await flush();
		expect(mockList.mock.calls.length).toBe(listCalls);
	});

	it("P15 hygiene: no id, nonce or invitation key in rendered text, testIDs, labels or console output across load, remove and failures", async () => {
		const cap = captureConsole();
		try {
			const tr = await mount();
			expectNoSecretExposed(tr);
			await press(tr, "paired-browser-remove-0");
			expectNoSecretExposed(tr);
			mockRemove.mockRejectedValueOnce(new PairedBrowserRemoveError("not-saved"));
			await pressConfirm(tr);
			mockRemove.mockRejectedValueOnce(new Error(`raw ${INVITE_KEY} ${USER_ID}`));
			await pressConfirm(tr);
			mockList.mockImplementationOnce(async () => {
				throw new PairedBrowsersUnreadableError();
			});
			await refresh(tr);
			await pressConfirm(tr);
			expectNoSecretExposed(tr, ["raw ", "unreadable "]);
			expect(cap.calls().length).toBeGreaterThan(0);
			expectNoSecretInConsole(cap, [...SECRETS, "paired browsers: not-saved", "network unavailable"]);
			for (const args of cap.calls()) {
				expect(typeof args[0]).toBe("string");
				expect(String(args[0]).startsWith("[paired-browsers] ")).toBe(true);
				expect(args.length).toBeLessThanOrEqual(2);
			}
		} finally {
			cap.restore();
		}
		const code = SCREEN_SOURCE.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
		expect(/console\.(log|debug)\(/.test(code)).toBe(false);
	});

	it("P16 geometry: inset bottom padding, a shrinkable title, a 44 dp Remove target", async () => {
		const tr = await mount();
		const list = byId(tr, "paired-browsers-list");
		const content = StyleSheet.flatten(list.props.contentContainerStyle) as Record<string, unknown>;
		expect(content.paddingBottom).toBe(30 + 24);
		expect(content.padding).toBe(16);
		expect(content.gap).toBe(8);
		const title = StyleSheet.flatten(byId(tr, "paired-browser-title-1").props.style) as Record<string, unknown>;
		expect(title.flexShrink).toBe(1);
		expect(byId(tr, "paired-browser-title-1").props.numberOfLines).toBe(2);
		const stateWord = StyleSheet.flatten(byId(tr, "paired-browser-state-1").props.style) as Record<string, unknown>;
		expect(stateWord.marginLeft).toBe("auto");
		const remove = byId(tr, "paired-browser-remove-1");
		const rs = StyleSheet.flatten(remove.props.style) as Record<string, unknown>;
		expect(rs.minHeight as number).toBeGreaterThanOrEqual(36);
		const slop = remove.props.hitSlop as { top: number; bottom: number };
		expect(slop.top).toBeGreaterThanOrEqual(4);
		expect(slop.bottom).toBeGreaterThanOrEqual(4);
		expect((rs.minHeight as number) + slop.top + slop.bottom).toBeGreaterThanOrEqual(44);
	});

	it("P17 copy keys: every key the screen uses exists in EN and ES, and every paired-browsers key has a reader", () => {
		const i18nSource = fs.readFileSync(path.join(SRC, "i18n", "index.ts"), "utf8");
		const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		const screenCode = strip(SCREEN_SOURCE);
		const used = new Set<string>();
		for (const m of screenCode.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) used.add(m[1]);
		for (const m of screenCode.matchAll(/"(pairedBrowsers[A-Za-z]+)"/g)) used.add(m[1]);
		expect(used.size).toBeGreaterThan(20);
		for (const key of used) {
			const lines = i18nSource.match(new RegExp(`^\\s*${key}:`, "gm")) ?? [];
			expect([key, lines.length >= 2]).toEqual([key, true]);
		}
		const shipped = Array.from(new Set(Array.from(i18nSource.matchAll(/^\s*(pairedBrowsers[A-Za-z]+):/gm), (m) => m[1])));
		expect(shipped.length).toBe(27);
		const readers = [
			screenCode,
			strip(fs.readFileSync(path.join(SRC, "screens", "users", "UserDetailsScreen.tsx"), "utf8")),
			strip(fs.readFileSync(path.join(SRC, "navigation", "index.tsx"), "utf8")),
		].join("\n");
		for (const key of shipped) {
			expect([key, readers.includes(`"${key}"`)]).toEqual([key, true]);
		}
	});
});
