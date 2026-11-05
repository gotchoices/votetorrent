/**
 * AuthorityDetailsScreen.proposedLabels.test.tsx — UAT 62: both administration sections labelled
 * their effectiveAt "Expires" (it is the START date), and the Proposed Administration section
 * showed the CURRENT administration's CID as if it were the proposal's. Mock scaffold mirrors
 * AuthorityDetailsScreen.longIds.test.tsx.
 */

import React from "react";
import renderer from "react-test-renderer";
import { Text } from "react-native";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

// A STABLE `t`: AuthorizationSection (rendered once a proposal exists) lists `t` in an effect's
// deps and sets state there — a fresh `t` per render would re-run it forever.
const mockT = (key: string) => key;
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: mockT }),
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

const ADMIN_ID = "authority-1:2026-10-01T00:00:00";
const AUTHORITY_FIXTURE = { id: "authority-1", name: "Test Authority", domainName: "test.example.org", imageRef: undefined };
const FOUNDER = { userId: "user-1", authorityId: "authority-1", title: "Chair", scopes: ["rad"] };

function makeAdminDetails() {
	return {
		admin: { id: ADMIN_ID, authorityId: "authority-1", officers: [FOUNDER], effectiveAt: Date.UTC(2026, 9, 1), thresholdPolicies: [] },
		proposed: {
			proposed: {
				officers: [{ existing: FOUNDER }, { init: { name: "Bea Two", title: "Clerk", scopes: ["vrg"] } }],
				effectiveAt: Date.UTC(2027, 9, 1),
				thresholdPolicies: [],
			},
			signers: ["user-1"],
		},
	};
}

const mockGetAdminDetails = jest.fn(async () => makeAdminDetails());
const mockAuthorityEngine = { getAdminDetails: mockGetAdminDetails, getPendingInviteCids: jest.fn(async () => []) };
const mockNetworkEngine = {
	openAuthority: jest.fn(async () => mockAuthorityEngine),
	getPinnedAuthorities: jest.fn(async () => []),
	pinAuthority: jest.fn(async () => {}),
	unpinAuthority: jest.fn(async () => {}),
	getUser: jest.fn(async () => ({ getSummary: async () => ({ id: "user-1", name: "Founding Chair" }) })),
};
const mockGetEngine = jest.fn(async (name: string) => (name === "network" ? mockNetworkEngine : name === "invitations" ? { getOfficerInvite: jest.fn(async () => undefined) } : undefined));

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

function textContent(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
}

/** Host-level Text nodes whose OWN text (no nested Text) equals `value`. */
function leafTexts(tr: renderer.ReactTestRenderer): string[] {
	return tr.root
		.findAllByType(Text)
		.filter((n) => !n.findAllByType(Text).some((child) => child !== n))
		.map(textContent);
}

beforeEach(() => {
	jest.clearAllMocks();
	mockRouteParams = { authority: AUTHORITY_FIXTURE };
});

describe("AuthorityDetailsScreen — administration dates and the proposed CID (UAT 62)", () => {
	it("labels both administrations' effectiveAt as Effective, never Expires", async () => {
		const tr = await renderScreen();
		const texts = leafTexts(tr);
		expect(texts.filter((s) => s === "effective: ")).toHaveLength(2);
		expect(texts.some((s) => s.startsWith("expires"))).toBe(false);
	});

	it("the proposed section does not repeat the current administration's CID", async () => {
		const tr = await renderScreen();
		expect(leafTexts(tr).filter((s) => s === ADMIN_ID)).toHaveLength(1);
	});

	it("still lists both proposed administrators", async () => {
		const tr = await renderScreen();
		const texts = leafTexts(tr).join(" | ");
		expect(texts).toContain("Bea Two");
		expect(texts).toContain("proposedAdministration");
	});
});

describe("AuthorityDetailsScreen - proposed roster actions", () => {
	const inviteButtons = (tr: renderer.ReactTestRenderer) =>
		tr.root.findAll((n) => n.props?.label === "invite" && typeof n.props?.onPress === "function");

	it("offers INVITE only on the init officer and prefills the invitation from that card", async () => {
		const tr = await renderScreen();
		const buttons = inviteButtons(tr);
		expect(buttons).toHaveLength(1);
		buttons[0].props.onPress();
		expect(mockNavigate).toHaveBeenCalledWith("AdministratorInvitation", {
			mode: "send",
			authority: AUTHORITY_FIXTURE,
			officerInit: { name: "Bea Two", title: "Clerk" },
		});
	});

	it("renders no remove button on the proposed roster", async () => {
		const tr = await renderScreen();
		expect(tr.root.findAll((n) => n.props?.name === "xmark")).toHaveLength(0);
	});

	it("hands the proposal's signers to the authorization section", async () => {
		const tr = await renderScreen();
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { AuthorizationSection } = require("../../../components/AuthorizationSection");
		expect(tr.root.findByType(AuthorizationSection).props.signedOfficerIds).toEqual(["user-1"]);
	});
});
