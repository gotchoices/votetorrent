/**
 * SettingsScreen.provisioningEntry.test.tsx — the D-09 device-level
 * provisioning entry (Phase 47 plan 47-21).
 *
 * Scaffold copied from
 * `../../elections/__tests__/ElectionDetailsScreen.navigation.test.tsx`
 * (Suite A) — real component + a mocked `@react-navigation/native` module,
 * pressing the REAL screen's own onPress handler. The real navigator really
 * resolving `AttestationProvisioningStatus` is proven separately by
 * `src/navigation/__tests__/phase47Routes.test.tsx` (Task 1); this suite
 * complements that, it does not duplicate it.
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

const PROVISIONING_TESTID = "settings-attestation-provisioning-entry";

beforeEach(() => {
	jest.clearAllMocks();
});

describe("SettingsScreen — D-09 device-level provisioning entry (47-21)", () => {
	it("renders exactly once with the attestationProvisioningScreenTitle key as its title", async () => {
		const tr = await renderScreen();
		expect(() => tr.root.findByProps({ testID: PROVISIONING_TESTID })).not.toThrow();
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("attestationProvisioningScreenTitle");
	});

	it("pressing it calls navigate exactly once with AttestationProvisioningStatus and no second argument", async () => {
		const tr = await renderScreen();
		await press(tr, PROVISIONING_TESTID);
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate.mock.calls[0]![0]).toBe("AttestationProvisioningStatus");
		// The route is typed `undefined` — passing params would be a contract drift.
		expect(mockNavigate.mock.calls[0]!.length).toBe(1);
	});

	// D-09 placement proof: provisioning is a device/build concern, not a
	// per-network one, so it must sit after connectDevice and before the
	// {currentNetwork} boundary — never drift below it. currentNetwork is
	// null in this fixture (no network loaded), so it renders no text marker
	// — the robust proof is source-order, not render-order: moving the entry
	// changes these three markers' indices exactly as a render-order swap
	// would (Mutation lock D).
	it("is placed after connectDevice and before the network-scoped group (D-09)", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "SettingsScreen.tsx"), "utf8");
		const connectDeviceIndex = source.indexOf('title={t("connectDevice")}');
		const provisioningIndex = source.indexOf(PROVISIONING_TESTID);
		const networkBoundaryIndex = source.indexOf("styles.networkTitle");
		expect(connectDeviceIndex).toBeGreaterThanOrEqual(0);
		expect(provisioningIndex).toBeGreaterThan(connectDeviceIndex);
		expect(networkBoundaryIndex).toBeGreaterThan(provisioningIndex);
	});

	// No scope gate, asserted as a decision: 47-19's screen has no scope gate
	// by design, so its entry needs none, and 47-22 must not assert one.
	it("the screen source contains no officer-scope hook", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "SettingsScreen.tsx"), "utf8");
		const scopeHookName = ["useCurrent", "OfficerScopes"].join("");
		expect(source).not.toContain(scopeHookName);
	});
});
