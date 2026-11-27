/**
 * phase50Routes.test.tsx — the real-navigator registration proof for the
 * `PairBrowser` route (the officer pairs their own browser). It replaced the
 * dashboard sign-in code route in the same position and the same non-modal
 * shape, and this suite now also proves the old route, entry and title key are
 * gone from the navigator, its types and Settings.
 *
 * Mirrored wholesale from `phase48Routes.test.tsx` (itself mirrored from
 * `phase47Routes.test.tsx`): "a rename or removal of a route name, a
 * registration, or an entry card severs the only user path into an entire
 * phase's UI with nothing going red." Renders the REAL `RootNavigator`
 * (src/navigation/index.tsx) inside a REAL `NavigationContainer` +
 * `SafeAreaProvider`. Only the DESTINATION screen module is replaced with a
 * marker component — the `Stack.Screen` registration, its route-name string
 * and its title binding are all the untouched production code from
 * `navigation/index.tsx`. `navigation/index.tsx` is never mocked.
 */

import React from "react";
import renderer from "react-test-renderer";
import fs from "fs";
import path from "path";

// Rendering the REAL RootNavigator eagerly loads every screen module in the
// app, so the FIRST test in this file pays the whole module-graph cost — see
// phase48Routes.test.tsx's identical comment; the render breadth *is* the
// proof, so raise the timeout rather than shortening the render.
//
// 2026-08-29 re-measurement (Phase 51 Nyquist audit): 30_000 was still
// insufficient — a `yarn jest --clearCache && yarn jest` full run clocked
// this file at 32.817s (cold), while solo cold (no other worker contention)
// it took 23.235s. Root cause is parallel-worker CPU contention across ~98
// suites cold-transforming Babel simultaneously, not a hang — isolated cold
// time is stable. Raised again, with headroom above the observed worst case.
jest.setTimeout(60_000);

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-splash-view", () => ({ hideSplash: jest.fn() }));

jest.mock("../../providers/AppProvider", () => ({
	useApp: () => ({}),
	AppProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: null, syncState: "offline", connectedPeers: () => 0 }),
	CadreNodeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

let mockPairBrowserParams: unknown = "unset";

jest.mock("../../screens/dashboard/PairBrowserScreen", () => ({
	__esModule: true,
	default: function MockPairBrowserScreen() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { useRoute } = require("@react-navigation/native");
		mockPairBrowserParams = (useRoute() as any).params;
		return ReactLib.createElement(Text, { testID: "mock-pair-browser-screen" }, "mock-pair-browser-screen");
	},
}));

async function renderRootNavigatorAt(
	initialState: { index: number; routes: Array<{ name: string; params?: unknown }> },
): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { NavigationContainer } = require("@react-navigation/native");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { SafeAreaProvider } = require("react-native-safe-area-context");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { RootNavigator } = require("../index");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { lightTheme } = require("../../theme/themes");

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(
			<SafeAreaProvider
				initialMetrics={{
					frame: { x: 0, y: 0, width: 320, height: 640 },
					insets: { top: 0, left: 0, right: 0, bottom: 0 },
				}}
			>
				<NavigationContainer theme={lightTheme} initialState={initialState}>
					<RootNavigator />
				</NavigationContainer>
			</SafeAreaProvider>,
		);
	});
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
	return tr;
}

beforeEach(() => {
	mockPairBrowserParams = "unset";
});

describe("RootNavigator — the PairBrowser route is really registered and really resolves", () => {
	it("the PairBrowser route is registered and resolves with no params", async () => {
		const tr = await renderRootNavigatorAt({
			index: 0,
			routes: [{ name: "PairBrowser" }],
		});
		expect(() => tr.root.findByProps({ testID: "mock-pair-browser-screen" })).not.toThrow();
		expect(mockPairBrowserParams).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Source-level gates. native-stack renders its header outside the asserted
// subtree under react-test-renderer, so the honest available proof that the
// Stack.Screen registration binds the right title key is a source assertion,
// not a render assertion.
// ---------------------------------------------------------------------------

const NAV_INDEX_PATH = path.join(__dirname, "..", "index.tsx");
const TYPES_PATH = path.join(__dirname, "..", "types.ts");
const SETTINGS_PATH = path.join(__dirname, "..", "..", "screens", "settings", "SettingsScreen.tsx");

/** Extracts the substring from `name="<Route>"` to the next `/>` in navigation/index.tsx. */
function extractRegistration(source: string, routeName: string): string {
	const marker = `name="${routeName}"`;
	const start = source.indexOf(marker);
	expect(start).toBeGreaterThanOrEqual(0);
	const end = source.indexOf("/>", start);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end + 2);
}

describe("navigation/index.tsx — PairBrowser title-binding source gate", () => {
	const source = fs.readFileSync(NAV_INDEX_PATH, "utf8");

	it("binds component PairBrowserScreen and title key dashboardPairingTitle", () => {
		const registration = extractRegistration(source, "PairBrowser");
		expect(registration).toContain("component={PairBrowserScreen}");
		expect(registration).toContain('t("dashboardPairingTitle")');
	});

	it("carries none of presentation/CloseButton/headerLeft/headerRight", () => {
		const registration = extractRegistration(source, "PairBrowser");
		expect(registration).not.toContain("presentation");
		expect(registration).not.toContain("CloseButton");
		expect(registration).not.toContain("headerLeft");
		expect(registration).not.toContain("headerRight");
	});
});

describe("i18n/index.ts — dashboardPairingTitle binding gate", () => {
	it("the title key appears at least twice (EN and ES) — a missing key does not throw at runtime", () => {
		const i18n = fs.readFileSync(path.join(__dirname, "..", "..", "i18n", "index.ts"), "utf8");
		const count = (i18n.match(/\bdashboardPairingTitle:/g) || []).length;
		expect(count).toBeGreaterThanOrEqual(2);
	});
});

describe("navigation/types.ts — param-hygiene source gate", () => {
	it("PairBrowser is typed undefined — no params, so the code never enters navigation state", () => {
		expect(fs.readFileSync(TYPES_PATH, "utf8")).toContain("PairBrowser: undefined;");
	});
});

describe("SettingsScreen.tsx — entry-point source gate", () => {
	it("contains the pair-a-browser entry row, its testID, and its PairBrowser navigate target", () => {
		const source = fs.readFileSync(SETTINGS_PATH, "utf8");
		expect(source).toContain("settings-pair-browser-entry");
		expect(source).toContain('"PairBrowser"');
		expect(source).toContain('t("dashboardPairingTitle")');
	});
});

describe("the retired sign-in code route is gone", () => {
	// Built from fragments so this file never spells the retired names itself.
	const RETIRED = ["Dashboard" + "SignInCode", "dashboard" + "SignInCode"];

	it("controls: the scan finds a planted name and passes clean text", () => {
		expect(RETIRED.some((r) => `name="${"Dashboard" + "SignInCode"}"`.includes(r))).toBe(true);
		expect(RETIRED.some((r) => 'name="PairBrowser"'.includes(r))).toBe(false);
	});

	it.each([
		["navigation/index.tsx", NAV_INDEX_PATH],
		["navigation/types.ts", TYPES_PATH],
		["SettingsScreen.tsx", SETTINGS_PATH],
	])("%s names neither the retired route nor its copy keys", (_label, file) => {
		const source = fs.readFileSync(file, "utf8");
		for (const r of RETIRED) expect(source.includes(r)).toBe(false);
	});
});
