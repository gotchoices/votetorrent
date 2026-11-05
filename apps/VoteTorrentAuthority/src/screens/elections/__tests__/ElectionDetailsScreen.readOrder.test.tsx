/**
 * ElectionDetailsScreen.readOrder.test.tsx — overlapping reads are superseded (code review WR-02).
 *
 * A cohort-unreachable read can take a long time to fail, and Try Again stays enabled meanwhile.
 * Before: the focus load and Try Again each had their own "active" flag and neither superseded the
 * other, so a slow earlier failure landing after a later success re-raised the can't-reach notice
 * over fresh data, and a slow earlier success could overwrite a newer one. Now only the latest
 * read of each kind (details, ballots) may write.
 *
 * Mock preamble copied from ElectionDetailsScreen.peerUnavailable.test.tsx.
 */

import React from "react";
import renderer from "react-test-renderer";
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

function makeDetails(title = "Spring Election") {
	return {
		election: {
			id: "election-1",
			title,
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
		new Error("Block default/app/Election is unavailable (cohort-unreachable): the repo could not determine whether it exists"),
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

function noticeShown(tr: renderer.ReactTestRenderer): boolean {
	return tr.root.findAll((n) => n.props?.testID === "peer-read-unavailable-notice").length > 0;
}

function shownTitle(tr: renderer.ReactTestRenderer): string | undefined {
	return tr.root.findAll((n) => typeof n.props?.electionDetails?.election?.title === "string")[0]?.props.electionDetails
		.election.title;
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

describe("ElectionDetailsScreen — only the latest read may write (WR-02)", () => {
	it("a slow earlier details failure landing after a later success does not re-raise the notice", async () => {
		const slow = deferred<ReturnType<typeof makeDetails>>();
		const getElectionDetails = jest
			.fn()
			.mockRejectedValueOnce(peerUnavailableError()) // focus load
			.mockReturnValueOnce(slow.promise) // Try Again #1: slow, fails later
			.mockResolvedValueOnce(makeDetails()); // Try Again #2: succeeds
		mockElectionEngine = { getElectionDetails, getBallots: jest.fn(async () => []), getBallotConfirmationState: jest.fn() };
		const tr = await renderScreen();
		expect(noticeShown(tr)).toBe(true);

		await pressRetry(tr); // #1 in flight
		await pressRetry(tr); // #2 succeeds
		expect(getElectionDetails).toHaveBeenCalledTimes(3);
		expect(noticeShown(tr)).toBe(false);
		expect(shownTitle(tr)).toBe("Spring Election");

		slow.reject(peerUnavailableError());
		await flush();

		expect(noticeShown(tr)).toBe(false);
		expect(shownTitle(tr)).toBe("Spring Election");
	});

	it("a slow earlier details success does not overwrite a newer one", async () => {
		const slow = deferred<ReturnType<typeof makeDetails>>();
		const getElectionDetails = jest
			.fn()
			.mockRejectedValueOnce(peerUnavailableError())
			.mockReturnValueOnce(slow.promise)
			.mockResolvedValueOnce(makeDetails("Newer Title"));
		mockElectionEngine = { getElectionDetails, getBallots: jest.fn(async () => []), getBallotConfirmationState: jest.fn() };
		const tr = await renderScreen();

		await pressRetry(tr);
		await pressRetry(tr);
		expect(shownTitle(tr)).toBe("Newer Title");

		slow.resolve(makeDetails("Older Title"));
		await flush();

		expect(shownTitle(tr)).toBe("Newer Title");
	});

	it("a slow earlier ballots failure landing after a refocus success does not raise the ballots notice", async () => {
		const slow = deferred<Array<typeof BALLOT>>();
		const getBallots = jest
			.fn()
			.mockReturnValueOnce(slow.promise) // first focus: slow, fails later
			.mockResolvedValueOnce([BALLOT]); // refocus: succeeds
		mockElectionEngine = {
			getElectionDetails: jest.fn(async () => makeDetails()),
			getBallots,
			getBallotConfirmationState: jest.fn(async () => ({ locked: false, confirmed: true })),
		};
		const tr = await renderScreen();

		await refocus();
		expect(getBallots).toHaveBeenCalledTimes(2);
		expect(tr.root.findAllByType(InfoCard).some((n) => n.props.title === "Ballot One")).toBe(true);
		expect(noticeShown(tr)).toBe(false);

		slow.reject(peerUnavailableError());
		await flush();

		expect(noticeShown(tr)).toBe(false);
		expect(tr.root.findAllByType(InfoCard).some((n) => n.props.title === "Ballot One")).toBe(true);
	});
});
