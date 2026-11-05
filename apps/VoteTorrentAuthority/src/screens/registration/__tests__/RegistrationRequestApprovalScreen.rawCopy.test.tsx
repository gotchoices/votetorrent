/**
 * Catalog copy only on the request-approval screen, and Approve only with a task.
 * Every engine is a jest.fn() stub: this proves the screen's copy and disable contract, not the engine.
 */
import React from "react";
import renderer from "react-test-renderer";

const LEAK = "Engine X requestId=abc";

const mockRead: any = {
	requestId: "req-1",
	authorityId: "auth-1",
	requesterKey: "requester-key-1",
	issuerType: "registrant",
	payload: {
		registrant: { id: "r-1", authorityId: "auth-1", expiration: "2099-01-01T00:00:00.000Z" },
		public: { lastName: "Doe", firstName: "Jane" },
		private: { expiration: "2099-01-01T00:00:00.000Z", details: [] },
	},
	payloadCid: "cid-1",
	status: "p",
	submittedAt: "2026-07-01T09:00:00Z",
	receivedAt: "2026-08-05T10:00:00Z",
};
const mockTask: any = {
	type: "signature",
	network: {},
	userId: "u1",
	signatureType: "registrant",
	requestId: "req-1",
	payload: mockRead.payload,
	submittedAt: mockRead.submittedAt,
	issuerType: "registrant",
};

let mockCurrent: any = mockRead;
let mockPriorError: any;
let mockTasks: any[] = [mockTask];
let mockThreshold = 1;
const mockGetRegistrationRequest = jest.fn(async (_id: string): Promise<any> => mockCurrent);
const mockCompleteSignature = jest.fn(async (_t: any, _r: any): Promise<any> => undefined);

const mockRegistrationEngine = {
	getRegistrationRequest: mockGetRegistrationRequest,
	getPriorRejections: jest.fn(async () => {
		if (mockPriorError) throw mockPriorError;
		return [];
	}),
	rejectRegistrationRequest: jest.fn(async () => undefined),
	getLikelyDuplicateRequests: jest.fn(async () => []),
	getDuplicateClosure: jest.fn(async () => undefined),
};
const mockSignatureTasksEngine = {
	getRequestedSignatures: jest.fn(async () => mockTasks),
	getSignatureDigest: jest.fn(async () => new Uint8Array([1])),
	completeSignature: mockCompleteSignature,
	getRegistrantSigningStatus: jest.fn(async () => ({ threshold: mockThreshold, signed: 0, reached: false, unreachable: false })),
};
const mockGetEngine = jest.fn(async (name: string): Promise<any> =>
	name === "registration" ? mockRegistrationEngine : name === "signatureTasksEngine" ? mockSignatureTasksEngine : null
);
const mockSigner = jest.fn(async () => ({ signature: "s", signerKey: "k", signerUserId: "u" }));

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
jest.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock("@react-navigation/native", () => ({
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		require("react").useEffect(() => cb(), [cb]);
	},
	dark: false,
	useTheme: () => ({
		dark: false,
		colors: new Proxy({}, { get: () => "c" }),
	}),
	useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() }),
	useRoute: () => ({ params: { requestId: "req-1", authorityId: "auth-1" } }),
}));
jest.mock("../../../providers/AppProvider", () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));
jest.mock("../../../engines/device-signer", () => ({ createDeviceSigner: async () => mockSigner }));
jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: () => ({ scopes: ["vrg"], loading: false, refresh: () => undefined }),
}));
jest.mock("../../../providers/SettingsProvider", () => ({ useSettings: () => ({ showHelpIcons: false }) }));

async function flush(n = 8) {
	await renderer.act(async () => {
		for (let i = 0; i < n; i++) await Promise.resolve();
	});
}
async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Screen = require("../RegistrationRequestApprovalScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<Screen />);
	});
	await flush();
	return tr;
}
function exists(tr: renderer.ReactTestRenderer, testID: string) {
	return tr.root.findAllByProps({ testID }).length > 0;
}
function pressable(tr: renderer.ReactTestRenderer, testID: string) {
	const w = tr.root.findAllByProps({ testID })[0];
	return [w, ...w.findAll(() => true)].find((n) => typeof n.props.onPress === "function");
}
function isDisabled(tr: renderer.ReactTestRenderer, testID: string) {
	const w = tr.root.findAllByProps({ testID })[0];
	return [w, ...w.findAll(() => true)].find((n) => "disabled" in n.props)?.props.disabled === true;
}
/** Presses a handler directly, bypassing `disabled`. */
async function forcePress(tr: renderer.ReactTestRenderer, testID: string) {
	await renderer.act(async () => {
		pressable(tr, testID)!.props.onPress();
	});
	await flush();
}
function treeText(tr: renderer.ReactTestRenderer) {
	return JSON.stringify(tr.toJSON());
}
function findJson(node: any, testID: string): any {
	if (node === null || node === undefined) return undefined;
	if (Array.isArray(node)) {
		for (const c of node) {
			const f = findJson(c, testID);
			if (f !== undefined) return f;
		}
		return undefined;
	}
	if (node.props?.testID === testID) return node;
	return node.children ? findJson(node.children, testID) : undefined;
}
function subtreeText(tr: renderer.ReactTestRenderer, testID: string) {
	const n = findJson(tr.toJSON(), testID);
	return n === undefined ? "" : JSON.stringify(n);
}
function errorText(tr: renderer.ReactTestRenderer) {
	return subtreeText(tr, "registration-request-approval-error");
}
function expectNoLeak(tr: renderer.ReactTestRenderer) {
	const text = treeText(tr);
	expect(text).not.toContain("requestId");
	expect(text).not.toContain("req-1)");
	expect(text).not.toContain("RegistrationRequestApprovalScreen:");
	expect(text).not.toContain("Engine X");
}

beforeEach(() => {
	jest.clearAllMocks();
	mockCurrent = mockRead;
	mockPriorError = undefined;
	mockTasks = [mockTask];
	mockThreshold = 1;
});

describe("request approval: Approve needs a task, and failures are catalog copy", () => {
	it("P-1 threshold 1 with no matching task: Approve is disabled with a hint; Reject still opens the reason card", async () => {
		mockTasks = [];
		const tr = await renderScreen();
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
		expect(exists(tr, "registration-request-no-task-hint")).toBe(true);
		expect(subtreeText(tr, "registration-request-no-task-hint")).toContain(
			"registrationRequestNoTask"
		);
		// Reject opens the card once the checklist gate is met.
		await renderer.act(async () => {
			pressable(tr, "verification-checklist-toggle-id")!.props.onPress();
		});
		await forcePress(tr, "registration-request-approval-reject");
		expect(exists(tr, "registration-request-approval-reject-card-host")).toBe(true);
	});

	it("P-1b with a task there is no hint", async () => {
		const tr = await renderScreen();
		expect(exists(tr, "registration-request-no-task-hint")).toBe(false);
	});

	it("P-2 an absent request reads as the not-found copy with no id or screen prefix", async () => {
		mockGetRegistrationRequest.mockImplementationOnce(async () => undefined);
		const tr = await renderScreen();
		expect(errorText(tr)).toContain("registrationRequestNotFound");
		expectNoLeak(tr);
	});

	it("P-3 a load failure and a prior-rejection failure use catalog copy", async () => {
		mockGetRegistrationRequest.mockImplementationOnce(async () => {
			throw new Error(LEAK);
		});
		const tr = await renderScreen();
		expect(errorText(tr)).toContain("registrationRequestLoadFailed");
		expectNoLeak(tr);

		mockPriorError = new Error(LEAK);
		const tr2 = await renderScreen();
		expect(errorText(tr2)).toContain("priorRejectionsUnavailable");
		expect(isDisabled(tr2, "registration-request-approval-approve")).toBe(true);
		expectNoLeak(tr2);
	});

	it("P-4 approve failures: engine text, unmet checklist, and no task", async () => {
		const tr = await renderScreen();
		await renderer.act(async () => {
			pressable(tr, "verification-checklist-toggle-id")!.props.onPress();
		});
		mockCompleteSignature.mockImplementationOnce(async () => {
			throw new Error(LEAK);
		});
		await forcePress(tr, "registration-request-approval-approve");
		expect(errorText(tr)).toContain("registrationRequestApproveFailed");
		expectNoLeak(tr);

		// Checklist unmet, disabled bypassed.
		const tr2 = await renderScreen();
		await forcePress(tr2, "registration-request-approval-approve");
		expect(errorText(tr2)).toContain("registrationRequestChecklistIncomplete");
		expectNoLeak(tr2);

		// No task.
		mockTasks = [];
		const tr3 = await renderScreen();
		await renderer.act(async () => {
			pressable(tr3, "verification-checklist-toggle-id")!.props.onPress();
		});
		await forcePress(tr3, "registration-request-approval-approve");
		expect(errorText(tr3)).toContain("registrationRequestNoTask");
		expectNoLeak(tr3);
	});

	it("P-5 a threshold-2 reject vote failure uses the vote-failed copy", async () => {
		mockThreshold = 2;
		const tr = await renderScreen();
		await renderer.act(async () => {
			pressable(tr, "verification-checklist-toggle-id")!.props.onPress();
		});
		mockCompleteSignature.mockImplementationOnce(async () => {
			throw new Error(LEAK);
		});
		await forcePress(tr, "registration-request-approval-reject");
		expect(errorText(tr)).toContain("registrationRequestVoteFailed");
		expectNoLeak(tr);
	});
});
