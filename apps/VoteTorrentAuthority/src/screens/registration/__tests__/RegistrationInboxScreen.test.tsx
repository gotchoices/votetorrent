/**
 * RegistrationInboxScreen.test.tsx — the Phase 48 inbox suite (48-18)
 * covering D-03 (the bridge render-iff contract), D-09 (the always-present,
 * filter-independent transparency card), D-12 (screen-level coverage), both
 * scope-banner branches, the empty-state split, and the identifiers-only
 * navigation contract.
 *
 * PATTERN SOURCE: RegistrantsListScreen.test.tsx — a REAL
 * `MockRegistrationEngine` instance required by a relative `dist/` path, NOT
 * a `jest.fn()`-mock data engine. `react-test-renderer` ONLY.
 *
 * ============================================================================
 * DECLARED BLIND SPOT — read before trusting a single green test in this file.
 * ============================================================================
 * The mock engine is `Map`/array-backed and enforces NONE of the schema's
 * PK / CHECK / `InsertOnly` semantics — no `RegistrationRequest.SignatureValid`,
 * no `BridgeIdValid`, no `'vrg'`-gated `DecisionValid`, no `AdminSignature`
 * scope CHECK. Therefore EVERY D-03 assertion below proves that the markup
 * keys off `issuerType`, NOT that `issuerType` is trustworthy — what makes
 * the marking trustworthy is the schema's bridge-key binding CHECK (48-02)
 * and the intake ceremony (48-07), which this suite neither exercises nor
 * evidences. Likewise EVERY scope assertion proves a legibility affordance,
 * NOT an access-control boundary: `AdminSigning.SignerKeyValid` /
 * `OfficerSignature.OfficerValid` are hardcoded stubs (Phase 999.1), and
 * `useCurrentOfficerScopes` carries its own "NOT A SECURITY BOUNDARY" note.
 * This is NOT an access-control boundary anywhere in this file. The
 * requirement D-03 actually states is that an officer NOT BE MISLED. A
 * rendering assertion proves markup; perception is proven by the on-device
 * walkthrough (48-22) and nothing else.
 * ============================================================================
 *
 * ============================================================================
 * DECLARED BLIND SPOT (48-25) — a simulated focus event is not a real one.
 * ============================================================================
 * The `useFocusEffect` mock below proves that the engine is RE-QUERIED on a
 * simulated focus event (via `mockTriggerFocus`) and that the rendered
 * output tracks the new data. It does NOT prove that React Navigation
 * actually delivers a focus event on a real pop-back from the approval /
 * rejection ceremony, or on a real return from Bulk Import / Sync — that is
 * a navigation-container behaviour this mock stands in for, and jest never
 * runs a navigation container. The only proof of the real trigger is
 * 48-28's on-device leg. This gap-2 defect (48-UAT.md test 14) was
 * previously invisible to jest for exactly this reason: the mock this suite
 * used before 48-25 fired the focus callback once on mount and never again,
 * so a plain `useEffect` and a real `useFocusEffect` were indistinguishable
 * here. A mock that asserts its own premise must admit what it does not
 * prove.
 * ============================================================================
 *
 * ============================================================================
 * DISCLOSED DEVIATION — order-crossing supplement to 48-08's fixture.
 * ============================================================================
 * 48-08's built-in `fixture-authority-1` fixture (4 rows) is
 * monotonic-consistent between `submittedAt` and `receivedAt`: empirically
 * verified (via a direct `dist/` require, not assumed) that sorting those 4
 * rows by either clock yields the IDENTICAL permutation — no filter subset
 * of them produces a crossing. A test asserting the two orderings genuinely
 * differ would therefore FAIL OUTRIGHT (not pass vacuously) if it relied on
 * the built-in rows alone. Per this plan's own instruction to "read the
 * actual fixture array … so the guard test pins what is really there," the
 * guard test (1) and the ordering test (5) below both call
 * `seedOrderCrossingPair`, which adds exactly ONE order-crossing PAIR
 * through the engine's OWN PUBLIC `submitRegistrationRequest` API — never
 * touching `packages/vote-engine` — before computing both orderings from
 * live engine truth. This closes the vacuous-pass gap the guard exists to
 * prevent without modifying 48-08's landed fixture (this file's `packages/`
 * diff stays empty).
 * ============================================================================
 *
 * ============================================================================
 * DECLARED BLIND SPOT (48-27) — a flex style in the tree is not proof of fit.
 * ============================================================================
 * PROVEN here: the header carries no action button and the title is still
 * bound (`setOptions` carries `title` and no `headerRight` key at all); the
 * body Bulk Import / Sync control exists, is unconditional on scope (renders
 * with `vrg`, without `vrg`, and while scopes are still loading), and
 * navigates with `{ authorityId }` only; render order is stats card, then
 * the control, then the filters.
 *
 * NOT PROVEN, AND UNPROVABLE IN JEST: that the title actually renders in
 * full in Spanish on a 360dp header. `react-test-renderer` has no layout
 * engine and no text measurement — moving the control off the header is
 * evidence of intent, not of fit, and this is the same substitution the UAT
 * identified as the reason 48-UAT.md gap 4 shipped in the first place.
 *
 * WHAT DISCHARGES IT: 48-29's on-device leg, walked in EN and then ES at the
 * same viewport — ES is the longer locale and was never walked before this
 * UAT.
 * ============================================================================
 */

import React from "react";
import renderer from "react-test-renderer";
import { StyleSheet } from "react-native";

// ---------------------------------------------------------------------------
// Mutable module-level slots. Prefixed `mock` so the jest babel transform
// (babel-plugin-jest-hoist) allows the jest.mock() factories below to close
// over them despite being declared outside the factory's own scope.
// ---------------------------------------------------------------------------

interface TestOfficer {
	userId: string;
	authorityId: string;
	title: string;
	scopes: string[];
}
let mockOfficers: TestOfficer[] = [];

const mockGetAdminDetails = jest.fn(async () => ({ admin: { officers: mockOfficers } }));

let mockRegistrationEngine: any;

const mockNetworkEngine = {
	openAuthority: jest.fn(async () => ({ getAdminDetails: mockGetAdminDetails })),
};

// The seeding side-effect engine. This screen renders NO data from it — it
// is a fire-and-forget idempotent seeding call (48-11) — so the assertions
// below are about WHETHER it is called and WHETHER its failure is tolerated,
// which a real mock engine would obscure rather than reveal. A `jest.fn()`
// here is therefore the correct choice, unlike "registration" below.
const mockGetRequestedSignatures = jest.fn(async () => [] as unknown[]);
const mockSignatureTasksEngine = { getRequestedSignatures: mockGetRequestedSignatures };

// The getEngine dispatcher: serves the current real MockRegistrationEngine
// instance for "registration", the officer-lookup fixture for "network", and
// the jest.fn()-backed seeding stub for "signatureTasksEngine" — everything
// else resolves null.
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "registration") return mockRegistrationEngine;
	if (name === "network") return mockNetworkEngine;
	if (name === "signatureTasksEngine") return mockSignatureTasksEngine;
	return null;
});

let mockRouteParams: { authorityId: string } = { authorityId: "fixture-authority-1" };

// ---------------------------------------------------------------------------
// Module mocks — all heavy native / cross-cutting deps, module scope, before
// any import of the screen (mirrors RegistrantsListScreen.test.tsx exactly).
// ---------------------------------------------------------------------------

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));

// react-i18next: an interpolation-ECHOING t() — returns the bare key with no
// options, and `key + "|" + "k1=v1,k2=v2"` (a flat, UNQUOTED join, not
// `JSON.stringify(options)`) when an options object is present.
jest.mock("react-i18next", () => ({
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

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockSetOptions = jest.fn();
const mockSetParams = jest.fn();

// ---------------------------------------------------------------------------
// useFocusEffect mock registry (48-25). Prefixed `mock` — babel-plugin-jest-
// hoist forbids a jest.mock() factory from closing over a non-`mock`-
// prefixed out-of-scope binding. Deliberately NOT the
// SettingsScreen.provisioningEntry.test.tsx / TasksScreen.registrantTasks.
// test.tsx precedent verbatim: both of those fire the callback ONCE with
// `[]` deps, which would silently break this file's existing filter-change
// tests (a filter press would no longer refetch) and would make the gap-2
// assertion below unwritable. This registry instead re-fires on every
// callback-identity change (mirroring the real hook while focused, via
// deps `[cb]`) AND exposes `mockTriggerFocus` to simulate an explicit
// re-focus with no identity change at all — the pop-back / return-from-
// Bulk-Import-Sync case gap 2 is actually about.
// ---------------------------------------------------------------------------
interface MockFocusEntry {
	cb: () => void | (() => void);
	cleanup: (() => void) | undefined;
}
let mockFocusEntries: MockFocusEntry[] = [];

/**
 * Simulates a real re-focus: runs every registered callback's cleanup (if
 * any), then re-invokes the callback and records its new cleanup. Call from
 * inside `renderer.act(...)`.
 */
function mockTriggerFocus(): void {
	for (const entry of mockFocusEntries) {
		if (typeof entry.cleanup === "function") entry.cleanup();
		entry.cleanup = entry.cb() ?? undefined;
	}
}

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
	useRoute: () => ({
		params: mockRouteParams,
	}),
	// Deferred via a real useEffect keyed on [cb] (NOT called synchronously
	// during render): this screen's focus callbacks set state on every
	// invocation, and a synchronous during-render call trips React's
	// render-phase-update loop guard — same reasoning as the
	// SettingsScreen.provisioningEntry.test.tsx precedent, but with the
	// registry above so callback-identity changes AND an explicit
	// `mockTriggerFocus()` both re-fire it, instead of only-once-on-mount.
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			const entry: MockFocusEntry = { cb, cleanup: undefined };
			entry.cleanup = cb() ?? undefined;
			mockFocusEntries.push(entry);
			return () => {
				mockFocusEntries = mockFocusEntries.filter((e) => e !== entry);
				if (typeof entry.cleanup === "function") entry.cleanup();
			};
		}, [cb]);
	},
}));

jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({ id: "device-user-1", name: "Device User" })),
}));

// The device-change review toggle now mounts on this screen and imports the device signer; the
// real module initialises i18next, which this suite's react-i18next mock does not provide. The
// toggle's own behaviour is covered by RegistrationInboxScreen.reassociationReview.test.tsx.
jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => async () => ({ signature: "s", signerKey: "k", signerUserId: "u" })),
}));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

// ---------------------------------------------------------------------------
// The REAL mock engine — required by relative dist path, exactly six levels
// up, matching RegistrantsListScreen.test.tsx. NOT `@votetorrent/vote-engine`
// — the package's `exports` field blocks this subpath.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
	MockRegistrationEngine,
} = require("../../../../../../packages/vote-engine/dist/registration/mock-registration-engine");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ChipButton } = require("../../../components/ChipButton");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RegistrationRequestRow } = require("../components/RegistrationRequestRow");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUTURE_EXPIRATION = "2099-01-01T00:00:00.000Z";

/** A stable, reusable sign callback for directly-seeded engine state. */
const SEED_SIGN = async () => ({
	signature: "seed-sig",
	signerKey: "seed-key",
	signerUserId: "seed-user",
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
	const RegistrationInboxScreenModule = require("../RegistrationInboxScreen");
	const RegistrationInboxScreen =
		RegistrationInboxScreenModule.default ?? RegistrationInboxScreenModule.RegistrationInboxScreen;

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<RegistrationInboxScreen />);
	});

	// This screen runs THREE independent async chains alongside
	// useCurrentOfficerScopes' own device-user -> network -> openAuthority ->
	// getAdminDetails walk: loadFirstPage, loadStats, and the seeding effect.
	// Flush generously so every chain settles.
	await flushTicks(10);

	return tr;
}

/**
 * Fires the real handler on a control reachable under `testID`. ChipButton
 * binds `onPressIn`, NOT `onPress`; RegistrationRequestRow's TouchableOpacity
 * binds `onPress` directly on the SAME node that carries `testID`.
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
 * Recursively finds a node in the `tr.toJSON()` tree by its `testID` prop.
 * NOT `tr.root.findByProps(...)` directly — a `TestInstance` carries a
 * `parent` back-reference that breaks `JSON.stringify`. The `.toJSON()` tree
 * is plain data (type/props/children only, no back-refs).
 */
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

/** Every `testID` in the rendered tree whose value starts with one of `prefixes`. */
function collectTestIDs(node: unknown, prefixes: string[]): Set<string> {
	const found = new Set<string>();
	function walk(n: unknown): void {
		if (!n) return;
		if (Array.isArray(n)) {
			n.forEach(walk);
			return;
		}
		if (typeof n !== "object") return;
		const props = (n as { props?: { testID?: string } }).props;
		const id = props?.testID;
		if (typeof id === "string" && prefixes.some((p) => id.startsWith(p))) found.add(id);
		const children = (n as { children?: unknown }).children;
		if (children) walk(children);
	}
	walk(node);
	return found;
}

/** The rendered `RegistrationRequestRow` ids, in render order. */
function rowIds(tr: renderer.ReactTestRenderer): string[] {
	return tr.root.findAllByType(RegistrationRequestRow).map((n) => n.props.row.requestId);
}

/** The `icon` prop bound to the `ChipButton` wrapped by the View at `containerTestID`. */
function chipIcon(tr: renderer.ReactTestRenderer, containerTestID: string): string | undefined {
	const wrapper = tr.root.findByProps({ testID: containerTestID });
	return wrapper.findByType(ChipButton).props.icon;
}

/** The live `TextInput` node under the search field's wrapping View. */
function findTextInput(
	tr: renderer.ReactTestRenderer,
	containerTestID: string
): renderer.ReactTestInstance {
	const wrapper = tr.root.findByProps({ testID: containerTestID });
	const candidates = wrapper.findAll((node) => typeof node.props.onChangeText === "function");
	expect(candidates.length).toBeGreaterThan(0);
	return candidates[0]!;
}

/** Delegating request-payload seed through the real engine's public API. */
async function seedRequest(
	engine: any,
	args: {
		id: string;
		authorityId: string;
		submittedAt: string;
		lastName?: string;
		firstName?: string;
		issuerType?: "registrant" | "bridge";
		bridgeId?: string;
	}
): Promise<void> {
	await engine.submitRegistrationRequest(
		{
			id: args.id,
			authorityId: args.authorityId,
			payload: {
				registrant: { id: args.id + "-registrant", authorityId: args.authorityId, expiration: FUTURE_EXPIRATION },
				public:
					args.lastName !== undefined || args.firstName !== undefined
						? { lastName: args.lastName, firstName: args.firstName }
						: undefined,
				private: { expiration: FUTURE_EXPIRATION, details: [] },
			},
			submittedAt: args.submittedAt,
			issuerType: args.issuerType,
			bridgeId: args.bridgeId,
		},
		args.id + "-requester",
		SEED_SIGN
	);
}

/** See the DISCLOSED DEVIATION header block for why this exists. */
async function seedOrderCrossingPair(engine: any, authorityId: string): Promise<void> {
	const now = new Date();
	// Submitted RECENTLY (claim), but called FIRST -> receivedAt is the
	// EARLIER of the pair.
	await seedRequest(engine, {
		id: "extra-request-b",
		authorityId,
		submittedAt: now.toISOString(),
		lastName: "Crossing",
		firstName: "Bee",
	});
	await sleep(50);
	// Submitted a day in the PAST (claim), but called SECOND (a real ~50ms
	// later) -> receivedAt is the LATER of the pair. submittedAt(a) <
	// submittedAt(b) while receivedAt(a) > receivedAt(b): a genuine crossing.
	await seedRequest(engine, {
		id: "extra-request-a",
		authorityId,
		submittedAt: new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
		lastName: "Crossing",
		firstName: "Ay",
	});
}

async function readRows(): Promise<any[]> {
	const result = await mockRegistrationEngine.listRegistrationRequests({
		authorityId: "fixture-authority-1",
	});
	return result.rows;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
	jest.clearAllMocks();
	mockRegistrationEngine = new MockRegistrationEngine();
	mockOfficers = [
		{ userId: "device-user-1", authorityId: "fixture-authority-1", title: "Chair", scopes: ["vrg"] },
	];
	mockRouteParams = { authorityId: "fixture-authority-1" };
	mockGetRequestedSignatures.mockResolvedValue([]);
	// A focus-callback entry leaked from a previous test is its own defect
	// class — reset the registry alongside every other mock.
	mockFocusEntries = [];
	// Do NOT call jest.resetModules() — that would break the cached dist
	// require and the mock factory closures (RegistrantsListScreen.test.tsx's
	// same note applies here).
});

describe("RegistrationInboxScreen — D-03/D-09/D-12 (48-18)", () => {
	// -------------------------------------------------------------------------
	// Guard (1)
	// -------------------------------------------------------------------------

	it("stale-dist + fixture guard: fresh engine exposes the inbox surface, and its fixture-authority-1 rows are order-distinguishable once the crossing pair is added", async () => {
		const engine = new MockRegistrationEngine();
		expect(typeof engine.listRegistrationRequests).toBe("function");
		expect(typeof engine.getRegistrationRequest).toBe("function");
		expect(typeof engine.getPriorRejections).toBe("function");
		expect(typeof engine.getRegistrationTransparencyStats).toBe("function");

		const built = (await engine.listRegistrationRequests({ authorityId: "fixture-authority-1" })).rows;
		expect(built.some((r: any) => r.issuerType === "bridge")).toBe(true);
		expect(built.some((r: any) => r.issuerType === "registrant")).toBe(true);
		expect(built.some((r: any) => r.status === "p")).toBe(true);
		expect(built.some((r: any) => r.status === "a" || r.status === "r")).toBe(true);
		expect(built.some((r: any) => r.submittedAt !== r.receivedAt)).toBe(true);

		// See the DISCLOSED DEVIATION header: the built-in 4 rows alone do NOT
		// produce a distinguishable ordering (verified — sorting by either
		// clock yields the identical permutation), so this guard adds the
		// crossing pair through the engine's own public API before proving
		// the two orderings really differ — the property the ordering test
		// (5) below depends on holding, so the guard exists so a future
		// regression in EITHER the fixture OR the crossing helper fails
		// loudly here instead of surfacing as a confusing failure in test 5.
		await seedOrderCrossingPair(engine, "fixture-authority-1");
		const augmented = (await engine.listRegistrationRequests({ authorityId: "fixture-authority-1" })).rows;
		const byReceived = augmented.map((r: any) => r.requestId);
		const bySubmitted = [...augmented]
			.sort((a: any, b: any) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0))
			.map((r: any) => r.requestId);
		expect(bySubmitted).not.toEqual(byReceived);
	});

	// -------------------------------------------------------------------------
	// D-03 render-iff (2)
	// -------------------------------------------------------------------------

	it("D-03: the bridge badge renders iff issuerType === 'bridge', over every engine-returned row, with both populations non-empty", async () => {
		const tr = await renderScreen();
		await press(tr, "registration-inbox-filter-status-all");

		const rows = await readRows();
		const bridgeRows = rows.filter((r) => r.issuerType === "bridge");
		const registrantRows = rows.filter((r) => r.issuerType === "registrant");
		expect(bridgeRows.length).toBeGreaterThan(0);
		expect(registrantRows.length).toBeGreaterThan(0);

		for (const row of rows) {
			// Every row renders exactly once — `deep: false` stops at the
			// first (shallowest) match, which is sufficient here because
			// this specific testID is never conditionally re-rendered
			// deeper in the same row's own subtree.
			const rowMatches = tr.root.findAllByProps(
				{ testID: "registration-request-row-" + row.requestId },
				{ deep: false }
			);
			expect(rowMatches.length).toBe(1);

			const badgeTestID = "registration-request-row-bridge-badge-" + row.requestId;
			// `BridgeSourceBadge` (the COMPONENT instance) always exists in
			// the fiber tree with this testID PROP, even when its render
			// output is `null` — `tr.root.findAllByProps` matches on props at
			// the composite-component level and would therefore find it
			// regardless of issuerType (confirmed empirically), which is NOT
			// what D-03 requires. The `.toJSON()` tree is the RENDERED
			// HOST-NODE output only, so a registrant row's `null` return
			// genuinely produces no node there — that is the render-iff
			// contract this assertion pins.
			const node = findJsonNodeByTestID(tr.toJSON(), badgeTestID);
			if (row.issuerType === "bridge") {
				expect(node).not.toBeNull();
			} else {
				expect(node).toBeNull();
			}
		}
	});

	it("D-03: the reserved left border renders iff issuerType === 'bridge' — zero borderLeft* keys on any registrant row", async () => {
		const tr = await renderScreen();
		await press(tr, "registration-inbox-filter-status-all");

		const rows = await readRows();
		const bridgeRows = rows.filter((r) => r.issuerType === "bridge");
		const registrantRows = rows.filter((r) => r.issuerType === "registrant");
		expect(bridgeRows.length).toBeGreaterThan(0);
		expect(registrantRows.length).toBeGreaterThan(0);

		for (const row of rows) {
			const node = tr.root.findByProps({ testID: "registration-request-row-" + row.requestId });
			const flat = StyleSheet.flatten(node.props.style) as Record<string, unknown>;
			const hasBorderLeft = Object.keys(flat).some((k) => k.startsWith("borderLeft"));
			if (row.issuerType === "bridge") {
				expect(hasBorderLeft).toBe(true);
			} else {
				expect(hasBorderLeft).toBe(false);
			}
		}
	});

	// -------------------------------------------------------------------------
	// Triage default + ordering (2)
	// -------------------------------------------------------------------------

	it("mount default is Status=Pending, Issuer=All — the exact filter object, and every rendered row is pending", async () => {
		const listSpy = jest.spyOn(mockRegistrationEngine, "listRegistrationRequests");
		const tr = await renderScreen();

		const [firstFilter] = listSpy.mock.calls[0]! as [Record<string, unknown>];
		expect(firstFilter).toEqual({ authorityId: "fixture-authority-1", status: "p" });

		const rows = await readRows();
		for (const id of rowIds(tr)) {
			const row = rows.find((r) => r.requestId === id);
			expect(row?.status).toBe("p");
		}
	});

	it("oldest-receivedAt-first, and the sort label agrees with the engine — the screen-side half of 48-08's anti-backdating proof", async () => {
		await seedOrderCrossingPair(mockRegistrationEngine, "fixture-authority-1");
		const tr = await renderScreen();
		await press(tr, "registration-inbox-filter-status-all");

		const engineRows = await readRows(); // already receivedAt-ordered by the engine
		const byReceived = engineRows.map((r) => r.requestId);
		const bySubmitted = [...engineRows]
			.sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0))
			.map((r) => r.requestId);

		// The fixture's two orderings are genuinely distinguishable — the
		// next assertion cannot pass vacuously.
		expect(bySubmitted).not.toEqual(byReceived);

		const rendered = rowIds(tr);
		expect(rendered).toEqual(byReceived);
		expect(rendered).not.toEqual(bySubmitted);

		// Non-decreasing by receivedAt, checked directly against the rendered
		// order's own receivedAt values (not merely against engine order).
		for (let i = 1; i < engineRows.length; i++) {
			expect(engineRows[i - 1]!.receivedAt <= engineRows[i]!.receivedAt).toBe(true);
		}

		const sortLabelNode = findJsonNodeByTestID(tr.toJSON(), "registration-inbox-sort-label");
		expect(JSON.stringify(sortLabelNode)).toContain("registrationRequestSortedByReceivedLabel");
		// An assertion that merely checked "non-decreasing by submittedAt"
		// would pass over a receivedAt-ordered list wherever the two
		// timestamps agree — do NOT soften this to "renders in some order".
	});

	// -------------------------------------------------------------------------
	// Filters (2)
	// -------------------------------------------------------------------------

	it("status chips are single-select and All clears the filter entirely", async () => {
		const listSpy = jest.spyOn(mockRegistrationEngine, "listRegistrationRequests");
		const tr = await renderScreen();

		await press(tr, "registration-inbox-filter-status-a");
		let [filter] = listSpy.mock.calls[listSpy.mock.calls.length - 1]! as [Record<string, unknown>];
		expect(filter.status).toBe("a");

		const callsBefore = listSpy.mock.calls.length;
		await press(tr, "registration-inbox-filter-status-a");
		// React bails on a `setState` call whose value is `Object.is`-equal to
		// the current state (setStatusFilter("a") when statusFilter is
		// already "a") — no re-render, no effect re-run, no new engine call.
		// Single-select — a second tap on the active chip does NOT clear it.
		expect(listSpy.mock.calls.length).toBe(callsBefore);
		[filter] = listSpy.mock.calls[listSpy.mock.calls.length - 1]! as [Record<string, unknown>];
		expect(filter.status).toBe("a");

		await press(tr, "registration-inbox-filter-status-all");
		[filter] = listSpy.mock.calls[listSpy.mock.calls.length - 1]! as [Record<string, unknown>];
		expect("status" in filter).toBe(false);
	});

	it("issuer ANDs with status", async () => {
		const listSpy = jest.spyOn(mockRegistrationEngine, "listRegistrationRequests");
		const tr = await renderScreen();

		await press(tr, "registration-inbox-filter-status-all");
		await press(tr, "registration-inbox-filter-issuer-bridge");
		let [filter] = listSpy.mock.calls[listSpy.mock.calls.length - 1]! as [Record<string, unknown>];
		expect(filter.issuerType).toBe("bridge");
		const rows = await readRows();
		for (const id of rowIds(tr)) {
			expect(rows.find((r) => r.requestId === id)?.issuerType).toBe("bridge");
		}

		await press(tr, "registration-inbox-filter-status-p");
		[filter] = listSpy.mock.calls[listSpy.mock.calls.length - 1]! as [Record<string, unknown>];
		expect(filter).toMatchObject({ status: "p", issuerType: "bridge" });
	});

	// -------------------------------------------------------------------------
	// Search (1)
	// -------------------------------------------------------------------------

	it("search applies on submit only, never per keystroke, with no debounce timer", async () => {
		const listSpy = jest.spyOn(mockRegistrationEngine, "listRegistrationRequests");
		const tr = await renderScreen();
		const callsAfterLoad = listSpy.mock.calls.length;

		const input = findTextInput(tr, "registration-inbox-search");
		renderer.act(() => {
			input.props.onChangeText("Jor");
		});
		await flushTicks(4);
		expect(listSpy.mock.calls.length).toBe(callsAfterLoad); // unchanged — no debounce fired

		await renderer.act(async () => {
			input.props.onSubmitEditing();
		});
		await flushTicks(4);
		expect(listSpy.mock.calls.length).toBe(callsAfterLoad + 1); // exactly one further call
		const [lastFilter] = listSpy.mock.calls[listSpy.mock.calls.length - 1]! as [{ name?: string }];
		expect(lastFilter.name).toBe("Jor");
		expect(rowIds(tr)).toEqual(["fixture-request-bridge-1"]); // Jordan Alvarez, still Pending by default
	});

	// -------------------------------------------------------------------------
	// Empty-state split (2)
	// -------------------------------------------------------------------------

	it("mount-default empty renders the FILTERED state — Status=Pending is a real filter", async () => {
		mockRouteParams = { authorityId: "empty-authority-1" };
		const tr = await renderScreen();
		present(tr, "registration-inbox-empty-filtered");
		absent(tr, "registration-inbox-empty-none");
	});

	it("fully-cleared empty renders the NO-FILTERS state, mutually exclusive with the filtered one", async () => {
		mockRouteParams = { authorityId: "empty-authority-1" };
		const tr = await renderScreen();
		await press(tr, "registration-inbox-filter-status-all");
		await press(tr, "registration-inbox-filter-issuer-all");
		present(tr, "registration-inbox-empty-none");
		absent(tr, "registration-inbox-empty-filtered");
	});

	// -------------------------------------------------------------------------
	// Scope (2)
	// -------------------------------------------------------------------------

	it("both banner branches render correctly and are never both present", async () => {
		mockOfficers = [];
		const trNoOfficer = await renderScreen();
		present(trNoOfficer, "registration-inbox-readonly-no-officer-banner");
		absent(trNoOfficer, "registration-inbox-readonly-banner");

		mockOfficers = [
			{ userId: "device-user-1", authorityId: "fixture-authority-1", title: "Clerk", scopes: ["ele"] },
		];
		const trWrongScope = await renderScreen();
		present(trWrongScope, "registration-inbox-readonly-banner");
		absent(trWrongScope, "registration-inbox-readonly-no-officer-banner");
		expect(treeText(trWrongScope)).toContain("registrationRequestScopeReadOnlyBanner|scope=");

		mockOfficers = [
			{ userId: "device-user-1", authorityId: "fixture-authority-1", title: "Chair", scopes: ["vrg"] },
		];
		const trWithScope = await renderScreen();
		absent(trWithScope, "registration-inbox-readonly-banner");
		absent(trWithScope, "registration-inbox-readonly-no-officer-banner");
	});

	it("nothing is hidden by scope — the rendered testID set is identical across all three scope states apart from the banner", async () => {
		const prefixes = ["registration-inbox-", "registration-request-row-"];

		mockOfficers = [];
		const trNoOfficer = await renderScreen();
		const noOfficerIds = collectTestIDs(trNoOfficer.toJSON(), prefixes);

		mockOfficers = [
			{ userId: "device-user-1", authorityId: "fixture-authority-1", title: "Clerk", scopes: ["ele"] },
		];
		const trWrongScope = await renderScreen();
		const wrongScopeIds = collectTestIDs(trWrongScope.toJSON(), prefixes);

		mockOfficers = [
			{ userId: "device-user-1", authorityId: "fixture-authority-1", title: "Chair", scopes: ["vrg"] },
		];
		const trWithScope = await renderScreen();
		const withScopeIds = collectTestIDs(trWithScope.toJSON(), prefixes);

		const stripBanners = (s: Set<string>) => [...s].filter((id) => !id.includes("readonly")).sort();
		expect(stripBanners(noOfficerIds)).toEqual(stripBanners(wrongScopeIds));
		expect(stripBanners(wrongScopeIds)).toEqual(stripBanners(withScopeIds));
	});

	// -------------------------------------------------------------------------
	// Transparency (2)
	// -------------------------------------------------------------------------

	it("the stats card is always present, and a stats failure is not a screen error", async () => {
		mockOfficers = [];
		const trNoOfficer = await renderScreen();
		present(trNoOfficer, "registration-inbox-stats");

		jest.spyOn(mockRegistrationEngine, "getRegistrationTransparencyStats").mockRejectedValue(
			new Error("stats failed")
		);
		const tr = await renderScreen();
		present(tr, "registration-inbox-stats");
		expect(rowIds(tr).length).toBeGreaterThan(0);
		const errorNode = findJsonNodeByTestID(tr.toJSON(), "registration-inbox-error") as {
			children?: unknown;
		} | null;
		expect(errorNode?.children ?? null).toBeNull();
	});

	it("counts do not chase the filters (D-09)", async () => {
		const statsSpy = jest.spyOn(mockRegistrationEngine, "getRegistrationTransparencyStats");
		const listSpy = jest.spyOn(mockRegistrationEngine, "listRegistrationRequests");
		const tr = await renderScreen();
		const statsCallsAfterMount = statsSpy.mock.calls.length;
		const listCallsAfterMount = listSpy.mock.calls.length;

		await press(tr, "registration-inbox-filter-status-r");
		await press(tr, "registration-inbox-filter-issuer-bridge");

		expect(listSpy.mock.calls.length).toBeGreaterThan(listCallsAfterMount);
		expect(statsSpy.mock.calls.length).toBe(statsCallsAfterMount);
	});

	// -------------------------------------------------------------------------
	// Navigation (2)
	// -------------------------------------------------------------------------

	it("pressing a row navigates with { requestId, authorityId } ONLY — an exact deep-equality assertion", async () => {
		const tr = await renderScreen();

		await press(tr, "registration-request-row-fixture-request-bridge-1");

		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate).toHaveBeenCalledWith("RegistrationRequestApproval", {
			requestId: "fixture-request-bridge-1",
			authorityId: "fixture-authority-1",
		});
		const serialized = JSON.stringify(mockNavigate.mock.calls[0]);
		expect(serialized).not.toContain("Alvarez");
		expect(serialized).not.toContain("requesterKey");
	});

	// -------------------------------------------------------------------------
	// Body-mounted Bulk Import / Sync control (48-27, closing 48-UAT.md gap 4)
	// -------------------------------------------------------------------------
	// Replaces the pre-48-27 "header chip" test: the control moved from
	// `setOptions`'s `headerRight` into the screen body so a title always
	// renders, in every locale. See the RegistrationInboxScreen.tsx setOptions
	// comment for why.

	it("setOptions carries the title but no headerRight key at all — not a function, not undefined", async () => {
		await renderScreen();

		const titleCall = mockSetOptions.mock.calls.find((call) => call[0]?.title === "registrationRequestScreenTitle");
		expect(titleCall).toBeDefined();
		expect("headerRight" in titleCall![0]).toBe(false);
	});

	it("the body control carries the unchanged label and navigates with { authorityId } ONLY — identifiers only, no row/name/payload", async () => {
		const tr = await renderScreen();

		const control = tr.root.findByProps({ testID: "registration-inbox-bulk-import-sync" });
		const chip = control.findByType(ChipButton);
		expect(chip.props.label).toBe("registrationRequestBulkImportSyncButton");

		mockNavigate.mockClear();
		await press(tr, "registration-inbox-bulk-import-sync");
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate).toHaveBeenCalledWith("BulkImportSync", { authorityId: "fixture-authority-1" });
		const serialized = JSON.stringify(mockNavigate.mock.calls[0]);
		expect(serialized).not.toContain("Alvarez");
	});

	it("the body control renders in every scope state — with vrg, without vrg, and while scopes are still loading", async () => {
		const trWithScope = await renderScreen();
		present(trWithScope, "registration-inbox-bulk-import-sync");

		mockOfficers = [
			{ userId: "device-user-1", authorityId: "fixture-authority-1", title: "Clerk", scopes: ["ele"] },
		];
		const trWrongScope = await renderScreen();
		present(trWrongScope, "registration-inbox-bulk-import-sync");

		// Loading: openAuthority hangs forever, so scopesLoading never flips —
		// the body control is unconditional on it, unlike the two branches of
		// the read-only banner above.
		mockNetworkEngine.openAuthority.mockImplementationOnce(() => new Promise(() => {}));
		const trLoading = await renderScreen();
		present(trLoading, "registration-inbox-bulk-import-sync");
	});

	it("render order: the stats card, then the body Bulk Import / Sync control, then the filters", async () => {
		const tr = await renderScreen();
		const ids = [
			...collectTestIDs(tr.toJSON(), [
				"registration-inbox-stats",
				"registration-inbox-bulk-import-sync",
				"registration-inbox-filters",
			]),
		];
		expect(ids).toEqual([
			"registration-inbox-stats",
			"registration-inbox-bulk-import-sync",
			"registration-inbox-filters",
		]);
	});

	// -------------------------------------------------------------------------
	// Seeding + no-leak (2)
	// -------------------------------------------------------------------------

	it("idempotent seeding fires once on mount, and its failure is tolerated", async () => {
		const tr1 = await renderScreen();
		expect(mockGetRequestedSignatures).toHaveBeenCalledTimes(1);
		expect(mockGetRequestedSignatures).toHaveBeenCalledWith(true);
		expect(rowIds(tr1).length).toBeGreaterThan(0);

		const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
		const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
		const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});

		mockGetRequestedSignatures.mockRejectedValueOnce(new Error("seeding failed"));
		const tr2 = await renderScreen();

		expect(rowIds(tr2).length).toBeGreaterThan(0);
		const errorNode = findJsonNodeByTestID(tr2.toJSON(), "registration-inbox-error") as {
			children?: unknown;
		} | null;
		expect(errorNode?.children ?? null).toBeNull();
		expect(consoleWarnSpy).not.toHaveBeenCalled();
		expect(consoleErrorSpy).not.toHaveBeenCalled();
		expect(consoleLogSpy).not.toHaveBeenCalled();

		consoleWarnSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		consoleLogSpy.mockRestore();
	});

	it("a rejected search never leaks the typed term to the error surface, the tree, or any console call", async () => {
		const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
		const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
		const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});

		const tr = await renderScreen();

		const SENTINEL = "ZZ-SENTINEL-NAME";
		const input = findTextInput(tr, "registration-inbox-search");
		renderer.act(() => {
			input.props.onChangeText(SENTINEL);
		});
		await flushTicks(2);

		jest
			.spyOn(mockRegistrationEngine, "listRegistrationRequests")
			.mockRejectedValue(new Error("listRegistrationRequests failed"));

		await renderer.act(async () => {
			input.props.onSubmitEditing();
		});
		await flushTicks(4);

		present(tr, "registration-inbox-error");
		expect(treeText(tr)).toContain("errorLoadFailedGeneric");
		expect(treeText(tr)).not.toContain("listRegistrationRequests failed");

		// Exactly one occurrence: the search input's own `value` prop.
		const occurrences = treeText(tr).split(SENTINEL).length - 1;
		expect(occurrences).toBe(1);

		const allConsoleCalls = [
			...consoleWarnSpy.mock.calls,
			...consoleErrorSpy.mock.calls,
			...consoleLogSpy.mock.calls,
		];
		for (const call of allConsoleCalls) {
			expect(JSON.stringify(call)).not.toContain(SENTINEL);
		}

		consoleWarnSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		consoleLogSpy.mockRestore();
	});

	// -------------------------------------------------------------------------
	// Focus-driven refetch (48-25, gap 2 — 48-UAT.md test 14)
	// -------------------------------------------------------------------------
	// See the DECLARED BLIND SPOT header block above this describe: these
	// tests prove the screen re-queries the engine on a SIMULATED focus
	// event (`mockTriggerFocus`), not that React Navigation delivers a real
	// one on a pop-back or a return from Bulk Import / Sync — 48-28 owns
	// that proof.

	it("on mount, the list and the stats are each queried exactly once", async () => {
		const listSpy = jest.spyOn(mockRegistrationEngine, "listRegistrationRequests");
		const statsSpy = jest.spyOn(mockRegistrationEngine, "getRegistrationTransparencyStats");
		await renderScreen();
		expect(listSpy).toHaveBeenCalledTimes(1);
		expect(statsSpy).toHaveBeenCalledTimes(1);
	});

	it("refetch-list-on-focus: an explicit re-focus re-queries listRegistrationRequests", async () => {
		const listSpy = jest.spyOn(mockRegistrationEngine, "listRegistrationRequests");
		await renderScreen();
		const callsAfterMount = listSpy.mock.calls.length;

		await renderer.act(async () => {
			mockTriggerFocus();
		});
		await flushTicks(4);

		expect(listSpy.mock.calls.length).toBeGreaterThan(callsAfterMount);
	});

	it("refetch-stats-on-focus: an explicit re-focus re-queries getRegistrationTransparencyStats", async () => {
		const statsSpy = jest.spyOn(mockRegistrationEngine, "getRegistrationTransparencyStats");
		await renderScreen();
		const callsAfterMount = statsSpy.mock.calls.length;

		await renderer.act(async () => {
			mockTriggerFocus();
		});
		await flushTicks(4);

		expect(statsSpy.mock.calls.length).toBeGreaterThan(callsAfterMount);
	});

	it("no-stats-recompute-on-filter-change (D-09): a status chip refetches the list but not the stats", async () => {
		const statsSpy = jest.spyOn(mockRegistrationEngine, "getRegistrationTransparencyStats");
		const listSpy = jest.spyOn(mockRegistrationEngine, "listRegistrationRequests");
		const tr = await renderScreen();
		const statsCallsAfterMount = statsSpy.mock.calls.length;
		const listCallsAfterMount = listSpy.mock.calls.length;

		await press(tr, "registration-inbox-filter-status-r");
		await press(tr, "registration-inbox-filter-issuer-bridge");

		expect(listSpy.mock.calls.length).toBeGreaterThan(listCallsAfterMount);
		expect(statsSpy.mock.calls.length).toBe(statsCallsAfterMount);
	});

	it("reseed-on-focus: an explicit re-focus re-calls getRequestedSignatures(true)", async () => {
		await renderScreen();
		const callsAfterMount = mockGetRequestedSignatures.mock.calls.length;
		expect(callsAfterMount).toBeGreaterThan(0);

		await renderer.act(async () => {
			mockTriggerFocus();
		});
		await flushTicks(4);

		expect(mockGetRequestedSignatures.mock.calls.length).toBeGreaterThan(callsAfterMount);
		expect(mockGetRequestedSignatures).toHaveBeenLastCalledWith(true);
	});

	it("a status change made elsewhere is reflected on re-focus, with no remount", async () => {
		const tr = await renderScreen();
		// Switch off the Pending-only mount default so the mutated row stays
		// visible after its status changes away from "p".
		await press(tr, "registration-inbox-filter-status-all");

		const before = findJsonNodeByTestID(
			tr.toJSON(),
			"registration-request-row-status-fixture-request-pending-repeat"
		);
		expect(JSON.stringify(before)).toContain("registrationRequestStatusPending");

		// Mutate the mock engine's own state directly, exactly as a
		// completed approval ceremony would have committed it — this test
		// does not exercise the (unimplemented-in-mock) approve/reject
		// ceremony APIs, only the inbox's reaction to a state change it did
		// not itself cause.
		const stored = mockRegistrationEngine.registrationRequests.get("fixture-request-pending-repeat");
		stored.status = "a";
		stored.decidedAt = new Date().toISOString();

		await renderer.act(async () => {
			mockTriggerFocus();
		});
		await flushTicks(6);

		const after = findJsonNodeByTestID(
			tr.toJSON(),
			"registration-request-row-status-fixture-request-pending-repeat"
		);
		expect(JSON.stringify(after)).toContain("registrationRequestStatusApproved");
		expect(JSON.stringify(after)).not.toContain("registrationRequestStatusPending");

		// "No remount" — the same ReactTestRenderer instance rendered both
		// the pre- and post-mutation trees; a remount would have required a
		// fresh `renderer.create` call, which this test never makes.
	});

	it("a duplicate-closed request reads Closed under All, never Pending; Pending filter hides it (UAT 62 test 12)", async () => {
		const A = "fixture-request-pending-duplicate-a";
		const B = "fixture-request-pending-duplicate-b";
		mockRegistrationEngine.markDuplicateClosure(A, "closed");
		const tr = await renderScreen();
		await press(tr, "registration-inbox-filter-status-all");

		const closed = JSON.stringify(findJsonNodeByTestID(tr.toJSON(), "registration-request-row-status-" + A));
		expect(closed).toContain("registrationRequestStatusClosedDuplicate");
		expect(closed).not.toContain("registrationRequestStatusPending");
		const open = JSON.stringify(findJsonNodeByTestID(tr.toJSON(), "registration-request-row-status-" + B));
		expect(open).toContain("registrationRequestStatusPending");
		expect(open).not.toContain("registrationRequestStatusClosedDuplicate");

		await press(tr, "registration-inbox-filter-status-p");
		expect(findJsonNodeByTestID(tr.toJSON(), "registration-request-row-" + A)).toBeFalsy();
		expect(findJsonNodeByTestID(tr.toJSON(), "registration-request-row-" + B)).toBeTruthy();
	});

	it("the transparency card renders new totals on re-focus, with no filter change in between", async () => {
		const tr = await renderScreen();

		const pendingBefore = findJsonNodeByTestID(tr.toJSON(), "registration-inbox-stats");
		void pendingBefore;
		const pendingValueBefore = findJsonNodeByTestID(tr.toJSON(), "transparency-stats-pending-value");
		const approvedValueBefore = findJsonNodeByTestID(tr.toJSON(), "transparency-stats-approved-value");
		// 4 pending / 1 approved: 62-19 (D-44) added a second pending-pair fixture
		// (`fixture-request-pending-duplicate-a`/`-b`, both status 'p', same authority) to
		// `MockRegistrationEngine.seedRegistrationRequestFixtures`, alongside the pre-existing
		// `fixture-request-bridge-1`/`fixture-request-pending-repeat`. The numeric assertions
		// below read the rendered `children` text exactly (`toEqual`, not `toContain`) so a
		// future fixture-count drift fails loudly here instead of passing on a coincidental
		// digit substring (e.g. `fontSize":24` contains "2").
		expect(JSON.stringify((pendingValueBefore as { children: unknown[] }).children)).toEqual(
			JSON.stringify(["4"])
		);
		expect(JSON.stringify((approvedValueBefore as { children: unknown[] }).children)).toEqual(
			JSON.stringify(["1"])
		);

		const stored = mockRegistrationEngine.registrationRequests.get("fixture-request-pending-repeat");
		stored.status = "a";
		stored.decidedAt = new Date().toISOString();

		await renderer.act(async () => {
			mockTriggerFocus();
		});
		await flushTicks(6);

		const pendingValueAfter = findJsonNodeByTestID(tr.toJSON(), "transparency-stats-pending-value");
		const approvedValueAfter = findJsonNodeByTestID(tr.toJSON(), "transparency-stats-approved-value");
		expect(JSON.stringify((pendingValueAfter as { children: unknown[] }).children)).toEqual(
			JSON.stringify(["3"])
		);
		expect(JSON.stringify((approvedValueAfter as { children: unknown[] }).children)).toEqual(
			JSON.stringify(["2"])
		);
	});

	it("source gate: no plain useEffect besides the unmountedRef guard, and the false premise sentence is gone", () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("fs");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require("path");
		const source: string = fs.readFileSync(
			path.join(__dirname, "..", "RegistrationInboxScreen.tsx"),
			"utf8"
		);
		const stripped = source
			.split("\n")
			.filter((line) => !/^\s*\/\//.test(line))
			.join("\n");

		const useEffectCalls = stripped.match(/useEffect\(/g) ?? [];
		expect(useEffectCalls.length).toBe(1);

		expect(source).not.toContain("nothing else in the app mutates this queue mid-session");
	});

	// -------------------------------------------------------------------------
	// Declared limitation — recorded here, not papered over.
	// -------------------------------------------------------------------------
	// The mock fixture (even augmented by seedOrderCrossingPair) is smaller
	// than REGISTRATION_REQUESTS_PAGE_SIZE (25), so registration-inbox-load-more
	// and -loading-more are NOT exercised here — this suite renders only the
	// -end-of-list tail. Cursor semantics — including 48-08's contract that an
	// unresolvable cursor yields an empty page and never page 1 — are owned by
	// packages/vote-engine/test/registration-request-read.spec.ts, and this
	// comment says so rather than implying the branches are covered.
});
