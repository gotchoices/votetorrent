/**
 * NetworksScreen — the Direct (advanced) field and CONNECT scroll above the soft keyboard on
 * API 35+ (forced edge-to-edge: the window is not resized, so the list must be scrolled).
 */
import React from "react";
import renderer from "react-test-renderer";
import { Keyboard, Platform, ScrollView } from "react-native";

jest.mock("@multiformats/multiaddr", () => ({ multiaddr: () => ({ getComponents: () => [] }) }), { virtual: true });
jest.mock("@votetorrent/vote-core", () => ({}), { virtual: true });
jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));
jest.mock("@react-navigation/native", () => {
	const ReactForMock = require("react");
	return {
		useTheme: () => ({
			colors: { primary: "#007AFF", error: "#FF3B30", important: "#FF9500", text: "#000", textSecondary: "#888", accent: "#ddd" },
		}),
		useNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
		useFocusEffect: (cb: () => void | (() => void)) => {
			ReactForMock.useEffect(() => cb(), []);
		},
	};
});
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("../../../providers/SettingsProvider", () => ({ useSettings: () => ({ showHelpIcons: false }) }));
const mockNetworksEngine = { getRecentNetworks: jest.fn(async () => []) };
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ networksEngine: mockNetworksEngine, selectNetwork: jest.fn() }),
}));
jest.mock("../../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: null, syncState: "offline", connectedPeers: jest.fn() }),
}));

const NetworksScreen = require("../NetworksScreen").default;

const mockScrollToEnd = jest.fn();
let handlers: Record<string, Array<(e?: unknown) => void>>;
let removes: jest.Mock[];
const originalVersion = Platform.Version;
const originalOS = Platform.OS;

beforeEach(() => {
	jest.clearAllMocks();
	handlers = {};
	removes = [];
	jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, cb: any) => {
		(handlers[event] ??= []).push(cb);
		const remove = jest.fn(() => {
			handlers[event] = (handlers[event] ?? []).filter((h) => h !== cb);
		});
		removes.push(remove);
		return { remove };
	}) as any);
	jest.spyOn(Keyboard, "isVisible").mockReturnValue(false);
	jest.spyOn(globalThis, "requestAnimationFrame").mockImplementation(((cb: (t: number) => void) => {
		cb(0);
		return 0;
	}) as any);
	Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
	Object.defineProperty(Platform, "Version", { value: 35, configurable: true });
});

afterEach(() => {
	jest.restoreAllMocks();
	Object.defineProperty(Platform, "OS", { value: originalOS, configurable: true });
	Object.defineProperty(Platform, "Version", { value: originalVersion, configurable: true });
});

async function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<NetworksScreen />);
	});
	// The jest ScrollView is a class component; the screen's ref points at this instance.
	const instance = tr.root.findByType(ScrollView).instance as { scrollToEnd: unknown };
	instance.scrollToEnd = mockScrollToEnd;
	await renderer.act(async () => {
		await Promise.resolve();
	});
	return tr;
}

function field(tr: renderer.ReactTestRenderer, kind: "direct" | "find") {
	const match = tr.root.findAll(
		(n) =>
			typeof n.props.onChangeText === "function" &&
			n.props.placeholder === undefined &&
			(kind === "direct" ? n.props.autoCapitalize === "none" : n.props.autoCapitalize !== "none") &&
			n.props.accessibilityLabel !== undefined,
	);
	return match[0];
}

const show = async () =>
	renderer.act(async () => {
		handlers["keyboardDidShow"]?.forEach((cb) => cb({ endCoordinates: { height: 300 } }));
	});

describe("NetworksScreen Direct field keyboard scroll", () => {
	it("1: focusing the Direct field then keyboardDidShow scrolls to end (animated)", async () => {
		const tr = await renderScreen();
		await renderer.act(async () => {
			field(tr, "direct").props.onFocus?.({});
		});
		await show();
		expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: true });
	});

	it("2: focusing the Find field does not scroll", async () => {
		const tr = await renderScreen();
		await renderer.act(async () => {
			field(tr, "find").props.onFocus?.({});
		});
		await show();
		expect(mockScrollToEnd).not.toHaveBeenCalled();
	});

	it("3: blur stops scrolling; unmount removes listeners", async () => {
		const tr = await renderScreen();
		const direct = field(tr, "direct");
		await renderer.act(async () => {
			direct.props.onFocus?.({});
		});
		await renderer.act(async () => {
			field(tr, "direct").props.onBlur?.({});
		});
		await show();
		expect(mockScrollToEnd).not.toHaveBeenCalled();

		await renderer.act(async () => {
			field(tr, "direct").props.onFocus?.({});
		});
		const registered = (handlers["keyboardDidShow"] ?? []).slice();
		await renderer.act(async () => {
			tr.unmount();
		});
		expect(removes.length).toBeGreaterThan(0);
		removes.forEach((r) => expect(r).toHaveBeenCalled());
		registered.forEach((cb) => cb({ endCoordinates: { height: 300 } }));
		// Listeners are removed; a stale handler must not touch the unmounted ScrollView.
		expect(handlers["keyboardDidShow"] ?? []).toHaveLength(0);
	});

	it("4: focusing while the keyboard is already up scrolls immediately", async () => {
		(Keyboard.isVisible as jest.Mock).mockReturnValue(true);
		const tr = await renderScreen();
		await renderer.act(async () => {
			field(tr, "direct").props.onFocus?.({});
		});
		expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: true });
	});
});
