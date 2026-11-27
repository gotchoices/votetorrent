/** TasksScreen.peerUnavailable.test.tsx — 62-96: first reads after a cold start never show engine text. */
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

jest.mock("../../../engines/engine-factory", () => {
	class NoNetworkEstablishedError extends Error {}
	return { NoNetworkEstablishedError, isNoNetworkEstablishedError: (e: unknown) => e instanceof NoNetworkEstablishedError };
});
const mockGetKeys = jest.fn();
const mockGetSigs = jest.fn();
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "keysTasksEngine") return { getKeysToRelease: mockGetKeys };
	if (name === "signatureTasksEngine") return { getRequestedSignatures: mockGetSigs, getTaskSigningStatus: async () => null };
	return undefined;
});
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

async function renderScreen() {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Screen = require("../TasksScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<Screen />);
	});
	await flush();
	return tr;
}

describe("TasksScreen peer-unavailable reads (62-96)", () => {
	it("T-1: a cohort-unreachable load shows the notice (not 'no tasks'), no raw text; Try Again re-runs the load", async () => {
		mockGetKeys.mockRejectedValueOnce(peerError()).mockResolvedValue([]);
		mockGetSigs.mockResolvedValue([]);
		const tr = await renderScreen();
		expect(noticeCount(tr)).toBeGreaterThan(0);
		expect(allText(tr)).not.toContain("TidHighWater");
		expect(allText(tr)).not.toContain("noTasks");
		await pressRetry(tr);
		expect(noticeCount(tr)).toBe(0);
		expect(allText(tr)).toContain("noTasks");
	});

	it("T-2: a generic failure shows tasksLoadFailed, never the raw text", async () => {
		mockGetKeys.mockRejectedValue(new Error("secret-table blew up"));
		mockGetSigs.mockResolvedValue([]);
		const tr = await renderScreen();
		expect(allText(tr)).toContain("tasksLoadFailed");
		expect(allText(tr)).not.toContain("secret-table");
	});

	it("T-3: the no-network state is unchanged", async () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { NoNetworkEstablishedError } = require("../../../engines/engine-factory");
		mockGetKeys.mockRejectedValue(new NoNetworkEstablishedError("none"));
		mockGetSigs.mockResolvedValue([]);
		const tr = await renderScreen();
		// WR-R6-06 positive anchors: the load ran into the no-network rejection and the no-network
		// empty state rendered.
		expect(mockGetKeys).toHaveBeenCalled();
		expect(allText(tr)).toContain("noNetworkTitle");
		expect(allText(tr)).toContain("noNetwork");
		expect(console.error).not.toHaveBeenCalled();
		expect(noticeCount(tr)).toBe(0);
		expect(allText(tr)).not.toContain("tasksLoadFailed");
	});
});
