/**
 * RegistrantDetailScreen keyboard inset: its typed LifecycleConfirmCard holds a text
 * input inside the ScrollView, so under forced edge-to-edge (targetSdk 35, where
 * adjustResize is inert) the shell must pad by the IME height so the ScrollView
 * viewport ends at the top of the keyboard and the input can be scrolled into view.
 * Mocks copied from RegistrantDetailScreen.test.tsx; the screen renders its main
 * ScrollView even with an empty engine (there are no early-return branches).
 */

import React from "react";
import renderer from "react-test-renderer";
import { AppState, Keyboard, Platform, ScrollView, View } from "react-native";

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

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Screen = require("../RegistrantDetailScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<Screen />);
	});
	await renderer.act(async () => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	});
	return tr;
}

let handlers: Record<string, ((e?: unknown) => void)[]>;
const originalVersion = Platform.Version;
const originalOS = Platform.OS;

beforeEach(() => {
	jest.clearAllMocks();
	mockRegistrationEngine = new MockRegistrationEngine();
	handlers = {};
	jest.spyOn(AppState, "addEventListener").mockImplementation((() => ({ remove: jest.fn() })) as never);
	jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, cb: any) => {
		(handlers[event] ??= []).push(cb);
		return { remove: jest.fn() };
	}) as any);
	Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
	Object.defineProperty(Platform, "Version", { value: 35, configurable: true });
});

afterEach(() => {
	jest.restoreAllMocks();
	Object.defineProperty(Platform, "OS", { value: originalOS, configurable: true });
	Object.defineProperty(Platform, "Version", { value: originalVersion, configurable: true });
});

function flatten(style: any): Record<string, any> {
	if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
	return style ?? {};
}

function shell(tr: renderer.ReactTestRenderer) {
	return tr.root.findAll((n) => n.type === View && n.props.testID === "registrant-detail-screen")[0];
}

describe("RegistrantDetailScreen keyboard inset", () => {
	it("RD1: shell pads by the keyboard height and still wraps the ScrollView with its own contentContainerStyle", async () => {
		const tr = await renderScreen();
		expect(flatten(shell(tr).props.style).paddingBottom).toBe(0);
		await renderer.act(async () => {
			handlers["keyboardDidShow"]?.forEach((cb) => cb({ endCoordinates: { height: 280 } }));
		});
		expect(flatten(shell(tr).props.style).paddingBottom).toBe(280);
		const scroll = shell(tr).findAllByType(ScrollView);
		expect(scroll.length).toBeGreaterThan(0);
		expect(flatten(scroll[0]!.props.contentContainerStyle).paddingBottom).toBe(24);
	});

	it("RD2: keyboardDidHide releases the padding", async () => {
		const tr = await renderScreen();
		await renderer.act(async () => {
			handlers["keyboardDidShow"]?.forEach((cb) => cb({ endCoordinates: { height: 280 } }));
		});
		await renderer.act(async () => {
			handlers["keyboardDidHide"]?.forEach((cb) => cb());
		});
		expect(flatten(shell(tr).props.style).paddingBottom).toBe(0);
	});
});
