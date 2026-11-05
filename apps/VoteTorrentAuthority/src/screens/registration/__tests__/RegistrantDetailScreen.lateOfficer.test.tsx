/**
 * RegistrantDetailScreen.lateOfficer.test.tsx — 62-144 (D-51, late-officer ruling).
 *
 * The Selective and Private tiers of a registrant this device cannot open:
 *  - L1/L2: `not-a-recipient` keeps its existing line and adds the late-officer explanation.
 *  - L3: `no-opener`, `unreadable`, `tampered` and `opened` render their own state and no
 *    explanation.
 *  - L6: the Spanish and English explanation copy.
 *  - L7: for every sealed state, even when the engine hands back the sealed content, no value,
 *    field name or salt reaches the tree or any console channel, no audience preview is rendered
 *    and no disclosure is requested.
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
let mockTOverrides: Record<string, string> = {};

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
			mockTOverrides[key] !== undefined
				? mockTOverrides[key]
				: options && Object.keys(options).length > 0
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


// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
	MockRegistrationEngine,
} = require("../../../../../../packages/vote-engine/dist/registration/mock-registration-engine");
import type { RegistrantSelective, RegistrationContentAccess } from "@votetorrent/vote-core";

const SEED_SIGN = async () => ({ signature: "seed-sig", signerKey: "seed-key", signerUserId: "seed-user" });
const VALUE_SENTINEL = "SELECTIVE_VALUE_SENTINEL";
const LEAK_NAME = "LEAK_NAME_SENTINEL";

async function flushTicks(count: number): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < count; i++) await Promise.resolve();
	});
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Screen = require("../RegistrantDetailScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<Screen />);
	});
	await flushTicks(8);
	return tr;
}

function hostNode(tr: renderer.ReactTestRenderer, testID: string): renderer.ReactTestInstance {
	const found = tr.root.findAll((n) => n.props.testID === testID && typeof n.type === "string");
	expect(found.length).toBeGreaterThan(0);
	return found[0]!;
}
function present(tr: renderer.ReactTestRenderer, testID: string): void {
	expect(tr.root.findAll((n) => n.props.testID === testID).length).toBeGreaterThan(0);
}
function absent(tr: renderer.ReactTestRenderer, testID: string): void {
	expect(tr.root.findAll((n) => n.props.testID === testID).length).toBe(0);
}
function treeText(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}
function textOf(node: renderer.ReactTestInstance): string {
	return node
		.findAll((n) => typeof n.type === "string")
		.flatMap((n) => n.children.filter((c): c is string => typeof c === "string"))
		.join("");
}
async function press(tr: renderer.ReactTestRenderer, testID: string): Promise<void> {
	const wrapper = tr.root.findByProps({ testID });
	const candidates = wrapper.findAll(
		(node) => typeof node.props.onPressIn === "function" || typeof node.props.onPress === "function"
	);
	expect(candidates.length).toBeGreaterThan(0);
	const target = candidates[0]!;
	await renderer.act(async () => {
		if (typeof target.props.onPressIn === "function") target.props.onPressIn();
		else target.props.onPress();
	});
	await flushTicks(4);
}

async function seed(engine: any): Promise<void> {
	await engine.register(
		{
			registrant: { id: REGISTRANT_ID, authorityId: AUTHORITY_ID, expiration: FUTURE_ISO },
			public: { lastName: "Doe", firstName: "Jane" },
			private: { expiration: FUTURE_ISO, details: [{ name: "SSN", value: "000-00-0000" }] },
		},
		SEED_SIGN
	);
}

function selTier(overrides: Record<string, unknown>): RegistrantSelective {
	return { cid: "cid-1", registrantId: REGISTRANT_ID, ...overrides } as RegistrantSelective;
}
const LEAVES = [{ name: "Party", value: VALUE_SENTINEL, salt: SALT_SENTINEL }];

let consoleSpies: jest.SpyInstance[] = [];
let getDisclosed: jest.SpyInstance;

beforeEach(() => {
	jest.clearAllMocks();
	mockRegistrationEngine = new MockRegistrationEngine();
	mockTOverrides = {};
	mockScopesResult = { scopes: ["vrg"], loading: false };
	mockDeviceUser = { id: "u-officer-1" };
	mockElections = [{ id: "election-1" }];
	jest.spyOn(AppState, "addEventListener").mockImplementation((() => ({ remove: jest.fn() })) as never);
	consoleSpies = [
		jest.spyOn(console, "log").mockImplementation(() => {}),
		jest.spyOn(console, "warn").mockImplementation(() => {}),
		jest.spyOn(console, "error").mockImplementation(() => {}),
	];
	jest.spyOn(mockRegistrationEngine, "getElectionRegistrants").mockResolvedValue([{ registrantId: REGISTRANT_ID }] as never);
	getDisclosed = jest.spyOn(mockRegistrationEngine, "getDisclosedSelective");
});

afterEach(() => {
	jest.restoreAllMocks();
});

function stubSelective(value: RegistrantSelective | undefined): void {
	jest.spyOn(mockRegistrationEngine, "getRegistrantSelective").mockResolvedValue(value as never);
}

function stubPrivate(value: unknown): void {
	jest.spyOn(mockRegistrationEngine, "getRegistrantPrivate").mockResolvedValue(value as never);
}
function privTier(overrides: Record<string, unknown>): unknown {
	return { cid: "cid-1", registrantId: REGISTRANT_ID, expiration: FUTURE_ISO, privateDetails: [], ...overrides };
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resources } = require("../../../i18n");

describe("RegistrantDetailScreen — late officer explanation (D-51, NEVER ruling)", () => {
	it("L1. private tier not-a-recipient: existing line, then the explanation", async () => {
		await seed(mockRegistrationEngine);
		stubPrivate(privTier({ detailsAccess: "not-a-recipient" }));
		stubSelective(selTier({ detailsAccess: "opened", selectiveDetails: LEAVES }));
		const tr = await renderScreen();
		expect(textOf(hostNode(tr, "registrant-detail-private-sealed"))).toBe("registrantPrivateNotRecipient");
		expect(textOf(hostNode(tr, "registrant-detail-private-late-officer"))).toBe("sealedBeforeOfficerExplanation");
	});

	it("L2. selective tier not-a-recipient: existing line, then the explanation", async () => {
		await seed(mockRegistrationEngine);
		stubPrivate(privTier({ detailsAccess: "opened" }));
		stubSelective(selTier({ detailsAccess: "not-a-recipient", selectiveDetails: undefined }));
		const tr = await renderScreen();
		expect(textOf(hostNode(tr, "registrant-detail-selective-unread"))).toBe("registrantSelectiveNotRecipient");
		expect(textOf(hostNode(tr, "registrant-detail-selective-late-officer"))).toBe("sealedBeforeOfficerExplanation");
	});

	// WR-R6-06: each absence check is anchored on the state it claims to test having rendered, so a
	// stub drift that leaves a tier unrendered (or in an error state) cannot pass vacuously.
	const L3_PRIVATE_ANCHOR: Record<string, string> = {
		"no-opener": "registrant-detail-private-sealed-no-key",
		unreadable: "registrant-detail-private-sealed-unreadable",
		tampered: "registrant-detail-private-sealed-unreadable",
		opened: "registrant-detail-private-empty",
	};
	it.each(["no-opener", "unreadable", "tampered", "opened"])("L3. %s renders no explanation", async (access) => {
		await seed(mockRegistrationEngine);
		stubPrivate(privTier({ detailsAccess: access }));
		stubSelective(selTier({ detailsAccess: access, selectiveDetails: access === "opened" ? LEAVES : undefined }));
		const tr = await renderScreen();
		// Positive anchors: the tier states under test actually rendered.
		present(tr, L3_PRIVATE_ANCHOR[access]!);
		if (access === "opened") {
			absent(tr, "registrant-detail-private-sealed");
			absent(tr, "registrant-detail-selective-unread");
			present(tr, "registrant-detail-selective-tier");
		} else {
			present(tr, "registrant-detail-private-sealed");
			present(tr, "registrant-detail-selective-unread");
		}
		expect(consoleSpies[2]).not.toHaveBeenCalled();
		absent(tr, "registrant-detail-private-late-officer");
		absent(tr, "registrant-detail-selective-late-officer");
		expect(treeText(tr)).not.toContain("sealedBeforeOfficerExplanation");
	});

	it.each(["not-a-recipient", "no-opener", "unreadable", "tampered"])(
		"L7. %s: no value, field name or salt leaks, no audience preview, no disclosure",
		async (access) => {
			await seed(mockRegistrationEngine);
			stubPrivate(
				privTier({
					detailsAccess: access,
					// A buggy or hostile engine that hands back the sealed content anyway.
					privateDetails: [
						{ name: "SSN", value: SSN_SENTINEL },
						{ name: "DOB", value: DOB_SENTINEL },
						{ name: LEAK_NAME, value: PHONE_SENTINEL },
					],
				})
			);
			stubSelective(selTier({ detailsAccess: access, selectiveDetails: LEAVES }));
			const tr = await renderScreen();
			// Positive anchors: both tiers rendered their sealed state.
			present(tr, "registrant-detail-private-sealed");
			present(tr, "registrant-detail-selective-unread");
			absent(tr, "selective-audience-preview");
			expect(getDisclosed).not.toHaveBeenCalled();
			const tree = treeText(tr);
			const logged = JSON.stringify(consoleSpies.map((spy) => spy.mock.calls));
			for (const sentinel of [SSN_SENTINEL, DOB_SENTINEL, PHONE_SENTINEL, SALT_SENTINEL, LEAK_NAME, VALUE_SENTINEL]) {
				expect(tree).not.toContain(sentinel);
				expect(logged).not.toContain(sentinel);
			}
		}
	);

	it("L6. the Spanish copy names the funcionario and the English copy says never", () => {
		expect(resources.es.translation.sealedBeforeOfficerExplanation).toContain("funcionario");
		expect(resources.en.translation.sealedBeforeOfficerExplanation).toContain("never");
	});
});
