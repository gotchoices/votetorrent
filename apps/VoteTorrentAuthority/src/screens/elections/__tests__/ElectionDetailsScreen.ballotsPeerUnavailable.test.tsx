/**
 * ElectionDetailsScreen.ballotsPeerUnavailable.test.tsx — the ballots read on Election Details goes
 * through the same peer-read classifier as the details read (code review WR-01).
 *
 * Before: a peer-unavailable `getBallots()` failure was rendered as the raw engine message
 * (`Block default/app/... is unavailable (cohort-unreachable): ...`, which names block ids), and a
 * peer-unavailable `getBallotConfirmationState()` failure was swallowed into
 * `{ locked: false, confirmed: false }`, so a confirmed ballot read as "Proposed".
 *
 * Now: the ballots this device last read stay on screen with the stale notice, or the section shows
 * the can't-reach notice instead of "no ballot yet"; a confirmation state that could not be read
 * keeps the last-read badge, or shows no badge, never "Proposed".
 *
 * Mock preamble copied from ElectionDetailsScreen.peerUnavailable.test.tsx.
 */

import React from "react";
import renderer from "react-test-renderer";
import { ThemedText } from "../../../components/ThemedText";
import { InfoCard } from "../../../components/InfoCard";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

let mockElectionEngine: any;
const mockFocusCallbacks: Array<() => void | (() => void)> = [];

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "p", background: "b", card: "c", text: "t", border: "bo", notification: "n",
			error: "e", textSecondary: "ts", important: "i", success: "s", accent: "a", warning: "w",
		},
	}),
	useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() }),
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

const BALLOT = { id: "ballot-1", description: "Ballot One" };

function peerUnavailableError(): Error {
	return Object.assign(
		new Error("Block default/app/Ballot is unavailable (cohort-unreachable): the repo could not determine whether it exists"),
		{ name: "BlockUnavailableError", reason: "cohort-unreachable" }
	);
}

async function flush() {
	await renderer.act(async () => {
		for (let i = 0; i < 8; i++) {
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

function notices(tr: renderer.ReactTestRenderer) {
	// Host nodes only: the composite View and its host View both carry the testID.
	return tr.root.findAll((n) => typeof n.type === "string" && n.props?.testID === "peer-read-unavailable-notice");
}

function ballotCard(tr: renderer.ReactTestRenderer) {
	return tr.root.findAllByType(InfoCard).find((n) => n.props.title === "Ballot One");
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

describe("ElectionDetailsScreen — a ballots read the network could not answer is not absence (WR-01)", () => {
	it("first ballots read rejected cohort-unreachable: no raw block text, no 'no ballot yet', the can't-reach notice instead", async () => {
		mockElectionEngine = {
			getElectionDetails: jest.fn(async () => makeDetails()),
			getBallots: jest.fn().mockRejectedValue(peerUnavailableError()),
			getBallotConfirmationState: jest.fn(async () => ({ locked: false, confirmed: false })),
		};
		const tr = await renderScreen();

		const text = allText(tr);
		expect(text).not.toContain("is unavailable");
		expect(text).not.toContain("default/app/Ballot");
		expect(text).not.toContain("noBallotYet");
		expect(tr.root.findAll((n) => n.props?.title === "createBallotTemplate")).toHaveLength(0);
		expect(notices(tr).length).toBe(1);
		expect(text).toContain("peerReadUnavailableTitle");
		const peerLogs = warnSpy.mock.calls.filter((c) => String(c[0]).includes("peer read unavailable"));
		expect(peerLogs).toEqual([["[election-details] ballots peer read unavailable:", "cohort-unreachable"]]);
	});

	it("ballots read once, then a refocus rejected cohort-unreachable: the ballot stays with the stale notice; Try Again re-reads", async () => {
		const getBallots = jest.fn().mockResolvedValueOnce([BALLOT]);
		mockElectionEngine = {
			getElectionDetails: jest.fn(async () => makeDetails()),
			getBallots,
			getBallotConfirmationState: jest.fn(async () => ({ locked: true, confirmed: true })),
		};
		const tr = await renderScreen();
		expect(ballotCard(tr)?.props.subtitle).toBe("statusConfirmed");
		expect(notices(tr)).toHaveLength(0);

		getBallots.mockRejectedValueOnce(peerUnavailableError());
		await refocus();

		expect(ballotCard(tr)?.props.subtitle).toBe("statusConfirmed");
		let text = allText(tr);
		expect(text).toContain("peerReadUnavailableStaleBody");
		expect(text).not.toContain("is unavailable");
		expect(text).not.toContain("noBallotYet");

		getBallots.mockResolvedValueOnce([BALLOT]);
		await pressRetry(tr);

		expect(getBallots).toHaveBeenCalledTimes(3);
		expect(notices(tr)).toHaveLength(0);
		text = allText(tr);
		expect(text).not.toContain("peerReadUnavailable");
		expect(ballotCard(tr)?.props.subtitle).toBe("statusConfirmed");
	});

	it("a confirmation state that could not be read keeps the last-read badge, never 'Proposed'", async () => {
		const getBallotConfirmationState = jest.fn().mockResolvedValueOnce({ locked: true, confirmed: true });
		mockElectionEngine = {
			getElectionDetails: jest.fn(async () => makeDetails()),
			getBallots: jest.fn(async () => [BALLOT]),
			getBallotConfirmationState,
		};
		const tr = await renderScreen();
		expect(ballotCard(tr)?.props.subtitle).toBe("statusConfirmed");

		getBallotConfirmationState.mockRejectedValueOnce(peerUnavailableError());
		await refocus();

		expect(ballotCard(tr)?.props.subtitle).toBe("statusConfirmed");
		const text = allText(tr);
		expect(text).not.toContain("statusProposed");
		expect(text).not.toContain("is unavailable");
		expect(text).toContain("peerReadUnavailableStaleBody");
	});

	it("a confirmation state never read and not reachable shows no badge, never 'Proposed'", async () => {
		mockElectionEngine = {
			getElectionDetails: jest.fn(async () => makeDetails()),
			getBallots: jest.fn(async () => [BALLOT]),
			getBallotConfirmationState: jest.fn().mockRejectedValue(peerUnavailableError()),
		};
		const tr = await renderScreen();

		expect(ballotCard(tr)).toBeDefined();
		expect(ballotCard(tr)?.props.subtitle).toBeUndefined();
		const text = allText(tr);
		expect(text).not.toContain("statusProposed");
		expect(text).not.toContain("is unavailable");
	});

	it("a non-peer ballots failure shows the translated ballots copy, never its text, and no notice", async () => {
		mockElectionEngine = {
			getElectionDetails: jest.fn(async () => makeDetails()),
			getBallots: jest.fn().mockRejectedValue(new Error("boom")),
			getBallotConfirmationState: jest.fn(async () => ({ locked: false, confirmed: false })),
		};
		const tr = await renderScreen();

		expect(notices(tr)).toHaveLength(0);
		const text = allText(tr);
		expect(text).toContain("electionBallotsLoadFailed");
		expect(text).not.toContain("boom");
		expect(text).not.toContain("peerReadUnavailable");
	});
});
