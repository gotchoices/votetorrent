/**
 * ElectionDetailsScreen.registrationPolicyRoute.test.tsx — Suite B of the
 * Phase 46 (D-01) Nyquist gap closure (sibling:
 * ElectionDetailsScreen.navigation.test.tsx is Suite A).
 *
 * D-01 (46-CONTEXT.md): "One RegistrationPolicy route reached from
 * ElectionDetailsScreen ... No new top-level section; no
 * src/screens/registration/ tree this phase."
 *
 * This is the strongest proof available for this gap: it renders the REAL
 * RootNavigator (src/navigation/index.tsx) inside a REAL NavigationContainer
 * + SafeAreaProvider (the same pattern __tests__/App.test.tsx already proves
 * works under this Jest RN environment), landed directly on the real
 * ElectionDetailsScreen via `initialState`. Only the DESTINATION screen
 * module (RegistrationPolicyScreen) is replaced with a marker component —
 * the Stack.Screen registration, the "RegistrationPolicy" route-name string,
 * and ElectionDetailsScreen's onPress handler are all the untouched
 * production code from navigation/index.tsx and ElectionDetailsScreen.tsx.
 *
 * A rename of the route name in EITHER file, or removal of the
 * Stack.Screen registration, or a broken navigate() call, makes this test
 * fail — proven below by temporarily mutating navigation/index.tsx's route
 * name and observing RED before reverting (see the mutation note in the
 * PR/validation report; not committed here).
 */

import React from "react";
import renderer from "react-test-renderer";

// Rendering the REAL RootNavigator eagerly loads every screen module in the
// app, so the FIRST test in this file pays the whole module-graph cost. Run
// alone that fits inside Jest's 5s default; run as part of the full suite,
// competing with the other workers, it does not — this file and its Phase 47
// sibling (navigation/__tests__/phase47Routes.test.tsx) were the only two
// that intermittently timed out under full-suite load (observed 2026-08-05:
// RED in one full run, GREEN in the next, GREEN 18/18 in isolation). A
// timeout-flaky navigator proof is worse than a slow one: the gate can no
// longer tell a real route regression from scheduler noise. Raised
// deliberately rather than by shortening the render.
//
// 2026-08-29 re-measurement (Phase 51 Nyquist audit): 30_000 was still
// insufficient — a `yarn jest --clearCache && yarn jest` full run clocked
// this file at 34.205s (cold), while solo cold (no other worker contention)
// it took 23.316s. Root cause is parallel-worker CPU contention across ~98
// suites cold-transforming Babel simultaneously, not a hang — isolated cold
// time is stable. Raised again, with headroom above the observed worst case.
jest.setTimeout(60_000);

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

// navigation/index.tsx eagerly imports every screen module (including
// AuthorityDetailsScreen, which imports ../../providers/AppProvider, which
// imports react-native-splash-view) — a native TurboModule with no binary
// registered under this Jest RN environment. Mocked inert, matching
// __tests__/App.test.tsx's convention (App.tsx -> AppProvider -> same
// import). Not exercised by this test either way (AppProvider itself is
// never rendered here).
jest.mock("react-native-splash-view", () => ({ hideSplash: jest.fn() }));

// AppProvider/CadreNodeProvider (real engines + real @serfab/cadre-core +
// @optimystic/db-p2p-storage-rn) pull in native-binary-backed packages this
// Jest RN environment cannot resolve at all (not just mock — the module
// genuinely isn't installed for this platform target). navigation/index.tsx
// drags both in transitively via AuthorityDetailsScreen's import of
// AppProvider. Mocked to inert pass-throughs, exactly matching
// __tests__/App.test.tsx's convention — neither provider is rendered by
// this test (ElectionDetailsScreen sources its engine from route params,
// not useApp()), so this cannot mask anything this test is meant to prove.
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({}),
	AppProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("../../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: null, syncState: "offline", connectedPeers: () => 0 }),
	CadreNodeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Prefixed `mock` so babel-plugin-jest-hoist allows the jest.mock() factory
// below (hoisted above this declaration) to close over it.
let mockCapturedRouteParams: any = null;

// Replaces ONLY the destination screen module. navigation/index.tsx's import
// of "../screens/elections/RegistrationPolicyScreen" resolves to the same
// absolute file this relative path resolves to from this test file, so the
// real Stack.Screen registration in navigation/index.tsx is left completely
// untouched — it is simply fed this stub component instead of the real
// screen (which needs a live registration engine this test does not set up).
jest.mock("../RegistrationPolicyScreen", () => {
	const ReactLib = require("react");
	const { Text } = require("react-native");
	const { useRoute } = require("@react-navigation/native");
	return {
		__esModule: true,
		default: function MockRegistrationPolicyScreen() {
			const route = useRoute();
			mockCapturedRouteParams = (route as any).params;
			return ReactLib.createElement(
				Text,
				{ testID: "mock-registration-policy-screen" },
				"mock-registration-policy-screen",
			);
		},
	};
});

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

/** Same helper as Suite A — see that file for the "why" comment. */
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

const ENTRY_TESTID = "election-details-registration-policy-entry";

async function renderRootNavigatorOnElectionDetails(
	electionEngine: ReturnType<typeof makeElectionEngine>,
): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { NavigationContainer } = require("@react-navigation/native");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { SafeAreaProvider } = require("react-native-safe-area-context");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { RootNavigator } = require("../../../navigation");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { lightTheme } = require("../../../theme/themes");

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(
			// react-test-renderer never fires a real onLayout event, and
			// react-native-screens' native-stack view gates its content behind
			// SafeAreaProvider's measured frame — without `initialMetrics` the
			// whole Stack.Navigator subtree renders as `children: null` forever
			// (confirmed empirically: even __tests__/App.test.tsx's "renders
			// correctly" smoke test never inspects tree content, so it never
			// hit this). Supplying fake-but-plausible metrics unblocks real
			// rendering without touching jest.config.js or adding a
			// react-native-screens mock.
			<SafeAreaProvider
				initialMetrics={{
					frame: { x: 0, y: 0, width: 320, height: 640 },
					insets: { top: 0, left: 0, right: 0, bottom: 0 },
				}}
			>
				<NavigationContainer
					theme={lightTheme}
					initialState={{
						index: 0,
						routes: [{ name: "ElectionDetails", params: { electionEngine } }],
					}}
				>
					<RootNavigator />
				</NavigationContainer>
			</SafeAreaProvider>,
		);
	});
	// The real screen's mount effects (getElectionDetails/getBallots) are
	// async — flush several ticks so it clears its own "loading" gate.
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
	return tr;
}

beforeEach(() => {
	mockCapturedRouteParams = null;
});

describe("RootNavigator — RegistrationPolicy is really registered and really reached from ElectionDetailsScreen (D-01, Suite B)", () => {
	it("lands on the real ElectionDetailsScreen with the entry card present, not already on RegistrationPolicy", async () => {
		const engine = makeElectionEngine();
		const tr = await renderRootNavigatorOnElectionDetails(engine);

		expect(() => tr.root.findByProps({ testID: ENTRY_TESTID })).not.toThrow();
		expect(() => tr.root.findByProps({ testID: "mock-registration-policy-screen" })).toThrow();
	});

	it("pressing the entry card transitions the REAL navigator to the route registered as RegistrationPolicy, carrying the real electionEngine + election id/authorityId", async () => {
		const engine = makeElectionEngine();
		const tr = await renderRootNavigatorOnElectionDetails(engine);

		await press(tr, ENTRY_TESTID);
		// Native-stack mounts the pushed screen across a couple more commits.
		for (let i = 0; i < 4; i++) {
			// eslint-disable-next-line no-await-in-loop
			await renderer.act(async () => {
				await Promise.resolve();
			});
		}

		expect(() => tr.root.findByProps({ testID: "mock-registration-policy-screen" })).not.toThrow();

		expect(mockCapturedRouteParams).not.toBeNull();
		// Same object reference — proves the REAL electionEngine instance was
		// threaded through the REAL navigate() call, not a re-derived copy.
		expect(mockCapturedRouteParams.electionEngine).toBe(engine);
		expect(mockCapturedRouteParams.electionId).toBe("election-1");
		expect(mockCapturedRouteParams.authorityId).toBe("authority-1");
	});
});
