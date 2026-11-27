/**
 * SettingsScreen.acceptInvitationEntry.test.tsx - the release-reachable Accept an Invitation row
 * (UAT 62 test 10). Rendered with __DEV__ false so a dev-only row cannot satisfy it.
 */

import React from "react";
import renderer from "react-test-renderer";
import fs from "fs";
import path from "path";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
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
		},
	}),
	useNavigation: () => ({
		navigate: mockNavigate,
		goBack: mockGoBack,
		setOptions: mockSetOptions,
	}),
	// Deferred via a real useEffect (not called synchronously during render),
	// matching the Suite A scaffold's comment: calling cb() unconditionally
	// during render can cause an infinite re-render loop for screens whose
	// focus callback sets state on every invocation.
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			cb();
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false, setShowHelpIcons: jest.fn() }),
}));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: async () => null }),
}));
// Settings renders the owner-trust notice, which reads the cadre-node context; no ownerTrust means "ok", so nothing renders.
jest.mock("../../../providers/CadreNodeProvider", () => ({ useCadreNode: () => ({ node: null }) }));

jest.mock("../../../engines/engine-factory", () => ({
	// Keeps the no-network path silent per that file's own comment — this
	// screen must be reachable before any network exists.
	isNoNetworkEstablishedError: () => true,
}));

// SettingsScreen imports the real i18n singleton directly (`import i18n from
// "../../i18n"`) for language state (i18n.language, i18n.changeLanguage,
// i18n.on/off) — a different import path than the react-i18next
// useTranslation hook mocked above. Not in 47-21's enumerated mock set;
// added here because the real singleton's `.on('languageChanged', ...)`
// listener registration is harmless but its `initReactI18next` plugin chain
// pulls in `react-native-localize` init timing that is unnecessary to
// exercise for this suite. Mocked to the minimal surface this screen reads.
jest.mock("../../../i18n", () => ({
	__esModule: true,
	default: {
		language: "en",
		changeLanguage: jest.fn(async () => {}),
		on: jest.fn(),
		off: jest.fn(),
	},
}));

/** Same helper as Suite A — see ElectionDetailsScreen.navigation.test.tsx for the "why" comment. */
async function press(tr: renderer.ReactTestRenderer, testID: string): Promise<void> {
	const wrapper = tr.root.findByProps({ testID });
	const candidates = wrapper.findAll(
		(node) => typeof node.props.onPressIn === "function" || typeof node.props.onPress === "function",
	);
	expect(candidates.length).toBeGreaterThan(0);
	const target = candidates[0]!;
	await renderer.act(async () => {
		if (typeof target.props.onPressIn === "function") {
			target.props.onPressIn();
		} else {
			target.props.onPress();
		}
	});
	await renderer.act(async () => {
		await Promise.resolve();
	});
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const SettingsScreenModule = require("../SettingsScreen");
	const SettingsScreen = SettingsScreenModule.default;

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<SettingsScreen />);
	});
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
	return tr;
}

const ENTRY = "settings-accept-invitation-entry";

beforeEach(() => {
	jest.clearAllMocks();
});

describe("SettingsScreen - Accept an Invitation entry", () => {
	const g = globalThis as unknown as { __DEV__: boolean };
	let prevDev: boolean;
	beforeAll(() => {
		prevDev = g.__DEV__;
		g.__DEV__ = false;
	});
	afterAll(() => {
		g.__DEV__ = prevDev;
	});

	it("renders in a release-equivalent render with the invitationAcceptTitle key", async () => {
		const tr = await renderScreen();
		expect(() => tr.root.findByProps({ testID: ENTRY })).not.toThrow();
		expect(JSON.stringify(tr.toJSON())).toContain("invitationAcceptTitle");
	});

	it("pressing it navigates to AcceptInvitation with no params", async () => {
		const tr = await renderScreen();
		await press(tr, ENTRY);
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate.mock.calls[0]![0]).toBe("AcceptInvitation");
		expect(mockNavigate.mock.calls[0]!.length).toBe(1);
	});

	it("the row is outside any __DEV__ block and not scope-gated", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "SettingsScreen.tsx"), "utf8");
		const rowIndex = source.indexOf(ENTRY);
		const devIndex = source.indexOf("{__DEV__ &&");
		expect(rowIndex).toBeGreaterThanOrEqual(0);
		expect(rowIndex).toBeLessThan(devIndex);
		expect(source).not.toContain(["useCurrent", "OfficerScopes"].join(""));
	});
});
