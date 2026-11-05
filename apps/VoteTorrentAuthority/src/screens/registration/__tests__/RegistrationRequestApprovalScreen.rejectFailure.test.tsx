/**
 * Reject failures, officer standing and the request-detail footer (UAT 62 gap 4 items 1 and 2).
 * A failed Confirm Rejection explains itself INSIDE the reject card; Confirm is gated on canDecide;
 * scopes are re-read on focus; the engine's undecidable-request refusal maps to fixed copy by code.
 */
import React from "react";
import renderer, { act } from "react-test-renderer";
import { StyleSheet } from "react-native";

const PENDING_READ: any = {
	requestId: "req-pending-1",
	authorityId: "auth-1",
	requesterKey: "requester-key-1",
	issuerType: "registrant",
	payload: {
		registrant: { id: "registrant-draft-1", authorityId: "auth-1", expiration: "2099-01-01T00:00:00.000Z" },
		public: { lastName: "Doe", firstName: "Jane" },
		private: { expiration: "2099-01-01T00:00:00.000Z", details: [] },
	},
	payloadCid: "cid-pending-1",
	status: "p",
	submittedAt: "2026-07-01T09:00:00Z",
	receivedAt: "2026-08-05T10:00:00Z",
};

const ENGINE_TEXT = "engine-secret-text req-pending-1 SignatureValid";
const mockGoBack = jest.fn();
const mockRejectRegistrationRequest = jest.fn(async (..._a: any[]): Promise<any> => undefined);
const mockCompleteSignature = jest.fn(async (..._a: any[]): Promise<any> => undefined);
const mockRegistrationEngine = {
	getRegistrationRequest: jest.fn(async (_id: string) => PENDING_READ),
	getPriorRejections: jest.fn(async () => []),
	rejectRegistrationRequest: mockRejectRegistrationRequest,
	getLikelyDuplicateRequests: jest.fn(async () => []),
	getDuplicateClosure: jest.fn(async () => undefined),
};
const mockSignatureTasksEngine = {
	getRequestedSignatures: jest.fn(async () => [
		{
			type: "signature",
			network: {},
			userId: "device-user-1",
			signatureType: "registrant",
			requestId: PENDING_READ.requestId,
			payload: PENDING_READ.payload,
			submittedAt: PENDING_READ.submittedAt,
			issuerType: PENDING_READ.issuerType,
		},
	]),
	getSignatureDigest: jest.fn(async () => new Uint8Array([9])),
	completeSignature: mockCompleteSignature,
	getRegistrantSigningStatus: jest.fn(async () => null),
};
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "registration") return mockRegistrationEngine;
	if (name === "signatureTasksEngine") return mockSignatureTasksEngine;
	return null;
});

// Officer lookup: a stateful stand-in for the real hook so a focus refresh re-reads it.
let mockLookup: jest.Mock;
let mockFocusCb: (() => void) | undefined;

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 24, left: 0, right: 0 }),
}));
jest.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock("@react-navigation/native", () => ({
	dark: false,
	useTheme: () => ({
		dark: false,
		colors: new Proxy({}, { get: (_t, k) => `sentinel-${String(k)}` }),
	}),
	useNavigation: () => ({ navigate: jest.fn(), goBack: mockGoBack, setOptions: jest.fn() }),
	useRoute: () => ({ params: { requestId: "req-pending-1", authorityId: "auth-1" } }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		require("react").useEffect(() => {
			mockFocusCb = cb as () => void;
			return cb();
		}, [cb]);
	},
}));
jest.mock("../../../providers/AppProvider", () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));
jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => async () => new Uint8Array([1])),
}));
jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const R = require("react");
		const [scopes, setScopes] = R.useState(undefined);
		const [nonce, setNonce] = R.useState(0);
		const refresh = R.useCallback(() => setNonce((n: number) => n + 1), []);
		R.useEffect(() => {
			setScopes(mockLookup());
		}, [nonce]);
		return { scopes, loading: false, refresh };
	},
}));
jest.mock("../../../providers/SettingsProvider", () => ({ useSettings: () => ({ showHelpIcons: false }) }));

beforeEach(() => {
	jest.clearAllMocks();
	mockLookup = jest.fn(() => ["vrg"]);
	mockFocusCb = undefined;
	mockRejectRegistrationRequest.mockImplementation(async () => undefined);
	mockCompleteSignature.mockImplementation(async () => undefined);
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
	await act(async () => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	});
	return tr;
}

function pressable(tr: renderer.ReactTestRenderer, id: string) {
	const w = tr.root.findByProps({ testID: id });
	return [w, ...w.findAll(() => true)].find((x) => typeof x.props.onPress === "function")!;
}
function press(tr: renderer.ReactTestRenderer, id: string) {
	act(() => pressable(tr, id).props.onPress());
}
async function flush() {
	await act(async () => {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	});
}
function isDisabled(tr: renderer.ReactTestRenderer, id: string) {
	const w = tr.root.findByProps({ testID: id });
	return [w, ...w.findAll(() => true)].find((n) => "disabled" in n.props)?.props.disabled === true;
}
function exists(tr: renderer.ReactTestRenderer, id: string) {
	return tr.root.findAllByProps({ testID: id }).length > 0;
}
function textWithin(tr: renderer.ReactTestRenderer, id: string): string {
	const find = (n: any): any => {
		if (!n || typeof n !== "object") return null;
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
async function openCardAndConfirm(tr: renderer.ReactTestRenderer) {
	press(tr, "verification-checklist-toggle-id");
	press(tr, "registration-request-approval-reject");
	act(() => tr.root.findByProps({ testID: "reject-reason-reason-input" }).props.onChangeText("not enough proof"));
	await act(async () => {
		try {
			await pressable(tr, "reject-reason-confirm").props.onPress();
		} catch {
			/* the screen rethrows for the card latch */
		}
	});
	await flush();
}
const unverifiable = () =>
	Object.assign(new Error(ENGINE_TEXT), { name: "RequesterSignatureUnverifiableError", code: "requester-signature-unverifiable" });

describe("RegistrationRequestApprovalScreen reject failures (UAT 62 gap 4 item 1)", () => {
	it("F1: a failed rejection shows its copy inside the card, and the top surface is absent", async () => {
		mockRejectRegistrationRequest.mockRejectedValueOnce(new Error("boom"));
		const tr = await renderScreen();
		await openCardAndConfirm(tr);
		const card = tr.root.findByProps({ testID: "reject-reason-card" });
		expect(card.findAllByProps({ testID: "reject-reason-error" }).length).toBeGreaterThan(0);
		expect(textWithin(tr, "reject-reason-error")).toContain("registrationRequestRejectFailed");
		expect(exists(tr, "registration-request-approval-error")).toBe(false);
	});

	it("F2: Confirm Rejection is disabled for a non-vrg device even with checklist and reason", async () => {
		mockLookup = jest.fn(() => ["mel"]);
		const tr = await renderScreen();
		press(tr, "verification-checklist-toggle-id");
		// footer Reject is disabled for a non-officer, so reveal the card by its own control is impossible;
		// assert the gate through the footer and (if reachable) the card.
		expect(isDisabled(tr, "registration-request-approval-reject")).toBe(true);
	});

	it("F2b: the card's Confirm itself honours canDecide when the card is already open", async () => {
		const tr = await renderScreen();
		press(tr, "verification-checklist-toggle-id");
		press(tr, "registration-request-approval-reject");
		act(() => tr.root.findByProps({ testID: "reject-reason-reason-input" }).props.onChangeText("reason"));
		expect(isDisabled(tr, "reject-reason-confirm")).toBe(false);
		mockLookup.mockImplementation(() => undefined);
		act(() => mockFocusCb!());
		await flush();
		expect(isDisabled(tr, "reject-reason-confirm")).toBe(true);
	});

	it("F3: scopes are re-read on focus; after the officer lookup fails, footer buttons are disabled", async () => {
		const tr = await renderScreen();
		press(tr, "verification-checklist-toggle-id");
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(false);
		const calls = mockLookup.mock.calls.length;
		mockLookup.mockImplementation(() => undefined);
		act(() => mockFocusCb!());
		await flush();
		expect(mockLookup.mock.calls.length).toBeGreaterThan(calls);
		expect(isDisabled(tr, "registration-request-approval-approve")).toBe(true);
		expect(isDisabled(tr, "registration-request-approval-reject")).toBe(true);
	});

	it("F4: an unverifiable request on reject shows fixed copy in the card, never the engine text", async () => {
		mockRejectRegistrationRequest.mockRejectedValueOnce(unverifiable());
		const tr = await renderScreen();
		await openCardAndConfirm(tr);
		const text = textWithin(tr, "reject-reason-error");
		expect(text).toContain("registrationRequestUnverifiable");
		expect(text).not.toContain("engine-secret-text");
		expect(text).not.toContain("registrationRequestRejectFailed");
		expect(mockGoBack).not.toHaveBeenCalled();
	});

	it("F5: an unverifiable request on approve shows the same copy in the top surface", async () => {
		mockCompleteSignature.mockRejectedValueOnce(unverifiable());
		const tr = await renderScreen();
		press(tr, "verification-checklist-toggle-id");
		await act(async () => {
			await pressable(tr, "registration-request-approval-approve").props.onPress();
		});
		await flush();
		const text = textWithin(tr, "registration-request-approval-error");
		expect(text).toContain("registrationRequestUnverifiable");
		expect(text).not.toContain("engine-secret-text");
		expect(mockGoBack).not.toHaveBeenCalled();
	});

	it("F6: a closed-as-duplicate refusal still takes the D-44 path (card closes, no error copy)", async () => {
		mockRejectRegistrationRequest.mockRejectedValueOnce(
			Object.assign(new Error("dup"), { name: "RegistrationDuplicateError", code: "closed-as-duplicate" })
		);
		const tr = await renderScreen();
		await openCardAndConfirm(tr);
		expect(exists(tr, "reject-reason-card")).toBe(false);
		expect(exists(tr, "registration-request-approval-error")).toBe(false);
		expect(JSON.stringify(tr.toJSON())).not.toContain("registrationRequestRejectFailed");
	});
});

describe("RegistrationRequestApprovalScreen footer buttons (UAT 62 gap 4 item 2)", () => {
	it("G1: Approve and Reject use the tall size (paddingVertical 16), not the thin 6", async () => {
		const tr = await renderScreen();
		for (const id of ["registration-request-approval-approve", "registration-request-approval-reject"]) {
			const slot = tr.root.findByProps({ testID: id });
			const touchable = slot.findAll((n) => n.props.accessibilityRole === "button" && n.props.style !== undefined)[0];
			const flat = StyleSheet.flatten(touchable.props.style) as { paddingVertical?: number };
			expect(flat.paddingVertical).toBe(16);
		}
	});
});
