/**
 * useKeyboardInset — the inset must be applied ONLY when the platform will not
 * resize the window for the IME itself.
 *
 * Android's forced edge-to-edge (API 35+) makes `adjustResize` a no-op, so the
 * app pads by the keyboard height itself. Below API 35 the platform still
 * resizes the window, and padding on top of that subtracts the keyboard height
 * TWICE — the form collapses to the top of the screen and the pinned footer
 * jumps to mid-screen. Found on a Redmi 8 (Android 10 / API 29) against the
 * Add Network form.
 *
 * `Platform.OS`/`Version` are redefined per case and restored afterwards; the
 * hook reads them per render, so no module isolation is needed.
 */
import React from "react";
import renderer, { act } from "react-test-renderer";
import { Keyboard, Platform, View } from "react-native";
import { useKeyboardInset } from "../useKeyboardInset";

type Handler = (event?: unknown) => void;

/** Renders a probe with `Platform` pinned to the given OS/version, returns the hook's values. */
function runWithPlatform(os: string, version: number | string) {
	const handlers: Record<string, Handler> = {};
	const addListener = jest
		.spyOn(Keyboard, "addListener")
		.mockImplementation(((event: string, cb: Handler) => {
			handlers[event] = cb;
			return { remove: jest.fn() };
		}) as never);

	// `Platform.OS`/`Version` are plain data properties in the RN jest preset, so they are
	// redefined rather than spied, and restored in `finally`.
	const originalOS = Platform.OS;
	const originalVersion = Platform.Version;
	Object.defineProperty(Platform, "OS", { value: os, configurable: true });
	Object.defineProperty(Platform, "Version", { value: version, configurable: true });

	let observed = -1;
	try {
		function Probe() {
			observed = useKeyboardInset();
			return <View />;
		}

		act(() => {
			renderer.create(<Probe />);
		});

		const showEvent = os === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow";
		act(() => {
			handlers[showEvent]?.({ endCoordinates: { height: 300 } });
		});
	} finally {
		addListener.mockRestore();
		Object.defineProperty(Platform, "OS", { value: originalOS, configurable: true });
		Object.defineProperty(Platform, "Version", { value: originalVersion, configurable: true });
	}

	return { inset: observed, subscribed: Object.keys(handlers).length > 0 };
}

describe("useKeyboardInset — platform gating", () => {
	it("reports 0 on Android below API 35, where the platform already resized the window", () => {
		// The regression: returning 300 here double-pads against an adjustResize window.
		expect(runWithPlatform("android", 29).inset).toBe(0);
	});

	it("does not even subscribe on Android below API 35", () => {
		expect(runWithPlatform("android", 29).subscribed).toBe(false);
	});

	it("reports the keyboard height on Android from API 35, where adjustResize is a no-op", () => {
		expect(runWithPlatform("android", 35).inset).toBe(300);
	});

	it("reports the keyboard height on iOS, which never resizes the window", () => {
		expect(runWithPlatform("ios", "17.0").inset).toBe(300);
	});
});
