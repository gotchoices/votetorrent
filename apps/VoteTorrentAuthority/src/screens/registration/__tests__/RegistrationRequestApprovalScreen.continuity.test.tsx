/**
 * RegistrationRequestApprovalScreen.continuity.test.tsx — 62-27 (D-44, D-11, D-49).
 *
 * The duplicate callout and closed state, decide-time publishing, the vrg threshold
 * Reject-as-vote path with its progress note and unreachable outcome, and the D-49 unreadable
 * content states. Every engine is a call-recording jest.fn: this proves the screen's CALL
 * CONTRACT and what it renders, never an access-control boundary (the schema CHECKs and the
 * real-engine specs own that). `continuity-review` is deliberately NOT mocked.
 */

import React from "react";
import { StyleSheet } from "react-native";
import renderer from "react-test-renderer";

const RECEIVED_AT = "2026-08-05T10:00:00Z";
const SUBMITTED_AT = "2026-07-01T09:00:00Z";
const FUTURE_EXPIRATION = "2099-01-01T00:00:00.000Z";

const BASE_PAYLOAD = {
	registrant: { id: "registrant-draft-1", authorityId: "auth-1", expiration: FUTURE_EXPIRATION },
	public: { lastName: "Doe", firstName: "Jane", district: "D3" },
	private: { expiration: FUTURE_EXPIRATION, details: [] },
};

const PENDING_READ: any = {
	requestId: "req-1",
	authorityId: "auth-1",
	requesterKey: "requester-key-1",
	issuerType: "registrant",
	payload: BASE_PAYLOAD,
	payloadCid: "cid-1",
	status: "p",
	submittedAt: SUBMITTED_AT,
	receivedAt: RECEIVED_AT,
};

const LONG_FIRST = "Maximiliana Esperanza";
const LONG_LAST = "Villalobos-Etxeberria de la Cruz";
const CANDIDATE: any = {
	requestId: "req-B",
	authorityId: "auth-1",
	issuerType: "registrant",
	submittedAt: SUBMITTED_AT,
	receivedAt: RECEIVED_AT,
	firstName: LONG_FIRST,
	lastName: LONG_LAST,
	matchedOn: [],
};

function taskFor(read: any): any {
	return {
		type: "signature",
		network: {},
		userId: "device-user-1",
		signatureType: "registrant",
		requestId: read.requestId,
		payload: read.payload,
		submittedAt: read.submittedAt,
		issuerType: read.issuerType,
	};
}

function status(overrides: Record<string, unknown> = {}): any {
	return {
		nonce: "n1",
		scope: "vrg",
		threshold: 2,
		signatures: 0,
		openTasks: 3,
		rejected: 0,
		reached: false,
		unreachable: false,
		...overrides,
	};
}

let mockLocale: "en" | "es" = "en";
let mockCurrentRead: any = PENDING_READ;
let mockTasks: any[] = [taskFor(PENDING_READ)];
let mockScopes: string[] | undefined = ["vrg"];
let mockHasFactory = true;
let mockLikely: any[] = [];
let mockLikelyError: Error | undefined;
let mockClosureQueue: any[] = [];
let mockSigningStatus: any = null;

const mockGetRegistrationRequest = jest.fn(async (_id: string) => mockCurrentRead);
const mockGetPriorRejections = jest.fn(async (_k: string, _e?: string) => [] as any[]);
const mockRejectRegistrationRequest = jest.fn(async (_id: string, _d: any, _s: any): Promise<any> => undefined);
const mockGetLikelyDuplicateRequests = jest.fn(async (_id: string) => {
	if (mockLikelyError) throw mockLikelyError;
	return mockLikely;
});
const mockGetDuplicateClosure = jest.fn(async (_id: string) => {
	if (mockClosureQueue.length > 1) return mockClosureQueue.shift();
	return mockClosureQueue[0];
});
const mockPublishRegistrationDecision = jest.fn(async (_p: any, _id: string, _o?: any): Promise<any> => ({ status: "published" }));

const mockRegistrationEngine = {
	getRegistrationRequest: mockGetRegistrationRequest,
	getPriorRejections: mockGetPriorRejections,
	rejectRegistrationRequest: mockRejectRegistrationRequest,
	getLikelyDuplicateRequests: mockGetLikelyDuplicateRequests,
	getDuplicateClosure: mockGetDuplicateClosure,
	publishRegistrationDecision: mockPublishRegistrationDecision,
};

const mockGetRequestedSignatures = jest.fn(async (_p: boolean) => mockTasks);
const mockGetSignatureDigest = jest.fn(async (_t: any) => new Uint8Array([9, 9, 9]));
const mockCompleteSignature = jest.fn(async (_t: any, _r: any): Promise<any> => undefined);
const mockGetRegistrantSigningStatus = jest.fn(async (_id: string) => mockSigningStatus);

const mockSignatureTasksEngine = {
	getRequestedSignatures: mockGetRequestedSignatures,
	getSignatureDigest: mockGetSignatureDigest,
	completeSignature: mockCompleteSignature,
	getRegistrantSigningStatus: mockGetRegistrantSigningStatus,
};

const mockCreateOpener = jest.fn(() => ({ __opener: true }));
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "registration") return mockRegistrationEngine;
	if (name === "signatureTasksEngine") return mockSignatureTasksEngine;
	if (name === "intake") return { createOpener: mockCreateOpener };
	return null;
});

const mockTransports = {
	strandId: "strand-1",
	registration: { publishDecision: jest.fn(async () => "cid"), close: jest.fn(async () => undefined) },
	association: { close: jest.fn(async () => undefined) },
};
const mockCreateTransports = jest.fn((_d: any) => mockTransports);

const mockSignerFn = jest.fn(async (_d: Uint8Array) => ({ signature: "device-signature", signerKey: "device-key", signerUserId: "device-user-1" }));
const mockCreateDeviceSigner = jest.fn(async (_n: string) => mockSignerFn);

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockPush = jest.fn();
const mockSetOptions = jest.fn();

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources } = require("../../../i18n");
			const template = (resources[mockLocale].translation as Record<string, string>)[key];
			if (typeof template !== "string") return key;
			if (!opts) return template;
			return template.replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) => String(opts[name] ?? ""));
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));
jest.mock("@react-navigation/native", () => ({
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		require("react").useEffect(() => cb(), [cb]);
	},
	dark: false,
	useTheme: () => ({
		dark: false,
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
	useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack, setOptions: mockSetOptions, push: mockPush }),
	useRoute: () => ({ params: { requestId: "req-1", authorityId: "auth-1" } }),
}));
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({
		getEngine: mockGetEngine,
		createPeerStagingTransports: mockHasFactory ? mockCreateTransports : undefined,
	}),
}));
jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: (n: string) => mockCreateDeviceSigner(n),
}));
jest.mock("../../../engines/key-vault", () => ({
	resolveAuthorityKeyVault: jest.fn(() => ({ __vault: true })),
}));
jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: (_a: string) => ({ scopes: mockScopes, loading: false, refresh: () => undefined }),
}));
jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resources } = require("../../../i18n");
const dict = (locale: "en" | "es") => resources[locale].translation as Record<string, string>;

async function flushTicks(count: number): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < count; i++) await Promise.resolve();
	});
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Screen = require("../RegistrationRequestApprovalScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<Screen />);
	});
	await flushTicks(12);
	return tr;
}

function collectTestIDs(node: any, acc: string[]): void {
	if (node === null || node === undefined) return;
	if (Array.isArray(node)) {
		for (const c of node) collectTestIDs(c, acc);
		return;
	}
	if (node.props && typeof node.props.testID === "string") acc.push(node.props.testID);
	if (node.children) for (const c of node.children) collectTestIDs(c, acc);
}
function orderedTestIDs(tr: renderer.ReactTestRenderer): string[] {
	const acc: string[] = [];
	collectTestIDs(tr.toJSON(), acc);
	return acc;
}
function findPressable(tr: renderer.ReactTestRenderer, testID: string) {
	const wrapper = tr.root.findByProps({ testID });
	return [wrapper, ...wrapper.findAll(() => true)].find((n) => typeof n.props.onPress === "function" || typeof n.props.onPressIn === "function");
}
function press(tr: renderer.ReactTestRenderer, testID: string) {
	const p = findPressable(tr, testID)!;
	renderer.act(() => {
		(p.props.onPress ?? p.props.onPressIn)();
	});
}
async function pressAsync(tr: renderer.ReactTestRenderer, testID: string) {
	const p = findPressable(tr, testID)!;
	await renderer.act(async () => {
		(p.props.onPress ?? p.props.onPressIn)();
	});
	await flushTicks(12);
}
function isDisabled(tr: renderer.ReactTestRenderer, testID: string): boolean {
	const wrapper = tr.root.findByProps({ testID });
	const node = [wrapper, ...wrapper.findAll(() => true)].find((n) => "disabled" in n.props);
	return node?.props.disabled === true;
}
function exists(tr: renderer.ReactTestRenderer, testID: string): boolean {
	try {
		tr.root.findByProps({ testID });
		return true;
	} catch {
		return false;
	}
}
function textOfNode(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textOfNode(c as renderer.ReactTestInstance))).join("");
}
function textOf(tr: renderer.ReactTestRenderer, testID: string): string {
	return textOfNode(tr.root.findByProps({ testID }));
}
function whole(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}
function flat(node: renderer.ReactTestInstance): Record<string, any> {
	return (StyleSheet.flatten(node.props.style) ?? {}) as Record<string, any>;
}
function clippingAncestors(node: renderer.ReactTestInstance, stopAt: renderer.ReactTestInstance): string[] {
	const problems: string[] = [];
	let cur: renderer.ReactTestInstance | null = node.parent;
	while (cur) {
		const st = flat(cur);
		for (const k of ["height", "maxHeight"]) if (st[k] !== undefined) problems.push(`${k}=${String(st[k])}`);
		if (st.overflow === "hidden") problems.push("overflow:hidden");
		if (cur === stopAt) break;
		cur = cur.parent;
	}
	return problems;
}
function engineCalls(): number {
	return (
		mockRejectRegistrationRequest.mock.calls.length +
		mockGetSignatureDigest.mock.calls.length +
		mockCompleteSignature.mock.calls.length +
		mockPublishRegistrationDecision.mock.calls.length
	);
}

/** Makes the engine fakes behave like a real decision: the read flips to the decided status. */
function decideOnAccept(finalStatus: "a" | "r") {
	mockCompleteSignature.mockImplementation(async (_t: any, r: any) => {
		if (r.isAccepted) mockCurrentRead = { ...mockCurrentRead, status: finalStatus };
	});
}
function decideOnReject() {
	mockRejectRegistrationRequest.mockImplementation(async () => {
		mockCurrentRead = { ...mockCurrentRead, status: "r" };
	});
}
async function rejectWithReason(tr: renderer.ReactTestRenderer, reason = "no proof of residence") {
	// D-07: Reject is disabled until the checklist gate is met; tick only when it is not already.
	if (isDisabled(tr, "registration-request-approval-reject")) press(tr, "verification-checklist-toggle-id");
	press(tr, "registration-request-approval-reject");
	const input = tr.root.findByProps({ testID: "reject-reason-reason-input" });
	renderer.act(() => {
		input.props.onChangeText(reason);
	});
	await pressAsync(tr, "reject-reason-confirm");
}

let consoleSpies: jest.SpyInstance[] = [];
beforeAll(() => {
	consoleSpies = (["log", "warn", "error", "debug", "info"] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
});
afterAll(() => consoleSpies.forEach((s) => s.mockRestore()));
beforeEach(() => {
	jest.clearAllMocks();
	consoleSpies.forEach((s) => s.mockClear());
	mockLocale = "en";
	mockCurrentRead = PENDING_READ;
	mockTasks = [taskFor(PENDING_READ)];
	mockScopes = ["vrg"];
	mockHasFactory = true;
	mockLikely = [];
	mockLikelyError = undefined;
	mockClosureQueue = [undefined];
	mockSigningStatus = null;
	mockCompleteSignature.mockImplementation(async () => undefined);
	mockRejectRegistrationRequest.mockImplementation(async () => undefined);
	mockPublishRegistrationDecision.mockImplementation(async () => ({ status: "published" }));
});
afterEach(() => {
	consoleSpies.forEach((s) => expect(s).not.toHaveBeenCalled());
});

describe("RegistrationRequestApprovalScreen continuity — D-44 duplicate callout, closed state, publishing", () => {
	it("A1. anchor order: bridge < prior rejections < possible duplicate < threshold note < summary", async () => {
		const bridge = { ...PENDING_READ, issuerType: "bridge", bridgeId: "bridge-1", bridgeLabel: "Statewide Bridge" };
		mockCurrentRead = bridge;
		mockTasks = [taskFor(bridge)];
		mockGetPriorRejections.mockResolvedValueOnce([
			{ requestId: "req-old", rejectedAt: "2026-01-01T00:00:00Z", rejectionReason: "no id", decidingOfficerUserId: "officer-9" },
		]);
		mockLikely = [CANDIDATE];
		mockSigningStatus = status({ signatures: 1 });
		const tr = await renderScreen();
		const ids = orderedTestIDs(tr);
		const idx = (id: string) => ids.indexOf(id);
		expect(idx("bridge-source-callout")).toBeGreaterThanOrEqual(0);
		expect(idx("prior-rejections-callout")).toBeGreaterThan(idx("bridge-source-callout"));
		expect(idx("possible-duplicate-callout")).toBeGreaterThan(idx("prior-rejections-callout"));
		expect(idx("registration-request-approval-threshold-note")).toBeGreaterThan(idx("possible-duplicate-callout"));
		expect(idx("registration-request-approval-summary")).toBeGreaterThan(idx("registration-request-approval-threshold-note"));
	});

	it("A2. a threshold-1 reject publishes once with the callout candidate (or null) and then goes back", async () => {
		mockLikely = [CANDIDATE];
		decideOnReject();
		const tr = await renderScreen();
		await rejectWithReason(tr);
		expect(mockRejectRegistrationRequest).toHaveBeenCalledTimes(1);
		expect(mockPublishRegistrationDecision).toHaveBeenCalledTimes(1);
		const [publisher, id, opts] = mockPublishRegistrationDecision.mock.calls[0];
		expect(publisher.authorityId).toBe("auth-1");
		expect(id).toBe("req-1");
		expect(opts).toEqual({ closesRequestId: "req-B" });
		expect(mockPublishRegistrationDecision.mock.invocationCallOrder[0]).toBeLessThan(mockGoBack.mock.invocationCallOrder[0]);

		jest.clearAllMocks();
		mockCurrentRead = PENDING_READ;
		mockLikely = [];
		mockClosureQueue = [undefined];
		const tr2 = await renderScreen();
		await rejectWithReason(tr2);
		expect(mockPublishRegistrationDecision.mock.calls[0][2]).toEqual({ closesRequestId: null });
	});

	it("A3. an approval publishes with the candidate id, then goes back", async () => {
		mockLikely = [CANDIDATE];
		decideOnAccept("a");
		const tr = await renderScreen();
		press(tr, "verification-checklist-toggle-id");
		await pressAsync(tr, "registration-request-approval-approve");
		expect(mockCompleteSignature).toHaveBeenCalledTimes(1);
		expect(mockPublishRegistrationDecision).toHaveBeenCalledTimes(1);
		expect(mockPublishRegistrationDecision.mock.calls[0][2]).toEqual({ closesRequestId: "req-B" });
		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});

	it("A4. a publish failure, or a missing transport factory, still reaches goBack with no error shown", async () => {
		mockLikely = [CANDIDATE];
		decideOnAccept("a");
		mockPublishRegistrationDecision.mockRejectedValue(Object.assign(new Error("PUBLISH-SECRET"), { code: "cursor-exhausted" }));
		const tr = await renderScreen();
		press(tr, "verification-checklist-toggle-id");
		await pressAsync(tr, "registration-request-approval-approve");
		expect(mockGoBack).toHaveBeenCalledTimes(1);
		expect(exists(tr, "registration-request-approval-error")).toBe(false);
		expect(whole(tr)).not.toContain("PUBLISH-SECRET");

		jest.clearAllMocks();
		mockCurrentRead = PENDING_READ;
		mockHasFactory = false;
		decideOnAccept("a");
		const tr2 = await renderScreen();
		press(tr2, "verification-checklist-toggle-id");
		await pressAsync(tr2, "registration-request-approval-approve");
		expect(mockGoBack).toHaveBeenCalledTimes(1);
		expect(mockPublishRegistrationDecision).not.toHaveBeenCalled();
		expect(exists(tr2, "registration-request-approval-error")).toBe(false);
	});

	it("A5. a duplicate-read failure shows the check-failed copy, blocks Approve, keeps Reject, and publishes null", async () => {
		mockLikelyError = new Error("ENGINE-DUP-MSG");
		decideOnReject();
		const tr = await renderScreen();
		expect(textOf(tr, "registration-request-approval-error")).toBe(dict("en").possibleDuplicateCheckFailed);
		expect(whole(tr)).not.toContain("ENGINE-DUP-MSG");
		press(tr, "verification-checklist-toggle-id");
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-reject")).toBe(false);
		await rejectWithReason(tr);
		expect(mockPublishRegistrationDecision).toHaveBeenCalledTimes(1);
		expect(mockPublishRegistrationDecision.mock.calls[0][2]).toEqual({ closesRequestId: null });
	});

	it("A6. a closed request shows the closed block, a View Other button, and present-but-disabled controls", async () => {
		mockClosureQueue = [{ requestId: "req-1", state: "closed", closedByRequestId: "req-B" }];
		mockLikely = [CANDIDATE];
		const tr = await renderScreen();
		expect(textOf(tr, "registration-request-approval-duplicate-closed-block")).toContain(dict("en").possibleDuplicateClosedLabel);
		const block = tr.root.findByProps({ testID: "registration-request-approval-duplicate-closed-block" });
		const viewOther = block.findByProps({ accessibilityRole: "button" });
		renderer.act(() => {
			viewOther.props.onPressIn();
		});
		expect(mockPush).toHaveBeenCalledWith("RegistrationRequestApproval", { requestId: "req-B", authorityId: "auth-1" });
		expect(exists(tr, "registration-request-approval-approve")).toBe(true);
		expect(exists(tr, "registration-request-approval-reject")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-reject")).toBe(true);
		expect(exists(tr, "possible-duplicate-callout")).toBe(false);
		expect(mockGetLikelyDuplicateRequests).not.toHaveBeenCalled();
	});

	it("A7. a closing request renders identically", async () => {
		mockClosureQueue = [{ requestId: "req-1", state: "closing", closedByRequestId: "req-B" }];
		const tr = await renderScreen();
		expect(exists(tr, "registration-request-approval-duplicate-closed-block")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-reject")).toBe(true);
	});

	it("A8. a closed-as-duplicate race reloads into the closed state and never shows the engine message", async () => {
		mockClosureQueue = [undefined, { requestId: "req-1", state: "closed", closedByRequestId: "req-B" }];
		mockCompleteSignature.mockRejectedValue({ name: "RegistrationDuplicateError", code: "closed-as-duplicate", message: "ENGINE-MSG" });
		const tr = await renderScreen();
		press(tr, "verification-checklist-toggle-id");
		await pressAsync(tr, "registration-request-approval-approve");
		expect(whole(tr)).not.toContain("ENGINE-MSG");
		expect(mockGetDuplicateClosure).toHaveBeenCalledTimes(2);
		expect(exists(tr, "registration-request-approval-duplicate-closed-block")).toBe(true);
		expect(mockGoBack).not.toHaveBeenCalled();
	});
});

describe("RegistrationRequestApprovalScreen continuity — D-11 vrg threshold", () => {
	it("A9. a threshold-2 status renders the progress text from the resources", async () => {
		mockSigningStatus = status({ signatures: 1 });
		const tr = await renderScreen();
		const expected = dict("en").signatureTaskThresholdProgress.replace("{{signed}}", "1").replace("{{threshold}}", "2");
		expect(expected).toContain("1 of 2");
		expect(textOf(tr, "threshold-progress-note")).toBe(expected);
	});

	it("A10. Reject at threshold 2 records a vote through the own task and never calls the veto path", async () => {
		mockSigningStatus = status();
		const tr = await renderScreen();
		const before = mockGetRegistrantSigningStatus.mock.calls.length;
		await pressAsync(tr, "registration-request-approval-reject");
		expect(exists(tr, "reject-reason-card")).toBe(false);
		expect(mockCompleteSignature).toHaveBeenCalledTimes(1);
		const [task, result] = mockCompleteSignature.mock.calls[0];
		expect(task.requestId).toBe("req-1");
		expect(result).toEqual({ isAccepted: false, signature: { signature: "", signerKey: "", signerUserId: "" } });
		expect(mockRejectRegistrationRequest).not.toHaveBeenCalled();
		expect(mockGetSignatureDigest).not.toHaveBeenCalled();
		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
		expect(mockPublishRegistrationDecision).not.toHaveBeenCalled();
		expect(mockGoBack).not.toHaveBeenCalled();
		expect(mockGetRegistrantSigningStatus.mock.calls.length).toBeGreaterThan(before);
	});

	it("A11. a threshold-2 status with no own task keeps both buttons present and disabled and shows the vote-recorded line", async () => {
		mockSigningStatus = status({ signatures: 0, rejected: 1 });
		mockTasks = [];
		const tr = await renderScreen();
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-reject")).toBe(true);
		expect(exists(tr, "threshold-progress-note")).toBe(true);
		expect(textOf(tr, "registration-request-approval-vote-recorded")).toBe(dict("en").signatureTaskThresholdVoteRecorded);
	});

	it("A12. an unreachable session shows the Rejected pill and the unreachable line, with no footer, card or note", async () => {
		mockSigningStatus = status({ signatures: 0, rejected: 2, openTasks: 1, unreachable: true });
		const tr = await renderScreen();
		const block = "registration-request-approval-unreachable-block";
		expect(textOf(tr, block)).toContain(dict("en").registrationRequestStatusRejected);
		expect(textOf(tr, "registration-request-approval-unreachable-text")).toBe(dict("en").signatureTaskThresholdUnreachable);
		const pill = tr.root.findByProps({ testID: "registration-request-approval-unreachable-pill" });
		expect(flat(pill).backgroundColor).toBe("sentinel-error22");
		expect(exists(tr, "registration-request-approval-footer")).toBe(false);
		expect(exists(tr, "registration-request-approval-approve")).toBe(false);
		expect(exists(tr, "reject-reason-card")).toBe(false);
		expect(exists(tr, "registration-request-approval-threshold-note")).toBe(false);
	});

	it("A13. a threshold-1 status leaves Reject revealing the reason card", async () => {
		mockSigningStatus = status({ threshold: 1 });
		const tr = await renderScreen();
		press(tr, "registration-request-approval-reject");
		expect(exists(tr, "reject-reason-card")).toBe(true);
		expect(mockCompleteSignature).not.toHaveBeenCalled();
	});

	it("A14. at threshold 2 an accept that leaves the request pending reloads without publishing or leaving", async () => {
		mockSigningStatus = status({ signatures: 0 });
		const tr = await renderScreen();
		press(tr, "verification-checklist-toggle-id");
		const reads = mockGetRegistrationRequest.mock.calls.length;
		await pressAsync(tr, "registration-request-approval-approve");
		expect(mockCompleteSignature).toHaveBeenCalledTimes(1);
		expect(mockPublishRegistrationDecision).not.toHaveBeenCalled();
		expect(mockGoBack).not.toHaveBeenCalled();
		// the publish step's re-read, plus the reload
		expect(mockGetRegistrationRequest.mock.calls.length).toBeGreaterThanOrEqual(reads + 2);
	});

	it("A15. geometry: nothing around the long-name callout clips; footer slots stretch and do not change with the note", async () => {
		mockLikely = [CANDIDATE];
		mockSigningStatus = status({ signatures: 1 });
		const withNote = await renderScreen();
		const screen = withNote.root.findByProps({ testID: "registration-request-approval-screen" });
		const body = withNote.root.findByProps({ testID: "possible-duplicate-callout-body" });
		expect(textOfNode(body)).toContain(LONG_FIRST);
		expect(clippingAncestors(body, screen)).toEqual([]);
		for (const slot of ["registration-request-approval-approve", "registration-request-approval-reject"]) {
			const st = flat(withNote.root.findByProps({ testID: slot }));
			expect(st.alignSelf).toBe("stretch");
			expect(st.flex).toBeUndefined();
		}
		const footerStyle = (tr: renderer.ReactTestRenderer) => flat(tr.root.findByProps({ testID: "registration-request-approval-footer" }).children[0] as renderer.ReactTestInstance);
		const styleWith = footerStyle(withNote);

		jest.clearAllMocks();
		mockLikely = [];
		mockSigningStatus = null;
		mockClosureQueue = [undefined];
		const without = await renderScreen();
		expect(footerStyle(without)).toEqual(styleWith);

		jest.clearAllMocks();
		mockSigningStatus = status({ signatures: 0, rejected: 2, openTasks: 1, unreachable: true });
		const unreachable = await renderScreen();
		mockSigningStatus = status();
		mockTasks = [];
		const voted = await renderScreen();
		for (const [tr, id] of [
			[unreachable, "registration-request-approval-unreachable-text"],
			[voted, "registration-request-approval-vote-recorded"],
		] as const) {
			const n = tr.root.findByProps({ testID: id });
			expect(n.props.numberOfLines).toBeUndefined();
		}
	});

	it("A16. the candidate name appears only inside the callout body", async () => {
		mockLikely = [CANDIDATE];
		const tr = await renderScreen();
		const holders = tr.root
			.findAll((n) => typeof n.type === "string" && n.children.some((c) => typeof c === "string" && c.includes(LONG_FIRST)))
			.map((n) => n.props.testID);
		expect(holders).toEqual(["possible-duplicate-callout-body"]);
	});
});

describe("RegistrationRequestApprovalScreen continuity — D-49 unreadable content", () => {
	const UNREAD = (access: string) => ({ ...PENDING_READ, payload: {}, payloadAccess: access });
	const ACCESS_CODES = ["not-a-recipient", "no-opener", "unreadable", "tampered"];

	it("A17. an undefined, 'opened' or 'unsealed' payloadAccess renders the summary and no unreadable block", async () => {
		for (const access of [undefined, "opened", "unsealed"]) {
			jest.clearAllMocks();
			mockCurrentRead = { ...PENDING_READ, payloadAccess: access };
			const tr = await renderScreen();
			expect(exists(tr, "registration-request-approval-summary")).toBe(true);
			expect(exists(tr, "registration-request-approval-content-unreadable")).toBe(false);
		}
	});

	it("A18. not-a-recipient shows its copy in place of the form, with Approve and Reject present and disabled", async () => {
		mockCurrentRead = UNREAD("not-a-recipient");
		const tr = await renderScreen();
		expect(textOf(tr, "registration-request-approval-content-unreadable")).toBe(dict("en").registrationContentNotRecipient);
		expect(exists(tr, "registration-request-approval-summary")).toBe(false);
		expect(exists(tr, "verification-checklist")).toBe(false);
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-reject")).toBe(true);
		const before = engineCalls();
		await pressAsync(tr, "registration-request-approval-approve");
		expect(engineCalls()).toBe(before);

		jest.clearAllMocks();
		mockLocale = "es";
		const es = await renderScreen();
		expect(textOf(es, "registration-request-approval-content-unreadable")).toBe(dict("es").registrationContentNotRecipient);
	});

	it("A19. no-opener and unreadable each show their own copy and a fully disabled footer", async () => {
		for (const [access, key] of [
			["no-opener", "registrationContentNoKey"],
			["unreadable", "registrationContentUnreadable"],
		] as const) {
			for (const locale of ["en", "es"] as const) {
				jest.clearAllMocks();
				mockLocale = locale;
				mockCurrentRead = UNREAD(access);
				const tr = await renderScreen();
				const shown = textOf(tr, "registration-request-approval-content-unreadable");
				expect(shown).toBe(dict(locale)[key]);
				for (const other of ["registrationContentNoKey", "registrationContentTampered", "registrationContentUnreadable", "registrationContentNotRecipient"]) {
					if (other !== key) expect(shown).not.toBe(dict(locale)[other]);
				}
				expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
				expect(isDisabled(tr, "registration-request-approval-reject")).toBe(true);
			}
		}
	});

	it("A20. tampered: Approve stays disabled even with the gate met, Reject is enabled and reveals the reason card", async () => {
		mockCurrentRead = { ...UNREAD("tampered"), verificationChecklist: ["id"] };
		const tr = await renderScreen();
		expect(textOf(tr, "registration-request-approval-content-unreadable")).toBe(dict("en").registrationContentTampered);
		expect(exists(tr, "registration-request-approval-approve")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-reject")).toBe(false);
		press(tr, "registration-request-approval-reject");
		expect(exists(tr, "reject-reason-card")).toBe(true);
	});

	it("A20b. (62-52) tampered renders the checklist below the unreadable notice; a fresh tampered read can be ticked to enable Reject, and other unread states render none", async () => {
		mockCurrentRead = { ...UNREAD("tampered"), verificationChecklist: [] };
		const tr = await renderScreen();
		expect(exists(tr, "verification-checklist")).toBe(true);
		const ids = orderedTestIDs(tr);
		expect(ids.indexOf("verification-checklist")).toBeGreaterThan(ids.indexOf("registration-request-approval-content-unreadable"));
		expect(isDisabled(tr, "registration-request-approval-reject")).toBe(true);
		press(tr, "verification-checklist-toggle-id");
		expect(isDisabled(tr, "registration-request-approval-reject")).toBe(false);
		for (const access of ["not-a-recipient", "no-opener", "unreadable"]) {
			mockCurrentRead = UNREAD(access);
			const other = await renderScreen();
			expect(exists(other, "verification-checklist")).toBe(false);
			expect(isDisabled(other, "registration-request-approval-reject")).toBe(true);
		}
	});

	it("A21. the approval gate's refusal renders its mapped copy, never its message, and reloads", async () => {
		for (const [access, key] of [
			["tampered", "registrationContentTampered"],
			["not-a-recipient", "registrationContentNotRecipient"],
			["unreadable", "registrationContentUnreadable"],
		] as const) {
			jest.clearAllMocks();
			mockCurrentRead = { ...PENDING_READ, payloadAccess: "opened" };
			mockCompleteSignature.mockRejectedValue({
				name: "RegistrationContentAccessError",
				code: "registration-content-unreadable",
				access,
				requestId: "req-1",
				message: `ENGINE-MSG req-1 ${access}`,
			});
			const tr = await renderScreen();
			press(tr, "verification-checklist-toggle-id");
			const reads = mockGetRegistrationRequest.mock.calls.length;
			await pressAsync(tr, "registration-request-approval-approve");
			expect(textOf(tr, "registration-request-approval-error")).toBe(dict("en")[key]);
			expect(whole(tr)).not.toContain("ENGINE-MSG");
			expect(mockPublishRegistrationDecision).not.toHaveBeenCalled();
			expect(mockGoBack).not.toHaveBeenCalled();
			expect(mockGetRegistrationRequest.mock.calls.length).toBeGreaterThan(reads);
		}
	});

	it("A21b. the gate state survives a reload into an unread state, and Approve stays disabled (the screen's own gate, not the hidden checklist's)", async () => {
		mockCurrentRead = { ...PENDING_READ, payloadAccess: "opened" };
		mockCompleteSignature.mockImplementation(async () => {
			// The approval gate refuses, and by the time the screen reloads the row reads tampered.
			mockCurrentRead = { ...UNREAD("tampered"), verificationChecklist: [] };
			throw { name: "RegistrationContentAccessError", code: "registration-content-unreadable", access: "tampered", requestId: "req-1", message: "m" };
		});
		const tr = await renderScreen();
		press(tr, "verification-checklist-toggle-id");
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(false);
		await pressAsync(tr, "registration-request-approval-approve");
		// Tampered is the one unread state that renders the checklist (62-52: Reject needs its gate).
		expect(exists(tr, "verification-checklist")).toBe(true);
		expect(textOf(tr, "registration-request-approval-content-unreadable")).toBe(dict("en").registrationContentTampered);
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
	});

	it("A22. at threshold 2 with an unread payload and no own task the vote-recorded line is absent", async () => {
		mockCurrentRead = UNREAD("not-a-recipient");
		mockTasks = [];
		mockSigningStatus = status();
		const tr = await renderScreen();
		expect(exists(tr, "registration-request-approval-vote-recorded")).toBe(false);
	});

	it("A23. geometry: the unreadable text has no line limit and no clipping ancestor", async () => {
		mockCurrentRead = UNREAD("not-a-recipient");
		const tr = await renderScreen();
		const screen = tr.root.findByProps({ testID: "registration-request-approval-screen" });
		const block = tr.root.findByProps({ testID: "registration-request-approval-content-unreadable" });
		const texts = block.findAll((n) => typeof n.type === "string" && n.children.some((c) => typeof c === "string"));
		expect(texts.length).toBeGreaterThan(0);
		for (const n of texts) {
			expect(n.props.numberOfLines).toBeUndefined();
			expect(n.props.ellipsizeMode).toBeUndefined();
			expect(clippingAncestors(n, screen)).toEqual([]);
		}
	});

	it("A24. no console call and no rendered text is an access code", async () => {
		for (const access of ACCESS_CODES) {
			jest.clearAllMocks();
			mockCurrentRead = UNREAD(access);
			const tr = await renderScreen();
			const rendered = tr.root
				.findAll((n) => typeof n.type === "string")
				.flatMap((n) => n.children.filter((c): c is string => typeof c === "string"));
			for (const code of ACCESS_CODES) expect(rendered).not.toContain(code);
			expect(whole(tr)).not.toContain("req-1 " + access);
		}
		consoleSpies.forEach((s) => expect(s).not.toHaveBeenCalled());
	});
});
