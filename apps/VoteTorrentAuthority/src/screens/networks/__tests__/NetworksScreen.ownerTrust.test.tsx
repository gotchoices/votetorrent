/**
 * NetworksScreen — the owner-trust notice (D-09, D-10, D-11): N-1..N-7.
 *
 * The REAL NetworksScreen and the REAL OwnerTrustNotice mount over a mocked cadre-node context.
 * `t()` resolves against the REAL `resources`; `useTheme()` is the REAL light theme. The two
 * network cards are stubbed so this suite does not depend on their (sibling-owned) edits.
 * "First" is tree order under the scroll view, not measured geometry.
 */
import React from "react";
import fs from "fs";
import path from "path";
import renderer, { act } from "react-test-renderer";
import { resources } from "../../../i18n";

jest.mock("@multiformats/multiaddr", () => ({ multiaddr: () => ({ getComponents: () => [] }) }), { virtual: true });
jest.mock("@votetorrent/vote-core", () => ({}), { virtual: true });
jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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
			const { lightTheme: theme } = require("../../../theme/themes");
			return theme;
		},
		useNavigation: () => ({ navigate: mockNavigate, setOptions: jest.fn() }),
		useFocusEffect: (cb: () => void | (() => void)) => {
			ReactForMock.useEffect(() => cb(), []);
		},
	};
});

const NetworksScreen = require("../NetworksScreen").default;

type Json = { type: string; props: Record<string, any>; children: Array<Json | string> | null };
type StateName = "needs-reinvite" | "memory-only" | "blocked";
const STATES: StateName[] = ["needs-reinvite", "memory-only", "blocked"];
const TITLE: Record<StateName, string> = {
	"needs-reinvite": "ownerTrustReinviteTitle",
	"memory-only": "ownerTrustMemoryTitle",
	blocked: "ownerTrustBlockedTitle",
};

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

function pressableCount(json: unknown): number {
	return hosts(json).filter((h) => typeof h.props.onClick === "function" || typeof h.props.onPress === "function").length;
}

function scrollNode(json: unknown): Json {
	const sv = hosts(json).find((h) => h.props.testID === "networks-scroll");
	if (!sv) throw new Error("networks-scroll not found");
	return sv;
}

/** Host nodes under the scroll view (excluding it), in pre-order. */
function underScroll(json: unknown): Json[] {
	return hosts(scrollNode(json).children?.filter((c): c is Json => typeof c !== "string"));
}

function noticeNodes(json: unknown): Json[] {
	return hosts(json).filter((h) => typeof h.props.testID === "string" && h.props.testID.startsWith("owner-trust-notice"));
}

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

beforeEach(() => {
	mockCurrentLocale = "en";
	mockNavigate.mockClear();
});

describe("NetworksScreen owner-trust notice", () => {
	it("N-1: no ownerTrust renders no notice and the first text is the screen's own heading", async () => {
		const r = await mount({});
		const json = r.toJSON();
		expect(noticeNodes(json)).toHaveLength(0);
		const firstText = underScroll(json).find((h) => h.type === "Text");
		expect(firstText && textOf(firstText)).toBe(tr("en", "useOneOfTheFollowingToGetConnected"));
		await unmount(r);
	});

	it("N-2: 'ok' renders the same as a missing value", async () => {
		const r = await mount({ ownerTrust: "ok" });
		expect(noticeNodes(r.toJSON())).toHaveLength(0);
		await unmount(r);
	});

	describe.each(["en", "es"] as const)("N-3 (%s)", (locale) => {
		it.each(STATES)("%s shows one notice, first under the scroll view", async (state) => {
			mockCurrentLocale = locale;
			const r = await mount({ ownerTrust: state });
			const json = r.toJSON();
			expect(hosts(json).filter((h) => h.props.testID === "owner-trust-notice")).toHaveLength(1);
			const withId = underScroll(json).filter((h) => typeof h.props.testID === "string");
			expect(withId[0].props.testID).toBe("owner-trust-notice");
			const firstText = underScroll(json).find((h) => h.type === "Text");
			expect(firstText && textOf(firstText)).toBe(tr(locale, TITLE[state]));
			expect(hosts(json).filter((h) => h.props.testID === "owner-trust-notice-" + state)).toHaveLength(1);
			await unmount(r);
		});
	});

	it.each(["memory-only", "blocked"] as const)("N-4: %s offers Open Settings, which opens Home > Settings", async (state) => {
		const r = await mount({ ownerTrust: state });
		const id = "owner-trust-notice-" + state + "-action";
		const host = hosts(r.toJSON()).filter((h) => h.props.testID === id);
		expect(host.length).toBeGreaterThan(0);
		expect(host[0].props.accessibilityLabel).toBe(tr("en", "ownerTrustOpenSettings"));
		const el = r.root.findAll((n) => n.props.testID === id && typeof n.props.onPress === "function");
		await act(async () => {
			el[0].props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate).toHaveBeenCalledWith("Home", { screen: "Settings" });
		await unmount(r);
	});

	it("N-5: needs-reinvite has the wired action (JoinNetwork), and the screen never targets AcceptInvitation", async () => {
		const r = await mount({ ownerTrust: "needs-reinvite" });
		const json = r.toJSON();
		expect(hosts(json).filter((h) => h.props.testID === "owner-trust-notice-needs-reinvite-action").length).toBeGreaterThan(0);
		const notice = hosts(json).find((h) => h.props.testID === "owner-trust-notice") as Json;
		expect(pressableCount(notice)).toBe(1);
		const el = r.root.findAll((n) => n.props.testID === "owner-trust-notice-needs-reinvite-action" && typeof n.props.onPress === "function");
		await act(async () => {
			el[0].props.onPress();
		});
		expect(mockNavigate.mock.calls).toEqual([["JoinNetwork"]]);
		await unmount(r);
		const src = fs.readFileSync(path.join(__dirname, "../NetworksScreen.tsx"), "utf8");
		const code = src
			.split("\n")
			.filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
			.join("\n");
		expect(code.length).toBeGreaterThan(1000);
		expect(code).not.toContain("AcceptInvitation");
	});

	it.each(STATES)("N-6: %s persists after the Scan button sets its inline note", async (state) => {
		const r = await mount({ ownerTrust: state });
		const scanLabel = tr("en", "scan");
		const el = r.root.findAll((n) => n.props.accessibilityLabel === scanLabel && typeof n.props.onPress === "function");
		expect(el.length).toBeGreaterThan(0);
		await act(async () => {
			el[0].props.onPress();
		});
		const json = r.toJSON();
		// The inline note proves the press took effect.
		expect(JSON.stringify(json)).toContain(tr("en", "qrScanUnavailable"));
		expect(hosts(json).filter((h) => h.props.testID === "owner-trust-notice")).toHaveLength(1);
		expect(underScroll(json).filter((h) => typeof h.props.testID === "string")[0].props.testID).toBe("owner-trust-notice");
		const notice = hosts(json).find((h) => h.props.testID === "owner-trust-notice") as Json;
		// Every state now carries exactly one action: Open Settings, or the wired Join a network.
		expect(pressableCount(notice)).toBe(1);
		await unmount(r);
	});

	it("N-7: the notice goes away when the context value becomes ok", async () => {
		const r = await mount({ ownerTrust: "memory-only" });
		expect(noticeNodes(r.toJSON()).length).toBeGreaterThan(0);
		mockCadreValue = { ...mockCadreValue, ownerTrust: "ok" };
		await act(async () => {
			r.update(<NetworksScreen />);
		});
		expect(noticeNodes(r.toJSON())).toHaveLength(0);
		await unmount(r);
	});
});
