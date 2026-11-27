/**
 * AssociationsSection.test.tsx — co-located suite for Phase 47 plan 47-15,
 * pinning D-03 (the T-47-12 misrepresentation lock), D-10 (confirm/dismiss
 * discipline) and D-13 (the 'vrg' scope gate).
 *
 * PATTERN SOURCE: RegistrationPolicyScreen.test.tsx / BallotConfirmation.test.tsx
 * — a REAL `MockAssociationEngine` instance imported via a relative `dist/`
 * require, NEVER AdministratorInvitationScreen.test.tsx's `jest.fn()` engine
 * pattern. react-test-renderer ONLY; neither React Native Testing Library nor
 * @testing-library/react-hooks is a dependency of this app.
 *
 * The suite asserts on i18n KEY strings via an interpolation-echoing `t`, so
 * it is independent of 47-02's copy VALUES — with the single deliberate
 * exception of the D-10 dismiss-label test (test 17), which reads the
 * shipped strings out of the exported `resources` map, because
 * `isBareDismissLabel('associationListKeepAssociation')` would be trivially
 * false and therefore vacuous.
 *
 * ============================================================================
 * DECLARED BLIND SPOT — read before trusting a single green test in this file.
 * ============================================================================
 * `MockAssociationEngine.removeAssociation` is a plain `Map.delete`, which
 * NEVER throws on a missing key. This suite therefore proves the section's
 * CALL CONTRACT and its UI discipline (confirm/dismiss, identity targeting,
 * scope gating) — it does NOT prove that the real engine accepts a
 * 'vrg'-signed delete. That is 47-22's and 47-23's ground.
 * ============================================================================
 */

import React from "react";
import renderer from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });

// react-i18next: an interpolation-ECHOING t(), load-bearing for the D-10
// body-interpolation test — it returns the bare key with no options, and
// `key + "|" + JSON.stringify(options)` when an options object is supplied,
// so a test can prove `{{name}}` was actually bound rather than merely that
// some key rendered.
// Overrides only useTranslation — initReactI18next and the rest of the real
// module are preserved via requireActual, because test 17/18 also imports
// the app's own i18n/index.ts (for the shipped `resources` map), and that
// module's own `i18n.use(initReactI18next)` call needs a real export.
jest.mock("react-i18next", () => ({
	...jest.requireActual("react-i18next"),
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? key + "|" + JSON.stringify(options) : key,
	}),
}));

// Distinct sentinel values for every color token so a color assertion can
// never pass by accidental equality between two tokens.
jest.mock("@react-navigation/native", () => ({
	// 49-11: useDeviceSigningErrorHandler resolves useNavigation() —
	// mockNavigate lets AssociationsSection.handleRemove's device-signing
	// navigation branch resolve to a stable, assertable no-op.
	useNavigation: () => ({ navigate: jest.fn() }),
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
}));

jest.mock("../../../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({ id: "device-user-1", name: "Device User" })),
}));

jest.mock("../../../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => async () => ({
		signature: "mock-sig",
		signerKey: "mock-key",
		signerUserId: "device-user-1",
	})),
}));

// ---------------------------------------------------------------------------
// Mutable module-level slots. Prefixed `mock` so the jest babel transform
// (babel-plugin-jest-hoist) allows the jest.mock() factories above to close
// over them despite being declared after those calls.
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

let mockAssociationEngine: any;

// The getEngine dispatcher: serves the current association-engine fixture
// for "association" and the network-engine fixture (officer lookup chain,
// consumed by the REAL useCurrentOfficerScopes hook) for "network".
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "association") return mockAssociationEngine;
	if (name === "network") return mockNetworkEngine;
	return null;
});

jest.mock("../../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

// ---------------------------------------------------------------------------
// The REAL mock engine — required by relative dist path. Verified depth from
// this file's directory (apps/VoteTorrentAuthority/src/screens/registration/
// components/__tests__/) to the repo root is SEVEN levels up — one deeper
// than RegistrationPolicyScreen.test.tsx's six, because this suite's
// directory has an extra "components" segment. Confirmed via
// `node -e "console.log(require.resolve('../../../../../../../packages/vote-engine/dist/association/mock-association-engine'))"`
// run from this directory before writing this literal. A stale
// packages/vote-engine/dist will surface here as "method is not a function"
// for getAssociations/getAttestationVerdicts.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MockAssociationEngine } = require(
	"../../../../../../../packages/vote-engine/dist/association/mock-association-engine",
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AssociationsSection, truncateDeviceKey, formatTimestamp } = require("../AssociationsSection");

// latestVerdictByDeviceKey now lives in ONE shared module rather than being
// copy-pasted into this section and AttestationChallengesSection with divergent
// return types (47-REVIEW WR-08). Both sections, and both suites, consume it here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { latestVerdictByDeviceKey } = require("../verdicts");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isBareDismissLabel } = require("../LifecycleConfirmCard");

// Same verified relative depth convention as the dist require above, applied
// to the app's own i18n module (../../../../i18n from this directory).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resources } = require("../../../../i18n");

const REGISTRANT_ID = "registrant-1";
const AUTHORITY_ID = "auth-1";
const DISPLAY_NAME = "Jane Voter";

// First five characters are IDENTICAL ("devic") — exactly why row testIDs
// are index-based rather than device-key-based.
const DEVICE_KEY_ALPHA = "devicekey-alpha-0000000000";
const DEVICE_KEY_BRAVO = "devicekey-bravo-1111111111";

// ---------------------------------------------------------------------------
// T-47-12 fixture: 47-08 made the mock's associate() record a 'pass' verdict,
// so the mock alone cannot reproduce the real engine's AttestationRequired=0
// path (association written with a non-null AttestationCid, verdict row
// absent — 47-08 Task 2 test 5). This subclass reproduces that state
// faithfully and is the only way to exercise it from the app workspace.
// ---------------------------------------------------------------------------
class NoVerdictAssociationEngine extends MockAssociationEngine {
	async getAttestationVerdicts(): Promise<any[]> {
		return [];
	}
}

class ThrowingVerdictAssociationEngine extends MockAssociationEngine {
	async getAttestationVerdicts(): Promise<never> {
		throw new Error("verdict store unavailable");
	}
}

class ThrowingAssociationsEngine extends MockAssociationEngine {
	async getAssociations(): Promise<never> {
		throw new Error("association store unavailable");
	}
}

class ThrowingRemoveAssociationEngine extends MockAssociationEngine {
	async removeAssociation(): Promise<never> {
		throw new Error("signed delete rejected");
	}
}

async function seedEngine(
	engine: any,
	pairs: Array<{ deviceKey: string }>,
	registrantId: string = REGISTRANT_ID,
) {
	const sig = { signature: "seed-sig", signerKey: "seed-key", signerUserId: "seed-user" };
	for (const pair of pairs) {
		const challenge = await engine.issueAttestationChallenge(
			registrantId,
			pair.deviceKey,
			sig,
		);
		await engine.associate(
			{
				registrantId,
				deviceKey: pair.deviceKey,
				deviceHash: undefined,
				nonce: challenge.nonce,
				attestation: {} as never,
			},
			sig,
		);
	}
}

async function renderSection(overrides?: {
	registrantId?: string;
	authorityId?: string;
	registrantDisplayName?: string;
}) {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(
			<AssociationsSection
				registrantId={overrides?.registrantId ?? REGISTRANT_ID}
				authorityId={overrides?.authorityId ?? AUTHORITY_ID}
				registrantDisplayName={overrides?.registrantDisplayName ?? DISPLAY_NAME}
			/>,
		);
	});
	// Second flush so the useEffect data load AND the useCurrentOfficerScopes
	// walk both settle before assertions run.
	await renderer.act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
	return tr;
}

/** Finds the wrapper by testID, then invokes the first descendant's onPress. */
function press(tr: renderer.ReactTestRenderer, testID: string) {
	const wrapper = tr.root.findByProps({ testID });
	const pressable = [wrapper, ...wrapper.findAll(() => true)].find(
		(node) => typeof node.props.onPress === "function",
	);
	renderer.act(() => {
		pressable!.props.onPress();
	});
}

/** ChipButton wires its onPress prop to the native onPressIn — this helper
 * MUST look for onPressIn, not onPress, or the collapse test silently no-ops. */
function pressChip(tr: renderer.ReactTestRenderer, testID: string) {
	const wrapper = tr.root.findByProps({ testID });
	const pressable = [wrapper, ...wrapper.findAll(() => true)].find(
		(node) => typeof node.props.onPressIn === "function",
	);
	renderer.act(() => {
		pressable!.props.onPressIn();
	});
}

async function flush() {
	await renderer.act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

function treeText(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}

function isDisabled(tr: renderer.ReactTestRenderer, testID: string): boolean {
	const wrapper = tr.root.findByProps({ testID });
	const withDisabled = [wrapper, ...wrapper.findAll(() => true)].find(
		(node) => typeof node.props.disabled === "boolean",
	);
	return withDisabled!.props.disabled === true;
}

function findOnPress(tr: renderer.ReactTestRenderer, testID: string): () => void {
	const wrapper = tr.root.findByProps({ testID });
	const pressable = [wrapper, ...wrapper.findAll(() => true)].find(
		(node) => typeof node.props.onPress === "function",
	);
	return pressable!.props.onPress;
}

beforeEach(() => {
	jest.clearAllMocks();
	mockOfficers = [{ userId: "device-user-1", authorityId: AUTHORITY_ID, title: "Officer", scopes: ["vrg"] }];
	mockAssociationEngine = new MockAssociationEngine();
});

describe("AssociationsSection — D-03/D-10/D-13", () => {
	// -------------------------------------------------------------------------
	// List + disclosure
	// -------------------------------------------------------------------------

	test("1: two associated devices render two rows", async () => {
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }, { deviceKey: DEVICE_KEY_BRAVO }]);
		const tr = await renderSection();

		expect(() => tr.root.findByProps({ testID: "association-row-0" })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: "association-row-1" })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: "association-row-2" })).toThrow();
		// ChipButton renders label.toUpperCase() (ChipButton.tsx:32), so the
		// section-title key surfaces uppercased in the tree — assert
		// case-insensitively rather than baking that transform into every
		// other treeText assertion.
		expect(treeText(tr).toLowerCase()).toContain("associationlistsectiontitle");
	});

	test("2: T-47-05 truncation — only the 5-char prefix ever reaches the tree", async () => {
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }]);
		const tr = await renderSection();

		// findByProps locates the ThemedText composite element; its OWN props
		// (not the rendered host Text's `.children`) carry the JSX children
		// value passed by AssociationsSection.
		const keyNode = tr.root.findByProps({ testID: "association-row-0-device-key" });
		expect(keyNode.props.children).toBe("devic...");

		expect(treeText(tr)).not.toContain(DEVICE_KEY_ALPHA);
		expect(treeText(tr)).not.toContain(DEVICE_KEY_BRAVO);
	});

	test("3: expiration renders as YYYY-MM-DD, not a raw ISO datetime", async () => {
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }]);
		const tr = await renderSection();

		const rowText = treeText(tr);
		expect(rowText).toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(rowText).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
	});

	test("4: zero associations renders the empty state", async () => {
		const tr = await renderSection();

		expect(() => tr.root.findByProps({ testID: "associations-empty" })).not.toThrow();
		expect(treeText(tr)).toContain("associationListEmptyHeading");
		expect(treeText(tr)).toContain("associationListEmptyBody");
		expect(() => tr.root.findByProps({ testID: "association-row-0" })).toThrow();
	});

	test("5: default-open, then toggle collapses and a second press restores", async () => {
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }]);
		const tr = await renderSection();

		expect(() => tr.root.findByProps({ testID: "association-row-0" })).not.toThrow();

		pressChip(tr, "associations-section-toggle");
		expect(() => tr.root.findByProps({ testID: "association-row-0" })).toThrow();

		pressChip(tr, "associations-section-toggle");
		expect(() => tr.root.findByProps({ testID: "association-row-0" })).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// T-47-12 — the misrepresentation lock
	// -------------------------------------------------------------------------

	test("6: non-null AttestationCid with no verdict row renders the NO-VERDICT state, never Pass", async () => {
		const engine = new NoVerdictAssociationEngine();
		await seedEngine(engine, [{ deviceKey: DEVICE_KEY_ALPHA }]);
		mockAssociationEngine = engine;

		const associations = await engine.getAssociations(REGISTRANT_ID);
		expect(associations[0].attestationCid).toBeTruthy();

		const tr = await renderSection();

		expect(() => tr.root.findByProps({ testID: "association-verdict-0-none" })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: "association-verdict-0-pass" })).toThrow();
		expect(() => tr.root.findByProps({ testID: "association-verdict-0-fail" })).toThrow();
		expect(treeText(tr)).toContain("attestationVerdictNone");
		expect(treeText(tr)).not.toContain("attestationVerdictPass");
	});

	test("7: a recorded pass renders Pass", async () => {
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }]);
		const tr = await renderSection();

		expect(() => tr.root.findByProps({ testID: "association-verdict-0-pass" })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: "association-verdict-0-none" })).toThrow();
	});

	test("8: the LATEST verdict wins (max sequence, not array/emission order)", async () => {
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }]);
		await mockAssociationEngine.recordAttestationVerdict(REGISTRANT_ID, DEVICE_KEY_ALPHA, {
			ok: false,
			reason: "revoked device",
		});

		const tr = await renderSection();
		expect(() => tr.root.findByProps({ testID: "association-verdict-0-fail" })).not.toThrow();

		const descending = [
			{ registrantId: REGISTRANT_ID, deviceKey: DEVICE_KEY_ALPHA, sequence: 5, verdict: "pass" as const, verifiedAt: "2020-01-01T00:00:00.000Z" },
			{ registrantId: REGISTRANT_ID, deviceKey: DEVICE_KEY_ALPHA, sequence: 1, verdict: "fail" as const, verifiedAt: "2019-01-01T00:00:00.000Z" },
		];
		const reduced = latestVerdictByDeviceKey(descending);
		expect(reduced.get(DEVICE_KEY_ALPHA)?.sequence).toBe(5);
		expect(reduced.get(DEVICE_KEY_ALPHA)?.verdict).toBe("pass");
	});

	test("9: a verdict-read FAILURE omits the badge entirely, never blocks the roster", async () => {
		const engine = new ThrowingVerdictAssociationEngine();
		await seedEngine(engine, [{ deviceKey: DEVICE_KEY_ALPHA }]);
		mockAssociationEngine = engine;

		const tr = await renderSection();

		expect(() => tr.root.findByProps({ testID: "association-row-0" })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: "association-verdict-0" })).toThrow();
		expect(() => tr.root.findByProps({ testID: "association-verdict-0-none" })).toThrow();
		expect(() => tr.root.findByProps({ testID: "association-verdict-0-pass" })).toThrow();
		expect(() => tr.root.findByProps({ testID: "association-verdict-0-fail" })).toThrow();

		const text = treeText(tr);
		expect(text).not.toContain("attestationVerdictNone");
		expect(text).not.toContain("attestationVerdictPass");
		expect(text).not.toContain("attestationVerdictFail");
		expect(text).toContain("errorLoadFailedGeneric");
		expect(text).not.toContain("verdict store unavailable");
	});

	test("10: an association-read failure blanks the rows and surfaces the error (translated, no engine text)", async () => {
		mockAssociationEngine = new ThrowingAssociationsEngine();
		const tr = await renderSection();

		expect(() => tr.root.findByProps({ testID: "association-row-0" })).toThrow();
		expect(treeText(tr)).toContain("errorLoadFailedGeneric");
		expect(treeText(tr)).not.toContain("association store unavailable");
	});

	// -------------------------------------------------------------------------
	// D-10 — the confirmation discipline
	// -------------------------------------------------------------------------

	test("11: Remove is never a single tap — no engine call fires on open", async () => {
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }]);
		const tr = await renderSection();

		const before = (await mockAssociationEngine.getAssociations(REGISTRANT_ID)).length;
		press(tr, "association-remove-button-0");

		expect(() => tr.root.findByProps({ testID: "association-remove-0-card" })).not.toThrow();
		const after = (await mockAssociationEngine.getAssociations(REGISTRANT_ID)).length;
		expect(after).toBe(before);
		expect(() => tr.root.findByProps({ testID: "association-row-0" })).not.toThrow();
	});

	test("12: a dismissed confirmation fires ZERO engine calls", async () => {
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }]);
		const tr = await renderSection();

		press(tr, "association-remove-button-0");
		const beforeDismiss = (await mockAssociationEngine.getAssociations(REGISTRANT_ID)).length;

		press(tr, "association-remove-0-dismiss");
		await flush();

		expect(() => tr.root.findByProps({ testID: "association-remove-0-card" })).toThrow();
		expect(() => tr.root.findByProps({ testID: "association-row-0" })).not.toThrow();
		const afterDismiss = (await mockAssociationEngine.getAssociations(REGISTRANT_ID)).length;
		expect(afterDismiss).toBe(beforeDismiss);
	});

	test("13: a confirmed removal removes exactly that device", async () => {
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }, { deviceKey: DEVICE_KEY_BRAVO }]);
		const tr = await renderSection();

		press(tr, "association-remove-button-0");
		press(tr, "association-remove-0-confirm");
		await flush();

		const remaining = await mockAssociationEngine.getAssociations(REGISTRANT_ID);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].deviceKey).toBe(DEVICE_KEY_BRAVO);
	});

	test("14: T-47-13 identity lock — opening row 1 removes row 1's device, not row 0's", async () => {
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }, { deviceKey: DEVICE_KEY_BRAVO }]);
		const tr = await renderSection();

		press(tr, "association-remove-button-1");
		press(tr, "association-remove-1-confirm");
		await flush();

		const remaining = await mockAssociationEngine.getAssociations(REGISTRANT_ID);
		// T-47-13: the confirmation must remove the device it was opened for,
		// identified by its full deviceKey — never by list position.
		expect(remaining.map((a: any) => a.deviceKey)).toEqual([DEVICE_KEY_ALPHA]);
	});

	test("15: only one confirmation may be open at a time", async () => {
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }, { deviceKey: DEVICE_KEY_BRAVO }]);
		const tr = await renderSection();

		press(tr, "association-remove-button-0");
		expect(isDisabled(tr, "association-remove-button-1")).toBe(true);

		renderer.act(() => {
			findOnPress(tr, "association-remove-button-1")();
		});
		expect(() => tr.root.findByProps({ testID: "association-remove-1-card" })).toThrow();
	});

	test("16: a failed remove keeps the card mounted and surfaces InlineError", async () => {
		const engine = new ThrowingRemoveAssociationEngine();
		await seedEngine(engine, [{ deviceKey: DEVICE_KEY_ALPHA }]);
		mockAssociationEngine = engine;
		const tr = await renderSection();

		press(tr, "association-remove-button-0");
		press(tr, "association-remove-0-confirm");
		await flush();

		expect(() => tr.root.findByProps({ testID: "association-remove-0-card" })).not.toThrow();
		expect(isDisabled(tr, "association-remove-0-confirm")).toBe(false);
		expect(treeText(tr)).toContain("errorActionFailedGeneric");
		expect(treeText(tr)).not.toContain("signed delete rejected");
	});

	test("17: the dismiss label is not a bare acknowledgement (D-10) — shipped EN/ES strings", () => {
		expect(isBareDismissLabel(resources.en.translation.associationListKeepAssociation)).toBe(false);
		expect(isBareDismissLabel(resources.es.translation.associationListKeepAssociation)).toBe(false);
	});

	test("18: all ten associationList* keys exist in both locales", () => {
		const keys = [
			"associationListSectionTitle",
			"associationListEmptyHeading",
			"associationListEmptyBody",
			"associationListDeviceKeyLabel",
			"associationListExpirationLabel",
			"associationListRemoveButton",
			"associationListRemoveTitle",
			"associationListRemoveBody",
			"associationListRemoveConfirm",
			"associationListKeepAssociation",
		];
		for (const key of keys) {
			expect(typeof resources.en.translation[key]).toBe("string");
			expect(resources.en.translation[key].trim().length).toBeGreaterThan(0);
			expect(typeof resources.es.translation[key]).toBe("string");
			expect(resources.es.translation[key].trim().length).toBeGreaterThan(0);
		}
	});

	// -------------------------------------------------------------------------
	// D-13 — the scope gate
	// -------------------------------------------------------------------------

	test("19: 'vrg'-lacking officer — visible but disabled", async () => {
		mockOfficers = [{ userId: "device-user-1", authorityId: AUTHORITY_ID, title: "Officer", scopes: ["mel"] }];
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }, { deviceKey: DEVICE_KEY_BRAVO }]);
		const tr = await renderSection();

		expect(() => tr.root.findByProps({ testID: "association-row-0" })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: "association-row-1" })).not.toThrow();
		expect(isDisabled(tr, "association-remove-button-0")).toBe(true);
		expect(isDisabled(tr, "association-remove-button-1")).toBe(true);

		const before = (await mockAssociationEngine.getAssociations(REGISTRANT_ID)).length;
		renderer.act(() => {
			findOnPress(tr, "association-remove-button-0")();
		});
		expect(() => tr.root.findByProps({ testID: "association-remove-0-card" })).toThrow();
		const after = (await mockAssociationEngine.getAssociations(REGISTRANT_ID)).length;
		expect(after).toBe(before);
	});

	test("20: not-an-officer (scopes undefined) is also read-only, and rows still render", async () => {
		mockOfficers = [];
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }]);
		const tr = await renderSection();

		expect(() => tr.root.findByProps({ testID: "association-row-0" })).not.toThrow();
		expect(isDisabled(tr, "association-remove-button-0")).toBe(true);
	});

	test("21: 'vrg'-holding officer can write", async () => {
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }]);
		const tr = await renderSection();

		expect(isDisabled(tr, "association-remove-button-0")).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Pure helpers
	// -------------------------------------------------------------------------

	test("22: truncateDeviceKey slices unconditionally", () => {
		expect(truncateDeviceKey("abcdefghij")).toBe("abcde...");
		expect(truncateDeviceKey("ab")).toBe("ab...");
	});

	test("23: formatTimestamp — ISO-Z and epoch-ms agree; undefined/unparseable never coerce to N/A", () => {
		const iso = "2024-03-15T00:00:00.000Z";
		const epoch = Date.parse(iso);
		expect(formatTimestamp(iso)).toBe(formatTimestamp(epoch));
		expect(formatTimestamp(iso)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(formatTimestamp(undefined)).toBeUndefined();
		expect(formatTimestamp("not-a-date")).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// unmountedRef latching (StrictMode / Fast Refresh)
	// -------------------------------------------------------------------------

	test("24: a cleanup that runs while STILL MOUNTED does not latch every setState off", async () => {
		// The defect: this section's unmountedRef effect had no `unmountedRef.current
		// = false` on entry, unlike every sibling that copies the idiom. React 18
		// StrictMode (and any Fast Refresh) runs effect → cleanup → effect on the
		// SAME instance, so the cleanup latched the ref true forever and suppressed
		// every subsequent setState: dataLoading never left `true`, the section
		// rendered "Loading…" permanently, and a device revocation never re-read.
		//
		// Asserted through the rendered output, not the ref: with the reset absent
		// the rows below never appear and "associations-loading" never clears.
		await seedEngine(mockAssociationEngine, [{ deviceKey: DEVICE_KEY_ALPHA }, { deviceKey: DEVICE_KEY_BRAVO }]);

		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(
				<React.StrictMode>
					<AssociationsSection
						registrantId={REGISTRANT_ID}
						authorityId={AUTHORITY_ID}
						registrantDisplayName={DISPLAY_NAME}
					/>
				</React.StrictMode>,
			);
		});
		await flush();

		expect(() => tr.root.findByProps({ testID: "associations-loading" })).toThrow();
		expect(() => tr.root.findByProps({ testID: "association-row-0" })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: "association-row-1" })).not.toThrow();
	});

	// -------------------------------------------------------------------------
	// getEngine failure inside load()
	// -------------------------------------------------------------------------

	test("25: a getEngine failure surfaces InlineError and clears loading, with no unhandled rejection", async () => {
		// The defect: `const engine = await getEngine(...)` sat OUTSIDE both try
		// blocks in load(). getEngine → EngineFactory.buildEngine →
		// requireEstablishedCtx() throws NoNetworkEstablishedError whenever the
		// network context is absent or has just been switched, and load()'s only
		// caller is `useEffect(() => { load(); })` — a floating promise with no
		// .catch. The rejection escaped as an unhandled rejection while the
		// section sat on "Loading…" forever with no message.
		const unhandled: unknown[] = [];
		const onUnhandled = (err: unknown) => unhandled.push(err);
		process.on("unhandledRejection", onUnhandled);
		try {
			mockGetEngine.mockImplementation(async (name: string): Promise<any> => {
				if (name === "association") throw new Error("Network not established");
				if (name === "network") return mockNetworkEngine;
				return null;
			});

			const tr = await renderSection();
			// Drain the macrotask queue so a genuinely unhandled rejection would
			// have been reported by now.
			await new Promise((resolve) => setImmediate(resolve));

			expect(treeText(tr)).toContain("errorLoadFailedGeneric");
			expect(treeText(tr)).not.toContain("Network not established");
			expect(() => tr.root.findByProps({ testID: "associations-loading" })).toThrow();
			expect(() => tr.root.findByProps({ testID: "association-row-0" })).toThrow();
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
