/**
 * PairBrowserScreen.test.tsx — the "Pair a browser" screen: every state, the confirm gate, one
 * request per attempt, the anchor port bound to the revision-tolerant join-anchor reader, the owner
 * phone's local mint, cancel on leave, Copy / Share / QR, the full-screen view, QR geometry, the
 * too-large fallback, expiry, "used" detection, failures, signer errors, and bearer hygiene (the code
 * is never rendered, never in an accessibility prop or testID, never logged).
 *
 * The realistic code is built from a real-encoder join-code fixture trimmed to 4 member addresses
 * and wrapped with worst-case statement fields, so the QR stop rule is measured on a code the
 * engine can really produce.
 *
 * Comparisons involving the code are boolean or count-based: a failing matcher prints its operands,
 * and the code is a bearer credential.
 *
 * DECLARED BLIND SPOT: the engine, the signer and the owner are mocks. This proves the screen's
 * state machine, bindings and hygiene; the real biometric prompt and a real owner round trip are
 * proven on a device only.
 */
import React from "react";
import * as fs from "fs";
import * as path from "path";
import { ActivityIndicator, Dimensions, PixelRatio, Share, StyleSheet, TextInput } from "react-native";
import renderer, { act } from "react-test-renderer";
import { JOIN_CODE_FIXTURES } from "@votetorrent/vote-engine/test/fixtures/join-code-fixtures";
import { decodeNetworkJoinCode, encodeNetworkJoinCode, encodePairingCode } from "@votetorrent/vote-engine/rn";
import { resources } from "../../../i18n";
import { captureConsole, expectNoSecretInConsole } from "../../../engines/__fixtures__/console-leak";
import { nonLiteralConsoleFirstArgs } from "../../__fixtures__/log-content-scan";
import { buildQrMatrix, QR_MAX_TEXT_CHARS } from "../../../utils/qr/qr-matrix";
import { qrLayout } from "../../../utils/qr/qr-layout";
import { KeyboardAvoidingScreen } from "../../../components/KeyboardAvoidingScreen";
import { Footer } from "../../../components/Footer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

const mockSetString = jest.fn();
jest.mock("@react-native-clipboard/clipboard", () => ({
	__esModule: true,
	default: {
		setString: (...args: unknown[]) => mockSetString(...(args as [])),
		getString: async () => "",
		hasString: async () => false,
	},
}));

jest.mock("react-native-safe-area-context", () => ({
	SafeAreaProvider: ({ children }: { children: unknown }) => children,
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, vars?: Record<string, unknown>) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources: res } = require("../../../i18n");
			const value = (res.en.translation as Record<string, string>)[key];
			if (typeof value !== "string") return key;
			return value.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => String(vars?.[k] ?? ""));
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockCanGoBack = jest.fn(() => true);
jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { lightTheme } = require("../../../theme/themes");
		return lightTheme;
	},
	useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack, canGoBack: mockCanGoBack }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const R = require("react");
		R.useEffect(() => cb(), []);
	},
}));

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));

const mockGetJoinAnchor = jest.fn();
const mockGetFoundingAnchor = jest.fn(() => {
	throw new Error("getFoundingAnchor must never be called");
});
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ networksEngine: { getJoinAnchor: mockGetJoinAnchor, getFoundingAnchor: mockGetFoundingAnchor } }),
}));

const mockUsages = jest.fn();
const DB = { tag: "strand-db" };
const NODE = {
	peerId: { toString: () => "12D3KooWSe1fPeerSe1fPeerSe1fPeerSe1fPeerSe1fPeerSe1f" },
	getStrand: (_h: string) => ({ database: { getDatabase: () => DB } }),
	getControlDatabase: () => ({ queryCadreInviteUsages: (...a: unknown[]) => mockUsages(...a) }),
};
const mockLocalMint = jest.fn();
const mockPairMintGetter = jest.fn((): unknown => mockLocalMint);
jest.mock("../../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: NODE }),
	usePairMintLocal: () => mockPairMintGetter,
}));

const mockLoadState = jest.fn();
const mockCapability = jest.fn();
const mockRequest = jest.fn();
jest.mock("../../../engines/dashboard-pairing", () => ({
	loadPairingCapabilityState: (...a: unknown[]) => mockLoadState(...a),
	pairingCapability: (...a: unknown[]) => mockCapability(...a),
	requestPairingCode: (...a: unknown[]) => mockRequest(...a),
}));

const mockReadActiveNetworkHash = jest.fn();
jest.mock("../../../engines/pair-mint-host", () => ({
	readActiveNetworkHash: (...a: unknown[]) => mockReadActiveNetworkHash(...a),
}));

const mockReadPairedBrowsers = jest.fn();
jest.mock("../../../engines/paired-browsers-store", () => ({
	readPairedBrowsers: (...a: unknown[]) => mockReadPairedBrowsers(...a),
}));

const KEY_PUB = "02" + "11".repeat(32);
const USER_ID = "user-1";
jest.mock("../../../engines/device-user", () => ({
	getDeviceUser: async () => ({ id: "user-1", name: "Officer One", activeKeys: [{ key: "02" + "11".repeat(32), type: "P" }] }),
}));

const SIGNER = jest.fn();
const mockCreateDeviceSigner = jest.fn(async (_n: string) => SIGNER);
jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: (...a: unknown[]) => mockCreateDeviceSigner(...(a as [string])),
}));

const mockHandleSigningError = jest.fn((_e: unknown): { handled: boolean; message?: string } => ({ handled: false }));
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => mockHandleSigningError,
}));

const mockShareQrImage = jest.fn();
const mockDeleteQrImage = jest.fn(async () => undefined);
jest.mock("../../../engines/qr-share", () => ({
	shareJoinCodeQrImage: (...a: unknown[]) => mockShareQrImage(...a),
	deleteSharedQrImage: () => mockDeleteQrImage(),
}));

const mockCopy = jest.fn();
jest.mock("../../../utils/copyToClipboard", () => ({
	copyToClipboard: (...a: unknown[]) => mockCopy(...a),
}));

interface KeepAwakeMock {
	__keepAwakeActiveCount(): number;
	__resetKeepAwakeMock(): void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const keepAwake = require("../../../../__mocks__/@sayem314/react-native-keep-awake.js") as KeepAwakeMock;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const screenModule = require("../PairBrowserScreen");
const PairBrowserScreen = screenModule.default as React.ComponentType;
const {
	PAIRING_USAGE_POLL_MS,
	PAIRING_QR_MAX_MODULES,
	PAIRING_QR_MIN_MODULE_PX,
	pairingQrFits,
	pairingFailureState,
	makeReadAnchor,
} = screenModule as typeof import("../PairBrowserScreen");

const T = resources.en.translation as Record<string, string>;
const SOURCE = fs.readFileSync(path.join(__dirname, "..", "PairBrowserScreen.tsx"), "utf8");

// ---------------------------------------------------------------------------------------------
// The realistic code (a real join-code fixture, 4 member addresses, worst-case statement fields)

const fixture = (() => {
	const d = decodeNetworkJoinCode(JOIN_CODE_FIXTURES["v2-6-members"].text);
	if (!d.ok) throw new Error("fixture does not decode");
	return d.code;
})();
const INVITE_PREFIX = "sereus-invite:1.";
function trimInvitation(text: string, max: number): string {
	const json = JSON.parse(Buffer.from(text.slice(INVITE_PREFIX.length), "base64url").toString("utf8")) as {
		members: string[];
	};
	json.members = json.members.slice(0, max);
	return INVITE_PREFIX + Buffer.from(JSON.stringify(json), "utf8").toString("base64url");
}
const NOW = Date.UTC(2026, 10, 3, 10, 0, 0);
const EXPIRES_AT = new Date(NOW + 14 * 60_000).toISOString().slice(0, 19);
const NONCE = "AbCdEfGhIjKlMnOpQrStUv";
const REAL_CODE = encodePairingCode({
	statement: {
		userId: "6f9619ff-8b86-4d01-b42d-00c04fc964ff",
		requesterPeerId: "12D3KooWLongestPeerIdLongestPeerIdLongestPeerIdLonge",
		nonce: NONCE,
		expiresAt: EXPIRES_AT,
		keyPub: "04" + "ab".repeat(64),
		sig: "30" + "cd".repeat(71),
	},
	joinCode: encodeNetworkJoinCode({
		v: 2,
		invitation: trimInvitation(fixture.invitation, 4),
		networkHash: fixture.networkHash,
		name: fixture.name,
		genesis: fixture.genesis,
		digest: fixture.digest,
	}),
});
const REAL_N = buildQrMatrix(REAL_CODE).n;
const REAL_M = qrLayout(REAL_N, 1080).m;
const TOO_LARGE_CODE = "vtpair1." + "A".repeat(QR_MAX_TEXT_CHARS + 10);

const NET = fixture.networkHash;
const FINGERPRINT = "17b0 6508 2fd5 aab2";
const ANCHOR = {
	networkHash: NET,
	name: fixture.name,
	genesis: fixture.genesis,
	digest: fixture.digest,
	fingerprint: FINGERPRINT,
};

// ---------------------------------------------------------------------------------------------
// Helpers

type Profile = { width: number; height: number; scale: number };
const PIXEL_8: Profile = { width: 1080, height: 2400, scale: 2.625 };
const dims = Dimensions as unknown as { set(p: unknown): void };
const originalWindow = Dimensions.get("window");
const originalScreen = Dimensions.get("screen");
function setProfile(p: Profile) {
	const physical = { width: p.width, height: p.height, scale: p.scale, fontScale: 1 };
	dims.set({ windowPhysicalPixels: physical, screenPhysicalPixels: physical });
}

let currentCode = REAL_CODE;
let capabilityValue = "ready-officer";
const mounted: renderer.ReactTestRenderer[] = [];

function okResult() {
	return { ok: true, code: currentCode, nonce: NONCE, expiresAt: EXPIRES_AT };
}

async function flush(n = 12) {
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
		tr = renderer.create(<PairBrowserScreen />);
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
/** The text of every host Text under `node` (composite wrappers skipped, so nothing doubles). */
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

function typeConfirm(tr: renderer.ReactTestRenderer, text: string) {
	act(() => {
		tr.root.findByType(TextInput).props.onChangeText(text);
	});
}

async function openConfirmAndSubmit(tr: renderer.ReactTestRenderer) {
	await press(tr, "pair-browser-request");
	typeConfirm(tr, T.iConfirm);
	await press(tr, "pair-browser-confirm-submit");
	await flush();
}

async function toCodeReady(): Promise<renderer.ReactTestRenderer> {
	const tr = await mount();
	await openConfirmAndSubmit(tr);
	return tr;
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

/** Number of 16-char windows of `secret` found in `haystack`. Never prints either. */
function windowHits(haystack: string, secret: string): number {
	let hits = 0;
	for (let i = 0; i + 16 <= secret.length; i++) if (haystack.includes(secret.slice(i, i + 16))) hits++;
	return hits;
}

const lastRequestArgs = () => mockRequest.mock.calls[mockRequest.mock.calls.length - 1][0] as Record<string, unknown>;

beforeEach(() => {
	jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
	setProfile(PIXEL_8);
	keepAwake.__resetKeepAwakeMock();
	currentCode = REAL_CODE;
	capabilityValue = "ready-officer";
	mockSetString.mockReset();
	mockNavigate.mockReset();
	mockGoBack.mockReset();
	mockCanGoBack.mockReset().mockReturnValue(true);
	mockGetJoinAnchor.mockReset().mockResolvedValue(ANCHOR);
	mockGetFoundingAnchor.mockClear();
	mockUsages.mockReset().mockResolvedValue([]);
	mockLocalMint.mockReset();
	mockPairMintGetter.mockReset().mockImplementation(() => mockLocalMint);
	mockLoadState.mockReset().mockImplementation(async () => ({
		hasNode: true,
		networkHash: NET,
		inviteCapability: "not-owner",
		isCurrentOfficer: true,
		signingKey: { key: KEY_PUB, type: "P" },
	}));
	mockCapability.mockReset().mockImplementation(() => capabilityValue);
	mockRequest.mockReset().mockImplementation(async (args: { readAnchor: () => Promise<unknown> }) => {
		await args.readAnchor();
		return okResult();
	});
	mockReadActiveNetworkHash.mockReset().mockResolvedValue(NET);
	mockReadPairedBrowsers.mockReset().mockResolvedValue([]);
	mockCreateDeviceSigner.mockClear();
	mockHandleSigningError.mockReset().mockReturnValue({ handled: false });
	mockShareQrImage.mockReset().mockResolvedValue("shared");
	mockDeleteQrImage.mockClear();
	mockCopy.mockReset().mockResolvedValue(true);
	jest.spyOn(Share, "share").mockReset().mockResolvedValue({ action: "sharedAction" } as never);
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
	jest.useRealTimers();
});

afterAll(() => {
	dims.set({ window: originalWindow, screen: originalScreen });
});

// ---------------------------------------------------------------------------------------------

describe("PairBrowserScreen", () => {
	it("S1 shows the checking line while the capability loads, then the idle body and the primary Request button", async () => {
		const gate = deferred<unknown>();
		mockLoadState.mockImplementationOnce(() => gate.promise);
		let tr!: renderer.ReactTestRenderer;
		act(() => {
			tr = renderer.create(<PairBrowserScreen />);
		});
		mounted.push(tr);
		await flush();
		expect(textOf(byId(tr, "pair-browser-checking"))).toContain(T.dashboardPairingChecking);
		expect(has(tr, "pair-browser-request")).toBe(false);
		await act(async () => {
			gate.resolve({ hasNode: true, networkHash: NET, inviteCapability: "ready", isCurrentOfficer: true, signingKey: { key: KEY_PUB, type: "P" } });
		});
		await flush();
		expect(has(tr, "pair-browser-checking")).toBe(false);
		expect(textOf(byId(tr, "pair-browser-ready"))).toContain(T.dashboardPairingIdleBody);
		const request = byId(tr, "pair-browser-request");
		expect(request.props.title).toBe(T.dashboardPairingRequestButton);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		expect(request.props.backgroundColor).toBe(require("../../../theme/themes").lightTheme.colors.primary);
		// The capability inputs: the strand db and the active network.
		expect(mockLoadState).toHaveBeenCalledWith(expect.objectContaining({ node: NODE, db: DB, networkHash: NET, userId: USER_ID }));
	});

	it("S2 the typed confirm gate holds the submit until 'I confirm' and resets on cancel", async () => {
		const tr = await mount();
		await press(tr, "pair-browser-request");
		expect(textOf(byId(tr, "pair-browser-confirm"))).toContain(T.dashboardPairingConfirmHeading);
		expect(textOf(byId(tr, "pair-browser-confirm"))).toContain(T.dashboardPairingConfirmBody);
		expect(byId(tr, "pair-browser-confirm-submit").props.disabled).toBe(true);
		typeConfirm(tr, "I confir");
		expect(byId(tr, "pair-browser-confirm-submit").props.disabled).toBe(true);
		typeConfirm(tr, T.iConfirm);
		expect(byId(tr, "pair-browser-confirm-submit").props.disabled).toBe(false);
		await press(tr, "pair-browser-confirm-cancel");
		expect(has(tr, "pair-browser-confirm")).toBe(false);
		await press(tr, "pair-browser-request");
		expect(tr.root.findByType(TextInput).props.value).toBe("");
		expect(byId(tr, "pair-browser-confirm-submit").props.disabled).toBe(true);
		expect(mockRequest).not.toHaveBeenCalled();
	});

	it("S3 two submit presses in one tick make one signer and one request", async () => {
		const tr = await mount();
		await press(tr, "pair-browser-request");
		typeConfirm(tr, T.iConfirm);
		await act(async () => {
			const submit = byId(tr, "pair-browser-confirm-submit");
			submit.props.onPress();
			submit.props.onPress();
		});
		await flush();
		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
		expect(mockRequest).toHaveBeenCalledTimes(1);
	});

	it("S4 passes node, strand db, signer, network, user, key, readAnchor, label null and a signal (officer phone: no localMint)", async () => {
		await toCodeReady();
		expect(mockCreateDeviceSigner).toHaveBeenCalledWith("Device User");
		const a = lastRequestArgs();
		expect(a.node).toBe(NODE);
		expect(a.db).toBe(DB);
		expect(a.signer).toBe(SIGNER);
		expect(a.networkHash).toBe(NET);
		expect(a.userId).toBe(USER_ID);
		expect(a.keyPub).toBe(KEY_PUB);
		expect(typeof a.readAnchor).toBe("function");
		expect(a.label).toBeNull();
		expect(a.signal instanceof AbortSignal).toBe(true);
		expect(a.localMint).toBeUndefined();
	});

	it("S4 an owner phone passes its local mint; an absent or null getter passes none", async () => {
		capabilityValue = "ready-owner";
		await toCodeReady();
		expect(lastRequestArgs().localMint).toBe(mockLocalMint);

		mockPairMintGetter.mockImplementation(() => null);
		await toCodeReady();
		expect(lastRequestArgs().localMint).toBeUndefined();
	});

	it("S5 the captured readAnchor reads getJoinAnchor once and strips the fingerprint; never getFoundingAnchor", async () => {
		mockRequest.mockImplementation(async () => okResult());
		await toCodeReady();
		const readAnchor = lastRequestArgs().readAnchor as () => Promise<unknown>;
		mockGetJoinAnchor.mockClear();
		const r = await readAnchor();
		expect(mockGetJoinAnchor).toHaveBeenCalledTimes(1);
		expect(mockGetJoinAnchor).toHaveBeenCalledWith(NET);
		expect(r).toEqual({ ok: true, anchor: { networkHash: NET, name: fixture.name, genesis: fixture.genesis, digest: fixture.digest } });
		expect(mockGetFoundingAnchor).not.toHaveBeenCalled();
	});

	it("S5 makeReadAnchor maps network-not-open to not-open and anything else to unreadable, by code only", async () => {
		const onAnchor = jest.fn();
		const engine = { getJoinAnchor: jest.fn().mockResolvedValue(ANCHOR) };
		const read = makeReadAnchor({ networksEngine: engine, networkHash: NET, onAnchor });
		const ok = await read();
		expect(ok).toEqual({ ok: true, anchor: { networkHash: NET, name: fixture.name, genesis: fixture.genesis, digest: fixture.digest } });
		expect(onAnchor).toHaveBeenCalledWith({ name: fixture.name, fingerprint: FINGERPRINT });

		engine.getJoinAnchor.mockRejectedValueOnce(Object.assign(new Error("anything"), { code: "network-not-open" }));
		expect(await read()).toEqual({ ok: false, anchor: "not-open" });
		engine.getJoinAnchor.mockRejectedValueOnce(Object.assign(new Error("network-not-open"), { code: "genesis-unreadable" }));
		expect(await read()).toEqual({ ok: false, anchor: "unreadable" });
		engine.getJoinAnchor.mockRejectedValueOnce(new Error("network-not-open"));
		expect(await read()).toEqual({ ok: false, anchor: "unreadable" });
		expect(engine.getJoinAnchor).toHaveBeenCalledTimes(4);
	});

	it("S6 while waiting: heading, body, spinner and Cancel; Cancel aborts and returns to ready", async () => {
		const pending = deferred<unknown>();
		mockRequest.mockImplementation(() => pending.promise);
		const tr = await toCodeReady();
		const waiting = byId(tr, "pair-browser-waiting");
		expect(textOf(waiting)).toContain(T.dashboardPairingWaitingHeading);
		expect(textOf(waiting)).toContain(T.dashboardPairingWaitingBody);
		expect(waiting.findAllByType(ActivityIndicator)).toHaveLength(1);
		const signal = lastRequestArgs().signal as AbortSignal;
		expect(signal.aborted).toBe(false);
		await press(tr, "pair-browser-cancel-request");
		expect(signal.aborted).toBe(true);
		expect(has(tr, "pair-browser-ready")).toBe(true);
		await act(async () => pending.resolve(okResult()));
		await flush();
		expect(has(tr, "pair-browser-code-ready")).toBe(false);
	});

	it("S6 unmounting while waiting aborts; a late result sets no state", async () => {
		const pending = deferred<unknown>();
		mockRequest.mockImplementation(() => pending.promise);
		const tr = await toCodeReady();
		const signal = lastRequestArgs().signal as AbortSignal;
		const capture = captureConsole();
		try {
			act(() => tr.unmount());
			expect(signal.aborted).toBe(true);
			await act(async () => pending.resolve(okResult()));
			await flush();
			expect(capture.calls().filter((c) => /unmounted|state update/i.test(String(c[0])))).toHaveLength(0);
		} finally {
			capture.restore();
		}
	});

	it("S7 code ready: heading, body minutes, countdown ticking, tile, hint, ordered buttons and warning; no code text anywhere", async () => {
		const tr = await toCodeReady();
		const block = byId(tr, "pair-browser-code-ready");
		expect(textOf(block)).toContain(T.dashboardPairingReadyHeading);
		expect(textOf(block)).toContain(T.dashboardPairingReadyBody.replace("{{minutes}}", "14"));
		expect(textOf(byId(tr, "pair-browser-countdown"))).toBe(T.dashboardPairingCountdown.replace("{{remaining}}", "14:00"));
		act(() => {
			jest.advanceTimersByTime(1_000);
		});
		expect(textOf(byId(tr, "pair-browser-countdown"))).toBe(T.dashboardPairingCountdown.replace("{{remaining}}", "13:59"));
		// The QR tile and its hint are hidden for this release:
		// const tile = byId(tr, "pair-browser-qr");
		// expect(tile.props.accessibilityLabel).toBe(T.dashboardPairingQrTileLabel);
		// expect(tile.props.accessibilityRole).toBe("button");
		// expect(byId(tr, "pair-browser-qr-image").props.accessible).toBe(false);
		// expect(textOf(block)).toContain(T.dashboardPairingQrHint);
		expect(has(tr, "pair-browser-qr")).toBe(false);
		expect(has(tr, "pair-browser-qr-open")).toBe(false);
		expect(textOf(byId(tr, "pair-browser-warning"))).toBe(T.dashboardPairingQrWarning);

		const order: string[] = [];
		for (const n of block.findAll((x) => typeof x.props.testID === "string")) {
			const id = n.props.testID as string;
			if (["pair-browser-qr-open", "pair-browser-copy", "pair-browser-share", "pair-browser-finish"].includes(id) && !order.includes(id)) {
				order.push(id);
			}
		}
		// expect(order).toEqual(["pair-browser-qr-open", "pair-browser-copy", "pair-browser-share", "pair-browser-finish"]); // with the QR
		expect(order).toEqual(["pair-browser-copy", "pair-browser-share", "pair-browser-finish"]);

		// Bearer hygiene: no Text child and no a11y / testID / nativeID prop holds any 16-char window.
		expect(windowHits(exposedStrings(tr).join("\n"), REAL_CODE)).toBe(0);
		// No selectable text in the ready block.
		expect(block.findAll((n) => n.props.selectable === true)).toHaveLength(0);
	});

	it("S8 Copy writes the code once, shows the notice and clears the clipboard on Finish", async () => {
		const tr = await toCodeReady();
		await press(tr, "pair-browser-copy");
		expect(mockCopy).toHaveBeenCalledTimes(1);
		expect(mockCopy.mock.calls[0][0] === REAL_CODE).toBe(true);
		expect(textOf(byId(tr, "pair-browser-copy-notice"))).toBe(T.dashboardPairingCopied);
		expect(mockSetString).not.toHaveBeenCalled();
		await press(tr, "pair-browser-finish");
		expect(mockSetString).toHaveBeenCalledWith("");
		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});

	it("S8 a failed copy shows the copy-failed notice", async () => {
		mockCopy.mockResolvedValue(false);
		const tr = await toCodeReady();
		await press(tr, "pair-browser-copy");
		expect(textOf(byId(tr, "pair-browser-copy-notice"))).toBe(T.dashboardPairingCopyFailed);
	});

	it("S8 the clipboard is cleared on expiry and on unmount only after a Copy, never after a Share alone", async () => {
		let tr = await toCodeReady();
		await press(tr, "pair-browser-share");
		act(() => tr.unmount());
		expect(mockSetString).not.toHaveBeenCalled();

		tr = await toCodeReady();
		await press(tr, "pair-browser-copy");
		act(() => tr.unmount());
		expect(mockSetString).toHaveBeenCalledWith("");

		mockSetString.mockClear();
		tr = await toCodeReady();
		await press(tr, "pair-browser-copy");
		act(() => {
			jest.advanceTimersByTime(15 * 60_000);
		});
		await flush();
		expect(has(tr, "pair-browser-expired")).toBe(true);
		expect(mockSetString).toHaveBeenCalledWith("");
	});

	it("S9 Share sends exactly the code text; a rejection shows the share notice", async () => {
		const tr = await toCodeReady();
		await press(tr, "pair-browser-share");
		const shareSpy = Share.share as unknown as jest.Mock;
		expect(shareSpy).toHaveBeenCalledTimes(1);
		const arg = shareSpy.mock.calls[0][0] as Record<string, unknown>;
		expect(Object.keys(arg)).toEqual(["message"]);
		expect(arg.message === REAL_CODE).toBe(true);
		expect(has(tr, "pair-browser-share-notice")).toBe(false);
		shareSpy.mockRejectedValueOnce(new Error("no share"));
		await press(tr, "pair-browser-share");
		expect(textOf(byId(tr, "pair-browser-share-notice"))).toBe(T.dashboardPairingShareFailed);
	});

	// S10, S11 and the S12 too-large test are commented out with the QR tile and the Show QR button (hidden for this release: the dashboard cannot scan pairing QR codes). Restore them with the QR.
// 	it("S10 the full-screen view: Modal props, officer and network names, share image with the fingerprint, cleanup and keep-awake", async () => {
// 		const tr = await toCodeReady();
// 		expect(keepAwake.__keepAwakeActiveCount()).toBe(0);
// 		await press(tr, "pair-browser-qr-open");
// 		const modal = tr.root.findAll((n) => n.props.presentationStyle === "fullScreen", { deep: false })[0];
// 		expect(modal.props.visible).toBe(true);
// 		expect(modal.props.statusBarTranslucent).toBe(true);
// 		expect(modal.props.navigationBarTranslucent).toBe(true);
// 		expect(modal.props.animationType).toBe("fade");
// 		expect(modal.props.supportedOrientations).toEqual(["portrait"]);
// 		expect(has(tr, "pair-browser-qr-view")).toBe(true);
// 		expect(keepAwake.__keepAwakeActiveCount()).toBe(1);
// 		const officer = byId(tr, "pair-browser-qr-officer");
// 		expect(textOf(officer)).toBe("Officer One");
// 		const officerStyle = StyleSheet.flatten(officer.props.style) as Record<string, unknown>;
// 		expect(officerStyle.fontSize).toBe(16);
// 		expect(officerStyle.fontWeight).toBe("600");
// 		expect(officerStyle.color).toBe("#000000");
// 		const network = byId(tr, "pair-browser-qr-network");
// 		expect(textOf(network)).toBe(fixture.name);
// 		const networkStyle = StyleSheet.flatten(network.props.style) as Record<string, unknown>;
// 		expect(networkStyle.fontSize).toBe(14);
// 		expect(networkStyle.color).toBe("#000000");
// 		expect(byId(tr, "pair-browser-qr-close").props.accessibilityLabel).toBe(T.dashboardPairingQrClose);

// 		await press(tr, "pair-browser-qr-share-image");
// 		expect(mockShareQrImage).toHaveBeenCalledTimes(1);
// 		const shareArg = mockShareQrImage.mock.calls[0][0] as { code: string; fingerprint: string };
// 		expect(shareArg.code === REAL_CODE).toBe(true);
// 		expect(shareArg.fingerprint).toBe(FINGERPRINT);
// 		mockShareQrImage.mockRejectedValueOnce(new Error("share"));
// 		await press(tr, "pair-browser-qr-share-image");
// 		expect(textOf(byId(tr, "pair-browser-qr-share-notice"))).toBe(T.dashboardPairingQrShareFailed);

// 		mockDeleteQrImage.mockClear();
// 		await press(tr, "pair-browser-qr-close");
// 		expect(mockDeleteQrImage).toHaveBeenCalled();
// 		expect(has(tr, "pair-browser-qr-view")).toBe(false);
// 		expect(keepAwake.__keepAwakeActiveCount()).toBe(0);
// 		// The bearer-hygiene scan holds with the view open too.
// 		await press(tr, "pair-browser-qr");
// 		expect(has(tr, "pair-browser-qr-view")).toBe(true);
// 		expect(windowHits(exposedStrings(tr).join("\n"), REAL_CODE)).toBe(0);
// 		mockDeleteQrImage.mockClear();
// 		act(() => tr.unmount());
// 		expect(mockDeleteQrImage).toHaveBeenCalled();
// 	});

// 	it("S10 the Share QR image button is absent when no fingerprint is known (and the network line is omitted)", async () => {
// 		mockRequest.mockImplementation(async () => okResult());
// 		const tr = await toCodeReady();
// 		await press(tr, "pair-browser-qr-open");
// 		expect(has(tr, "pair-browser-qr-view")).toBe(true);
// 		expect(has(tr, "pair-browser-qr-share-image")).toBe(false);
// 		expect(has(tr, "pair-browser-qr-network")).toBe(false);
// 		expect(textOf(byId(tr, "pair-browser-qr-officer"))).toBe("Officer One");
// 	});

// 	it("S11 geometry on a 1080 x 2400 px window: integer m >= 5, panel = m(n+8), integer lead; tile width x ratio = panelPx", async () => {
// 		const tr = await toCodeReady();
// 		const ratio = PixelRatio.get();
// 		expect(ratio).toBe(2.625);
// 		const n = REAL_N;
// 		const tileImg = byId(tr, "pair-browser-qr-image");
// 		const tileStyle = StyleSheet.flatten(tileImg.props.style) as { width: number; height: number };
// 		const tilePanel = qrLayout(n, 160 * ratio).panelPx;
// 		expect(Math.round(tileStyle.width * ratio)).toBe(tilePanel);
// 		expect(Math.abs(tileStyle.width * ratio - tilePanel)).toBeLessThan(1e-6);

// 		await press(tr, "pair-browser-qr-open");
// 		const full = byId(tr, "pair-browser-qr-full");
// 		const style = StyleSheet.flatten(full.props.style) as { width: number; height: number; marginLeft: number };
// 		const panelPx = Math.round(style.width * ratio);
// 		const m = panelPx / (n + 8);
// 		expect(Number.isInteger(m)).toBe(true);
// 		expect(m).toBeGreaterThanOrEqual(PAIRING_QR_MIN_MODULE_PX);
// 		expect(panelPx).toBe(m * (n + 8));
// 		expect(panelPx).toBeLessThanOrEqual(1080);
// 		expect(1080 - panelPx).toBeLessThan(n + 8);
// 		const lead = style.marginLeft * ratio;
// 		expect(Math.abs(lead - Math.round(lead))).toBeLessThan(1e-6);
// 		expect(Math.round(lead)).toBe(Math.floor((1080 - panelPx) / 2));
// 	});

	it(`S12 STOP RULE: the realistic code (${REAL_CODE.length} chars, n=${REAL_N}, m=${REAL_M} at 1080 px) fits one scannable QR`, () => {
		expect(REAL_CODE.length).toBeGreaterThanOrEqual(2600);
		expect(REAL_CODE.length).toBeLessThanOrEqual(2953);
		expect(REAL_N).toBeLessThanOrEqual(PAIRING_QR_MAX_MODULES);
		expect(REAL_M).toBeGreaterThanOrEqual(PAIRING_QR_MIN_MODULE_PX);
		expect(pairingQrFits(REAL_CODE)).toBe(true);
		expect(pairingQrFits(TOO_LARGE_CODE)).toBe(false);
		expect(pairingQrFits("")).toBe(false);
	});

// 	it("S12 a code too large for a QR shows the notice, no tile and no Show QR; Copy and Share remain", async () => {
// 		currentCode = TOO_LARGE_CODE;
// 		const tr = await toCodeReady();
// 		expect(textOf(byId(tr, "pair-browser-qr-too-large"))).toBe(T.dashboardPairingQrTooLarge);
// 		expect(has(tr, "pair-browser-qr")).toBe(false);
// 		expect(has(tr, "pair-browser-qr-open")).toBe(false);
// 		expect(has(tr, "pair-browser-copy")).toBe(true);
// 		expect(has(tr, "pair-browser-share")).toBe(true);
// 	});

	it("S13 past the expiry the screen shows expired with Request; Copy, Share and QR are gone", async () => {
		const tr = await toCodeReady();
		act(() => {
			jest.advanceTimersByTime(14 * 60_000 + 1_000);
		});
		await flush();
		expect(textOf(byId(tr, "pair-browser-expired"))).toBe(T.dashboardPairingExpired);
		expect(has(tr, "pair-browser-request")).toBe(true);
		for (const id of ["pair-browser-copy", "pair-browser-share", "pair-browser-qr", "pair-browser-qr-open"]) {
			expect(has(tr, id)).toBe(false);
		}
	});

	it("S14 a redeemed invitation flips the screen to used on the next poll; polling then stops", async () => {
		mockReadPairedBrowsers.mockResolvedValue([
			{ nonce: "other-nonce-000000000000", inviteKey: "other-key", userId: USER_ID, networkHash: NET, mintedAt: NOW, expiresAt: EXPIRES_AT, label: null },
			{ nonce: NONCE, inviteKey: "invite-key-1", userId: USER_ID, networkHash: NET, mintedAt: NOW, expiresAt: EXPIRES_AT, label: null },
		]);
		mockUsages.mockResolvedValueOnce([{ inviteKey: "other-key", peerId: "p" }]);
		const tr = await toCodeReady();
		act(() => {
			jest.advanceTimersByTime(PAIRING_USAGE_POLL_MS);
		});
		await flush();
		expect(has(tr, "pair-browser-code-ready")).toBe(true);
		expect(mockReadPairedBrowsers).toHaveBeenCalledWith({ networkHash: NET, userId: USER_ID });
		expect(mockUsages).toHaveBeenCalledWith(false);
		mockUsages.mockResolvedValue([{ inviteKey: "invite-key-1", peerId: "p" }]);
		act(() => {
			jest.advanceTimersByTime(PAIRING_USAGE_POLL_MS);
		});
		await flush();
		expect(textOf(byId(tr, "pair-browser-used"))).toBe(T.dashboardPairingUsed);
		expect(byId(tr, "pair-browser-pair-another").props.title).toBe(T.dashboardPairingPairAnotherButton);
		const frozen = mockUsages.mock.calls.length;
		act(() => {
			jest.advanceTimersByTime(PAIRING_USAGE_POLL_MS * 4);
		});
		await flush();
		expect(mockUsages.mock.calls.length).toBe(frozen);
		await press(tr, "pair-browser-pair-another");
		expect(has(tr, "pair-browser-confirm")).toBe(true);
	});

	it("S14 polling stops after Finish and after unmount", async () => {
		let tr = await toCodeReady();
		await press(tr, "pair-browser-finish");
		let frozen = mockReadPairedBrowsers.mock.calls.length;
		act(() => {
			jest.advanceTimersByTime(PAIRING_USAGE_POLL_MS * 3);
		});
		await flush();
		expect(mockReadPairedBrowsers.mock.calls.length).toBe(frozen);

		tr = await toCodeReady();
		act(() => tr.unmount());
		frozen = mockReadPairedBrowsers.mock.calls.length;
		act(() => {
			jest.advanceTimersByTime(PAIRING_USAGE_POLL_MS * 3);
		});
		await flush();
		expect(mockReadPairedBrowsers.mock.calls.length).toBe(frozen);
	});

	it("S15 pairingFailureState is total over the engine's reasons", () => {
		const table: Array<[string, string]> = [
			["owner-unreachable", "owner-unreachable"],
			["not-reachable", "owner-unreachable"],
			["switched-off", "refused-off"],
			["not-allowed", "refused-not-allowed"],
			["build-failed", "build-failed"],
			["cancelled", "ready"],
		];
		for (const [reason, state] of table) expect(pairingFailureState(reason as never)).toBe(state);
	});

	it.each([
		["owner-unreachable", "pair-browser-owner-unreachable", [T.dashboardPairingOwnerUnreachableHeading, T.dashboardPairingOwnerUnreachableBody], true],
		["not-reachable", "pair-browser-owner-unreachable", [T.dashboardPairingOwnerUnreachableHeading], true],
		["switched-off", "pair-browser-refused-off", [T.dashboardPairingSwitchedOff], false],
		["not-allowed", "pair-browser-refused-not-allowed", [T.dashboardPairingNotAllowed], false],
		["build-failed", "pair-browser-build-failed", [T.dashboardPairingBuildFailed], true],
	])("S15 reason %s renders its state", async (reason, id, texts, retry) => {
		mockRequest.mockResolvedValue({ ok: false, reason });
		const tr = await toCodeReady();
		for (const text of texts as string[]) expect(textOf(byId(tr, id as string))).toContain(text);
		expect(has(tr, "pair-browser-retry")).toBe(retry);
		if (retry) {
			mockRequest.mockImplementation(async () => okResult());
			await press(tr, "pair-browser-retry");
			expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(2);
			expect(mockRequest).toHaveBeenCalledTimes(2);
			expect(has(tr, "pair-browser-code-ready")).toBe(true);
		}
	});

	it("S15 a cancelled result returns to ready with no message", async () => {
		mockRequest.mockResolvedValue({ ok: false, reason: "cancelled" });
		const tr = await toCodeReady();
		expect(has(tr, "pair-browser-ready")).toBe(true);
		expect(has(tr, "pair-browser-build-failed")).toBe(false);
	});

	it("S16 signer errors route to the hook: handled -> ready; message -> inline error; none -> build failed", async () => {
		const noKey = { code: "NO_KEY_PROVISIONED" };
		mockRequest.mockRejectedValue(noKey);
		mockHandleSigningError.mockReturnValueOnce({ handled: true });
		let tr = await toCodeReady();
		expect(mockHandleSigningError).toHaveBeenCalledWith(noKey);
		expect(has(tr, "pair-browser-ready")).toBe(true);
		expect(textOf(tr.root)).not.toContain(T.dashboardPairingBuildFailed);

		mockHandleSigningError.mockReturnValueOnce({ handled: false, message: "Mapped signing copy" });
		mockRequest.mockRejectedValue({ code: "SOME_SIGNING_CODE" });
		tr = await toCodeReady();
		expect(textOf(tr.root)).toContain("Mapped signing copy");
		expect(has(tr, "pair-browser-ready")).toBe(true);

		mockHandleSigningError.mockReturnValueOnce({ handled: false });
		tr = await toCodeReady();
		expect(has(tr, "pair-browser-build-failed")).toBe(true);

		mockHandleSigningError.mockReturnValueOnce({ handled: false, message: "peer copy" });
		mockRequest.mockRejectedValue(new Error("no code here"));
		tr = await toCodeReady();
		expect(has(tr, "pair-browser-build-failed")).toBe(true);
		expect(mockNavigate).not.toHaveBeenCalled();
	});

	it.each([
		["no-network", T.dashboardPairingUnavailableNoNetwork],
		["not-officer", T.dashboardPairingUnavailableNotOfficer],
		["no-signing-key", T.dashboardPairingUnavailableNoKey],
	])("S17 capability %s shows unavailable with its line and no Request", async (capability, line) => {
		capabilityValue = capability;
		const tr = await mount();
		const block = byId(tr, "pair-browser-unavailable");
		expect(textOf(block)).toContain(T.dashboardPairingUnavailable);
		expect(textOf(block)).toContain(line);
		expect(has(tr, "pair-browser-request")).toBe(false);
		expect(mockRequest).not.toHaveBeenCalled();
		expect(mockNavigate).not.toHaveBeenCalled();
	});

	it("S17 a missing strand database reads as no network", async () => {
		mockReadActiveNetworkHash.mockResolvedValue(null);
		capabilityValue = "no-network";
		await mount();
		expect(mockLoadState).toHaveBeenCalledWith(expect.objectContaining({ db: null, networkHash: null }));
	});

	it("S18 the whole flow under console capture leaks no window of the code; the source logs closed tags only", async () => {
		const capture = captureConsole();
		try {
			const tr = await toCodeReady();
			await press(tr, "pair-browser-copy");
			(Share.share as unknown as jest.Mock).mockRejectedValueOnce(new Error(REAL_CODE));
			await press(tr, "pair-browser-share");
			// The QR view is hidden for this release:
			// mockShareQrImage.mockRejectedValueOnce(new Error(REAL_CODE));
			// await press(tr, "pair-browser-qr-open");
			// await press(tr, "pair-browser-qr-share-image");
			// await press(tr, "pair-browser-qr-close");
			await press(tr, "pair-browser-finish");
			// A hostile request failure whose message carries the code.
			mockRequest.mockRejectedValueOnce(new Error(REAL_CODE));
			const tr2 = await toCodeReady();
			expect(has(tr2, "pair-browser-build-failed")).toBe(true);
			// Cancel while waiting.
			const pending = deferred<unknown>();
			mockRequest.mockImplementationOnce(() => pending.promise);
			await press(tr2, "pair-browser-retry");
			await press(tr2, "pair-browser-cancel-request");
			await act(async () => pending.resolve(okResult()));
			await flush();
			expectNoSecretInConsole(capture, [REAL_CODE]);
			const warned = capture.calls().filter((c) => c[0] === "[pair-browser] request failed:");
			expect(warned).toHaveLength(1);
			expect(warned[0][1]).toBe("Error");
		} finally {
			capture.restore();
		}
		expect(nonLiteralConsoleFirstArgs(SOURCE)).toEqual([]);
		expect(/console\.(log|debug)\(/.test(SOURCE)).toBe(false);
	});

	it("S19 the root is a KeyboardAvoidingScreen with a pinned Footer", async () => {
		const tr = await mount();
		const root = tr.root.findByType(KeyboardAvoidingScreen);
		expect(root.props.testID).toBe("pair-browser-screen");
		expect(root.findAllByType(Footer)).toHaveLength(1);
	});

	it("S20 source: no services import, no snapshot export, no founding-anchor reader, nothing selectable", () => {
		expect(SOURCE.includes("../../services/")).toBe(false);
		expect(SOURCE.includes("export" + "DashboardSnapshot")).toBe(false);
		expect(SOURCE.includes("getFounding" + "Anchor")).toBe(false);
		expect(/\bselectable\b/.test(SOURCE)).toBe(false);
		expect(SOURCE.includes("getJoinAnchor(")).toBe(true);
		expect(SOURCE.includes("usePairMintLocal()")).toBe(true);
		expect(SOURCE.includes("ProvisionSigningKey")).toBe(false);
	});
});
