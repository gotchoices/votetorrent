/**
 * SettingsScreen.debugSeedTasksDebugGate.test.tsx — D-27 (phase 62 plan 09,
 * T-62-09-03): `debugSeedPendingTasks` stays a `__DEV__`-only aid.
 *
 * The dev gate around the "Seed Tasks" button already exists
 * (`SettingsScreen.tsx`'s `{__DEV__ && (<>…</>)}` fragment — see
 * `62-RESEARCH.md` Finding 5f). This is a REGRESSION GUARD, not new gating
 * logic: it does not edit `SettingsScreen.tsx`. Five checks:
 *   1. behavioral — not mounted at `__DEV__ = false`.
 *   2. behavioral positive control — mounted exactly once at `__DEV__ = true`,
 *      and its `onPress` is genuinely wired (not vacuous): with no current
 *      user it renders the `seedTasksNoUser` message.
 *   3. static — `debugSeedPendingTasks` appears in exactly one non-test
 *      source file across both apps: this screen.
 *   4. static — `IElectionsEngine` never declares `debugSeedPendingTasks`
 *      (calling it requires a concrete-class cast, so it can never become
 *      part of the public engine contract).
 *   5. static — the `onPress` wiring sits textually AFTER the `__DEV__` gate
 *      opens, and `handleDebugSeedTasks` is wired to exactly one JSX
 *      `onPress`.
 *
 * Two negative controls were run once (and reverted) to prove checks 1 and 3
 * are not vacuous — see the SUMMARY for both results.
 *
 * Preamble copied verbatim from
 * `SettingsScreen.screenScaffoldsDebugGate.test.tsx` (itself copied from
 * `SettingsScreen.scrollContainer.test.tsx`) — same screen, same
 * native/provider surface to stub out.
 */

import * as fs from "fs";
import * as path from "path";
import React from "react";
import renderer, { act } from "react-test-renderer";
import { ThemedText } from "../../../components/ThemedText";

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

// No currentUser is ever set: getEngine always resolves null, so the
// screen's own user-loading effects never populate `currentUser` — exactly
// the "no device user" precondition test (2) needs, with no extra stubbing.
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
 * `CustomButton` receives `title` straight from `t("debugSeedTasksTitle")`;
 * the mocked `t` above is the identity function, so a mounted button always
 * carries `title === "debugSeedTasksTitle"` verbatim. Finding the composite
 * `CustomButton` element by that exact prop (plus a genuine `onPress`
 * function) fails to match an unrelated button and fails to match nothing
 * at all if the button was never mounted.
 */
function findSeedTasksButton(tr: renderer.ReactTestRenderer) {
	return tr.root.findAll(
		(node) => node.props && node.props.title === "debugSeedTasksTitle" && typeof node.props.onPress === "function",
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

describe("SettingsScreen — debugSeedPendingTasks stays a __DEV__-only aid (D-27, T-62-09-03)", () => {
	it("1. does not mount the Seed Tasks button in a release build (__DEV__ = false)", async () => {
		(global as any).__DEV__ = false;
		const tr = await renderScreen();
		expect(findSeedTasksButton(tr)).toHaveLength(0);
	});

	it(
		"2. mounts exactly one Seed Tasks button in a dev build, and pressing it with no current " +
			"user renders seedTasksNoUser (positive control proving the handler is wired, not vacuous)",
		async () => {
			(global as any).__DEV__ = true;
			const tr = await renderScreen();
			const matches = findSeedTasksButton(tr);
			expect(matches).toHaveLength(1);

			await act(async () => {
				matches[0]!.props.onPress();
			});

			const texts = tr.root
				.findAllByType(ThemedText)
				.map((node) => ([] as unknown[]).concat(node.props.children as unknown).join(""));
			expect(texts).toContain("seedTasksNoUser");
		},
	);

	describe("static scans", () => {
		const REPO_ROOT = path.join(__dirname, "../../../../../../");
		const SCREEN_RELATIVE_PATH = "apps/VoteTorrentAuthority/src/screens/settings/SettingsScreen.tsx";

		/** Recursively collect non-test .ts/.tsx files under `dirAbs` (excludes any __tests__ dir and any test/spec file). */
		function listSourceFiles(dirAbs: string): string[] {
			const out: string[] = [];
			for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
				if (entry.name === "__tests__" || entry.name === "node_modules") continue;
				const full = path.join(dirAbs, entry.name);
				if (entry.isDirectory()) {
					out.push(...listSourceFiles(full));
					continue;
				}
				if (!/\.(ts|tsx)$/.test(entry.name)) continue;
				if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;
				out.push(full);
			}
			return out;
		}

		/** Non-test source files (relative, POSIX-separated, repo-root-relative) under both apps whose text contains `token`. */
		function findTokenFiles(token: string): string[] {
			const roots = [
				path.join(REPO_ROOT, "apps/VoteTorrentAuthority/src"),
				path.join(REPO_ROOT, "apps/VoteTorrentVoter/src"),
			];
			const matches: string[] = [];
			for (const root of roots) {
				for (const file of listSourceFiles(root)) {
					const text = fs.readFileSync(file, "utf8");
					if (text.includes(token)) {
						matches.push(path.relative(REPO_ROOT, file).split(path.sep).join("/"));
					}
				}
			}
			return matches;
		}

		it("3. SettingsScreen.tsx is the ONLY non-test call site of debugSeedPendingTasks in either app", () => {
			expect(findTokenFiles("debugSeedPendingTasks")).toEqual([SCREEN_RELATIVE_PATH]);
		});

		it("4. IElectionsEngine does not declare debugSeedPendingTasks — it stays a concrete-class-only aid", () => {
			const typesText = fs.readFileSync(
				path.join(REPO_ROOT, "packages/vote-core/src/elections/types.ts"),
				"utf8",
			);
			expect(typesText).not.toContain("debugSeedPendingTasks");
		});

		it("5. the onPress wiring sits after the __DEV__ gate opens, and handleDebugSeedTasks is wired to exactly one JSX onPress", () => {
			const screenText = fs.readFileSync(path.join(REPO_ROOT, SCREEN_RELATIVE_PATH), "utf8");
			const devGateIndex = screenText.indexOf("{__DEV__ && (");
			const onPressIndex = screenText.indexOf("onPress={handleDebugSeedTasks}");
			expect(devGateIndex).toBeGreaterThan(-1);
			expect(onPressIndex).toBeGreaterThan(-1);
			expect(onPressIndex).toBeGreaterThan(devGateIndex);

			const onPressOccurrences = screenText.split("onPress={handleDebugSeedTasks}").length - 1;
			expect(onPressOccurrences).toBe(1);
		});
	});
});
