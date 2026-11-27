/**
 * TasksScreen.keyRelease.test.tsx — 62-29 (D-20): a release-key task in the inbox opens the
 * KeyRelease route (the signer-less KeyTask route is gone); signature tasks still open
 * SignatureTask. Stub harness copied from `TasksScreen.registrantTasks.test.tsx`.
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

const releaseTask = {
	type: "release-key",
	userId: "kh-1",
	network: { name: "Release Network Marker" },
	election: { election: { id: "e-1", title: "Release Election Marker", authorityId: "a-1", date: Date.now() }, current: { timeline: {} } },
};

const adminTask = {
	type: "signature",
	userId: "user-1",
	signatureType: "admin",
	network: { name: "Test Network" },
	authority: { name: "Test Authority" },
};

beforeEach(() => {
	jest.clearAllMocks();
	mockGetKeysToRelease.mockResolvedValue([]);
	mockGetRequestedSignatures.mockResolvedValue([]);
});

function cardPressables(tr: renderer.ReactTestRenderer) {
	return tr.root.findAll((node) => typeof node.props.onPress === "function" && node.props.testID === undefined);
}

describe("TasksScreen — release-key routing (62-29, D-20)", () => {
	it("T1: pressing a release-key task card navigates to KeyRelease with the same task and never to KeyTask", async () => {
		mockGetKeysToRelease.mockResolvedValue([releaseTask]);
		const tr = await renderScreen();

		await renderer.act(async () => {
			for (const p of cardPressables(tr)) {
				try {
					p.props.onPress();
				} catch {
					// non-card pressables are irrelevant here
				}
			}
		});

		const keyRelease = mockNavigate.mock.calls.filter((c) => c[0] === "KeyRelease");
		// The card wraps several pressables bound to one handler, so the press may fire more than once.
		expect(keyRelease.length).toBeGreaterThanOrEqual(1);
		for (const call of keyRelease) expect(call[1].task).toBe(releaseTask);
		expect(mockNavigate.mock.calls.some((c) => c[0] === "KeyTask")).toBe(false);
	});

	it("T2: a signature task still navigates to SignatureTask", async () => {
		mockGetRequestedSignatures.mockResolvedValue([adminTask]);
		const tr = await renderScreen();

		await renderer.act(async () => {
			for (const p of cardPressables(tr)) {
				try {
					p.props.onPress();
				} catch {
					// non-card pressables are irrelevant here
				}
			}
		});

		const sig = mockNavigate.mock.calls.filter((c) => c[0] === "SignatureTask");
		expect(sig.length).toBeGreaterThanOrEqual(1);
		for (const call of sig) expect(call[1].task).toBe(adminTask);
		expect(mockNavigate.mock.calls.some((c) => c[0] === "KeyRelease")).toBe(false);
	});
});
