/**
 * ElectionDetailsScreen.resultsEntry.test.tsx — the Results entry navigates to ElectionResults with the election id
 * and its public title only. Scaffold copied from ElectionDetailsScreen.registrantsEntry.test.tsx.
 */

import React from "react";
import renderer from "react-test-renderer";

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
// Prefixed `mock` so babel-plugin-jest-hoist allows the jest.mock() factory
// below (hoisted above this declaration) to close over it.
let mockElectionEngine: any;

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
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			cb();
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
	useRoute: () => ({ params: { electionEngine: mockElectionEngine } }),
}));

function makeElectionEngine() {
	return {
		getElectionDetails: jest.fn(async () => ({
			election: {
				id: "election-1",
				title: "Test Election",
				authorityId: "authority-1",
				type: 0,
				date: Date.now(),
				revisionDeadline: Date.now(),
				ballotDeadline: Date.now(),
			},
			current: {
				revision: 1,
				revisionTimestamp: [],
				tags: [],
				timeline: {},
				keyholderThreshold: 0,
				keyholders: [],
			},
			proposed: undefined,
		})),
		getBallots: jest.fn(async () => []),
	};
}

/** Same helper as Suite A — see ElectionDetailsScreen.navigation.test.tsx for the "why" comment. */
async function press(tr: renderer.ReactTestRenderer, testID: string): Promise<void> {
	const wrapper = tr.root.findByProps({ testID });
	const candidates = wrapper.findAll(
		(node) => typeof node.props.onPressIn === "function" || typeof node.props.onPress === "function",
	);
	expect(candidates.length).toBeGreaterThan(0);
	const target = candidates[0]!;
	await renderer.act(async () => {
		if (typeof target.props.onPressIn === "function") {
			target.props.onPressIn();
		} else {
			target.props.onPress();
		}
	});
	await renderer.act(async () => {
		await Promise.resolve();
	});
}

const REGISTRATION_POLICY_TESTID = "election-details-registration-policy-entry";
const REGISTRANTS_TESTID = "election-details-registrants-entry";

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const ElectionDetailsScreenModule = require("../ElectionDetailsScreen");
	const ElectionDetailsScreen = ElectionDetailsScreenModule.default;

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<ElectionDetailsScreen />);
	});
	await renderer.act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
	return tr;
}

beforeEach(() => {
	jest.clearAllMocks();
	mockElectionEngine = makeElectionEngine();
});

const RESULTS_TESTID = "election-details-results-entry";

describe("ElectionDetailsScreen — Results entry", () => {
	it("renders beside the Registrants entry", async () => {
		const tr = await renderScreen();
		expect(() => tr.root.findByProps({ testID: RESULTS_TESTID })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: REGISTRANTS_TESTID })).not.toThrow();
	});

	it("navigates to ElectionResults with exactly the election id, title and authority id", async () => {
		const tr = await renderScreen();
		await press(tr, RESULTS_TESTID);
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		const [routeName, params] = mockNavigate.mock.calls[0]!;
		expect(routeName).toBe("ElectionResults");
		expect(params).toEqual({ electionId: "election-1", electionTitle: "Test Election", authorityId: "authority-1" });
	});
});
