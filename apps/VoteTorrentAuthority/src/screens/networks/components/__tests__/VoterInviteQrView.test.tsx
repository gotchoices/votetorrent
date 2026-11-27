/**
 * VoterInviteQrView.test.tsx - Phase 64 Plan 17 (D-03, D-04, D-06). The full-screen QR Modal: the
 * panel is the largest integer-module square that fits, drawn full-bleed at an integer device-pixel
 * lead offset with no horizontal padding on any ancestor. Every expected number is computed from the
 * 64-10 builders, never written as a literal N. Comparisons of code text are boolean: a failing
 * matcher would print the credential.
 */
import React from "react";
import { Dimensions, PixelRatio, Platform, StyleSheet } from "react-native";
import renderer, { act } from "react-test-renderer";
import jsQR from "jsqr";
import { JOIN_CODE_FIXTURES, type JoinCodeFixtureName } from "@votetorrent/vote-engine/test/fixtures/join-code-fixtures";
import Share from "react-native-share";
import { decodeNetworkJoinCode } from "@votetorrent/vote-engine/rn";
import { resources } from "../../../../i18n";
import { captureConsole, type ConsoleCapture } from "../../../../engines/__fixtures__/console-leak";
import { buildQrMatrix } from "../../../../utils/qr/qr-matrix";
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

const mockInsets = { top: 24, bottom: 24, left: 0, right: 0 };
jest.mock("react-native-safe-area-context", () => ({
	SafeAreaProvider: ({ children }: { children: unknown }) => children,
	useSafeAreaInsets: () => mockInsets,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VoterInviteQrView, QR_VIEW_CHROME_DP, qrViewTargetPx } = require("../VoterInviteQrView");

interface FsMock {
	CachesDirectoryPath: string;
	writeFile: jest.Mock;
	exists: jest.Mock;
	unlink: jest.Mock;
	__fsFiles(): Array<{ path: string }>;
	__resetFsMock(): void;
}
interface KeepAwakeMock {
	deactivateKeepAwake: jest.Mock;
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
interface PngjsModule {
	PNG: { sync: { read(data: Uint8Array): DecodedPng } };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PNG } = require("pngjs") as PngjsModule;

const T = resources.en.translation as Record<string, string>;
const NAMES = ["v2-1-member", "v2-2-members", "v2-6-members", "v2-non-ascii-name", "v1-legacy-1-member"] as const;
const FILE = fsMock.CachesDirectoryPath + "/votetorrent-join-code.png";
const URI_PREFIX = "data:image/png;base64,";
const QR_TOKEN = "[voter-invite] qr: failed";
const SHARE_TOKEN = "[voter-invite] qr-share: failed";

type Profile = { width: number; height: number; scale: number };
const PIXEL_8: Profile = { width: 1080, height: 2400, scale: 2.625 };
const WIDE: Profile = { width: 1440, height: 3120, scale: 3.5 };
const SHORT: Profile = { width: 1080, height: 1500, scale: 2.625 };
const NARROW: Profile = { width: 100, height: 2400, scale: 2.625 };

const dims = Dimensions as unknown as { set(p: unknown): void; get(k: string): unknown };
const originalWindow = Dimensions.get("window");
const originalScreen = Dimensions.get("screen");
function setProfile(p: Profile) {
	const physical = { width: p.width, height: p.height, scale: p.scale, fontScale: 1 };
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
async function flush() {
	for (let i = 0; i < 12; i++) {
		// eslint-disable-next-line no-await-in-loop
		await act(async () => {
			await Promise.resolve();
		});
	}
}

// Trees subscribe to Dimensions changes, so a tree left mounted would re-render under the next
// test's profile and log into its capture. Every tree is unmounted after its test.
const mounted: renderer.ReactTestRenderer[] = [];
type Props = { code: string; fingerprint: string; onClose: () => void };
function mount(code: string, fingerprint = "17b0 6508 2fd5 aab2", onClose: () => void = jest.fn()): renderer.ReactTestRenderer {
	let tr!: renderer.ReactTestRenderer;
	const props: Props = { code, fingerprint, onClose };
	act(() => {
		tr = renderer.create(<VoterInviteQrView {...props} />);
	});
	mounted.push(tr);
	return tr;
}
const byId = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAll((n) => n.props.testID === id, { deep: false })[0]!;
const hasId = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAll((n) => n.props.testID === id).length > 0;
const modalOf = (tr: renderer.ReactTestRenderer) => tr.root.findAll((n) => n.props.presentationStyle === "fullScreen", { deep: false })[0]!;
const textOf = (node: renderer.ReactTestInstance) =>
	node.findAll((n) => typeof n.props.children === "string").map((n) => n.props.children as string).join(" ");
const styleOf = (node: renderer.ReactTestInstance) => (StyleSheet.flatten(node.props.style) ?? {}) as Record<string, unknown>;
function uriOf(tr: renderer.ReactTestRenderer): string {
	return (byId(tr, "voter-invite-qr-full").props.source as { uri: string }).uri;
}
function decodeUri(uri: string): DecodedPng {
	return PNG.sync.read(Buffer.from(uri.slice(URI_PREFIX.length), "base64"));
}
function readBack(img: DecodedPng): string | null {
	const found = jsQR(new Uint8ClampedArray(img.data), img.width, img.height, { inversionAttempts: "dontInvert" });
	return found === null ? null : found.data;
}
function tokenCount(capture: ConsoleCapture, token: string): number {
	return capture.calls().filter((c) => c.length === 1 && c[0] === token).length;
}
function textFor(name: JoinCodeFixtureName): string {
	return JOIN_CODE_FIXTURES[name].text;
}

let capture: ConsoleCapture;
beforeEach(() => {
	setProfile(PIXEL_8);
	mockThemeState.dark = false;
	fsMock.__resetFsMock();
	keepAwake.__resetKeepAwakeMock();
	(Share.open as jest.Mock).mockReset();
	(Share.open as jest.Mock).mockImplementation(async () => ({ success: true, message: "" }));
	capture = captureConsole();
});
afterEach(() => {
	for (const tr of mounted.splice(0)) act(() => tr.unmount());
	capture.restore();
});

describe("full-screen panel geometry", () => {
	it.each(NAMES)("%s: the Pixel_8 panel is the largest integer fit at an integer lead offset", (name) => {
		const text = textFor(name);
		const tr = mount(text);
		const ratio = 2.625;
		const expected = buildQrPanelPng(text, 1080);
		const n = buildQrMatrix(text).n;
		const image = byId(tr, "voter-invite-qr-full");
		expect(uriOf(tr) === URI_PREFIX + expected.base64).toBe(true);
		expect(expected.m).toBe(Math.floor(1080 / (n + 8)));
		expect(expected.m).toBeGreaterThanOrEqual(6);
		const style = styleOf(image);
		expect(Math.round((style.width as number) * ratio)).toBe(expected.panelPx);
		expect(Math.round((style.height as number) * ratio)).toBe(expected.panelPx);
		expect(Math.abs((style.marginLeft as number) * ratio - Math.floor((1080 - expected.panelPx) / 2))).toBeLessThan(1e-6);
		expect(image.props.resizeMode).toBe("stretch");
		expect(image.props.fadeDuration).toBe(0);
		expect(image.props.accessible).toBe(false);
		expect(typeof image.props.onError).toBe("function");
	});

	it.each(["v2-1-member", "v1-legacy-1-member"] as const)("%s: the drawn PNG is panelPx square and jsQR reads the code back", (name) => {
		const text = textFor(name);
		const tr = mount(text);
		const img = decodeUri(uriOf(tr));
		expect(img.width).toBe(buildQrPanelPng(text, 1080).panelPx);
		expect(img.height).toBe(img.width);
		expect(readBack(img) === text).toBe(true);
	});

	it.each(NAMES)("%s: no ancestor of the panel has horizontal padding or margin, and the row is 100% wide", (name) => {
		const tr = mount(textFor(name));
		const zeroKeys = ["padding", "paddingHorizontal", "paddingLeft", "paddingRight", "paddingStart", "paddingEnd", "margin", "marginHorizontal", "marginLeft", "marginRight", "marginStart", "marginEnd"];
		const image = byId(tr, "voter-invite-qr-full");
		let node: renderer.ReactTestInstance | null = image.parent;
		let row: renderer.ReactTestInstance | null = null;
		while (node) {
			const style = styleOf(node);
			if (row === null && style.width === "100%") row = node;
			for (const k of zeroKeys) {
				const v = style[k];
				expect(v === undefined || v === 0).toBe(true);
			}
			node = node.parent;
		}
		expect(row).not.toBeNull();
	});

	it.each(NAMES)("%s: wide and height-bound phones keep the largest fit and the integer lead offset", (name) => {
		const text = textFor(name);
		const n = buildQrMatrix(text).n;
		setProfile(WIDE);
		let tr = mount(text);
		let expected = buildQrPanelPng(text, 1440);
		expect(expected.m).toBe(Math.floor(1440 / (n + 8)));
		expect(uriOf(tr) === URI_PREFIX + expected.base64).toBe(true);
		let style = styleOf(byId(tr, "voter-invite-qr-full"));
		expect(Math.abs((style.marginLeft as number) * 3.5 - Math.floor((1440 - expected.panelPx) / 2))).toBeLessThan(1e-6);

		setProfile(SHORT);
		tr = mount(text);
		const chromePx = Math.round((QR_VIEW_CHROME_DP + 24 + 24) * 2.625);
		const target = qrViewTargetPx({ windowWidthPx: 1080, windowHeightPx: 1500, chromePx });
		expect(target).toBe(Math.min(1080, 1500 - chromePx));
		expected = buildQrPanelPng(text, target);
		expect(expected.panelPx).toBeLessThanOrEqual(target);
		expect(expected.m).toBe(Math.floor(target / (n + 8)));
		expect(uriOf(tr) === URI_PREFIX + expected.base64).toBe(true);
		style = styleOf(byId(tr, "voter-invite-qr-full"));
		expect(Math.abs((style.marginLeft as number) * 2.625 - Math.floor((1080 - expected.panelPx) / 2))).toBeLessThan(1e-6);
	});

	it("qrViewTargetPx is the smaller of the width and the height left after the chrome", () => {
		expect(qrViewTargetPx({ windowWidthPx: 1080, windowHeightPx: 2400, chromePx: 900 })).toBe(1080);
		expect(qrViewTargetPx({ windowWidthPx: 1080, windowHeightPx: 1500, chromePx: 900 })).toBe(600);
	});
});

describe("content and Modal props", () => {
	it.each([false, true])("fingerprint, labels, share button and the white surface (dark theme %s)", (dark) => {
		mockThemeState.dark = dark;
		const fingerprint = "17b0 6508 2fd5 aab2";
		const tr = mount(textFor("v2-1-member"), fingerprint);
		const fp = byId(tr, "voter-invite-qr-fingerprint");
		expect(fp.props.children).toBe(fingerprint);
		const s = styleOf(fp);
		expect([s.fontSize, s.fontWeight, s.lineHeight, s.color]).toEqual([24, "600", 32, "#000000"]);
		expect(s.fontFamily).toBe(Platform.select({ ios: "Menlo", default: "monospace" }));
		expect(fp.props.selectable).toBe(true);
		expect(fp.props.maxFontSizeMultiplier).toBe(1.5);
		expect(fp.props.numberOfLines).toBeUndefined();
		expect(textOf(byId(tr, "voter-invite-qr-view"))).toContain(T.networkFoundingExportFingerprintLabel);
		expect(byId(tr, "voter-invite-qr-warning").props.children).toBe(T.voterInviteQrWarning);

		const close = byId(tr, "voter-invite-qr-close");
		expect(close.props.accessibilityRole).toBe("button");
		expect(close.props.accessibilityLabel).toBe(T.voterInviteQrClose);
		expect([styleOf(close).width, styleOf(close).height]).toEqual([48, 48]);

		const share = byId(tr, "voter-invite-qr-share");
		expect(share.props.title).toBe(T.voterInviteQrShareImage);
		expect(share.props.icon).toBe("share-nodes");
		expect(share.props.backgroundColor).toBe("#d9d9d9");
		expect(share.props.forceDarkText).toBe(true);

		expect(styleOf(byId(tr, "voter-invite-qr-view")).backgroundColor).toBe("#FFFFFF");
		const all = textOf(tr.root);
		const decoded = decodeNetworkJoinCode(textFor("v2-1-member"));
		expect(decoded.ok && decoded.code.name.length > 0 && all.includes(decoded.code.name)).toBe(false);
		expect(all.includes(T.voterInviteExpires.split("{{")[0]!)).toBe(false);
	});

	it("the Modal is a portrait full-screen, translucent, fading presentation", () => {
		const tr = mount(textFor("v2-1-member"));
		const modal = modalOf(tr);
		expect(modal.props.visible).toBe(true);
		expect(modal.props.presentationStyle).toBe("fullScreen");
		expect(modal.props.statusBarTranslucent).toBe(true);
		expect(modal.props.navigationBarTranslucent).toBe(true);
		expect(modal.props.animationType).toBe("fade");
		expect(modal.props.supportedOrientations).toEqual(["portrait"]);
		expect(typeof modal.props.onRequestClose).toBe("function");
	});

	it("keeps the screen awake exactly while mounted", () => {
		expect(keepAwake.__keepAwakeActiveCount()).toBe(0);
		const tr = mount(textFor("v2-1-member"));
		expect(keepAwake.__keepAwakeActiveCount()).toBe(1);
		act(() => tr.unmount());
		expect(keepAwake.__keepAwakeActiveCount()).toBe(0);
		expect(keepAwake.deactivateKeepAwake).toHaveBeenCalledTimes(1);
	});

	it("no accessibility label, hint, testID or nativeID holds a 16-char window of the code", () => {
		for (const name of NAMES) {
			const text = textFor(name);
			const tr = mount(text);
			const values = tr.root
				.findAll(() => true)
				.flatMap((n) => [n.props.accessibilityLabel, n.props.accessibilityHint, n.props.testID, n.props.nativeID])
				.filter((v): v is string => typeof v === "string");
			expect(values.length).toBeGreaterThan(0);
			expect(windowHits(values.join("\n"), text)).toBe(0);
			act(() => tr.unmount());
		}
	});
});

describe("closing and cleanup", () => {
	it("the X and onRequestClose each call onClose once and delete a planted cache file", async () => {
		for (const how of ["x", "back"] as const) {
			await fsMock.writeFile(FILE, "AAAA", "base64");
			const onClose = jest.fn();
			const tr = mount(textFor("v2-1-member"), "17b0 6508 2fd5 aab2", onClose);
			await act(async () => {
				if (how === "x") byId(tr, "voter-invite-qr-close").props.onPress();
				else modalOf(tr).props.onRequestClose();
			});
			await flush();
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(fsMock.__fsFiles()).toEqual([]);
			act(() => tr.unmount());
		}
	});

	it("unmounting deletes a planted file", async () => {
		const tr = mount(textFor("v2-1-member"));
		await fsMock.writeFile(FILE, "AAAA", "base64");
		act(() => tr.unmount());
		await flush();
		expect(fsMock.__fsFiles()).toEqual([]);
	});
});

describe("Share QR image", () => {
	it("a press opens the share sheet once, ignores a second press while pending, then deletes the file", async () => {
		const open = Share.open as jest.Mock;
		let release: (v: unknown) => void = () => {};
		open.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const tr = mount(textFor("v2-1-member"));
		await act(async () => {
			byId(tr, "voter-invite-qr-share").props.onPress();
		});
		await flush();
		expect(open).toHaveBeenCalledTimes(1);
		expect(byId(tr, "voter-invite-qr-share").props.disabled).toBe(true);
		await act(async () => {
			byId(tr, "voter-invite-qr-share").props.onPress();
		});
		await flush();
		expect(open).toHaveBeenCalledTimes(1);
		expect(fsMock.__fsFiles().length).toBe(1);
		await act(async () => {
			release({ success: true, message: "" });
		});
		await flush();
		expect(fsMock.__fsFiles()).toEqual([]);
		expect(byId(tr, "voter-invite-qr-share").props.disabled).toBe(false);
		expect(hasId(tr, "voter-invite-qr-share-notice")).toBe(false);
	});

	it("a share rejection shows the translated notice and logs the closed token once; a later success clears it", async () => {
		const open = Share.open as jest.Mock;
		open.mockImplementationOnce(async () => {
			throw new Error(textFor("v2-1-member"));
		});
		const tr = mount(textFor("v2-1-member"));
		await act(async () => {
			byId(tr, "voter-invite-qr-share").props.onPress();
		});
		await flush();
		const notice = byId(tr, "voter-invite-qr-share-notice");
		expect(notice.props.children).toBe(T.voterInviteQrShareFailed);
		expect(styleOf(notice).color).toBe("#971d1d");
		expect(notice.props.numberOfLines).toBeUndefined();
		expect(tokenCount(capture, SHARE_TOKEN)).toBe(1);
		await act(async () => {
			byId(tr, "voter-invite-qr-share").props.onPress();
		});
		await flush();
		expect(hasId(tr, "voter-invite-qr-share-notice")).toBe(false);
		expect(tokenCount(capture, SHARE_TOKEN)).toBe(1);
	});

	it("a fingerprint outside the atlas shows the same notice and writes nothing", async () => {
		const tr = mount(textFor("v2-1-member"), "zzzz zzzz zzzz zzzz");
		await act(async () => {
			byId(tr, "voter-invite-qr-share").props.onPress();
		});
		await flush();
		expect(byId(tr, "voter-invite-qr-share-notice").props.children).toBe(T.voterInviteQrShareFailed);
		expect(fsMock.writeFile).not.toHaveBeenCalled();
		expect(tokenCount(capture, SHARE_TOKEN)).toBe(1);
	});
});

describe("render failures", () => {
	const inputError = () => {
		const t = textFor("v2-1-member");
		return t.slice(0, 12) + "é" + t.slice(12);
	};
	const overflow = () => textFor("v2-6-members") + textFor("v2-1-member");
	const cases: Array<[string, () => string, Profile]> = [
		["a non-ASCII character (QrInputError)", inputError, PIXEL_8],
		["more text than a QR holds (QrOverflowError)", overflow, PIXEL_8],
		["a window too narrow for one pixel per module (QrLayoutError)", () => textFor("v2-1-member"), NARROW],
	];

	it.each(cases)("%s: the failure line replaces the panel, close stays, one token per mount", (_label, make, profile) => {
		setProfile(profile);
		const onClose = jest.fn();
		const tr = mount(make(), "17b0 6508 2fd5 aab2", onClose);
		expect(hasId(tr, "voter-invite-qr-full")).toBe(false);
		expect(byId(tr, "voter-invite-qr-full-render-failed").props.children).toBe(T.voterInviteQrRenderFailed);
		expect(hasId(tr, "voter-invite-qr-close")).toBe(true);
		expect(tokenCount(capture, QR_TOKEN)).toBe(1);
		act(() => tr.update(<VoterInviteQrView code={make()} fingerprint="17b0 6508 2fd5 aab2" onClose={onClose} />));
		expect(tokenCount(capture, QR_TOKEN)).toBe(1);
	});

	it("the Image onError logs the same closed token once, carrying nothing from the event", () => {
		const text = textFor("v2-1-member");
		const tr = mount(text);
		act(() => {
			byId(tr, "voter-invite-qr-full").props.onError({ nativeEvent: { error: uriOf(tr) } });
		});
		expect(tokenCount(capture, QR_TOKEN)).toBe(1);
		expect(capture.calls().length).toBe(1);
	});
});
