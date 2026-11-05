/**
 * JoinNetworkScreen.logging.test.tsx - L-1..L-4 and N-1 (D-06, UI-SPEC A1).
 *
 * The join code is a bearer credential. This sweep drives the REAL screen through every flow with
 * four REAL-encoder fixture codes (1400 to 1800 chars) and proves, with 64-10's console-leak helper,
 * that neither the code, any 16-char slice of it, the network name, the fingerprint, a result
 * detail nor an error message reaches the console, a navigation call, or the accessibility tree.
 * The screen's console calls are exactly three closed tokens (L-3, static). No test prints a code;
 * failure messages name the fixture and an offset only.
 */

import React from "react";
import fs from "fs";
import path from "path";
import renderer, { act } from "react-test-renderer";
import Clipboard from "@react-native-clipboard/clipboard";
import { JOIN_CODE_FIXTURES } from "@votetorrent/vote-engine/test/fixtures/join-code-fixtures";
import { captureConsole, expectNoSecretInConsole } from "../../../engines/__fixtures__/console-leak";
import { consoleTags, nonLiteralConsoleFirstArgs } from "../../__fixtures__/log-content-scan";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => mockInsets,
	SafeAreaProvider: ({ children }: { children: unknown }) => children,
}));
jest.mock("../../../hooks/useKeyboardInset", () => ({ useKeyboardInset: () => 0 }));
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: { name?: string }) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources: res } = require("../../../i18n");
			const value = (res.en.translation as Record<string, string>)[key];
			if (typeof value !== "string") throw new Error("missing i18n key " + key);
			return opts && typeof opts.name === "string" ? value.replace("{{name}}", opts.name) : value;
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
const mockSetParams = jest.fn();
jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require("../../../theme/themes").lightTheme;
	},
	useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack, setOptions: mockSetOptions, setParams: mockSetParams }),
	useFocusEffect: (cb: () => void | (() => void)) => {
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
jest.mock("../../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: mockNode, ownerTrust: "needs-reinvite", refreshOwnerTrust: mockRefresh }),
}));
const mockNetworksEngine = { joinFromStrand: jest.fn() };
const mockSelectNetwork = jest.fn(async () => undefined);
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ networksEngine: mockNetworksEngine, selectNetwork: mockSelectNetwork }),
}));
jest.mock("../../../engines/device-user", () => ({ getDeviceUser: async () => ({ id: "user-1" }) }));
const mockRun = jest.fn();
const mockComplete = jest.fn();
jest.mock("../../../engines/authority-network-join", () => ({
	runAuthorityNetworkJoin: (...a: unknown[]) => mockRun(...a),
	completeAuthorityJoin: (...a: unknown[]) => mockComplete(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const JoinNetworkScreen = require("../JoinNetworkScreen").default;
const SOURCE = fs.readFileSync(path.join(__dirname, "..", "JoinNetworkScreen.tsx"), "utf8");

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
	"founder-cannot-join",
];
const TOKENS = ["JoinNetworkScreen: join refused:", "JoinNetworkScreen: join failed:", "JoinNetworkScreen: select failed:"];
const FIXTURES = ["v2-1-member", "v2-6-members", "v2-non-ascii-name", "v1-legacy-1-member"] as const;

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
function elWith(tr: renderer.ReactTestRenderer, id: string, prop: string): Inst {
	const found = tr.root.findAll((n) => n.props.testID === id && typeof n.props[prop] === "function")[0];
	if (!found) throw new Error("no element " + id);
	return found;
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

/** The whole secret and every 16-char window of it that is found in `haystack`, as offsets only. */
function scanFor(haystack: string, secrets: string[], width = 16): number[] {
	const hits: number[] = [];
	secrets.forEach((s, i) => {
		if (haystack.includes(s)) hits.push(i * 1_000_000);
		for (let o = 0; o + width <= s.length; o++) {
			if (haystack.includes(s.slice(o, o + width))) {
				hits.push(i * 1_000_000 + o + 1);
				break;
			}
		}
	});
	return hits;
}

/** Every a11y/identity string on every host node of the tree. */
function identityStrings(tr: renderer.ReactTestRenderer): string {
	const parts: string[] = [];
	for (const n of tr.root.findAll((x) => typeof x.type === "string")) {
		for (const k of ["testID", "nativeID", "accessibilityLabel", "accessibilityHint"]) {
			const v = n.props[k];
			if (typeof v === "string") parts.push(v);
		}
	}
	return parts.join("\n");
}

let treeHits: Array<{ state: string; offsets: number[] }>;

beforeEach(() => {
	for (const m of [mockNavigate, mockGoBack, mockSetOptions, mockSetParams, mockRun, mockComplete]) m.mockReset();
	mockRun.mockResolvedValue({ ok: true, networkRef: { hash: "h1", name: "Net", primaryAuthorityDomainName: "a.example" } });
	mockComplete.mockResolvedValue({ trustSaved: true });
	treeHits = [];
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

describe("L-1: no console call carries a secret, across every flow", () => {
	it.each(FIXTURES)("%s", async (name) => {
		const fx = JOIN_CODE_FIXTURES[name];
		expect(fx.text.length).toBe(fx.chars);
		const secrets = [fx.text, fx.name, fx.fingerprint].filter(Boolean);
		const hostile = "join: RAW ENGINE TEXT " + fx.text.slice(0, 64) + " " + fx.name + " " + fx.fingerprint;
		const scan = (tr: renderer.ReactTestRenderer, state: string) => {
			const offsets = scanFor(identityStrings(tr), [fx.text, ...(fx.name.length >= 16 ? [fx.name] : []), fx.fingerprint]);
			if (offsets.length) treeHits.push({ state, offsets });
		};
		const c = captureConsole();
		let calls: unknown[][] = [];
		try {
			let tr = await mount();
			scan(tr, "empty");
			jest.spyOn(Clipboard, "getString").mockResolvedValue("  \n" + fx.text + "\n  ");
			await act(async () => {
				elWith(tr, "join-network-paste", "onPress").props.onPress();
			});
			await settle();
			scan(tr, "pasted");
			await typeCode(tr, fx.text.slice(0, 600));
			scan(tr, "decode-error");
			await typeCode(tr, fx.text);
			scan(tr, "decoded");
			for (const reason of REASONS) {
				mockRun.mockResolvedValueOnce({ ok: false, reason, detail: hostile });
				await pressJoin(tr);
				scan(tr, "refused:" + reason);
			}
			mockRun.mockRejectedValueOnce(Object.assign(new Error(hostile), { name: "FounderIntentBusyError" }));
			await pressJoin(tr);
			scan(tr, "rejected");
			mockComplete.mockResolvedValueOnce({ trustSaved: false });
			await pressJoin(tr);
			scan(tr, "joined-trust-warning");
			await act(async () => {
				tr.unmount();
			});
			tr = await mount();
			await typeCode(tr, fx.text);
			mockComplete.mockRejectedValueOnce(
				Object.assign(new Error(fx.text + fx.name), { code: "NO_KEY_PROVISIONED" }),
			);
			await pressJoin(tr);
			scan(tr, "select-failed");
			calls = c.calls();
			expectNoSecretInConsole(c, secrets);
		} finally {
			c.restore();
		}
		expect(calls.length).toBeGreaterThan(0);
		// Every captured call is one of the three closed shapes.
		for (const call of calls) {
			expect(call).toHaveLength(2);
			const [tag, arg] = call as [string, string];
			expect(TOKENS).toContain(tag);
			if (tag === TOKENS[0]) expect([...REASONS]).toContain(arg);
			else if (tag === TOKENS[1]) expect(arg === "no-engine" || /^[A-Za-z]+$/.test(arg)).toBe(true);
			else expect(/^[A-Za-z]+$/.test(arg)).toBe(true);
		}
		expect(calls.filter((x) => x[0] === TOKENS[0])).toHaveLength(REASONS.length);
		expect(calls.filter((x) => x[0] === TOKENS[1])).toEqual([[TOKENS[1], "FounderIntentBusyError"]]);
		expect(calls.filter((x) => x[0] === TOKENS[2])).toEqual([[TOKENS[2], "Error"]]);
		// L-4 (collected above): the accessibility tree.
		expect(treeHits).toEqual([]);
		// N-1: navigation.
		expect(mockSetParams).not.toHaveBeenCalled();
		expect(mockSetOptions).not.toHaveBeenCalled();
		expect(mockNavigate.mock.calls).toEqual([["ProvisionSigningKey", { reason: "first-run" }]]);
		const navText = JSON.stringify([mockNavigate.mock.calls, mockGoBack.mock.calls, mockSetParams.mock.calls, mockSetOptions.mock.calls]);
		expect(scanFor(navText, secrets)).toEqual([]);
	});
});

describe("L-2 / N-1 anti-vacuity", () => {
	it("L-2: the helper flags a 16-char slice of the code", () => {
		const fx = JOIN_CODE_FIXTURES["v2-1-member"];
		const c = captureConsole();
		try {
			console.warn("x", fx.text.slice(200, 216));
			expect(() => expectNoSecretInConsole(c, [fx.text])).toThrow();
		} finally {
			c.restore();
		}
	});

	it("N-1: the navigation scan flags a synthetic call carrying a slice, and the tree scan flags a label", () => {
		const fx = JOIN_CODE_FIXTURES["v2-1-member"];
		const synthetic = JSON.stringify([["Somewhere", { x: fx.text.slice(300, 316) }]]);
		expect(scanFor(synthetic, [fx.text]).length).toBeGreaterThan(0);
		expect(scanFor("label " + fx.fingerprint, [fx.fingerprint]).length).toBeGreaterThan(0);
	});
});

describe("L-3: the screen's console calls are closed tokens (static)", () => {
	it("has only literal first arguments, exactly the three tokens, and safe second arguments", () => {
		expect(SOURCE.length).toBeGreaterThan(3000);
		expect(nonLiteralConsoleFirstArgs(SOURCE)).toEqual([]);
		expect([...consoleTags(SOURCE)].sort()).toEqual([...TOKENS].sort());
		const second = [...SOURCE.matchAll(/console\.(?:warn|error)\("[^"]*",\s*([^)]*\)?)\)/g)].map((m) => m[1].trim());
		expect(second.length).toBeGreaterThanOrEqual(5);
		for (const arg of second) {
			expect(
				arg === "result.reason" || /^"[a-z-]+"$/.test(arg) || /^errorClassName\([A-Za-z]+\)$/.test(arg),
			).toBe(true);
		}
	});
});
