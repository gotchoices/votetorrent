/**
 * phase48Routes.test.tsx — the real-navigator registration proof for
 * 48-21's three Phase 48 routes (D-12).
 *
 * This is exactly the gap Phase 46's `ed5cde8` closed for the single D-01
 * route, and 47-21 closed for its five: "a rename or removal of a route
 * name, a registration, or an entry card severs the only user path into an
 * entire phase's UI with nothing going red." Mirrored wholesale from
 * `phase47Routes.test.tsx`.
 *
 * Renders the REAL `RootNavigator` (src/navigation/index.tsx) inside a REAL
 * `NavigationContainer` + `SafeAreaProvider`. Only the three DESTINATION
 * screen modules are replaced with marker components — the three
 * `Stack.Screen` registrations, their route-name strings and their title
 * bindings are all the untouched production code from navigation/index.tsx.
 * `navigation/index.tsx` is never mocked.
 */

import React from "react";
import renderer from "react-test-renderer";
import fs from "fs";
import path from "path";

// Rendering the REAL RootNavigator eagerly loads every screen module in the
// app, so the FIRST test in this file pays the whole module-graph cost. A
// 2026-08-05 validation run observed this file's Phase 47 sibling flipping
// RED-then-GREEN under full-suite load and fixed it by raising the timeout
// rather than shortening the render, because the render breadth *is* the
// proof. Do not rediscover this.
//
// 2026-08-29 re-measurement (Phase 51 Nyquist audit): 30_000 was still
// insufficient — a `yarn jest --clearCache && yarn jest` full run clocked
// this file at 35.506s (cold), while solo cold (no other worker contention)
// it took 23.267s. Root cause is parallel-worker CPU contention across ~98
// suites cold-transforming Babel simultaneously, not a hang — isolated cold
// time is stable. Raised again, with headroom above the observed worst case.
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
// none of the three destination markers calls useApp() or useCadreNode(), so
// this cannot mask anything this test is meant to prove.
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
let mockRegistrationInboxParams: any = "unset";
let mockRegistrationRequestApprovalParams: any = "unset";
let mockBulkImportSyncParams: any = "unset";

// Replaces ONLY the destination screen modules. navigation/index.tsx's
// imports of these same absolute files are left completely untouched — each
// is simply fed a marker stub instead of the real screen, so the real
// Stack.Screen registrations are exercised verbatim and only the
// destinations are swapped. Proves ROUTING; each screen's own suite proves
// its behavior. Each factory is inlined (not a shared helper) because
// babel-plugin-jest-hoist forbids a jest.mock() factory from closing over an
// out-of-scope, non-`mock`-prefixed binding.
jest.mock("../../screens/registration/RegistrationInboxScreen", () => ({
	__esModule: true,
	default: function MockRegistrationInboxScreen() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { useRoute } = require("@react-navigation/native");
		mockRegistrationInboxParams = (useRoute() as any).params;
		return ReactLib.createElement(Text, { testID: "mock-registration-inbox-screen" }, "mock-registration-inbox-screen");
	},
}));
jest.mock("../../screens/registration/RegistrationRequestApprovalScreen", () => ({
	__esModule: true,
	default: function MockRegistrationRequestApprovalScreen() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { useRoute } = require("@react-navigation/native");
		mockRegistrationRequestApprovalParams = (useRoute() as any).params;
		return ReactLib.createElement(
			Text,
			{ testID: "mock-registration-request-approval-screen" },
			"mock-registration-request-approval-screen",
		);
	},
}));
// BulkImportSyncScreen (48-20) is a NAMED export, not a default export —
// navigation/index.tsx imports it accordingly, so the marker factory must
// export the same named binding, not `default`.
jest.mock("../../screens/registration/BulkImportSyncScreen", () => ({
	__esModule: true,
	BulkImportSyncScreen: function MockBulkImportSyncScreen() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { useRoute } = require("@react-navigation/native");
		mockBulkImportSyncParams = (useRoute() as any).params;
		return ReactLib.createElement(Text, { testID: "mock-bulk-import-sync-screen" }, "mock-bulk-import-sync-screen");
	},
}));

const ALL_MARKER_TESTIDS = [
	"mock-registration-inbox-screen",
	"mock-registration-request-approval-screen",
	"mock-bulk-import-sync-screen",
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
	mockRegistrationInboxParams = "unset";
	mockRegistrationRequestApprovalParams = "unset";
	mockBulkImportSyncParams = "unset";
});

describe("RootNavigator — the three Phase 48 routes are really registered and really resolve (48-21, D-12)", () => {
	it("RegistrationInbox", async () => {
		const params = { authorityId: "authority-1" };
		const tr = await renderRootNavigatorAt({
			index: 0,
			routes: [{ name: "RegistrationInbox", params }],
		});
		assertOnlyMarkerRendered(tr, "mock-registration-inbox-screen");
		expect(mockRegistrationInboxParams).toEqual(params);
	});

	// The params-echo proves the approval screen receives its request
	// identifier through the route rather than through an ambient handle.
	it("RegistrationRequestApproval", async () => {
		const params = { requestId: "request-1", authorityId: "authority-1" };
		const tr = await renderRootNavigatorAt({
			index: 0,
			routes: [{ name: "RegistrationRequestApproval", params }],
		});
		assertOnlyMarkerRendered(tr, "mock-registration-request-approval-screen");
		expect(mockRegistrationRequestApprovalParams).toEqual(params);
	});

	it("BulkImportSync", async () => {
		const params = { authorityId: "authority-1" };
		const tr = await renderRootNavigatorAt({
			index: 0,
			routes: [{ name: "BulkImportSync", params }],
		});
		assertOnlyMarkerRendered(tr, "mock-bulk-import-sync-screen");
		expect(mockBulkImportSyncParams).toEqual(params);
	});

	it(
		"push-through: RegistrationInbox -> RegistrationRequestApproval is a real pushable stack, " +
			"not merely a declared route",
		async () => {
			const inboxParams = { authorityId: "authority-1" };
			const approvalParams = { requestId: "request-1", authorityId: "authority-1" };
			const tr = await renderRootNavigatorAt({
				index: 1,
				routes: [
					{ name: "RegistrationInbox", params: inboxParams },
					{ name: "RegistrationRequestApproval", params: approvalParams },
				],
			});
			// The approval marker is on top...
			expect(() => tr.root.findByProps({ testID: "mock-registration-request-approval-screen" })).not.toThrow();
			expect(mockRegistrationRequestApprovalParams).toEqual(approvalParams);
			// ...and the inbox marker is still mounted beneath it (native-stack
			// keeps prior screens mounted, not unmounted, under the pushed screen).
			expect(() => tr.root.findByProps({ testID: "mock-registration-inbox-screen" })).not.toThrow();
			expect(mockRegistrationInboxParams).toEqual(inboxParams);
		},
	);
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
const AUTHORITY_DETAILS_SCREEN_PATH = path.join(
	__dirname,
	"..",
	"..",
	"screens",
	"authorities",
	"AuthorityDetailsScreen.tsx",
);
const REGISTRATION_INBOX_SCREEN_PATH = path.join(
	__dirname,
	"..",
	"..",
	"screens",
	"registration",
	"RegistrationInboxScreen.tsx",
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

describe("navigation/index.tsx — title-binding source gates (48-21)", () => {
	const source = fs.readFileSync(NAV_INDEX_PATH, "utf8");

	const table: Array<{ route: string; component: string; titleKey: string }> = [
		{
			route: "RegistrationInbox",
			component: "RegistrationInboxScreen",
			titleKey: "registrationRequestScreenTitle",
		},
		{
			route: "RegistrationRequestApproval",
			component: "RegistrationRequestApprovalScreen",
			titleKey: "registrationRequestApprovalScreenTitle",
		},
		{ route: "BulkImportSync", component: "BulkImportSyncScreen", titleKey: "bulkImportSyncScreenTitle" },
	];

	it.each(table)("$route binds component $component and title key $titleKey", ({ route, component, titleKey }) => {
		const registration = extractRegistration(source, route);
		expect(registration).toContain(component);
		expect(registration).toContain(`t("${titleKey}")`);
	});

	// The modal + CloseButton shape is reserved for a different screen family,
	// and a duplicate header chip is exactly what 47-18 removed from
	// AuthorityPeers — RegistrationInbox already sets its own Bulk Import /
	// Sync chip via setOptions (48-18).
	it.each(table)("$route registration carries none of presentation/CloseButton/headerLeft/headerRight", ({ route }) => {
		const registration = extractRegistration(source, route);
		expect(registration).not.toContain("presentation");
		expect(registration).not.toContain("CloseButton");
		expect(registration).not.toContain("headerLeft");
		expect(registration).not.toContain("headerRight");
	});
});

describe("i18n/index.ts — title-key binding gate (48-21)", () => {
	it("each of the three title keys appears at least twice (EN and ES) — a missing key does not throw at runtime", () => {
		const i18n = fs.readFileSync(path.join(__dirname, "..", "..", "i18n", "index.ts"), "utf8");
		for (const key of [
			"registrationRequestScreenTitle",
			"registrationRequestApprovalScreenTitle",
			"bulkImportSyncScreenTitle",
		]) {
			const count = (i18n.match(new RegExp(`\\b${key}:`, "g")) || []).length;
			expect(count).toBeGreaterThanOrEqual(2);
		}
	});
});

// Built from concatenated fragments, not a literal, so this test file itself
// never contains the retired widening's marker — a repo-wide grep for it
// (this suite's own <verify> gate) must find zero occurrences, including in
// this file.
const RETIRED_WIDENING_MARKER = ["48-21", "REMOVES THIS", "WIDENING"].join(" ");

describe("Widening-retirement gate (48-21) — a test, not just a shell gate", () => {
	it(
		"RegistrationInboxScreen.tsx contains no retired-widening marker, no `as unknown as` and no " +
			"`InboxNavigation` alias, and DOES contain NativeStackNavigationProp<RootStackParamList> — " +
			"a route widening left in place after the route lands compiles, works, and silently disables " +
			"route-name checking on that navigate call forever",
		() => {
			const source = fs.readFileSync(REGISTRATION_INBOX_SCREEN_PATH, "utf8");
			expect(source).not.toContain(RETIRED_WIDENING_MARKER);
			expect(source).not.toContain("as unknown as");
			expect(source).not.toContain("InboxNavigation");
			expect(source).toContain("NativeStackNavigationProp<RootStackParamList>");
		},
	);
});

describe("navigation/types.ts — param-hygiene source gate (T-48-21-01)", () => {
	it("the three new route entries carry only the allow-listed identifiers, per T-48-21-01's crash-payload reasoning", () => {
		const source = fs.readFileSync(NAV_TYPES_PATH, "utf8");
		const start = source.indexOf("RegistrationInbox:");
		expect(start).toBeGreaterThanOrEqual(0);
		const end = source.indexOf("RegistrantsList:", start);
		expect(end).toBeGreaterThan(start);
		const rawBlock = source.slice(start, end);
		// Strip block and line comments from the slice before analysing it —
		// the slice's own explanatory comment would otherwise inject spurious
		// `word:` property matches and deny-listed substrings.
		const block = rawBlock.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

		// Every identifier that appears as a `propertyName:` inside the block,
		// EXCLUDING the three route names themselves (RegistrationInbox:,
		// RegistrationRequestApproval:, BulkImportSync: are route keys, not
		// params).
		const routeNames = new Set(["RegistrationInbox", "RegistrationRequestApproval", "BulkImportSync"]);
		const propertyMatches = Array.from(block.matchAll(/(\w+)\??:/g))
			.map((m) => m[1])
			.filter((name) => !routeNames.has(name));
		const uniqueProperties = new Set(propertyMatches);

		const allowList = new Set(["authorityId", "requestId"]);

		expect(uniqueProperties).toEqual(allowList);

		// Belt-and-suspenders substring deny-list. React Navigation serializes
		// params into navigation state and that state surfaces in crash and
		// debug payloads.
		for (const forbidden of ["district", "ssn", "private", "Engine", "lastName", "firstName", "payload", "name"]) {
			expect(block).not.toContain(forbidden);
		}
	});
});

describe("AuthorityDetailsScreen.tsx — entry-point source gate (48-21)", () => {
	it("contains the Registration Requests entry row, its testID, and its RegistrationInbox navigate target", () => {
		const source = fs.readFileSync(AUTHORITY_DETAILS_SCREEN_PATH, "utf8");
		expect(source).toContain("authority-details-registration-requests-entry");
		expect(source).toContain('"RegistrationInbox"');
		expect(source).toContain('t("registrationRequestScreenTitle")');
	});
});
