/**
 * AuthorityDetailsScreen.entryPoints.test.tsx — the three authority-owned
 * Phase 47 entry rows (D-08): Registrants, Polling Devices, Authority Peers.
 *
 * Scaffold copied from
 * `../../elections/__tests__/ElectionDetailsScreen.navigation.test.tsx`
 * (Suite A) — real component + a mocked `@react-navigation/native` module,
 * pressing the REAL screen's own onPress handlers (not a restatement of
 * them). The real navigator really resolving these routes is proven
 * separately by `src/navigation/__tests__/phase47Routes.test.tsx` (Task 1);
 * this suite complements that, it does not duplicate it.
 */

import React from "react";
import renderer from "react-test-renderer";
import fs from "fs";
import path from "path";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
// Prefixed `mock` so babel-plugin-jest-hoist allows the jest.mock() factory
// below (hoisted above this declaration) to close over it.
let mockRouteParams: { authority: any } = { authority: null };

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "sentinel-primary",
			background: "sentinel-background",
			card: "sentinel-card",
			text: "sentinel-text",
			border: "sentinel-border",
			notification: "sentinel-notification",
			error: "sentinel-error",
			textSecondary: "sentinel-textSecondary",
			important: "sentinel-important",
			success: "sentinel-success",
			accent: "sentinel-accent",
			warning: "sentinel-warning",
		},
	}),
	useNavigation: () => ({
		navigate: mockNavigate,
		goBack: mockGoBack,
		setOptions: mockSetOptions,
	}),
	useRoute: () => ({ params: mockRouteParams }),
	// Run the callback once on mount (like a first focus); an effect keyed on `cb` would re-run every render.
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			const cleanup = cb();
			return typeof cleanup === "function" ? cleanup : undefined;
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));

const AUTHORITY_FIXTURE = {
	id: "authority-1",
	name: "Test Authority",
	domainName: "test.example.org",
	imageRef: undefined,
};

function makeAdminDetails() {
	return {
		admin: { id: "admin-1", officers: [], effectiveAt: Date.now() },
		proposed: undefined,
	};
}

const mockGetAdminDetails = jest.fn(async () => makeAdminDetails());
// The screen probes `authorityEngine.getInvitedAuthorities` via `typeof fn === "function"` —
// this fixture deliberately omits it, matching the upstream_contract's "may be absent" floor.
const mockAuthorityEngine = { getAdminDetails: mockGetAdminDetails, getPendingInviteCids: jest.fn(async () => []) };
const mockOpenAuthority = jest.fn(async () => mockAuthorityEngine);
const mockGetPinnedAuthorities = jest.fn(async () => []);
const mockPinAuthority = jest.fn(async () => {});
const mockUnpinAuthority = jest.fn(async () => {});
const mockNetworkEngine = {
	openAuthority: mockOpenAuthority,
	getPinnedAuthorities: mockGetPinnedAuthorities,
	pinAuthority: mockPinAuthority,
	unpinAuthority: mockUnpinAuthority,
};
const mockGetEngine = jest.fn(async (name: string) => {
	if (name === "network") return mockNetworkEngine;
	if (name === "invitations") return { getOfficerInvite: jest.fn(async () => undefined) };
	return undefined;
});

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

/** Same helper as Suite A — see ElectionDetailsScreen.navigation.test.tsx for the "why" comment. */
async function press(tr: renderer.ReactTestRenderer, testID: string): Promise<void> {
	const wrapper = tr.root.findByProps({ testID });
	const candidates = wrapper.findAll(
		(node) => typeof node.props.onPressIn === "function" || typeof node.props.onPress === "function",
	);
	expect(candidates.length).toBeGreaterThan(0);
	const target = candidates[0]!;
	await renderer.act(async () => {
		if (typeof target.props.onPressIn === "function") {
			target.props.onPressIn();
		} else {
			target.props.onPress();
		}
	});
	await renderer.act(async () => {
		await Promise.resolve();
	});
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const AuthorityDetailsScreenModule = require("../AuthorityDetailsScreen");
	const AuthorityDetailsScreen = AuthorityDetailsScreenModule.default;

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<AuthorityDetailsScreen />);
	});
	// The screen early-returns null while networkEngine is null (loadEngines'
	// getEngine("network") is async) — flush several ticks to clear the gate
	// and let the follow-on effects (getAuthorityData/getUsers) settle too.
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
	return tr;
}

const REGISTRANTS_TESTID = "authority-details-registrants-entry";
const POLLING_DEVICES_TESTID = "authority-details-polling-devices-entry";
const AUTHORITY_PEERS_TESTID = "authority-details-authority-peers-entry";
const REGISTRATION_REQUESTS_TESTID = "authority-details-registration-requests-entry";

beforeEach(() => {
	jest.clearAllMocks();
	mockRouteParams = { authority: AUTHORITY_FIXTURE };
	mockGetAdminDetails.mockImplementation(async () => makeAdminDetails());
	mockOpenAuthority.mockImplementation(async () => mockAuthorityEngine);
	mockGetPinnedAuthorities.mockImplementation(async () => []);
	mockGetEngine.mockImplementation(async (name: string) => (name === "network" ? mockNetworkEngine : name === "invitations" ? { getOfficerInvite: jest.fn(async () => undefined) } : undefined));
});

describe("AuthorityDetailsScreen — Phase 47 entry rows (D-08)", () => {
	it("all three rows render exactly once", async () => {
		const tr = await renderScreen();
		// findByProps (not findAllByProps) — react-test-renderer's findByProps
		// passes { deep: false }, so it stops at the first matching layer
		// (the composite View), while findAllByProps's default deep:true also
		// matches the underlying host View with the same forwarded testID,
		// double-counting a single rendered row.
		expect(() => tr.root.findByProps({ testID: REGISTRANTS_TESTID })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: POLLING_DEVICES_TESTID })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: AUTHORITY_PEERS_TESTID })).not.toThrow();
	});

	it("pressing Registrants navigates to RegistrantsList with exactly { authorityId }", async () => {
		const tr = await renderScreen();
		await press(tr, REGISTRANTS_TESTID);
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate).toHaveBeenCalledWith("RegistrantsList", { authorityId: AUTHORITY_FIXTURE.id });
	});

	it("pressing Polling Devices navigates to PollingDevices with exactly { authorityId }", async () => {
		const tr = await renderScreen();
		await press(tr, POLLING_DEVICES_TESTID);
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate).toHaveBeenCalledWith("PollingDevices", { authorityId: AUTHORITY_FIXTURE.id });
	});

	it("pressing Authority Peers navigates to AuthorityPeers with exactly { authorityId }", async () => {
		const tr = await renderScreen();
		await press(tr, AUTHORITY_PEERS_TESTID);
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate).toHaveBeenCalledWith("AuthorityPeers", { authorityId: AUTHORITY_FIXTURE.id });
	});

	// D-07 negative: the Registrants row's params carry no electionFilter — this
	// is the authority-wide roster. The election-filtered variant is reached
	// from ElectionDetailsScreen instead (same route, D-07).
	it("D-07: the Registrants row's params contain no electionFilter key", async () => {
		const tr = await renderScreen();
		await press(tr, REGISTRANTS_TESTID);
		const [, params] = mockNavigate.mock.calls[0]!;
		expect("electionFilter" in params).toBe(false);
	});

	// T-47-21-01: React Navigation serializes params into navigation state,
	// which surfaces in crash and debug payloads — identifiers only.
	it("T-47-21-01: no navigate call's params carry a name, district, ssn or engine handle", async () => {
		const tr = await renderScreen();
		await press(tr, REGISTRANTS_TESTID);
		await press(tr, POLLING_DEVICES_TESTID);
		await press(tr, AUTHORITY_PEERS_TESTID);
		for (const call of mockNavigate.mock.calls) {
			const json = JSON.stringify(call[1]);
			expect(json).not.toMatch(/name/i);
			expect(json).not.toContain("district");
			expect(json).not.toContain("ssn");
			expect(json).not.toContain("Engine");
		}
	});

	// T-47-04 / D-13: this asserts a DECISION — the destination screens own the
	// gate — not an enforcement claim. The three rows render with no scope
	// fixture configured at all (this test file mocks no officer-scope hook
	// whatsoever). Built from concatenated fragments so this test file itself
	// never contains the hook's name literally.
	const SCOPE_HOOK_NAME = ["useCurrent", "OfficerScopes"].join("");

	it("T-47-04 / D-13: the screen source contains no officer-scope hook, and the rows render ungated", async () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "AuthorityDetailsScreen.tsx"), "utf8");
		expect(source).not.toContain(SCOPE_HOOK_NAME);

		const tr = await renderScreen();
		expect(() => tr.root.findByProps({ testID: REGISTRANTS_TESTID })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: POLLING_DEVICES_TESTID })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: AUTHORITY_PEERS_TESTID })).not.toThrow();
	});

	// Placement: the new section did not displace the Invited Authorities
	// section that follows it.
	it("the Invited Authorities section still renders after the new entries", async () => {
		const tr = await renderScreen();
		expect(() => tr.root.findByProps({ testID: REGISTRANTS_TESTID })).not.toThrow();
		// invitedAuthorities is rendered as translated text content (identity `t`
		// mock echoes the key), not a testID — assert via the rendered string tree,
		// proving the insertion did not displace this existing section.
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("invitedAuthorities");
	});
});

// -----------------------------------------------------------------------
// 48-21 (D-12) — the Registration Requests entry row. The real RootNavigator
// really resolving this route is proven separately by
// src/navigation/__tests__/phase48Routes.test.tsx; this suite complements
// that with the runtime half of the reachability proof: pressing the row on
// the REAL screen and asserting the exact navigate call it produces.
// -----------------------------------------------------------------------
describe("AuthorityDetailsScreen — Registration Requests entry row (48-21, D-12)", () => {
	it("the row renders exactly once", async () => {
		const tr = await renderScreen();
		// findByProps (not findAllByProps) — see the Phase 47 comment above for
		// why: findAllByProps's default deep:true double-counts the underlying
		// host View carrying the same forwarded testID.
		expect(() => tr.root.findByProps({ testID: REGISTRATION_REQUESTS_TESTID })).not.toThrow();
	});

	it("pressing it navigates to RegistrationInbox with exactly { authorityId }", async () => {
		const tr = await renderScreen();
		await press(tr, REGISTRATION_REQUESTS_TESTID);
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate).toHaveBeenCalledWith("RegistrationInbox", { authorityId: AUTHORITY_FIXTURE.id });
	});

	// T-48-21-01: React Navigation serializes params into navigation state,
	// which surfaces in crash and debug payloads — an exact key-set assertion,
	// not a substring scan, is the one place a future editor's "just pass the
	// authority object too" is caught.
	it("T-48-21-01: the navigate call's params carry exactly the key 'authorityId', nothing else", async () => {
		const tr = await renderScreen();
		await press(tr, REGISTRATION_REQUESTS_TESTID);
		const params = mockNavigate.mock.calls[0]![1];
		expect(Object.keys(params)).toEqual(["authorityId"]);
	});

	// T-47-04 / D-13 precedent, restated for this row's own decision: the row
	// is navigation, not access control. This file mocks no officer-scope hook
	// whatsoever, so the row rendering here at all is itself the ungated proof
	// — the destination screen owns the read-only banner.
	it("the row is ungated — renders with no officer-scope fixture configured, and the screen source contains no scope-hook reference", async () => {
		const SCOPE_HOOK_NAME = ["useCurrent", "OfficerScopes"].join("");
		const source = fs.readFileSync(path.join(__dirname, "..", "AuthorityDetailsScreen.tsx"), "utf8");
		expect(source).not.toContain(SCOPE_HOOK_NAME);

		const tr = await renderScreen();
		expect(() => tr.root.findByProps({ testID: REGISTRATION_REQUESTS_TESTID })).not.toThrow();
	});

	// The new row must not displace any of the three Phase 47 rows sharing its
	// container block.
	it("the three Phase 47 rows still resolve alongside the new row", async () => {
		const tr = await renderScreen();
		expect(() => tr.root.findByProps({ testID: REGISTRANTS_TESTID })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: POLLING_DEVICES_TESTID })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: AUTHORITY_PEERS_TESTID })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: REGISTRATION_REQUESTS_TESTID })).not.toThrow();
	});
});
