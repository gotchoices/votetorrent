/**
 * AuthoritiesScreen.findCard.test.tsx - gap 5 UI half. A Find card's body opens Authority Details
 * (it never pins by accident); only the labelled thumbtack pins. Failures render translated copy or
 * the peer-unavailable notice, never the engine message.
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
jest.mock("@react-navigation/native", () => {
	const R = require("react");
	return {
		useTheme: () => ({
			colors: {
				primary: "p", background: "b", card: "c", text: "t", border: "bo", notification: "n",
				error: "e", textSecondary: "ts", important: "i", success: "s", accent: "a", warning: "w",
			},
		}),
		useNavigation: () => ({ navigate: mockNavigate }),
		useFocusEffect: (cb: () => void) => R.useEffect(cb, [cb]),
	};
});

const FIND = { id: "auth-find", name: "Find Auth", domainName: "find.test", imageRef: undefined };
const PINNED = { id: "auth-pin", name: "Pinned Auth", domainName: "pin.test", imageRef: undefined };

let pinnedRows: any[] = [];
const mockNetworkEngine = {
	getPinnedAuthorities: jest.fn(async () => pinnedRows),
	getAuthoritiesByName: jest.fn(async () => ({ buffer: [FIND, PINNED] })),
	pinAuthority: jest.fn(async (a: any) => {
		pinnedRows = [...pinnedRows, a];
	}),
	unpinAuthority: jest.fn(async () => {}),
};
const mockGetEngine = jest.fn(async (_n: string): Promise<any> => mockNetworkEngine);

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine, hasNetwork: true }),
}));

async function flush() {
	for (let i = 0; i < 8; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
}

async function renderScreen() {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Screen = require("../AuthoritiesScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<Screen />);
	});
	await flush();
	return tr;
}

function textContent(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
}
function allText(tr: renderer.ReactTestRenderer): string {
	return tr.root.findAllByType(Text).map(textContent).join("|");
}
function peerUnavailableError(): Error {
	return Object.assign(new Error("Block default/app/Authority is unavailable (cohort-unreachable): x"), {
		name: "BlockUnavailableError",
		reason: "cohort-unreachable",
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	pinnedRows = [PINNED];
	mockGetEngine.mockImplementation(async () => mockNetworkEngine);
	mockNetworkEngine.getPinnedAuthorities.mockImplementation(async () => pinnedRows);
	jest.spyOn(console, "warn").mockImplementation(() => {});
});

function pressByLabel(tr: renderer.ReactTestRenderer, label: string) {
	const nodes = tr.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === "function");
	expect(nodes.length).toBeGreaterThan(0);
	return renderer.act(async () => {
		nodes[0]!.props.onPress();
		await Promise.resolve();
	});
}

describe("AuthoritiesScreen - Find card", () => {
	it("body tap navigates to AuthorityDetails and does not pin", async () => {
		const tr = await renderScreen();
		await pressByLabel(tr, "Find Auth");
		expect(mockNavigate).toHaveBeenCalledWith("AuthorityDetails", { authority: FIND });
		expect(mockNetworkEngine.pinAuthority).not.toHaveBeenCalled();
	});

	it("the thumbtack pins and the card moves to the pinned list", async () => {
		const tr = await renderScreen();
		await pressByLabel(tr, "pin");
		await flush();
		expect(mockNetworkEngine.pinAuthority).toHaveBeenCalledWith(FIND);
		expect(mockNavigate).not.toHaveBeenCalled();
		const pinnedCards = tr.root.findAll((n) => n.props.accessibilityLabel === "Find Auth" && typeof n.props.onPress === "function");
		expect(pinnedCards.length).toBeGreaterThan(0);
		// no Find-section thumbtack remains for it (only none left to pin)
		expect(tr.root.findAll((n) => n.props.accessibilityLabel === "pin")).toHaveLength(0);
	});

	it("a pinned card body still navigates", async () => {
		const tr = await renderScreen();
		await pressByLabel(tr, "Pinned Auth");
		expect(mockNavigate).toHaveBeenCalledWith("AuthorityDetails", { authority: PINNED });
	});
});

describe("AuthoritiesScreen - errors", () => {
	it("peer-unavailable load with nothing loaded shows the notice; Try Again re-runs the load", async () => {
		mockNetworkEngine.getPinnedAuthorities.mockRejectedValueOnce(peerUnavailableError());
		const tr = await renderScreen();
		expect(tr.root.findAllByProps({ testID: "peer-read-unavailable-notice" }).length).toBeGreaterThan(0);
		expect(allText(tr)).toContain("peerReadUnavailableTitle");
		expect(allText(tr)).not.toContain("is unavailable");
		const before = mockNetworkEngine.getPinnedAuthorities.mock.calls.length;
		const retry = tr.root.findAll((n) => n.props.testID === "peer-read-unavailable-retry" && typeof n.props.onPress === "function")[0]!;
		await renderer.act(async () => {
			retry.props.onPress();
			await Promise.resolve();
		});
		await flush();
		expect(mockNetworkEngine.getPinnedAuthorities.mock.calls.length).toBeGreaterThan(before);
		expect(tr.root.findAllByProps({ testID: "peer-read-unavailable-notice" })).toHaveLength(0);
	});

	it("a generic load rejection shows authoritiesLoadFailed, not the raw message", async () => {
		mockNetworkEngine.getPinnedAuthorities.mockRejectedValue(new Error("raw boom 0xdeadbeef"));
		const tr = await renderScreen();
		const text = allText(tr);
		expect(text).toContain("authoritiesLoadFailed");
		expect(text).not.toContain("raw boom");
	});

	it("getEngine('network') rejecting shows authoritiesLoadFailed", async () => {
		mockGetEngine.mockRejectedValue(new Error("raw engine boom"));
		const tr = await renderScreen();
		const text = allText(tr);
		expect(text).toContain("authoritiesLoadFailed");
		expect(text).not.toContain("raw engine boom");
	});

	it("a pin toggle failure shows authorityPinFailed", async () => {
		mockNetworkEngine.pinAuthority.mockRejectedValueOnce(new Error("raw pin boom"));
		const tr = await renderScreen();
		await pressByLabel(tr, "pin");
		await flush();
		const text = allText(tr);
		expect(text).toContain("authorityPinFailed");
		expect(text).not.toContain("raw pin boom");
	});
});
