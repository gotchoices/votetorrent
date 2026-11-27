/**
 * RegistrantDetailScreen.selectiveSealed.test.tsx — Phase 62 Plan 37 (D-52, D-51).
 *
 * The Selective tier: sealed details this device cannot open render an explicit state, never an
 * empty audience preview, never offer disclosure, and never leak a value or salt.
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
const LEAVES = [{ name: "Party", value: VALUE_SENTINEL, salt: "SALT_SENTINEL_1" }];

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

const UNREAD: Array<[RegistrationContentAccess, string]> = [
	["not-a-recipient", "registrantSelectiveNotRecipient"],
	["no-opener", "registrationContentNoKey"],
	["unreadable", "registrantSelectiveUnreadable"],
	["tampered", "registrantSelectiveTampered"],
];

describe("RegistrantDetailScreen — sealed selective tier (D-52, D-51)", () => {
	describe.each(UNREAD)("R1/R2: detailsAccess %s", (access, key) => {
		it("renders the catalog copy, no audience preview, no leak, never calls getDisclosedSelective", async () => {
			await seed(mockRegistrationEngine);
			stubSelective(selTier({ detailsAccess: access, selectiveDetails: undefined, rawLeaves: LEAVES, leaked: VALUE_SENTINEL }));
			const tr = await renderScreen();
			present(tr, "registrant-detail-selective-tier");
			expect(textOf(hostNode(tr, "registrant-detail-selective-unread"))).toBe(key);
			absent(tr, "selective-audience-preview");
			absent(tr, "selective-audience-chip-everyone");
			absent(tr, "selective-audience-chip-district");
			absent(tr, "selective-audience-preview-empty");
			expect(treeText(tr)).not.toContain("registrantDetailNoSelectiveTier");
			expect(treeText(tr)).not.toContain(VALUE_SENTINEL);
			expect(treeText(tr)).not.toContain("SALT_SENTINEL_1");
			expect(textOf(hostNode(tr, "registrant-detail-error"))).toBe("");
			expect(getDisclosed).not.toHaveBeenCalled();
			for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
		});
	});

	describe.each(["opened", "unsealed", undefined])("R3: readable (%s)", (access) => {
		it("renders the preview with leaves and calls getDisclosedSelective once on select", async () => {
			await seed(mockRegistrationEngine);
			stubSelective(selTier({ ...(access ? { detailsAccess: access } : {}), selectiveDetails: LEAVES }));
			const tr = await renderScreen();
			present(tr, "selective-audience-preview");
			present(tr, "selective-field-row-Party");
			absent(tr, "registrant-detail-selective-unread");
			await press(tr, "selective-audience-chip-everyone");
			expect(getDisclosed).toHaveBeenCalledTimes(1);
		});
	});

	it("R4: an unread DisclosedSelective renders no disclosed or hidden leaf and no annotation", async () => {
		await seed(mockRegistrationEngine);
		stubSelective(selTier({ detailsAccess: "opened", selectiveDetails: LEAVES }));
		getDisclosed.mockResolvedValue({
			access: "not-a-recipient",
			root: "",
			disclosed: [{ name: LEAK_NAME, value: VALUE_SENTINEL + "_D", salt: "SALT_D" }],
			hidden: ["HIDDEN_DIGEST_SENTINEL"],
		} as never);
		const tr = await renderScreen();
		await press(tr, "selective-audience-chip-everyone");
		expect(getDisclosed).toHaveBeenCalledTimes(1);
		const text = treeText(tr);
		expect(text).not.toContain(LEAK_NAME);
		expect(text).not.toContain(VALUE_SENTINEL + "_D");
		expect(text).not.toContain("HIDDEN_DIGEST_SENTINEL");
		expect(tr.root.findAll((n) => String(n.props.testID ?? "").startsWith("selective-field-disclosure-")).length).toBe(0);
		for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
	});
});
