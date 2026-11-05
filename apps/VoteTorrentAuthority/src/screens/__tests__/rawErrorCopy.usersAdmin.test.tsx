/**
 * rawErrorCopy.usersAdmin.test.tsx - the officer and user screens never render engine text for a
 * non-peer failure. Each screen's engine call rejects with an error that carries a table name and
 * an id; the tree must show the catalog key and none of that text. A device-signing rejection
 * (code LOCKOUT) still shows the hook's own copy.
 */
import React from "react";
import renderer from "react-test-renderer";

const RAW = "Engine X userId=u1 table=UserKey";
const rawErr = () => new Error(RAW);

let mockRouteParams: any = {};
let mockEngines: Record<string, any> = {};
let mockHeaderRight: any;
const mockGetEngine = jest.fn(async (name: string) => mockEngines[name]);
const mockNavigation = {
	navigate: jest.fn(),
	goBack: jest.fn(),
	popTo: jest.fn(),
	setOptions: jest.fn((o: any) => {
		mockHeaderRight = o?.headerRight;
	}),
};

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });
jest.mock("../../providers/SettingsProvider", () => ({ useSettings: () => ({ showHelpIcons: false }) }));
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({ colors: new Proxy({}, { get: (_t, p) => `c-${String(p)}` }) }),
	useNavigation: () => mockNavigation,
	useRoute: () => ({ params: mockRouteParams }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		const R = require("react");
		R.useEffect(() => cb(), []);
	},
}));
jest.mock("../../providers/AppProvider", () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));
// The hook: a LOCKOUT rejection is handled with the hook's own copy; anything else is unhandled.
jest.mock("../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => (err: any) =>
		err?.code === "LOCKOUT" ? { handled: false, message: "signingLockoutCopy" } : { handled: false },
}));
jest.mock("../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({ id: "device-user-1", name: "Device User" })),
}));
let mockSignerImpl: (b: Uint8Array) => Promise<any> = async () => ({
	signature: "s",
	signerKey: "k",
	signerUserId: "device-user-1",
});
jest.mock("../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => (b: Uint8Array) => mockSignerImpl(b)),
}));

const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
afterAll(() => warnSpy.mockRestore());

function allText(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}

async function flush(n = 12) {
	await renderer.act(async () => {
		for (let i = 0; i < n; i++) await Promise.resolve();
	});
}

async function mount(el: React.ReactElement): Promise<renderer.ReactTestRenderer> {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(el);
	});
	await flush();
	return tr;
}

function byTitle(tr: renderer.ReactTestRenderer, title: string) {
	const n = tr.root.findAll((x) => x.props?.title === title && typeof x.props?.onPress === "function")[0];
	if (!n) throw new Error(`no control titled ${title}`);
	return n;
}

async function press(node: { props: Record<string, any> }) {
	await renderer.act(async () => {
		await node.props.onPress();
	});
	await flush();
}

function expectGeneric(text: string, key: string) {
	expect(text).toContain(key);
	expect(text).not.toContain("Engine X");
	expect(text).not.toContain("userId");
	expect(text).not.toContain("UserKey");
}

beforeEach(() => {
	mockRouteParams = {};
	mockEngines = {};
	mockHeaderRight = undefined;
	mockNavigation.goBack.mockClear();
	mockSignerImpl = async () => ({ signature: "s", signerKey: "k", signerUserId: "device-user-1" });
});

const authority = { id: "auth-1" };
const adminDetails = { admin: { officers: [{ userId: "o1", title: "T", scopes: [] }], thresholdPolicies: [] } };

describe("EditOfficerScreen", () => {
	const Screen = () => require("../admin/EditOfficerScreen").default;

	it("U-1 load failure shows errorLoadFailedGeneric", async () => {
		mockRouteParams = { authority, officerId: "o1" };
		const openAuthority = jest.fn(async () => { throw rawErr(); });
		mockEngines = { network: { openAuthority } };
		const S = Screen();
		const tr = await mount(<S />);
		// REVIEW WR-R5-04: the rejecting stub ran, so the copy is the rejection's, not a harness TypeError's.
		expect(openAuthority).toHaveBeenCalled();
		expectGeneric(allText(tr), "errorLoadFailedGeneric");
	});

	it("U-1 save failure shows errorActionFailedGeneric", async () => {
		mockRouteParams = { authority };
		const proposeAdmin = jest.fn(async () => { throw rawErr(); });
		mockEngines = {
			network: {
				openAuthority: jest.fn(async () => ({
					getAdminDetails: async () => adminDetails,
					proposeAdmin,
				})),
			},
		};
		const S = Screen();
		const tr = await mount(<S />);
		await press(byTitle(tr, "save"));
		expect(proposeAdmin).toHaveBeenCalled();
		expectGeneric(allText(tr), "errorActionFailedGeneric");
	});

	it("U-1 remove failure shows errorActionFailedGeneric", async () => {
		mockRouteParams = { authority, officerId: "o1" };
		const proposeAdmin = jest.fn(async () => { throw rawErr(); });
		mockEngines = {
			network: {
				openAuthority: jest.fn(async () => ({
					getAdminDetails: async () => adminDetails,
					proposeAdmin,
					}),
				),
				getUser: jest.fn(async () => undefined),
			},
		};
		const S = Screen();
		const tr = await mount(<S />);
		expect(typeof mockHeaderRight).toBe("function");
		const chip = mockHeaderRight();
		await press({ props: { onPress: chip.props.onPress } });
		expect(proposeAdmin).toHaveBeenCalled();
		expectGeneric(allText(tr), "errorActionFailedGeneric");
	});
});

describe("OfficerDetailsScreen", () => {
	it("U-1 open-user failure shows errorLoadFailedGeneric", async () => {
		mockRouteParams = { officer: { userId: "o1", title: "T", scopes: [] }, authority };
		const getUser = jest.fn(async () => { throw rawErr(); });
		mockEngines = { network: { getUser } };
		const S = require("../admin/OfficerDetailsScreen").default;
		const tr = await mount(<S />);
		const card = tr.root.findAll((x) => Array.isArray(x.props?.additionalInfo) && typeof x.props?.onPress === "function")[0];
		await press(card);
		expect(getUser).toHaveBeenCalled();
		expectGeneric(allText(tr), "errorLoadFailedGeneric");
	});
});

describe("UserDetailsScreen", () => {
	it("U-1 summary and history load failures show errorLoadFailedGeneric", async () => {
		const userEngine = {
			getSummary: jest.fn(async () => { throw rawErr(); }),
			getHistory: jest.fn(async () => { throw rawErr(); }),
		};
		mockRouteParams = { user: { id: "u1", name: "U", activeKeys: [] }, userEngine };
		const { UserDetailsScreen } = require("../users/UserDetailsScreen");
		const tr = await mount(<UserDetailsScreen />);
		expect(userEngine.getSummary).toHaveBeenCalled();
		expect(userEngine.getHistory).toHaveBeenCalled();
		expectGeneric(allText(tr), "errorLoadFailedGeneric");
	});
});

describe("ReviseUserScreen", () => {
	async function prepare(revise: any) {
		mockRouteParams = { user: { id: "u1", name: "Una" }, userEngine: { revise } };
		const { ReviseUserScreen } = require("../users/ReviseUserScreen");
		const tr = await mount(<ReviseUserScreen />);
		const inputs = tr.root.findAll((n) => typeof n.props?.onChangeText === "function" && n.props?.title === "name");
		await renderer.act(async () => {
			inputs[0].props.onChangeText("Una Two");
		});
		return tr;
	}

	it("U-1 save failure shows errorActionFailedGeneric", async () => {
		const revise = jest.fn(async () => { throw rawErr(); });
		const tr = await prepare(revise);
		await press(byTitle(tr, "sign"));
		await press(byTitle(tr, "save"));
		expect(revise).toHaveBeenCalled();
		expectGeneric(allText(tr), "errorActionFailedGeneric");
	});

	it("U-1 sign failure shows errorActionFailedGeneric", async () => {
		const tr = await prepare(jest.fn());
		const signer = jest.fn(async () => { throw rawErr(); });
		mockSignerImpl = signer;
		await press(byTitle(tr, "sign"));
		expect(signer).toHaveBeenCalled();
		expectGeneric(allText(tr), "errorActionFailedGeneric");
	});
});

describe("AddKeyScreen", () => {
	const mountAdd = (addKey: any) => {
		mockRouteParams = { user: { id: "u1", name: "Una", activeKeys: [] }, userEngine: { addKey } };
		const { AddKeyScreen } = require("../users/AddKeyScreen");
		return mount(<AddKeyScreen />);
	};

	it("U-1 save failure shows errorActionFailedGeneric", async () => {
		const addKey = jest.fn(async () => { throw rawErr(); });
		const tr = await mountAdd(addKey);
		await press(byTitle(tr, "addKey"));
		expect(addKey).toHaveBeenCalled();
		expectGeneric(allText(tr), "errorActionFailedGeneric");
	});

	it("U-4 a device-signing rejection still shows the hook's copy", async () => {
		const tr = await mountAdd(jest.fn(async () => { throw Object.assign(new Error(RAW), { code: "LOCKOUT" }); }));
		await press(byTitle(tr, "addKey"));
		const text = allText(tr);
		expect(text).toContain("signingLockoutCopy");
		expect(text).not.toContain("errorActionFailedGeneric");
		expect(text).not.toContain("Engine X");
	});
});

describe("DefaultUserScreen", () => {
	it("U-1 save failure shows errorActionFailedGeneric, not the storage error", async () => {
		const set = jest.fn(async () => { throw rawErr(); });
		mockRouteParams = {
			defaultUser: { name: "D", image: { url: "" } },
			defaultUserEngine: { set },
		};
		const { DefaultUserScreen } = require("../users/DefaultUserScreen");
		const tr = await mount(<DefaultUserScreen />);
		await press(byTitle(tr, "save"));
		expect(set).toHaveBeenCalled();
		expectGeneric(allText(tr), "errorActionFailedGeneric");
	});
});
