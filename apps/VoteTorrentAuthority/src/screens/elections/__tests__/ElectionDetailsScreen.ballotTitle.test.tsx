/**
 * Ballot row title (UAT 62 gap 4 item 4): the row is titled by the ballot's
 * description, falling back to the template copy; never the authority's raw id.
 */
import React from "react";
import renderer from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let mockElectionEngine: any;

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "p", background: "b", card: "c", text: "t", border: "bo", notification: "n",
			error: "e", textSecondary: "ts", important: "i", success: "s", accent: "a", warning: "w",
		},
	}),
	useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			cb();
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
	useRoute: () => ({ params: { electionEngine: mockElectionEngine } }),
}));

const AUTHORITY_ID = "5ec4aee6-0000-4000-8000-aaaaaaaaaaaa";

function makeEngine(description: string) {
	return {
		getElectionDetails: jest.fn(async () => ({
			election: {
				id: "election-1", title: "Test Election", authorityId: "authority-1", type: 0,
				date: Date.now(), revisionDeadline: Date.now(), ballotDeadline: Date.now(),
			},
			current: {
				revision: 1, revisionTimestamp: [], tags: [], timeline: {},
				keyholderThreshold: 0, keyholders: [],
			},
			proposed: undefined,
		})),
		getBallots: jest.fn(async () => [
			{ id: "b1", electionId: "election-1", authorityId: AUTHORITY_ID, description },
		]),
		getBallotConfirmationState: jest.fn(async () => ({ confirmed: false, locked: false })),
	};
}

async function renderScreen(): Promise<string> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Screen = require("../ElectionDetailsScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<Screen />);
	});
	await renderer.act(async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	});
	return JSON.stringify(tr.toJSON());
}

describe("ElectionDetailsScreen ballot row title", () => {
	it("T1: titled with the ballot description, authority id absent", async () => {
		mockElectionEngine = makeEngine("Main ballot");
		const out = await renderScreen();
		expect(out).toContain("Main ballot");
		expect(out).not.toContain(AUTHORITY_ID);
	});

	it("T2: an empty description falls back to the template copy, never the authority id", async () => {
		mockElectionEngine = makeEngine("");
		const out = await renderScreen();
		expect(out).toContain("ballotTemplate");
		expect(out).not.toContain(AUTHORITY_ID);
	});
});
