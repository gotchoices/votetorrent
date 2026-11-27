/**
 * TasksScreen.threshold.test.tsx — 62-12 (Surface 5, D-09/D-10/D-11).
 *
 * Inbox wiring: the threshold progress note renders per row, an `unreachable` session takes the
 * existing closed-task path (leaves the list AND the badge together, same as a 'registrant'
 * task), a never-throw status read fails open, and the badge (useTaskCount) counts the SAME
 * population TasksScreen renders — both now go through the one shared
 * `loadRenderableSignatureTasks` filter.
 *
 * Mock scaffolding copied from `TasksScreen.registrantTasks.test.tsx` (engine stubs,
 * `useFocusEffect` deferred mock, `flushTicks`, task fixtures), widened with
 * `getTaskSigningStatus`. `../../engines/engine-factory` is mocked (not the real module) so
 * mounting `TasksScreen` never pulls in `rn-entry.ts` -> `@optimystic/quereus-plugin-crypto`,
 * which this shared checkout's hoisted `node_modules` cannot currently resolve for jest
 * (a pre-existing, environment-level gap — see `BallotConfirmation.test.tsx`'s identical
 * `@votetorrent/vote-engine/rn` virtual-mock workaround).
 */

import React from "react";
import { Text } from "react-native";
import renderer from "react-test-renderer";
import type { SigningStatus } from "@votetorrent/vote-core";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock("../../../engines/engine-factory", () => {
	class NoNetworkEstablishedError extends Error {}
	return {
		NoNetworkEstablishedError,
		isNoNetworkEstablishedError: (error: unknown) => error instanceof NoNetworkEstablishedError,
	};
});

function makeStatus(overrides: Partial<SigningStatus>): SigningStatus {
	return {
		nonce: "nonce-1",
		scope: "ceb",
		threshold: 2,
		signatures: 1,
		openTasks: 1,
		rejected: 0,
		reached: false,
		unreachable: false,
		...overrides,
	};
}

const mockGetKeysToRelease = jest.fn(async () => [] as unknown[]);
const mockGetRequestedSignatures = jest.fn(async () => [] as unknown[]);
const mockGetTaskSigningStatus = jest.fn(async (_task: unknown) => null as SigningStatus | null);
const mockKeysTasksEngine = { getKeysToRelease: mockGetKeysToRelease };
const mockSignatureTasksEngine = {
	getRequestedSignatures: mockGetRequestedSignatures,
	getTaskSigningStatus: mockGetTaskSigningStatus,
};

const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "keysTasksEngine") return mockKeysTasksEngine;
	if (name === "signatureTasksEngine") return mockSignatureTasksEngine;
	return undefined;
});

const mockNavigate = jest.fn();
const mockSetOptions = jest.fn();

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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useTaskCount } = require("../../../hooks/useTaskCount");

function CountDisplay() {
	const count = useTaskCount();
	return <Text testID="count">{String(count)}</Text>;
}

async function flushTicks(count: number): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < count; i++) {
			await Promise.resolve();
		}
	});
}

/**
 * react-test-renderer's `findAll` walks the FULL instance tree, which under this jest
 * environment's react-native mock includes both a composite `View`/`Text` wrapper AND its own
 * inner host instance for every RN primitive — the same props (including `testID`) forward to
 * both layers, so a predicate on `props.testID` matches twice per real element. Keep only the
 * innermost (deepest) match per cluster — the one with no matching descendant.
 */
function dedupeNestedMatches(nodes: renderer.ReactTestInstance[]): renderer.ReactTestInstance[] {
	const set = new Set(nodes);
	return nodes.filter((n) => !n.children.some((c) => typeof c !== "string" && set.has(c)));
}

async function renderScreen(element: React.ReactElement = <TasksScreen />): Promise<renderer.ReactTestRenderer> {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(element);
	});
	await flushTicks(4);
	return tr;
}

function makeBallotTask(id: string, title: string) {
	return {
		type: "signature",
		userId: "user-1",
		signatureType: "ballot",
		network: { name: "Test Network" },
		ballot: { proposed: { id, description: title, timestamp: Date.now() } },
	};
}

const registrantTask = {
	type: "signature",
	userId: "user-1",
	signatureType: "registrant",
	requestId: "req-1",
	network: { name: "Test Network" },
};

beforeEach(() => {
	jest.clearAllMocks();
	// jest.clearAllMocks() clears call history ONLY — it does NOT remove a previous
	// `mockImplementation` (that is `resetAllMocks`'s job). T4b reassigns
	// `mockGetEngine.mockImplementation` to a stub lacking `getTaskSigningStatus`; without
	// restoring the default here that override would silently leak into every later test.
	mockGetEngine.mockImplementation(async (name: string): Promise<any> => {
		if (name === "keysTasksEngine") return mockKeysTasksEngine;
		if (name === "signatureTasksEngine") return mockSignatureTasksEngine;
		return undefined;
	});
	mockGetKeysToRelease.mockResolvedValue([]);
	mockGetRequestedSignatures.mockResolvedValue([]);
	mockGetTaskSigningStatus.mockResolvedValue(null);
});

describe("TasksScreen — threshold progress wiring (62-12, Surface 5)", () => {
	it("T1: progress and reached notes render per row", async () => {
		const ballot1 = makeBallotTask("ballot-1", "Ballot One");
		const ballot2 = makeBallotTask("ballot-2", "Ballot Two");
		mockGetRequestedSignatures.mockResolvedValue([ballot1, ballot2]);
		mockGetTaskSigningStatus.mockImplementation(async (task: any) => {
			if (task.ballot.proposed.id === "ballot-1") return makeStatus({ threshold: 2, signatures: 1, reached: false });
			if (task.ballot.proposed.id === "ballot-2") return makeStatus({ threshold: 2, signatures: 2, reached: true });
			return null;
		});

		const tr = await renderScreen();
		const notes = dedupeNestedMatches(tr.root.findAll((node) => node.props.testID === "threshold-progress-note"));
		expect(notes).toHaveLength(2);
		expect(JSON.stringify(notes[0].props.children)).toContain("signatureTaskThresholdProgress");
		expect(JSON.stringify(notes[1].props.children)).toContain("signatureTaskThresholdReached");
	});

	it("T2: a reached task (D-09/D-10) stays in the list", async () => {
		const ballot1 = makeBallotTask("ballot-1", "Ballot One");
		mockGetRequestedSignatures.mockResolvedValue([ballot1]);
		mockGetTaskSigningStatus.mockResolvedValue(makeStatus({ threshold: 2, signatures: 2, reached: true }));

		const tr = await renderScreen();
		const treeText = JSON.stringify(tr.toJSON());
		expect(treeText).toContain("Ballot One");
	});

	it("T3: an unreachable task takes the existing closed path (excluded from the list)", async () => {
		const ballot1 = makeBallotTask("ballot-1", "Ballot One");
		const ballot2 = makeBallotTask("ballot-2", "Ballot Two (unreachable)");
		const ballot3 = makeBallotTask("ballot-3", "Ballot Three");
		mockGetRequestedSignatures.mockResolvedValue([ballot1, ballot2, ballot3]);
		mockGetTaskSigningStatus.mockImplementation(async (task: any) => {
			if (task.ballot.proposed.id === "ballot-2") return makeStatus({ unreachable: true, reached: false });
			return makeStatus({ threshold: 2, signatures: 1, reached: false, unreachable: false });
		});

		const tr = await renderScreen();
		const treeText = JSON.stringify(tr.toJSON());
		expect(treeText).toContain("Ballot One");
		expect(treeText).not.toContain("Ballot Two (unreachable)");
		expect(treeText).toContain("Ballot Three");
	});

	it("T3b: all signature tasks unreachable and no release-key tasks renders the empty state", async () => {
		const ballot1 = makeBallotTask("ballot-1", "Ballot One");
		mockGetRequestedSignatures.mockResolvedValue([ballot1]);
		mockGetKeysToRelease.mockResolvedValue([]);
		mockGetTaskSigningStatus.mockResolvedValue(makeStatus({ unreachable: true, reached: false }));

		const tr = await renderScreen();
		expect(() => tr.root.findByProps({ children: "noTasks" })).not.toThrow();
	});

	it("T4: fail-open — a rejecting status read and a stub with no getTaskSigningStatus member both still render every task with no note", async () => {
		const ballot1 = makeBallotTask("ballot-1", "Ballot One");
		const ballot2 = makeBallotTask("ballot-2", "Ballot Two");
		mockGetRequestedSignatures.mockResolvedValue([ballot1, ballot2]);
		mockGetTaskSigningStatus.mockImplementation(async (task: any) => {
			if (task.ballot.proposed.id === "ballot-1") throw new Error("status read failed");
			return null;
		});

		const tr = await renderScreen();
		const treeText = JSON.stringify(tr.toJSON());
		expect(treeText).toContain("Ballot One");
		expect(treeText).toContain("Ballot Two");
		const notes = dedupeNestedMatches(tr.root.findAll((node) => node.props.testID === "threshold-progress-note"));
		expect(notes).toHaveLength(0);
	});

	it("T4b: a stub engine with no getTaskSigningStatus member still renders every task with no note", async () => {
		const ballot1 = makeBallotTask("ballot-1", "Ballot One");
		mockGetEngine.mockImplementation(async (name: string): Promise<any> => {
			if (name === "keysTasksEngine") return mockKeysTasksEngine;
			if (name === "signatureTasksEngine") return { getRequestedSignatures: mockGetRequestedSignatures };
			return undefined;
		});
		mockGetRequestedSignatures.mockResolvedValue([ballot1]);

		const tr = await renderScreen();
		const treeText = JSON.stringify(tr.toJSON());
		expect(treeText).toContain("Ballot One");
		const notes = dedupeNestedMatches(tr.root.findAll((node) => node.props.testID === "threshold-progress-note"));
		expect(notes).toHaveLength(0);
	});

	it("T5: threshold 1 renders no note node", async () => {
		const ballot1 = makeBallotTask("ballot-1", "Ballot One");
		mockGetRequestedSignatures.mockResolvedValue([ballot1]);
		mockGetTaskSigningStatus.mockResolvedValue(makeStatus({ threshold: 1, signatures: 1, reached: true }));

		const tr = await renderScreen();
		const notes = dedupeNestedMatches(tr.root.findAll((node) => node.props.testID === "threshold-progress-note"));
		expect(notes).toHaveLength(0);
	});

	it("T6: the badge (useTaskCount) counts the SAME population as the list (2, not the raw 3)", async () => {
		const ballot1 = makeBallotTask("ballot-1", "Ballot One");
		const ballot2 = makeBallotTask("ballot-2", "Ballot Two (unreachable)");
		const ballot3 = makeBallotTask("ballot-3", "Ballot Three");
		mockGetRequestedSignatures.mockResolvedValue([ballot1, ballot2, ballot3]);
		mockGetTaskSigningStatus.mockImplementation(async (task: any) => {
			if (task.ballot.proposed.id === "ballot-2") return makeStatus({ unreachable: true, reached: false });
			return makeStatus({ threshold: 2, signatures: 1, reached: false, unreachable: false });
		});

		const listTr = await renderScreen();
		const cardCount = dedupeNestedMatches(listTr.root.findAll((node) => node.props.testID === "task-card-content")).length;
		expect(cardCount).toBe(2);

		const badgeTr = await renderScreen(<CountDisplay />);
		const node = badgeTr.root.findByProps({ testID: "count" });
		expect(parseInt(node.props.children as string, 10)).toBe(2);
	});

	it("T7: registrant tasks are still excluded, getRequestedSignatures(true) still fires, and getTaskSigningStatus is never called for a registrant task", async () => {
		mockGetRequestedSignatures.mockResolvedValue([registrantTask]);

		await renderScreen();

		expect(mockGetRequestedSignatures).toHaveBeenCalledWith(true);
		expect(mockGetTaskSigningStatus).not.toHaveBeenCalled();
	});
});
