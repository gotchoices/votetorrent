/**
 * VoterInviteQr.consoleLeak.test.tsx - Phase 64 Plan 17 (D-06). The join code is a bearer
 * credential in text and in image form. Over every QR flow, no console call may carry the code, the
 * invitation mint, the network name, the fingerprint, a 16-char window of any of them or of either
 * PNG's base64, or a binary argument; the only lines are the closed [voter-invite] tokens. Hostile
 * errors planted below carry the code and data URIs, and are built from fixture data at runtime.
 */
import React from "react";
import { Dimensions } from "react-native";
import renderer, { act } from "react-test-renderer";
import Share from "react-native-share";
import { decodeNetworkJoinCode, encodeNetworkJoinCode } from "@votetorrent/vote-engine/rn";
import { JOIN_CODE_FIXTURES, type JoinCodeFixtureName } from "@votetorrent/vote-engine/test/fixtures/join-code-fixtures";
import { captureConsole, expectNoSecretInConsole, type ConsoleCapture } from "../../../../engines/__fixtures__/console-leak";
import { QR_MAX_TEXT_CHARS } from "../../../../utils/qr/qr-matrix";
import { bytesToBase64 } from "../../../../utils/qr/gray-png";
import { buildQrPanelPng } from "../../../../utils/qr/qr-panel";
import { buildShareQrPng } from "../../../../utils/qr/share-png";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, vars?: Record<string, string>) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources: res } = require("../../../../i18n");
			const value = (res.en.translation as Record<string, string>)[key];
			if (typeof value !== "string") return key;
			return value.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => vars?.[k] ?? "");
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { lightTheme } = require("../../../../theme/themes");
		return lightTheme;
	},
}));

jest.mock("react-native-safe-area-context", () => ({
	SafeAreaProvider: ({ children }: { children: unknown }) => children,
	useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

const mockAnchorState: { anchor: Record<string, unknown>; invitation: string } = { anchor: {}, invitation: "" };
jest.mock("../../../../providers/AppProvider", () => ({
	useApp: () => ({ networksEngine: { open: jest.fn(async () => ({})), getFoundingAnchor: jest.fn(async () => mockAnchorState.anchor) } }),
}));

const mockNodeState: { node: unknown } = { node: null };
function makeNode() {
	const owners = new Set<string>(["self-pub"]);
	return {
		peerId: { toString: () => "self-peer" },
		getIdentityOwnerKey: () => ({ publicKeyB64: "self-pub", privateKeyB64: "self-priv" }),
		getSeedBootstrapService: () => ({ canAuthorize: () => true }),
		getControlDatabase: () => ({
			queryCadrePeers: async () => [],
			getOwnerKeys: async () => new Set(owners),
			ensureOwnerKey: jest.fn(async () => true),
		}),
		trustOwnerKeys: jest.fn(async () => undefined),
		initializeSeedBootstrap: jest.fn(async () => undefined),
		createCadreInvitation: jest.fn(async () => ({ encoded: mockAnchorState.invitation, invitation: { invite: { expiresAt: "2026-11-11T11:26:21.316" } } })),
	};
}
jest.mock("../../../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: mockNodeState.node }),
}));
jest.mock("../../../../engines/device-user", () => ({
	getDeviceUser: async () => ({ id: "user-1", name: "O", activeKeys: [{ key: "key-1", type: "ed25519" }] }),
}));
jest.mock("../../../../utils/copyToClipboard", () => ({ copyToClipboard: async () => true }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VoterInviteCard } = require("../VoterInviteCard");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VoterInviteQrView } = require("../VoterInviteQrView");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Share: RnShare } = require("react-native");

interface FsMock {
	CachesDirectoryPath: string;
	writeFile: jest.Mock;
	exists: jest.Mock;
	unlink: jest.Mock;
	__resetFsMock(): void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fsMock = require("../../../../../__mocks__/@dr.pogodin/react-native-fs.js") as FsMock;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const keepAwake = require("../../../../../__mocks__/@sayem314/react-native-keep-awake.js") as { __resetKeepAwakeMock(): void };

const open = Share.open as jest.Mock;
const REF = { hash: "hashA", name: "Network A", relays: [], primaryAuthorityDomainName: "a.example" };
const TOKENS = {
	qr: "[voter-invite] qr: failed",
	"qr-share": "[voter-invite] qr-share: failed",
	generate: "[voter-invite] generate: failed",
	share: "[voter-invite] share: failed",
	capability: "[voter-invite] capability: failed",
} as const;
type Expect = Partial<Record<keyof typeof TOKENS, number>>;

const dims = Dimensions as unknown as { set(p: unknown): void };
const originalWindow = Dimensions.get("window");
const originalScreen = Dimensions.get("screen");
afterAll(() => {
	dims.set({ window: originalWindow, screen: originalScreen });
});

function parts(name: JoinCodeFixtureName) {
	const text = JOIN_CODE_FIXTURES[name].text;
	const d = decodeNetworkJoinCode(text);
	if (!d.ok) throw new Error("fixture did not decode");
	const { networkHash, name: networkName, genesis, digest } = d.code;
	return {
		text,
		mint: d.code.invitation,
		networkName,
		fingerprint: d.fingerprint,
		anchor: { networkHash, name: networkName, genesis, digest, fingerprint: d.fingerprint },
	};
}

/** Every secret a flow could leak: text, mint, name, fingerprint and the three image encodings. */
function secretsFor(text: string, mint: string, networkName: string, fingerprint: string): string[] {
	return [
		text,
		mint,
		networkName,
		fingerprint,
		buildQrPanelPng(text, 160 * 2.625).base64,
		buildQrPanelPng(text, 1080).base64,
		bytesToBase64(buildShareQrPng(text, fingerprint)),
	];
}

function assertTokens(c: ConsoleCapture, expected: Expect): void {
	const allowed = new Set<string>(Object.values(TOKENS));
	for (const call of c.calls()) {
		expect(call.length).toBe(1);
		expect(typeof call[0] === "string" && allowed.has(call[0])).toBe(true);
	}
	for (const key of Object.keys(TOKENS) as Array<keyof typeof TOKENS>) {
		const n = c.calls().filter((call) => call[0] === TOKENS[key]).length;
		expect([key, n]).toEqual([key, expected[key] ?? 0]);
	}
}

async function flush() {
	for (let i = 0; i < 12; i++) {
		// eslint-disable-next-line no-await-in-loop
		await act(async () => {
			await Promise.resolve();
		});
	}
}
const mounted: renderer.ReactTestRenderer[] = [];
async function renderCard(): Promise<renderer.ReactTestRenderer> {
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<VoterInviteCard networkRef={REF} onClose={jest.fn()} />);
	});
	await flush();
	mounted.push(tr);
	return tr;
}
function renderView(code: string, fingerprint: string): renderer.ReactTestRenderer {
	let tr!: renderer.ReactTestRenderer;
	act(() => {
		tr = renderer.create(<VoterInviteQrView code={code} fingerprint={fingerprint} onClose={jest.fn()} />);
	});
	mounted.push(tr);
	return tr;
}
const byId = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAll((n) => n.props.testID === id, { deep: false })[0]!;
const hasId = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAll((n) => n.props.testID === id).length > 0;
async function press(tr: renderer.ReactTestRenderer, id: string) {
	await act(async () => {
		byId(tr, id).props.onPress();
	});
	await flush();
}

let capture: ConsoleCapture;
beforeEach(() => {
	capture = captureConsole();
	const physical = { width: 1080, height: 2400, scale: 2.625, fontScale: 1 };
	dims.set({ windowPhysicalPixels: physical, screenPhysicalPixels: physical });
	fsMock.__resetFsMock();
	keepAwake.__resetKeepAwakeMock();
	open.mockReset();
	open.mockImplementation(async () => ({ success: true, message: "" }));
	mockNodeState.node = makeNode();
});
afterEach(() => {
	for (const tr of mounted.splice(0)) act(() => tr.unmount());
	capture.restore();
});

function setAnchor(name: JoinCodeFixtureName) {
	const p = parts(name);
	mockAnchorState.anchor = p.anchor;
	mockAnchorState.invitation = p.mint;
	return p;
}

/** The v2-6-members anchor with a name of `k` 'é' characters, and the code the real encoder makes of it. */
function longNameAnchor(k: number) {
	const p = parts("v2-6-members");
	const anchor = { ...p.anchor, name: "é".repeat(k) };
	return { p, anchor, encode: () => encodeNetworkJoinCode({ v: 2, invitation: p.mint, networkHash: anchor.networkHash, name: anchor.name, genesis: anchor.genesis, digest: anchor.digest }) };
}

const CARD_NAMES = ["v2-1-member", "v2-6-members"] as const;
const VIEW_NAMES = ["v2-1-member", "v2-6-members", "v1-legacy-1-member"] as const;

describe("card flows: no code, mint, name, fingerprint, image or slice reaches the console", () => {
	it.each(CARD_NAMES)("%s L1: render to ready with the thumbnail", async (name) => {
		const p = setAnchor(name);
		const tr = await renderCard();
		expect(hasId(tr, "voter-invite-qr-image")).toBe(true);
		assertTokens(capture, {});
		expectNoSecretInConsole(capture, secretsFor(p.text, p.mint, p.networkName, p.fingerprint));
	});

	it.each(CARD_NAMES)("%s L2: open by the thumbnail, close by X, reopen by Show QR code, close by onRequestClose", async (name) => {
		const p = setAnchor(name);
		const tr = await renderCard();
		await press(tr, "voter-invite-qr");
		expect(hasId(tr, "voter-invite-qr-full")).toBe(true);
		await press(tr, "voter-invite-qr-close");
		await press(tr, "voter-invite-qr-open");
		expect(hasId(tr, "voter-invite-qr-full")).toBe(true);
		await act(async () => {
			tr.root.findAll((n) => n.props.presentationStyle === "fullScreen", { deep: false })[0]!.props.onRequestClose();
		});
		await flush();
		expect(hasId(tr, "voter-invite-qr-full")).toBe(false);
		assertTokens(capture, {});
		expectNoSecretInConsole(capture, secretsFor(p.text, p.mint, p.networkName, p.fingerprint));
	});

	it.each(CARD_NAMES)("%s L3: share success", async (name) => {
		const p = setAnchor(name);
		const tr = await renderCard();
		await press(tr, "voter-invite-qr-open");
		await press(tr, "voter-invite-qr-share");
		expect(open).toHaveBeenCalledTimes(1);
		assertTokens(capture, {});
		expectNoSecretInConsole(capture, secretsFor(p.text, p.mint, p.networkName, p.fingerprint));
	});

	it.each(CARD_NAMES)("%s L4: share dismissed", async (name) => {
		const p = setAnchor(name);
		open.mockImplementation(async () => ({ success: false, dismissedAction: true, message: "" }));
		const tr = await renderCard();
		await press(tr, "voter-invite-qr-open");
		await press(tr, "voter-invite-qr-share");
		expect(open).toHaveBeenCalledTimes(1);
		assertTokens(capture, {});
		expectNoSecretInConsole(capture, secretsFor(p.text, p.mint, p.networkName, p.fingerprint));
	});

	it.each(CARD_NAMES)("%s L5: a share rejection carrying the code and a data URI logs the closed token once", async (name) => {
		const p = setAnchor(name);
		open.mockImplementation(async () => {
			throw Object.assign(new Error(p.text), { code: "EUNSPECIFIED", url: "data:image/png;base64," + buildQrPanelPng(p.text, 1080).base64 });
		});
		const tr = await renderCard();
		await press(tr, "voter-invite-qr-open");
		await press(tr, "voter-invite-qr-share");
		expect(hasId(tr, "voter-invite-qr-share-notice")).toBe(true);
		assertTokens(capture, { "qr-share": 1 });
		expectNoSecretInConsole(capture, secretsFor(p.text, p.mint, p.networkName, p.fingerprint));
	});

	it.each(CARD_NAMES)("%s L6: a write failure carrying the share PNG's base64 logs the closed token once", async (name) => {
		const p = setAnchor(name);
		const shareBase64 = bytesToBase64(buildShareQrPng(p.text, p.fingerprint));
		fsMock.writeFile.mockImplementationOnce(async () => {
			throw new Error(shareBase64);
		});
		const tr = await renderCard();
		await press(tr, "voter-invite-qr-open");
		await press(tr, "voter-invite-qr-share");
		expect(open).not.toHaveBeenCalled();
		assertTokens(capture, { "qr-share": 1 });
		expectNoSecretInConsole(capture, secretsFor(p.text, p.mint, p.networkName, p.fingerprint));
	});

	it.each(CARD_NAMES)("%s L10: the card unmounting with the view open while the cleanup fails logs the closed token once", async (name) => {
		const p = setAnchor(name);
		const tr = await renderCard();
		await press(tr, "voter-invite-qr-open");
		fsMock.exists.mockImplementationOnce(async () => true);
		fsMock.unlink.mockImplementationOnce(async () => {
			throw Object.assign(new Error(p.text), { code: "EACCES" });
		});
		await act(async () => {
			tr.unmount();
		});
		await flush();
		assertTokens(capture, { "qr-share": 1 });
		expectNoSecretInConsole(capture, secretsFor(p.text, p.mint, p.networkName, p.fingerprint));
	});

	it("L8: a code too long for a QR logs the render token once, and Copy and the text Share stay quiet", async () => {
		const parts6 = parts("v2-6-members");
		let k = 1;
		const long = longNameAnchor(k);
		while (longNameAnchor(k).encode().length <= QR_MAX_TEXT_CHARS && k < 256) k++;
		const a = longNameAnchor(k);
		const text = a.encode();
		expect(text.length).toBeGreaterThan(QR_MAX_TEXT_CHARS);
		expect(long.p.text).toBe(parts6.text);
		mockAnchorState.anchor = a.anchor;
		mockAnchorState.invitation = parts6.mint;
		const shareSpy = jest.spyOn(RnShare, "share").mockResolvedValue({ action: "sharedAction" });
		const tr = await renderCard();
		expect(hasId(tr, "voter-invite-qr-render-failed")).toBe(true);
		await press(tr, "voter-invite-copy");
		await press(tr, "voter-invite-share");
		shareSpy.mockRestore();
		assertTokens(capture, { qr: 1 });
		expectNoSecretInConsole(capture, [text, parts6.mint, a.anchor.name, parts6.fingerprint, bytesToBase64(buildShareQrPng(parts6.text, parts6.fingerprint))]);
	});

	it("L11: a code past 4096 chars fails closed with the generate token once and shows the error body", async () => {
		const a = longNameAnchor(256);
		mockAnchorState.anchor = a.anchor;
		mockAnchorState.invitation = a.p.mint;
		const tr = await renderCard();
		expect(hasId(tr, "voter-invite-body-error")).toBe(true);
		assertTokens(capture, { generate: 1 });
		expectNoSecretInConsole(capture, [a.p.text, a.p.mint, a.anchor.name, a.p.fingerprint]);
	});
});

describe("direct view flows (text prop)", () => {
	it.each(VIEW_NAMES)("%s L7: a fingerprint outside the atlas logs the share token once", async (name) => {
		const p = parts(name);
		const tr = renderView(p.text, "zzzz zzzz zzzz zzzz");
		await press(tr, "voter-invite-qr-share");
		expect(open).not.toHaveBeenCalled();
		assertTokens(capture, { "qr-share": 1 });
		expectNoSecretInConsole(capture, secretsFor(p.text, p.mint, p.networkName, p.fingerprint));
	});

	it.each(VIEW_NAMES)("%s L9: the panel Image onError with the code in the event logs the render token once", async (name) => {
		const p = parts(name);
		const tr = renderView(p.text, p.fingerprint);
		act(() => {
			byId(tr, "voter-invite-qr-full").props.onError({ nativeEvent: { error: p.text } });
		});
		assertTokens(capture, { qr: 1 });
		expectNoSecretInConsole(capture, secretsFor(p.text, p.mint, p.networkName, p.fingerprint));
	});

	it.each(VIEW_NAMES)("%s: share success, dismissal and rejection through the view stay clean", async (name) => {
		const p = parts(name);
		const tr = renderView(p.text, p.fingerprint);
		await press(tr, "voter-invite-qr-share");
		open.mockImplementationOnce(async () => ({ success: false, dismissedAction: true, message: "" }));
		await press(tr, "voter-invite-qr-share");
		open.mockImplementationOnce(async () => {
			throw Object.assign(new Error(p.text), { code: "EUNSPECIFIED", url: "data:image/png;base64," + buildQrPanelPng(p.text, 1080).base64 });
		});
		await press(tr, "voter-invite-qr-share");
		await press(tr, "voter-invite-qr-close");
		assertTokens(capture, { "qr-share": 1 });
		expectNoSecretInConsole(capture, secretsFor(p.text, p.mint, p.networkName, p.fingerprint));
	});
});
