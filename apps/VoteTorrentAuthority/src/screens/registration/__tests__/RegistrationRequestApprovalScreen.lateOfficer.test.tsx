/**
 * RegistrationRequestApprovalScreen.lateOfficer.test.tsx - 62-144 (D-51, late-officer ruling).
 *
 * Covers only the late-officer explanation on this screen:
 *  - L4: a `not-a-recipient` request keeps its unreadable-content line, adds the explanation after
 *    it (English and Spanish), and leaves Approve/Reject disabled.
 *  - L5: `no-opener`, `unreadable`, `tampered` and a readable payload render their own state and no
 *    explanation.
 * Every engine is a call-recording jest.fn: this proves what the screen renders, never an
 * access-control boundary (the schema CHECKs and the real-engine specs own that).
 * `continuity-review` is deliberately NOT mocked.
 */

import React from "react";
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

describe("RegistrationRequestApprovalScreen - late officer explanation", () => {
	const UNREAD = (access: string) => ({ ...PENDING_READ, payload: {}, payloadAccess: access });

	it("L4. not-a-recipient keeps its line, adds the explanation after it, footer stays disabled", async () => {
		mockCurrentRead = UNREAD("not-a-recipient");
		const tr = await renderScreen();
		expect(textOf(tr, "registration-request-approval-content-unreadable")).toBe(dict("en").registrationContentNotRecipient);
		expect(textOf(tr, "registration-request-approval-late-officer")).toBe(dict("en").sealedBeforeOfficerExplanation);
		const ids = orderedTestIDs(tr);
		expect(ids.indexOf("registration-request-approval-late-officer")).toBeGreaterThan(ids.indexOf("registration-request-approval-content-unreadable"));
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-reject")).toBe(true);

		jest.clearAllMocks();
		mockLocale = "es";
		const es = await renderScreen();
		expect(textOf(es, "registration-request-approval-late-officer")).toContain("funcionario");
	});

	it("L5. no-opener, unreadable, tampered and readable render no explanation", async () => {
		// WR-R6-06: each case first proves the state under test rendered (its own unreadable line, or
		// the readable payload), so the absence check cannot pass on a screen that never rendered.
		const UNREAD_LINE: Record<string, string> = {
			"no-opener": dict("en").registrationContentNoKey,
			unreadable: dict("en").registrationContentUnreadable,
			tampered: dict("en").registrationContentTampered,
		};
		for (const access of ["no-opener", "unreadable", "tampered", "opened"]) {
			jest.clearAllMocks();
			mockCurrentRead = access === "opened" ? { ...PENDING_READ, payloadAccess: access } : UNREAD(access);
			const tr = await renderScreen();
			if (access === "opened") {
				expect(exists(tr, "registration-request-approval-content-unreadable")).toBe(false);
				expect(whole(tr)).toContain("Doe");
			} else {
				expect(UNREAD_LINE[access]).toEqual(expect.any(String));
				expect(textOf(tr, "registration-request-approval-content-unreadable")).toBe(UNREAD_LINE[access]);
			}
			expect(exists(tr, "registration-request-approval-late-officer")).toBe(false);
		}
	});
});
