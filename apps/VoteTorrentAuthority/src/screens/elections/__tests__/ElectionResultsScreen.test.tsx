/**
 * ElectionResultsScreen.test.tsx — the results screen renders each ElectionResultsEngine outcome, recomputes on
 * Refresh, and resolves its engine as 'electionResults'. The engine itself is covered by vote-engine's
 * election-results.spec.ts.
 */

import React from "react";
import renderer from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
	}),
}));

const mockGetEngine = jest.fn();
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "p", background: "b", card: "c", text: "t", border: "bo", notification: "n",
			error: "e", textSecondary: "ts", important: "i", success: "s", accent: "a", warning: "w",
		},
	}),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => cb(), []);
	},
	useRoute: () => ({ params: { electionId: "election-1", electionTitle: "Fruit poll" } }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ElectionResultsScreen = require("../ElectionResultsScreen").default;

const TALLIED = {
	status: "tallied",
	electionId: "election-1",
	revision: 1,
	threshold: 2,
	keyholdersUsed: 2,
	blockCount: 1,
	totals: { blocks: 1, entries: 3, valid: 3, invalid: 0, excluded: 0, undecryptable: 0 },
	ballots: [
		{
			ballotId: "ballot-1",
			description: "Fruit poll",
			votes: 3,
			valid: 3,
			invalid: 0,
			excluded: 0,
			questions: [
				{
					code: "Q1", title: "Favourite fruit", type: "select", counted: true, answered: 3, blank: 0,
					options: [
						{ code: "A", title: "Apple", count: 2 },
						{ code: "B", title: "Banana", count: 1 },
						{ code: "C", title: "Mango", count: 0 },
					],
				},
			],
		},
	],
	tallyRoot: "abcdef0123456789abcdef",
	blockRoot: "00",
	tally: {},
};

function textOf(tr: renderer.ReactTestRenderer, testID: string): string {
	const node = tr.root.findAll((n) => n.props.testID === testID && typeof n.type !== "string")[0];
	if (!node) throw new Error(`no ${testID}`);
	const parts: string[] = [];
	const walk = (x: any): void => {
		if (typeof x === "string") parts.push(x);
		else if (x && x.children) x.children.forEach(walk);
	};
	walk(node);
	return parts.join("");
}

const has = (tr: renderer.ReactTestRenderer, testID: string): boolean => tr.root.findAll((n) => n.props.testID === testID).length > 0;

async function render(results: unknown | Error) {
	const engine = {
		getElectionResults: jest.fn(async () => {
			if (results instanceof Error) throw results;
			return results;
		}),
	};
	mockGetEngine.mockReset();
	mockGetEngine.mockResolvedValue(engine);
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<ElectionResultsScreen />);
	});
	await renderer.act(async () => {
		await Promise.resolve();
	});
	return { tr, engine };
}

describe("ElectionResultsScreen", () => {
	it("computes the election's results through the 'electionResults' engine and shows per-option counts", async () => {
		const { tr, engine } = await render(TALLIED);
		expect(mockGetEngine).toHaveBeenCalledWith("electionResults");
		expect(engine.getElectionResults).toHaveBeenCalledWith("election-1");
		expect(textOf(tr, "results-valid-total")).toContain('"count":3');
		expect(textOf(tr, "results-count-Q1-A")).toBe('resultsOptionCount:{"count":2,"percent":67}');
		expect(textOf(tr, "results-count-Q1-B")).toBe('resultsOptionCount:{"count":1,"percent":33}');
		expect(textOf(tr, "results-count-Q1-C")).toBe('resultsOptionCount:{"count":0,"percent":0}');
		expect(textOf(tr, "results-tally-root")).toContain("abcdef0123456789");
		expect(has(tr, "results-invalid-total")).toBe(false);
		expect(has(tr, "results-awaiting-keys")).toBe(false);
	});

	it("shows the locked state with the released-share count before the key is reconstructable", async () => {
		const { tr } = await render({
			status: "awaiting-keys", electionId: "election-1", phase: "releasing", revision: 1,
			threshold: 2, participants: 2, releasedCount: 1, releasingKeysAt: Date.UTC(2026, 10, 5, 8, 5),
		});
		expect(has(tr, "results-awaiting-keys")).toBe(true);
		expect(textOf(tr, "results-released-count")).toBe('resultsReleasedCount:{"released":1,"needed":2}');
		expect(has(tr, "results-summary")).toBe(false);
	});

	it("says the key is not generated yet when there is no election key", async () => {
		const { tr } = await render({
			status: "awaiting-keys", electionId: "election-1", phase: "no-election-key", revision: 1,
			threshold: null, participants: null, releasedCount: 0, releasingKeysAt: null,
		});
		expect(has(tr, "results-no-key")).toBe(true);
	});

	it("shows the refusal reason when the results cannot be computed", async () => {
		const { tr } = await render({ status: "unavailable", electionId: "election-1", reason: "group-key-mismatch", detail: "x" });
		expect(textOf(tr, "results-unavailable-reason")).toBe('resultsUnavailableReason:{"reason":"group-key-mismatch"}');
	});

	it("shows a load failure when the engine throws, and Refresh computes again", async () => {
		const { tr, engine } = await render(new Error("no network"));
		expect(has(tr, "results-failed")).toBe(true);
		const button = tr.root.findAll((n) => n.props.testID === "results-refresh" && typeof n.props.onPress === "function")[0]!;
		await renderer.act(async () => {
			button.props.onPress();
		});
		await renderer.act(async () => {
			await Promise.resolve();
		});
		expect(engine.getElectionResults).toHaveBeenCalledTimes(2);
	});

	it("says no vote blocks have arrived (never a bare 0) when the device has none yet", async () => {
		const { tr } = await render({ ...TALLIED, blockCount: 0, totals: { ...TALLIED.totals, blocks: 0, entries: 0, valid: 0 } });
		expect(has(tr, "results-no-blocks")).toBe(true);
		expect(has(tr, "results-summary")).toBe(false);
		expect(has(tr, "results-count-Q1-A")).toBe(false);
	});

	it("flags invalid and excluded votes when there are any", async () => {
		const { tr } = await render({ ...TALLIED, totals: { ...TALLIED.totals, invalid: 1, excluded: 3 } });
		expect(textOf(tr, "results-invalid-total")).toContain('"count":1');
		expect(textOf(tr, "results-excluded-total")).toContain('"count":3');
	});
});
