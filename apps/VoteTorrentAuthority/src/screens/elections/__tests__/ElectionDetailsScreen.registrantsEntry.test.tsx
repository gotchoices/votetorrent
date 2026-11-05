/**
 * ElectionDetailsScreen.registrantsEntry.test.tsx — the D-07 election-roster
 * entry (Phase 47 plan 47-21). This is the D-07 sibling of Phase 46's D-01
 * suite: the D-01 entry (RegistrationPolicy) shipped with ZERO automated
 * coverage until a validation pass caught it (`ed5cde8`). The strongest
 * available leg — the real navigator really resolving `RegistrantsList` —
 * lives in `src/navigation/__tests__/phase47Routes.test.tsx` (Task 1), which
 * this suite complements rather than duplicates.
 *
 * Scaffold copied wholesale from `ElectionDetailsScreen.navigation.test.tsx`
 * (Suite A).
 */

import React from "react";
import renderer from "react-test-renderer";
import fs from "fs";
import path from "path";

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

describe("ElectionDetailsScreen — Registrants entry is the D-07 election roster (47-21)", () => {
	it("the entry renders, and the Phase 46 Registration Policy entry beside it still renders too", async () => {
		const tr = await renderScreen();
		expect(() => tr.root.findByProps({ testID: REGISTRANTS_TESTID })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: REGISTRATION_POLICY_TESTID })).not.toThrow();
	});

	it("pressing it navigates to RegistrantsList with the exact D-07 params", async () => {
		const tr = await renderScreen();

		expect(mockNavigate).not.toHaveBeenCalled();

		await press(tr, REGISTRANTS_TESTID);

		expect(mockNavigate).toHaveBeenCalledTimes(1);
		const [routeName, params] = mockNavigate.mock.calls[0]!;
		expect(routeName).toBe("RegistrantsList");
		expect(params).toEqual({
			authorityId: "authority-1",
			electionFilter: { electionId: "election-1", electionTitle: "Test Election" },
		});
	});

	// D-07 shape lock: no extra field, and in particular no engine handle —
	// every field added here is a field RegistrantsListScreen's route
	// destructure does not know about.
	it("the electionFilter object's keys are exactly [electionId, electionTitle]", async () => {
		const tr = await renderScreen();
		await press(tr, REGISTRANTS_TESTID);
		const [, params] = mockNavigate.mock.calls[0]!;
		expect(Object.keys(params.electionFilter).sort()).toEqual(["electionId", "electionTitle"]);
	});

	// T-47-21-01 param hygiene. electionTitle IS present — the single knowing
	// exception (public metadata, needed for the roster header).
	it("the params carry no private/identifying fields beyond the documented exception", async () => {
		const tr = await renderScreen();
		await press(tr, REGISTRANTS_TESTID);
		const [, params] = mockNavigate.mock.calls[0]!;
		const json = JSON.stringify(params);
		for (const forbidden of ["ssn", "district", "lastName", "firstName", "Engine", "private"]) {
			expect(json).not.toContain(forbidden);
		}
		expect(params.electionFilter.electionTitle).toBe("Test Election");
	});

	// The two entries navigate to different routes — a copy-paste of the
	// neighbouring onPress is the most likely defect on this screen.
	it("the Registration Policy entry and the Registrants entry navigate to different routes", async () => {
		const tr = await renderScreen();
		await press(tr, REGISTRATION_POLICY_TESTID);
		const firstRoute = mockNavigate.mock.calls[0]![0];
		await press(tr, REGISTRANTS_TESTID);
		const secondRoute = mockNavigate.mock.calls[1]![0];
		expect(firstRoute).not.toBe(secondRoute);
	});

	// No cast-driven type escape — protects the deliberate `as any` omission
	// recorded in ElectionDetailsScreen.tsx, not a style policy.
	it("the RegistrantsList navigate call site contains no `as any`", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "ElectionDetailsScreen.tsx"), "utf8");
		const start = source.indexOf('navigate("RegistrantsList"');
		expect(start).toBeGreaterThanOrEqual(0);
		const end = source.indexOf(");", start);
		expect(end).toBeGreaterThan(start);
		const statement = source.slice(start, end);
		expect(statement).not.toContain("as any");
	});
});
