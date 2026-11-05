/**
 * SignatureTaskScreen.threshold.test.tsx — 62-12 (Surface 5, D-09/D-10/D-11).
 *
 * Detail-screen wiring: the threshold progress note loads on mount and renders first, D-10
 * identical rendering at and past the threshold, D-11 reject-as-vote (no confirm, no second
 * engine call), and the D-11 unreachable-closes path (the session takes the EXISTING closed-task
 * route — `navigation.goBack()` — rather than a new pill).
 *
 * The six `*SignatureTaskDetails` components are mocked as marker-rendering stubs (not plain
 * null) so D1's "before the details component" ordering claim is actually provable from the
 * serialized tree, not merely assumed. `Alert` is spied (not mocked) — `react-native`'s own
 * `Alert.alert` — since this screen does not import `react-native` partially-mocked elsewhere in
 * this suite.
 */

import React from "react";
import { Alert } from "react-native";
import renderer from "react-test-renderer";
import type { SigningStatus } from "@votetorrent/vote-core";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("../components/AdminSignatureTaskDetails", () => ({
	AdminSignatureTaskDetails: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		return <Text testID="details-marker">ADMIN_DETAILS_MARKER</Text>;
	},
}));
jest.mock("../components/AuthoritySignatureTaskDetails", () => ({
	AuthoritySignatureTaskDetails: () => null,
}));
jest.mock("../components/NetworkSignatureTaskDetails", () => ({
	NetworkSignatureTaskDetails: () => null,
}));
jest.mock("../components/ElectionSignatureTaskDetails", () => ({
	ElectionSignatureTaskDetails: () => null,
}));
jest.mock("../components/ElectionRevisionSignatureTaskDetails", () => ({
	ElectionRevisionSignatureTaskDetails: () => null,
}));
jest.mock("../components/BallotSignatureTaskDetails", () => ({
	BallotSignatureTaskDetails: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		return <Text testID="details-marker">BALLOT_DETAILS_MARKER</Text>;
	},
}));

const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
let mockRouteTask: unknown = null;

jest.mock("@react-navigation/native", () => ({
	useRoute: () => ({ params: { task: mockRouteTask } }),
	useNavigation: () => ({ goBack: mockGoBack, setOptions: mockSetOptions }),
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
			dark: "sentinel-dark",
			light: "sentinel-light",
		},
	}),
}));

const mockGetTaskSigningStatus = jest.fn(async (_task: unknown) => null as SigningStatus | null);
const mockGetSignatureDigest = jest.fn(async () => new Uint8Array([1, 2, 3]));
const mockCompleteSignature = jest.fn(async (_task: unknown, _result: { isAccepted: boolean; signature: unknown }) => {});
const mockSignatureTasksEngine = {
	getTaskSigningStatus: mockGetTaskSigningStatus,
	getSignatureDigest: mockGetSignatureDigest,
	completeSignature: mockCompleteSignature,
};
const mockGetEngine = jest.fn(async (_name: string): Promise<any> => mockSignatureTasksEngine);

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

const mockCreateDeviceSigner = jest.fn();
jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: (...args: unknown[]) => mockCreateDeviceSigner(...args),
}));

let mockHandleDeviceSigningError: jest.Mock = jest.fn(() => ({ handled: false }));
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => mockHandleDeviceSigningError,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SignatureTaskScreenModule = require("../SignatureTaskScreen");
const SignatureTaskScreen = SignatureTaskScreenModule.default ?? SignatureTaskScreenModule.SignatureTaskScreen;

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

function makeBallotTask() {
	return {
		type: "signature",
		userId: "user-1",
		signatureType: "ballot",
		network: { name: "Test Network" },
		ballot: { proposed: { id: "ballot-1", description: "Ballot One", timestamp: Date.now() } },
	};
}

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
		tr = renderer.create(<SignatureTaskScreen />);
	});
	await flushTicks(4);
	return tr;
}

/**
 * `testID` is a React PROP, so `ThresholdProgressNote` carries it on its own composite instance
 * even when its render output is `null` (D-09/N1 — threshold<=1 / unreachable / no status) —
 * `findAll` on a bare `props.testID` predicate would then match the "rendered nothing" composite
 * itself. Require a HOST element (string `type`, e.g. `'Text'`), the one react-test-renderer
 * representation that only exists when something was actually rendered.
 */
function noteIsRendered(tr: renderer.ReactTestRenderer): boolean {
	return tr.root.findAll(
		(node) => node.props.testID === "signature-task-threshold-note" && typeof node.type === "string"
	).length > 0;
}

/** Function-valued props (onClick, onResponderGrant, …) differ by identity across renders even
 *  when the two trees are visually identical, so a bare `toEqual` on `toJSON()` output always
 *  fails. Compare the JSON-serialized form instead — functions are dropped by `JSON.stringify`,
 *  leaving only the structural/style/text comparison D-10/D-11 actually care about. */
function sameRender(a: renderer.ReactTestRenderer, b: renderer.ReactTestRenderer): boolean {
	return JSON.stringify(a.toJSON()) === JSON.stringify(b.toJSON());
}

beforeEach(() => {
	jest.clearAllMocks();
	mockRouteTask = makeBallotTask();
	mockGetEngine.mockImplementation(async (_name: string): Promise<any> => mockSignatureTasksEngine);
	mockGetTaskSigningStatus.mockResolvedValue(null);
	mockGetSignatureDigest.mockResolvedValue(new Uint8Array([1, 2, 3]));
	mockCompleteSignature.mockResolvedValue(undefined);
	mockCreateDeviceSigner.mockImplementation(async () => jest.fn(async () => ({ signature: "s", signerKey: "k", signerUserId: "u" })));
	mockHandleDeviceSigningError = jest.fn(() => ({ handled: false }));
});

describe("SignatureTaskScreen — threshold progress wiring (62-12, Surface 5)", () => {
	it("D1: the note loads on mount and renders FIRST, before the details component", async () => {
		mockGetTaskSigningStatus.mockResolvedValue(makeStatus({ threshold: 2, signatures: 1, reached: false }));

		const tr = await renderScreen();

		const serialized = JSON.stringify(tr.toJSON());
		const noteIndex = serialized.indexOf("signature-task-threshold-note");
		const detailsIndex = serialized.indexOf("BALLOT_DETAILS_MARKER");
		expect(noteIndex).toBeGreaterThanOrEqual(0);
		expect(detailsIndex).toBeGreaterThanOrEqual(0);
		expect(noteIndex).toBeLessThan(detailsIndex);
	});

	it("D2: D-10 — identical render and both buttons enabled, at and past threshold", async () => {
		mockGetTaskSigningStatus.mockResolvedValue(makeStatus({ threshold: 2, signatures: 2, reached: true }));
		const atThreshold = await renderScreen();

		mockGetTaskSigningStatus.mockResolvedValue(makeStatus({ threshold: 2, signatures: 3, reached: true }));
		const pastThreshold = await renderScreen();

		expect(sameRender(pastThreshold, atThreshold)).toBe(true);

		const buttons = atThreshold.root.findAll(
			(node) => typeof node.props.onPress === "function" && node.props.disabled !== undefined
		);
		for (const button of buttons) {
			expect(button.props.disabled).toBe(false);
		}
	});

	it("D3: D-11 — Reject is a plain recorded vote (no confirm, no device signer, one engine call, then goBack)", async () => {
		mockGetTaskSigningStatus.mockResolvedValue(makeStatus({ threshold: 2, signatures: 1, rejected: 0, unreachable: false }));
		const tr = await renderScreen();
		const alertSpy = jest.spyOn(Alert, "alert");

		const rejectButton = tr.root.findAll(
			(node) => typeof node.props.onPress === "function" && node.props.title === "reject"
		)[0];
		await renderer.act(async () => {
			rejectButton.props.onPress();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(mockCompleteSignature).toHaveBeenCalledTimes(1);
		expect(mockCompleteSignature).toHaveBeenCalledWith(
			mockRouteTask,
			{ isAccepted: false, signature: { signature: "", signerKey: "", signerUserId: "" } }
		);
		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
		expect(alertSpy).not.toHaveBeenCalled();
		// Only getEngine('signatureTasksEngine') is requested — never getSignatureDigest on reject.
		expect(mockGetSignatureDigest).not.toHaveBeenCalled();
		expect(mockGoBack).toHaveBeenCalledTimes(1);

		alertSpy.mockRestore();
	});

	it("D3b: a status with rejected > 0 renders identically to rejected 0", async () => {
		mockGetTaskSigningStatus.mockResolvedValue(makeStatus({ threshold: 3, signatures: 1, rejected: 0, unreachable: false }));
		const noRejects = await renderScreen();

		mockGetTaskSigningStatus.mockResolvedValue(makeStatus({ threshold: 3, signatures: 1, rejected: 1, unreachable: false }));
		const withRejects = await renderScreen();

		expect(sameRender(withRejects, noRejects)).toBe(true);
	});

	it("D4: D-11 — an unreachable status calls goBack and never calls completeSignature", async () => {
		mockGetTaskSigningStatus.mockResolvedValue(makeStatus({ unreachable: true, reached: false }));

		await renderScreen();

		expect(mockGoBack).toHaveBeenCalledTimes(1);
		expect(mockCompleteSignature).not.toHaveBeenCalled();
	});

	it("D5: Accept is unchanged — still calls getSignatureDigest, the signer, and completeSignature(isAccepted:true)", async () => {
		mockGetTaskSigningStatus.mockResolvedValue(makeStatus({ threshold: 2, signatures: 2, reached: true }));
		const tr = await renderScreen();

		const acceptButton = tr.root.findAll(
			(node) => typeof node.props.onPress === "function" && node.props.title === "sign"
		)[0];
		await renderer.act(async () => {
			acceptButton.props.onPress();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(mockGetSignatureDigest).toHaveBeenCalledTimes(1);
		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
		expect(mockCompleteSignature).toHaveBeenCalledTimes(1);
		const [, result] = mockCompleteSignature.mock.calls[0];
		expect(result.isAccepted).toBe(true);
		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});

	it("D6: fail-open + threshold 1 — a rejecting status read, a missing method, and threshold 1 all render no note, never call goBack on mount, and leave both buttons enabled", async () => {
		// (a) rejecting status read
		mockGetTaskSigningStatus.mockRejectedValue(new Error("status read failed"));
		const trA = await renderScreen();
		expect(noteIsRendered(trA)).toBe(false);
		expect(mockGoBack).not.toHaveBeenCalled();

		jest.clearAllMocks();
		mockRouteTask = makeBallotTask();
		mockGetSignatureDigest.mockResolvedValue(new Uint8Array([1, 2, 3]));
		mockCompleteSignature.mockResolvedValue(undefined);

		// (b) engine with no getTaskSigningStatus member
		mockGetEngine.mockImplementation(async (_name: string): Promise<any> => ({
			getSignatureDigest: mockGetSignatureDigest,
			completeSignature: mockCompleteSignature,
		}));
		const trB = await renderScreen();
		expect(noteIsRendered(trB)).toBe(false);
		expect(mockGoBack).not.toHaveBeenCalled();

		jest.clearAllMocks();
		mockRouteTask = makeBallotTask();
		mockGetEngine.mockImplementation(async (_name: string): Promise<any> => mockSignatureTasksEngine);
		mockGetSignatureDigest.mockResolvedValue(new Uint8Array([1, 2, 3]));
		mockCompleteSignature.mockResolvedValue(undefined);

		// (c) threshold 1
		mockGetTaskSigningStatus.mockResolvedValue(makeStatus({ threshold: 1, signatures: 1, reached: true }));
		const trC = await renderScreen();
		expect(noteIsRendered(trC)).toBe(false);
		expect(mockGoBack).not.toHaveBeenCalled();

		for (const tr of [trA, trB, trC]) {
			const buttons = tr.root.findAll(
				(node) => typeof node.props.onPress === "function" && node.props.disabled !== undefined
			);
			for (const button of buttons) {
				expect(button.props.disabled).toBe(false);
			}
		}
	});

	it("D7: unmount safety — unmounting before the status promise resolves logs no React state-update warning", async () => {
		let resolveStatus!: (status: SigningStatus | null) => void;
		mockGetTaskSigningStatus.mockImplementation(
			() => new Promise((resolve) => { resolveStatus = resolve; })
		);
		const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(<SignatureTaskScreen />);
		});

		await renderer.act(async () => {
			tr.unmount();
		});

		await renderer.act(async () => {
			resolveStatus(makeStatus({ threshold: 2, signatures: 1 }));
			await Promise.resolve();
			await Promise.resolve();
		});

		const stateUpdateWarning = consoleErrorSpy.mock.calls.some((call) =>
			typeof call[0] === "string" && call[0].includes("state update")
		);
		expect(stateUpdateWarning).toBe(false);

		consoleErrorSpy.mockRestore();
	});
});
