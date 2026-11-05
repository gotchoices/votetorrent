/**
 * NetworksScreen — O-04: the ScrollView carries usePreserveScrollOnResize's handlers so a
 * rotation keeps the officer's place (scrollEventThrottle 16, onScroll/onLayout/onContentSizeChange).
 */
import React from "react";
import renderer from "react-test-renderer";
import { ScrollView } from "react-native";

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

describe("NetworksScreen rotation scroll (O-04)", () => {
	it("P5: spreads the preserve-scroll handlers onto its ScrollView", async () => {
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(<NetworksScreen />);
		});
		const sv = tr.root.findByType(ScrollView);
		expect(sv.props.scrollEventThrottle).toBe(16);
		expect(typeof sv.props.onScroll).toBe("function");
		expect(typeof sv.props.onLayout).toBe("function");
		expect(typeof sv.props.onContentSizeChange).toBe("function");
		tr.unmount();
	});
});
