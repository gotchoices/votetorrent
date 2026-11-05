/**
 * RegistrantDetailScreen.integration.test.tsx — the Phase 47 END-TO-END gate
 * for D-10 (typed vs. ordinary confirmation, dismissed-fires-nothing), D-12
 * (audience preview annotates every row, salts never render) and D-13 (both
 * scope-gate shapes plus the private-tier hidden-entirely divergence).
 *
 * PATTERN SOURCE: `BallotConfirmation.test.tsx` — real `MockRegistrationEngine`
 * / `MockAssociationEngine` / `MockAuthorityConfigEngine` instances required
 * by a relative `dist/` path, never a `jest.fn()` engine stub.
 * `AdministratorInvitationScreen.test.tsx`'s `jest.fn()`-stub pattern is
 * DELIBERATELY NOT used here.
 *
 * ============================================================================
 * DECLARED BLIND SPOT — read before trusting a single green test in this file.
 * ============================================================================
 * The mock engines are `Map`-backed and enforce NONE of the schema's
 * PK/CHECK/`InsertOnly` semantics (no `AdminSignature` scope CHECK, no replay
 * guard beyond `MockAssociationEngine.associate`'s own PK-collision throw, no
 * `RegistrantPublic` currency join). Every D-13 scope-gate assertion below
 * proves a UI legibility affordance, NOT an access-control boundary — the
 * real and only control is the schema's `'vrg'`-scoped `AdminSignature` CHECK
 * (T-47-04, `useCurrentOfficerScopes`'s own "NOT A SECURITY BOUNDARY" note).
 * Nothing in this suite is evidence about the real engine or the on-device
 * re-attach path — that proof belongs to 47-06/47-08's real-engine specs and
 * 47-23's device run.
 * ============================================================================
 */

import React from "react";
import renderer from "react-test-renderer";
import { isBareDismissLabel } from "../components/LifecycleConfirmCard";

// ---------------------------------------------------------------------------
// Mutable module-level slots. Prefixed `mock` so babel-plugin-jest-hoist
// allows the jest.mock() factories below to close over them.
// ---------------------------------------------------------------------------

const REGISTRANT_ID = "reg-1";
const AUTHORITY_ID = "auth-1";
const ELECTION_ID = "election-1";
const FUTURE_ISO = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
const DISPLAY_NAME = "Vasquez, Ada";

// Private-tier VALUE sentinels — never used in a test title.
const SSN_VALUE = "123-45-6789";
const DOB_VALUE = "1980-01-01";
const PHONE_VALUE = "555-0142";

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

let mockRegistrationEngine: any;
let mockAssociationEngine: any;
let mockAuthorityConfigEngine: any;

// A minimal, NON-real elections fixture — deliberately NOT
// MockElectionsEngine, which logs via console.log('Getting active
// elections') on every getElections() call and would poison the T-47-02
// never-log assertion (Group D test 16). RegistrantDetailScreen.tsx (47-20)
// discovered detail: the screen scans getElections() -> getElectionRegistrants
// per election to resolve the audience-preview election context; this
// fixture gives the suite direct control over that resolution.
let mockElections: Array<{ id: string }> = [];
const mockElectionsEngine = {
	getElections: jest.fn(async () => mockElections),
};

// The getEngine dispatcher — all four keys the frozen contract names, plus
// "elections" (discovered from shipped RegistrantDetailScreen.tsx source,
// not a frozen contract key): "registration"/"association"/"authorityConfig"
// resolve to REAL dist/ mock-engine instances; "network" and "elections"
// resolve to lightweight fixtures.
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "registration") return mockRegistrationEngine;
	if (name === "association") return mockAssociationEngine;
	if (name === "authorityConfig") return mockAuthorityConfigEngine;
	if (name === "network") return mockNetworkEngine;
	if (name === "elections") return mockElectionsEngine;
	return null;
});

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

// react-i18next: interpolation-ECHOING t() — bare key when no options, else
// `key + "|" + "k1=v1,k2=v2"` (flat, unquoted join) so a single assertion can
// prove BOTH which key rendered AND which interpolation values were actually
// bound (scope, name, oldStatus, newExpiration all appear this way across
// this screen's call sites). `...jest.requireActual` per the 47-11 binding
// convention.
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

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
const mockSetParams = jest.fn();

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
		goBack: mockGoBack,
		setOptions: mockSetOptions,
		setParams: mockSetParams,
	}),
	// The frozen 47-21 route param shape.
	useRoute: () => ({ params: { registrantId: REGISTRANT_ID, authorityId: AUTHORITY_ID } }),
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

// Discovered detail: AttestationChallengesSection destructures
// `isAttestationVerifierProvisioned` off useApp() unconditionally (no
// optional chaining) — omitting it here would crash Group A test 4's render.
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine, isAttestationVerifierProvisioned: () => true }),
}));

// ---------------------------------------------------------------------------
// The REAL mock engines — required by relative dist path, six levels up,
// matching BallotConfirmation.test.tsx / RegistrationPolicyScreen.test.tsx.
// NOT `@votetorrent/vote-engine` — the package's `exports` field blocks this
// subpath. `yarn workspace @votetorrent/vote-engine build` must run first, or
// the phase-47 engine surface this suite needs is invisible to this require
// (see the stale-dist guard test below).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MockRegistrationEngine } = require(
	"../../../../../../packages/vote-engine/dist/registration/mock-registration-engine",
);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MockAssociationEngine } = require(
	"../../../../../../packages/vote-engine/dist/association/mock-association-engine",
);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MockAuthorityConfigEngine } = require(
	"../../../../../../packages/vote-engine/dist/authority-config/mock-authority-config-engine",
);

// ---------------------------------------------------------------------------
// Helpers — adapted from RegistrationPolicyScreen.test.tsx /
// RegistrantDetailScreen.test.tsx (47-20).
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
	// of getRegistrant/getRegistrantPublic/getRegistrantSelective, PLUS the
	// separate private-tier effect, PLUS the device-user mount effect, PLUS
	// useCurrentOfficerScopes' OWN async walk (device-user -> network engine
	// -> openAuthority -> getAdminDetails) — this suite does NOT mock that
	// hook directly (unlike 47-20's co-located test), so its chain must also
	// resolve here.
	await flushTicks(12);
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
	await flushTicks(4);
}

/** The D-10 read-only variant of `press` — used ONLY where an EMPTY candidate list is CORRECT. */
function attemptPress(tr: renderer.ReactTestRenderer, testID: string): void {
	const wrapper = tr.root.findByProps({ testID });
	const candidates = wrapper.findAll(
		(node) => typeof node.props.onPressIn === "function" || typeof node.props.onPress === "function",
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
	const disabledNode = [wrapper, ...wrapper.findAll(() => true)].find((node) => "disabled" in node.props);
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

/**
 * Counts DISTINCT testIDs matching `pattern`, not raw node matches. React
 * Test Renderer's `findAll` walks both the composite wrapper AND the
 * underlying host instance for a plain `<View testID="x">` — both carry the
 * same forwarded `testID` prop, so a raw node count double-counts every row.
 * Deduping by the testID string itself is what makes "3" mean "three rows",
 * not "three rows times however many renderer layers happen to forward the
 * prop".
 */
function countTestIDsMatching(tr: renderer.ReactTestRenderer, pattern: RegExp): number {
	const matches = tr.root.findAll((node) => typeof node.props.testID === "string" && pattern.test(node.props.testID));
	return new Set(matches.map((n) => n.props.testID as string)).size;
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

// Populated fresh by seedRegistrant() every call — the plugin's own
// randomBytes(128) salts, read back so absence assertions target the ACTUAL
// salts this test run produced, never a hardcoded literal.
let currentSalts: { email: string; street: string; county: string } = { email: "", street: "", county: "" };

/**
 * Seeds a full registrant (all three tiers) through the real mock engine's
 * own `register()` surface — three private fields, three selective fields,
 * chosen so a count assertion of 3 cannot pass by coincidence against a
 * one-row fixture.
 */
async function seedRegistrant(): Promise<void> {
	await mockRegistrationEngine.register(
		{
			registrant: { id: REGISTRANT_ID, authorityId: AUTHORITY_ID, expiration: FUTURE_ISO },
			public: { lastName: "Vasquez", firstName: "Ada", district: "D-7", extraFields: [] },
			private: {
				expiration: FUTURE_ISO,
				details: [
					{ name: "ssn", value: SSN_VALUE },
					{ name: "dob", value: DOB_VALUE },
					{ name: "phone", value: PHONE_VALUE },
				],
			},
			selective: {
				expiration: FUTURE_ISO,
				details: [
					{ name: "email", value: "ada@example.test" },
					{ name: "street", value: "12 Elm" },
					{ name: "county", value: "Marion" },
				],
			},
		},
		SEED_SIGN,
	);

	const selectiveRow = await mockRegistrationEngine.getRegistrantSelective(REGISTRANT_ID);
	const leaves: Array<{ name: string; salt: unknown }> = selectiveRow?.selectiveDetails ?? [];
	currentSalts = {
		email: String(leaves.find((l) => l.name === "email")?.salt ?? ""),
		street: String(leaves.find((l) => l.name === "street")?.salt ?? ""),
		county: String(leaves.find((l) => l.name === "county")?.salt ?? ""),
	};
	// A structural guard on the fixture itself, not the screen: if this ever
	// fails, the salt-absence assertions below (test 8) would be vacuously
	// true against empty-string "sentinels".
	expect(currentSalts.email.length).toBeGreaterThan(0);
	expect(currentSalts.street.length).toBeGreaterThan(0);
	expect(currentSalts.county.length).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
	jest.clearAllMocks();
	mockRegistrationEngine = new MockRegistrationEngine();
	mockAssociationEngine = new MockAssociationEngine();
	mockAuthorityConfigEngine = new MockAuthorityConfigEngine();
	mockOfficers = [];
	mockElections = [];
	currentSalts = { email: "", street: "", county: "" };
	// Do NOT call jest.resetModules() — that would break the cached dist
	// require and the mock factory closures (BallotConfirmation.test.tsx's
	// note, carried forward).
});

// ---------------------------------------------------------------------------
// Stale-dist guard — a plain module-load-time assertion, NOT an `it()` block
// (the plan pins this suite at exactly 17 tests). A stale
// `packages/vote-engine/dist/` throws here immediately, before any test
// runs, with a clear message rather than surfacing as an obscure downstream
// render error deep inside the suite.
// ---------------------------------------------------------------------------
(function staleDistGuard() {
	const reg = new MockRegistrationEngine();
	const assoc = new MockAssociationEngine();
	const authCfg = new MockAuthorityConfigEngine();
	const missing = [
		typeof reg.getDisclosedSelective !== "function" && "MockRegistrationEngine.getDisclosedSelective",
		typeof reg.recordRegistrantAccessEvent !== "function" && "MockRegistrationEngine.recordRegistrantAccessEvent",
		typeof assoc.getAttestationChallenges !== "function" && "MockAssociationEngine.getAttestationChallenges",
		typeof assoc.getAttestationVerdicts !== "function" && "MockAssociationEngine.getAttestationVerdicts",
		typeof authCfg.getPollingDevices !== "function" && "MockAuthorityConfigEngine.getPollingDevices",
		typeof authCfg.getAuthorityPeers !== "function" && "MockAuthorityConfigEngine.getAuthorityPeers",
	].filter(Boolean);
	if (missing.length > 0) {
		throw new Error(
			`STALE DIST: packages/vote-engine/dist/ is missing ${missing.join(", ")}. Run 'yarn workspace @votetorrent/vote-engine build' before this suite.`,
		);
	}
})();

describe("RegistrantDetailScreen.integration — the Phase 47 E2E gate (D-10/D-12/D-13)", () => {
	// =========================================================================
	// GROUP A — D-13 scope gating, three officer shapes
	// =========================================================================

	it("D-13: an officer holding vrg sees the private tier field rows", async () => {
		mockOfficers = [{ userId: "device-user-1", authorityId: AUTHORITY_ID, title: "Registrar", scopes: ["vrg"] }];
		await seedRegistrant();

		const tr = await renderScreen();

		expect(countTestIDsMatching(tr, /^registrant-detail-private-row-/)).toBe(3);
		present(tr, "registrant-detail-private-row-ssn");
		present(tr, "registrant-detail-private-row-dob");
		present(tr, "registrant-detail-private-row-phone");

		const text = treeText(tr);
		// Masked by default — the label renders, the values do not.
		expect((text.match(/registrantDetailPrivateMaskedValue/g) ?? []).length).toBe(3);
		expect(text).not.toContain(SSN_VALUE);
		expect(text).not.toContain(DOB_VALUE);
		expect(text).not.toContain(PHONE_VALUE);
	});

	it("D-13 DIVERGENCE: an officer whose scopes lack vrg sees the private tier hidden ENTIRELY", async () => {
		mockOfficers = [{ userId: "device-user-1", authorityId: AUTHORITY_ID, title: "Clerk", scopes: ["ceb"] }];
		await seedRegistrant();

		const tr = await renderScreen();

		// Zero private rows — not merely masked, ABSENT.
		expect(countTestIDsMatching(tr, /^registrant-detail-private-row-/)).toBe(0);

		// This is what "must not even learn which private fields exist" means:
		// a masked placeholder row would still leak the field NAME. A quoted
		// exact-string check (not a substring test) so common short words
		// elsewhere in the tree cannot produce a false pass.
		const text = treeText(tr);
		expect(text).not.toContain('"ssn"');
		expect(text).not.toContain('"dob"');
		expect(text).not.toContain('"phone"');

		present(tr, "registrant-detail-private-gate");
		// The scope binding proof: scopeDescriptions.vrg was actually bound
		// into the heading, not merely that some key rendered.
		expect(text).toContain("registrantDetailPrivateGateHeading|scope=Validate registrations");
		present(tr, "registrant-detail-scope-banner");
	});

	it("D-13: a device that is not an officer at all gets the no-officer banner, and the private tier is still hidden entirely", async () => {
		mockOfficers = []; // find() yields undefined — a DIFFERENT fact from scopes === [].
		await seedRegistrant();

		const tr = await renderScreen();

		present(tr, "registrant-detail-scope-no-officer-banner");
		absent(tr, "registrant-detail-scope-banner");
		expect(countTestIDsMatching(tr, /^registrant-detail-private-row-/)).toBe(0);
		present(tr, "registrant-detail-private-gate");
	});

	it("D-13: every OTHER write control follows the visible-but-disabled pattern", async () => {
		mockOfficers = [{ userId: "device-user-1", authorityId: AUTHORITY_ID, title: "Clerk", scopes: ["ceb"] }];
		await seedRegistrant();
		await mockAssociationEngine.associate(
			{ registrantId: REGISTRANT_ID, deviceKey: "device-key-1", deviceHash: "hash-1", nonce: "nonce-assoc-1" },
			SEED_SIGN,
		);
		const challenge = await mockAssociationEngine.issueAttestationChallenge(
			REGISTRANT_ID,
			"device-key-2",
			SEED_SIGN,
		);

		const tr = await renderScreen();

		// Lifecycle actions (Active status -> renew/suspend/revoke): present, disabled.
		for (const id of ["renew", "suspend", "revoke"]) {
			present(tr, `registrant-detail-lifecycle-${id}`);
			expect(isDisabled(tr, `registrant-detail-lifecycle-${id}`)).toBe(true);
		}

		// Association remove: present, disabled.
		present(tr, "association-remove-button-0");
		expect(isDisabled(tr, "association-remove-button-0")).toBe(true);

		// Attestation challenge expire: present, disabled.
		const expireTestID = `attestation-challenges-expire-trigger-${challenge.nonce}`;
		present(tr, expireTestID);
		expect(isDisabled(tr, expireTestID)).toBe(true);

		// The divergence is scoped to the private tier alone — everything above
		// stayed in the tree, unlike the private tier which vanished entirely.
		expect(countTestIDsMatching(tr, /^registrant-detail-private-row-/)).toBe(0);
	});

	// =========================================================================
	// GROUP B — D-12 selective tier and salt absence
	// =========================================================================

	describe("D-12 selective tier (scopes: ['vrg'])", () => {
		beforeEach(() => {
			mockOfficers = [{ userId: "device-user-1", authorityId: AUTHORITY_ID, title: "Registrar", scopes: ["vrg"] }];
		});

		it("D-12: the raw selective set renders unmasked with no reveal affordance", async () => {
			await seedRegistrant();
			const tr = await renderScreen();

			present(tr, "selective-field-row-email");
			present(tr, "selective-field-row-street");
			present(tr, "selective-field-row-county");
			const text = treeText(tr);
			expect(text).toContain("ada@example.test");
			expect(text).toContain("12 Elm");
			expect(text).toContain("Marion");

			// The contrast with the private tier: no reveal/mask affordance
			// (the private-tier testID family) lives inside the selective block.
			const selectiveSection = tr.root.findByProps({ testID: "registrant-detail-selective-tier" });
			const privateLike = selectiveSection.findAll(
				(node) => typeof node.props.testID === "string" && node.props.testID.startsWith("registrant-detail-private"),
			);
			expect(privateLike.length).toBe(0);
		});

		it("D-12: selecting an audience annotates EVERY raw field, never omitting the undisclosed ones", async () => {
			await seedRegistrant();
			mockElections = [{ id: ELECTION_ID }];
			await mockRegistrationEngine.enrollElectionRegistrant(ELECTION_ID, REGISTRANT_ID, SEED_SIGN);
			await mockRegistrationEngine.addElectionDisclosurePolicy(
				{ electionId: ELECTION_ID, fieldName: "email", audience: "everyone" },
				SEED_SIGN,
			);

			const tr = await renderScreen();
			await press(tr, "selective-audience-chip-everyone");

			const text = treeText(tr);
			const disclosedCount = (text.match(/registrantDetailSelectiveDisclosedLabel/g) ?? []).length;
			const notDisclosedCount = (text.match(/registrantDetailSelectiveNotDisclosedLabel/g) ?? []).length;
			// Omitting the undisclosed rows would still render a plausible
			// screen — this count is the exact defect D-12 rules out.
			expect(disclosedCount + notDisclosedCount).toBe(3);
			expect(disclosedCount).toBe(1);
			expect(notDisclosedCount).toBe(2);

			expect(JSON.stringify(findJsonNodeByTestID(tr.toJSON(), "selective-field-disclosure-email"))).toContain(
				"registrantDetailSelectiveDisclosedLabel",
			);
			expect(JSON.stringify(findJsonNodeByTestID(tr.toJSON(), "selective-field-disclosure-street"))).toContain(
				"registrantDetailSelectiveNotDisclosedLabel",
			);
			expect(JSON.stringify(findJsonNodeByTestID(tr.toJSON(), "selective-field-disclosure-county"))).toContain(
				"registrantDetailSelectiveNotDisclosedLabel",
			);

			// All three rows are still present — never filtered.
			present(tr, "selective-field-row-email");
			present(tr, "selective-field-row-street");
			present(tr, "selective-field-row-county");
		});

		it("D-12: switching audiences re-annotates rather than re-filtering", async () => {
			await seedRegistrant();
			mockElections = [{ id: ELECTION_ID }];
			await mockRegistrationEngine.enrollElectionRegistrant(ELECTION_ID, REGISTRANT_ID, SEED_SIGN);

			const tr = await renderScreen();
			await press(tr, "selective-audience-chip-district");

			const text = treeText(tr);
			const disclosedCount = (text.match(/registrantDetailSelectiveDisclosedLabel/g) ?? []).length;
			const notDisclosedCount = (text.match(/registrantDetailSelectiveNotDisclosedLabel/g) ?? []).length;
			expect(disclosedCount + notDisclosedCount).toBe(3);
			present(tr, "selective-field-row-email");
			present(tr, "selective-field-row-street");
			present(tr, "selective-field-row-county");
		});

		it("D-12/T-47-02: no salt appears in the rendered tree in ANY audience state", async () => {
			await seedRegistrant();
			mockElections = [{ id: ELECTION_ID }];
			await mockRegistrationEngine.enrollElectionRegistrant(ELECTION_ID, REGISTRANT_ID, SEED_SIGN);

			const tr = await renderScreen();

			// Comment: MockRegistrationEngine.getDisclosedSelective returns
			// `disclosed` leaves WITH their `salt` field populated, and the raw
			// `selectiveDetails` leaves carry salts too — the salt is in the DATA
			// on both paths; only the RENDER excludes it. This is why the check
			// below is load-bearing rather than decorative.
			const salts = [currentSalts.email, currentSalts.street, currentSalts.county];

			// State 1: no audience selected.
			for (const salt of salts) expect(treeText(tr)).not.toContain(salt);

			// State 2: everyone.
			await press(tr, "selective-audience-chip-everyone");
			for (const salt of salts) expect(treeText(tr)).not.toContain(salt);

			// State 3: district.
			await press(tr, "selective-audience-chip-district");
			for (const salt of salts) expect(treeText(tr)).not.toContain(salt);
		});

		it("D-12: an audience with no policy at all annotates every row Not-disclosed", async () => {
			await seedRegistrant();
			mockElections = []; // No election context resolvable — the disclosure===null leg.
			const disclosedSpy = jest.spyOn(mockRegistrationEngine, "getDisclosedSelective");

			const tr = await renderScreen();
			await press(tr, "selective-audience-chip-everyone");

			expect(disclosedSpy).toHaveBeenCalledTimes(0);
			const text = treeText(tr);
			expect((text.match(/registrantDetailSelectiveNotDisclosedLabel/g) ?? []).length).toBe(3);
			expect((text.match(/registrantDetailSelectiveDisclosedLabel/g) ?? []).length).toBe(0);
		});
	});

	// =========================================================================
	// GROUP C — D-10 lifecycle confirmations (scopes: ['vrg'])
	// =========================================================================

	describe("D-10 lifecycle confirmations (scopes: ['vrg'])", () => {
		beforeEach(() => {
			mockOfficers = [{ userId: "device-user-1", authorityId: AUTHORITY_ID, title: "Registrar", scopes: ["vrg"] }];
		});

		it("D-10: Suspend opens the TYPED confirm variant", async () => {
			await seedRegistrant();
			const tr = await renderScreen();

			await press(tr, "registrant-detail-lifecycle-suspend");
			present(tr, "registrant-detail-confirm-suspend-card");
			present(tr, "registrant-detail-confirm-suspend-typed-input");
			expect(treeText(tr)).toContain(DISPLAY_NAME);
		});

		it("D-10: Revoke also opens the TYPED variant — D-10 groups suspend and revoke together", async () => {
			// Treating Revoke alone as destructive is the misreading this test
			// exists to catch — Suspend must carry the SAME typed safeguard.
			await seedRegistrant();
			const tr = await renderScreen();

			await press(tr, "registrant-detail-lifecycle-revoke");
			present(tr, "registrant-detail-confirm-revoke-card");
			present(tr, "registrant-detail-confirm-revoke-typed-input");
			expect(treeText(tr)).toContain(DISPLAY_NAME);
		});

		it("D-10: Renew and Reinstate open the ORDINARY variant — no typed input", async () => {
			await seedRegistrant();
			const tr1 = await renderScreen();

			// Renew: the card does not exist until a valid date is set
			// (renderLifecycleCard's hasValidExpiration guard) — discovered from
			// shipped source, not guessed.
			await press(tr1, "registrant-detail-lifecycle-renew");
			present(tr1, "registrant-detail-renew-picker");
			absent(tr1, "registrant-detail-confirm-renew-card");

			const dateField = tr1.root.findByProps({ title: "registrantDetailExpirationLabel" });
			const newExpiration = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
			await renderer.act(async () => {
				dateField.props.onChange(newExpiration);
			});
			present(tr1, "registrant-detail-confirm-renew-card");
			absent(tr1, "registrant-detail-confirm-renew-typed-input");

			// Reinstate requires a suspended registrant first.
			await renderer.act(async () => {
				tr1.unmount();
			});
			await mockRegistrationEngine.changeStatus(REGISTRANT_ID, "s", SEED_SIGN);
			const tr2 = await renderScreen();
			await press(tr2, "registrant-detail-lifecycle-reinstate");
			present(tr2, "registrant-detail-confirm-reinstate-card");
			absent(tr2, "registrant-detail-confirm-reinstate-typed-input");
		});

		it("D-10: a DISMISSED confirmation fires ZERO engine calls", async () => {
			await seedRegistrant();
			const changeStatusSpy = jest.spyOn(mockRegistrationEngine, "changeStatus");
			const changeExpirationSpy = jest.spyOn(mockRegistrationEngine, "changeExpiration");

			const tr = await renderScreen();

			// Suspend, dismissed.
			await press(tr, "registrant-detail-lifecycle-suspend");
			present(tr, "registrant-detail-confirm-suspend-card");
			await press(tr, "registrant-detail-confirm-suspend-dismiss");

			expect(changeStatusSpy).toHaveBeenCalledTimes(0);
			expect(changeExpirationSpy).toHaveBeenCalledTimes(0);
			absent(tr, "registrant-detail-confirm-suspend-card");
			expect((await mockRegistrationEngine.getRegistrant(REGISTRANT_ID)).status).toBe("a");

			// Renew, dismissed (via the confirm card's own dismiss, after a valid date is set).
			await press(tr, "registrant-detail-lifecycle-renew");
			const dateField = tr.root.findByProps({ title: "registrantDetailExpirationLabel" });
			await renderer.act(async () => {
				dateField.props.onChange(new Date(Date.now() + 86400000).toISOString());
			});
			present(tr, "registrant-detail-confirm-renew-card");
			await press(tr, "registrant-detail-confirm-renew-dismiss");

			expect(changeStatusSpy).toHaveBeenCalledTimes(0);
			expect(changeExpirationSpy).toHaveBeenCalledTimes(0);
			absent(tr, "registrant-detail-confirm-renew-card");
			const registrant = await mockRegistrationEngine.getRegistrant(REGISTRANT_ID);
			expect(registrant.status).toBe("a");
			expect(registrant.expiration).toBe(FUTURE_ISO);
		});

		it("D-10: the typed confirm stays disabled until the typed name matches, then one call reaches the engine", async () => {
			await seedRegistrant();
			const changeStatusSpy = jest.spyOn(mockRegistrationEngine, "changeStatus");
			const tr = await renderScreen();

			await press(tr, "registrant-detail-lifecycle-suspend");
			expect(isDisabled(tr, "registrant-detail-confirm-suspend-confirm")).toBe(true);

			typeInto(tr, "registrant-detail-confirm-suspend-typed-input", "wrong name");
			expect(isDisabled(tr, "registrant-detail-confirm-suspend-confirm")).toBe(true);
			expect(changeStatusSpy).toHaveBeenCalledTimes(0);

			// matchesConfirmationName's case-insensitive trim contract.
			typeInto(tr, "registrant-detail-confirm-suspend-typed-input", "  VASQUEZ, ada  ");
			expect(isDisabled(tr, "registrant-detail-confirm-suspend-confirm")).toBe(false);

			await press(tr, "registrant-detail-confirm-suspend-confirm");

			expect(changeStatusSpy).toHaveBeenCalledTimes(1);
			expect(changeStatusSpy).toHaveBeenCalledWith(REGISTRANT_ID, "s", expect.any(Function));
			expect((await mockRegistrationEngine.getRegistrant(REGISTRANT_ID)).status).toBe("s");
		});

		// Regression: 47-UAT.md test 12 (blocker), found on device.
		//
		// Both typed actions render through the SAME <LifecycleConfirmCard>
		// element at the same position in RegistrantDetailScreen. Switching
		// pendingAction suspend -> revoke swaps the props but does NOT unmount
		// the element, so without a `key` React reconciles them as one
		// instance and the card's internal `typedValue` carries over. An
		// officer who typed the registrant's name to arm SUSPEND and then
		// pressed REVOKE instead — permanent, no undo — arrived already armed,
		// having typed nothing for that action.
		//
		// The pre-existing coverage could not catch this: the component-level
		// tests mount ONE card in isolation, and the "dismissed fires zero
		// engine calls" test above goes suspend -> dismiss -> renew, where the
		// dismiss unmounts the card (pendingAction becomes undefined) and it
		// never types anything first, so no typed value ever exists to carry.
		// Only a DIRECT switch between the two typed actions keeps the element
		// mounted with a satisfied gate.
		it("D-10: switching from one typed action to the other does not carry the typed name over", async () => {
			await seedRegistrant();
			const changeStatusSpy = jest.spyOn(mockRegistrationEngine, "changeStatus");
			const tr = await renderScreen();

			// Arm SUSPEND with the exact name, then — WITHOUT dismissing —
			// change our mind and press REVOKE. The lifecycle action buttons
			// stay rendered above the open card, so this is an ordinary thing
			// to do. Dismissing first would set pendingAction to undefined and
			// unmount the card, which resets its state anyway; switching
			// directly is what keeps the element mounted and is the path that
			// was actually broken.
			await press(tr, "registrant-detail-lifecycle-suspend");
			typeInto(tr, "registrant-detail-confirm-suspend-typed-input", DISPLAY_NAME);
			expect(isDisabled(tr, "registrant-detail-confirm-suspend-confirm")).toBe(false);

			await press(tr, "registrant-detail-lifecycle-revoke");
			present(tr, "registrant-detail-confirm-revoke-card");
			absent(tr, "registrant-detail-confirm-suspend-card");

			// The typed field must be empty and the gate must be closed. Both
			// are asserted: an empty input with an enabled button, or a
			// pre-filled input, are each independently the defect.
			expect(tr.root.findByProps({ testID: "registrant-detail-confirm-revoke-typed-input" }).props.value).toBe("");
			expect(isDisabled(tr, "registrant-detail-confirm-revoke-confirm")).toBe(true);

			// And the armed-by-inheritance path must reach no engine call.
			await press(tr, "registrant-detail-confirm-revoke-confirm");
			expect(changeStatusSpy).toHaveBeenCalledTimes(0);
			expect((await mockRegistrationEngine.getRegistrant(REGISTRANT_ID)).status).toBe("a");
		});

		// Sibling of the typed-action test above, for the ORDINARY pair. The
		// re-audit (47-SECURITY.md, D-10-SITE-3) found renew and reinstate are
		// also early returns at the same tree position, and ARE co-reachable —
		// on a suspended registrant the screen offers renew, reinstate and
		// revoke together. Unkeyed, switching between them reuses one instance,
		// carrying submitState / submittingRef rather than typedValue.
		//
		// That direction is fail-SAFE (a confirm stuck disabled, never one
		// wrongly enabled), so this is robustness rather than a security lock —
		// but the fix shipped with nothing holding it, which is what this test
		// is for. Without key={pendingAction} on those two branches, the
		// reinstate card inherits the renew card's in-flight `submitting` state
		// and renders disabled with no way forward.
		it("D-10: switching between the two ordinary actions yields a fresh, usable card", async () => {
			await seedRegistrant();
			await mockRegistrationEngine.changeStatus(REGISTRANT_ID, "s", SEED_SIGN);

			// Hold the renew write open so the card is genuinely mid-submit.
			let releaseRenew: () => void = () => {};
			jest
				.spyOn(mockRegistrationEngine, "changeExpiration")
				.mockImplementation(() => new Promise<void>((resolve) => {
					releaseRenew = resolve;
				}));

			const tr = await renderScreen();

			await press(tr, "registrant-detail-lifecycle-renew");
			const dateField = tr.root.findByProps({ title: "registrantDetailExpirationLabel" });
			await renderer.act(async () => {
				dateField.props.onChange(new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000).toISOString());
			});
			present(tr, "registrant-detail-confirm-renew-card");
			await press(tr, "registrant-detail-confirm-renew-confirm");
			// Renew is now latched submitting (its own write has not resolved).
			expect(isDisabled(tr, "registrant-detail-confirm-renew-confirm")).toBe(true);

			// Switch to the other ordinary action without the first resolving.
			await press(tr, "registrant-detail-lifecycle-reinstate");
			present(tr, "registrant-detail-confirm-reinstate-card");

			// It must be a FRESH card: usable, not inheriting renew's latch.
			expect(isDisabled(tr, "registrant-detail-confirm-reinstate-confirm")).toBe(false);

			releaseRenew();
			await flushTicks(4);
		});

		it("D-10: the dismiss label is never a bare Cancel", async () => {
			await seedRegistrant();
			const tr = await renderScreen();

			await press(tr, "registrant-detail-lifecycle-suspend");
			const dismissWrapper = tr.root.findByProps({ testID: "registrant-detail-confirm-suspend-dismiss" });
			const button = dismissWrapper.findAll((n) => typeof n.props.title === "string")[0]!;
			// Rides the exported 47-10 helper rather than re-deriving the rule.
			expect(isBareDismissLabel(button.props.title)).toBe(false);
		});
	});

	// =========================================================================
	// GROUP D — the never-log rule, end to end
	// =========================================================================

	describe("T-47-02 never-log rule", () => {
		it("no console method is called across a full reveal / audience-switch / confirm-dismiss cycle", async () => {
			const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
			const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
			const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
			const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
			const debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
			try {
				// useCurrentOfficerScopes legitimately console.warns on a FAILED
				// officer walk — this fixture must stay healthy (a matching
				// Officer row for device-user-1), or this test regresses on that
				// warning; the fix in that case is the fixture, never narrowing
				// the spy set.
				mockOfficers = [{ userId: "device-user-1", authorityId: AUTHORITY_ID, title: "Registrar", scopes: ["vrg"] }];
				await seedRegistrant();
				mockElections = [{ id: ELECTION_ID }];
				await mockRegistrationEngine.enrollElectionRegistrant(ELECTION_ID, REGISTRANT_ID, SEED_SIGN);

				const tr = await renderScreen();

				await press(tr, "registrant-detail-private-toggle-ssn");
				await press(tr, "registrant-detail-private-toggle-dob");
				await press(tr, "registrant-detail-private-toggle-phone");

				await press(tr, "selective-audience-chip-everyone");

				await press(tr, "registrant-detail-lifecycle-suspend");
				present(tr, "registrant-detail-confirm-suspend-card");
				await press(tr, "registrant-detail-confirm-suspend-dismiss");

				for (const spy of [logSpy, warnSpy, errorSpy, infoSpy, debugSpy]) {
					expect(spy).toHaveBeenCalledTimes(0);
				}
			} finally {
				logSpy.mockRestore();
				warnSpy.mockRestore();
				errorSpy.mockRestore();
				infoSpy.mockRestore();
				debugSpy.mockRestore();
			}
		});

		it("revealing every private field puts no VALUE anywhere except the revealed row itself", async () => {
			mockOfficers = [{ userId: "device-user-1", authorityId: AUTHORITY_ID, title: "Registrar", scopes: ["vrg"] }];
			await seedRegistrant();
			const tr = await renderScreen();

			await press(tr, "registrant-detail-private-toggle-ssn");
			await press(tr, "registrant-detail-private-toggle-dob");
			await press(tr, "registrant-detail-private-toggle-phone");

			const text = treeText(tr);
			for (const value of [SSN_VALUE, DOB_VALUE, PHONE_VALUE]) {
				const occurrences = text.split(value).length - 1;
				expect(occurrences).toBe(1);
			}

			// Never inside an accessibilityLabel or a testID string.
			const suspiciousNodes = tr.root.findAll((node) => {
				const label = node.props.accessibilityLabel;
				const testID = node.props.testID;
				return (
					(typeof label === "string" && [SSN_VALUE, DOB_VALUE, PHONE_VALUE].some((v) => label.includes(v))) ||
					(typeof testID === "string" && [SSN_VALUE, DOB_VALUE, PHONE_VALUE].some((v) => testID.includes(v)))
				);
			});
			expect(suspiciousNodes.length).toBe(0);
		});
	});
});
