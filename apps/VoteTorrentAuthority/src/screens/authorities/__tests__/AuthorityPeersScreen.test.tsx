/**
 * AuthorityPeersScreen.test.tsx — Phase 47 plan 47-18 (D-08/D-13) screen
 * integration suite.
 *
 * PATTERN SOURCE: `BallotConfirmation.test.tsx` (the MANDATORY pattern — a
 * REAL `MockAuthorityConfigEngine` instance driven through a relative
 * `dist/` require, not `jest.fn()` stubs) and
 * `PollingDevicesScreen.test.tsx` / `RegistrationPolicyScreen.test.tsx` (the
 * closest screen-shape analogs: the `mock`-prefixed module-level mutable
 * slots, the interpolation-ECHOING `react-i18next` `t`, the sentinel colour
 * palette, the device-user/device-signer mocks, the `mockGetEngine`
 * dispatcher, and the six-level `dist/` require). `react-test-renderer`
 * only — neither RTL-native nor a hooks testing library is a dependency of
 * this app.
 *
 * ============================================================================
 * DECLARED BLIND SPOT — read before trusting a single green test in this file.
 * ============================================================================
 * `MockAuthorityConfigEngine.addAuthorityPeer` (mock-authority-config-engine.ts:14-24)
 * is a guarded `Array.push`: re-adding an existing `peerId` silently no-ops.
 * The real `AuthorityConfigEngine.addAuthorityPeer` (authority-config-engine.ts:42-69)
 * is a plain `insert into AuthorityPeer` against `primary key (AuthorityId, PeerId)`
 * — a duplicate THROWS there. Likewise `MockAuthorityConfigEngine.removeAuthorityPeer`
 * is an `Array.filter` that never throws on a missing row, while the real
 * engine issues a `delete … where` whose `DeleteValid` CHECK must find a
 * matching `'cap'` `AdminSignature`. THIS SUITE THEREFORE PROVES CALL
 * SEQUENCING AND GATING ONLY, NOT THAT THE REAL ENGINE ACCEPTS THE SEQUENCE.
 * Real-engine proof for the `'cap'` ceremony is routed to 47-23's on-device
 * walkthrough.
 * ============================================================================
 */

import React from "react";
import renderer from "react-test-renderer";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import type { AuthorityPeer } from "@votetorrent/vote-core";

// ---------------------------------------------------------------------------
// Mutable module-level slots (prefixed `mock` so babel-plugin-jest-hoist
// allows the jest.mock() factories below to close over them).
// ---------------------------------------------------------------------------
interface TestOfficer {
	userId: string;
	authorityId: string;
	title: string;
	scopes: string[];
}
let mockOfficers: TestOfficer[] = [];

const mockGetAdminDetails = jest.fn(async () => ({ admin: { officers: mockOfficers } }));

const mockNetworkEngine = {
	openAuthority: jest.fn(async () => ({ getAdminDetails: mockGetAdminDetails })),
};

// The live authorityConfig engine instance this suite drives — reassigned in
// beforeEach to a fresh MockAuthorityConfigEngine (its Maps are instance
// state, so reusing one leaks rows across tests).
let mockAuthorityConfigEngine: any;

// The getEngine dispatcher: serves the current authorityConfig engine for
// "authorityConfig" and the network-engine fixture (officer lookup chain)
// for "network" — everything else resolves null.
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "authorityConfig") return mockAuthorityConfigEngine;
	if (name === "network") return mockNetworkEngine;
	return null;
});

// ---------------------------------------------------------------------------
// Module mocks (module scope, before any screen import).
// ---------------------------------------------------------------------------

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));

// react-i18next mock — an interpolation-ECHOING `t()`, load-bearing for the
// D-13 scope-naming test: it returns the bare key with no options, and
// `key + "|" + String(options.scope)` when an options object carries a
// `scope` field, so a test can prove `scopeDescriptions.cap` was actually
// bound rather than merely that some key rendered.
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { scope?: string }) =>
			options && "scope" in options ? key + "|" + String(options.scope) : key,
	}),
}));

jest.mock("@react-navigation/native", () => ({
	// Distinct sentinel values for every color token so a color assertion can
	// never pass by accidental equality between two tokens.
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
			dark: "sentinel-dark",
			light: "sentinel-light",
		},
	}),
	useRoute: () => ({ params: { authorityId: "auth-1" } }),
	// 49-12: AuthorityPeersScreen now imports useDeviceSigningErrorHandler,
	// which resolves useNavigation() internally — the prior mock had no
	// consumer of it (this screen navigates nowhere of its own).
	useNavigation: () => ({ navigate: jest.fn() }),
}));

jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({ id: "device-user-1", name: "Device User" })),
}));

jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => async () => ({
		signature: "mock-sig",
		signerKey: "mock-key",
		signerUserId: "device-user-1",
	})),
}));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

// ---------------------------------------------------------------------------
// The REAL mock engine. Six levels up, matching BallotConfirmation.test.tsx's
// depth. NOT `@votetorrent/vote-engine` — the package's `exports` field
// blocks this subpath; the physical `dist/` file is required directly.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
	MockAuthorityConfigEngine,
} = require("../../../../../../packages/vote-engine/dist/authority-config/mock-authority-config-engine");

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** A stable, reusable sign callback for directly-seeded engine state (bypasses createDeviceSigner). */
const SEED_SIGN = async () => ({
	signature: "seed-sig",
	signerKey: "seed-key",
	signerUserId: "seed-user",
});

async function seedPeers(peerIds: string[]): Promise<void> {
	for (const peerId of peerIds) {
		await mockAuthorityConfigEngine.addAuthorityPeer("auth-1", peerId, SEED_SIGN);
	}
	// Seeding must not contaminate call counts the tests assert on.
	addSpy.mockClear();
	removeSpy.mockClear();
}

async function flushTicks(count: number): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < count; i++) {
			await Promise.resolve();
		}
	});
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const AuthorityPeersScreenModule = require("../AuthorityPeersScreen");
	const AuthorityPeersScreen =
		AuthorityPeersScreenModule.default ?? AuthorityPeersScreenModule.AuthorityPeersScreen;

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<AuthorityPeersScreen />);
	});
	// Flush AT LEAST six ticks: engine acquisition -> getAuthorityPeers, PLUS
	// useCurrentOfficerScopes' own device-user -> network engine ->
	// openAuthority -> getAdminDetails walk (RegistrationPolicyScreen.test.tsx
	// / PollingDevicesScreen.test.tsx precedent).
	await flushTicks(6);
	return tr;
}

/**
 * Fires the real handler on a write control reachable under `testID`.
 * ChipButton binds `onPressIn`, CustomButton binds `onPress` — both are
 * probed. Asserting a non-empty candidate list BEFORE firing turns a
 * renamed/restructured control into a loud failure instead of a silent
 * vacuous pass.
 */
async function press(tr: renderer.ReactTestRenderer, testID: string): Promise<void> {
	const wrapper = tr.root.findByProps({ testID });
	const candidates = wrapper.findAll(
		(node) => typeof node.props.onPressIn === "function" || typeof node.props.onPress === "function"
	);
	expect(candidates.length).toBeGreaterThan(0);
	const target = candidates[0]!;
	await renderer.act(async () => {
		if (typeof target.props.onPressIn === "function") {
			target.props.onPressIn();
		} else {
			await target.props.onPress();
		}
	});
	await flushTicks(4);
}

/**
 * The D-13 read-only variant of `press` — used ONLY where an EMPTY candidate
 * list is the correct outcome (a gated control's `onPress`/`onPressIn` is
 * `undefined`, not a no-op). `findByProps` itself is the "control still
 * present" assertion.
 */
function attemptPress(tr: renderer.ReactTestRenderer, testID: string): void {
	const wrapper = tr.root.findByProps({ testID });
	const candidates = wrapper.findAll(
		(node) => typeof node.props.onPressIn === "function" || typeof node.props.onPress === "function"
	);
	candidates.forEach((c) => {
		if (typeof c.props.onPressIn === "function") c.props.onPressIn();
		else if (typeof c.props.onPress === "function") c.props.onPress();
	});
}

function present(tr: renderer.ReactTestRenderer, testID: string): void {
	expect(() => tr.root.findByProps({ testID })).not.toThrow();
}

function absent(tr: renderer.ReactTestRenderer, testID: string): void {
	expect(() => tr.root.findByProps({ testID })).toThrow();
}

/**
 * Reads the whole rendered tree as a plain-data JSON string, for
 * `.toContain()` text assertions (banner copy, error strings). Built off
 * `tr.toJSON()` — NOT `tr.root.findByProps(...)` — because a `TestInstance`
 * carries a `parent` back-reference into the live fiber tree, and
 * stringifying it throws "Converting circular structure to JSON". `toJSON()`
 * is plain data (type/props/children only, no back-refs), so this is the
 * safe subtree-scoping primitive (RegistrationPolicyScreen.test.tsx /
 * PollingDevicesScreen.test.tsx precedent).
 */
function treeText(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let addSpy: jest.SpyInstance;
let removeSpy: jest.SpyInstance;

beforeEach(() => {
	jest.clearAllMocks();
	mockAuthorityConfigEngine = new MockAuthorityConfigEngine();
	// Preserve real behaviour, count calls — never replace with jest.fn().
	addSpy = jest.spyOn(mockAuthorityConfigEngine, "addAuthorityPeer");
	removeSpy = jest.spyOn(mockAuthorityConfigEngine, "removeAuthorityPeer");
	mockOfficers = [
		{ userId: "device-user-1", authorityId: "auth-1", title: "Chair", scopes: ["cap"] },
	];
	// Do NOT call jest.resetModules() — it would break the cached top-level
	// require for MockAuthorityConfigEngine and the mock-factory closures.
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuthorityPeersScreen — D-08 / D-13 ('cap' scope)", () => {
	test("1. pure helper truncatePeerId — mutation lock on the slice(0,5)+'...' convention", () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { truncatePeerId } = require("../AuthorityPeersScreen");
		expect(truncatePeerId("12345678")).toBe("12345678"); // length 8, unchanged
		expect(truncatePeerId("123456789")).toBe("12345...");
		expect(truncatePeerId("")).toBe("");
	});

	test("2. pure helper isDuplicatePeerId — exact match, trim only, NOT case-folded", () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { isDuplicatePeerId } = require("../AuthorityPeersScreen");
		const peers: AuthorityPeer[] = [{ authorityId: "auth-1", peerId: "QmAbC" }];
		expect(isDuplicatePeerId(peers, "QmAbC")).toBe(true);
		expect(isDuplicatePeerId(peers, "  QmAbC  ")).toBe(true);
		// Mutation lock on the "no case-folding" rule — a toLowerCase added to
		// either side of isDuplicatePeerId would flip this to true.
		expect(isDuplicatePeerId(peers, "qmabc")).toBe(false);
	});

	test("3. 'cap' officer sees a writable screen", async () => {
		await seedPeers(["peer-alpha", "peer-beta"]);
		const tr = await renderScreen();

		absent(tr, "authority-peers-readonly-banner");
		absent(tr, "authority-peers-readonly-no-officer-banner");
		present(tr, "authority-peers-row-peer-alpha");
		present(tr, "authority-peers-row-peer-beta");
		present(tr, "authority-peers-add-toggle");
	});

	test("4. SCOPE-CONFLATION PROOF — a 'vrg'-only officer is read-only here", async () => {
		// This is the plan's reason for existing: 'vrg' is the scope every other
		// Phase 47 authorities/registration screen uses, so a copy-paste from
		// 47-17 lands here as a silently-widened cluster-membership gate. This
		// test proves the gate stayed at 'cap'.
		mockOfficers = [
			{ userId: "device-user-1", authorityId: "auth-1", title: "Chair", scopes: ["vrg"] },
		];
		await seedPeers(["peer-alpha"]);
		const tr = await renderScreen();

		present(tr, "authority-peers-readonly-banner");
		absent(tr, "authority-peers-readonly-no-officer-banner");
		// The interpolation-echoing `t` makes this prove scopeDescriptions.cap
		// was actually bound, not merely that some key rendered.
		expect(treeText(tr)).toContain("authorityPeerScopeReadOnlyBanner|Configure Authority Peers");
		// NEGATIVE assertions: the registrant-scope banner copy and the 'vrg'
		// scope description must NOT appear anywhere in this tree.
		expect(treeText(tr)).not.toContain("registrantScopeReadOnlyBanner");
		expect(treeText(tr)).not.toContain("Validate registrations");

		// Visible-but-disabled (D-13 default), not hidden.
		present(tr, "authority-peers-row-peer-alpha");
		present(tr, "authority-peers-add-toggle");

		attemptPress(tr, "authority-peers-add-toggle");
		attemptPress(tr, "authority-peers-remove-peer-alpha");
		await flushTicks(2);

		expect(addSpy).toHaveBeenCalledTimes(0);
		expect(removeSpy).toHaveBeenCalledTimes(0);
		absent(tr, "authority-peers-confirm-peer-alpha-card");
	});

	test("5. not-an-officer gets the other banner", async () => {
		mockOfficers = [];
		const tr = await renderScreen();

		present(tr, "authority-peers-readonly-no-officer-banner");
		absent(tr, "authority-peers-readonly-banner");
		expect(treeText(tr)).not.toContain("Configure Authority Peers");
	});

	test("6. empty state", async () => {
		const tr = await renderScreen();

		present(tr, "authority-peers-empty");
		absent(tr, "authority-peers-row-peer-alpha");
		absent(tr, "authority-peers-loading");
	});

	test("7. add: happy path", async () => {
		const tr = await renderScreen();

		await press(tr, "authority-peers-add-toggle");
		present(tr, "authority-peers-add-form");

		const input = tr.root.findByProps({ testID: "authority-peers-add-input" });
		await renderer.act(async () => {
			input.props.onChangeText("peer-alpha");
		});

		await press(tr, "authority-peers-add-submit");

		expect(addSpy).toHaveBeenCalledTimes(1);
		expect(addSpy).toHaveBeenCalledWith("auth-1", "peer-alpha", expect.any(Function));
		absent(tr, "authority-peers-add-form");
		// Proves the post-write loadPeers() re-read, not an optimistic local push.
		present(tr, "authority-peers-row-peer-alpha");
	});

	test("8. add trims, does not case-fold", async () => {
		const tr = await renderScreen();

		await press(tr, "authority-peers-add-toggle");
		const input = tr.root.findByProps({ testID: "authority-peers-add-input" });
		await renderer.act(async () => {
			input.props.onChangeText("  peer-beta  ");
		});
		await press(tr, "authority-peers-add-submit");

		expect(addSpy).toHaveBeenCalledWith("auth-1", "peer-beta", expect.any(Function));
	});

	test("9. DUPLICATE GUARD — a duplicate peerId never reaches the engine", async () => {
		// The real engine would raise a PK violation here while the mock
		// silently no-ops — this guard is the only thing keeping the two in
		// agreement (see the DECLARED BLIND SPOT header comment).
		await seedPeers(["peer-alpha"]);
		const tr = await renderScreen();

		await press(tr, "authority-peers-add-toggle");
		const input = tr.root.findByProps({ testID: "authority-peers-add-input" });
		await renderer.act(async () => {
			input.props.onChangeText("peer-alpha");
		});
		await press(tr, "authority-peers-add-submit");

		expect(addSpy).toHaveBeenCalledTimes(0);
		// The message is a translated key (47-REVIEW IN-06), and it must NOT carry
		// the operator-supplied peer id — the rejected draft stays in the input
		// instead, which the assertion below proves.
		expect(treeText(tr)).toContain("authorityPeerDuplicateError");
		expect(treeText(tr)).not.toContain("Peer already configured");
		expect(tr.root.findByProps({ testID: "authority-peers-add-input" }).props.value).toBe(
			"peer-alpha"
		);
	});

	test("10. remove requires the confirmation card — a single tap never deletes", async () => {
		await seedPeers(["peer-alpha"]);
		const tr = await renderScreen();

		await press(tr, "authority-peers-remove-peer-alpha");

		present(tr, "authority-peers-confirm-peer-alpha-card");
		expect(removeSpy).toHaveBeenCalledTimes(0);
	});

	test("11. dismissed confirmation fires ZERO engine calls", async () => {
		await seedPeers(["peer-alpha"]);
		const tr = await renderScreen();

		await press(tr, "authority-peers-remove-peer-alpha");
		present(tr, "authority-peers-confirm-peer-alpha-card");

		await press(tr, "authority-peers-confirm-peer-alpha-dismiss");

		absent(tr, "authority-peers-confirm-peer-alpha-card");
		expect(removeSpy).toHaveBeenCalledTimes(0);
		present(tr, "authority-peers-row-peer-alpha");
	});

	test("12. confirmed removal deletes exactly once and the row disappears", async () => {
		await seedPeers(["peer-alpha"]);
		const tr = await renderScreen();

		await press(tr, "authority-peers-remove-peer-alpha");
		present(tr, "authority-peers-confirm-peer-alpha-card");

		await press(tr, "authority-peers-confirm-peer-alpha-confirm");

		expect(removeSpy).toHaveBeenCalledTimes(1);
		expect(removeSpy).toHaveBeenCalledWith("auth-1", "peer-alpha", expect.any(Function));
		absent(tr, "authority-peers-confirm-peer-alpha-card");
		absent(tr, "authority-peers-row-peer-alpha");
	});

	test("13. row containment: card slot carries flex:1 + minWidth:0, REMOVE wrapper carries flexShrink:0, row stays flexDirection:row", async () => {
		await seedPeers(["peer-alpha"]);
		const tr = await renderScreen();

		const row = tr.root.findByProps({ testID: "authority-peers-row-peer-alpha" });
		const rowFlat = StyleSheet.flatten(row.props.style) as Record<string, unknown>;
		expect(rowFlat.flexDirection).toBe("row");

		const [cardSlot, removeWrapper] = row.props.children as [
			{ props: { style?: StyleProp<ViewStyle> } },
			{ props: { style?: StyleProp<ViewStyle> } }
		];
		const cardFlat = StyleSheet.flatten(cardSlot.props.style) as Record<string, unknown>;
		expect(cardFlat.flex).toBe(1);
		expect(cardFlat.minWidth).toBe(0);

		const removeFlat = StyleSheet.flatten(removeWrapper.props.style) as Record<string, unknown>;
		expect(removeFlat.flexShrink).toBe(0);
	});
});
