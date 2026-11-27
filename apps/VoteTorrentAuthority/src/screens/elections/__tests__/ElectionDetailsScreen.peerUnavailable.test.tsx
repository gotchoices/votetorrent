/**
 * ElectionDetailsScreen.peerUnavailable.test.tsx — gap 7 (D-23/D-39). After both apps relaunched
 * and re-dialed, `getElectionDetails` failed `Block default/app/... is unavailable
 * (cohort-unreachable)`: the screen put the raw engine message in errorMessage, the ballots focus
 * effect cleared it, and the screen sat on "Loading" forever. A read the network could not answer
 * now shows an explicit can't-reach-other-devices state (or keeps the details already read), which
 * the ballots reload cannot erase. Non-peer errors keep today's InlineError path.
 *
 * Mock preamble copied from ElectionDetailsScreen.engineKeyholders.test.tsx.
 */

import React from "react";
import renderer from "react-test-renderer";
import { ThemedText } from "../../../components/ThemedText";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
let mockElectionEngine: any;
const mockFocusCallbacks: Array<() => void | (() => void)> = [];

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
	useFocusEffect: (cb: () => void | (() => void)) => {
		mockFocusCallbacks.push(cb);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			cb();
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
	useRoute: () => ({ params: { electionEngine: mockElectionEngine } }),
}));

function makeDetails() {
	return {
		election: {
			id: "election-1",
			title: "Spring Election",
			authorityId: "authority-1",
			type: 0,
			date: Date.UTC(2026, 9, 1),
			revisionDeadline: Date.UTC(2026, 9, 1),
			ballotDeadline: Date.UTC(2026, 9, 1),
		},
		current: {
			revision: 1,
			revisionTimestamp: [],
			tags: [],
			timeline: {},
			keyholderThreshold: 1,
			keyholders: [],
		},
		proposed: undefined,
	};
}

function peerUnavailableError(): Error {
	return Object.assign(
		new Error("Block default/app/Admin is unavailable (cohort-unreachable): the repo could not determine whether it exists"),
		{ name: "BlockUnavailableError", reason: "cohort-unreachable" }
	);
}

/** getBallots resolves only when the test says so, so the ballots effect can be made to finish AFTER the details read. */
function deferredBallots() {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		release: () => release(),
		getBallots: jest.fn(async () => {
			await gate;
			return [];
		}),
	};
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
		for (let i = 0; i < 6; i++) {
			// eslint-disable-next-line no-await-in-loop
			await Promise.resolve();
		}
	});
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const ElectionDetailsScreen = require("../ElectionDetailsScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<ElectionDetailsScreen />);
	});
	await flush();
	return tr;
}

/** Simulate a re-focus by invoking the latest two focus callbacks (details, then ballots). */
async function refocus() {
	const callbacks = mockFocusCallbacks.splice(0);
	await renderer.act(async () => {
		callbacks.slice(-2).forEach((cb) => cb());
	});
	await flush();
}

function textOf(node: renderer.ReactTestInstance): string {
	return ([] as unknown[]).concat(node.props.children as unknown).join("");
}

function allText(tr: renderer.ReactTestRenderer): string {
	return tr.root.findAllByType(ThemedText).map(textOf).join(" | ");
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
	mockFocusCallbacks.splice(0);
	warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warnSpy.mockRestore();
});

describe("ElectionDetailsScreen — a read the network could not answer is not absence (gap 7)", () => {
	it("first focus rejected cohort-unreachable: the unavailable notice replaces Loading, and the later ballots reload does not clear it", async () => {
		const ballots = deferredBallots();
		mockElectionEngine = makeEngine(jest.fn().mockRejectedValue(peerUnavailableError()), ballots.getBallots);
		const tr = await renderScreen();

		expect(noticeShown(tr)).toBe(true);
		expect(allText(tr)).toContain("peerReadUnavailableTitle");
		expect(allText(tr)).not.toContain("loading");

		// The ballots focus effect finishes AFTER the details read failed.
		ballots.release();
		await flush();
		expect(ballots.getBallots).toHaveBeenCalled();

		const text = allText(tr);
		expect(noticeShown(tr)).toBe(true);
		expect(text).toContain("peerReadUnavailableTitle");
		expect(text).toContain("peerReadUnavailableBody");
		expect(text).not.toContain("loading");
		expect(text).not.toContain("is unavailable");
		expect(text).not.toContain("default/app/Admin");
		const peerLogs = warnSpy.mock.calls.filter((c) => String(c[0]).includes("peer read unavailable"));
		expect(peerLogs).toEqual([["[election-details] peer read unavailable:", "cohort-unreachable"]]);
	});

	it("loaded on a first focus, rejected on a refocus: the election stays, plus the stale notice; Try Again re-reads", async () => {
		const getElectionDetails = jest.fn().mockResolvedValueOnce(makeDetails());
		mockElectionEngine = makeEngine(getElectionDetails);
		const tr = await renderScreen();
		expect(noticeShown(tr)).toBe(false);
		expect(tr.root.findAll((n) => n.props?.electionDetails?.election?.title === "Spring Election").length).toBeGreaterThan(0);

		getElectionDetails.mockRejectedValueOnce(peerUnavailableError());
		await refocus();

		expect(getElectionDetails).toHaveBeenCalledTimes(2);
		expect(tr.root.findAll((n) => n.props?.electionDetails?.election?.title === "Spring Election").length).toBeGreaterThan(0);
		let text = allText(tr);
		expect(text).toContain("peerReadUnavailableStaleBody");
		expect(text).not.toContain("peerReadUnavailableTitle");
		expect(text).not.toContain("is unavailable");

		getElectionDetails.mockResolvedValueOnce(makeDetails());
		await pressRetry(tr);

		expect(getElectionDetails).toHaveBeenCalledTimes(3);
		expect(noticeShown(tr)).toBe(false);
		text = allText(tr);
		expect(text).not.toContain("peerReadUnavailable");
		expect(tr.root.findAll((n) => n.props?.electionDetails?.election?.title === "Spring Election").length).toBeGreaterThan(0);
	});

	it("Try Again from the unavailable state loads the election once the read succeeds", async () => {
		const getElectionDetails = jest.fn().mockRejectedValueOnce(peerUnavailableError()).mockResolvedValueOnce(makeDetails());
		mockElectionEngine = makeEngine(getElectionDetails);
		const tr = await renderScreen();
		expect(noticeShown(tr)).toBe(true);

		await pressRetry(tr);

		expect(getElectionDetails).toHaveBeenCalledTimes(2);
		expect(noticeShown(tr)).toBe(false);
		expect(tr.root.findAll((n) => n.props?.electionDetails?.election?.title === "Spring Election").length).toBeGreaterThan(0);
	});

	it("a non-peer error shows the translated details copy, never its text, and no notice", async () => {
		const getElectionDetails = jest.fn().mockResolvedValueOnce(makeDetails());
		mockElectionEngine = makeEngine(getElectionDetails);
		const tr = await renderScreen();

		getElectionDetails.mockRejectedValueOnce(new Error("boom"));
		await refocus();

		expect(noticeShown(tr)).toBe(false);
		const text = allText(tr);
		expect(text).toContain("electionDetailsLoadFailed");
		expect(text).not.toContain("boom");
		expect(text).not.toContain("peerReadUnavailable");
	});

	it("a non-peer error on the first focus is not masked as unreachable (no notice)", async () => {
		mockElectionEngine = makeEngine(jest.fn().mockRejectedValue(new Error("boom")));
		const tr = await renderScreen();

		expect(noticeShown(tr)).toBe(false);
		expect(allText(tr)).not.toContain("peerReadUnavailable");
	});
});
