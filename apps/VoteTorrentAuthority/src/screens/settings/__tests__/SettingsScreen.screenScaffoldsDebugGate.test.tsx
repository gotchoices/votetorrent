/**
 * SettingsScreen.screenScaffoldsDebugGate.test.tsx — gap closure for
 * T-57-16-05 ("ungated ScreenScaffoldsDebug entry ships in release builds").
 *
 * `.planning/todos/completed/2026-09-08-ungated-screenscaffoldsdebug-entry-ships-in-release.md`
 * closed this threat with a one-shot manual release-bundle grep and left the
 * fix with zero automated coverage. This asserts the first of the fix's
 * three halves behaviourally: the `ScreenScaffoldsDebug` `CustomButton` in
 * `SettingsScreen.tsx` renders ONLY inside the `{__DEV__ && (<>…</>)}`
 * fragment — not merely "the fragment text is present in source", which
 * would also pass for an imported-but-unreachable button (the exact class of
 * gap `SettingsScreen.scrollContainer.test.tsx`'s own header comment warns
 * about for this same file).
 *
 * Preamble copied verbatim from `SettingsScreen.scrollContainer.test.tsx` —
 * it is load-bearing (the same screen, the same native/provider surface to
 * stub out) and this file must not diverge from it by accident.
 */

import React from "react";
import renderer from "react-test-renderer";

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
	// Deferred via a real useEffect (not called synchronously during render) —
	// matches the SettingsScreen.provisioningEntry.test.tsx scaffold's own
	// comment: calling cb() unconditionally during render can infinite-loop a
	// screen whose focus callback sets state on every invocation.
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

// Same reasoning as SettingsScreen.provisioningEntry.test.tsx: the screen
// imports the real i18n singleton directly for language state, a different
// path than the react-i18next useTranslation hook mocked above.
jest.mock("../../../i18n", () => ({
	__esModule: true,
	default: {
		language: "en",
		changeLanguage: jest.fn(async () => {}),
		on: jest.fn(),
		off: jest.fn(),
	},
}));

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

/**
 * `CustomButton` receives `title` straight from `t("screenScaffoldsDebugTitle")`;
 * the mocked `t` above is the identity function, so a mounted button always
 * carries `title === "screenScaffoldsDebugTitle"` verbatim. Finding the
 * composite `CustomButton` element by that exact prop is a stronger proof
 * than a text-content grep of the rendered tree: it fails to match an
 * unrelated button whose *label* happens to contain the same substring, and
 * it fails to match nothing at all if the button was never mounted.
 */
function findScaffoldsButton(tr: renderer.ReactTestRenderer) {
	return tr.root.findAll(
		(node) => node.props && node.props.title === "screenScaffoldsDebugTitle" && typeof node.props.onPress === "function",
	);
}

beforeEach(() => {
	jest.clearAllMocks();
	(global as any).__DEV__ = true;
});

afterEach(() => {
	// SettingsScreen reads `__DEV__` at render time (not module scope), so
	// nothing here needs jest.resetModules() — but a stray `false` MUST NOT
	// leak into a sibling suite sharing this Jest worker.
	(global as any).__DEV__ = true;
});

describe("SettingsScreen — ScreenScaffoldsDebug entry is dev-gated (T-57-16-05)", () => {
	it("does not mount the ScreenScaffoldsDebug button in a release build (__DEV__ = false)", async () => {
		(global as any).__DEV__ = false;
		const tr = await renderScreen();
		expect(findScaffoldsButton(tr)).toHaveLength(0);
	});

	it(
		"mounts exactly one ScreenScaffoldsDebug button in a dev build, and pressing it navigates " +
			"to the ScreenScaffoldsDebug route (positive control proving the finder is not vacuous)",
		async () => {
			(global as any).__DEV__ = true;
			const tr = await renderScreen();
			const matches = findScaffoldsButton(tr);
			expect(matches).toHaveLength(1);

			matches[0].props.onPress();
			expect(mockNavigate).toHaveBeenCalledWith("ScreenScaffoldsDebug");
		},
	);
});
