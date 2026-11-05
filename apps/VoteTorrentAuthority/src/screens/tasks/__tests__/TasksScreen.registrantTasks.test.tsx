/**
 * TasksScreen.registrantTasks.test.tsx — the 48-11 handoff, resolved by
 * 48-18 (T-48-18-11): `'registrant'` signature tasks are excluded from the
 * generic Tasks list (both the `isEmpty` computation and the rendered card
 * set), while `getRequestedSignatures(true)` — 48-11's idempotent
 * pull-and-seed call — keeps firing unchanged.
 *
 * DEVIATION (disclosed, per this plan's own instruction): this suite uses
 * `jest.fn()`-backed engine stubs rather than the real `dist/`-required mock
 * engines `RegistrantsListScreen.test.tsx` mandates elsewhere in this phase.
 * The assertion here is a PURE FILTER PREDICATE over a caller-supplied
 * `SignatureTask[]`, and a real mock engine would take away this test's
 * control over exactly which signature types are present — the same
 * justification `AdministratorInvitationScreen.test.tsx`'s stub pattern
 * already carries in this repo.
 */

import React from "react";
import renderer from "react-test-renderer";

const mockGetKeysToRelease = jest.fn(async () => [] as unknown[]);
const mockGetRequestedSignatures = jest.fn(async () => [] as unknown[]);
const mockKeysTasksEngine = { getKeysToRelease: mockGetKeysToRelease };
const mockSignatureTasksEngine = { getRequestedSignatures: mockGetRequestedSignatures };

const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "keysTasksEngine") return mockKeysTasksEngine;
	if (name === "signatureTasksEngine") return mockSignatureTasksEngine;
	return undefined;
});

const mockNavigate = jest.fn();
const mockSetOptions = jest.fn();

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

jest.mock("@react-navigation/native", () => {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { useEffect } = require("react");
	return {
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
		useNavigation: () => ({ navigate: mockNavigate, setOptions: mockSetOptions }),
		// Invokes the focus callback ONCE, deferred to a post-render effect —
		// NOT synchronously during render (TasksScreen.loadTasksEngines calls
		// setLoadError/setHasNetwork BEFORE its first await, so a
		// synchronous-during-render invocation triggers React's
		// "Too many re-renders" render-phase-update loop guard).
		useFocusEffect: (cb: () => (() => void) | void) => {
			useEffect(() => {
				cb();
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, []);
		},
	};
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TasksScreenModule = require("../TasksScreen");
const TasksScreen = TasksScreenModule.default ?? TasksScreenModule.TasksScreen;

async function flushTicks(count: number): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < count; i++) {
			await Promise.resolve();
		}
	});
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<TasksScreen />);
	});
	await flushTicks(4);
	return tr;
}

const registrantTask = {
	type: "signature",
	userId: "user-1",
	signatureType: "registrant",
	requestId: "req-1",
	network: { name: "Test Network" },
};

const adminTask = {
	type: "signature",
	userId: "user-1",
	signatureType: "admin",
	network: { name: "Test Network" },
	authority: { name: "Test Authority" },
};

// CR-01 (48-30, Task 3): fixtures for the two additional non-registrant types exercised below.
// Each carries a distinguishable rendered string the way `adminTask` carries `authority.name` —
// read from TaskCard.tsx's per-type `determineInfo` switch (ballot: title = ballot.proposed
// description; network: title = network.name).
const ballotTask = {
	type: "signature",
	userId: "user-1",
	signatureType: "ballot",
	network: { name: "Test Network" },
	ballot: { proposed: { id: "ballot-1", description: "Ballot Card Marker", timestamp: Date.now() } },
};

const networkTask = {
	type: "signature",
	userId: "user-1",
	signatureType: "network",
	network: { name: "Network Card Marker" },
};

beforeEach(() => {
	jest.clearAllMocks();
	mockGetKeysToRelease.mockResolvedValue([]);
	mockGetRequestedSignatures.mockResolvedValue([]);
});

describe("TasksScreen — 'registrant' signature tasks are excluded (48-11 handoff, 48-18)", () => {
	it("a 'registrant' signature task renders no card and no navigation target", async () => {
		mockGetRequestedSignatures.mockResolvedValue([registrantTask, adminTask]);

		const tr = await renderScreen();

		// The non-'registrant' task's own title text renders exactly once.
		const treeText = JSON.stringify(tr.toJSON());
		expect(treeText).toContain("Test Authority");

		// Every rendered TouchableOpacity card, pressed, must never navigate
		// carrying the 'registrant' task.
		const pressables = tr.root.findAll(
			(node) => typeof node.props.onPress === "function" && node.props.testID === undefined
		);
		await renderer.act(async () => {
			for (const p of pressables) {
				try {
					p.props.onPress();
				} catch {
					// non-card pressables (if any) are irrelevant here
				}
			}
		});
		for (const call of mockNavigate.mock.calls) {
			const [, params] = call as [string, { task?: { signatureType?: string } }];
			expect(params?.task?.signatureType).not.toBe("registrant");
		}
	});

	it("an authority whose only signature task is 'registrant' renders the empty state, not a bare section header", async () => {
		mockGetRequestedSignatures.mockResolvedValue([registrantTask]);
		mockGetKeysToRelease.mockResolvedValue([]);

		const tr = await renderScreen();

		expect(() => tr.root.findByProps({ children: "noTasks" })).not.toThrow();
		const treeText = JSON.stringify(tr.toJSON());
		expect(treeText).not.toContain("chipSignature");
		expect(treeText).not.toContain("Test Network");
	});

	it("the pull-and-seed call still fires unchanged", async () => {
		mockGetRequestedSignatures.mockResolvedValue([registrantTask]);

		await renderScreen();

		expect(mockGetRequestedSignatures).toHaveBeenCalledWith(true);
		expect(mockGetKeysToRelease).toHaveBeenCalledWith(true);
	});

	// CR-01 (48-30, Task 3): this test proves ONLY "given this array, these cards render" against
	// a jest.fn()-stubbed engine — it proves nothing about whether the REAL engine produces this
	// array (that is the mocha suite in registrant-seeding-scope.spec.ts, Task 2) and nothing
	// about a real device (48-32). Without CR-01's fix, a single foreign-authority
	// RegistrationRequest would make the REAL getRequestedSignatures(true) reject outright,
	// bricking this screen for every signature type — a failure mode this jest stub cannot
	// reproduce, since the mock never throws. This test only guards the render layer's OWN
	// contract: given a mixed list that happens to include a 'registrant' task, every
	// non-registrant type still renders its own card.
	it("renders a card for every non-registrant signature type when a registrant task is also present", async () => {
		const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
		mockGetRequestedSignatures.mockResolvedValue([registrantTask, adminTask, ballotTask, networkTask]);

		const tr = await renderScreen();

		const treeText = JSON.stringify(tr.toJSON());
		expect(treeText).toContain("Test Authority"); // admin card title
		expect(treeText).toContain("Ballot Card Marker"); // ballot card title
		expect(treeText).toContain("Network Card Marker"); // network card title

		// noTasks must NOT render — cards are present.
		expect(() => tr.root.findByProps({ children: "noTasks" })).toThrow();

		// No InlineError message renders — loadTasksEngines never hit its catch branch.
		expect(consoleErrorSpy).not.toHaveBeenCalled();

		consoleErrorSpy.mockRestore();
	});
});
