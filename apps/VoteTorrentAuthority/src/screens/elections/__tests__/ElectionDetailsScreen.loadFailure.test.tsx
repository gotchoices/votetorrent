/**
 * ElectionDetailsScreen.loadFailure.test.tsx -- a first details read that fails is visible and
 * recoverable (REVIEW/IN-11), non-peer failures show translated copy (gap6/WR-10), and a read
 * made for one election is never shown under another (REVIEW/IN-05).
 */

import React from "react";
import renderer from "react-test-renderer";
import { ThemedText } from "../../../components/ThemedText";
import { consoleTags, leakingCalls, nonLiteralConsoleFirstArgs, untaggedCalls } from "../../__fixtures__/log-content-scan";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// A FRESH `t` on every call of useTranslation: the screen must not put it in effect deps.
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

let mockElectionEngine: any;
jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "p", background: "b", card: "c", text: "t", border: "bo", notification: "n",
			error: "e", textSecondary: "ts", important: "i", success: "s", accent: "a", warning: "w",
		},
	}),
	useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() }),
	// Like the real hook: re-runs when the callback identity changes.
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => cb(), [cb]);
	},
	useRoute: () => ({ params: { electionEngine: mockElectionEngine } }),
}));

const mockShare = jest.fn();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RN = require("react-native");
RN.Share.share = (...a: unknown[]) => mockShare(...a);

function makeDetails(title: string, opts: { withProposedHolder?: boolean } = {}) {
	return {
		election: { id: title, title, authorityId: "a", type: 0, date: Date.UTC(2026, 9, 1), revisionDeadline: 0, ballotDeadline: 0 },
		current: { revision: 1, revisionTimestamp: [], tags: [], timeline: {}, keyholderThreshold: 1, keyholders: [] },
		// The Share control renders only on a proposed-revision holder row, so E-3 needs one.
		proposed: opts.withProposedHolder
			? {
					proposed: { revision: 2, revisionTimestamp: [], tags: [], timeline: {}, keyholderThreshold: 1, keyholders: [{ name: "Holder One" }] },
					signatures: [],
				}
			: undefined,
	};
}

function peerError(): Error {
	return Object.assign(new Error("Block default/app/Admin is unavailable (cohort-unreachable)"), {
		name: "BlockUnavailableError",
		reason: "cohort-unreachable",
	});
}

function makeEngine(getElectionDetails: jest.Mock, getBallots: jest.Mock = jest.fn(async () => [])) {
	return {
		getElectionDetails,
		getBallots,
		getBallotConfirmationState: jest.fn(async () => ({ locked: false, confirmed: false })),
	};
}

async function flush() {
	await renderer.act(async () => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	});
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const getScreen = () => require("../ElectionDetailsScreen").default;

async function renderScreen() {
	const Screen = getScreen();
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<Screen />);
	});
	await flush();
	return tr;
}

function allText(tr: renderer.ReactTestRenderer) {
	return tr.root
		.findAllByType(ThemedText)
		.map((n) => ([] as unknown[]).concat(n.props.children as unknown).join(""))
		.join(" | ");
}
const byId = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAll((n) => n.props?.testID === id);
const hasTitle = (tr: renderer.ReactTestRenderer, title: string) =>
	tr.root.findAll((n) => n.props?.electionDetails?.election?.title === title).length > 0;

let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
beforeEach(() => {
	jest.clearAllMocks();
	warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
	errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	warnSpy.mockRestore();
	errorSpy.mockRestore();
});

describe("ElectionDetailsScreen load failures", () => {
	it("E-1: a first details read that fails shows the translated error and Try Again, not Loading; Try Again recovers", async () => {
		const get = jest.fn().mockRejectedValueOnce(new Error("secret block id")).mockResolvedValueOnce(makeDetails("Spring"));
		mockElectionEngine = makeEngine(get);
		const tr = await renderScreen();

		expect(allText(tr)).not.toContain("loading");
		expect(byId(tr, "election-details-load-error").length).toBeGreaterThan(0);
		expect(JSON.stringify(tr.toJSON())).toContain("electionDetailsLoadFailed");
		expect(JSON.stringify(tr.toJSON())).not.toContain("secret block id");
		const retry = byId(tr, "election-details-retry").filter((n) => typeof n.props.onPress === "function");
		expect(retry.length).toBeGreaterThan(0);
		expect(byId(tr, "election-details-retry")[0].props.title).toBe("loadRetryButton");

		await renderer.act(async () => {
			retry[0].props.onPress();
		});
		await flush();
		expect(get).toHaveBeenCalledTimes(2);
		expect(hasTitle(tr, "Spring")).toBe(true);
		expect(JSON.stringify(tr.toJSON())).not.toContain("electionDetailsLoadFailed");
	});

	it("E-2: the ballots reload that finishes after a failed details read does not erase the details error", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		mockElectionEngine = makeEngine(
			jest.fn().mockRejectedValue(new Error("boom")),
			jest.fn(async () => {
				await gate;
				return [];
			}),
		);
		const tr = await renderScreen();
		expect(byId(tr, "election-details-load-error").length).toBeGreaterThan(0);
		release();
		await flush();
		expect(byId(tr, "election-details-load-error").length).toBeGreaterThan(0);
		expect(JSON.stringify(tr.toJSON())).toContain("electionDetailsLoadFailed");
	});

	it("E-3: a non-peer ballots failure shows electionBallotsLoadFailed, a Share failure electionShareFailed; no raw text", async () => {
		mockElectionEngine = makeEngine(
			jest.fn().mockResolvedValue(makeDetails("Spring", { withProposedHolder: true })),
			jest.fn().mockRejectedValue(new Error("ballots raw text")),
		);
		const tr = await renderScreen();
		let json = JSON.stringify(tr.toJSON());
		expect(json).toContain("electionBallotsLoadFailed");
		expect(json).not.toContain("ballots raw text");

		mockShare.mockRejectedValueOnce(new Error("share raw text"));
		// Never behind an `if`: the Share control must be found, or this half proves nothing.
		const shareButtons = tr.root.findAll((n) => n.props?.title === "shareRevision" && typeof n.props?.onPress === "function");
		expect(shareButtons.length).toBeGreaterThan(0);
		expect(json).not.toContain("electionShareFailed");
		await renderer.act(async () => {
			await shareButtons[0].props.onPress();
		});
		expect(mockShare).toHaveBeenCalledTimes(1);
		json = JSON.stringify(tr.toJSON());
		expect(json).toContain("electionShareFailed");
		expect(json).not.toContain("share raw text");
	});

	it("E-3 regression: a peer failure still shows the peer notice", async () => {
		mockElectionEngine = makeEngine(jest.fn().mockRejectedValue(peerError()));
		const tr = await renderScreen();
		expect(byId(tr, "peer-read-unavailable-notice").length).toBeGreaterThan(0);
		expect(JSON.stringify(tr.toJSON())).not.toContain("electionDetailsLoadFailed");
	});

	it("E-4: the screen re-pointed at election B (peer failure) shows none of election A's read", async () => {
		const a = makeEngine(
			jest.fn().mockResolvedValue(makeDetails("Election A")),
			jest.fn().mockResolvedValue([{ id: "ballot-a", title: "Ballot of A" }]),
		);
		mockElectionEngine = a;
		const tr = await renderScreen();
		expect(hasTitle(tr, "Election A")).toBe(true);

		mockElectionEngine = makeEngine(jest.fn().mockRejectedValue(peerError()), jest.fn().mockRejectedValue(peerError()));
		const Screen = getScreen();
		await renderer.act(async () => {
			tr.update(<Screen />);
		});
		await flush();

		expect(hasTitle(tr, "Election A")).toBe(false);
		const json = JSON.stringify(tr.toJSON());
		expect(json).not.toContain("Election A");
		expect(json).not.toContain("Ballot of A");
		expect(byId(tr, "peer-read-unavailable-notice").length).toBeGreaterThan(0);
		expect(allText(tr)).toContain("peerReadUnavailableTitle");
	});

	it("E-5: the screen's own failure logs carry only tags, class names and reason tokens", async () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const src: string = require("fs").readFileSync(require("path").join(__dirname, "..", "ElectionDetailsScreen.tsx"), "utf8");
		const tags = consoleTags(src);
		expect(tags.size).toBeGreaterThan(0);
		// A log whose first argument is built at runtime (template literal, concatenation) fails here.
		expect(nonLiteralConsoleFirstArgs(src)).toEqual([]);

		mockElectionEngine = makeEngine(jest.fn().mockRejectedValue(new Error("secret details text")), jest.fn().mockRejectedValue(new Error("secret ballots text")));
		await renderScreen();
		mockElectionEngine = makeEngine(jest.fn().mockRejectedValue(peerError()), jest.fn().mockRejectedValue(peerError()));
		await renderScreen();

		// EVERY spied call, not only the tagged ones (REVIEW WR-R5-01).
		const calls = [...warnSpy.mock.calls, ...errorSpy.mock.calls];
		expect(calls.filter((c) => typeof c[0] === "string" && tags.has(c[0])).length).toBeGreaterThanOrEqual(4);
		expect(untaggedCalls(calls, tags)).toEqual([]);
		expect(leakingCalls(calls, ["secret"])).toEqual([]);
		for (const call of calls) {
			for (const arg of call) expect(typeof arg).toBe("string");
		}
	});
});
