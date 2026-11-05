/**
 * AuthorityDetailsScreen.readOrder.test.tsx — overlapping reads are superseded (code review WR-02).
 *
 * A cohort-unreachable read can take a long time to fail, and Try Again stays enabled meanwhile.
 * Before: getAuthorityData had no cancellation, so a slow earlier failure landing after a later
 * success re-raised the can't-reach notice over fresh data, and a slow earlier success could
 * overwrite a newer one. Now only the latest read may write.
 *
 * Mock scaffold mirrors AuthorityDetailsScreen.peerUnavailable.test.tsx.
 */

import React from "react";
import renderer from "react-test-renderer";
import { Text } from "react-native";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

const mockT = (key: string) => key;
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: mockT }),
}));

let mockRouteParams: { authority: any } = { authority: null };

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "p", background: "b", card: "c", text: "t", border: "bo", notification: "n",
			error: "e", textSecondary: "ts", important: "i", success: "s", accent: "a", warning: "w",
		},
	}),
	useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() }),
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

const AUTHORITY_FIXTURE = { id: "authority-1", name: "Test Authority", domainName: "test.example.org", imageRef: undefined };
const UNA = { userId: "user-una", authorityId: "authority-1", title: "Chair", scopes: ["rad"] };
const BEA = { userId: "user-bea", authorityId: "authority-1", title: "Clerk", scopes: ["vrg"] };
const USER_NAMES: Record<string, string> = { "user-una": "Una Test", "user-bea": "Bea Two" };

function makeAdminDetails(officers = [UNA]) {
	return {
		admin: { id: "admin-1", authorityId: "authority-1", officers, effectiveAt: Date.UTC(2026, 9, 1), thresholdPolicies: [] },
		proposed: undefined,
	};
}

function peerUnavailableError(): Error {
	return Object.assign(
		new Error("Block default/app/Admin is unavailable (cohort-unreachable): the repo could not determine whether it exists"),
		{ name: "BlockUnavailableError", reason: "cohort-unreachable" }
	);
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const mockGetAdminDetails = jest.fn();
const mockAuthorityEngine = { getAdminDetails: mockGetAdminDetails, getPendingInviteCids: jest.fn(async () => []) };
const mockNetworkEngine = {
	openAuthority: jest.fn(async () => mockAuthorityEngine),
	getPinnedAuthorities: jest.fn(async () => []),
	pinAuthority: jest.fn(async () => {}),
	unpinAuthority: jest.fn(async () => {}),
	getUser: jest.fn(async (userId: string) => ({ getSummary: async () => ({ id: userId, name: USER_NAMES[userId] }) })),
};
const mockGetEngine = jest.fn(async (name: string) => (name === "network" ? mockNetworkEngine : name === "invitations" ? { getOfficerInvite: jest.fn(async () => undefined) } : undefined));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

async function flush() {
	for (let i = 0; i < 8; i++) {
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

function allText(tr: renderer.ReactTestRenderer): string {
	return tr.root
		.findAllByType(Text)
		.filter((n) => !n.findAllByType(Text).some((child) => child !== n))
		.map(textContent)
		.join(" | ");
}

function noticeShown(tr: renderer.ReactTestRenderer): boolean {
	return tr.root.findAll((n) => n.props?.testID === "peer-read-unavailable-notice").length > 0;
}

async function pressRetry(tr: renderer.ReactTestRenderer) {
	const retry = tr.root.findAll(
		(n) => n.props?.testID === "peer-read-unavailable-retry" && typeof n.props?.onPress === "function"
	);
	expect(retry.length).toBeGreaterThan(0);
	await renderer.act(async () => {
		retry[0].props.onPress();
	});
	await flush();
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
	jest.clearAllMocks();
	mockRouteParams = { authority: AUTHORITY_FIXTURE };
	warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warnSpy.mockRestore();
});

describe("AuthorityDetailsScreen — only the latest read may write (WR-02)", () => {
	it("a slow earlier failure landing after a later success does not re-raise the notice over fresh data", async () => {
		const slow = deferred<ReturnType<typeof makeAdminDetails>>();
		mockGetAdminDetails
			.mockRejectedValueOnce(peerUnavailableError()) // first load
			.mockReturnValueOnce(slow.promise) // Try Again #1: slow, fails later
			.mockResolvedValueOnce(makeAdminDetails()); // Try Again #2: succeeds
		const tr = await renderScreen();
		expect(noticeShown(tr)).toBe(true);

		await pressRetry(tr); // #1 in flight
		await pressRetry(tr); // #2 succeeds
		expect(mockGetAdminDetails).toHaveBeenCalledTimes(3);
		expect(noticeShown(tr)).toBe(false);
		expect(allText(tr)).toContain("Una Test");

		slow.reject(peerUnavailableError());
		await flush();

		expect(noticeShown(tr)).toBe(false);
		expect(allText(tr)).toContain("Una Test");
	});

	it("a slow earlier success does not overwrite a newer one", async () => {
		const slow = deferred<ReturnType<typeof makeAdminDetails>>();
		mockGetAdminDetails
			.mockRejectedValueOnce(peerUnavailableError())
			.mockReturnValueOnce(slow.promise)
			.mockResolvedValueOnce(makeAdminDetails([UNA]));
		const tr = await renderScreen();

		await pressRetry(tr);
		await pressRetry(tr);
		expect(allText(tr)).toContain("Una Test");

		slow.resolve(makeAdminDetails([BEA]));
		await flush();

		const text = allText(tr);
		expect(text).toContain("Una Test");
		expect(text).not.toContain("Bea Two");
	});
});
