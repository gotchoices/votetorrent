/**
 * Keyboard inset on the approval screen: under forced edge-to-edge (targetSdk 35)
 * `adjustResize` is inert, so the screen shell must pad by the IME height or the
 * bottom-pinned reject card is drawn over by the keyboard. Jest has no IME; the
 * Keyboard emitter is stubbed and Platform.Version controlled.
 */
import React from "react";
import renderer, { act } from "react-test-renderer";
import { Keyboard, Platform, View } from "react-native";

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

const mockRegistrationEngine = {
	getRegistrationRequest: jest.fn(async (_id: string) => PENDING_READ),
	getPriorRejections: jest.fn(async () => []),
	rejectRegistrationRequest: jest.fn(async () => undefined),
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
	completeSignature: jest.fn(async () => undefined),
	getRegistrantSigningStatus: jest.fn(async () => null),
};
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "registration") return mockRegistrationEngine;
	if (name === "signatureTasksEngine") return mockSignatureTasksEngine;
	return null;
});

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
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		require("react").useEffect(() => cb(), [cb]);
	},
	useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() }),
	useRoute: () => ({ params: { requestId: "req-pending-1", authorityId: "auth-1" } }),
}));
jest.mock("../../../providers/AppProvider", () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));
jest.mock("../../../engines/device-signer", () => ({ createDeviceSigner: jest.fn() }));
jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: () => ({ scopes: ["vrg"], loading: false, refresh: () => undefined }),
}));
jest.mock("../../../providers/SettingsProvider", () => ({ useSettings: () => ({ showHelpIcons: false }) }));

// Pinned to android: the API-version gate (K3) only applies there.
const SHOW = "keyboardDidShow";
const HIDE = "keyboardDidHide";

// Several components subscribe to the same event; keep every callback.
let handlers: Record<string, ((e?: unknown) => void)[]>;
const originalVersion = Platform.Version;
const originalOS = Platform.OS;

function setVersion(v: number) {
	Object.defineProperty(Platform, "Version", { value: v, configurable: true });
}

beforeEach(() => {
	handlers = {};
	jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, cb: any) => {
		(handlers[event] ??= []).push(cb);
		return { remove: jest.fn() };
	}) as any);
	jest.spyOn(console, "error").mockImplementation(() => undefined);
	jest.spyOn(console, "warn").mockImplementation(() => undefined);
	Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
	setVersion(35);
});

afterEach(() => {
	jest.restoreAllMocks();
	Object.defineProperty(Platform, "Version", { value: originalVersion, configurable: true });
	Object.defineProperty(Platform, "OS", { value: originalOS, configurable: true });
});

function flatten(style: any): Record<string, any> {
	if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
	return style ?? {};
}

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

const show = (h: number) => act(() => {
		handlers[SHOW]?.forEach((cb) => cb({ endCoordinates: { height: h } }));
	});
const hide = () => act(() => {
		handlers[HIDE]?.forEach((cb) => cb());
	});

function styleOf(tr: renderer.ReactTestRenderer, testID: string) {
	return flatten(tr.root.findAll((n) => n.type === View && n.props.testID === testID)[0].props.style);
}

async function openRejectCard(tr: renderer.ReactTestRenderer) {
	const press = (id: string) => {
		const w = tr.root.findByProps({ testID: id });
		const n = [w, ...w.findAll(() => true)].find((x) => typeof x.props.onPress === "function");
		act(() => n!.props.onPress());
	};
	press("verification-checklist-toggle-id");
	press("registration-request-approval-reject");
}

describe("RegistrationRequestApprovalScreen keyboard inset", () => {
	it("K1: shell paddingBottom tracks the keyboard height on API 35", async () => {
		const tr = await renderScreen();
		expect(styleOf(tr, "registration-request-approval-screen").paddingBottom).toBe(0);
		show(300);
		expect(styleOf(tr, "registration-request-approval-screen").paddingBottom).toBe(300);
		hide();
		expect(styleOf(tr, "registration-request-approval-screen").paddingBottom).toBe(0);
	});

	it("K2: reject-card host does not double-count the gesture inset while the keyboard is up", async () => {
		const tr = await renderScreen();
		await openRejectCard(tr);
		expect(styleOf(tr, "registration-request-approval-reject-card-host").paddingBottom).toBe(24);
		show(300);
		expect(styleOf(tr, "registration-request-approval-reject-card-host").paddingBottom).toBe(0);
		hide();
		expect(styleOf(tr, "registration-request-approval-reject-card-host").paddingBottom).toBe(24);
	});

	it("K3: below API 35 the platform resizes, so the shell adds no inset", async () => {
		setVersion(34);
		const tr = await renderScreen();
		show(300);
		expect(styleOf(tr, "registration-request-approval-screen").paddingBottom).toBe(0);
	});

	it("K4: reason input and both buttons render inside the host", async () => {
		const tr = await renderScreen();
		await openRejectCard(tr);
		const host = tr.root.findByProps({ testID: "registration-request-approval-reject-card-host" });
		for (const id of ["reject-reason-reason-input", "reject-reason-confirm"]) {
			expect(host.findAllByProps({ testID: id }).length).toBeGreaterThan(0);
		}
		expect(host.findAll((n) => typeof n.props.testID === "string" && /dismiss|cancel|keep/i.test(n.props.testID)).length).toBeGreaterThan(0);
	});
});
