/**
 * JoinNetworkScreen.test.tsx - K-1..K-3, R-1..R-10, B-1..B-12 (D-26, D-09, D-06).
 *
 * Mounts the REAL screen over a mocked cadre-node context, a mocked app context and a mocked glue
 * (64-16's `runAuthorityNetworkJoin` / `completeAuthorityJoin`). `t()` resolves against the REAL
 * `resources` for both locales and THROWS on a missing key; `useTheme()` is the REAL light or dark
 * theme. The real `decodeNetworkJoinCode` decodes REAL-length fixture codes (1400 to 1800 chars),
 * never a short canary. The signing-error hook is the real one.
 *
 * Presses go through the React element's `onPress` (the host of a TouchableOpacity does not expose a
 * callable one). The console sweep over every flow lives in JoinNetworkScreen.logging.test.tsx.
 */

import React from "react";
import fs from "fs";
import path from "path";
import { StyleSheet } from "react-native";
import renderer, { act } from "react-test-renderer";
import Clipboard from "@react-native-clipboard/clipboard";
import { decodeNetworkJoinCode } from "@votetorrent/vote-engine/rn";
import { JOIN_CODE_FIXTURES } from "@votetorrent/vote-engine/test/fixtures/join-code-fixtures";
import { lightTheme, darkTheme } from "../../../theme/themes";
import { resources } from "../../../i18n";
import { CODE_TO_CLASS } from "../../../utils/deviceSigningError";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => mockInsets,
	SafeAreaProvider: ({ children }: { children: unknown }) => children,
}));

let mockKeyboardInset = 0;
jest.mock("../../../hooks/useKeyboardInset", () => ({
	useKeyboardInset: () => mockKeyboardInset,
}));

let mockCurrentLocale: "en" | "es" = "en";
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: { name?: string }) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources: res } = require("../../../i18n");
			const value = (res[mockCurrentLocale].translation as Record<string, string>)[key];
			if (typeof value !== "string") throw new Error("missing i18n key " + key);
			return opts && typeof opts.name === "string" ? value.replace("{{name}}", opts.name) : value;
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

let mockDark = false;
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
const mockSetParams = jest.fn();
const mockFocusCallbacks: Array<() => void | (() => void)> = [];
jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const themes = require("../../../theme/themes");
		return mockDark ? themes.darkTheme : themes.lightTheme;
	},
	useNavigation: () => ({
		navigate: mockNavigate,
		goBack: mockGoBack,
		setOptions: mockSetOptions,
		setParams: mockSetParams,
	}),
	useFocusEffect: (cb: () => void | (() => void)) => {
		mockFocusCallbacks.push(cb);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			const cleanup = cb();
			return typeof cleanup === "function" ? cleanup : undefined;
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));

const mockNode = { partyId: "party-1" };
const mockRefresh = jest.fn(async () => undefined);
let mockCadreValue: Record<string, unknown> = {};
jest.mock("../../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => mockCadreValue,
}));

const mockNetworksEngine = { joinFromStrand: jest.fn() };
const mockSelectNetwork = jest.fn(async () => undefined);
let mockAppValue: Record<string, unknown> = {};
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => mockAppValue,
}));

const mockGetDeviceUser = jest.fn();
jest.mock("../../../engines/device-user", () => ({
	getDeviceUser: () => mockGetDeviceUser(),
}));

const mockRun = jest.fn();
const mockComplete = jest.fn();
jest.mock("../../../engines/authority-network-join", () => ({
	runAuthorityNetworkJoin: (...a: unknown[]) => mockRun(...a),
	completeAuthorityJoin: (...a: unknown[]) => mockComplete(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ScreenModule = require("../JoinNetworkScreen");
const JoinNetworkScreen = ScreenModule.default;
const { joinNetworkFailureKey, joinNetworkDecodeErrorKey, joinNetworkStepKey } = ScreenModule;

const SCREEN_PATH = path.join(__dirname, "..", "JoinNetworkScreen.tsx");
const COPY_KEY = "joinNetworkErrorFounderCannotJoin";
const FX = JOIN_CODE_FIXTURES;
const OK_NAME = FX["v2-1-member"].name;

const REASONS = [
	"invitation-malformed",
	"invitation-expired",
	"invitation-used-up",
	"invitation-older-version",
	"not-admitted",
	"no-peers",
	"not-synced",
	"digest-mismatch",
	"open-failed",
] as const;
const REASON_KEY: Record<string, string> = {
	"invitation-malformed": "joinNetworkErrorInvalidCode",
	"invitation-expired": "joinNetworkErrorExpired",
	"invitation-used-up": "joinNetworkErrorUsedUp",
	"invitation-older-version": "joinNetworkErrorOlderCode",
	"not-admitted": "joinNetworkErrorNotAdmitted",
	"no-peers": "joinNetworkErrorNoPeers",
	"not-synced": "joinNetworkErrorNotSynced",
	"digest-mismatch": "joinNetworkErrorDigestMismatch",
	"open-failed": "joinNetworkErrorOpenFailed",
	"founder-cannot-join": COPY_KEY,
};
const ALL_REASONS = [...REASONS, "founder-cannot-join"] as string[];

function tx(locale: "en" | "es", key: string, name?: string): string {
	const v = (resources[locale].translation as Record<string, string>)[key];
	if (typeof v !== "string") throw new Error("missing i18n key " + key);
	return name === undefined ? v : v.replace("{{name}}", name);
}

type Inst = renderer.ReactTestInstance;
const trees: renderer.ReactTestRenderer[] = [];

async function mount(): Promise<renderer.ReactTestRenderer> {
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<JoinNetworkScreen />);
	});
	trees.push(tr);
	return tr;
}

async function settle(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	});
}

function hostById(tr: renderer.ReactTestRenderer, id: string): Inst | undefined {
	return tr.root.findAll((n) => typeof n.type === "string" && n.props.testID === id)[0];
}
function hasId(tr: renderer.ReactTestRenderer, id: string): boolean {
	return hostById(tr, id) !== undefined;
}
function elWith(tr: renderer.ReactTestRenderer, id: string, prop: string): Inst {
	const found = tr.root.findAll((n) => n.props.testID === id && typeof n.props[prop] === "function")[0];
	if (!found) throw new Error("no element " + id + " with " + prop);
	return found;
}
function textOf(n: Inst): string {
	return n.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
}
function textById(tr: renderer.ReactTestRenderer, id: string): string {
	const h = hostById(tr, id);
	if (!h) throw new Error("no host " + id);
	return textOf(h);
}
function styleOf(n: Inst): Record<string, any> {
	return (StyleSheet.flatten(n.props.style) ?? {}) as Record<string, any>;
}
function allStrings(tr: renderer.ReactTestRenderer): string[] {
	return tr.root.findAll((n) => (n.type as unknown) === "Text").map((n) => textOf(n));
}

type Json = { type: string; props: Record<string, any>; children: Array<Json | string> | null };
function jsonHosts(json: unknown): Json[] {
	const out: Json[] = [];
	const visit = (n: unknown) => {
		const list = n === null || n === undefined ? [] : Array.isArray(n) ? n : [n];
		for (const node of list as Json[]) {
			if (node === null || typeof node !== "object") continue;
			out.push(node);
			if (node.children) visit(node.children.filter((c) => typeof c !== "string"));
		}
	};
	visit(json);
	return out;
}
function numberOfLinesFlags(json: unknown): number {
	return jsonHosts(json).filter((h) => h.props.numberOfLines !== undefined).length;
}

async function typeCode(tr: renderer.ReactTestRenderer, text: string): Promise<void> {
	const el = elWith(tr, "join-network-code-input", "onChangeText");
	await act(async () => {
		el.props.onChangeText(text);
	});
}
async function pressJoin(tr: renderer.ReactTestRenderer): Promise<void> {
	const el = elWith(tr, "join-network-submit", "onPress");
	await act(async () => {
		el.props.onPress();
	});
	await settle();
}
function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
function okResult(name: string = OK_NAME) {
	return { ok: true, networkRef: { hash: "net-hash-1", name, primaryAuthorityDomainName: "authority.example" } };
}
function namedError(name: string, text = "boom"): Error {
	return Object.assign(new Error(text), { name });
}
const noKeyError = () =>
	Object.assign(new Error("no device signing key provisioned"), { code: "NO_KEY_PROVISIONED" });

let errSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
	mockCurrentLocale = "en";
	mockDark = false;
	mockKeyboardInset = 0;
	mockInsets.bottom = 0;
	mockFocusCallbacks.length = 0;
	for (const m of [mockNavigate, mockGoBack, mockSetOptions, mockSetParams, mockRefresh, mockSelectNetwork, mockGetDeviceUser, mockRun, mockComplete]) {
		m.mockReset();
	}
	mockRefresh.mockResolvedValue(undefined);
	mockSelectNetwork.mockResolvedValue(undefined);
	mockGetDeviceUser.mockResolvedValue({ id: "user-1" });
	mockRun.mockResolvedValue(okResult());
	mockComplete.mockResolvedValue({ trustSaved: true });
	mockCadreValue = { node: mockNode, ownerTrust: "needs-reinvite", refreshOwnerTrust: mockRefresh };
	mockAppValue = { networksEngine: mockNetworksEngine, selectNetwork: mockSelectNetwork };
	errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
	warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
	jest.restoreAllMocks();
	for (const tr of trees.splice(0)) {
		await act(async () => {
			try {
				tr.unmount();
			} catch {
				// already unmounted
			}
		});
	}
});

// ---------------------------------------------------------------------------------------------
describe("K: the pure key maps and the source (D-06)", () => {
	it("K-1: joinNetworkFailureKey maps every reason, the founder reason and the default", () => {
		for (const r of REASONS) expect(joinNetworkFailureKey(r)).toBe(REASON_KEY[r]);
		expect(joinNetworkFailureKey("founder-cannot-join")).toBe(COPY_KEY);
		expect(joinNetworkFailureKey("garbage" as never)).toBe("joinNetworkErrorGeneric");
		for (const r of [...ALL_REASONS, "garbage"]) {
			const key = joinNetworkFailureKey(r as never);
			expect(typeof (resources.en.translation as Record<string, string>)[key]).toBe("string");
			expect(typeof (resources.es.translation as Record<string, string>)[key]).toBe("string");
		}
	});

	it("K-2: the decode and step maps cover every row and fall back", () => {
		expect(joinNetworkDecodeErrorKey("unsupported-version")).toBe("joinNetworkErrorNewerCode");
		expect(joinNetworkDecodeErrorKey("invitation-older-version")).toBe("joinNetworkErrorOlderCode");
		expect(joinNetworkDecodeErrorKey("not-join-code")).toBe("joinNetworkErrorNotJoinCode");
		expect(joinNetworkDecodeErrorKey("malformed")).toBe("joinNetworkErrorInvalidCode");
		expect(joinNetworkDecodeErrorKey("other" as never)).toBe("joinNetworkErrorInvalidCode");
		expect(joinNetworkStepKey("admitting")).toBe("joinNetworkStepAdmitting");
		expect(joinNetworkStepKey("syncing")).toBe("joinNetworkStepSyncing");
		expect(joinNetworkStepKey("verifying")).toBe("joinNetworkStepVerifying");
		expect(joinNetworkStepKey("done")).toBe("joinNetworkStepVerifying");
		expect(joinNetworkStepKey("other" as never)).toBe("joinNetworkStepVerifying");
	});

	it("K-3: the screen source obeys the closed-surface rules", () => {
		const raw = fs.readFileSync(SCREEN_PATH, "utf8");
		const code = raw
			.split("\n")
			.filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
			.join("\n");
		expect(code.length).toBeGreaterThan(3000);
		for (const fn of ["joinNetworkFailureKey", "joinNetworkDecodeErrorKey", "joinNetworkStepKey"]) {
			const start = code.indexOf("export function " + fn);
			expect(start).toBeGreaterThanOrEqual(0);
			const end = code.indexOf("\n}\n", start);
			expect(end).toBeGreaterThan(start);
			const body = code.slice(start, end);
			expect(body).not.toMatch(/detail|message|\bt\(/);
		}
		expect(code).not.toMatch(/numberOfLines|setParams|setOptions|\.navigate\(|require\(["']@serfab|vision-camera|Camera/);
		expect(code.match(/goBack\(/g) ?? []).toHaveLength(1);
		expect(code.match(/<ScrollView/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
		expect(code.match(/"founder-cannot-join"/g) ?? []).toHaveLength(2);
		expect(code.match(/require\("\.\.\/\.\.\/engines\/authority-network-join"\)/g) ?? []).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------------------------
describe("R: rendering", () => {
	it.each([false, true])("R-1: empty state (dark=%s)", async (dark) => {
		mockDark = dark;
		const theme = dark ? darkTheme : lightTheme;
		const tr = await mount();
		const sv = tr.root.findAll((n) => n.props.testID === "join-network-screen" && n.props.keyboardShouldPersistTaps !== undefined)[0];
		expect(sv.props.keyboardShouldPersistTaps).toBe("handled");
		expect(textById(tr, "join-network-intro")).toBe(tx("en", "joinNetworkIntro"));
		expect(styleOf(hostById(tr, "join-network-intro")!).color).toBe(theme.colors.text);
		const input = hostById(tr, "join-network-code-input")!;
		expect(input.props.value ?? "").toBe("");
		expect(input.props.placeholder).toBe(tx("en", "joinNetworkCodePlaceholder"));
		expect(input.props.placeholderTextColor).toBe(dark ? theme.colors.text : theme.colors.textSecondary);
		const submit = elWith(tr, "join-network-submit", "onPress");
		expect(submit.props.disabled).toBe(true);
		expect(hostById(tr, "join-network-submit")!.props.accessibilityState.disabled).toBe(true);
		for (const id of ["join-network-code-error", "join-network-preview", "join-network-error", "join-network-progress", "join-network-joined"]) {
			expect(hasId(tr, id)).toBe(false);
		}
		expect(numberOfLinesFlags(tr.toJSON())).toBe(0);
	});

	it.each([["v2-1-member", 1370], ["v2-non-ascii-name", 1370], ["v1-legacy-1-member", 1600]] as const)(
		"R-2: %s decodes to a preview and enables Join without joining",
		async (name, min) => {
			const fx = FX[name];
			expect(fx.text.length).toBe(fx.chars);
			expect(fx.text.length).toBeGreaterThanOrEqual(min);
			const real = decodeNetworkJoinCode(fx.text);
			expect(real.ok).toBe(true);
			const tr = await mount();
			await typeCode(tr, "  " + fx.text + "\n");
			expect(textById(tr, "join-network-preview-name")).toBe(fx.name);
			if (real.ok) expect(textById(tr, "join-network-preview-name")).toBe(real.code.name);
			const fp = hostById(tr, "join-network-preview-fingerprint")!;
			expect(textOf(fp)).toBe(fx.fingerprint);
			expect(fp.props.selectable).toBe(true);
			expect(fp.props.maxFontSizeMultiplier).toBe(1.5);
			const fs_ = styleOf(fp);
			expect(fs_.fontFamily).toBe("monospace");
			expect(fs_.fontSize).toBe(16);
			expect(fs_.fontWeight).toBe("600");
			const strings = allStrings(tr);
			expect(strings).toContain(tx("en", "network"));
			expect(strings).toContain(tx("en", "networkFoundingExportFingerprintLabel"));
			expect(strings).toContain(tx("en", "joinNetworkPreviewCheck"));
			const submit = elWith(tr, "join-network-submit", "onPress");
			expect(submit.props.disabled).toBe(false);
			expect(submit.props.backgroundColor).toBe(lightTheme.colors.primary);
			expect(submit.props.size ?? "tall").toBe("tall");
			expect(styleOf(hostById(tr, "join-network-code-input")!).borderColor).toBe(lightTheme.colors.primary);
			expect(hasId(tr, "join-network-code-error")).toBe(false);
			expect(mockRun).not.toHaveBeenCalled();
		},
	);

	const v2 = FX["v2-1-member"].text;
	const DECODE_CASES: Array<[string, string, string, string]> = [
		["older", FX["v1-114-no-prefix"].text, "invitation-older-version", "joinNetworkErrorOlderCode"],
		["newer", v2.replace("vtjoin2.", "vtjoin3."), "unsupported-version", "joinNetworkErrorNewerCode"],
		["not-a-code", "https://example.org/not-a-code", "not-join-code", "joinNetworkErrorNotJoinCode"],
		["truncated", v2.slice(0, 600), "malformed", "joinNetworkErrorInvalidCode"],
	];
	describe.each(["en", "es"] as const)("R-3 (%s)", (locale) => {
		it.each(DECODE_CASES)("decode error: %s", async (_label, input, reason, key) => {
			mockCurrentLocale = locale;
			const real = decodeNetworkJoinCode(input);
			expect(real.ok).toBe(false);
			if (!real.ok) expect(real.reason).toBe(reason);
			const tr = await mount();
			await typeCode(tr, input);
			const err = hostById(tr, "join-network-code-error")!;
			expect(textOf(err)).toBe(tx(locale, key));
			expect(styleOf(err).color).toBe(lightTheme.colors.error);
			expect(styleOf(hostById(tr, "join-network-code-input")!).borderColor).toBe(lightTheme.colors.error);
			expect(elWith(tr, "join-network-submit", "onPress").props.disabled).toBe(true);
			expect(hasId(tr, "join-network-preview")).toBe(false);
			await typeCode(tr, v2);
			expect(hasId(tr, "join-network-code-error")).toBe(false);
			expect(hasId(tr, "join-network-preview")).toBe(true);
		});
	});

	it("R-4: joining shows progress, the live step, and locks the inputs", async () => {
		const run = deferred<unknown>();
		mockRun.mockImplementation(() => run.promise);
		const tr = await mount();
		await typeCode(tr, v2);
		await pressJoin(tr);
		expect(hasId(tr, "join-network-progress")).toBe(true);
		expect(textById(tr, "join-network-step")).toBe(tx("en", "joinNetworkStepAdmitting"));
		expect(hasId(tr, "join-network-submit")).toBe(false);
		expect(hostById(tr, "join-network-code-input")!.props.editable).toBe(false);
		expect(elWith(tr, "join-network-paste", "onPress").props.disabled).toBe(true);
		const onStep = mockRun.mock.calls[0][0].onStep as (s: string) => void;
		for (const [step, key] of [["syncing", "joinNetworkStepSyncing"], ["verifying", "joinNetworkStepVerifying"], ["done", "joinNetworkStepVerifying"]]) {
			await act(async () => {
				onStep(step);
			});
			expect(textById(tr, "join-network-step")).toBe(tx("en", key));
		}
		const stepStyle = styleOf(hostById(tr, "join-network-step")!);
		expect(stepStyle.flexShrink).toBe(1);
		expect(numberOfLinesFlags(tr.toJSON())).toBe(0);
		await act(async () => {
			run.resolve({ ok: false, reason: "no-peers", detail: "x" });
		});
		await settle();
	});

	describe.each(["en", "es"] as const)("R-5 / R-6 (%s)", (locale) => {
		it("R-5: joined", async () => {
			mockCurrentLocale = locale;
			const tr = await mount();
			await typeCode(tr, v2);
			await pressJoin(tr);
			const joined = hostById(tr, "join-network-joined")!;
			expect(joined.props.accessibilityRole).toBe("header");
			expect(textOf(joined)).toBe(tx(locale, "joinNetworkJoinedTitle", OK_NAME));
			expect(hasId(tr, "join-network-trust-warning")).toBe(false);
			expect(hasId(tr, "join-network-card")).toBe(false);
			expect(hasId(tr, "join-network-code-input")).toBe(false);
			expect(elWith(tr, "join-network-done", "onPress").props.title).toBe(tx(locale, "joinNetworkDone"));
			await act(async () => {
				elWith(tr, "join-network-done", "onPress").props.onPress();
			});
			expect(mockGoBack).toHaveBeenCalledTimes(1);
		});

		it("R-6: joined, trust not saved", async () => {
			mockCurrentLocale = locale;
			mockComplete.mockResolvedValue({ trustSaved: false });
			const tr = await mount();
			await typeCode(tr, v2);
			await pressJoin(tr);
			const warn = hostById(tr, "join-network-trust-warning")!;
			expect(textOf(warn)).toBe(tx(locale, "joinNetworkTrustNotSaved"));
			expect(styleOf(warn).color).toBe(lightTheme.colors.error);
			expect(warn.props.accessibilityRole).toBe("alert");
			expect(warn.props.numberOfLines).toBeUndefined();
			expect(hasId(tr, "join-network-joined")).toBe(true);
		});
	});

	describe.each(["en", "es"] as const)("R-7 (%s)", (locale) => {
		it.each(ALL_REASONS)("refused: %s", async (reason) => {
			mockCurrentLocale = locale;
			mockRun.mockResolvedValue({ ok: false, reason, detail: "detail-text" });
			const tr = await mount();
			await typeCode(tr, v2);
			await pressJoin(tr);
			const err = hostById(tr, "join-network-error")!;
			expect(err.props.accessibilityRole).toBe("alert");
			expect(styleOf(err).color).toBe(lightTheme.colors.error);
			expect(textOf(err)).toBe(tx(locale, REASON_KEY[reason]));
			expect(elWith(tr, "join-network-submit", "onPress").props.disabled).toBe(false);
			await typeCode(tr, v2 + " ");
			expect(hasId(tr, "join-network-error")).toBe(false);
		});
	});

	describe("R-8: paste", () => {
		it.each(["", "reject"])("a %s clipboard changes nothing", async (mode) => {
			const spy = jest.spyOn(Clipboard, "getString");
			if (mode === "reject") spy.mockRejectedValue(new Error("denied"));
			else spy.mockResolvedValue("");
			for (const typed of [null, v2]) {
				const tr = await mount();
				if (typed) await typeCode(tr, typed);
				const before = JSON.stringify(tr.toJSON());
				await act(async () => {
					elWith(tr, "join-network-paste", "onPress").props.onPress();
				});
				await settle();
				expect(JSON.stringify(tr.toJSON())).toBe(before);
			}
			expect(mockRun).not.toHaveBeenCalled();
		});

		it("a pasted code fills the field and shows the preview, but never joins", async () => {
			jest.spyOn(Clipboard, "getString").mockResolvedValue(v2);
			const tr = await mount();
			await act(async () => {
				elWith(tr, "join-network-paste", "onPress").props.onPress();
			});
			await settle();
			expect(hostById(tr, "join-network-code-input")!.props.value).toBe(v2);
			expect(hasId(tr, "join-network-preview")).toBe(true);
			expect(mockRun).not.toHaveBeenCalled();
		});

		it("a paste after a failed join clears the error", async () => {
			mockRun.mockResolvedValue({ ok: false, reason: "no-peers", detail: "x" });
			const tr = await mount();
			await typeCode(tr, v2);
			await pressJoin(tr);
			expect(hasId(tr, "join-network-error")).toBe(true);
			jest.spyOn(Clipboard, "getString").mockResolvedValue(v2 + "\n");
			await act(async () => {
				elWith(tr, "join-network-paste", "onPress").props.onPress();
			});
			await settle();
			expect(hasId(tr, "join-network-error")).toBe(false);
			expect(mockRun).toHaveBeenCalledTimes(1);
		});
	});

	it.each([[0, 0], [34, 0], [34, 291]])("R-9: layout with insets.bottom %i and keyboard inset %i", async (bottom, inset) => {
		mockInsets.bottom = bottom;
		mockKeyboardInset = inset;
		const tr = await mount();
		await typeCode(tr, v2);
		const sv = tr.root.findAll((n) => n.props.testID === "join-network-screen" && n.props.contentContainerStyle !== undefined)[0];
		expect(StyleSheet.flatten(sv.props.contentContainerStyle).paddingBottom).toBe(bottom + 16 + inset);
		const card = styleOf(hostById(tr, "join-network-card")!);
		expect(card).toMatchObject({ borderWidth: 1, borderRadius: 8, padding: 16, gap: 8, backgroundColor: lightTheme.colors.card, borderColor: lightTheme.colors.border });
		const input = hostById(tr, "join-network-code-input")!;
		expect(input.props.multiline).toBe(true);
		expect(input.props.autoCapitalize).toBe("none");
		expect(input.props.autoCorrect).toBe(false);
		expect(input.props.accessibilityLabel).toBe(tx("en", "joinNetworkCodeLabel"));
		expect(styleOf(input)).toMatchObject({ minHeight: 96, textAlignVertical: "top", borderRadius: 8, padding: 12, fontSize: 14 });
		const paste = hostById(tr, "join-network-paste")!;
		expect(paste.props.accessibilityRole).toBe("button");
		expect(styleOf(paste)).toMatchObject({ minHeight: 44, minWidth: 44 });
		const label = tr.root.findAll((n) => (n.type as unknown) === "Text" && textOf(n) === tx("en", "joinNetworkPaste"))[0];
		expect(styleOf(label).color).toBe(lightTheme.colors.primary);
	});

	it("R-9: the card border follows the dark theme", async () => {
		mockDark = true;
		const tr = await mount();
		expect(styleOf(hostById(tr, "join-network-card")!)).toMatchObject({ backgroundColor: darkTheme.colors.card, borderColor: darkTheme.colors.accent });
	});

	it("R-10: no numberOfLines in any state, and the walker flags one when present", async () => {
		expect(numberOfLinesFlags({ type: "Text", props: { numberOfLines: 1 }, children: null })).toBe(1);
		const tr = await mount();
		expect(numberOfLinesFlags(tr.toJSON())).toBe(0);
		await typeCode(tr, v2);
		expect(numberOfLinesFlags(tr.toJSON())).toBe(0);
		await pressJoin(tr);
		expect(numberOfLinesFlags(tr.toJSON())).toBe(0);
	});
});

// ---------------------------------------------------------------------------------------------
describe("B: behaviour", () => {
	const v2 = FX["v2-1-member"].text;

	async function joined(): Promise<renderer.ReactTestRenderer> {
		const tr = await mount();
		await typeCode(tr, v2);
		await pressJoin(tr);
		return tr;
	}

	it("B-1: the glue is called with the context objects and the decoded code", async () => {
		const real = decodeNetworkJoinCode(v2);
		if (!real.ok) throw new Error("fixture does not decode");
		await joined();
		expect(mockRun).toHaveBeenCalledTimes(1);
		const a = mockRun.mock.calls[0][0];
		expect(a.node).toBe(mockNode);
		expect(a.networksEngine).toBe(mockNetworksEngine);
		expect(a.user).toEqual({ id: "user-1" });
		expect(a.code).toEqual(real.code);
		expect(typeof a.onStep).toBe("function");
		const result = await mockRun.mock.results[0].value;
		expect(mockComplete).toHaveBeenCalledTimes(1);
		const c = mockComplete.mock.calls[0][0];
		expect(c.node).toBe(mockNode);
		expect(c.networkRef).toBe(result.networkRef);
		expect(c.selectNetwork).toBe(mockSelectNetwork);
		expect(c.refreshOwnerTrust).toBe(mockRefresh);
	});

	it("B-2: a context without refreshOwnerTrust passes a resolved no-op", async () => {
		mockCadreValue = { node: mockNode };
		await joined();
		const fn = mockComplete.mock.calls[0][0].refreshOwnerTrust;
		expect(typeof fn).toBe("function");
		await expect(fn()).resolves.toBeUndefined();
	});

	it("B-3: joined renders only after completion resolves", async () => {
		const done = deferred<{ trustSaved: boolean }>();
		mockComplete.mockImplementation(() => done.promise);
		const tr = await joined();
		expect(hasId(tr, "join-network-joined")).toBe(false);
		expect(hasId(tr, "join-network-progress")).toBe(true);
		await act(async () => {
			done.resolve({ trustSaved: true });
		});
		await settle();
		expect(hasId(tr, "join-network-joined")).toBe(true);
	});

	it("B-4: a hostile detail never reaches the screen", async () => {
		const real = JOIN_CODE_FIXTURES["v2-1-member"];
		const detail = "join: RAW ENGINE TEXT " + real.text.slice(0, 64) + " " + real.name + " " + real.fingerprint;
		mockRun.mockResolvedValue({ ok: false, reason: "not-admitted", detail });
		const tr = await joined();
		expect(textById(tr, "join-network-error")).toBe(tx("en", "joinNetworkErrorNotAdmitted"));
		const shown = allStrings(tr).join("\n");
		for (let o = 0; o + 16 <= detail.length; o++) {
			const w = detail.slice(o, o + 16);
			// The name and fingerprint legitimately show in the preview; only the code and engine text may not.
			if (real.name.includes(w) || real.fingerprint.includes(w) || tx("en", "joinNetworkPreviewCheck").includes(w)) continue;
			if (shown.includes(w)) throw new Error("detail window at offset " + o + " is rendered");
		}
	});

	it("B-5: two presses in one act start one join; a later press starts another", async () => {
		const run = deferred<unknown>();
		mockRun.mockImplementation(() => run.promise);
		const tr = await mount();
		await typeCode(tr, v2);
		const el = elWith(tr, "join-network-submit", "onPress");
		await act(async () => {
			el.props.onPress();
			el.props.onPress();
		});
		await settle();
		expect(mockRun).toHaveBeenCalledTimes(1);
		await act(async () => {
			run.resolve({ ok: false, reason: "no-peers", detail: "x" });
		});
		await settle();
		mockRun.mockResolvedValue({ ok: false, reason: "no-peers", detail: "x" });
		await pressJoin(tr);
		expect(mockRun).toHaveBeenCalledTimes(2);
	});

	it.each(["FounderIntentBusyError", "JoinedNetworksUnreadableError", "TypeError", "Error", "FounderGuardUnreadableError"])(
		"B-6: a %s rejection shows the generic sentence and logs the class name",
		async (name) => {
			mockRun.mockRejectedValue(namedError(name, "secret engine text " + v2.slice(0, 40)));
			const tr = await joined();
			expect(textById(tr, "join-network-error")).toBe(tx("en", "joinNetworkErrorGeneric"));
			expect(errSpy.mock.calls).toEqual([["JoinNetworkScreen: join failed:", name]]);
			expect(mockComplete).not.toHaveBeenCalled();
		},
	);

	it("B-7: a getDeviceUser rejection shows the generic sentence and never runs the join", async () => {
		mockGetDeviceUser.mockRejectedValue(namedError("Error"));
		const tr = await joined();
		expect(textById(tr, "join-network-error")).toBe(tx("en", "joinNetworkErrorGeneric"));
		expect(mockRun).not.toHaveBeenCalled();
	});

	it("B-8: missing dependencies are refused without calling the glue", async () => {
		mockCadreValue = { node: null, refreshOwnerTrust: mockRefresh };
		let tr = await joined();
		expect(textById(tr, "join-network-error")).toBe(tx("en", "joinNetworkErrorNoPeers"));
		expect(warnSpy.mock.calls).toEqual([["JoinNetworkScreen: join refused:", "no-peers"]]);
		expect(mockRun).not.toHaveBeenCalled();
		await act(async () => {
			tr.unmount();
		});
		errSpy.mockClear();
		mockCadreValue = { node: mockNode, refreshOwnerTrust: mockRefresh };
		mockAppValue = { networksEngine: undefined, selectNetwork: mockSelectNetwork };
		tr = await joined();
		expect(textById(tr, "join-network-error")).toBe(tx("en", "joinNetworkErrorGeneric"));
		expect(errSpy.mock.calls).toEqual([["JoinNetworkScreen: join failed:", "no-engine"]]);
		expect(mockRun).not.toHaveBeenCalled();
	});

	async function refocus() {
		const callbacks = mockFocusCallbacks.splice(0);
		await act(async () => {
			callbacks.slice(-1).forEach((cb) => cb());
		});
		await settle();
	}

	it("B-9: NO_KEY_PROVISIONED routes to the ceremony and the completion is retried once on focus", async () => {
		mockComplete.mockRejectedValueOnce(noKeyError());
		const tr = await joined();
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "first-run" });
		expect(textById(tr, "join-network-error")).toBe(tx("en", "joinNetworkErrorGeneric"));
		expect(errSpy.mock.calls).toEqual([["JoinNetworkScreen: select failed:", "Error"]]);
		const result = await mockRun.mock.results[0].value;
		mockComplete.mockResolvedValueOnce({ trustSaved: true });
		await refocus();
		expect(mockComplete).toHaveBeenCalledTimes(2);
		expect(mockComplete.mock.calls[1][0].networkRef).toBe(result.networkRef);
		expect(hasId(tr, "join-network-joined")).toBe(true);
		await refocus();
		expect(mockComplete).toHaveBeenCalledTimes(2);
		expect(mockRun).toHaveBeenCalledTimes(1);
		expect(mockNavigate).toHaveBeenCalledTimes(1);
	});

	it("B-9: a failed retry is not routed again", async () => {
		mockComplete.mockRejectedValueOnce(noKeyError()).mockRejectedValueOnce(noKeyError());
		const tr = await joined();
		await refocus();
		expect(mockComplete).toHaveBeenCalledTimes(2);
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(textById(tr, "join-network-error")).toBe(tx("en", "joinNetworkErrorGeneric"));
		await refocus();
		expect(mockComplete).toHaveBeenCalledTimes(2);
	});

	it("B-10: a plain error is not routed and not retried", async () => {
		mockComplete.mockRejectedValueOnce(new Error("boom"));
		const tr = await joined();
		expect(textById(tr, "join-network-error")).toBe(tx("en", "joinNetworkErrorGeneric"));
		expect(mockNavigate).not.toHaveBeenCalled();
		await refocus();
		expect(mockComplete).toHaveBeenCalledTimes(1);
	});

	it("B-11: a cancellation is neither routed nor retried", async () => {
		const code = Object.keys(CODE_TO_CLASS).find((k) => CODE_TO_CLASS[k] === "cancellation");
		expect(code).toBeDefined();
		mockComplete.mockRejectedValueOnce(Object.assign(new Error("cancelled"), { code }));
		const tr = await joined();
		expect(mockNavigate).not.toHaveBeenCalled();
		expect(textById(tr, "join-network-error")).toBe(tx("en", "joinNetworkErrorGeneric"));
		await refocus();
		expect(mockComplete).toHaveBeenCalledTimes(1);
	});

	it("B-12: unmounting mid-join still finishes the join but renders and routes nothing", async () => {
		const run = deferred<unknown>();
		mockRun.mockImplementation(() => run.promise);
		const tr = await mount();
		await typeCode(tr, v2);
		await pressJoin(tr);
		await act(async () => {
			tr.unmount();
		});
		await act(async () => {
			run.resolve(okResult());
		});
		await settle();
		expect(mockComplete).toHaveBeenCalledTimes(1);
		expect(mockNavigate).not.toHaveBeenCalled();
		expect(errSpy).not.toHaveBeenCalled();

		const run2 = deferred<unknown>();
		mockRun.mockImplementation(() => run2.promise);
		mockComplete.mockRejectedValueOnce(noKeyError());
		const tr2 = await mount();
		await typeCode(tr2, v2);
		await pressJoin(tr2);
		await act(async () => {
			tr2.unmount();
		});
		await act(async () => {
			run2.resolve(okResult());
		});
		await settle();
		expect(mockComplete).toHaveBeenCalledTimes(2);
		expect(mockNavigate).not.toHaveBeenCalled();
	});
});
