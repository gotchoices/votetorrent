/**
 * An officer whose signing key was invalidated by a biometric enrolment change is routed to
 * Replace Signing Key from BOTH Confirm Rejection and Approve Registration. The engine boundary
 * re-throws the device signer's error with an engine-labelled message AND its `code`; the screen's
 * device-signing handler keys on that code, never on the message. A code-less error (what the
 * engine boundary used to produce) falls through to the generic copy, which is why the engine
 * preserving `code` is what makes the routing work.
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
const mockNavigate = jest.fn();
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
	useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack, setOptions: jest.fn() }),
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

const ENGINE_SHAPED_KEY_INVALIDATED = (method: string) =>
	Object.assign(new Error(`${method}: Key permanently invalidated`), { code: "KEY_INVALIDATED_REASSOCIATE" });

describe("RegistrationRequestApprovalScreen key invalidated routing", () => {
	it("K1: Confirm Rejection routes the re-thrown KEY_INVALIDATED_REASSOCIATE to key replacement", async () => {
		mockRejectRegistrationRequest.mockRejectedValueOnce(
			ENGINE_SHAPED_KEY_INVALIDATED("RegistrationEngine.rejectRegistrationRequest")
		);
		const tr = await renderScreen();
		await openCardAndConfirm(tr);
		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "invalidated" });
		expect(JSON.stringify(tr.toJSON())).not.toContain("registrationRequestRejectFailed");
		expect(mockGoBack).not.toHaveBeenCalled();
	});

	it("K2: Approve Registration routes the re-thrown KEY_INVALIDATED_REASSOCIATE to key replacement", async () => {
		mockCompleteSignature.mockRejectedValueOnce(
			ENGINE_SHAPED_KEY_INVALIDATED("SignatureTasksEngine.completeSignature")
		);
		const tr = await renderScreen();
		press(tr, "verification-checklist-toggle-id");
		await act(async () => {
			await pressable(tr, "registration-request-approval-approve").props.onPress();
		});
		await flush();
		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "invalidated" });
		expect(mockGoBack).not.toHaveBeenCalled();
	});

	it("K3 (control): the pre-fix shape with no code stays on the generic reject-failed copy", async () => {
		mockRejectRegistrationRequest.mockRejectedValueOnce(
			new Error("RegistrationEngine.rejectRegistrationRequest: Key permanently invalidated")
		);
		const tr = await renderScreen();
		await openCardAndConfirm(tr);
		expect(mockNavigate).not.toHaveBeenCalled();
		expect(textWithin(tr, "reject-reason-error")).toContain("registrationRequestRejectFailed");
	});

	it("K4 (control): a coded error outside the device-signing allow-list is not routed to key replacement", async () => {
		mockRejectRegistrationRequest.mockRejectedValueOnce(
			Object.assign(new Error("RegistrationEngine.rejectRegistrationRequest: nope"), { code: "SOME_OTHER_CODE" })
		);
		const tr = await renderScreen();
		await openCardAndConfirm(tr);
		expect(mockNavigate).not.toHaveBeenCalledWith("ProvisionSigningKey", expect.anything());
	});
});
