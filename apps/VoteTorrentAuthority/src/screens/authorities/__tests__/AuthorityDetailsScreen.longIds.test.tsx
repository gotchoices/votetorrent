/**
 * AuthorityDetailsScreen.longIds.test.tsx — on-device UAT (Redmi 8, 360dp): the Administration
 * "CID: <uuid>:<timestamp>" line ran off the right edge, clipped. Every label/value detail row on
 * the screen (and in OfficerCard) must let its value shrink, and id values ellipsize in the
 * middle. Mock scaffold mirrors AuthorityDetailsScreen.entryPoints.test.tsx.
 */

import React from "react";
import renderer from "react-test-renderer";
import { Text } from "react-native";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
// Prefixed `mock` so babel-plugin-jest-hoist allows the jest.mock() factory
// below (hoisted above this declaration) to close over it.
let mockRouteParams: { authority: any } = { authority: null };

jest.mock("@react-navigation/native", () => ({
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
		},
	}),
	useNavigation: () => ({
		navigate: mockNavigate,
		goBack: mockGoBack,
		setOptions: mockSetOptions,
	}),
	useRoute: () => ({ params: mockRouteParams }),
	// Run the callback once on mount (like a first focus); an effect keyed on `cb` would re-run every render.
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			const cleanup = cb();
			return typeof cleanup === "function" ? cleanup : undefined;
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));

// Real-shaped ids from the device report: a uuid plus a ":<ISO timestamp>" suffix, far wider
// than a 360dp screen once a "CID: " label sits beside it.
const LONG_ADMIN_ID = "3628cb7e-6ea6-45ea-bb2f-79a24a52fe51:2026-10-06T10:11:12.000Z";
const LONG_PRIOR_ID = "9b1d2c3e-1111-4a4a-8b8b-0123456789ab:2026-09-30T08:00:00.000Z";
const LONG_AUTHORITY_ID = "c0ffee00-2222-4b4b-9c9c-abcdefabcdef:2026-10-01T00:00:00.000Z";

const AUTHORITY_FIXTURE = {
	id: LONG_AUTHORITY_ID,
	name: "Test Authority",
	domainName: "test.example.org",
	imageRef: undefined,
};

function makeAdminDetails() {
	return {
		admin: { id: LONG_ADMIN_ID, priorId: LONG_PRIOR_ID, officers: [], effectiveAt: Date.now() },
		proposed: undefined,
	};
}

const mockGetAdminDetails = jest.fn(async () => makeAdminDetails());
// The screen probes `authorityEngine.getInvitedAuthorities` via `typeof fn === "function"` —
// this fixture deliberately omits it, matching the upstream_contract's "may be absent" floor.
const mockAuthorityEngine = { getAdminDetails: mockGetAdminDetails, getPendingInviteCids: jest.fn(async () => []) };
const mockOpenAuthority = jest.fn(async () => mockAuthorityEngine);
const mockGetPinnedAuthorities = jest.fn(async () => []);
const mockPinAuthority = jest.fn(async () => {});
const mockUnpinAuthority = jest.fn(async () => {});
const mockNetworkEngine = {
	openAuthority: mockOpenAuthority,
	getPinnedAuthorities: mockGetPinnedAuthorities,
	pinAuthority: mockPinAuthority,
	unpinAuthority: mockUnpinAuthority,
};
const mockGetEngine = jest.fn(async (name: string) => {
	if (name === "network") return mockNetworkEngine;
	if (name === "invitations") return { getOfficerInvite: jest.fn(async () => undefined) };
	return undefined;
});

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const AuthorityDetailsScreen = require("../AuthorityDetailsScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<AuthorityDetailsScreen />);
	});
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
	return tr;
}

function flattenStyle(style: unknown): Record<string, unknown> {
	if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
	return style && typeof style === "object" ? (style as Record<string, unknown>) : {};
}

function textContent(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
}

/** The single host-level Text whose own content includes `needle` (innermost match). */
function textsContaining(tr: renderer.ReactTestRenderer, needle: string): renderer.ReactTestInstance[] {
	return tr.root
		.findAllByType(Text)
		.filter((n) => textContent(n).includes(needle))
		.filter((n) => !n.findAllByType(Text).some((child) => child !== n && textContent(child).includes(needle)));
}

beforeEach(() => {
	jest.clearAllMocks();
	mockRouteParams = { authority: AUTHORITY_FIXTURE };
	mockGetAdminDetails.mockImplementation(async () => makeAdminDetails());
	mockOpenAuthority.mockImplementation(async () => mockAuthorityEngine);
	mockGetPinnedAuthorities.mockImplementation(async () => []);
	mockGetEngine.mockImplementation(async (name: string) => (name === "network" ? mockNetworkEngine : name === "invitations" ? { getOfficerInvite: jest.fn(async () => undefined) } : undefined));
});

describe("AuthorityDetailsScreen — long id lines never run off the screen", () => {
	it.each([
		["authority CID", LONG_AUTHORITY_ID],
		["administration CID", LONG_ADMIN_ID],
		["prior administration CID", LONG_PRIOR_ID],
	])("the %s is one line, middle-ellipsized, and shrinks beside its label", async (_label, id) => {
		const tr = await renderScreen();
		const nodes = textsContaining(tr, id);
		expect(nodes.length).toBeGreaterThan(0);
		for (const node of nodes) {
			expect(node.props.numberOfLines).toBe(1);
			expect(node.props.ellipsizeMode).toBe("middle");
			// Without flexShrink the value measures at full row width and the label pushes it
			// past the right edge — the ellipsis never engages.
			expect(flattenStyle(node.props.style).flexShrink).toBeGreaterThanOrEqual(1);
		}
	});

	it("the authority name and domain values also shrink beside their labels", async () => {
		const tr = await renderScreen();
		for (const value of [AUTHORITY_FIXTURE.name, AUTHORITY_FIXTURE.domainName]) {
			const nodes = textsContaining(tr, value);
			expect(nodes.length).toBeGreaterThan(0);
			for (const node of nodes) {
				expect(flattenStyle(node.props.style).flexShrink).toBeGreaterThanOrEqual(1);
			}
		}
	});
});

describe("OfficerCard — label/value rows shrink instead of clipping", () => {
	const LONG_INVITE_ID = "inv-5f0e2b7c-3333-4c4c-8d8d-fedcbafedcba:2026-10-06T09:00:00.000Z";
	const LONG_TITLE = "Deputy Chief Registrar of Electoral Rolls and Overseas Voter Services";

	it("name, title, invite id and permission bullets carry flexShrink; the invite id middle-ellipsizes", () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { OfficerCard } = require("../components/OfficerCard");
		let tr!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tr = renderer.create(
				<OfficerCard
					officer={{ userId: LONG_ADMIN_ID, authorityId: LONG_AUTHORITY_ID, title: LONG_TITLE, scopes: ["rn"] }}
					userName={undefined}
					inviteId={LONG_INVITE_ID}
				/>,
			);
		});

		for (const value of [LONG_ADMIN_ID, LONG_TITLE, LONG_INVITE_ID]) {
			const nodes = textsContaining(tr, value);
			expect(nodes.length).toBeGreaterThan(0);
			for (const node of nodes) {
				expect(flattenStyle(node.props.style).flexShrink).toBeGreaterThanOrEqual(1);
			}
		}
		for (const node of textsContaining(tr, LONG_INVITE_ID)) {
			expect(node.props.numberOfLines).toBe(1);
			expect(node.props.ellipsizeMode).toBe("middle");
		}
	});
});
