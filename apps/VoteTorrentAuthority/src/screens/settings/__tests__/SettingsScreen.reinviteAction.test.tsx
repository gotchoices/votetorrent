/**
 * SettingsScreen - the wired needs-reinvite action (D-09): S-1..S-5.
 *
 * The REAL SettingsScreen and the REAL OwnerTrustNotice mount over a mocked cadre-node context. The
 * CadreNodeProvider is mocked because the real one cannot load under the RN jest config. `t()`
 * resolves against the REAL `resources`; `useTheme()` is the REAL light theme.
 */
import React from "react";
import fs from "fs";
import path from "path";
import renderer, { act } from "react-test-renderer";
import { resources } from "../../../i18n";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
	SafeAreaProvider: ({ children }: { children: unknown }) => children,
}));

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

const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require("../../../theme/themes").lightTheme;
	},
	useNavigation: () => ({ navigate: mockNavigate, setOptions: jest.fn(), goBack: jest.fn() }),
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
const mockGetEngine = jest.fn();
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: (...a: unknown[]) => mockGetEngine(...a) }),
}));
let mockCadreValue: Record<string, unknown> = { node: null };
jest.mock("../../../providers/CadreNodeProvider", () => ({ useCadreNode: () => mockCadreValue }));

type Json = { type: string; props: Record<string, any>; children: Array<Json | string> | null };

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

const isPressable = (h: Json) => typeof h.props.onClick === "function" || typeof h.props.onPress === "function";
const noticeHost = (json: unknown) => hosts(json).filter((h) => h.props.testID === "owner-trust-notice");

async function flush() {
	for (let i = 0; i < 8; i++) {
		// eslint-disable-next-line no-await-in-loop
		await act(async () => {
			await Promise.resolve();
		});
	}
}

async function mount(value: Record<string, unknown>): Promise<renderer.ReactTestRenderer> {
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

beforeEach(() => {
	mockCurrentLocale = "en";
	mockNavigate.mockClear();
	mockGetEngine.mockReset();
});

describe("SettingsScreen needs-reinvite action", () => {
	describe.each(["en", "es"] as const)("S-1 (%s)", (locale) => {
		it("renders the action, which opens JoinNetwork and never AcceptInvitation", async () => {
			mockCurrentLocale = locale;
			const r = await mount({ ownerTrust: "needs-reinvite" });
			const id = "owner-trust-notice-needs-reinvite-action";
			const host = hosts(r.toJSON()).filter((h) => h.props.testID === id);
			expect(host.length).toBeGreaterThan(0);
			expect(host[0].props.accessibilityLabel).toBe(tr(locale, "ownerTrustReinviteAction"));
			expect(hosts(noticeHost(r.toJSON())[0]).filter(isPressable)).toHaveLength(1);
			const el = r.root.findAll((n) => n.props.testID === id && typeof n.props.onPress === "function");
			await act(async () => {
				el[0].props.onPress();
			});
			expect(mockNavigate.mock.calls).toEqual([["JoinNetwork"]]);
			expect(JSON.stringify(mockNavigate.mock.calls)).not.toContain("AcceptInvitation");
			await unmount(r);
		});
	});

	it.each(["memory-only", "blocked"] as const)("S-2: %s keeps Open Settings hidden (zero pressables)", async (state) => {
		const r = await mount({ ownerTrust: state });
		expect(hosts(noticeHost(r.toJSON())[0]).filter(isPressable)).toHaveLength(0);
		await unmount(r);
	});

	it.each([undefined, "ok"])("S-3: ownerTrust %s renders no notice", async (state) => {
		const r = await mount(state === undefined ? {} : { ownerTrust: state });
		expect(noticeHost(r.toJSON())).toHaveLength(0);
		await unmount(r);
	});

	it("S-4: the notice is gone when the officer returns after a join refreshed owner trust", async () => {
		const refreshOwnerTrust = jest.fn(async () => {
			mockCadreValue = { ...mockCadreValue, ownerTrust: "ok" };
		});
		const r = await mount({ ownerTrust: "needs-reinvite", refreshOwnerTrust });
		const id = "owner-trust-notice-needs-reinvite-action";
		const el = r.root.findAll((n) => n.props.testID === id && typeof n.props.onPress === "function");
		await act(async () => {
			el[0].props.onPress();
		});
		expect(mockNavigate.mock.calls).toEqual([["JoinNetwork"]]);
		await act(async () => {
			await refreshOwnerTrust();
		});
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const Screen = require("../SettingsScreen").default;
		await act(async () => {
			r.update(<Screen />);
		});
		await flush();
		expect(noticeHost(r.toJSON())).toHaveLength(0);
		await unmount(r);
	});

	it("S-5: the source wires the notice once and keeps the unrelated AcceptInvitation row", () => {
		const src = fs.readFileSync(path.join(__dirname, "../SettingsScreen.tsx"), "utf8");
		const code = src
			.split("\n")
			.filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
			.join("\n");
		expect(code.length).toBeGreaterThan(1000);
		expect(code.match(/navigate\("AcceptInvitation"\)/g) ?? []).toHaveLength(1);
		expect(code.split('<OwnerTrustNotice onNeedsReinvite={() => navigation.navigate("JoinNetwork")} />').length - 1).toBe(1);
		expect(code).not.toContain("<OwnerTrustNotice />");
	});
});
