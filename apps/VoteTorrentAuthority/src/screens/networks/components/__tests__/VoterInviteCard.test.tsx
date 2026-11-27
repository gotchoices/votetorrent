/**
 * VoterInviteCard.test.tsx — "Invite voters" (spike 100; Phase 64 plan 17: D-01, D-03, D-06). Real
 * i18n resources and the real engines/voter-invite logic; the node, the networks engine,
 * device-user, clipboard and Share are mocked. Comparisons of code text are boolean: a failing
 * matcher would print the credential.
 */
import React from "react";
import { AccessibilityInfo, Dimensions, StyleSheet } from "react-native";
import renderer, { act } from "react-test-renderer";
import jsQR from "jsqr";
import { decodeNetworkJoinCode, encodeNetworkJoinCode } from "@votetorrent/vote-engine/rn";
import { JOIN_CODE_FIXTURES, type JoinCodeFixtureName } from "@votetorrent/vote-engine/test/fixtures/join-code-fixtures";
import { resources } from "../../../../i18n";
import { captureConsole, type ConsoleCapture } from "../../../../engines/__fixtures__/console-leak";
import { QR_MAX_TEXT_CHARS } from "../../../../utils/qr/qr-matrix";
import { buildQrPanelPng } from "../../../../utils/qr/qr-panel";

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

const mockThemeState = { dark: false };
jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { lightTheme, darkTheme } = require("../../../../theme/themes");
		return mockThemeState.dark ? darkTheme : lightTheme;
	},
}));

jest.mock("react-native-safe-area-context", () => ({
	SafeAreaProvider: ({ children }: { children: unknown }) => children,
	useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

function fixtureParts(name: JoinCodeFixtureName) {
	const d = decodeNetworkJoinCode(JOIN_CODE_FIXTURES[name].text);
	if (!d.ok) throw new Error("fixture did not decode");
	const { networkHash, name: networkName, genesis, digest } = d.code;
	return { invitation: d.code.invitation, anchor: { networkHash, name: networkName, genesis, digest, fingerprint: d.fingerprint } };
}
const MINT = fixtureParts("v2-1-member").invitation;
const CODE = JOIN_CODE_FIXTURES["v2-1-member"].text;

const mockAnchorState = { anchor: fixtureParts("v2-1-member").anchor, invitation: MINT };
const mockOpen = jest.fn(async () => ({}));
const mockGetFoundingAnchor = jest.fn(async () => mockAnchorState.anchor);
jest.mock("../../../../providers/AppProvider", () => ({
	useApp: () => ({ networksEngine: { open: mockOpen, getFoundingAnchor: mockGetFoundingAnchor } }),
}));

const mockNodeState: { owners: Set<string>; node: unknown; seeded: boolean; addrs: string[]; configFault: unknown } = {
	owners: new Set(),
	node: null,
	seeded: false,
	addrs: [],
	configFault: null,
};
function makeNode() {
	return {
		peerId: { toString: () => "self-peer" },
		getMultiaddrs: () => mockNodeState.addrs,
		getIdentityOwnerKey: () => ({ publicKeyB64: "self-pub", privateKeyB64: "self-priv" }),
		getSeedBootstrapService: () => ({ canAuthorize: () => mockNodeState.seeded }),
		getControlDatabase: () => ({
			queryCadrePeers: async () => [],
			getOwnerKeys: async () => new Set(mockNodeState.owners),
			ensureOwnerKey: jest.fn(async (key: string) => {
				mockNodeState.owners.add(key);
				return true;
			}),
		}),
		trustOwnerKeys: jest.fn(async () => undefined),
		initializeSeedBootstrap: jest.fn(async () => {
			mockNodeState.seeded = true;
		}),
		createCadreInvitation: jest.fn(async () => ({ encoded: mockAnchorState.invitation, invitation: { invite: { expiresAt: "2026-11-11T11:26:21.316" } } })),
	};
}
jest.mock("../../../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: mockNodeState.node, configFault: mockNodeState.configFault }),
}));
jest.mock("../../../../engines/device-user", () => ({
	getDeviceUser: async () => ({ id: "user-1", name: "O", activeKeys: [{ key: "key-1", type: "ed25519" }] }),
}));
const mockCopy = jest.fn(async () => true);
jest.mock("../../../../utils/copyToClipboard", () => ({ copyToClipboard: (...a: unknown[]) => mockCopy(...(a as [])) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VoterInviteCard } = require("../VoterInviteCard");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Share } = require("react-native");

const T = resources.en.translation;
const REF = { hash: "hashA", name: "Network A", relays: [], primaryAuthorityDomainName: "a.example" };

async function flush() {
	for (let i = 0; i < 12; i++) {
		// eslint-disable-next-line no-await-in-loop
		await act(async () => {
			await Promise.resolve();
		});
	}
}
// Trees subscribe to Dimensions changes, so a tree left mounted would re-render under the next
// test's profile. Every tree is unmounted after its test.
const mounted: renderer.ReactTestRenderer[] = [];
async function render(onClose = jest.fn()) {
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<VoterInviteCard networkRef={REF} onClose={onClose} />);
	});
	await flush();
	mounted.push(tr);
	return tr;
}
const byId = (tr: renderer.ReactTestRenderer, id: string) => tr.root.find((n) => n.props.testID === id);
const hasId = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAll((n) => n.props.testID === id).length > 0;
const textOf = (node: renderer.ReactTestInstance) =>
	node.findAll((n) => typeof n.props.children === "string").map((n) => n.props.children).join(" ");

interface FsMock {
	CachesDirectoryPath: string;
	writeFile: jest.Mock;
	__fsFiles(): Array<{ path: string }>;
	__resetFsMock(): void;
}
interface KeepAwakeMock {
	__keepAwakeActiveCount(): number;
	__resetKeepAwakeMock(): void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fsMock = require("../../../../../__mocks__/@dr.pogodin/react-native-fs.js") as FsMock;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const keepAwake = require("../../../../../__mocks__/@sayem314/react-native-keep-awake.js") as KeepAwakeMock;
interface DecodedPng {
	width: number;
	height: number;
	data: Uint8Array;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PNG } = require("pngjs") as { PNG: { sync: { read(data: Uint8Array): DecodedPng } } };

const FILE = fsMock.CachesDirectoryPath + "/votetorrent-join-code.png";
const URI_PREFIX = "data:image/png;base64,";
const QR_TOKEN = "[voter-invite] qr: failed";
const dims = Dimensions as unknown as { set(p: unknown): void };
const originalWindow = Dimensions.get("window");
const originalScreen = Dimensions.get("screen");
function setProfile(width: number, height: number, scale: number) {
	const physical = { width, height, scale, fontScale: 1 };
	dims.set({ windowPhysicalPixels: physical, screenPhysicalPixels: physical });
}
afterAll(() => {
	dims.set({ window: originalWindow, screen: originalScreen });
});

function windowHits(haystack: string, secret: string): number {
	let hits = 0;
	for (let i = 0; i + 16 <= secret.length; i++) if (haystack.includes(secret.slice(i, i + 16))) hits++;
	return hits;
}
function tokenCount(c: ConsoleCapture, token: string): number {
	return c.calls().filter((a) => a.length === 1 && a[0] === token).length;
}
const styleOf = (node: renderer.ReactTestInstance) => (StyleSheet.flatten(node.props.style) ?? {}) as Record<string, unknown>;
const outermost = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAll((n) => n.props.testID === id, { deep: false })[0]!;
const uriOf = (node: renderer.ReactTestInstance) => (node.props.source as { uri: string }).uri;
function readBack(uri: string): string | null {
	const img = PNG.sync.read(Buffer.from(uri.slice(URI_PREFIX.length), "base64"));
	const found = jsQR(new Uint8ClampedArray(img.data), img.width, img.height, { inversionAttempts: "dontInvert" });
	return found === null ? null : found.data;
}
/** Every string the tree exposes to a reader: children, labels, hints, ids. */
function exposedStrings(tr: renderer.ReactTestRenderer): string[] {
	const out: string[] = [];
	for (const n of tr.root.findAll(() => true)) {
		for (const v of [n.props.children, n.props.accessibilityLabel, n.props.accessibilityHint, n.props.testID, n.props.nativeID]) {
			if (typeof v === "string") out.push(v);
		}
	}
	return out;
}

let capture: ConsoleCapture;
afterEach(() => {
	for (const tr of mounted.splice(0)) act(() => tr.unmount());
	capture.restore();
});

beforeEach(() => {
	capture = captureConsole();
	setProfile(1080, 2400, 2.625);
	mockThemeState.dark = false;
	mockAnchorState.anchor = fixtureParts("v2-1-member").anchor;
	mockAnchorState.invitation = MINT;
	fsMock.__resetFsMock();
	keepAwake.__resetKeepAwakeMock();
	mockNodeState.owners = new Set();
	mockNodeState.seeded = false;
	mockNodeState.addrs = ["/ip4/203.0.113.7/tcp/443/wss/p2p/relay/p2p-circuit/p2p/self-peer"];
	mockNodeState.configFault = null;
	mockNodeState.node = makeNode();
	mockOpen.mockClear();
	mockGetFoundingAnchor.mockClear();
	mockCopy.mockClear();
});

describe("VoterInviteCard", () => {
	it("on this phone's own cadre: generates at once and shows the fingerprint, the expiry and the code", async () => {
		mockNodeState.owners = new Set(["self-pub"]);
		const tr = await render();
		expect(hasId(tr, "voter-invite-body-ready")).toBe(true);
		expect(byId(tr, "voter-invite-fingerprint").props.children).toBe(mockAnchorState.anchor.fingerprint);
		expect(hasId(tr, "voter-invite-expiry")).toBe(true);
		expect(byId(tr, "voter-invite-ready-body").props.children).toBe(T.voterInviteReadyBody);
		// D-03/D-06: the code text is no longer rendered anywhere a reader can see it.
		expect(hasId(tr, "voter-invite-code")).toBe(false);
		expect(windowHits(exposedStrings(tr).join("\n"), CODE)).toBe(0);
		await act(async () => {
			byId(tr, "voter-invite-copy").props.onPress();
		});
		await flush();
		const code = (mockCopy.mock.calls[0] as unknown as [string])[0];
		expect(code === CODE).toBe(true);
		const decoded = decodeNetworkJoinCode(code);
		expect(decoded.ok && decoded.code.v === 2).toBe(true);
		expect(decoded.ok && decoded.code.invitation === MINT).toBe(true);
		expect(mockOpen).toHaveBeenCalledWith(REF, expect.objectContaining({ id: "user-1" }), false);
		expect(mockGetFoundingAnchor).toHaveBeenCalledWith("hashA", { userId: "user-1", signerKey: "key-1" });
	});

	it("an ownerless cadre asks first, and only a confirm makes this phone the owner", async () => {
		const node = mockNodeState.node as ReturnType<typeof makeNode>;
		const tr = await render();
		expect(hasId(tr, "voter-invite-body-confirm-owner")).toBe(true);
		expect(textOf(byId(tr, "voter-invite-body-confirm-owner"))).toContain(T.voterInviteOwnerTitle);
		expect(node.trustOwnerKeys).not.toHaveBeenCalled();
		expect(node.createCadreInvitation).not.toHaveBeenCalled();

		await act(async () => {
			await byId(tr, "voter-invite-owner-confirm").props.onPress();
		});
		await flush();
		expect(node.trustOwnerKeys).toHaveBeenCalledWith(["self-pub"], "operator");
		expect(node.initializeSeedBootstrap).toHaveBeenCalledWith("self-priv");
		expect(hasId(tr, "voter-invite-body-ready")).toBe(true);
	});

	it("Cancel on the owner question closes without any change", async () => {
		const onClose = jest.fn();
		const node = mockNodeState.node as ReturnType<typeof makeNode>;
		const tr = await render(onClose);
		act(() => {
			byId(tr, "voter-invite-cancel").props.onPress();
		});
		expect(onClose).toHaveBeenCalled();
		expect(node.trustOwnerKeys).not.toHaveBeenCalled();
	});

	it("a cadre someone else owns: explains that the owner device must invite", async () => {
		mockNodeState.owners = new Set(["drone-owner"]);
		const tr = await render();
		expect(textOf(byId(tr, "voter-invite-body-not-owner"))).toContain(T.voterInviteNotOwner);
	});

	it("a failure shows translated copy only, and Try again regenerates", async () => {
		mockNodeState.owners = new Set(["self-pub"]);
		mockGetFoundingAnchor.mockImplementationOnce(async () => {
			throw new Error("RAW ENGINE TEXT");
		});
		const tr = await render();
		const body = byId(tr, "voter-invite-body-error");
		expect(textOf(body)).toContain(T.voterInviteFailed);
		expect(textOf(body)).not.toContain("RAW ENGINE TEXT");
		await act(async () => {
			await byId(tr, "voter-invite-retry").props.onPress();
		});
		await flush();
		expect(hasId(tr, "voter-invite-body-ready")).toBe(true);
	});

	it("Copy puts the code on the clipboard and confirms; Share sends name, fingerprint and code", async () => {
		mockNodeState.owners = new Set(["self-pub"]);
		const shareSpy = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" });
		const tr = await render();
		await act(async () => {
			byId(tr, "voter-invite-copy").props.onPress();
		});
		await flush();
		const code = (mockCopy.mock.calls[0] as unknown as [string])[0];
		expect(code === CODE).toBe(true);
		expect(byId(tr, "voter-invite-copy-notice").props.children).toBe(T.voterInviteCopied);
		await act(async () => {
			byId(tr, "voter-invite-share").props.onPress();
		});
		const message = (shareSpy.mock.calls[0]![0] as { message: string }).message;
		expect(message.includes(mockAnchorState.anchor.name)).toBe(true);
		expect(message.includes(mockAnchorState.anchor.fingerprint)).toBe(true);
		expect(message.includes(code)).toBe(true);
		shareSpy.mockRestore();
	});

	const UNDIALABLE = "createCadreInvitation: neither this machine nor any other machine of the party has an address a device could dial";
	function refuseMint() {
		const node = mockNodeState.node as ReturnType<typeof makeNode>;
		node.createCadreInvitation.mockImplementationOnce(async () => {
			throw new Error(UNDIALABLE);
		});
	}

	it("a phone with no relay address says it is not connected yet, with one closed token", async () => {
		mockNodeState.owners = new Set(["self-pub"]);
		mockNodeState.addrs = [];
		refuseMint();
		const tr = await render();
		const body = textOf(byId(tr, "voter-invite-body-error"));
		expect(body).toContain(T.voterInviteFailedNotReachable);
		expect(body).not.toContain(UNDIALABLE);
		expect(tokenCount(capture, "[voter-invite] generate: not-reachable")).toBe(1);
	});

	it("with no relay configured in the app, it says so instead", async () => {
		mockNodeState.owners = new Set(["self-pub"]);
		mockNodeState.addrs = [];
		mockNodeState.configFault = { kind: "missing", reason: "empty-address-list" };
		refuseMint();
		const tr = await render();
		expect(textOf(byId(tr, "voter-invite-body-error"))).toContain(T.voterInviteFailedNoRelay);
		expect(tokenCount(capture, "[voter-invite] generate: no-relay-config")).toBe(1);
	});

	it("a network this phone did not found says only its founding officer can invite", async () => {
		mockNodeState.owners = new Set(["self-pub"]);
		mockGetFoundingAnchor.mockImplementationOnce(async () => {
			throw Object.assign(new Error("founding bundle export refused: not-founding-officer"), { code: "not-founding-officer" });
		});
		const tr = await render();
		expect(textOf(byId(tr, "voter-invite-body-error"))).toContain(T.voterInviteFailedNotFounder);
	});

	it("a network that does not open in time says so", async () => {
		jest.useFakeTimers();
		try {
			mockNodeState.owners = new Set(["self-pub"]);
			mockOpen.mockImplementationOnce(() => new Promise(() => undefined));
			const tr = await render();
			await act(async () => {
				jest.advanceTimersByTime(45000);
			});
			await flush();
			expect(textOf(byId(tr, "voter-invite-body-error"))).toContain(T.voterInviteFailedOpenTimeout);
		} finally {
			jest.useRealTimers();
		}
	});

	it("no node yet: an error, not a hang", async () => {
		mockNodeState.node = null;
		const tr = await render();
		expect(hasId(tr, "voter-invite-body-error")).toBe(true);
	});
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { QR_FOCUS_RETURN_DELAY_MS } = require("../VoterInviteCard");

describe("VoterInviteCard QR (Phase 64 plan 17)", () => {
	beforeEach(() => {
		mockNodeState.owners = new Set(["self-pub"]);
	});

	it("C-2: the inline QR is a labelled button drawing the 160 dp panel with a 1 px outline in each theme", async () => {
		for (const dark of [false, true]) {
			mockThemeState.dark = dark;
			const tr = await render();
			const open = outermost(tr, "voter-invite-qr");
			expect(open.props.accessibilityRole).toBe("button");
			expect(open.props.accessibilityLabel).toBe(T.voterInviteQrThumbA11y);
			const image = outermost(tr, "voter-invite-qr-image");
			const expected = buildQrPanelPng(CODE, 160 * 2.625);
			expect(uriOf(image) === URI_PREFIX + expected.base64).toBe(true);
			expect(Math.round((styleOf(image).width as number) * 2.625)).toBe(expected.panelPx);
			expect(Math.round((styleOf(image).height as number) * 2.625)).toBe(expected.panelPx);
			expect([image.props.accessible, image.props.resizeMode, image.props.fadeDuration]).toEqual([false, "stretch", 0]);
			let outline: renderer.ReactTestInstance | null = image.parent;
			while (outline && styleOf(outline).borderWidth === undefined) outline = outline.parent;
			expect(outline).not.toBeNull();
			expect(Math.abs((styleOf(outline!).borderWidth as number) - 1 / 2.625)).toBeLessThan(1e-9);
			expect(styleOf(outline!).borderColor).toBe(dark ? "#606060" : "#D0D0D0");
			const hint = tr.root.find((n) => n.props.children === T.voterInviteQrHint);
			expect(hint.props.numberOfLines).toBeUndefined();
			act(() => tr.unmount());
		}
	});

	it("C-3: the ready body runs thumbnail, fingerprint, expiry, Show QR code, Copy, Share, Done", async () => {
		const tr = await render();
		const body = byId(tr, "voter-invite-body-ready");
		const ids: string[] = [];
		for (const n of body.findAll((x) => typeof x.props.testID === "string")) {
			if (n.props.testID === "voter-invite-body-ready") continue;
			let a = n.parent;
			let nested = false;
			while (a && a.props.testID !== "voter-invite-body-ready") {
				if (typeof a.props.testID === "string") nested = true;
				a = a.parent;
			}
			if (!nested) ids.push(n.props.testID as string);
		}
		expect(ids).toEqual([
			"voter-invite-ready-body",
			"voter-invite-qr",
			"voter-invite-fingerprint",
			"voter-invite-expiry",
			"voter-invite-qr-open",
			"voter-invite-copy",
			"voter-invite-share",
			"voter-invite-done",
		]);
		const openButton = byId(tr, "voter-invite-qr-open");
		expect([openButton.props.title, openButton.props.icon, openButton.props.backgroundColor]).toEqual([T.voterInviteQrOpen, "qrcode", "#007AFF"]);
	});

	it("C-4: the Modal (and keep-awake) exist only while open; both openers work; the panel reads back to the copied code", async () => {
		const tr = await render();
		expect(keepAwake.__keepAwakeActiveCount()).toBe(0);
		expect(hasId(tr, "voter-invite-qr-full")).toBe(false);
		await act(async () => {
			byId(tr, "voter-invite-copy").props.onPress();
		});
		await flush();
		const copied = (mockCopy.mock.calls[0] as unknown as [string])[0];

		act(() => outermost(tr, "voter-invite-qr").props.onPress());
		expect(hasId(tr, "voter-invite-qr-full")).toBe(true);
		expect(keepAwake.__keepAwakeActiveCount()).toBe(1);
		expect(readBack(uriOf(outermost(tr, "voter-invite-qr-full"))) === copied).toBe(true);
		await act(async () => {
			byId(tr, "voter-invite-qr-close").props.onPress();
		});
		expect(hasId(tr, "voter-invite-qr-full")).toBe(false);
		expect(keepAwake.__keepAwakeActiveCount()).toBe(0);

		act(() => byId(tr, "voter-invite-qr-open").props.onPress());
		expect(hasId(tr, "voter-invite-qr-full")).toBe(true);
		expect(keepAwake.__keepAwakeActiveCount()).toBe(1);
		const modal = tr.root.findAll((n) => n.props.presentationStyle === "fullScreen", { deep: false })[0]!;
		await act(async () => {
			modal.props.onRequestClose();
		});
		expect(hasId(tr, "voter-invite-qr-full")).toBe(false);
		expect(keepAwake.__keepAwakeActiveCount()).toBe(0);
	});

	it("C-5: closing returns accessibility focus to the Show QR code button after the delay, never before and never after unmount", async () => {
		const send = jest.spyOn(AccessibilityInfo, "sendAccessibilityEvent").mockImplementation(() => {});
		try {
			const tr = await render();
			// The ref travels CustomButton -> TouchableOpacity -> Animated.View -> the View mock class,
			// the innermost node with a class instance among those carrying this testID.
			const withInstance = tr.root.findAll((n) => n.props.testID === "voter-invite-qr-open" && n.instance != null);
			const target = withInstance[withInstance.length - 1]!.instance;
			// Real timers: jest's fake timers left the following tests' act() queue stuck (measured), so the
			// delay is waited out for real, with margin for a loaded host.
			const wait = (ms: number) =>
				act(async () => {
					await new Promise((resolve) => setTimeout(resolve, ms));
				});
			act(() => byId(tr, "voter-invite-qr-open").props.onPress());
			await wait(QR_FOCUS_RETURN_DELAY_MS + 100);
			expect(send).not.toHaveBeenCalled();
			await act(async () => {
				byId(tr, "voter-invite-qr-close").props.onPress();
			});
			expect(send).not.toHaveBeenCalled();
			await wait(QR_FOCUS_RETURN_DELAY_MS + 150);
			expect(send).toHaveBeenCalledTimes(1);
			expect(send.mock.calls[0]![0] === target).toBe(true);
			expect(send.mock.calls[0]![1]).toBe("focus");

			// Unmount during the delay: no focus call.
			send.mockClear();
			act(() => byId(tr, "voter-invite-qr-open").props.onPress());
			await act(async () => {
				byId(tr, "voter-invite-qr-close").props.onPress();
			});
			act(() => tr.unmount());
			await wait(QR_FOCUS_RETURN_DELAY_MS + 150);
			expect(send).not.toHaveBeenCalled();
		} finally {
			send.mockRestore();
		}
	});

	it("C-6: the cache file is gone after the view closes and after the card unmounts, open or closed", async () => {
		let tr = await render();
		act(() => byId(tr, "voter-invite-qr-open").props.onPress());
		await fsMock.writeFile(FILE, "AAAA", "base64");
		await act(async () => {
			byId(tr, "voter-invite-qr-close").props.onPress();
		});
		await flush();
		expect(fsMock.__fsFiles()).toEqual([]);

		tr = await render();
		act(() => byId(tr, "voter-invite-qr-open").props.onPress());
		await fsMock.writeFile(FILE, "AAAA", "base64");
		await act(async () => {
			tr.unmount();
		});
		await flush();
		expect(fsMock.__fsFiles()).toEqual([]);

		tr = await render();
		await fsMock.writeFile(FILE, "AAAA", "base64");
		await act(async () => {
			tr.unmount();
		});
		await flush();
		expect(fsMock.__fsFiles()).toEqual([]);
	});

	it("C-7: a code too long for a QR keeps Copy and Share, shows the translated line and logs one token", async () => {
		const parts = fixtureParts("v2-6-members");
		let k = 1;
		const make = (n: number) =>
			encodeNetworkJoinCode({ v: 2, invitation: parts.invitation, networkHash: parts.anchor.networkHash, name: "é".repeat(n), genesis: parts.anchor.genesis, digest: parts.anchor.digest });
		while (make(k).length <= QR_MAX_TEXT_CHARS && k < 256) k++;
		expect(make(k).length).toBeGreaterThan(QR_MAX_TEXT_CHARS);
		expect(make(k).length).toBeLessThanOrEqual(4096);
		mockAnchorState.anchor = { ...parts.anchor, name: "é".repeat(k) };
		mockAnchorState.invitation = parts.invitation;
		const long = make(k);
		const tr = await render();
		expect(hasId(tr, "voter-invite-body-ready")).toBe(true);
		expect(byId(tr, "voter-invite-qr-render-failed").props.children).toBe(T.voterInviteQrRenderFailed);
		expect(hasId(tr, "voter-invite-qr")).toBe(false);
		expect(hasId(tr, "voter-invite-qr-open")).toBe(false);
		await act(async () => {
			byId(tr, "voter-invite-copy").props.onPress();
		});
		await flush();
		expect((mockCopy.mock.calls[0] as unknown as [string])[0] === long).toBe(true);
		const shareSpy = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" });
		await act(async () => {
			byId(tr, "voter-invite-share").props.onPress();
		});
		expect(((shareSpy.mock.calls[0]![0] as { message: string }).message).includes(long)).toBe(true);
		shareSpy.mockRestore();
		expect(tokenCount(capture, QR_TOKEN)).toBe(1);
	});

	it("C-8: at scale 1 the thumbnail cannot hold one pixel per module and the card shows the translated line", async () => {
		mockAnchorState.anchor = fixtureParts("v2-6-members").anchor;
		mockAnchorState.invitation = fixtureParts("v2-6-members").invitation;
		setProfile(411, 914, 1);
		const tr = await render();
		expect(byId(tr, "voter-invite-qr-render-failed").props.children).toBe(T.voterInviteQrRenderFailed);
		expect(hasId(tr, "voter-invite-qr")).toBe(false);
		expect(tokenCount(capture, QR_TOKEN)).toBe(1);
	});

	it("C-9: with the view open, no text, label, hint, testID or nativeID anywhere holds a 16-char window of the code", async () => {
		const tr = await render();
		act(() => byId(tr, "voter-invite-qr-open").props.onPress());
		expect(hasId(tr, "voter-invite-qr-full")).toBe(true);
		const strings = exposedStrings(tr);
		expect(strings.length).toBeGreaterThan(0);
		expect(windowHits(strings.join("\n"), CODE)).toBe(0);
		expect(windowHits(strings.join("\n"), MINT)).toBe(0);
	});
});
