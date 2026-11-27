/**
 * Close as Rejected (stale close). Above a vrg threshold of 1, once the engine reports a pending
 * request closable (its session has been open for the stale-close timeout), a vrg officer sees
 * "Close as Rejected", including in the unreachable state; the card collects a reason, the engine's
 * closeStaleRegistrationRequest gets it, and the decision is published. Hidden before the timeout and
 * for an officer without vrg. Engine refusals map to fixed copy by code, never the engine text.
 */
import React from "react";
import renderer, { act } from "react-test-renderer";

const PENDING_READ: any = {
	requestId: "req-stale-1",
	authorityId: "auth-1",
	requesterKey: "requester-key-1",
	issuerType: "registrant",
	payload: {
		registrant: { id: "registrant-draft-1", authorityId: "auth-1", expiration: "2099-01-01T00:00:00.000Z" },
		public: { lastName: "Doe", firstName: "Jane" },
		private: { expiration: "2099-01-01T00:00:00.000Z", details: [] },
	},
	payloadCid: "cid-stale-1",
	status: "p",
	submittedAt: "2026-07-01T09:00:00Z",
	receivedAt: "2026-07-01T10:00:00Z",
};

const AVAILABLE = {
	requestId: "req-stale-1",
	threshold: 2,
	openedAt: "2026-07-01T10:00:00.000Z",
	availableAt: "2026-07-08T10:00:00.000Z",
	available: true,
};

const mockGoBack = jest.fn();
const mockClose = jest.fn(async (..._a: any[]): Promise<any> => undefined);
const mockAvailability = jest.fn(async (_id: string): Promise<any> => AVAILABLE);
const mockSigningStatus = jest.fn(async (): Promise<any> => ({ nonce: "n", scope: "vrg", threshold: 2, signatures: 0, openTasks: 2, rejected: 1, reached: false, unreachable: false }));
const mockPublish = jest.fn(async (..._a: any[]): Promise<any> => ({ outcome: "published", publishedStatus: "r" }));
const mockRegistrationEngine = {
	getRegistrationRequest: jest.fn(async (_id: string) => PENDING_READ),
	getPriorRejections: jest.fn(async () => []),
	rejectRegistrationRequest: jest.fn(async () => undefined),
	getLikelyDuplicateRequests: jest.fn(async () => []),
	getDuplicateClosure: jest.fn(async () => undefined),
	getStaleCloseAvailability: mockAvailability,
	closeStaleRegistrationRequest: mockClose,
	publishRegistrationDecision: mockPublish,
};
const mockSignatureTasksEngine = {
	getRequestedSignatures: jest.fn(async () => []),
	getSignatureDigest: jest.fn(async () => new Uint8Array([9])),
	completeSignature: jest.fn(async () => undefined),
	getRegistrantSigningStatus: mockSigningStatus,
};
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "registration") return mockRegistrationEngine;
	if (name === "signatureTasksEngine") return mockSignatureTasksEngine;
	return null;
});

let mockScopes: string[] | undefined;

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 24, left: 0, right: 0 }),
}));
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }),
}));
jest.mock("@react-navigation/native", () => ({
	dark: false,
	useTheme: () => ({
		dark: false,
		colors: new Proxy({}, { get: (_t, k) => `sentinel-${String(k)}` }),
	}),
	useNavigation: () => ({ navigate: jest.fn(), push: jest.fn(), goBack: mockGoBack, setOptions: jest.fn() }),
	useRoute: () => ({ params: { requestId: "req-stale-1", authorityId: "auth-1" } }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		require("react").useEffect(() => cb(), [cb]);
	},
}));
jest.mock("../../../providers/AppProvider", () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));
jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => async () => new Uint8Array([1])),
}));
jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: () => ({ scopes: mockScopes, loading: false, refresh: () => undefined }),
}));
jest.mock("../../../providers/SettingsProvider", () => ({ useSettings: () => ({ showHelpIcons: false }) }));

beforeEach(() => {
	jest.clearAllMocks();
	mockScopes = ["vrg"];
	mockAvailability.mockImplementation(async () => AVAILABLE);
	mockClose.mockImplementation(async () => undefined);
	jest.spyOn(console, "error").mockImplementation(() => undefined);
	jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

async function renderScreen() {
	const Screen = require("../RegistrationRequestApprovalScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<Screen />);
	});
	await flush();
	return tr;
}
async function flush() {
	await act(async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	});
}
function pressable(tr: renderer.ReactTestRenderer, id: string) {
	const w = tr.root.findByProps({ testID: id });
	return [w, ...w.findAll(() => true)].find((x) => typeof x.props.onPress === "function")!;
}
function exists(tr: renderer.ReactTestRenderer, id: string) {
	return tr.root.findAllByProps({ testID: id }).length > 0;
}
function textWithin(tr: renderer.ReactTestRenderer, id: string): string {
	const find = (n: any): any => {
		if (!n || typeof n !== "object") return null;
		if (Array.isArray(n)) {
			for (const c of n) {
				const r = find(c);
				if (r) return r;
			}
			return null;
		}
		if (n.props?.testID === id) return n;
		for (const c of n.children ?? []) {
			const r = find(c);
			if (r) return r;
		}
		return null;
	};
	const hit = find(tr.toJSON());
	return hit ? JSON.stringify(hit) : "";
}
async function openAndConfirm(tr: renderer.ReactTestRenderer, reason: string) {
	act(() => pressable(tr, "registration-request-approval-stale-close").props.onPress());
	act(() => tr.root.findByProps({ testID: "stale-close-reason-input" }).props.onChangeText(reason));
	await act(async () => {
		try {
			await pressable(tr, "stale-close-confirm").props.onPress();
		} catch {
			/* the screen rethrows for the card latch */
		}
	});
	await flush();
}

describe("RegistrationRequestApprovalScreen Close as Rejected", () => {
	it("S1: offered with the 7-day note once the engine reports the request closable", async () => {
		const tr = await renderScreen();
		expect(mockAvailability).toHaveBeenCalledWith("req-stale-1");
		expect(exists(tr, "registration-request-approval-stale-close")).toBe(true);
		expect(textWithin(tr, "registration-request-approval-stale-close-note")).toContain('registrationRequestStaleCloseNote:{\\"days\\":7}');
	});

	it("S2: hidden before the timeout", async () => {
		mockAvailability.mockImplementation(async () => ({ ...AVAILABLE, available: false }));
		const tr = await renderScreen();
		expect(exists(tr, "registration-request-approval-stale-close")).toBe(false);
	});

	it("S3: hidden for an officer without vrg", async () => {
		mockScopes = ["mel"];
		const tr = await renderScreen();
		expect(exists(tr, "registration-request-approval-stale-close")).toBe(false);
	});

	it("S4: offered in the unreachable state too", async () => {
		mockSigningStatus.mockImplementationOnce(async () => ({ nonce: "n", scope: "vrg", threshold: 2, signatures: 0, openTasks: 0, rejected: 3, reached: false, unreachable: true }));
		const tr = await renderScreen();
		expect(exists(tr, "registration-request-approval-unreachable-block")).toBe(true);
		expect(exists(tr, "registration-request-approval-stale-close")).toBe(true);
	});

	it("S5: the card sends the trimmed reason to closeStaleRegistrationRequest, publishes, and leaves", async () => {
		const tr = await renderScreen();
		await openAndConfirm(tr, "  No co-signer answered  ");
		expect(mockClose).toHaveBeenCalledTimes(1);
		expect(mockClose.mock.calls[0]![0]).toBe("req-stale-1");
		expect(mockClose.mock.calls[0]![1]).toEqual({ rejectionReason: "No co-signer answered" });
		expect(mockRegistrationEngine.rejectRegistrationRequest).not.toHaveBeenCalled();
		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});

	it("S6: the card uses the close copy, not the reject copy", async () => {
		const tr = await renderScreen();
		act(() => pressable(tr, "registration-request-approval-stale-close").props.onPress());
		expect(textWithin(tr, "stale-close-card")).toContain("registrationRequestStaleCloseTitle");
		expect(textWithin(tr, "stale-close-card")).not.toContain("registrationRequestRejectTitle");
		expect(exists(tr, "registration-request-approval-footer")).toBe(false);
	});

	it("S7: an engine refusal shows fixed copy in the card, never the engine text", async () => {
		mockClose.mockRejectedValueOnce(
			Object.assign(new Error("engine-secret req-stale-1"), { name: "RegistrationStaleCloseError", code: "too-early", availableAt: AVAILABLE.availableAt })
		);
		const tr = await renderScreen();
		await openAndConfirm(tr, "reason");
		const text = textWithin(tr, "stale-close-card");
		expect(text).toContain("registrationRequestStaleCloseNotYet");
		expect(text).not.toContain("engine-secret");
		expect(mockGoBack).not.toHaveBeenCalled();
	});
});
