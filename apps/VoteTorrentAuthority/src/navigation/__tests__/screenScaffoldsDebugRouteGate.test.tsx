/**
 * screenScaffoldsDebugRouteGate.test.tsx — gap closure for T-57-16-05
 * ("ungated ScreenScaffoldsDebug entry ships in release builds").
 *
 * `.planning/todos/completed/2026-09-08-ungated-screenscaffoldsdebug-entry-ships-in-release.md`
 * closed this threat with a one-shot manual release-bundle grep and left the
 * fix with zero automated coverage. This file guards halves 2 and 3 of the
 * applied fix in `navigation/index.tsx`:
 *
 *   1. The `ScreenScaffoldsDebugScreen` binding at module scope is a
 *      `__DEV__`-guarded `require()`, not a static import — in a release
 *      build the module must never be required at all.
 *   2. The `<Stack.Screen name="ScreenScaffoldsDebug">` registration is
 *      wrapped in `{__DEV__ && ScreenScaffoldsDebugScreen ? (…) : null}` —
 *      in a release build the route must not be reachable.
 *   3. A release-build render of the real `RootNavigator` must still mount
 *      cleanly (react-navigation's `Children.toArray` strips the `null`
 *      branch before its "can only contain 'Screen'" throw).
 *
 * `__DEV__` is read at MODULE SCOPE in navigation/index.tsx
 * (`const X = __DEV__ ? require(...) : undefined`), so a static top-of-file
 * `import` here would latch whichever value Jest's RN preset happened to
 * have set (`true`, per react-native/jest/setup.js) and make every
 * "release build" assertion below silently inert. Every test that needs a
 * particular `__DEV__` value therefore calls `jest.resetModules()` and sets
 * `global.__DEV__` BEFORE re-`require()`-ing "../index", and `afterEach`
 * restores `__DEV__` to `true` so a stray `false` cannot poison a sibling
 * suite sharing this Jest worker.
 */

import React from "react";
import renderer from "react-test-renderer";

// Rendering the REAL RootNavigator eagerly loads every screen module in the
// app (see phase48Routes.test.tsx's sibling comment, measured there at up to
// 35.5s under full-suite cold-cache contention). This file additionally
// calls jest.resetModules() per test, re-paying that module-graph cost each
// time, so the generous timeout below is load-bearing, not decorative.
jest.setTimeout(60_000);

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

// navigation/index.tsx eagerly imports every screen module (including
// AuthorityDetailsScreen, which imports ../../providers/AppProvider, which
// imports react-native-splash-view) — a native TurboModule with no binary
// registered under this Jest RN environment. Mocked inert, matching
// __tests__/App.test.tsx's and phase48Routes.test.tsx's convention.
jest.mock("react-native-splash-view", () => ({ hideSplash: jest.fn() }));

jest.mock("../../providers/AppProvider", () => ({
	useApp: () => ({}),
	AppProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: null, syncState: "offline", connectedPeers: () => 0 }),
	CadreNodeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Tracks how many times the debug screen module is actually `require()`-d.
// This is the strongest proxy Jest can observe for "is this a static
// dependency of the release bundle" — Metro's own elimination of the guarded
// `require()` is a build-time property this file cannot exercise (the
// completed todo verified that half with a release-bundle grep instead);
// what IS Jest-observable, and what this factory proves, is that the
// require() call inside the `__DEV__ ? require(...) : undefined` ternary is
// never reached at runtime when `__DEV__` is false. Prefixed `mock` so
// babel-plugin-jest-hoist allows the factory (hoisted above this
// declaration) to close over it.
let mockScaffoldsRequireCount = 0;
jest.mock("../../screens/tasks/ScreenScaffoldsDebugScreen", () => {
	mockScaffoldsRequireCount++;
	return {
		__esModule: true,
		default: function MockScreenScaffoldsDebugScreen() {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const ReactLib = require("react");
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { Text } = require("react-native");
			return ReactLib.createElement(
				Text,
				{ testID: "mock-screen-scaffolds-debug-screen" },
				"mock-screen-scaffolds-debug-screen",
			);
		},
	};
});

// jest.resetModules() clears the WHOLE module registry, including 'react' —
// which would otherwise hand every freshly-required dependency (react-navigation,
// react-native-safe-area-context, the screen modules) a SECOND 'react' module
// instance with its own hook-dispatcher state, crashing every hook call with
// "Cannot read properties of null (reading 'useContext')" the instant the
// render mixes that copy with the one react-test-renderer (imported once,
// statically, above) already holds. This is the exact multi-copy-React trap
// CadreNodeProvider.test.tsx's D-14 config-fault suite already documents and
// fixes: capture the ACTUAL 'react' module once, before any reset, and pin
// every subsequent reset back to that same instance via `jest.doMock`.
const actualReact = jest.requireActual("react");

function resetModulesPinningReact() {
	jest.resetModules();
	jest.doMock("react", () => actualReact);
}

afterEach(() => {
	(global as any).__DEV__ = true;
	jest.dontMock("react");
});

describe("navigation/index.tsx — the module-scope require is really gated by __DEV__ (T-57-16-05)", () => {
	it("never requires the debug screen module when __DEV__ is false at load time", () => {
		mockScaffoldsRequireCount = 0;
		(global as any).__DEV__ = false;
		resetModulesPinningReact();
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		require("../index");
		expect(mockScaffoldsRequireCount).toBe(0);
	});

	it(
		"does require the debug screen module when __DEV__ is true at load time (positive control " +
			"proving the load-count assertion above is not vacuously green)",
		() => {
			mockScaffoldsRequireCount = 0;
			(global as any).__DEV__ = true;
			resetModulesPinningReact();
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			require("../index");
			expect(mockScaffoldsRequireCount).toBeGreaterThan(0);
		},
	);
});

async function renderRootNavigatorAt(initialState?: {
	index: number;
	routes: Array<{ name: string; params?: unknown }>;
}) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { NavigationContainer, createNavigationContainerRef } = require("@react-navigation/native");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { SafeAreaProvider } = require("react-native-safe-area-context");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { RootNavigator } = require("../index");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { lightTheme } = require("../../theme/themes");

	const navRef = createNavigationContainerRef();

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(
			// react-test-renderer never fires a real onLayout event, and
			// react-native-screens' native-stack view gates its content behind
			// SafeAreaProvider's measured frame — without `initialMetrics` the
			// whole Stack.Navigator subtree renders as `children: null` forever
			// (matches phase48Routes.test.tsx's identical setup).
			<SafeAreaProvider
				initialMetrics={{
					frame: { x: 0, y: 0, width: 320, height: 640 },
					insets: { top: 0, left: 0, right: 0, bottom: 0 },
				}}
			>
				<NavigationContainer ref={navRef} theme={lightTheme} initialState={initialState}>
					<RootNavigator />
				</NavigationContainer>
			</SafeAreaProvider>,
		);
	});
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
	return { tr, navRef };
}

describe("RootNavigator — release build never registers the ScreenScaffoldsDebug route (T-57-16-05)", () => {
	it(
		"mounts cleanly with no thrown error, and dispatching navigate(\"ScreenScaffoldsDebug\") is an " +
			"unhandled action that leaves the current route unchanged and never mounts the debug screen",
		async () => {
			mockScaffoldsRequireCount = 0;
			(global as any).__DEV__ = false;
			resetModulesPinningReact();

			// React Navigation's default unhandled-action handler logs via
			// console.error (dev-only warning, never throws) — spied so the run
			// stays quiet, and asserted on below as extra evidence the dispatch
			// really was rejected as unhandled rather than silently swallowed.
			const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
			try {
				const { tr, navRef } = await renderRootNavigatorAt();

				// Requirement 3: react-navigation's Children.toArray strips the
				// `null` branch before the navigator's "can only contain 'Screen'"
				// throw — proven by renderer.create() above completing without
				// throwing, not merely asserted.
				expect(tr.toJSON()).not.toBeNull();

				const routeNameBeforeNavigate = navRef.current?.getCurrentRoute()?.name;
				expect(routeNameBeforeNavigate).toBeTruthy();

				// Requirement 2: the route is genuinely absent from the
				// registration, not merely hidden from Settings — an unregistered
				// route name is an unhandled NAVIGATE action in React Navigation
				// and never changes the current route.
				await renderer.act(async () => {
					navRef.current?.navigate("ScreenScaffoldsDebug");
				});
				expect(navRef.current?.getCurrentRoute()?.name).toBe(routeNameBeforeNavigate);
				expect(() => tr.root.findByProps({ testID: "mock-screen-scaffolds-debug-screen" })).toThrow();
				expect(mockScaffoldsRequireCount).toBe(0);

				const unhandledMessages = errorSpy.mock.calls.map((args) => String(args[0]));
				expect(unhandledMessages.some((msg) => msg.includes("was not handled by any navigator"))).toBe(true);
			} finally {
				errorSpy.mockRestore();
			}
		},
	);
});

describe(
	"RootNavigator — dev build control: the same assertions actually can go red (T-57-16-05, anti-vacuity)",
	() => {
		it("registers the route in a dev build and renders the real debug screen when navigated to", async () => {
			mockScaffoldsRequireCount = 0;
			(global as any).__DEV__ = true;
			resetModulesPinningReact();

			const { tr, navRef } = await renderRootNavigatorAt({
				index: 0,
				routes: [{ name: "ScreenScaffoldsDebug" }],
			});

			expect(navRef.current?.getCurrentRoute()?.name).toBe("ScreenScaffoldsDebug");
			expect(() => tr.root.findByProps({ testID: "mock-screen-scaffolds-debug-screen" })).not.toThrow();
			expect(mockScaffoldsRequireCount).toBeGreaterThan(0);
		});
	},
);
