/**
 * SettingsScreen — the "Require saved owner trust" row (D-11): R-1..R-10.
 *
 * The REAL owner-trust-setting module runs over the jest AsyncStorage mock. Failures and deferrals
 * are installed on that mock's getItem and setItem and put back by hand after each test (the mock's
 * functions are already jest.fn, so restoreAllMocks would not undo an implementation).
 */
import React from "react";
import fs from "fs";
import path from "path";
import { Alert, Switch } from "react-native";
import renderer, { act } from "react-test-renderer";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { resources } from "../../../i18n";
import { lightTheme } from "../../../theme/themes";
import { REQUIRE_OWNER_TRUST_KEY } from "../../../engines/owner-trust-setting";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

let mockCurrentLocale: "en" | "es" = "en";
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources: res } = require("../../../i18n");
			const value = (res[mockCurrentLocale].translation as Record<string, string>)[key];
			return typeof value === "string" ? value : key;
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require("../../../theme/themes").lightTheme;
	},
	useNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn(), goBack: jest.fn() }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			cb();
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));
jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false, setShowHelpIcons: jest.fn() }),
}));
jest.mock("../../../i18n", () => ({
	__esModule: true,
	...jest.requireActual("../../../i18n"),
	default: { language: "en", changeLanguage: jest.fn(async () => {}), on: jest.fn(), off: jest.fn() },
}));
jest.mock("../../../engines/engine-factory", () => {
	class NoNetworkEstablishedError extends Error {}
	return { NoNetworkEstablishedError, isNoNetworkEstablishedError: (e: unknown) => e instanceof NoNetworkEstablishedError };
});
let mockGetEngine: (...a: unknown[]) => Promise<unknown> = async () => null;
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: (...a: unknown[]) => mockGetEngine(...a) }),
}));
let mockCadreValue: Record<string, unknown> = { node: null };
jest.mock("../../../providers/CadreNodeProvider", () => ({ useCadreNode: () => mockCadreValue }));

type Json = { type: string; props: Record<string, any>; children: Array<Json | string> | null };

const ID = "settings-require-owner-trust";
const PLANTED_IO = "planted-io-text";
const PLANTED_VALUE = "planted-garbage-value";

const getMock = AsyncStorage.getItem as unknown as jest.Mock;
const setMock = AsyncStorage.setItem as unknown as jest.Mock;
const origGet = getMock.getMockImplementation();
const origSet = setMock.getMockImplementation();

function tr(locale: "en" | "es", key: string): string {
	return (resources[locale].translation as Record<string, string>)[key];
}

function hosts(json: unknown): Json[] {
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

function textOf(node: Json): string {
	const parts: string[] = [];
	const visit = (n: Json) => {
		for (const c of n.children ?? []) {
			if (typeof c === "string") parts.push(c);
			else visit(c);
		}
	};
	visit(node);
	return parts.join("");
}

function allStrings(json: unknown): string[] {
	return hosts(json)
		.flatMap((h) => (h.children ?? []).filter((c): c is string => typeof c === "string"))
		.sort();
}

async function flush() {
	for (let i = 0; i < 10; i++) {
		// eslint-disable-next-line no-await-in-loop
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function mount(value: Record<string, unknown> = {}): Promise<renderer.ReactTestRenderer> {
	mockCadreValue = { node: null, ...value };
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Screen = require("../SettingsScreen").default;
	let r!: renderer.ReactTestRenderer;
	await act(async () => {
		r = renderer.create(<Screen />);
	});
	await flush();
	return r;
}

async function unmount(r: renderer.ReactTestRenderer): Promise<void> {
	await act(async () => {
		r.unmount();
	});
}

function switchOf(r: renderer.ReactTestRenderer) {
	const sw = r.root.findAll((n) => n.type === Switch && n.props.testID === ID);
	expect(sw).toHaveLength(1);
	return sw[0];
}

function shown(r: renderer.ReactTestRenderer): boolean {
	return switchOf(r).props.value as boolean;
}

async function toggle(r: renderer.ReactTestRenderer, next: boolean) {
	await act(async () => {
		switchOf(r).props.onValueChange(next);
	});
	await flush();
}

async function stored(): Promise<string | null> {
	return AsyncStorage.getItem(REQUIRE_OWNER_TRUST_KEY);
}

function consoleText(): string {
	return JSON.stringify(
		[console.log, console.info, console.warn, console.error, console.debug].map((f) => (f as jest.Mock).mock.calls),
	);
}

function warnCount(token: string): number {
	return (console.warn as jest.Mock).mock.calls.filter((c) => c.length === 1 && c[0] === token).length;
}

beforeEach(async () => {
	jest.clearAllMocks();
	mockCurrentLocale = "en";
	mockGetEngine = async () => null;
	await AsyncStorage.clear();
	getMock.mockClear();
	setMock.mockClear();
	for (const m of ["log", "info", "warn", "error", "debug"] as const) {
		jest.spyOn(console, m).mockImplementation(() => {});
	}
});
afterEach(() => {
	for (const m of ["log", "info", "warn", "error", "debug"] as const) (console[m] as jest.Mock).mockRestore();
	if (origGet) getMock.mockImplementation(origGet);
	if (origSet) setMock.mockImplementation(origSet);
});

describe("SettingsScreen require-saved-owner-trust row", () => {
	it.each(["en", "es"] as const)("R-1: defaults OFF with its real label and help (%s)", async (locale) => {
		mockCurrentLocale = locale;
		const r = await mount();
		const json = r.toJSON();
		const row = r.root.findAll((n) => typeof n.type !== "string" && n.props.testID === ID && n.props.label !== undefined);
		expect(row).toHaveLength(1);
		expect(row[0].props.label).toBe(tr(locale, "settingsRequireOwnerTrust"));
		expect(row[0].props.accessibilityLabel).toBe(tr(locale, "settingsRequireOwnerTrust"));
		expect(row[0].props.value).toBe(false);
		const swHost = hosts(json).filter((h) => h.props.testID === ID);
		expect(swHost.length).toBeGreaterThan(0);
		expect(swHost[0].props.value).toBe(false);
		expect(swHost[0].props.accessibilityLabel).toBe(tr(locale, "settingsRequireOwnerTrust"));
		const help = hosts(json).find((h) => h.props.testID === "settings-require-owner-trust-help") as Json;
		expect(textOf(help)).toBe(tr(locale, "settingsRequireOwnerTrustHelp"));
		const style = Object.assign({}, ...[help.props.style].flat(Infinity).filter(Boolean));
		expect(style.color).toBe(lightTheme.colors.text);
		expect(hosts(json).filter((h) => h.props.testID === ID || h.props.testID === "settings-require-owner-trust-help")
			.every((h) => h.props.numberOfLines === undefined)).toBe(true);
		const labelHost = hosts(json).find((h) => h.type === "Text" && textOf(h) === tr(locale, "settingsRequireOwnerTrust")) as Json;
		expect(labelHost.props.numberOfLines).toBeUndefined();
		expect(getMock).toHaveBeenCalledWith(REQUIRE_OWNER_TRUST_KEY);
		expect(consoleText()).toBe(JSON.stringify([[], [], [], [], []]));
		await unmount(r);
	});

	it("R-2: a stored 'true' shows ON and a stored 'false' shows OFF", async () => {
		await AsyncStorage.setItem(REQUIRE_OWNER_TRUST_KEY, "true");
		const a = await mount();
		expect(shown(a)).toBe(true);
		await unmount(a);
		await AsyncStorage.setItem(REQUIRE_OWNER_TRUST_KEY, "false");
		const b = await mount();
		expect(shown(b)).toBe(false);
		await unmount(b);
	});

	it("R-3: an unknown stored value shows ON, logs one closed token, and prints nothing planted", async () => {
		await AsyncStorage.setItem(REQUIRE_OWNER_TRUST_KEY, PLANTED_VALUE);
		const r = await mount();
		expect(shown(r)).toBe(true);
		expect(warnCount("[owner-trust] setting: unreadable")).toBe(1);
		expect(consoleText()).not.toContain(PLANTED_VALUE);
		await unmount(r);
	});

	it("R-3: a read that rejects shows ON, logs one closed token, and prints nothing planted", async () => {
		getMock.mockImplementation(async (key: string) => {
			if (key === REQUIRE_OWNER_TRUST_KEY) throw new Error(PLANTED_IO);
			return origGet ? origGet(key) : null;
		});
		const r = await mount();
		expect(shown(r)).toBe(true);
		expect(warnCount("[owner-trust] setting: unreadable")).toBe(1);
		expect(consoleText()).not.toContain(PLANTED_IO);
		await unmount(r);
	});

	it("R-4: toggling stores exactly 'true' then 'false' and shows the new value at once", async () => {
		const r = await mount();
		await toggle(r, true);
		expect(shown(r)).toBe(true);
		expect(await stored()).toBe("true");
		await toggle(r, false);
		expect(shown(r)).toBe(false);
		expect(await stored()).toBe("false");
		await unmount(r);
	});

	it("R-5: a failed write re-reads and shows what is actually stored", async () => {
		const failOnce = () => {
			setMock.mockImplementationOnce(async () => {
				throw new Error(PLANTED_IO);
			});
		};
		const a = await mount();
		failOnce();
		await toggle(a, true);
		expect(shown(a)).toBe(false);
		expect(warnCount("[owner-trust] setting: write failed")).toBe(1);
		expect(await stored()).toBeNull();
		await unmount(a);

		await AsyncStorage.setItem(REQUIRE_OWNER_TRUST_KEY, "true");
		(console.warn as jest.Mock).mockClear();
		const b = await mount();
		expect(shown(b)).toBe(true);
		failOnce();
		await toggle(b, false);
		expect(shown(b)).toBe(true);
		expect(warnCount("[owner-trust] setting: write failed")).toBe(1);
		expect(consoleText()).not.toContain(PLANTED_IO);
		await unmount(b);
	});

	it("R-6: toggling before the first read settles wins over that read", async () => {
		let release!: (v: string | null) => void;
		getMock.mockImplementationOnce(
			() =>
				new Promise<string | null>((res) => {
					release = res;
				}),
		);
		const r = await mount();
		await toggle(r, true);
		expect(shown(r)).toBe(true);
		await act(async () => {
			release("false");
		});
		await flush();
		expect(shown(r)).toBe(true);
		expect(await stored()).toBe("true");
		await unmount(r);
	});

	it("R-7: the row sits after the pair-a-browser row and before the per-network block", async () => {
		mockGetEngine = async (name: unknown) =>
			name === "network" ? { getDetails: async () => ({ network: { name: "Net One" } }) } : null;
		const r = await mount();
		const hs = hosts(r.toJSON());
		const idx = (pred: (h: Json) => boolean) => hs.findIndex(pred);
		const signIn = idx((h) => h.props.testID === "settings-pair-browser-entry");
		const entry = idx((h) => h.props.testID === "settings-require-owner-trust-entry");
		const net = idx((h) => h.type === "Text" && textOf(h) === "Net One");
		expect(signIn).toBeGreaterThanOrEqual(0);
		expect(entry).toBeGreaterThan(signIn);
		expect(net).toBeGreaterThan(entry);
		await unmount(r);

		const src = fs.readFileSync(path.join(__dirname, "../SettingsScreen.tsx"), "utf8");
		const a = src.indexOf("settings-pair-browser-entry");
		const b = src.indexOf('testID="settings-require-owner-trust"');
		const c = src.indexOf("styles.networkTitle");
		expect(a).toBeGreaterThan(0);
		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
	});

	it("R-8: no restart prompt, and nothing else on screen changes", async () => {
		const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
		const r = await mount();
		const before = allStrings(r.toJSON());
		await toggle(r, true);
		expect(alertSpy).not.toHaveBeenCalled();
		expect(allStrings(r.toJSON())).toEqual(before);
		alertSpy.mockRestore();
		await unmount(r);
	});

	it("R-9: with the blocked notice and no node, toggling OFF stores 'false'", async () => {
		await AsyncStorage.setItem(REQUIRE_OWNER_TRUST_KEY, "true");
		const r = await mount({ ownerTrust: "blocked", node: null });
		expect(shown(r)).toBe(true);
		await toggle(r, false);
		expect(shown(r)).toBe(false);
		expect(await stored()).toBe("false");
		await unmount(r);
	});

	it("R-10: unmounting while the first read is pending sets no state afterwards", async () => {
		let release!: (v: string | null) => void;
		getMock.mockImplementationOnce(
			() =>
				new Promise<string | null>((res) => {
					release = res;
				}),
		);
		await AsyncStorage.setItem(REQUIRE_OWNER_TRUST_KEY, "true");
		const r = await mount();
		await unmount(r);
		await act(async () => {
			release("true");
		});
		await flush();
		expect(console.error).not.toHaveBeenCalled();
	});
});
