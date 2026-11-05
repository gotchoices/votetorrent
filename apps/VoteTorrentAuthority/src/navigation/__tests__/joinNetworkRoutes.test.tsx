/**
 * joinNetworkRoutes.test.tsx - the real-navigator registration proof for the `JoinNetwork` route
 * (D-26, UI-SPEC A1). Mirrors `foundingBundleRoutes.test.tsx`: the REAL `RootNavigator` renders
 * inside a REAL `NavigationContainer` and `SafeAreaProvider`; only the destination screen module is
 * a marker that records `useRoute().params`. Navigation state is never persisted (A1 point 2), and
 * the route carries no params, so the join code can never enter navigation state.
 */

import React from "react";
import renderer from "react-test-renderer";
import fs from "fs";
import path from "path";

// Rendering the REAL RootNavigator eagerly loads every screen module in the app.
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

let mockJoinNetworkParams: unknown = "unset";

jest.mock("../../screens/networks/JoinNetworkScreen", () => ({
	__esModule: true,
	default: function MockJoinNetworkScreen() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { useRoute } = require("@react-navigation/native");
		mockJoinNetworkParams = (useRoute() as any).params;
		return ReactLib.createElement(Text, { testID: "mock-join-network-screen" }, "mock-join-network-screen");
	},
}));

const trees: renderer.ReactTestRenderer[] = [];

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
	trees.push(tr);
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
	return tr;
}

beforeEach(() => {
	mockJoinNetworkParams = "unset";
});

afterEach(async () => {
	for (const tr of trees.splice(0)) {
		await renderer.act(async () => {
			tr.unmount();
		});
	}
});

describe("RootNavigator - the JoinNetwork route is really registered and really resolves (D-26)", () => {
	it("J-1: resolves JoinNetwork to its destination marker with params undefined", async () => {
		const tr = await renderRootNavigatorAt({ index: 0, routes: [{ name: "JoinNetwork" }] });
		expect(() => tr.root.findByProps({ testID: "mock-join-network-screen" })).not.toThrow();
		expect(mockJoinNetworkParams).toBeUndefined();
	});
});

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

describe("navigation/index.tsx - JoinNetwork registration source gate (D-26)", () => {
	const source = fs.readFileSync(NAV_INDEX_PATH, "utf8");

	it("J-2: binds JoinNetworkScreen and the joinNetworkTitle key, with no initialParams, after ImportFoundingBundle", () => {
		const registration = extractRegistration(source, "JoinNetwork");
		expect(registration).toContain("JoinNetworkScreen");
		expect(registration).toContain('t("joinNetworkTitle")');
		expect(registration).not.toContain("initialParams");
		const at = source.indexOf('name="JoinNetwork"');
		expect(at).toBeGreaterThan(source.indexOf('name="ImportFoundingBundle"'));
		expect(at).toBeLessThan(source.indexOf('name="AssociationRequestApproval"'));
	});
});

describe("types.ts and i18n - JoinNetwork param hygiene and title key (D-26)", () => {
	it("J-3: JoinNetwork is typed undefined, once, between ImportFoundingBundle and AssociationRequestApproval", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "types.ts"), "utf8");
		expect(source.match(/JoinNetwork: undefined;/g) ?? []).toHaveLength(1);
		const at = source.indexOf("JoinNetwork: undefined;");
		expect(at).toBeGreaterThan(source.indexOf("ImportFoundingBundle: undefined;"));
		expect(at).toBeLessThan(source.indexOf("AssociationRequestApproval:"));
		const i18n = fs.readFileSync(path.join(__dirname, "..", "..", "i18n", "index.ts"), "utf8");
		expect((i18n.match(/\bjoinNetworkTitle:/g) ?? []).length).toBeGreaterThanOrEqual(2);
	});
});

describe("navigation state is never persisted (UI-SPEC A1 point 2)", () => {
	const PATTERN = /onStateChange|initialState/;

	function walk(dir: string, out: string[]): void {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "__tests__" || entry.name === "__fixtures__" || entry.name === "node_modules") continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full, out);
			else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
		}
	}

	it("J-4: no production file sets onStateChange or initialState", () => {
		const srcDir = path.join(__dirname, "..", "..");
		const files: string[] = [path.join(srcDir, "..", "App.tsx")];
		walk(srcDir, files);
		expect(files.length).toBeGreaterThan(100);
		expect(PATTERN.test("<NavigationContainer initialState={x} />")).toBe(true);
		const hits = files.filter((f) => fs.existsSync(f) && PATTERN.test(fs.readFileSync(f, "utf8")));
		expect(hits.map((f) => path.relative(srcDir, f))).toEqual([]);
	});
});
