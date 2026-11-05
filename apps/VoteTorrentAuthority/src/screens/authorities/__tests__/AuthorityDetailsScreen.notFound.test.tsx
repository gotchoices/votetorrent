/**
 * AuthorityDetailsScreen.notFound.test.tsx - gap 5 UI half (D-35/D-39, decision B4). A stale
 * navigation to an authority that is not on the active network reads honestly (translated
 * "not on this network" state, no administration, no revise, no pin chip, pins never read), and no
 * failure on this screen renders the engine message.
 */

import React from "react";
import renderer from "react-test-renderer";
import { Text } from "react-native";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

const mockT = (key: string) => key;
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: mockT }),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
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
const EFFECTIVE_AT = Date.UTC(2026, 9, 1);
const AUTHORITY_FIXTURE = { id: "authority-1", name: "Test Authority", domainName: "test.example.org", imageRef: undefined };
const UNA = { userId: "user-una", authorityId: "authority-1", title: "Chair", scopes: ["rad"] };
const BEA = { userId: "user-bea", authorityId: "authority-1", title: "Clerk", scopes: ["vrg"] };

function makeAdminDetails(officers = [UNA]) {
	return {
		admin: { id: ADMIN_ID, authorityId: "authority-1", officers, effectiveAt: EFFECTIVE_AT, thresholdPolicies: [] },
		proposed: undefined,
	};
}

function peerUnavailableError(): Error {
	return Object.assign(
		new Error("Block default/app/Admin is unavailable (cohort-unreachable): the repo could not determine whether it exists"),
		{ name: "BlockUnavailableError", reason: "cohort-unreachable" }
	);
}

const USER_NAMES: Record<string, string> = { "user-una": "Una Test", "user-bea": "Bea Two" };

const mockGetAdminDetails = jest.fn();
const mockGetUser = jest.fn();
const mockAuthorityEngine = { getAdminDetails: mockGetAdminDetails, getPendingInviteCids: jest.fn(async () => []) };
const mockNetworkEngine = {
	openAuthority: jest.fn(async () => mockAuthorityEngine),
	getPinnedAuthorities: jest.fn(async () => []),
	pinAuthority: jest.fn(async () => {}),
	unpinAuthority: jest.fn(async () => {}),
	getUser: mockGetUser,
};
const mockGetEngine = jest.fn(async (name: string) => (name === "network" ? mockNetworkEngine : name === "invitations" ? { getOfficerInvite: jest.fn(async () => undefined) } : undefined));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

async function flush() {
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const AuthorityDetailsScreen = require("../AuthorityDetailsScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<AuthorityDetailsScreen />);
	});
	await flush();
	return tr;
}

function textContent(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
}

function leafTexts(tr: renderer.ReactTestRenderer): string[] {
	return tr.root
		.findAllByType(Text)
		.filter((n) => !n.findAllByType(Text).some((child) => child !== n))
		.map(textContent);
}

function allText(tr: renderer.ReactTestRenderer): string {
	return leafTexts(tr).join(" | ");
}

function noticeShown(tr: renderer.ReactTestRenderer): boolean {
	return tr.root.findAll((n) => n.props?.testID === "peer-read-unavailable-notice").length > 0;
}
function notOnNetworkShown(tr: renderer.ReactTestRenderer): boolean {
	return tr.root.findAll((n) => n.props?.testID === "authority-not-on-network").length > 0;
}
function lastHeaderRight(): any {
	const calls = mockSetOptions.mock.calls;
	return calls.length ? calls[calls.length - 1][0].headerRight : undefined;
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
	jest.clearAllMocks();
	mockRouteParams = { authority: AUTHORITY_FIXTURE };
	mockNetworkEngine.openAuthority.mockImplementation(async () => mockAuthorityEngine);
	mockGetAdminDetails.mockResolvedValue(makeAdminDetails());
	mockGetUser.mockImplementation(async (userId: string) => ({
		getSummary: async () => ({ id: userId, name: USER_NAMES[userId] }),
	}));
	warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warnSpy.mockRestore());

describe("AuthorityDetailsScreen - not on this network", () => {
	function assertHonest(tr: renderer.ReactTestRenderer) {
		expect(notOnNetworkShown(tr)).toBe(true);
		const text = allText(tr);
		expect(text).toContain("authorityNotOnNetworkTitle");
		expect(text).toContain("authorityNotOnNetworkBody");
		expect(text).not.toContain("Unknown error opening authority");
		expect(text).not.toContain("Authority not found");
		expect(text).not.toContain("effective: ");
		expect(text).not.toContain("N/A");
		expect(text).not.toContain("administration");
		expect(text).not.toContain("reviseAuthority");
		expect(text).not.toContain("Una Test");
		expect(mockNetworkEngine.getPinnedAuthorities).not.toHaveBeenCalled();
		expect(lastHeaderRight()).toBeUndefined();
	}

	it("code authority-not-found", async () => {
		mockNetworkEngine.openAuthority.mockRejectedValue(
			Object.assign(new Error("Authority not found"), { code: "authority-not-found" })
		);
		assertHonest(await renderScreen());
	});

	it("message-only fallback behaves the same", async () => {
		mockNetworkEngine.openAuthority.mockRejectedValue(new Error("Authority not found"));
		assertHonest(await renderScreen());
	});
});

describe("AuthorityDetailsScreen - failures never render the engine message", () => {
	it("openAuthority peer-unavailable: notice; Try Again re-runs loadEngines", async () => {
		mockNetworkEngine.openAuthority.mockRejectedValueOnce(peerUnavailableError());
		const tr = await renderScreen();
		expect(noticeShown(tr)).toBe(true);
		expect(allText(tr)).not.toContain("is unavailable");
		const retry = tr.root.findAll((n) => n.props?.testID === "peer-read-unavailable-retry" && typeof n.props?.onPress === "function");
		await renderer.act(async () => {
			retry[0].props.onPress();
		});
		await flush();
		expect(mockNetworkEngine.openAuthority).toHaveBeenCalledTimes(2);
		expect(noticeShown(tr)).toBe(false);
		expect(allText(tr)).toContain("Una Test");
	});

	it("openAuthority generic: authorityDetailsLoadFailed", async () => {
		mockNetworkEngine.openAuthority.mockRejectedValue(new Error("raw open boom"));
		const text = allText(await renderScreen());
		expect(text).toContain("authorityDetailsLoadFailed");
		expect(text).not.toContain("raw open boom");
	});

	it("getUsers failure: officersLoadFailed", async () => {
		mockGetUser.mockRejectedValue(new Error("raw user boom"));
		const text = allText(await renderScreen());
		expect(text).toContain("officersLoadFailed");
		expect(text).not.toContain("raw user boom");
	});

	it("loadInvited failure: invitedAuthoritiesLoadFailed", async () => {
		(mockAuthorityEngine as any).getInvitedAuthorities = jest.fn(async () => {
			throw new Error("raw invited boom");
		});
		try {
			const text = allText(await renderScreen());
			expect(text).toContain("invitedAuthoritiesLoadFailed");
			expect(text).not.toContain("raw invited boom");
		} finally {
			delete (mockAuthorityEngine as any).getInvitedAuthorities;
		}
	});

	it("pin toggle failure: authorityPinFailed", async () => {
		mockNetworkEngine.pinAuthority.mockRejectedValueOnce(new Error("raw pin boom"));
		const tr = await renderScreen();
		let chip!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			chip = renderer.create(lastHeaderRight()());
		});
		const btn = chip.root.findAll((n) => typeof n.props?.onPress === "function")[0]!;
		await renderer.act(async () => {
			await btn.props.onPress();
		});
		await flush();
		const text = allText(tr);
		expect(text).toContain("authorityPinFailed");
		expect(text).not.toContain("raw pin boom");
	});
});
