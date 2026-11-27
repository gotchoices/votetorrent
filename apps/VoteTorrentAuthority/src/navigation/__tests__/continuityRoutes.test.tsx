/**
 * continuityRoutes.test.tsx — the real-navigator registration proof for 62-27's
 * `AssociationRequestApproval` route (D-41/D-45). Mirrored wholesale from `foundingBundleRoutes.test.tsx`
 * (62-23), itself from `phase50Routes.test.tsx`
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

let mockApprovalParams: unknown = "unset";

jest.mock("../../screens/registration/AssociationRequestApprovalScreen", () => ({
	__esModule: true,
	default: function MockAssociationRequestApprovalScreen() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { useRoute } = require("@react-navigation/native");
		mockApprovalParams = (useRoute() as any).params;
		return ReactLib.createElement(Text, { testID: "mock-association-request-approval-screen" }, "mock-association-request-approval-screen");
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
	mockApprovalParams = "unset";
});

describe("RootNavigator — the AssociationRequestApproval route is really registered and really resolves (62-27, D-41/D-45)", () => {
	it("R1. resolves AssociationRequestApproval to its destination marker with exactly { requestId, authorityId }", async () => {
		const tr = await renderRootNavigatorAt({
			index: 0,
			routes: [{ name: "AssociationRequestApproval", params: { requestId: "arq-1", authorityId: "auth-1" } }],
		});
		expect(() => tr.root.findByProps({ testID: "mock-association-request-approval-screen" })).not.toThrow();
		expect(mockApprovalParams).toEqual({ requestId: "arq-1", authorityId: "auth-1" });
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

describe("navigation source gates (62-27)", () => {
	it("R2. types.ts declares the route after ImportFoundingBundle with exactly the two identifier params", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "types.ts"), "utf8");
		const after = source.indexOf("ImportFoundingBundle: undefined;");
		const route = source.indexOf("AssociationRequestApproval: { requestId: string; authorityId: string };");
		expect(after).toBeGreaterThanOrEqual(0);
		expect(route).toBeGreaterThan(after);
	});

	it("R3. the Stack.Screen follows ImportFoundingBundle and is titled associationApprovalScreenTitle", () => {
		const source = fs.readFileSync(NAV_INDEX_PATH, "utf8");
		expect(source.indexOf('name="AssociationRequestApproval"')).toBeGreaterThan(source.indexOf('name="ImportFoundingBundle"'));
		const registration = extractRegistration(source, "AssociationRequestApproval");
		expect(registration).toContain("AssociationRequestApprovalScreen");
		expect(registration).toContain('t("associationApprovalScreenTitle")');
		const i18n = fs.readFileSync(path.join(__dirname, "..", "..", "i18n", "index.ts"), "utf8");
		expect((i18n.match(/\bassociationApprovalScreenTitle:/g) || []).length).toBeGreaterThanOrEqual(2);
	});
});
