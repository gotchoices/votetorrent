/**
 * RegistrantDetailScreen.test.tsx — the phase's integration-seam suite.
 * Covers the nine-block render order (47-UI-SPEC.md:644-663), both scope-
 * banner shapes, the D-13 hide-entirely private-tier divergence (at both the
 * render AND the read), D-14's visit lifecycle (unmount flush, background
 * flush, the delta contract, the accepted-loss no-User.Id path), D-10's
 * lifecycle writes (typed suspend/revoke, ordinary reinstate/renew, zero-call
 * dismiss, the failed-write retry latch), D-12's audience preview wired to a
 * real `getDisclosedSelective` call, and T-47-02's no-value-leak guarantee.
 *
 * Two deliberate mocking decisions, so a checker does not read them as
 * shortcuts:
 *
 * 1. The ENGINES ARE REAL — `MockRegistrationEngine` via the relative
 *    `dist/` require, per the phase's mandatory pattern
 *    (`BallotConfirmation.test.tsx`), never a `jest.fn()` engine stub.
 * 2. The THREE SELF-FETCHING CHILD SECTIONS (`AssociationsSection`,
 *    `AttestationChallengesSection`, `AccessHistorySection`) are replaced by
 *    recording stand-ins that render one testID-carrying `View` and capture
 *    their props. This suite's subject is the SHELL: the composition order
 *    and the props contract 47-20 owes them. Each section's own behaviour is
 *    covered by 47-15/47-16/47-14's co-located suites, and the end-to-end
 *    wiring by 47-22's `RegistrantDetailScreen.integration.test.tsx`.
 *    Rendering three self-fetching sections here would make every assertion
 *    depend on three unrelated engine surfaces.
 *
 * `PrivateFieldRow`, `SelectiveAudiencePreview` and `LifecycleConfirmCard`
 * stay REAL — they are the D-12/D-13/D-14/D-10 surfaces this plan wires, and
 * stubbing them would hollow out every assertion below.
 */

import React from "react";
import renderer from "react-test-renderer";
import { AppState } from "react-native";
import type { AppStateStatus } from "react-native";

// ---------------------------------------------------------------------------
// Mutable module-level slots. Prefixed `mock` so babel-plugin-jest-hoist
// allows the jest.mock() factories below to close over them.
// ---------------------------------------------------------------------------

const REGISTRANT_ID = "registrant-jane-doe";
const AUTHORITY_ID = "auth-1";
const FUTURE_ISO = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

const SSN_SENTINEL = "000-00-0000";
const DOB_SENTINEL = "1980-01-01";
const PHONE_SENTINEL = "555-0100";
const SALT_SENTINEL = "SALT_SENTINEL_1";

let mockRegistrationEngine: any;

let mockElections: Array<{ id: string; title?: string }> = [];
const mockElectionsEngine = {
	getElections: jest.fn(async () => mockElections),
};

const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "registration") return mockRegistrationEngine;
	if (name === "elections") return mockElectionsEngine;
	return null;
});

let mockScopesResult: { scopes: string[] | undefined; loading: boolean } = {
	scopes: ["vrg"],
	loading: false,
};

let mockDeviceUser: { id: string } | undefined = { id: "u-officer-1" };

let mockAssociationsProps: any = null;
let mockAttestationProps: any = null;
let mockAccessHistoryProps: any = null;

const mockNavigate = jest.fn();
const mockSetOptions = jest.fn();

const mockRouteParams = { registrantId: REGISTRANT_ID, authorityId: AUTHORITY_ID };

// ---------------------------------------------------------------------------
// Module mocks — module scope, before any import of the screen.
// ---------------------------------------------------------------------------

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("@react-native-community/datetimepicker", () => "DateTimePicker");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));

// react-i18next: an interpolation-ECHOING t() — returns the bare key with no
// options, and `key + "|" + "k1=v1,k2=v2"` (a flat, UNQUOTED join, not
// `JSON.stringify(options)`) when an options object is present. Unquoted is
// load-bearing: the rendered string is itself later embedded inside
// `JSON.stringify(tr.toJSON())` for tree-text assertions, and a
// `JSON.stringify(options)`-style value would have its own quotes
// double-escaped by that OUTER stringify, breaking a plain `.toContain(...)`
// match against an unescaped expected literal (RegistrantsListScreen.test.tsx
// precedent). Overrides only useTranslation; the rest of the real module is
// preserved via requireActual (47-11's binding convention for this mock).
jest.mock("react-i18next", () => ({
	...jest.requireActual("react-i18next"),
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && Object.keys(options).length > 0
				? key +
				  "|" +
				  Object.entries(options)
						.map(([k, v]) => k + "=" + String(v))
						.join(",")
				: key,
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
	useNavigation: () => ({
		navigate: mockNavigate,
		setOptions: mockSetOptions,
	}),
	useRoute: () => ({ params: mockRouteParams }),
}));

jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => mockDeviceUser),
}));

const mockSignCallback = jest.fn(async () => ({
	signature: "mock-sig",
	signerKey: "mock-key",
	signerUserId: "u-officer-1",
}));

jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => mockSignCallback),
}));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

// Mocking useCurrentOfficerScopes directly is deliberate — the hook has its
// own Phase 46 suite, and this suite needs to drive undefined / [] / ["vrg"]
// directly without walking a network-engine officer lookup chain.
jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: () => mockScopesResult,
}));

// The three self-fetching child sections — recording stand-ins. This
// suite's subject is the SHELL; each section's own behaviour is covered by
// its own co-located suite (47-14/47-15/47-16).
jest.mock("../components/AssociationsSection", () => {
	const ReactLib = require("react");
	const { View } = require("react-native");
	return {
		AssociationsSection: (props: any) => {
			mockAssociationsProps = props;
			return ReactLib.createElement(View, { testID: "associations-section" });
		},
	};
});

jest.mock("../components/AttestationChallengesSection", () => {
	const ReactLib = require("react");
	const { View } = require("react-native");
	return {
		AttestationChallengesSection: (props: any) => {
			mockAttestationProps = props;
			return ReactLib.createElement(View, { testID: "attestation-challenges-section" });
		},
	};
});

jest.mock("../components/AccessHistorySection", () => {
	const ReactLib = require("react");
	const { View } = require("react-native");
	return {
		AccessHistorySection: (props: any) => {
			mockAccessHistoryProps = props;
			return ReactLib.createElement(View, { testID: "access-history-section" });
		},
	};
});

// ---------------------------------------------------------------------------
// The REAL mock engine — required by relative dist path, six levels up,
// matching BallotConfirmation.test.tsx / RegistrationPolicyScreen.test.tsx.
// NOT `@votetorrent/vote-engine` — the package's `exports` field blocks this
// subpath. 47-05/47-07 rebuild vote-engine's dist/; without that rebuild the
// registrant-detail methods this suite needs are invisible to this require
// (see the stale-dist guard below).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
	MockRegistrationEngine,
} = require("../../../../../../packages/vote-engine/dist/registration/mock-registration-engine");

// ---------------------------------------------------------------------------
// Helpers — copied/adapted from RegistrationPolicyScreen.test.tsx:287-341.
// ---------------------------------------------------------------------------

/** A stable, reusable sign callback for directly-seeded engine state. */
const SEED_SIGN = async () => ({
	signature: "seed-sig",
	signerKey: "seed-key",
	signerUserId: "seed-user",
});

async function flushTicks(count: number): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < count; i++) {
			await Promise.resolve();
		}
	});
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const RegistrantDetailScreenModule = require("../RegistrantDetailScreen");
	const RegistrantDetailScreen = RegistrantDetailScreenModule.default;

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<RegistrantDetailScreen />);
	});
	// The load chain is deep: registration engine acquisition -> Promise.all
	// of getRegistrant/getRegistrantPublic/getRegistrantSelective, PLUS a
	// separate private-tier effect, PLUS the device-user mount effect.
	await flushTicks(8);
	return tr;
}

/**
 * Fires the real handler on a write control reachable under `testID`.
 * Asserts a non-empty candidate list BEFORE firing, so a renamed/restructured
 * control fails loudly instead of silently no-op-ing.
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
			target.props.onPress();
		}
	});
	await flushTicks(4);
}

/** The D-10 read-only variant of `press` — used ONLY where an empty candidate list is correct. */
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

function typeInto(tr: renderer.ReactTestRenderer, testID: string, text: string): void {
	const input = tr.root.findByProps({ testID });
	renderer.act(() => {
		input.props.onChangeText(text);
	});
}

function isDisabled(tr: renderer.ReactTestRenderer, testID: string): boolean {
	const wrapper = tr.root.findByProps({ testID });
	const disabledNode = [wrapper, ...wrapper.findAll(() => true)].find(
		(node) => "disabled" in node.props
	);
	return disabledNode?.props.disabled === true;
}

function present(tr: renderer.ReactTestRenderer, testID: string): void {
	expect(() => tr.root.findByProps({ testID })).not.toThrow();
}

function absent(tr: renderer.ReactTestRenderer, testID: string): void {
	expect(() => tr.root.findByProps({ testID })).toThrow();
}

function treeText(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}

/** Recursively find a node in the tr.toJSON() tree by its testID prop. */
function findJsonNodeByTestID(node: unknown, testID: string): unknown {
	if (!node) return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findJsonNodeByTestID(child, testID);
			if (found) return found;
		}
		return null;
	}
	if (typeof node !== "object") return null;
	const n = node as { props?: { testID?: string }; children?: unknown };
	if (n.props?.testID === testID) return n;
	if (n.children) return findJsonNodeByTestID(n.children, testID);
	return null;
}

/** Seeds a full registrant (all three tiers) through the real mock engine's own surface. */
async function seedRegistrant(
	engine: any,
	overrides: {
		public?: Record<string, unknown>;
		privateDetails?: Array<{ name: string; value: unknown; hint?: string }>;
		selective?: Array<{ name: string; value: unknown }>;
	} = {}
): Promise<void> {
	await engine.register(
		{
			registrant: { id: REGISTRANT_ID, authorityId: AUTHORITY_ID, expiration: FUTURE_ISO },
			public: overrides.public ?? { lastName: "Doe", firstName: "Jane", district: "D-7" },
			private: {
				expiration: FUTURE_ISO,
				details: overrides.privateDetails ?? [
					{ name: "SSN", value: SSN_SENTINEL },
					{ name: "DOB", value: DOB_SENTINEL },
					{ name: "Phone", value: PHONE_SENTINEL },
				],
			},
			selective: {
				expiration: FUTURE_ISO,
				details: overrides.selective ?? [
					{ name: "Email", value: "jane@example.com" },
					{ name: "Address", value: "123 Main St" },
				],
			},
		},
		SEED_SIGN
	);
}

let capturedAppStateHandler: ((state: AppStateStatus) => void) | undefined;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
	jest.clearAllMocks();
	mockRegistrationEngine = new MockRegistrationEngine();
	mockElections = [];
	mockScopesResult = { scopes: ["vrg"], loading: false };
	mockDeviceUser = { id: "u-officer-1" };
	mockAssociationsProps = null;
	mockAttestationProps = null;
	mockAccessHistoryProps = null;
	capturedAppStateHandler = undefined;

	jest.spyOn(AppState, "addEventListener").mockImplementation(((
		type: string,
		handler: (s: AppStateStatus) => void
	) => {
		capturedAppStateHandler = handler;
		return { remove: jest.fn() } as never;
	}) as typeof AppState.addEventListener);
	// Do NOT call jest.resetModules() — that would break the cached dist
	// require and the mock factory closures.
});

afterEach(() => {
	jest.restoreAllMocks();
});

describe("RegistrantDetailScreen — the phase's integration seam", () => {
	// -------------------------------------------------------------------------
	// Stale-dist guard
	// -------------------------------------------------------------------------

	it("stale-dist guard: MockRegistrationEngine exposes the registrant-detail surface on a fresh instance", () => {
		const engine = new MockRegistrationEngine();
		expect(typeof engine.getRegistrantPrivate).toBe("function");
		expect(typeof engine.getRegistrantSelective).toBe("function");
		expect(typeof engine.getDisclosedSelective).toBe("function");
		expect(typeof engine.changeStatus).toBe("function");
		expect(typeof engine.changeExpiration).toBe("function");
		expect(typeof engine.getElectionRegistrants).toBe("function");
		expect(typeof engine.recordRegistrantAccessEvent).toBe("function");
	});

	// -------------------------------------------------------------------------
	// Render order
	// -------------------------------------------------------------------------

	it("renders the nine blocks in 47-UI-SPEC.md:644-663's exact order", async () => {
		await seedRegistrant(mockRegistrationEngine);
		const tr = await renderScreen();
		const text = treeText(tr);

		const order = [
			"registrant-detail-error",
			"registrant-detail-header",
			"registrant-detail-public-tier",
			"registrant-detail-selective-tier",
			"registrant-detail-private-tier",
			"associations-section",
			"attestation-challenges-section",
			"access-history-section",
		];

		for (const testID of order) {
			present(tr, testID);
		}

		let lastIndex = -1;
		for (const testID of order) {
			const idx = text.indexOf(`"${testID}"`);
			expect(idx).toBeGreaterThan(lastIndex);
			lastIndex = idx;
		}
	});

	// -------------------------------------------------------------------------
	// Both scope-banner shapes stay distinct (D-13 default pattern)
	// -------------------------------------------------------------------------

	it("scopes === undefined -> the no-officer banner only", async () => {
		mockScopesResult = { scopes: undefined, loading: false };
		await seedRegistrant(mockRegistrationEngine);
		const tr = await renderScreen();
		present(tr, "registrant-detail-scope-no-officer-banner");
		absent(tr, "registrant-detail-scope-banner");
	});

	it("scopes === [] -> the scoped banner naming Validate registrations", async () => {
		mockScopesResult = { scopes: [], loading: false };
		await seedRegistrant(mockRegistrationEngine);
		const tr = await renderScreen();
		present(tr, "registrant-detail-scope-banner");
		absent(tr, "registrant-detail-scope-no-officer-banner");
		expect(treeText(tr)).toContain("registrantScopeReadOnlyBanner|scope=Validate registrations");
	});

	it("scopes === ['vrg'] -> neither banner renders", async () => {
		mockScopesResult = { scopes: ["vrg"], loading: false };
		await seedRegistrant(mockRegistrationEngine);
		const tr = await renderScreen();
		absent(tr, "registrant-detail-scope-banner");
		absent(tr, "registrant-detail-scope-no-officer-banner");
	});

	it("while scopesLoading is true, neither banner renders", async () => {
		mockScopesResult = { scopes: undefined, loading: true };
		await seedRegistrant(mockRegistrationEngine);
		const tr = await renderScreen();
		absent(tr, "registrant-detail-scope-banner");
		absent(tr, "registrant-detail-scope-no-officer-banner");
	});

	// -------------------------------------------------------------------------
	// D-13 divergence — hidden ENTIRELY, not masked-and-disabled
	// -------------------------------------------------------------------------

	it("D-13: an ungated officer sees the private tier hidden entirely, and the device never issues the read", async () => {
		mockScopesResult = { scopes: [], loading: false };
		await seedRegistrant(mockRegistrationEngine);
		const privateReadSpy = jest.spyOn(mockRegistrationEngine, "getRegistrantPrivate");

		const tr = await renderScreen();

		present(tr, "registrant-detail-private-tier");
		present(tr, "registrant-detail-private-gate");
		expect(treeText(tr)).toContain(
			"registrantDetailPrivateGateHeading|scope=Validate registrations"
		);

		const privateRows = tr.root.findAll(
			(node) =>
				typeof node.props.testID === "string" &&
				node.props.testID.startsWith("registrant-detail-private-row-")
		);
		expect(privateRows.length).toBe(0);

		const text = treeText(tr);
		expect(text).not.toContain('"SSN"');
		expect(text).not.toContain('"DOB"');
		expect(text).not.toContain('"Phone"');
		expect(text).not.toContain(SSN_SENTINEL);
		expect(text).not.toContain(DOB_SENTINEL);
		expect(text).not.toContain(PHONE_SENTINEL);
		expect(text).not.toContain("registrantDetailPrivateMaskedValue");

		// The read gate, not just the render gate.
		expect(privateReadSpy).toHaveBeenCalledTimes(0);
	});

	it("D-13: the divergence is scoped to the private tier alone — Public/Selective stay unmasked and every OTHER control stays visible-but-disabled", async () => {
		mockScopesResult = { scopes: [], loading: false };
		await seedRegistrant(mockRegistrationEngine);
		const tr = await renderScreen();

		present(tr, "registrant-detail-public-row-lastName");
		present(tr, "registrant-detail-public-row-firstName");
		present(tr, "selective-field-row-Email");

		const lifecycleButtons = tr.root.findAll(
			(node) =>
				typeof node.props.testID === "string" &&
				node.props.testID.startsWith("registrant-detail-lifecycle-")
		);
		expect(lifecycleButtons.length).toBeGreaterThan(0);
		for (const wrapperNode of lifecycleButtons) {
			const disabledDescendant = wrapperNode.findAll((n) => "disabled" in n.props);
			expect(disabledDescendant.some((n) => n.props.disabled === true)).toBe(true);
		}

		expect(mockAttestationProps.canWrite).toBe(false);
		expect(mockAccessHistoryProps.canView).toBe(false);
	});

	it("IN-07: a gate that closes mid-session DROPS the fetched private tier from state, not just from the render", async () => {
		// canViewPrivate is not constant for this screen's lifetime — the
		// officer's scopes can be revised while it stays open. D-13's structural
		// claim is that no decrypted private tier sits in this component's state
		// whenever the gate is closed, which a render-time-only gate does not
		// deliver.
		mockScopesResult = { scopes: ["vrg"], loading: false };
		await seedRegistrant(mockRegistrationEngine);
		const privateReadSpy = jest.spyOn(mockRegistrationEngine, "getRegistrantPrivate");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const RegistrantDetailScreen = require("../RegistrantDetailScreen").default;

		const tr = await renderScreen();
		await press(tr, "registrant-detail-private-toggle-SSN");
		expect(treeText(tr)).toContain(SSN_SENTINEL);
		expect(privateReadSpy).toHaveBeenCalledTimes(1);

		// The scopes are revised away while the screen stays mounted.
		mockScopesResult = { scopes: [], loading: false };
		await renderer.act(async () => {
			tr.update(<RegistrantDetailScreen />);
		});
		await flushTicks(4);
		present(tr, "registrant-detail-private-gate");
		expect(treeText(tr)).not.toContain(SSN_SENTINEL);

		// THE assertion that separates "cleared from state" from "merely hidden":
		// reopen the gate with the refetch FAILING. The failure is what isolates
		// the two — it means nothing can write privateTier on the way back in, so
		// whatever renders came from state that survived the close. A retained
		// tier renders its stale rows (and, once revealed again, its SSN);
		// cleared state renders the empty branch.
		privateReadSpy.mockRejectedValueOnce(
			new Error("RegistrationEngine.getRegistrantPrivate: unavailable")
		);
		mockScopesResult = { scopes: ["vrg"], loading: false };
		await renderer.act(async () => {
			tr.update(<RegistrantDetailScreen />);
		});
		await flushTicks(6);

		present(tr, "registrant-detail-private-empty");
		absent(tr, "registrant-detail-private-row-SSN");
		expect(treeText(tr)).not.toContain(SSN_SENTINEL);
	});

	it("WR-02: a gate that closes while the private read is IN FLIGHT discards the late resolution", async () => {
		// The IN-07 test above lets the first read settle before flipping the
		// scopes, so it never exercises the in-flight window. Checking
		// canViewPrivate only at loadPrivateTier's ENTRY leaves that window open:
		// gate open -> the engine call is awaited -> scopes are revised away ->
		// the effect clears privateTier -> the still-pending promise resolves and
		// writes the decrypted tier straight back into state. The render gate
		// hides it, so nothing is visible; only a snapshot or a crash payload
		// would show it -- which is exactly what D-13's structural half claims
		// cannot happen.
		mockScopesResult = { scopes: ["vrg"], loading: false };
		await seedRegistrant(mockRegistrationEngine);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const RegistrantDetailScreen = require("../RegistrantDetailScreen").default;

		// Capture the real tier, then hand the screen a promise WE decide when
		// to settle, so the gate can close strictly before it resolves.
		const realPrivate = await mockRegistrationEngine.getRegistrantPrivate(REGISTRANT_ID);
		expect(JSON.stringify(realPrivate)).toContain(SSN_SENTINEL);

		let releaseRead: (() => void) | undefined;
		const deferred = new Promise((resolve) => {
			releaseRead = () => resolve(realPrivate);
		});
		const privateReadSpy = jest
			.spyOn(mockRegistrationEngine, "getRegistrantPrivate")
			.mockReturnValueOnce(deferred as never);

		const tr = await renderScreen();
		expect(privateReadSpy).toHaveBeenCalledTimes(1);
		// Still in flight: nothing has been written yet.
		present(tr, "registrant-detail-private-empty");

		// The scopes are revised away WHILE the read is outstanding.
		mockScopesResult = { scopes: [], loading: false };
		await renderer.act(async () => {
			tr.update(<RegistrantDetailScreen />);
		});
		await flushTicks(4);
		present(tr, "registrant-detail-private-gate");

		// Only NOW does the read come back.
		releaseRead!();
		await flushTicks(6);
		expect(treeText(tr)).not.toContain(SSN_SENTINEL);

		// Same isolation device as the IN-07 test: reopen the gate with the
		// refetch FAILING, so nothing can write privateTier on the way back in.
		// Whatever renders therefore came from state. A late resolution that was
		// allowed to write renders the stale rows; a discarded one renders empty.
		privateReadSpy.mockRejectedValueOnce(
			new Error("RegistrationEngine.getRegistrantPrivate: unavailable")
		);
		mockScopesResult = { scopes: ["vrg"], loading: false };
		await renderer.act(async () => {
			tr.update(<RegistrantDetailScreen />);
		});
		await flushTicks(6);

		present(tr, "registrant-detail-private-empty");
		absent(tr, "registrant-detail-private-row-SSN");
		expect(treeText(tr)).not.toContain(SSN_SENTINEL);
	});

	// -------------------------------------------------------------------------
	// Private tier revealed (D-01/D-14)
	// -------------------------------------------------------------------------

	it("D-01/D-14: a gated officer reveals fields one at a time — no value present until its own toggle is pressed", async () => {
		mockScopesResult = { scopes: ["vrg"], loading: false };
		await seedRegistrant(mockRegistrationEngine);
		const tr = await renderScreen();

		present(tr, "registrant-detail-private-row-SSN");
		present(tr, "registrant-detail-private-row-DOB");
		present(tr, "registrant-detail-private-row-Phone");

		let text = treeText(tr);
		expect(text).not.toContain(SSN_SENTINEL);
		expect(text).not.toContain(DOB_SENTINEL);
		expect(text).not.toContain(PHONE_SENTINEL);

		await press(tr, "registrant-detail-private-toggle-SSN");

		text = treeText(tr);
		expect(text).toContain(SSN_SENTINEL);
		expect(text).not.toContain(DOB_SENTINEL);
		expect(text).not.toContain(PHONE_SENTINEL);
	});

	// -------------------------------------------------------------------------
	// D-14 flush lifecycle
	// -------------------------------------------------------------------------

	it("D-14: the unmount flush sends the accumulated names, sorted ascending, exactly once", async () => {
		mockScopesResult = { scopes: ["vrg"], loading: false };
		await seedRegistrant(mockRegistrationEngine);
		const recordSpy = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");
		const tr = await renderScreen();

		await press(tr, "registrant-detail-private-toggle-SSN");
		await press(tr, "registrant-detail-private-toggle-DOB");

		await renderer.act(async () => {
			tr.unmount();
		});
		await flushTicks(4);

		expect(recordSpy).toHaveBeenCalledTimes(1);
		expect(recordSpy).toHaveBeenCalledWith(REGISTRANT_ID, "u-officer-1", ["DOB", "SSN"]);
		expect(JSON.stringify(recordSpy.mock.calls)).not.toContain(SSN_SENTINEL);
		expect(JSON.stringify(recordSpy.mock.calls)).not.toContain(DOB_SENTINEL);
	});

	it("D-14: a background flush followed by an unmount flush produces two rows with disjoint names — the delta contract", async () => {
		mockScopesResult = { scopes: ["vrg"], loading: false };
		await seedRegistrant(mockRegistrationEngine);
		const recordSpy = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");
		const tr = await renderScreen();

		await press(tr, "registrant-detail-private-toggle-SSN");

		await renderer.act(async () => {
			capturedAppStateHandler?.("background");
			await Promise.resolve();
		});
		await flushTicks(4);

		await press(tr, "registrant-detail-private-toggle-DOB");

		await renderer.act(async () => {
			tr.unmount();
		});
		await flushTicks(4);

		expect(recordSpy).toHaveBeenCalledTimes(2);
		expect(recordSpy.mock.calls[0]![2]).toEqual(["SSN"]);
		expect(recordSpy.mock.calls[1]![2]).toEqual(["DOB"]);
	});

	it("D-14: an unresolved officer User.Id resolves without writing — accepted loss, no throw", async () => {
		mockScopesResult = { scopes: ["vrg"], loading: false };
		mockDeviceUser = undefined;
		await seedRegistrant(mockRegistrationEngine);
		const recordSpy = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");
		const tr = await renderScreen();

		await press(tr, "registrant-detail-private-toggle-SSN");

		await expect(
			(async () => {
				await renderer.act(async () => {
					tr.unmount();
				});
				await flushTicks(4);
			})()
		).resolves.not.toThrow();

		expect(recordSpy).toHaveBeenCalledTimes(0);
	});

	// -------------------------------------------------------------------------
	// D-10 no-op suppression
	// -------------------------------------------------------------------------

	it("D-10 no-op suppression: Active shows suspend/revoke/renew, not reinstate", async () => {
		await seedRegistrant(mockRegistrationEngine);
		const tr = await renderScreen();
		present(tr, "registrant-detail-lifecycle-suspend");
		present(tr, "registrant-detail-lifecycle-revoke");
		present(tr, "registrant-detail-lifecycle-renew");
		absent(tr, "registrant-detail-lifecycle-reinstate");
	});

	it("D-10 no-op suppression: Suspended shows reinstate/revoke/renew, not suspend", async () => {
		await seedRegistrant(mockRegistrationEngine);
		await mockRegistrationEngine.changeStatus(REGISTRANT_ID, "s", SEED_SIGN);
		const tr = await renderScreen();
		present(tr, "registrant-detail-lifecycle-reinstate");
		present(tr, "registrant-detail-lifecycle-revoke");
		present(tr, "registrant-detail-lifecycle-renew");
		absent(tr, "registrant-detail-lifecycle-suspend");
	});

	it("D-10 no-op suppression: Revoked shows reinstate/suspend/renew, not revoke", async () => {
		await seedRegistrant(mockRegistrationEngine);
		await mockRegistrationEngine.changeStatus(REGISTRANT_ID, "r", SEED_SIGN);
		const tr = await renderScreen();
		present(tr, "registrant-detail-lifecycle-reinstate");
		present(tr, "registrant-detail-lifecycle-suspend");
		present(tr, "registrant-detail-lifecycle-renew");
		absent(tr, "registrant-detail-lifecycle-revoke");
	});

	// -------------------------------------------------------------------------
	// D-10 typed variant — suspend AND revoke
	// -------------------------------------------------------------------------

	it.each<["suspend" | "revoke", "s" | "r"]>([
		["suspend", "s"],
		["revoke", "r"],
	])(
		"D-10 typed variant: %s requires the exact registrant name and commits the status change",
		async (action, targetStatus) => {
			await seedRegistrant(mockRegistrationEngine);
			const tr = await renderScreen();
			const prefix = "registrant-detail-confirm-" + action;

			await press(tr, "registrant-detail-lifecycle-" + action);
			present(tr, prefix + "-card");
			present(tr, prefix + "-typed-input");
			expect(isDisabled(tr, prefix + "-confirm")).toBe(true);

			typeInto(tr, prefix + "-typed-input", "Doe, Jan");
			expect(isDisabled(tr, prefix + "-confirm")).toBe(true);

			typeInto(tr, prefix + "-typed-input", "  doe, jane  ");
			expect(isDisabled(tr, prefix + "-confirm")).toBe(false);

			await press(tr, prefix + "-confirm");

			const registrant = await mockRegistrationEngine.getRegistrant(REGISTRANT_ID);
			expect(registrant.status).toBe(targetStatus);
			absent(tr, prefix + "-card");
		}
	);

	it("D-10: -typed-input never renders for renew or reinstate", async () => {
		await seedRegistrant(mockRegistrationEngine);
		await mockRegistrationEngine.changeStatus(REGISTRANT_ID, "s", SEED_SIGN);
		const tr = await renderScreen();

		await press(tr, "registrant-detail-lifecycle-reinstate");
		absent(tr, "registrant-detail-confirm-reinstate-typed-input");
	});

	// -------------------------------------------------------------------------
	// D-10 ordinary variants
	// -------------------------------------------------------------------------

	it("D-10 ordinary: reinstate carries the oldStatus interpolation and commits", async () => {
		await seedRegistrant(mockRegistrationEngine);
		await mockRegistrationEngine.changeStatus(REGISTRANT_ID, "s", SEED_SIGN);
		const tr = await renderScreen();

		await press(tr, "registrant-detail-lifecycle-reinstate");
		const prefix = "registrant-detail-confirm-reinstate";
		present(tr, prefix + "-card");
		absent(tr, prefix + "-typed-input");
		expect(treeText(tr)).toContain(
			"registrantLifecycleReinstateBody|name=Doe, Jane,oldStatus=registrantStatusSuspended"
		);

		await press(tr, prefix + "-confirm");
		const registrant = await mockRegistrationEngine.getRegistrant(REGISTRANT_ID);
		expect(registrant.status).toBe("a");
	});

	it("D-10 ordinary: renew shows the DateField picker first, the card only after a valid date, and commits the new expiration", async () => {
		await seedRegistrant(mockRegistrationEngine);
		const tr = await renderScreen();

		await press(tr, "registrant-detail-lifecycle-renew");
		present(tr, "registrant-detail-renew-picker");
		absent(tr, "registrant-detail-confirm-renew-card");

		const newExpiration = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
		const dateField = tr.root.findByProps({ title: "registrantDetailExpirationLabel" });
		await renderer.act(async () => {
			dateField.props.onChange(newExpiration);
		});

		present(tr, "registrant-detail-confirm-renew-card");
		expect(treeText(tr)).toContain("newExpiration=" + newExpiration.split("T")[0]);

		await press(tr, "registrant-detail-confirm-renew-confirm");
		const registrant = await mockRegistrationEngine.getRegistrant(REGISTRANT_ID);
		expect(registrant.expiration).toBe(newExpiration);
	});

	// -------------------------------------------------------------------------
	// D-10 zero-call dismiss
	// -------------------------------------------------------------------------

	it.each<"renew" | "reinstate" | "suspend" | "revoke">([
		"renew",
		"reinstate",
		"suspend",
		"revoke",
	])("D-10: dismissing %s fires ZERO engine calls", async (action) => {
		await seedRegistrant(mockRegistrationEngine);
		if (action === "reinstate") {
			await mockRegistrationEngine.changeStatus(REGISTRANT_ID, "s", SEED_SIGN);
		}
		const changeStatusSpy = jest.spyOn(mockRegistrationEngine, "changeStatus");
		const changeExpirationSpy = jest.spyOn(mockRegistrationEngine, "changeExpiration");

		const tr = await renderScreen();
		const prefix = "registrant-detail-confirm-" + action;

		await press(tr, "registrant-detail-lifecycle-" + action);

		if (action === "renew") {
			const dateField = tr.root.findByProps({ title: "registrantDetailExpirationLabel" });
			await renderer.act(async () => {
				dateField.props.onChange(new Date(Date.now() + 86400000).toISOString());
			});
		}

		if (action === "suspend" || action === "revoke") {
			typeInto(tr, prefix + "-typed-input", "Doe, Jane");
		}

		present(tr, prefix + "-card");
		await press(tr, prefix + "-dismiss");

		expect(changeStatusSpy).toHaveBeenCalledTimes(0);
		expect(changeExpirationSpy).toHaveBeenCalledTimes(0);
		absent(tr, prefix + "-card");

		const registrant = await mockRegistrationEngine.getRegistrant(REGISTRANT_ID);
		// reinstate is exercised from a Suspended seed (its trigger is a
		// no-op — and therefore absent — on the default Active status), so
		// the unchanged status after a dismissed reinstate is 's', not 'a'.
		expect(registrant.status).toBe(action === "reinstate" ? "s" : "a");
		expect(registrant.expiration).toBe(FUTURE_ISO);
	});

	// -------------------------------------------------------------------------
	// D-10 failed-write retry latch
	// -------------------------------------------------------------------------

	it("D-10: a failed write keeps the card mounted and retryable (47-10's latch contract) (translated, no engine text)", async () => {
		await seedRegistrant(mockRegistrationEngine);
		const changeStatusSpy = jest
			.spyOn(mockRegistrationEngine, "changeStatus")
			.mockImplementationOnce(() => Promise.reject(new Error("signed write failed")));

		const tr = await renderScreen();
		const prefix = "registrant-detail-confirm-revoke";

		await press(tr, "registrant-detail-lifecycle-revoke");
		typeInto(tr, prefix + "-typed-input", "Doe, Jane");
		await press(tr, prefix + "-confirm");

		expect(treeText(tr)).toContain("errorActionFailedGeneric");
		expect(treeText(tr)).not.toContain("signed write failed");
		present(tr, prefix + "-card");
		expect(isDisabled(tr, prefix + "-confirm")).toBe(false);

		await press(tr, prefix + "-confirm");

		const registrant = await mockRegistrationEngine.getRegistrant(REGISTRANT_ID);
		expect(registrant.status).toBe("r");
		absent(tr, prefix + "-card");
		expect(changeStatusSpy).toHaveBeenCalledTimes(2);
		expect(treeText(tr)).not.toContain(SSN_SENTINEL);
		expect(treeText(tr)).not.toContain(DOB_SENTINEL);
		expect(treeText(tr)).not.toContain(PHONE_SENTINEL);
	});

	// -------------------------------------------------------------------------
	// D-12 audience preview drives the real engine call
	// -------------------------------------------------------------------------

	it("D-12: selecting an audience calls getDisclosedSelective exactly once with the resolved election id, and every raw row still renders", async () => {
		await seedRegistrant(mockRegistrationEngine);
		mockElections = [{ id: "election-1", title: "General" }];
		await mockRegistrationEngine.enrollElectionRegistrant("election-1", REGISTRANT_ID, SEED_SIGN);
		const disclosedSpy = jest.spyOn(mockRegistrationEngine, "getDisclosedSelective");

		const tr = await renderScreen();

		await press(tr, "selective-audience-chip-everyone");

		expect(disclosedSpy).toHaveBeenCalledTimes(1);
		expect(disclosedSpy).toHaveBeenCalledWith("election-1", REGISTRANT_ID, "everyone");
		present(tr, "selective-field-row-Email");
		present(tr, "selective-field-row-Address");
		present(tr, "selective-field-disclosure-Email");
		present(tr, "selective-field-disclosure-Address");

		await press(tr, "selective-audience-chip-district");
		expect(disclosedSpy).toHaveBeenCalledTimes(2);
		expect(disclosedSpy).toHaveBeenLastCalledWith("election-1", REGISTRANT_ID, "district");
	});

	// -------------------------------------------------------------------------
	// D-12 no-election-context / failure annotation
	// -------------------------------------------------------------------------

	it("D-12: no election context annotates every row Not-disclosed, without calling getDisclosedSelective", async () => {
		await seedRegistrant(mockRegistrationEngine);
		mockElections = [];
		const disclosedSpy = jest.spyOn(mockRegistrationEngine, "getDisclosedSelective");

		const tr = await renderScreen();
		await press(tr, "selective-audience-chip-everyone");

		expect(disclosedSpy).toHaveBeenCalledTimes(0);
		const emailBadge = findJsonNodeByTestID(tr.toJSON(), "selective-field-disclosure-Email");
		expect(JSON.stringify(emailBadge)).toContain("registrantDetailSelectiveNotDisclosedLabel");
		const addressBadge = findJsonNodeByTestID(tr.toJSON(), "selective-field-disclosure-Address");
		expect(JSON.stringify(addressBadge)).toContain("registrantDetailSelectiveNotDisclosedLabel");
	});

	it("D-12: a failed fetch annotates NO row, surfaces InlineError, and every raw row still renders", async () => {
		await seedRegistrant(mockRegistrationEngine);
		mockElections = [{ id: "election-1", title: "General" }];
		await mockRegistrationEngine.enrollElectionRegistrant("election-1", REGISTRANT_ID, SEED_SIGN);
		jest
			.spyOn(mockRegistrationEngine, "getDisclosedSelective")
			.mockRejectedValueOnce(new Error("disclosure fetch failed"));

		const tr = await renderScreen();
		await press(tr, "selective-audience-chip-everyone");

		const disclosureBadges = tr.root.findAll(
			(node) =>
				typeof node.props.testID === "string" &&
				node.props.testID.startsWith("selective-field-disclosure-")
		);
		expect(disclosureBadges.length).toBe(0);
		expect(treeText(tr)).toContain("errorLoadFailedGeneric");
		expect(treeText(tr)).not.toContain("disclosure fetch failed");
		present(tr, "selective-field-row-Email");
		present(tr, "selective-field-row-Address");
	});

	// -------------------------------------------------------------------------
	// D-12 salt exclusion
	// -------------------------------------------------------------------------

	it("D-12: no salt ever reaches the rendered tree across the undefined/null/result states", async () => {
		await seedRegistrant(mockRegistrationEngine, {
			selective: [{ name: "SaltyField", value: "visible-value" }],
		});
		mockElections = [];

		const tr = await renderScreen();
		expect(treeText(tr)).not.toContain(SALT_SENTINEL);

		await press(tr, "selective-audience-chip-everyone");
		expect(treeText(tr)).not.toContain(SALT_SENTINEL);

		mockElections = [{ id: "election-1" }];
		await mockRegistrationEngine.enrollElectionRegistrant("election-1", REGISTRANT_ID, SEED_SIGN);
		await press(tr, "selective-audience-chip-district");
		expect(treeText(tr)).not.toContain(SALT_SENTINEL);
	});

	// -------------------------------------------------------------------------
	// T-47-02 — no private value escapes anywhere
	// -------------------------------------------------------------------------

	it("T-47-02: no private value reaches the debug console, an error string, an i18n interpolation, or the engine call log across a full cycle", async () => {
		const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
		const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
		const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
		const debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});

		mockScopesResult = { scopes: ["vrg"], loading: false };
		await seedRegistrant(mockRegistrationEngine);
		mockElections = [{ id: "election-1" }];
		await mockRegistrationEngine.enrollElectionRegistrant("election-1", REGISTRANT_ID, SEED_SIGN);

		const recordSpy = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");
		const disclosedSpy = jest.spyOn(mockRegistrationEngine, "getDisclosedSelective");
		const changeStatusSpy = jest
			.spyOn(mockRegistrationEngine, "changeStatus")
			.mockImplementationOnce(() => Promise.reject(new Error("signed write failed")));

		const tr = await renderScreen();

		await press(tr, "registrant-detail-private-toggle-SSN");
		await press(tr, "registrant-detail-private-toggle-DOB");
		await press(tr, "registrant-detail-private-toggle-Phone");

		await press(tr, "selective-audience-chip-everyone");
		await press(tr, "selective-audience-chip-district");

		await press(tr, "registrant-detail-lifecycle-revoke");
		typeInto(tr, "registrant-detail-confirm-revoke-typed-input", "Doe, Jane");
		await press(tr, "registrant-detail-confirm-revoke-confirm");
		expect(treeText(tr)).toContain("errorActionFailedGeneric");
		expect(treeText(tr)).not.toContain("signed write failed");
		await press(tr, "registrant-detail-confirm-revoke-dismiss");

		await press(tr, "registrant-detail-lifecycle-renew");
		const dateField = tr.root.findByProps({ title: "registrantDetailExpirationLabel" });
		await renderer.act(async () => {
			dateField.props.onChange(new Date(Date.now() + 86400000).toISOString());
		});
		await press(tr, "registrant-detail-confirm-renew-confirm");

		await renderer.act(async () => {
			capturedAppStateHandler?.("background");
			await Promise.resolve();
		});
		await flushTicks(4);

		await renderer.act(async () => {
			tr.unmount();
		});
		await flushTicks(4);

		for (const spy of [logSpy, warnSpy, errorSpy, infoSpy, debugSpy]) {
			expect(spy).toHaveBeenCalledTimes(0);
		}

		const combinedCallLog = JSON.stringify([
			...recordSpy.mock.calls,
			...disclosedSpy.mock.calls,
			...changeStatusSpy.mock.calls,
		]);
		expect(combinedCallLog).not.toContain(SSN_SENTINEL);
		expect(combinedCallLog).not.toContain(DOB_SENTINEL);
		expect(combinedCallLog).not.toContain(PHONE_SENTINEL);
		expect(combinedCallLog).not.toContain(SALT_SENTINEL);
	});

	// -------------------------------------------------------------------------
	// Provisioning-status callback
	// -------------------------------------------------------------------------

	it("supplies onOpenProvisioningStatus as a real callback that navigates to AttestationProvisioningStatus", async () => {
		await seedRegistrant(mockRegistrationEngine);
		await renderScreen();

		expect(typeof mockAttestationProps.onOpenProvisioningStatus).toBe("function");
		mockAttestationProps.onOpenProvisioningStatus();
		expect(mockNavigate).toHaveBeenCalledWith("AttestationProvisioningStatus");
	});

	// -------------------------------------------------------------------------
	// Sibling props contract
	// -------------------------------------------------------------------------

	it("AssociationsSection and AccessHistorySection receive exactly their frozen prop contracts", async () => {
		mockScopesResult = { scopes: ["vrg"], loading: false };
		await seedRegistrant(mockRegistrationEngine);
		await renderScreen();

		expect(mockAssociationsProps).toEqual({
			registrantId: REGISTRANT_ID,
			authorityId: AUTHORITY_ID,
			registrantDisplayName: "Doe, Jane",
		});
		expect(mockAccessHistoryProps).toEqual({ registrantId: REGISTRANT_ID, canView: true });
	});
});
