/**
 * NetworksScreen - the Join a network entry and the wired re-invite action (D-26, D-09): E-1..E-5.
 *
 * The REAL NetworksScreen and the REAL OwnerTrustNotice mount over a mocked cadre-node context.
 * `t()` resolves against the REAL `resources`; `useTheme()` is the REAL light theme. The two network
 * cards are stubbed so this suite does not depend on their edits. The CadreNodeProvider is mocked
 * because the real one cannot load under the RN jest config.
 */
import React from "react";
import { StyleSheet } from "react-native";
import renderer, { act } from "react-test-renderer";
import { resources } from "../../../i18n";
import { lightTheme } from "../../../theme/themes";

jest.mock("@multiformats/multiaddr", () => ({ multiaddr: () => ({ getComponents: () => [] }) }), { virtual: true });
jest.mock("@votetorrent/vote-core", () => ({}), { virtual: true });
jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
	SafeAreaProvider: ({ children }: { children: unknown }) => children,
}));
jest.mock("../../../providers/SettingsProvider", () => ({ useSettings: () => ({ showHelpIcons: false }) }));
const mockNetworksEngine = { getRecentNetworks: jest.fn(async () => []) };
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ networksEngine: mockNetworksEngine, selectNetwork: jest.fn() }),
}));
let mockCadreValue: Record<string, unknown> = {};
jest.mock("../../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => mockCadreValue,
}));
jest.mock("../components/VoterInviteCard", () => ({ VoterInviteCard: () => null }));
jest.mock("../components/FoundingBundleExportCard", () => ({ FoundingBundleExportCard: () => null }));

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
jest.mock("@react-navigation/native", () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const ReactForMock = require("react");
	return {
		useTheme: () => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			return require("../../../theme/themes").lightTheme;
		},
		useNavigation: () => ({ navigate: mockNavigate, setOptions: jest.fn() }),
		useFocusEffect: (cb: () => void | (() => void)) => {
			ReactForMock.useEffect(() => cb(), []);
		},
	};
});

const NetworksScreen = require("../NetworksScreen").default;

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

async function mount(value: Record<string, unknown>): Promise<renderer.ReactTestRenderer> {
	mockCadreValue = { node: null, syncState: "offline", connectedPeers: jest.fn(), ...value };
	let r!: renderer.ReactTestRenderer;
	await act(async () => {
		r = renderer.create(<NetworksScreen />);
	});
	return r;
}

async function unmount(r: renderer.ReactTestRenderer): Promise<void> {
	await act(async () => {
		r.unmount();
	});
}

function elementWith(r: renderer.ReactTestRenderer, testID: string) {
	const found = r.root.findAll((n) => n.props.testID === testID && typeof n.props.onPress === "function");
	if (found.length === 0) throw new Error("no pressable " + testID);
	return found[0];
}

beforeEach(() => {
	mockCurrentLocale = "en";
	mockNavigate.mockClear();
});

describe("NetworksScreen Join a network entry", () => {
	it.each([undefined, "ok", "needs-reinvite", "memory-only", "blocked"])(
		"E-1: the entry button sits right after Import Network and opens JoinNetwork (ownerTrust %s)",
		async (state) => {
			const r = await mount(state === undefined ? {} : { ownerTrust: state });
			const json = r.toJSON();
			const buttons = hosts(json).filter((h) => h.props.testID === "networks-join-network-button");
			expect(buttons).toHaveLength(1);
			const el = r.root.findAll((n) => n.props.testID === "networks-join-network-button" && n.props.title !== undefined);
			expect(el).toHaveLength(1);
			expect(el[0].props.title).toBe(tr("en", "joinNetworkButton"));
			expect(el[0].props.icon).toBe("right-to-bracket");
			expect(el[0].props.backgroundColor).toBeUndefined();
			expect(StyleSheet.flatten(buttons[0].props.style).backgroundColor).toBe(lightTheme.colors.accent);

			const importEl = r.root.findAll((n) => n.props.title === tr("en", "networkFoundingImportButton") && typeof n.props.onPress === "function");
			expect(importEl).toHaveLength(1);
			expect(importEl[0].parent).toBe(el[0].parent);

			const pressables = hosts(json).filter(isPressable);
			const at = pressables.findIndex((h) => h.props.accessibilityLabel === tr("en", "networkFoundingImportButton"));
			expect(at).toBeGreaterThanOrEqual(0);
			expect(pressables[at + 1].props.testID).toBe("networks-join-network-button");

			await act(async () => {
				el[0].props.onPress();
			});
			expect(mockNavigate.mock.calls).toEqual([["JoinNetwork"]]);
			await unmount(r);
		},
	);

	describe.each(["en", "es"] as const)("E-2 (%s)", (locale) => {
		it("the needs-reinvite action opens JoinNetwork, never AcceptInvitation", async () => {
			mockCurrentLocale = locale;
			const r = await mount({ ownerTrust: "needs-reinvite" });
			const id = "owner-trust-notice-needs-reinvite-action";
			const host = hosts(r.toJSON()).filter((h) => h.props.testID === id);
			expect(host.length).toBeGreaterThan(0);
			expect(host[0].props.accessibilityLabel).toBe(tr(locale, "ownerTrustReinviteAction"));
			const notice = hosts(r.toJSON()).find((h) => h.props.testID === "owner-trust-notice") as Json;
			expect(hosts(notice).filter(isPressable)).toHaveLength(1);
			await act(async () => {
				elementWith(r, id).props.onPress();
			});
			expect(mockNavigate.mock.calls).toEqual([["JoinNetwork"]]);
			expect(JSON.stringify(mockNavigate.mock.calls)).not.toContain("AcceptInvitation");
			await unmount(r);
		});
	});

	it.each(["memory-only", "blocked"] as const)("E-3: %s has no re-invite action and keeps Open Settings", async (state) => {
		const r = await mount({ ownerTrust: state });
		expect(hosts(r.toJSON()).filter((h) => h.props.testID === "owner-trust-notice-needs-reinvite-action")).toHaveLength(0);
		await act(async () => {
			elementWith(r, "owner-trust-notice-" + state + "-action").props.onPress();
		});
		expect(mockNavigate.mock.calls).toEqual([["Home", { screen: "Settings" }]]);
		await unmount(r);
	});

	it("E-4: the notice is gone when the officer returns after a join refreshed owner trust", async () => {
		const refreshOwnerTrust = jest.fn(async () => {
			mockCadreValue = { ...mockCadreValue, ownerTrust: "ok" };
		});
		const r = await mount({ ownerTrust: "needs-reinvite", refreshOwnerTrust });
		await act(async () => {
			elementWith(r, "owner-trust-notice-needs-reinvite-action").props.onPress();
		});
		expect(mockNavigate.mock.calls).toEqual([["JoinNetwork"]]);
		await act(async () => {
			await refreshOwnerTrust();
		});
		await act(async () => {
			r.update(<NetworksScreen />);
		});
		const json = r.toJSON();
		expect(hosts(json).filter((h) => h.props.testID === "owner-trust-notice")).toHaveLength(0);
		expect(hosts(json).filter((h) => h.props.testID === "networks-join-network-button")).toHaveLength(1);
		await unmount(r);
	});

	it("E-5: the Scan button still only sets its inline note and navigates nowhere", async () => {
		const r = await mount({});
		const el = r.root.findAll((n) => n.props.accessibilityLabel === tr("en", "scan") && typeof n.props.onPress === "function");
		expect(el.length).toBeGreaterThan(0);
		await act(async () => {
			el[0].props.onPress();
		});
		expect(JSON.stringify(r.toJSON())).toContain(tr("en", "qrScanUnavailable"));
		expect(mockNavigate).not.toHaveBeenCalled();
		await unmount(r);
	});
});
