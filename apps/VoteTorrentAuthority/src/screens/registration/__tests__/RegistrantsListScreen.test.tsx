/**
 * RegistrantsListScreen.test.tsx — the roster/election-roster integration
 * suite for Phase 47 (47-11), covering D-04 (filtering + both empty states),
 * D-05 (keyset paging + cached count + count-failure degradation), D-07
 * (election roster = same screen, pre-applied filter), D-13 (both scope-gate
 * banner branches, rows always render), and the identifiers-only navigation
 * contract (T-47-11-03) plus the no-leak contract (T-47-11-01).
 *
 * PATTERN SOURCE: apps/VoteTorrentAuthority/src/screens/elections/__tests__/RegistrationPolicyScreen.test.tsx
 * — a REAL MockRegistrationEngine instance imported via a relative `dist/`
 * require, NOT a `jest.fn()`-mock pattern. `react-test-renderer` ONLY.
 */

import React from "react";
import renderer from "react-test-renderer";

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

// The getEngine dispatcher: serves the current real MockRegistrationEngine
// instance for "registration" and the network-engine fixture (officer lookup
// chain) for "network" — everything else resolves null.
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "registration") return mockRegistrationEngine;
	if (name === "network") return mockNetworkEngine;
	return null;
});

let mockRouteParams: {
	authorityId: string;
	electionFilter?: { electionId: string; electionTitle?: string };
} = {
	authorityId: "auth-1",
};

// ---------------------------------------------------------------------------
// Module mocks — all heavy native / cross-cutting deps, module scope, before
// any import of the screen (mirrors RegistrationPolicyScreen.test.tsx exactly).
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
// `JSON.stringify(options)`) when an options object is present. Unquoted is
// load-bearing: the rendered string is itself later embedded inside
// `JSON.stringify(tr.toJSON())` for tree-text assertions, and a
// `JSON.stringify(options)`-style value would have its own quotes
// double-escaped by that OUTER stringify, breaking a plain `.toContain(...)`
// match against an unescaped expected literal.
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
}));

jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({ id: "device-user-1", name: "Device User" })),
}));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

// ---------------------------------------------------------------------------
// The REAL mock engine — required by relative dist path, exactly six levels
// up, matching RegistrationPolicyScreen.test.tsx. NOT `@votetorrent/vote-engine`
// — the package's `exports` field blocks this subpath. 47-05 built vote-engine's
// dist/; without that build the listRegistrants/getElectionRegistrants
// methods this suite needs are invisible to this require (see the stale-dist
// guard below).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
	MockRegistrationEngine,
} = require("../../../../../../packages/vote-engine/dist/registration/mock-registration-engine");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ChipButton } = require("../../../components/ChipButton");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RegistrantRow } = require("../components/RegistrantRow");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A stable, reusable sign callback for directly-seeded engine state (bypasses createDeviceSigner). */
const SEED_SIGN = async () => ({
	signature: "seed-sig",
	signerKey: "seed-key",
	signerUserId: "seed-user",
});

const FUTURE_EXPIRATION = "2099-01-01T00:00:00.000Z";

async function flushTicks(count: number): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < count; i++) {
			await Promise.resolve();
		}
	});
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const RegistrantsListScreenModule = require("../RegistrantsListScreen");
	const RegistrantsListScreen =
		RegistrantsListScreenModule.default ?? RegistrantsListScreenModule.RegistrantsListScreen;

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<RegistrantsListScreen />);
	});

	// Flush AT LEAST four ticks — this screen's load chain (registration engine
	// acquisition -> listRegistrants) runs alongside useCurrentOfficerScopes'
	// own device-user -> network engine -> openAuthority -> getAdminDetails walk.
	await flushTicks(6);

	return tr;
}

/**
 * Fires the real handler on a control reachable under `testID`. ChipButton
 * binds `onPressIn`, NOT `onPress`; RegistrantRow's TouchableOpacity binds
 * `onPress` directly on the SAME node that carries `testID`. Asserting a
 * non-empty candidate list BEFORE firing turns a renamed/restructured
 * control into a loud failure instead of a silent no-op pass.
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
 * `parent` back-reference into the live fiber tree, and `JSON.stringify` on
 * it throws "Converting circular structure to JSON" (confirmed empirically;
 * matches `RegistrationPolicyScreen.test.tsx`'s identical helper). The
 * `.toJSON()` tree is plain data (type/props/children only, no back-refs).
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

/** The rendered `RegistrantRow` ids, in render order — a structural (not string-scraping) row-content proof. */
function rowIds(tr: renderer.ReactTestRenderer): string[] {
	return tr.root.findAllByType(RegistrantRow).map((n) => n.props.row.registrantId);
}

/** The `icon` prop bound to the `ChipButton` wrapped by the View at `containerTestID` — the selected-state signal. */
function chipIcon(tr: renderer.ReactTestRenderer, containerTestID: string): string | undefined {
	const wrapper = tr.root.findByProps({ testID: containerTestID });
	return wrapper.findByType(ChipButton).props.icon;
}

/** The live `TextInput` node under the search field's wrapping View (CustomTextInput does not forward `testID` to itself). */
function findTextInput(
	tr: renderer.ReactTestRenderer,
	containerTestID: string
): renderer.ReactTestInstance {
	const wrapper = tr.root.findByProps({ testID: containerTestID });
	const candidates = wrapper.findAll((node) => typeof node.props.onChangeText === "function");
	expect(candidates.length).toBeGreaterThan(0);
	return candidates[0]!;
}

async function submitSearch(tr: renderer.ReactTestRenderer, text: string): Promise<void> {
	const input = findTextInput(tr, "registrants-list-search");
	renderer.act(() => {
		input.props.onChangeText(text);
	});
	await renderer.act(async () => {
		input.props.onSubmitEditing();
	});
	await flushTicks(4);
}

/** Seeds a Registrant (+ optional public tier + optional non-active status) directly through the mock's own engine surface. */
async function seedRegistrant(
	engine: any,
	args: {
		id: string;
		authorityId: string;
		lastName?: string;
		firstName?: string;
		district?: string;
		expiration?: string;
		status?: "a" | "s" | "r";
	}
): Promise<void> {
	const hasPublic =
		args.lastName !== undefined || args.firstName !== undefined || args.district !== undefined;
	const expiration = args.expiration ?? FUTURE_EXPIRATION;
	await engine.register(
		{
			registrant: { id: args.id, authorityId: args.authorityId, expiration },
			public: hasPublic
				? { lastName: args.lastName, firstName: args.firstName, district: args.district }
				: undefined,
			private: { expiration, details: {} },
		},
		SEED_SIGN
	);
	if (args.status !== undefined && args.status !== "a") {
		await engine.changeStatus(args.id, args.status, SEED_SIGN);
	}
}

/**
 * A thin delegating proxy over a REAL `MockRegistrationEngine` instance.
 * Records the `(filter, page)` argument pair the CALLER passed and forwards
 * to the real implementation with `pageSize` overridden — a page-size shim,
 * not a behavioural stub, so the real cursor / `nextCursor` / `total`
 * semantics stay entirely intact. Every other method delegates unchanged
 * (bound to the real target, not to the proxy, so internal `this.<field>`
 * access inside the real class continues to see real state).
 */
function makePagingProxy(realEngine: any, pageSize: number) {
	const calls: Array<{ filter: any; page: any }> = [];
	const handler: ProxyHandler<any> = {
		get(target, prop, _receiver) {
			if (prop === "listRegistrants") {
				return async (filter: any, page: any) => {
					calls.push({ filter, page });
					return target.listRegistrants(filter, { ...(page ?? {}), pageSize });
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	};
	return { engine: new Proxy(realEngine, handler), calls };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
	jest.clearAllMocks();
	mockRegistrationEngine = new MockRegistrationEngine();
	mockOfficers = [
		{ userId: "device-user-1", authorityId: "auth-1", title: "Chair", scopes: ["vrg"] },
	];
	mockRouteParams = { authorityId: "auth-1" };
	// Do NOT call jest.resetModules() — that would break the cached dist
	// require and the mock factory closures (RegistrationPolicyScreen.test.tsx's
	// same note applies here).
});

describe("RegistrantsListScreen — D-04/D-05/D-07/D-13 (47-11)", () => {
	// -------------------------------------------------------------------------
	// Stale-dist guard
	// -------------------------------------------------------------------------

	it("stale-dist guard: MockRegistrationEngine exposes the roster trio on a fresh instance", () => {
		// A failure here means packages/vote-engine/dist/ is stale relative to
		// 47-05's engine-surface additions and must be rebuilt — this makes a
		// stale dist fail loudly and legibly here instead of surfacing as an
		// obscure downstream render error deep inside this suite.
		const engine = new MockRegistrationEngine();
		expect(typeof engine.listRegistrants).toBe("function");
		expect(typeof engine.getElectionRegistrants).toBe("function");
	});

	// -------------------------------------------------------------------------
	// D-04 roster render
	// -------------------------------------------------------------------------

	it("D-04: one row per registrant, with a truncated-id fallback when no public tier exists", async () => {
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-01",
			authorityId: "auth-1",
			lastName: "Doe",
			firstName: "Jane",
		});
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-02",
			authorityId: "auth-1",
			lastName: "Smith",
			firstName: "Sam",
		});
		await seedRegistrant(mockRegistrationEngine, { id: "r-03zzzzzzzzz", authorityId: "auth-1" }); // no public tier

		const tr = await renderScreen();

		present(tr, "registrant-row-r-01");
		present(tr, "registrant-row-r-02");
		present(tr, "registrant-row-r-03zzzzzzzzz");
		expect(treeText(tr)).toContain("Doe, Jane");
		expect(treeText(tr)).toContain("Smith, Sam");
		expect(treeText(tr)).toContain("r-03z...");
	});

	// -------------------------------------------------------------------------
	// D-05 count on the first page
	// -------------------------------------------------------------------------

	it("D-05: the count line renders shown/total bound from the first (cursor-absent) page", async () => {
		await seedRegistrant(mockRegistrationEngine, { id: "r-01", authorityId: "auth-1" });
		await seedRegistrant(mockRegistrationEngine, { id: "r-02", authorityId: "auth-1" });
		await seedRegistrant(mockRegistrationEngine, { id: "r-03", authorityId: "auth-1" });

		const tr = await renderScreen();

		expect(JSON.stringify(findJsonNodeByTestID(tr.toJSON(), "registrants-list-count"))).toContain(
			"registrantListCountLabel|shown=3,total=3"
		);
	});

	// -------------------------------------------------------------------------
	// D-05 paging + the cached count
	// -------------------------------------------------------------------------

	it("D-05: Load More appends pages with no repeats/skips, and the cached count survives every page", async () => {
		for (let i = 1; i <= 7; i++) {
			await seedRegistrant(mockRegistrationEngine, { id: "r-0" + i, authorityId: "auth-1" });
		}
		const { engine: proxyEngine, calls } = makePagingProxy(mockRegistrationEngine, 3);
		mockRegistrationEngine = proxyEngine;

		const tr = await renderScreen();

		// (a) after the initial load, exactly 3 rows render and Load More exists.
		expect(rowIds(tr)).toEqual(["r-01", "r-02", "r-03"]);
		present(tr, "registrants-list-load-more");

		// (b) press Load More -> 6 rows, no id appears twice, and the recorded
		// second call carries a defined page.cursor equal to the third row's id.
		await press(tr, "registrants-list-load-more");
		expect(rowIds(tr)).toEqual(["r-01", "r-02", "r-03", "r-04", "r-05", "r-06"]);
		expect(new Set(rowIds(tr)).size).toBe(6);
		expect(calls[1]!.page.cursor).toBe("r-03");

		// (c) the count line still shows total: 7 after Load More — the
		// regression a naive setTotal(result.total) in loadMore would break,
		// since a cursored call returns total: undefined.
		expect(JSON.stringify(findJsonNodeByTestID(tr.toJSON(), "registrants-list-count"))).toContain(
			"registrantListCountLabel|shown=6,total=7"
		);

		// (d) press Load More once more -> 7 rows, End of list renders, Load
		// More does not.
		await press(tr, "registrants-list-load-more");
		expect(rowIds(tr)).toEqual(["r-01", "r-02", "r-03", "r-04", "r-05", "r-06", "r-07"]);
		present(tr, "registrants-list-end-of-list");
		absent(tr, "registrants-list-load-more");

		// (e) exactly one recorded call has page.cursor === undefined across the
		// whole scroll — the mechanical proof of "count once per filter-change,
		// never per page".
		const cursorAbsentCalls = calls.filter((c) => c.page.cursor === undefined);
		expect(cursorAbsentCalls.length).toBe(1);
	});

	// -------------------------------------------------------------------------
	// D-05 count failure never blocks the roster
	// -------------------------------------------------------------------------

	it("D-05: a failed count degrades to registrantListCountUnknown with the roster fully rendered", async () => {
		// A purpose-built double — the real mock structurally cannot express a
		// count-query failure (its listRegistrants never rejects and always
		// computes `total` synchronously). RegistrantsListScreen calls only
		// `listRegistrants` on the registration engine, so this double needs no
		// other method.
		const rows = [
			{
				registrantId: "r-01",
				authorityId: "auth-1",
				status: "a",
				expiration: FUTURE_EXPIRATION,
				privateCid: "p1",
			},
			{
				registrantId: "r-02",
				authorityId: "auth-1",
				status: "a",
				expiration: FUTURE_EXPIRATION,
				privateCid: "p2",
			},
			{
				registrantId: "r-03",
				authorityId: "auth-1",
				status: "a",
				expiration: FUTURE_EXPIRATION,
				privateCid: "p3",
			},
		];
		mockRegistrationEngine = {
			async listRegistrants(_filter: any, _page: any) {
				return { rows, nextCursor: undefined, total: undefined };
			},
		};

		const tr = await renderScreen();

		expect(rowIds(tr)).toEqual(["r-01", "r-02", "r-03"]);
		expect(JSON.stringify(findJsonNodeByTestID(tr.toJSON(), "registrants-list-count"))).toContain(
			"registrantListCountUnknown|shown=3"
		);
		// InlineError renders `null` for an empty message — no error surfaced.
		const errorNode = findJsonNodeByTestID(tr.toJSON(), "registrants-list-error") as {
			children?: unknown;
		} | null;
		expect(errorNode?.children ?? null).toBeNull();
		absent(tr, "registrants-list-empty-none");
		absent(tr, "registrants-list-empty-filtered");
	});

	// -------------------------------------------------------------------------
	// D-04 filters
	// -------------------------------------------------------------------------

	it("D-04: status is single-select, district ANDs with status, and All Statuses restores the full set", async () => {
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-01",
			authorityId: "auth-1",
			district: "D1",
			status: "a",
		});
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-02",
			authorityId: "auth-1",
			district: "D1",
			status: "s",
		});
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-03",
			authorityId: "auth-1",
			district: "D2",
			status: "s",
		});
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-04",
			authorityId: "auth-1",
			district: "D2",
			status: "r",
		});

		const tr = await renderScreen();
		expect(rowIds(tr)).toEqual(["r-01", "r-02", "r-03", "r-04"]);

		// Status filter -> suspended only, chip gains icon="check".
		await press(tr, "registrants-list-filter-status-s");
		expect(rowIds(tr)).toEqual(["r-02", "r-03"]);
		expect(chipIcon(tr, "registrants-list-filter-status-s")).toBe("check");
		expect(chipIcon(tr, "registrants-list-filter-status-all")).toBeUndefined();

		// All Statuses restores the full set.
		await press(tr, "registrants-list-filter-status-all");
		expect(rowIds(tr)).toEqual(["r-01", "r-02", "r-03", "r-04"]);
		expect(chipIcon(tr, "registrants-list-filter-status-all")).toBe("check");

		// District alone.
		await press(tr, "registrants-list-filter-district-D1");
		expect(rowIds(tr)).toEqual(["r-01", "r-02"]);

		// Status AND district together -> intersection.
		await press(tr, "registrants-list-filter-status-s");
		expect(rowIds(tr)).toEqual(["r-02"]);

		// Selecting a second status REPLACES rather than adds (single-select
		// within the status dimension) — D1 has no revoked registrant.
		await press(tr, "registrants-list-filter-status-r");
		expect(rowIds(tr)).toEqual([]);
		expect(chipIcon(tr, "registrants-list-filter-status-s")).toBeUndefined();
		expect(chipIcon(tr, "registrants-list-filter-status-r")).toBe("check");
	});

	// -------------------------------------------------------------------------
	// IN-05: the district chip set widens, it never narrows
	// -------------------------------------------------------------------------

	it("IN-05: a status filter that narrows the rows to one district keeps every district chip", async () => {
		// D1 holds the only two active registrants; D2 holds the only suspended
		// one. Filtering to Suspended therefore returns a first page whose rows
		// are entirely D2 — the exact shape that used to REPLACE the chip set
		// with {D2} and leave the officer no D1 chip to switch back to.
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-01",
			authorityId: "auth-1",
			district: "D1",
			status: "a",
		});
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-02",
			authorityId: "auth-1",
			district: "D1",
			status: "a",
		});
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-03",
			authorityId: "auth-1",
			district: "D2",
			status: "s",
		});

		const tr = await renderScreen();
		present(tr, "registrants-list-filter-district-D1");
		present(tr, "registrants-list-filter-district-D2");

		await press(tr, "registrants-list-filter-status-s");
		expect(rowIds(tr)).toEqual(["r-03"]);
		present(tr, "registrants-list-filter-district-D1");
		present(tr, "registrants-list-filter-district-D2");

		// And the officer really can still get back to D1 through the surviving chip.
		await press(tr, "registrants-list-filter-status-all");
		await press(tr, "registrants-list-filter-district-D1");
		expect(rowIds(tr)).toEqual(["r-01", "r-02"]);
	});

	it("IN-05: Load More contributes the districts that only appear on a later page", async () => {
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-01",
			authorityId: "auth-1",
			district: "D1",
		});
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-02",
			authorityId: "auth-1",
			district: "D1",
		});
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-03",
			authorityId: "auth-1",
			district: "D3",
		});
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-04",
			authorityId: "auth-1",
			district: "D4",
		});
		const { engine: proxyEngine } = makePagingProxy(mockRegistrationEngine, 2);
		mockRegistrationEngine = proxyEngine;

		const tr = await renderScreen();

		// Page 1 is D1-only, so D3/D4 are not offerable yet — an honest chip set.
		expect(rowIds(tr)).toEqual(["r-01", "r-02"]);
		present(tr, "registrants-list-filter-district-D1");
		absent(tr, "registrants-list-filter-district-D3");
		absent(tr, "registrants-list-filter-district-D4");

		// Page 2 introduces D3 and D4; page 1's D1 chip must survive.
		await press(tr, "registrants-list-load-more");
		expect(rowIds(tr)).toEqual(["r-01", "r-02", "r-03", "r-04"]);
		present(tr, "registrants-list-filter-district-D1");
		present(tr, "registrants-list-filter-district-D3");
		present(tr, "registrants-list-filter-district-D4");

		// The newly-offered chip is a working filter, not just a label.
		await press(tr, "registrants-list-filter-district-D3");
		expect(rowIds(tr)).toEqual(["r-03"]);
	});

	// -------------------------------------------------------------------------
	// D-04 name search applies on submit only
	// -------------------------------------------------------------------------

	it("D-04: name search applies on submit, never per keystroke, with no debounce timer", async () => {
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-01",
			authorityId: "auth-1",
			lastName: "Smith",
			firstName: "Ann",
		});
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-02",
			authorityId: "auth-1",
			lastName: "Jones",
			firstName: "Bob",
		});

		const listSpy = jest.spyOn(mockRegistrationEngine, "listRegistrants");
		const tr = await renderScreen();
		const callsAfterLoad = listSpy.mock.calls.length;

		const input = findTextInput(tr, "registrants-list-search");
		renderer.act(() => {
			input.props.onChangeText("smi");
		});
		await flushTicks(4);
		expect(listSpy.mock.calls.length).toBe(callsAfterLoad);

		await renderer.act(async () => {
			input.props.onSubmitEditing();
		});
		await flushTicks(4);
		expect(listSpy.mock.calls.length).toBe(callsAfterLoad + 1);
		const [lastFilter] = listSpy.mock.calls[listSpy.mock.calls.length - 1]! as [{ name?: string }];
		expect(lastFilter.name).toBe("smi");
		expect(rowIds(tr)).toEqual(["r-01"]);
	});

	// -------------------------------------------------------------------------
	// D-04 both empty states
	// -------------------------------------------------------------------------

	it("D-04: filtered-empty and nothing-exists render distinct, mutually exclusive copy", async () => {
		const trEmpty = await renderScreen();
		present(trEmpty, "registrants-list-empty-none");
		absent(trEmpty, "registrants-list-empty-filtered");

		await seedRegistrant(mockRegistrationEngine, {
			id: "r-01",
			authorityId: "auth-1",
			lastName: "Smith",
			firstName: "Ann",
		});
		const trFiltered = await renderScreen();
		await submitSearch(trFiltered, "zzz-no-match");
		present(trFiltered, "registrants-list-empty-filtered");
		absent(trFiltered, "registrants-list-empty-none");
	});

	// -------------------------------------------------------------------------
	// D-07 election roster
	// -------------------------------------------------------------------------

	it("D-07: an electionFilter route param pre-applies electionId and titles the screen — same screen, no second route", async () => {
		mockRouteParams = {
			authorityId: "auth-1",
			electionFilter: { electionId: "e-1", electionTitle: "Spring" },
		};
		await seedRegistrant(mockRegistrationEngine, { id: "r-01", authorityId: "auth-1" });
		await seedRegistrant(mockRegistrationEngine, { id: "r-02", authorityId: "auth-1" });
		await mockRegistrationEngine.enrollElectionRegistrant("e-1", "r-01", SEED_SIGN);

		const listSpy = jest.spyOn(mockRegistrationEngine, "listRegistrants");
		const tr = await renderScreen();

		expect(rowIds(tr)).toEqual(["r-01"]);
		const [firstFilter] = listSpy.mock.calls[0]! as [{ electionId?: string }];
		expect(firstFilter.electionId).toBe("e-1");

		const titleCall = mockSetOptions.mock.calls.find((call) => {
			const title = call[0]?.title;
			return typeof title === "string" && title.startsWith("registrantListRosterScreenTitle");
		});
		expect(titleCall).toBeDefined();
		expect(titleCall![0].title).toContain("Spring");
	});

	it("D-07: an election filter with zero enrolled registrants renders empty-none, NOT empty-filtered", async () => {
		mockRouteParams = {
			authorityId: "auth-1",
			electionFilter: { electionId: "e-1", electionTitle: "Spring" },
		};
		await seedRegistrant(mockRegistrationEngine, { id: "r-01", authorityId: "auth-1" }); // not enrolled

		const tr = await renderScreen();
		present(tr, "registrants-list-empty-none");
		absent(tr, "registrants-list-empty-filtered");
	});

	// -------------------------------------------------------------------------
	// D-13 both gate branches — rows always render
	// -------------------------------------------------------------------------

	it("D-13: both scope-gate banner branches render correctly, and the roster renders in all three scope states", async () => {
		await seedRegistrant(mockRegistrationEngine, { id: "r-01", authorityId: "auth-1" });

		// No matching officer row -> scopes === undefined.
		mockOfficers = [];
		const trNoOfficer = await renderScreen();
		present(trNoOfficer, "registrants-list-readonly-no-officer-banner");
		absent(trNoOfficer, "registrants-list-readonly-banner");
		expect(rowIds(trNoOfficer)).toEqual(["r-01"]);

		// An officer holding a scope other than 'vrg'.
		mockOfficers = [
			{ userId: "device-user-1", authorityId: "auth-1", title: "Clerk", scopes: ["mel"] },
		];
		const trWrongScope = await renderScreen();
		present(trWrongScope, "registrants-list-readonly-banner");
		absent(trWrongScope, "registrants-list-readonly-no-officer-banner");
		// The interpolation-echoing t() proves scopeDescriptions.vrg was
		// actually bound, proving the gate checks 'vrg' and not some other scope.
		expect(treeText(trWrongScope)).toContain(
			"registrantScopeReadOnlyBanner|scope=Validate registrations"
		);
		expect(rowIds(trWrongScope)).toEqual(["r-01"]);

		// An officer holding 'vrg'.
		mockOfficers = [
			{ userId: "device-user-1", authorityId: "auth-1", title: "Chair", scopes: ["vrg"] },
		];
		const trWithScope = await renderScreen();
		absent(trWithScope, "registrants-list-readonly-banner");
		absent(trWithScope, "registrants-list-readonly-no-officer-banner");
		expect(rowIds(trWithScope)).toEqual(["r-01"]);
	});

	// -------------------------------------------------------------------------
	// Row press navigates with identifiers only
	// -------------------------------------------------------------------------

	it("T-47-11-03: pressing a row navigates with {registrantId, authorityId} ONLY — an exact deep-equality assertion", async () => {
		await seedRegistrant(mockRegistrationEngine, {
			id: "r-01",
			authorityId: "auth-1",
			lastName: "Doe",
			firstName: "Jane",
		});
		const tr = await renderScreen();

		await press(tr, "registrant-row-r-01");

		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate).toHaveBeenCalledWith("RegistrantDetail", {
			registrantId: "r-01",
			authorityId: "auth-1",
		});
	});

	// -------------------------------------------------------------------------
	// T-47-11-01 no-leak
	// -------------------------------------------------------------------------

	it("T-47-11-01: a rejected search never leaks the typed term to the error surface, the tree, or any console call", async () => {
		const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
		const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
		const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});

		await seedRegistrant(mockRegistrationEngine, { id: "r-01", authorityId: "auth-1" });
		const tr = await renderScreen();

		const SENTINEL = "ZZ-SENTINEL-NAME";
		const input = findTextInput(tr, "registrants-list-search");
		renderer.act(() => {
			input.props.onChangeText(SENTINEL);
		});
		await flushTicks(2);

		jest
			.spyOn(mockRegistrationEngine, "listRegistrants")
			.mockRejectedValue(new Error("listRegistrants failed"));

		await renderer.act(async () => {
			input.props.onSubmitEditing();
		});
		await flushTicks(4);

		present(tr, "registrants-list-error");
		expect(treeText(tr)).toContain("errorLoadFailedGeneric");
		expect(treeText(tr)).not.toContain("listRegistrants failed");

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
});

// ---------------------------------------------------------------------------
// Mutation checks (red-then-green) — recorded in 47-11-SUMMARY.md.
// Both are performed by hand against RegistrantsListScreen.tsx and reverted;
// they are NOT left as permanently-skipped tests in this file (there is no
// stable, source-independent way to express "temporarily mutate the
// implementation" as a runnable Jest test).
// ---------------------------------------------------------------------------
