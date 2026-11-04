/**
 * UserDetailsScreen — the "Paired browsers" entry (D-08): U1..U3.
 *
 * The entry shows only on this phone's own officer's details (the list holds the browsers THIS phone
 * paired for its device user). The check is read-only (`getDeviceUser`, never the creating variant)
 * and silent: another officer, no device user, a failing read, or a module without `getDeviceUser`
 * all hide the entry with no console output. U3 pins the route: a param-less `PairedBrowsers` type
 * and a title-only registration (the screen sets its own "+" header action).
 */
import React from "react";
import fs from "fs";
import path from "path";
import renderer, { act } from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });
jest.mock("../../../providers/SettingsProvider", () => ({ useSettings: () => ({ showHelpIcons: false }) }));
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const mockNavigate = jest.fn();
let mockRouteParams: Record<string, unknown> = {};
jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({ colors: new Proxy({}, { get: (_t, p) => `c-${String(p)}` }) }),
	useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn(), setOptions: jest.fn() }),
	useRoute: () => ({ params: mockRouteParams }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const R = require("react");
		R.useEffect(() => cb(), []);
	},
}));

const mockGetDeviceUser = jest.fn();
let mockDeviceUserModule: Record<string, unknown> = { getDeviceUser: (...a: unknown[]) => mockGetDeviceUser(...a) };
jest.mock("../../../engines/device-user", () => new Proxy({}, { get: (_t, p) => mockDeviceUserModule[String(p)] }));

const ENTRY = "user-details-paired-browsers-entry";
const SRC = path.join(__dirname, "..", "..", "..");

function routeFor(id: string) {
	return {
		user: { id, name: "Officer One", activeKeys: [] },
		userEngine: {
			getSummary: jest.fn(async () => ({ id, name: "Officer One", activeKeys: [] })),
			getHistory: jest.fn(async () => (async function* () {})()),
		},
	};
}

async function flush(n = 12) {
	for (let i = 0; i < n; i++) {
		// eslint-disable-next-line no-await-in-loop
		await act(async () => {
			await Promise.resolve();
		});
	}
}

const mounted: renderer.ReactTestRenderer[] = [];
async function mount(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { UserDetailsScreen } = require("../UserDetailsScreen");
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<UserDetailsScreen />);
	});
	mounted.push(tr);
	await flush();
	return tr;
}

const entries = (tr: renderer.ReactTestRenderer) =>
	tr.root.findAll((n) => n.props.testID === ENTRY && typeof n.props.onPress === "function" && typeof n.props.title === "string");

beforeEach(() => {
	jest.clearAllMocks();
	mockDeviceUserModule = { getDeviceUser: (...a: unknown[]) => mockGetDeviceUser(...a) };
	mockRouteParams = routeFor("u1");
});

afterEach(async () => {
	while (mounted.length > 0) {
		const tr = mounted.pop()!;
		// eslint-disable-next-line no-await-in-loop
		await act(async () => tr.unmount());
	}
});

describe("UserDetailsScreen paired-browsers entry", () => {
	it("U1 this phone's officer: one entry after Revoke key, titled Paired browsers, opening the list with no params", async () => {
		mockGetDeviceUser.mockResolvedValue({ id: "u1", name: "Officer One", activeKeys: [] });
		const tr = await mount();
		const found = entries(tr);
		expect(found.length).toBe(1);
		const entry = found[0];
		expect(entry.props.title).toBe("pairedBrowsersTitle");
		expect(entry.props.size).toBe("thin");
		expect(entry.props.icon).toBe("desktop");
		expect(entry.props.backgroundColor).toBe("c-accent");
		// Placement: directly after the revokeKey button.
		const buttons = tr.root.findAll((n) => typeof n.props.title === "string" && typeof n.props.onPress === "function" && n.props.size === "thin");
		const titles = buttons.map((b) => b.props.title as string).filter((t, i, a) => a.indexOf(t) === i);
		expect(titles.indexOf("pairedBrowsersTitle")).toBe(titles.indexOf("revokeKey") + 1);
		await act(async () => {
			entry.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate.mock.calls[0]).toEqual(["PairedBrowsers"]);
		expect(mockGetDeviceUser).toHaveBeenCalled();
	});

	it("U2 any other case hides the entry silently: another officer, no device user, a failing read, no getDeviceUser export", async () => {
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
			jest.spyOn(console, m).mockImplementation(() => undefined)
		);
		try {
			const setups: Array<() => void> = [
				() => mockGetDeviceUser.mockResolvedValue({ id: "someone-else", name: "X", activeKeys: [] }),
				() => mockGetDeviceUser.mockResolvedValue(undefined),
				() => mockGetDeviceUser.mockRejectedValue(new Error("storage broken")),
				() => {
					mockDeviceUserModule = { getOrCreateDeviceUser: jest.fn() };
				},
			];
			for (const setup of setups) {
				mockDeviceUserModule = { getDeviceUser: (...a: unknown[]) => mockGetDeviceUser(...a) };
				setup();
				// eslint-disable-next-line no-await-in-loop
				const tr = await mount();
				expect(entries(tr).length).toBe(0);
			}
			const consoleCalls = spies.reduce((n, s) => n + s.mock.calls.length, 0);
			expect(consoleCalls).toBe(0);
		} finally {
			for (const s of spies) s.mockRestore();
		}
		const source = fs.readFileSync(path.join(SRC, "screens", "users", "UserDetailsScreen.tsx"), "utf8");
		expect(/getOrCreateDeviceUser/.test(source)).toBe(false);
		expect(source.split('navigate("PairedBrowsers")').length - 1).toBe(1);
	});

	it("U3 route: a param-less PairedBrowsers type and a title-only registration bound to the screen", () => {
		const types = fs.readFileSync(path.join(SRC, "navigation", "types.ts"), "utf8");
		expect(types.split("PairedBrowsers: undefined;").length - 1).toBe(1);
		const nav = fs.readFileSync(path.join(SRC, "navigation", "index.tsx"), "utf8");
		expect(nav.includes('import PairedBrowsersScreen from "../screens/dashboard/PairedBrowsersScreen";')).toBe(true);
		const start = nav.indexOf('name="PairedBrowsers"');
		expect(start).toBeGreaterThan(0);
		expect(nav.indexOf('name="PairedBrowsers"', start + 1)).toBe(-1);
		const open = nav.lastIndexOf("<Stack.Screen", start);
		const close = nav.indexOf("/>", start);
		const block = nav.slice(open, close + 2);
		expect(block).toContain("component={PairedBrowsersScreen}");
		expect(block).toContain('options={{ title: t("pairedBrowsersTitle") }}');
		for (const banned of ["presentation", "CloseButton", "headerLeft", "headerRight"]) {
			expect([banned, block.includes(banned)]).toEqual([banned, false]);
		}
		// Registered right after the pair screen.
		expect(nav.indexOf('name="PairBrowser"')).toBeLessThan(start);
	});
});
