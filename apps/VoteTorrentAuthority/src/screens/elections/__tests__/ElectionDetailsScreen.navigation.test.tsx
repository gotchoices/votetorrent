/**
 * ElectionDetailsScreen.navigation.test.tsx — closes half of the Phase 46
 * (D-01) Nyquist gap: "the single RegistrationPolicy route and its
 * ElectionDetailsScreen entry point have NO automated coverage anywhere in
 * the app."
 *
 * D-01 (46-CONTEXT.md): "One RegistrationPolicy route reached from
 * ElectionDetailsScreen ... No new top-level section; no
 * src/screens/registration/ tree this phase."
 *
 * Suite A (this file) — ElectionDetailsScreen in isolation, real component +
 * a mocked navigation prop (the AdministratorInvitationScreen.test.tsx
 * pattern). Proves the screen's own onPress handler calls
 * navigation.navigate("RegistrationPolicy", {electionEngine, electionId,
 * authorityId}) with the exact route name and the exact scalar values
 * sourced from the loaded ElectionDetails — the real handler executes, not a
 * restatement of it.
 *
 * Suite B (ElectionDetailsScreen.registrationPolicyRoute.test.tsx, sibling
 * file — split out because it needs the REAL @react-navigation/native module
 * while this file needs it fully mocked; jest.mock() is file-scoped, not
 * describe-scoped) proves the end-to-end wiring: the real Stack.Screen
 * registration in navigation/index.tsx really maps "RegistrationPolicy" to
 * whatever module it imports as RegistrationPolicyScreen, and pressing this
 * same entry card in the real navigator really reaches it.
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
	// Deferred via a real useEffect (not called synchronously during render)
	// so the resulting setState calls land in a commit phase, matching real
	// useFocusEffect's behavior. Calling cb() unconditionally during render
	// (as a naive mock would) causes an infinite re-render loop here because
	// ElectionDetailsScreen's loadBallots sets state on every invocation.
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			cb();
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
	useRoute: () => ({ params: { electionEngine: mockElectionEngine, authorityName: "Lab Auth" } }),
}));

// ---------------------------------------------------------------------------
// Fixture — a minimal but structurally complete ElectionDetails the real
// ElectionDetailsScreen render path can consume without crashing
// (getElectionDetails + getBallots are the only two engine calls it makes on
// mount/focus per the file's own render-order comment).
// ---------------------------------------------------------------------------
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

/**
 * Fires the real onPress reachable under `testID`. Mirrors
 * RegistrationPolicyScreen.test.tsx's `press()` helper: InfoCard's testID
 * lives on a wrapping View (no handler of its own) — the TouchableOpacity
 * with the actual onPress is a descendant. Asserting a non-empty candidate
 * list BEFORE firing turns a renamed/restructured control into a loud
 * failure instead of a silent no-op pass.
 */
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

describe("ElectionDetailsScreen — Registration Policy entry calls navigate() correctly (D-01, Suite A)", () => {
	it("the Registration Policy entry card is present once the election loads", async () => {
		const tr = await renderScreen();
		expect(() => tr.root.findByProps({ testID: ENTRY_TESTID })).not.toThrow();
	});

	it("pressing the Registration Policy entry card navigates to the RegistrationPolicy route with the loaded election's id/authorityId", async () => {
		const tr = await renderScreen();

		expect(mockNavigate).not.toHaveBeenCalled();

		await press(tr, ENTRY_TESTID);

		expect(mockNavigate).toHaveBeenCalledTimes(1);
		const [routeName, params] = mockNavigate.mock.calls[0]!;
		expect(routeName).toBe("RegistrationPolicy");
		expect(params).toMatchObject({
			electionEngine: mockElectionEngine,
			electionId: "election-1",
			authorityId: "authority-1",
		});
	});
});

describe("ElectionDetailsScreen — authority header (UAT 62 N2)", () => {
	it("renders the route's authorityName instead of the raw authority id", async () => {
		const tree = await renderScreen();
		expect(tree.root.findByProps({ testID: "election-details-authority" }).props.children).toBe("Lab Auth");
	});
});
