/**
 * foundingBundleRoutes.test.tsx — the real-navigator registration proof for 62-23's
 * `ImportFoundingBundle` route (D-35/D-36). Mirrored wholesale from `phase50Routes.test.tsx`
 * (itself mirrored from `phase48Routes.test.tsx`/`phase47Routes.test.tsx`): "a rename or removal
 * of a route name, a registration, or an entry card severs the only user path into an entire
 * phase's UI with nothing going red." Renders the REAL `RootNavigator` (src/navigation/index.tsx)
 * inside a REAL `NavigationContainer` + `SafeAreaProvider`. Only the DESTINATION screen module is
 * replaced with a marker component — the `Stack.Screen` registration, its route-name string and
 * its title binding are all the untouched production code from `navigation/index.tsx`.
 * `navigation/index.tsx` is never mocked.
 */

import React from "react";
import renderer from "react-test-renderer";
import fs from "fs";
import path from "path";

// Rendering the REAL RootNavigator eagerly loads every screen module in the app — see
// phase48Routes.test.tsx's identical comment; the render breadth *is* the proof.
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

let mockImportFoundingBundleParams: unknown = "unset";

jest.mock("../../screens/networks/ImportFoundingBundleScreen", () => ({
	__esModule: true,
	default: function MockImportFoundingBundleScreen() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { useRoute } = require("@react-navigation/native");
		mockImportFoundingBundleParams = (useRoute() as any).params;
		return ReactLib.createElement(
			Text,
			{ testID: "mock-import-founding-bundle-screen" },
			"mock-import-founding-bundle-screen",
		);
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
	mockImportFoundingBundleParams = "unset";
});

describe("RootNavigator — the ImportFoundingBundle route is really registered and really resolves (62-23, D-35/D-36)", () => {
	it("resolves ImportFoundingBundle to its destination marker with no params", async () => {
		const tr = await renderRootNavigatorAt({
			index: 0,
			routes: [{ name: "ImportFoundingBundle" }],
		});
		expect(() => tr.root.findByProps({ testID: "mock-import-founding-bundle-screen" })).not.toThrow();
		expect(mockImportFoundingBundleParams).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Source-level gates. native-stack renders its header outside the asserted
// subtree under react-test-renderer, so the honest available proof that the
// Stack.Screen registration binds the right title key is a source assertion,
// not a render assertion.
// ---------------------------------------------------------------------------

const NAV_INDEX_PATH = path.join(__dirname, "..", "index.tsx");

/** Extracts the substring from `name="<Route>"` to the next `/>` in navigation/index.tsx. */
function extractRegistration(source: string, routeName: string): string {
	const marker = `name="${routeName}"`;
	const start = source.indexOf(marker);
	expect(start).toBeGreaterThanOrEqual(0);
	const end = source.indexOf("/>", start);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end + 2);
}

describe("navigation/index.tsx — ImportFoundingBundle title-binding source gate (62-23)", () => {
	const source = fs.readFileSync(NAV_INDEX_PATH, "utf8");

	it("binds component ImportFoundingBundleScreen and title key networkFoundingImportScreenTitle", () => {
		const registration = extractRegistration(source, "ImportFoundingBundle");
		expect(registration).toContain("ImportFoundingBundleScreen");
		expect(registration).toContain('t("networkFoundingImportScreenTitle")');
	});
});

describe("i18n/index.ts — networkFoundingImportScreenTitle binding gate (62-23)", () => {
	it("the title key appears at least twice (EN and ES) — a missing key does not throw at runtime", () => {
		const i18n = fs.readFileSync(path.join(__dirname, "..", "..", "i18n", "index.ts"), "utf8");
		const count = (i18n.match(/\bnetworkFoundingImportScreenTitle:/g) || []).length;
		expect(count).toBeGreaterThanOrEqual(2);
	});
});

describe("navigation/types.ts — param-hygiene source gate (62-23)", () => {
	it("ImportFoundingBundle is typed undefined — no params", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "types.ts"), "utf8");
		expect(source).toContain("ImportFoundingBundle: undefined;");
	});
});
