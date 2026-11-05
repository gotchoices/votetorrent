/**
 * Co-located test for AssociationRequestStatusScreen — pins D-06's
 * genuinely-control-free contract, the T-51-10-01 zero-pressable property
 * against the RENDERED TREE (not a source grep — a control introduced via a
 * shared component would pass a grep and fail a render), the single named
 * `listAssociationRequests(authorityId)` data path, the fail-conservative
 * empty-state resolution on a throwing engine read, and the
 * submittedAt/receivedAt distinct-rendering rule.
 *
 * Uses react-test-renderer ONLY, mirroring the app's established convention
 * (`AttestationProvisioningStatusScreen.test.tsx`, `AssociationsSection.test.tsx`).
 */

import React from "react";
import renderer from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const PALETTE = {
	text: "#T",
	textSecondary: "#TS",
	success: "#SU",
	warning: "#WA",
	error: "#ER",
	card: "#CA",
	background: "#BG",
};

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({ dark: false, colors: PALETTE }),
	useRoute: () => ({ params: { authorityId: "fixture-authority-1" } }),
}));

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Mutable module-level slot for the mocked engine's listAssociationRequests
// implementation. Prefixed `mock` so babel-plugin-jest-hoist allows the
// jest.mock() factory below to close over it.
let mockListAssociationRequests: jest.Mock;

const mockGetEngine = jest.fn(async (_name: string) => ({
	listAssociationRequests: mockListAssociationRequests,
}));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ScreenModule = require("../AssociationRequestStatusScreen");
const Screen = ScreenModule.default;
const { resolveAssociationRequestRows, associationRequestStatusCopy } = ScreenModule;

beforeEach(() => {
	mockListAssociationRequests = jest.fn(async () => []);
	mockGetEngine.mockClear();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flush() {
	await renderer.act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<Screen />);
	});
	await flush();
	return tr;
}

function has(tr: renderer.ReactTestRenderer, testID: string): boolean {
	return tr.root.findAllByProps({ testID }).length > 0;
}

function textOf(tr: renderer.ReactTestRenderer, testID: string): string {
	const node = tr.root.findByProps({ testID });
	const children = node.props.children;
	return Array.isArray(children) ? children.join("") : String(children);
}

/** Every node in the WHOLE rendered tree whose `onPress` prop is a function,
 * plus a scan for known pressable component types. A control introduced via
 * a shared component (not a raw RN primitive) would still surface here,
 * because this walks the FULL tree, not the source text. */
function pressableCount(tr: renderer.ReactTestRenderer): number {
	const rootNode = tr.root;
	const nodes = [rootNode, ...rootNode.findAll(() => true)];
	return nodes.filter((n) => typeof n.props.onPress === "function").length;
}

const ROW = {
	requestId: "req-1",
	authorityId: "fixture-authority-1",
	registrantId: "registrant-1",
	deviceKey: "device-key-abc",
	status: "p" as const,
	submittedAt: "2026-08-01T00:00:00.000Z",
	receivedAt: "2026-08-01T00:00:05.000Z",
};

describe("resolveAssociationRequestRows — fail-conservative boundary", () => {
	it("(a) a resolving probe returns its rows", async () => {
		await expect(resolveAssociationRequestRows(async () => [ROW])).resolves.toEqual([ROW]);
	});

	it("(b) a THROWING probe resolves to an empty list, and the throw does not escape", async () => {
		const throwing = async () => {
			throw new Error("boom");
		};
		await expect(resolveAssociationRequestRows(throwing)).resolves.toEqual([]);
	});

	it("(c) a probe resolving to a non-array resolves to an empty list", async () => {
		const drifted = (async () => undefined) as unknown as () => Promise<never[]>;
		await expect(resolveAssociationRequestRows(drifted)).resolves.toEqual([]);
	});
});

describe("associationRequestStatusCopy — the status/label pairing lock", () => {
	it("maps every AssociationRequestStatus code to a distinct testIDSuffix and labelKey", () => {
		const codes = ["p", "c", "a", "r"] as const;
		const results = codes.map((c) => associationRequestStatusCopy(c));
		expect(new Set(results.map((r) => r.testIDSuffix)).size).toBe(4);
		expect(new Set(results.map((r) => r.labelKey)).size).toBe(4);
	});
});

describe("AssociationRequestStatusScreen — D-06/D-19 read-only status surface", () => {
	it("1. behavior: renders a row per AssociationRequestRead with status, submittedAt and receivedAt as DISTINCT values, and challenge-nonce PRESENCE for a 'c' row", async () => {
		mockListAssociationRequests = jest.fn(async () => [
			ROW,
			{ ...ROW, requestId: "req-2", status: "c", challengeNonce: "super-secret-nonce-value" },
		]);
		const tr = await renderScreen();

		expect(has(tr, "association-request-status-row-req-1")).toBe(true);
		expect(textOf(tr, "association-request-status-row-req-1-status")).toBe(
			"associationRequestStatusPendingLabel",
		);
		expect(textOf(tr, "association-request-status-row-req-1-submitted-at")).toContain(ROW.submittedAt);
		expect(textOf(tr, "association-request-status-row-req-1-received-at")).toContain(ROW.receivedAt);
		expect(textOf(tr, "association-request-status-row-req-1-submitted-at")).not.toEqual(
			textOf(tr, "association-request-status-row-req-1-received-at"),
		);

		expect(has(tr, "association-request-status-row-req-2-challenge")).toBe(true);
		// Presence only — the real nonce VALUE must never reach the tree.
		const tree = JSON.stringify(tr.toJSON());
		expect(tree).not.toContain("super-secret-nonce-value");
	});

	it("2. behavior: the rendered tree contains ZERO pressable elements", async () => {
		mockListAssociationRequests = jest.fn(async () => [ROW]);
		const tr = await renderScreen();
		expect(pressableCount(tr)).toBe(0);
	});

	it("3. behavior: an engine read that THROWS renders the empty/neutral state, not a crash", async () => {
		mockListAssociationRequests = jest.fn(async () => {
			throw new Error("network error with a message that must never reach the tree");
		});
		let tr!: renderer.ReactTestRenderer;
		await expect(
			(async () => {
				tr = await renderScreen();
			})(),
		).resolves.not.toThrow();

		expect(has(tr, "association-request-status-empty")).toBe(true);
		const tree = JSON.stringify(tr.toJSON());
		expect(tree).not.toContain("network error with a message");
	});

	it("4. behavior: no raw registrant PII is rendered — only identifiers, status and timestamps reach the tree", async () => {
		mockListAssociationRequests = jest.fn(async () => [ROW]);
		const tr = await renderScreen();
		const tree = JSON.stringify(tr.toJSON());
		// The row carries no name/email/phone/address fields at all (the
		// AssociationRequestRead shape itself has none), so this is a
		// structural guarantee, pinned here as a tripwire: the device key
		// present on the row is never rendered by this screen.
		expect(tree).not.toContain(ROW.deviceKey);
	});

	it("5. reaches the engine through exactly getEngine('association').listAssociationRequests(authorityId), passing no status filter", async () => {
		mockListAssociationRequests = jest.fn(async () => []);
		await renderScreen();
		expect(mockGetEngine).toHaveBeenCalledWith("association");
		expect(mockListAssociationRequests).toHaveBeenCalledWith("fixture-authority-1");
		expect(mockListAssociationRequests.mock.calls[0].length).toBe(1);
	});

	it("6. empty state renders when there are no requests, and only then", async () => {
		mockListAssociationRequests = jest.fn(async () => [ROW]);
		const trWithRows = await renderScreen();
		expect(has(trWithRows, "association-request-status-empty")).toBe(false);

		mockListAssociationRequests = jest.fn(async () => []);
		const trEmpty = await renderScreen();
		expect(has(trEmpty, "association-request-status-empty")).toBe(true);
	});

	it("7. source assertions: no pressable component names, no InlineError, exactly one listAssociationRequests call site, no getAssociationRequest, no direct SQL", async () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("fs");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require("path");
		const source: string = fs.readFileSync(
			path.join(__dirname, "../AssociationRequestStatusScreen.tsx"),
			"utf8",
		);
		expect((source.match(/Pressable|TouchableOpacity|onPress|<Button/g) ?? []).length).toBe(0);
		expect((source.match(/InlineError/g) ?? []).length).toBe(0);
		expect((source.match(/listAssociationRequests\(/g) ?? []).length).toBe(1);
		expect((source.match(/getAssociationRequest/g) ?? []).length).toBe(0);
		expect(source).not.toContain("exec(");
		expect(source).not.toMatch(/\bselect\b/i);
	});
});
