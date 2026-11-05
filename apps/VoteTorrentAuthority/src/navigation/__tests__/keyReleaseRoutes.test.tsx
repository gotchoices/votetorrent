/**
 * keyReleaseRoutes.test.tsx — the real-navigator registration proof for 62-29's `KeyRelease` route
 * (D-17/D-20). Mirrored from `continuityRoutes.test.tsx` (62-27): "a rename or removal
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

let mockKeyReleaseParams: unknown = "unset";

jest.mock("../../screens/keyholder/KeyReleaseScreen", () => ({
	__esModule: true,
	default: function MockKeyReleaseScreen() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { useRoute } = require("@react-navigation/native");
		mockKeyReleaseParams = (useRoute() as any).params;
		return ReactLib.createElement(Text, { testID: "mock-key-release-screen" }, "mock-key-release-screen");
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
	mockKeyReleaseParams = "unset";
});

describe("RootNavigator — the KeyRelease route is really registered and really resolves (62-29, D-17/D-20)", () => {
	it("R1. resolves KeyRelease to its destination marker carrying the task param", async () => {
		const task = { type: "release-key", userId: "kh-1" };
		const tr = await renderRootNavigatorAt({
			index: 0,
			routes: [{ name: "KeyRelease", params: { task } }],
		});
		expect(() => tr.root.findByProps({ testID: "mock-key-release-screen" })).not.toThrow();
		expect(mockKeyReleaseParams).toEqual({ task });
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

describe("navigation source gates (62-29)", () => {
	it("R2. types.ts declares KeyRelease after AssociationRequestApproval and no KeyTask entry", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "types.ts"), "utf8");
		const after = source.indexOf("AssociationRequestApproval: { requestId: string; authorityId: string };");
		const route = source.indexOf("KeyRelease: { task: ReleaseKeyTask };");
		expect(after).toBeGreaterThanOrEqual(0);
		expect(route).toBeGreaterThan(after);
		expect(/^\s*KeyTask:/m.test(source)).toBe(false);
	});

	it("R3. the Stack.Screen follows AssociationRequestApproval, is registered once, and KeyTask is gone", () => {
		const source = fs.readFileSync(NAV_INDEX_PATH, "utf8");
		expect(source.split('name="KeyRelease"')).toHaveLength(2);
		expect(source.indexOf('name="KeyRelease"')).toBeGreaterThan(source.indexOf('name="AssociationRequestApproval"'));
		const registration = extractRegistration(source, "KeyRelease");
		expect(registration).toContain("KeyReleaseScreen");
		expect(registration).toContain('t("keyholderReleaseScreenTitle")');
		expect(registration).toContain('presentation: "modal"');
		expect(registration).toContain("CloseButton");
		expect(source).not.toContain('name="KeyTask"');
		expect(source).not.toContain("KeyTaskScreen");
	});
});
