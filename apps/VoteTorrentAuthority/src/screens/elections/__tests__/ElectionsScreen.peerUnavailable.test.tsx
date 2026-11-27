/** ElectionsScreen.peerUnavailable.test.tsx — 62-96: first reads after a cold start never show engine text. */
import React from "react";
import { Text } from "react-native";
import renderer from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const RAW = "Block default/app/TidHighWater is unavailable (cohort-unreachable): the repo could not determine whether it exists";
function peerError(): Error {
	return Object.assign(new Error(RAW), { name: "BlockUnavailableError", reason: "cohort-unreachable" });
}

const THEME = {
	colors: {
		primary: "p", background: "b", card: "c", text: "t", border: "bo", notification: "n", error: "e",
		textSecondary: "ts", important: "i", success: "s", accent: "a", warning: "w",
	},
};
const mockNavigate = jest.fn();
const mockSetOptions = jest.fn();
jest.mock("@react-navigation/native", () => ({
	useTheme: () => THEME,
	useNavigation: () => ({ navigate: mockNavigate, setOptions: mockSetOptions, goBack: jest.fn() }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			cb();
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));

async function flush() {
	for (let i = 0; i < 8; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
}
function textContent(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
}
function allText(tr: renderer.ReactTestRenderer): string {
	return tr.root.findAllByType(Text).map(textContent).join(" | ");
}
function noticeCount(tr: renderer.ReactTestRenderer): number {
	return tr.root.findAll((n) => n.props?.testID === "peer-read-unavailable-notice" && typeof n.type === "string").length;
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
beforeEach(() => {
	jest.clearAllMocks();
	jest.spyOn(console, "warn").mockImplementation(() => {});
	jest.spyOn(console, "error").mockImplementation(() => {});
	jest.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

let mockGetElections = jest.fn();
const mockEngine = {
	getElections: (...a: unknown[]) => mockGetElections(...a),
	getProposedElections: async () => [],
	getElectionHistory: async () => [],
	openElection: jest.fn(),
};
let mockHasNetwork = true;
// A stable getEngine identity, like the real provider's (a fresh function per render would
// re-run the load effects forever).
const mockGetEngine = async () => mockEngine;
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine, hasNetwork: mockHasNetwork }),
}));

async function renderScreen() {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Screen = require("../ElectionsScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<Screen />);
	});
	await flush();
	return tr;
}

describe("ElectionsScreen peer-unavailable reads (62-96)", () => {
	beforeEach(() => {
		mockHasNetwork = true;
		mockGetElections = jest.fn();
	});

	it("E-1: a cohort-unreachable first load shows the notice, never the raw text; Try Again re-runs the load", async () => {
		mockGetElections.mockRejectedValue(peerError());
		const tr = await renderScreen();
		expect(noticeCount(tr)).toBeGreaterThan(0);
		expect(allText(tr)).not.toContain("TidHighWater");
		expect(allText(tr)).toContain("peerReadUnavailableTitle");
		mockGetElections.mockResolvedValue([]);
		const calls = mockGetElections.mock.calls.length;
		await pressRetry(tr);
		expect(mockGetElections.mock.calls.length).toBeGreaterThan(calls);
		expect(noticeCount(tr)).toBe(0);
	});

	it("E-2: a generic failure shows the translated generic copy, never the raw text", async () => {
		mockGetElections.mockRejectedValue(new Error("constraint exploded: secret-table"));
		const tr = await renderScreen();
		expect(allText(tr)).toContain("electionsLoadFailed");
		expect(allText(tr)).not.toContain("secret-table");
		expect(noticeCount(tr)).toBe(0);
	});

	it("E-3: after a successful load, a later peer failure shows the stale variant", async () => {
		mockGetElections.mockResolvedValueOnce([]).mockRejectedValue(peerError());
		const tr = await renderScreen();
		// the focus reload ran in the same mount, so the second call is the failure
		expect(noticeCount(tr)).toBeGreaterThan(0);
		expect(allText(tr)).toContain("peerReadUnavailableStaleBody");
		expect(allText(tr)).not.toContain("TidHighWater");
	});
});

// 62 session 1 observation 3: on a cohort-unreachable network the tab said "No current elections".
// The empty copy rendered before any load had succeeded, and an older load that settled after a newer
// one overwrote its outcome (mount, focus and strand-change loads all race).
describe("ElectionsScreen never claims an empty list it has not loaded", () => {
	beforeEach(() => {
		mockHasNetwork = true;
		mockGetElections = jest.fn();
	});

	function deferred<T>() {
		let resolve!: (v: T) => void;
		let reject!: (e: unknown) => void;
		const promise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	}

	const EMPTY_KEYS = ["noCurrentElections", "noProposedElectionsCurrently", "noHistoryFound"];

	it("E-5: a cohort-unreachable first load shows the notice and no empty-list copy", async () => {
		mockGetElections.mockRejectedValue(peerError());
		const tr = await renderScreen();
		expect(noticeCount(tr)).toBeGreaterThan(0);
		for (const key of EMPTY_KEYS) expect(allText(tr)).not.toContain(key);
	});

	it("E-6: a generic first-load failure shows the error and no empty-list copy", async () => {
		mockGetElections.mockRejectedValue(new Error("constraint exploded: secret-table"));
		const tr = await renderScreen();
		expect(allText(tr)).toContain("electionsLoadFailed");
		for (const key of EMPTY_KEYS) expect(allText(tr)).not.toContain(key);
	});

	it("E-7: while the first load is pending, no empty-list copy", async () => {
		mockGetElections.mockImplementation(() => new Promise(() => undefined));
		const tr = await renderScreen();
		for (const key of EMPTY_KEYS) expect(allText(tr)).not.toContain(key);
	});

	it("E-8: a successful empty load shows the empty-list copy", async () => {
		mockGetElections.mockResolvedValue([]);
		const tr = await renderScreen();
		expect(allText(tr)).toContain("noCurrentElections");
		expect(allText(tr)).toContain("noProposedElectionsCurrently");
		expect(noticeCount(tr)).toBe(0);
	});

	it("E-9: an older load that succeeds after a newer peer failure does not clear the notice", async () => {
		const first = deferred<unknown[]>();
		const second = deferred<unknown[]>();
		mockGetElections.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const tr = await renderScreen();
		expect(mockGetElections).toHaveBeenCalledTimes(2); // mount load + focus load
		await renderer.act(async () => {
			second.reject(peerError());
		});
		await flush();
		expect(noticeCount(tr)).toBeGreaterThan(0);
		await renderer.act(async () => {
			first.resolve([]);
		});
		await flush();
		expect(noticeCount(tr)).toBeGreaterThan(0);
		expect(allText(tr)).not.toContain("noCurrentElections");
	});

	it("E-10: an older load that fails after a newer success does not raise the notice", async () => {
		const first = deferred<unknown[]>();
		const second = deferred<unknown[]>();
		mockGetElections.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const tr = await renderScreen();
		await renderer.act(async () => {
			second.resolve([]);
		});
		await flush();
		await renderer.act(async () => {
			first.reject(peerError());
		});
		await flush();
		expect(noticeCount(tr)).toBe(0);
		expect(allText(tr)).toContain("noCurrentElections");
	});
});

