/**
 * The user and default-user screens read and write the image under `imageRef`, the field vote-core
 * and the engines use. They used `image`, which nothing reads: an entered image URL was dropped on
 * save, an existing image never showed, and a revise wrote a null ImageRef over the stored one.
 * Harness copied from rawErrorCopy.usersAdmin.test.tsx.
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
jest.mock("../../../providers/SettingsProvider", () => ({ useSettings: () => ({ showHelpIcons: false }) }));
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
jest.mock("../../../providers/AppProvider", () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));
// The hook: a LOCKOUT rejection is handled with the hook's own copy; anything else is unhandled.
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => (err: any) =>
		err?.code === "LOCKOUT" ? { handled: false, message: "signingLockoutCopy" } : { handled: false },
}));
jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({ id: "device-user-1", name: "Device User" })),
}));
let mockSignerImpl: (b: Uint8Array) => Promise<any> = async () => ({
	signature: "s",
	signerKey: "k",
	signerUserId: "device-user-1",
});
jest.mock("../../../engines/device-signer", () => ({
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

function input(tr: renderer.ReactTestRenderer, title: string) {
	const n = tr.root.findAll((x) => x.props?.title === title && typeof x.props?.onChangeText === "function")[0];
	if (!n) throw new Error(`no input titled ${title}`);
	return n;
}

async function type(tr: renderer.ReactTestRenderer, title: string, text: string) {
	await renderer.act(async () => {
		input(tr, title).props.onChangeText(text);
	});
}

const STORED = "https://img.local/stored.png";
const ENTERED = "https://img.local/entered.png";

describe("DefaultUserScreen imageRef", () => {
	it("shows the stored image URL", async () => {
		mockRouteParams = { defaultUser: { name: "D", imageRef: { url: STORED } }, defaultUserEngine: { set: jest.fn() } };
		const { DefaultUserScreen } = require("../DefaultUserScreen");
		const tr = await mount(<DefaultUserScreen />);
		expect(input(tr, "imageUrl").props.value).toBe(STORED);
	});

	it("saves an entered image URL under imageRef", async () => {
		const set = jest.fn(async () => undefined);
		mockRouteParams = { defaultUser: { name: "D" }, defaultUserEngine: { set } };
		const { DefaultUserScreen } = require("../DefaultUserScreen");
		const tr = await mount(<DefaultUserScreen />);
		await type(tr, "imageUrl", ENTERED);
		await press(byTitle(tr, "save"));
		expect(set).toHaveBeenCalledTimes(1);
		expect(set).toHaveBeenCalledWith({ name: "D", imageRef: { url: ENTERED } });
	});
});

describe("ReviseUserScreen imageRef", () => {
	async function mountRevise(revise: jest.Mock) {
		mockRouteParams = { user: { id: "u1", name: "Una", imageRef: { url: STORED }, activeKeys: [] }, userEngine: { revise } };
		const { ReviseUserScreen } = require("../ReviseUserScreen");
		return mount(<ReviseUserScreen />);
	}

	it("shows the stored image URL", async () => {
		const tr = await mountRevise(jest.fn());
		expect(input(tr, "imageUrl").props.value).toBe(STORED);
	});

	it("a name-only revise keeps the stored image", async () => {
		const revise = jest.fn(async () => undefined);
		const tr = await mountRevise(revise);
		await type(tr, "name", "Una Two");
		await press(byTitle(tr, "sign"));
		await press(byTitle(tr, "save"));
		expect(revise).toHaveBeenCalledTimes(1);
		expect((revise.mock.calls[0] as any[])[0].info).toEqual({ name: "Una Two", imageRef: { url: STORED } });
	});

	it("an entered image URL is revised under imageRef", async () => {
		const revise = jest.fn(async () => undefined);
		const tr = await mountRevise(revise);
		await type(tr, "imageUrl", ENTERED);
		await press(byTitle(tr, "sign"));
		await press(byTitle(tr, "save"));
		expect(revise).toHaveBeenCalledTimes(1);
		expect((revise.mock.calls[0] as any[])[0].info).toEqual({ name: "Una", imageRef: { url: ENTERED } });
	});
});
