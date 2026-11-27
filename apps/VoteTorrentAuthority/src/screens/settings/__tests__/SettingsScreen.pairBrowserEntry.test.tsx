/**
 * SettingsScreen.pairBrowserEntry.test.tsx — the "Pair a browser" entry (it
 * replaced the dashboard sign-in code entry in the same position).
 *
 * Scaffold mirrored from `SettingsScreen.provisioningEntry.test.tsx` (itself
 * copied from Suite A's `ElectionDetailsScreen.navigation.test.tsx`): a real
 * component + a mocked `@react-navigation/native` module, pressing the REAL
 * screen's own onPress handler. The real navigator really resolving
 * `PairBrowser` is proven separately by
 * `src/navigation/__tests__/phase50Routes.test.tsx`; this suite complements
 * that, it does not duplicate it.
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

const ENTRY_TESTID = "settings-pair-browser-entry";

beforeEach(() => {
	jest.clearAllMocks();
});

describe("SettingsScreen — the Pair a browser entry", () => {
	it("renders exactly once with the dashboardPairingTitle key as its title", async () => {
		const tr = await renderScreen();
		expect(() => tr.root.findByProps({ testID: ENTRY_TESTID })).not.toThrow();
		const json = JSON.stringify(tr.toJSON());
		expect(json.split('"dashboardPairingTitle"').length - 1).toBeGreaterThanOrEqual(1);
		expect(json).not.toContain("SignInCode");
	});

	it("pressing it calls navigate exactly once with PairBrowser and no second argument", async () => {
		const tr = await renderScreen();
		await press(tr, ENTRY_TESTID);
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate.mock.calls[0]![0]).toBe("PairBrowser");
		// The route is typed `undefined` — passing params would be a contract drift.
		expect(mockNavigate.mock.calls[0]!.length).toBe(1);
	});

	// No scope gate, asserted as a decision: every officer may pair their own
	// browser, so gating it would hide the feature from exactly the officer who
	// needs it (mirrors the identical decision for the attestation-provisioning row).
	it("the screen source contains no officer-scope hook", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "SettingsScreen.tsx"), "utf8");
		const scopeHookName = ["useCurrent", "OfficerScopes"].join("");
		expect(source).not.toContain(scopeHookName);
	});

	it("is placed adjacent to the other device-level provisioning rows (source order)", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "SettingsScreen.tsx"), "utf8");
		const signingKeyIndex = source.indexOf("settings-signing-key-provisioning-entry");
		const entryIndex = source.indexOf(ENTRY_TESTID);
		const networkBoundaryIndex = source.indexOf("styles.networkTitle");
		expect(signingKeyIndex).toBeGreaterThanOrEqual(0);
		expect(entryIndex).toBeGreaterThan(signingKeyIndex);
		expect(networkBoundaryIndex).toBeGreaterThan(entryIndex);
	});
});
