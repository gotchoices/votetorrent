/**
 * phase47Routes.test.tsx — the real-navigator registration proof for
 * 47-21's five Phase 47 routes (D-07/D-08/D-09).
 *
 * This is exactly the gap Phase 46's `ed5cde8` closed for the single D-01
 * route: "a rename or removal of a route name, a registration, or an entry
 * card severs the only user path into an entire phase's UI with nothing
 * going red." Scaffold copied wholesale from
 * `../../screens/elections/__tests__/ElectionDetailsScreen.registrationPolicyRoute.test.tsx`
 * (Suite B), adjusted for this file's location one directory deeper.
 *
 * Renders the REAL `RootNavigator` (src/navigation/index.tsx) inside a REAL
 * `NavigationContainer` + `SafeAreaProvider`. Only the five DESTINATION
 * screen modules are replaced with marker components — the five
 * `Stack.Screen` registrations, their route-name strings and their title
 * bindings are all the untouched production code from navigation/index.tsx.
 */

import React from "react";
import renderer from "react-test-renderer";
import fs from "fs";
import path from "path";

// Rendering the REAL RootNavigator eagerly loads every screen module in the
// app, so the FIRST test in this file pays the whole module-graph cost. Run
// alone that fits inside Jest's 5s default; run as part of the full suite,
// competing with the other workers, it does not — this file and its Suite B
// sibling were the only two that intermittently timed out under full-suite
// load (observed 2026-08-05: RED in one full run, GREEN in the next, GREEN
// 18/18 in isolation). A timeout-flaky navigator proof is worse than a slow
// one: the gate can no longer tell a real route regression from scheduler
// noise. Raised deliberately rather than by shortening the render.
//
// 2026-08-29 re-measurement (Phase 51 Nyquist audit): `yarn jest --clearCache
// && yarn jest` on this 10-core host still failed 30_000ms — full-suite run
// clocked this file at 35.774s (cold). Solo (still cold-cache, no other
// worker contention) it took 23.286s. The gap is scheduler contention across
// ~98 parallel suites on a cold Babel-transform cache, not a hang or a real
// perf regression: isolated cold time is stable and well under any of these
// budgets. Raised again, with headroom above the observed 35.774s worst case.
jest.setTimeout(60_000);

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

// navigation/index.tsx eagerly imports every screen module (including
// AuthorityDetailsScreen, which imports ../../providers/AppProvider, which
// imports react-native-splash-view) — a native TurboModule with no binary
// registered under this Jest RN environment. Mocked inert, matching
// __tests__/App.test.tsx's convention.
jest.mock("react-native-splash-view", () => ({ hideSplash: jest.fn() }));

// AppProvider/CadreNodeProvider pull in native-binary-backed packages this
// Jest RN environment cannot resolve at all. Mocked to inert pass-throughs —
// neither provider is rendered by this test (none of the five destination
// markers call useApp() or useCadreNode()), so this cannot mask anything
// this test is meant to prove.
jest.mock("../../providers/AppProvider", () => ({
	useApp: () => ({}),
	AppProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: null, syncState: "offline", connectedPeers: () => 0 }),
	CadreNodeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Prefixed `mock` so babel-plugin-jest-hoist allows the jest.mock() factories
// below (hoisted above these declarations) to close over them.
let mockRegistrantsListParams: any = "unset";
let mockRegistrantDetailParams: any = "unset";
let mockAttestationProvisioningStatusParams: any = "unset";
let mockPollingDevicesParams: any = "unset";
let mockAuthorityPeersParams: any = "unset";

// Replaces ONLY the destination screen modules. navigation/index.tsx's
// imports of these same absolute files are left completely untouched — each
// is simply fed a marker stub instead of the real screen, so the real
// Stack.Screen registrations are exercised verbatim and only the
// destinations are swapped. Proves ROUTING; each screen's own suite proves
// its behavior. Each factory is inlined (not a shared helper) because
// babel-plugin-jest-hoist forbids a jest.mock() factory from closing over an
// out-of-scope, non-`mock`-prefixed binding.
jest.mock("../../screens/registration/RegistrantsListScreen", () => ({
	__esModule: true,
	default: function MockRegistrantsListScreen() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { useRoute } = require("@react-navigation/native");
		mockRegistrantsListParams = (useRoute() as any).params;
		return ReactLib.createElement(Text, { testID: "mock-registrants-list-screen" }, "mock-registrants-list-screen");
	},
}));
jest.mock("../../screens/registration/RegistrantDetailScreen", () => ({
	__esModule: true,
	default: function MockRegistrantDetailScreen() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { useRoute } = require("@react-navigation/native");
		mockRegistrantDetailParams = (useRoute() as any).params;
		return ReactLib.createElement(Text, { testID: "mock-registrant-detail-screen" }, "mock-registrant-detail-screen");
	},
}));
jest.mock("../../screens/registration/AttestationProvisioningStatusScreen", () => ({
	__esModule: true,
	default: function MockAttestationProvisioningStatusScreen() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { useRoute } = require("@react-navigation/native");
		mockAttestationProvisioningStatusParams = (useRoute() as any).params;
		return ReactLib.createElement(
			Text,
			{ testID: "mock-attestation-provisioning-status-screen" },
			"mock-attestation-provisioning-status-screen",
		);
	},
}));
jest.mock("../../screens/authorities/PollingDevicesScreen", () => ({
	__esModule: true,
	default: function MockPollingDevicesScreen() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { useRoute } = require("@react-navigation/native");
		mockPollingDevicesParams = (useRoute() as any).params;
		return ReactLib.createElement(Text, { testID: "mock-polling-devices-screen" }, "mock-polling-devices-screen");
	},
}));
jest.mock("../../screens/authorities/AuthorityPeersScreen", () => ({
	__esModule: true,
	default: function MockAuthorityPeersScreen() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { useRoute } = require("@react-navigation/native");
		mockAuthorityPeersParams = (useRoute() as any).params;
		return ReactLib.createElement(Text, { testID: "mock-authority-peers-screen" }, "mock-authority-peers-screen");
	},
}));

const ALL_MARKER_TESTIDS = [
	"mock-registrants-list-screen",
	"mock-registrant-detail-screen",
	"mock-attestation-provisioning-status-screen",
	"mock-polling-devices-screen",
	"mock-authority-peers-screen",
];

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
			// react-test-renderer never fires a real onLayout event, and
			// react-native-screens' native-stack view gates its content behind
			// SafeAreaProvider's measured frame — without `initialMetrics` the
			// whole Stack.Navigator subtree renders as `children: null` forever.
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

function assertOnlyMarkerRendered(tr: renderer.ReactTestRenderer, expectedTestID: string) {
	expect(() => tr.root.findByProps({ testID: expectedTestID })).not.toThrow();
	for (const testID of ALL_MARKER_TESTIDS) {
		if (testID === expectedTestID) continue;
		expect(() => tr.root.findByProps({ testID })).toThrow();
	}
}

beforeEach(() => {
	mockRegistrantsListParams = "unset";
	mockRegistrantDetailParams = "unset";
	mockAttestationProvisioningStatusParams = "unset";
	mockPollingDevicesParams = "unset";
	mockAuthorityPeersParams = "unset";
});

describe("RootNavigator — the five Phase 47 routes are really registered and really resolve (47-21, D-07/D-08/D-09)", () => {
	it("RegistrantsList — authority-wide roster (no electionFilter)", async () => {
		const params = { authorityId: "authority-1" };
		const tr = await renderRootNavigatorAt({
			index: 0,
			routes: [{ name: "RegistrantsList", params }],
		});
		assertOnlyMarkerRendered(tr, "mock-registrants-list-screen");
		expect(mockRegistrantsListParams).toEqual(params);
	});

	// D-07: the SAME RegistrantsList route, with electionFilter pre-applied —
	// this is the election roster (no second screen, no second route).
	it("RegistrantsList — election roster (electionFilter pre-applied, D-07)", async () => {
		const params = {
			authorityId: "authority-1",
			electionFilter: { electionId: "election-1", electionTitle: "Test Election" },
		};
		const tr = await renderRootNavigatorAt({
			index: 0,
			routes: [{ name: "RegistrantsList", params }],
		});
		assertOnlyMarkerRendered(tr, "mock-registrants-list-screen");
		expect(mockRegistrantsListParams).toEqual(params);
	});

	it("RegistrantDetail", async () => {
		const params = { registrantId: "registrant-1", authorityId: "authority-1" };
		const tr = await renderRootNavigatorAt({
			index: 0,
			routes: [{ name: "RegistrantDetail", params }],
		});
		assertOnlyMarkerRendered(tr, "mock-registrant-detail-screen");
		expect(mockRegistrantDetailParams).toEqual(params);
	});

	it("AttestationProvisioningStatus — no params (typed undefined)", async () => {
		const tr = await renderRootNavigatorAt({
			index: 0,
			routes: [{ name: "AttestationProvisioningStatus" }],
		});
		assertOnlyMarkerRendered(tr, "mock-attestation-provisioning-status-screen");
		expect(mockAttestationProvisioningStatusParams).toBeUndefined();
	});

	it("PollingDevices", async () => {
		const params = { authorityId: "authority-1" };
		const tr = await renderRootNavigatorAt({
			index: 0,
			routes: [{ name: "PollingDevices", params }],
		});
		assertOnlyMarkerRendered(tr, "mock-polling-devices-screen");
		expect(mockPollingDevicesParams).toEqual(params);
	});

	it("AuthorityPeers", async () => {
		const params = { authorityId: "authority-1" };
		const tr = await renderRootNavigatorAt({
			index: 0,
			routes: [{ name: "AuthorityPeers", params }],
		});
		assertOnlyMarkerRendered(tr, "mock-authority-peers-screen");
		expect(mockAuthorityPeersParams).toEqual(params);
	});

	it("push-through: RegistrantsList -> RegistrantDetail is a real pushable stack, not merely a declared route", async () => {
		const listParams = { authorityId: "authority-1" };
		const detailParams = { registrantId: "registrant-1", authorityId: "authority-1" };
		const tr = await renderRootNavigatorAt({
			index: 1,
			routes: [
				{ name: "RegistrantsList", params: listParams },
				{ name: "RegistrantDetail", params: detailParams },
			],
		});
		// The detail marker is on top...
		expect(() => tr.root.findByProps({ testID: "mock-registrant-detail-screen" })).not.toThrow();
		expect(mockRegistrantDetailParams).toEqual(detailParams);
		// ...and the list marker is still mounted beneath it (native-stack keeps
		// prior screens mounted, not unmounted, under the pushed screen).
		expect(() => tr.root.findByProps({ testID: "mock-registrants-list-screen" })).not.toThrow();
		expect(mockRegistrantsListParams).toEqual(listParams);
	});
});

// ---------------------------------------------------------------------------
// Source-level gates. native-stack renders its header outside the asserted
// subtree under react-test-renderer, so the honest available proof that a
// Stack.Screen registration binds the right title key is a source
// assertion, not a render assertion — a wrong or missing key is exactly
// what this catches.
// ---------------------------------------------------------------------------

const NAV_INDEX_PATH = path.join(__dirname, "..", "index.tsx");
const NAV_TYPES_PATH = path.join(__dirname, "..", "types.ts");
const REGISTRANTS_LIST_SCREEN_PATH = path.join(
	__dirname,
	"..",
	"..",
	"screens",
	"registration",
	"RegistrantsListScreen.tsx",
);
const REGISTRANT_DETAIL_SCREEN_PATH = path.join(
	__dirname,
	"..",
	"..",
	"screens",
	"registration",
	"RegistrantDetailScreen.tsx",
);

/** Extracts the substring from `name="<Route>"` to the next `/>` in navigation/index.tsx. */
function extractRegistration(source: string, routeName: string): string {
	const marker = `name="${routeName}"`;
	const start = source.indexOf(marker);
	expect(start).toBeGreaterThanOrEqual(0);
	const end = source.indexOf("/>", start);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end + 2);
}

describe("navigation/index.tsx — title-binding source gates (47-21)", () => {
	const source = fs.readFileSync(NAV_INDEX_PATH, "utf8");

	const table: Array<{ route: string; component: string; titleKey: string }> = [
		{ route: "RegistrantsList", component: "RegistrantsListScreen", titleKey: "registrantListScreenTitle" },
		{ route: "RegistrantDetail", component: "RegistrantDetailScreen", titleKey: "registrantDetailScreenTitle" },
		{
			route: "AttestationProvisioningStatus",
			component: "AttestationProvisioningStatusScreen",
			titleKey: "attestationProvisioningScreenTitle",
		},
		{ route: "PollingDevices", component: "PollingDevicesScreen", titleKey: "pollingDeviceScreenTitle" },
		{ route: "AuthorityPeers", component: "AuthorityPeersScreen", titleKey: "authorityPeerScreenTitle" },
	];

	it.each(table)("$route binds component $component and title key $titleKey", ({ route, component, titleKey }) => {
		const registration = extractRegistration(source, route);
		expect(registration).toContain(component);
		expect(registration).toContain(`t("${titleKey}")`);
	});

	// 47-18's explicit request: no duplicate header chip on AuthorityPeers —
	// its in-body add chip is what makes the D-13 'cap' gate provable under
	// react-test-renderer.
	it("AuthorityPeers registration carries no headerRight", () => {
		const registration = extractRegistration(source, "AuthorityPeers");
		expect(registration).not.toContain("headerRight");
	});
});

// Built from concatenated fragments, not a literal, so this test file itself
// never contains the retired widening's type name — a repo-wide grep for
// that name (this suite's own <verify> gate) must find zero occurrences,
// including in this file.
const RETIRED_WIDENING_TYPE_NAME = ["Pending", "Route", "Navigation"].join("");

describe("Widening-retirement gate (47-21) — a test, not just a shell gate", () => {
	it("RegistrantsListScreen.tsx contains no retired-widening type name and no `as unknown as`", () => {
		const source = fs.readFileSync(REGISTRANTS_LIST_SCREEN_PATH, "utf8");
		expect(source).not.toContain(RETIRED_WIDENING_TYPE_NAME);
		expect(source).not.toContain("as unknown as");
	});

	it(
		"RegistrantDetailScreen.tsx contains no retired-widening type name and no `as unknown as` — " +
			"a route widening left in place after the route lands compiles, works, and silently " +
			"disables route-name checking on that navigate call forever",
		() => {
			const source = fs.readFileSync(REGISTRANT_DETAIL_SCREEN_PATH, "utf8");
			expect(source).not.toContain(RETIRED_WIDENING_TYPE_NAME);
			expect(source).not.toContain("as unknown as");
		},
	);
});

describe("navigation/types.ts — param-hygiene source gate (T-47-21-01)", () => {
	it("the five new route entries carry only the allow-listed identifiers, per T-47-21-01's crash-payload reasoning", () => {
		const source = fs.readFileSync(NAV_TYPES_PATH, "utf8");
		const start = source.indexOf("RegistrantsList:");
		expect(start).toBeGreaterThanOrEqual(0);
		const end = source.indexOf("EditBallot:", start);
		expect(end).toBeGreaterThan(start);
		const block = source.slice(start, end);

		// Every identifier that appears as a `propertyName:` inside the block,
		// EXCLUDING the five route names themselves (RegistrantsList:,
		// RegistrantDetail:, etc. are route keys, not params).
		const routeNames = new Set([
			"RegistrantsList",
			"RegistrantDetail",
			"AttestationProvisioningStatus",
			"PollingDevices",
			"AuthorityPeers",
		]);
		const propertyMatches = Array.from(block.matchAll(/(\w+)\??:/g))
			.map((m) => m[1])
			.filter((name) => !routeNames.has(name));
		const uniqueProperties = new Set(propertyMatches);

		const allowList = new Set(["authorityId", "electionFilter", "electionId", "electionTitle", "registrantId"]);

		expect(uniqueProperties).toEqual(allowList);

		// Belt-and-suspenders substring gate.
		for (const forbidden of ["district", "ssn", "private", "Engine", "lastName", "firstName"]) {
			expect(block).not.toContain(forbidden);
		}
	});
});
