/**
 * RegistrantDetailScreen.sealedContent.test.tsx — Phase 62 Plan 32 Task 2 (D-49, D-51).
 *
 * The Private tier's unread states: a registrant's sealed private details that this device cannot
 * open (late officer / no key / unreadable / tampered) render as an explicit, visible state and
 * NEVER as "No private details recorded", and never leak a value, a ciphertext or a failure detail.
 * The engine is the real MockRegistrationEngine with `getRegistrantPrivate` driven per test.
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
import { StyleSheet } from "react-native";
import type { RegistrantPrivate, RegistrationContentAccess } from "@votetorrent/vote-core";
import {
	privateTierReadState,
	PRIVATE_TIER_READ_STATE_COPY,
} from "../registrant-detail-model";

const SEED_SIGN = async () => ({ signature: "seed-sig", signerKey: "seed-key", signerUserId: "seed-user" });
const CIPHERTEXT_SENTINEL = "vt-env-1:CIPHERTEXT-SENTINEL";

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

async function seed(engine: any): Promise<void> {
	await engine.register(
		{
			registrant: { id: REGISTRANT_ID, authorityId: AUTHORITY_ID, expiration: FUTURE_ISO },
			public: { lastName: "Doe", firstName: "Jane" },
			private: { expiration: FUTURE_ISO, details: [{ name: "SSN", value: SSN_SENTINEL }] },
		},
		SEED_SIGN
	);
}

function tier(overrides: Partial<RegistrantPrivate> & Record<string, unknown>): RegistrantPrivate {
	return { cid: "cid-1", registrantId: REGISTRANT_ID, expiration: FUTURE_ISO, privateDetails: [], ...overrides } as RegistrantPrivate;
}

let consoleSpies: jest.SpyInstance[] = [];

beforeEach(() => {
	jest.clearAllMocks();
	mockRegistrationEngine = new MockRegistrationEngine();
	mockTOverrides = {};
	mockScopesResult = { scopes: ["vrg"], loading: false };
	mockDeviceUser = { id: "u-officer-1" };
	mockAssociationsProps = null;
	mockAttestationProps = null;
	mockAccessHistoryProps = null;
	jest.spyOn(AppState, "addEventListener").mockImplementation((() => ({ remove: jest.fn() })) as never);
	consoleSpies = [
		jest.spyOn(console, "log").mockImplementation(() => {}),
		jest.spyOn(console, "warn").mockImplementation(() => {}),
		jest.spyOn(console, "error").mockImplementation(() => {}),
	];
});

afterEach(() => {
	jest.restoreAllMocks();
});

function stubPrivate(value: RegistrantPrivate | undefined): void {
	jest.spyOn(mockRegistrationEngine, "getRegistrantPrivate").mockResolvedValue(value as never);
}

const UNREAD: Array<[RegistrationContentAccess, "not-a-recipient" | "no-key" | "unreadable", string]> = [
	["not-a-recipient", "not-a-recipient", "registrantPrivateNotRecipient"],
	["no-opener", "no-key", "registrationContentNoKey"],
	["unreadable", "unreadable", "registrantPrivateUnreadable"],
	["tampered", "unreadable", "registrantPrivateUnreadable"],
];

describe("privateTierReadState (M1)", () => {
	it("maps every RegistrationContentAccess value", () => {
		expect(privateTierReadState(undefined)).toBe("readable");
		expect(privateTierReadState("opened")).toBe("readable");
		expect(privateTierReadState("unsealed")).toBe("readable");
		expect(privateTierReadState("not-a-recipient")).toBe("not-a-recipient");
		expect(privateTierReadState("no-opener")).toBe("no-key");
		expect(privateTierReadState("unreadable")).toBe("unreadable");
		expect(privateTierReadState("tampered")).toBe("unreadable");
	});
	it("pins the copy keys", () => {
		expect(PRIVATE_TIER_READ_STATE_COPY).toEqual({
			"not-a-recipient": "registrantPrivateNotRecipient",
			"no-key": "registrationContentNoKey",
			unreadable: "registrantPrivateUnreadable",
		});
	});
});

describe("RegistrantDetailScreen — sealed private tier (D-49, D-51)", () => {
	describe.each(UNREAD)("S1: detailsAccess %s", (access, state, key) => {
		it("renders the explicit state, not the empty record, and no field rows", async () => {
			await seed(mockRegistrationEngine);
			stubPrivate(tier({ detailsAccess: access }));
			const tr = await renderScreen();
			present(tr, "registrant-detail-private-sealed");
			present(tr, "registrant-detail-private-sealed-" + state);
			expect(textOf(hostNode(tr, "registrant-detail-private-sealed-text"))).toBe(key);
			absent(tr, "registrant-detail-private-empty");
			expect(treeText(tr)).not.toContain("registrantDetailNoPrivateTier");
			expect(tr.root.findAll((n) => String(n.props.testID ?? "").startsWith("registrant-detail-private-row-")).length).toBe(0);
		});
	});

	describe.each(["opened", "unsealed", undefined])("S2: readable (%s)", (access) => {
		it("renders field rows exactly as before and no sealed block", async () => {
			await seed(mockRegistrationEngine);
			stubPrivate(
				tier({
					...(access ? { detailsAccess: access } : {}),
					privateDetails: [
						{ name: "SSN", value: SSN_SENTINEL },
						{ name: "DOB", value: DOB_SENTINEL },
					],
				} as never)
			);
			const tr = await renderScreen();
			present(tr, "registrant-detail-private-row-SSN");
			present(tr, "registrant-detail-private-row-DOB");
			absent(tr, "registrant-detail-private-sealed");
		});
	});

	it("S2: an empty readable tier still shows the empty state", async () => {
		await seed(mockRegistrationEngine);
		stubPrivate(tier({ detailsAccess: "opened", privateDetails: [] }));
		const tr = await renderScreen();
		present(tr, "registrant-detail-private-empty");
		absent(tr, "registrant-detail-private-sealed");
	});

	describe("S3: no leakage", () => {
		it("not-a-recipient with rows attached: no row, no sentinel, no error, no trail event, no console", async () => {
			await seed(mockRegistrationEngine);
			const record = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");
			stubPrivate(tier({ detailsAccess: "not-a-recipient", privateDetails: [{ name: "SSN", value: SSN_SENTINEL }] }));
			const tr = await renderScreen();
			expect(treeText(tr)).not.toContain(SSN_SENTINEL);
			absent(tr, "registrant-detail-private-row-SSN");
			expect(textOf(hostNode(tr, "registrant-detail-error"))).toBe("");
			await renderer.act(async () => {
				tr.unmount();
			});
			await flushTicks(4);
			expect(record).not.toHaveBeenCalled();
			for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
		});

		it("unreadable with an off-contract ciphertext field: nothing from the record is rendered", async () => {
			await seed(mockRegistrationEngine);
			const record = jest.spyOn(mockRegistrationEngine, "recordRegistrantAccessEvent");
			stubPrivate(
				tier({
					detailsAccess: "unreadable",
					privateDetails: [{ name: "SSN", value: SSN_SENTINEL }],
					rawPrivateDetails: CIPHERTEXT_SENTINEL,
				})
			);
			const tr = await renderScreen();
			const text = treeText(tr);
			expect(text).not.toContain(CIPHERTEXT_SENTINEL);
			expect(text).not.toContain(SSN_SENTINEL);
			absent(tr, "registrant-detail-private-row-SSN");
			expect(textOf(hostNode(tr, "registrant-detail-error"))).toBe("");
			await renderer.act(async () => {
				tr.unmount();
			});
			await flushTicks(4);
			expect(record).not.toHaveBeenCalled();
			for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
		});
	});

	describe("S4: gate precedence", () => {
		it("without 'vrg' the gate renders, the private read is never issued, no sealed block", async () => {
			await seed(mockRegistrationEngine);
			mockScopesResult = { scopes: ["mel"], loading: false };
			const read = jest.spyOn(mockRegistrationEngine, "getRegistrantPrivate");
			const tr = await renderScreen();
			present(tr, "registrant-detail-private-gate");
			absent(tr, "registrant-detail-private-sealed");
			expect(read).not.toHaveBeenCalled();
		});

		it("revising scopes away while a sealed state shows replaces it with the gate", async () => {
			await seed(mockRegistrationEngine);
			stubPrivate(tier({ detailsAccess: "not-a-recipient" }));
			const tr = await renderScreen();
			present(tr, "registrant-detail-private-sealed");
			mockScopesResult = { scopes: [], loading: false };
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const Screen = require("../RegistrantDetailScreen").default;
			await renderer.act(async () => {
				tr.update(<Screen />);
			});
			await flushTicks(4);
			absent(tr, "registrant-detail-private-sealed");
			present(tr, "registrant-detail-private-gate");
		});
	});

	describe.each(UNREAD)("S5: not hidden (%s)", (access) => {
		it("keeps the section, title, lifecycle controls and access history", async () => {
			await seed(mockRegistrationEngine);
			stubPrivate(tier({ detailsAccess: access }));
			const tr = await renderScreen();
			present(tr, "registrant-detail-private-tier");
			expect(textOf(hostNode(tr, "registrant-detail-private-tier"))).toContain("registrantDetailPrivateTierTitle");
			const lifecycle = tr.root.findAll(
				(n) => String(n.props.testID ?? "").startsWith("registrant-detail-lifecycle-") && typeof n.type === "string"
			);
			expect(lifecycle.length).toBeGreaterThan(0);
			for (const wrap of lifecycle) {
				const disabledNode = [wrap, ...wrap.findAll(() => true)].find((n) => "disabled" in n.props);
				expect(disabledNode?.props.disabled).toBe(false);
			}
			present(tr, "access-history-section");
			expect(mockAccessHistoryProps.canView).toBe(true);
		});
	});

	describe("S6: geometry", () => {
		async function renderSealed(): Promise<renderer.ReactTestRenderer> {
			await seed(mockRegistrationEngine);
			stubPrivate(tier({ detailsAccess: "not-a-recipient" }));
			return renderScreen();
		}

		it("the block is a flex-start row", async () => {
			const tr = await renderSealed();
			const style = StyleSheet.flatten(hostNode(tr, "registrant-detail-private-sealed").props.style);
			expect(style.flexDirection).toBe("row");
			expect(style.alignItems).toBe("flex-start");
		});

		it("the text shrinks and is never truncated", async () => {
			const tr = await renderSealed();
			const text = hostNode(tr, "registrant-detail-private-sealed-text");
			expect(StyleSheet.flatten(text.props.style).flexShrink).toBe(1);
			expect(text.props.numberOfLines).toBeUndefined();
			expect(text.props.ellipsizeMode).toBeUndefined();
		});

		it("no container between the text and the Private tier clips or fixes height", async () => {
			const tr = await renderSealed();
			let node: renderer.ReactTestInstance | null = hostNode(tr, "registrant-detail-private-sealed-text");
			let sawTier = false;
			while (node) {
				if (typeof node.type === "string") {
					const s = StyleSheet.flatten(node.props.style) ?? {};
					expect(typeof s.height).not.toBe("number");
					expect(s.maxHeight).toBeUndefined();
					expect(s.overflow).not.toBe("hidden");
				}
				if (node.props.testID === "registrant-detail-private-tier") {
					sawTier = true;
					break;
				}
				node = node.parent;
			}
			expect(sawTier).toBe(true);
		});

		it("a 200-character string renders in full", async () => {
			const long = "x".repeat(200);
			mockTOverrides = { registrantPrivateNotRecipient: long };
			const tr = await renderSealed();
			expect(textOf(hostNode(tr, "registrant-detail-private-sealed-text"))).toBe(long);
		});
	});
});
