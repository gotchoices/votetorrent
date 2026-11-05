/** SettingsScreen.peerUnavailable.test.tsx — 62-96: first reads after a cold start never show engine text. */
import React from "react";
import { Text } from "react-native";
import renderer from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const RAW = "Block default/app/TidHighWater is unavailable (cohort-unreachable): the repo could not determine whether it exists";
function peerError(): Error {
	return Object.assign(new Error(RAW), { name: "BlockUnavailableError", reason: "cohort-unreachable" });
}

const THEME = {
	colors: {
		primary: "p", background: "b", card: "c", text: "t", border: "bo", notification: "n", error: "e",
		textSecondary: "ts", important: "i", success: "s", accent: "a", warning: "w",
	},
};
const mockNavigate = jest.fn();
const mockSetOptions = jest.fn();
jest.mock("@react-navigation/native", () => ({
	useTheme: () => THEME,
	useNavigation: () => ({ navigate: mockNavigate, setOptions: mockSetOptions, goBack: jest.fn() }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			cb();
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));

async function flush() {
	for (let i = 0; i < 8; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
}
function textContent(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
}
function allText(tr: renderer.ReactTestRenderer): string {
	return tr.root.findAllByType(Text).map(textContent).join(" | ");
}
function noticeCount(tr: renderer.ReactTestRenderer): number {
	return tr.root.findAll((n) => n.props?.testID === "peer-read-unavailable-notice" && typeof n.type === "string").length;
}
async function pressRetry(tr: renderer.ReactTestRenderer) {
	const retry = tr.root.findAll(
		(n) => n.props?.testID === "peer-read-unavailable-retry" && typeof n.props?.onPress === "function"
	);
	expect(retry.length).toBeGreaterThan(0);
	await renderer.act(async () => {
		retry[0].props.onPress();
	});
	await flush();
}
beforeEach(() => {
	jest.clearAllMocks();
	jest.spyOn(console, "warn").mockImplementation(() => {});
	jest.spyOn(console, "error").mockImplementation(() => {});
	jest.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false, setShowHelpIcons: jest.fn() }),
}));
jest.mock("../../../i18n", () => ({
	__esModule: true,
	default: { language: "en", changeLanguage: jest.fn(async () => {}), on: jest.fn(), off: jest.fn() },
}));
jest.mock("../../../engines/engine-factory", () => {
	class NoNetworkEstablishedError extends Error {}
	return { NoNetworkEstablishedError, isNoNetworkEstablishedError: (e: unknown) => e instanceof NoNetworkEstablishedError };
});
let mockGetEngine = jest.fn();
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: (...a: unknown[]) => mockGetEngine(...a) }),
}));
// Settings renders the owner-trust notice, which reads the cadre-node context; no ownerTrust means "ok", so nothing renders.
jest.mock("../../../providers/CadreNodeProvider", () => ({ useCadreNode: () => ({ node: null }) }));

async function renderScreen() {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Screen = require("../SettingsScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<Screen />);
	});
	await flush();
	return tr;
}

describe("SettingsScreen peer-unavailable reads (62-96)", () => {
	it("S-1: a cohort-unreachable engine load shows the notice, no raw text, controls stay; Try Again re-runs", async () => {
		mockGetEngine = jest.fn().mockRejectedValueOnce(peerError()).mockResolvedValue(null);
		const tr = await renderScreen();
		expect(noticeCount(tr)).toBeGreaterThan(0);
		expect(allText(tr)).not.toContain("TidHighWater");
		expect(tr.root.findAll((n) => n.props?.testID === "settings-language-toggle").length).toBeGreaterThan(0);
		const calls = mockGetEngine.mock.calls.length;
		await pressRetry(tr);
		expect(mockGetEngine.mock.calls.length).toBeGreaterThan(calls);
		expect(noticeCount(tr)).toBe(0);
	});

	it("S-2: a generic failure shows settingsLoadFailed, never the raw text", async () => {
		mockGetEngine = jest.fn().mockRejectedValue(new Error("secret-table blew up"));
		const tr = await renderScreen();
		expect(allText(tr)).toContain("settingsLoadFailed");
		expect(allText(tr)).not.toContain("secret-table");
	});

	it("S-3: no-network stays silent", async () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { NoNetworkEstablishedError } = require("../../../engines/engine-factory");
		mockGetEngine = jest.fn().mockRejectedValue(new NoNetworkEstablishedError("none"));
		const tr = await renderScreen();
		// WR-R6-06 positive anchors: the no-network rejection was actually taken, and the screen
		// rendered its network-independent controls.
		expect(mockGetEngine).toHaveBeenCalled();
		expect(tr.root.findAll((n) => n.props?.testID === "settings-language-toggle").length).toBeGreaterThan(0);
		expect(console.error).not.toHaveBeenCalled();
		expect(noticeCount(tr)).toBe(0);
		expect(allText(tr)).not.toContain("settingsLoadFailed");
	});
});
