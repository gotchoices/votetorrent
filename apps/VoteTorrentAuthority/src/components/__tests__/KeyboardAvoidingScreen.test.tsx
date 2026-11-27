/**
 * KeyboardAvoidingScreen — the app's answer to Android's forced edge-to-edge.
 *
 * The manifest asks for `windowSoftInputMode="adjustResize"`, but an app that
 * targets SDK 35 is forced edge-to-edge from Android 15 onwards, and in
 * edge-to-edge the platform stops resizing the window for the IME. The
 * ScrollView viewport (and so its maximum scroll offset) therefore never
 * shrinks: reproduced on a Pixel 8 emulator (API 37) against Add Network,
 * where six full-length swipes could not bring the last three fields or the
 * CREATE footer above the keyboard, because the list was already at max
 * offset.
 *
 * The invariant these tests pin is the one that fixes that: the screen shell
 * pads its own bottom by exactly the keyboard's height, so the flex children
 * above it end at the top of the keyboard rather than behind it.
 *
 * `Keyboard.addListener` is stubbed rather than driven through the real
 * emitter — the RN jest preset has no IME to raise events, and stubbing keeps
 * the assertions on OUR contract (what we do with a reported height) instead
 * of on RN's emitter internals.
 */

import React from "react";
import renderer, { act } from "react-test-renderer";
import { Keyboard, Platform, View } from "react-native";
import { KeyboardAvoidingScreen } from "../KeyboardAvoidingScreen";

/**
 * The hook subscribes to the `Will` pair on iOS (so the padding animates in
 * step with the keyboard) and the `Did` pair on Android, which only emits
 * those. Tests resolve the names off `Platform.OS` rather than hard-coding
 * one pair, so this suite asserts the same behaviour whichever platform the
 * jest preset reports.
 */
const SHOW_EVENT = Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow";
const HIDE_EVENT = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

type KeyboardEventName = string;

/** Callbacks the component registered, keyed by the event it asked for. */
let handlers: Partial<Record<KeyboardEventName, (event?: unknown) => void>>;
/** The `remove()` of each returned subscription, so unmount can be asserted. */
let removals: Partial<Record<KeyboardEventName, jest.Mock>>;

beforeEach(() => {
	handlers = {};
	removals = {};
	jest.spyOn(Keyboard, "addListener").mockImplementation(((event: KeyboardEventName, cb: any) => {
		handlers[event] = cb;
		removals[event] = jest.fn();
		return { remove: removals[event] };
	}) as any);
});

afterEach(() => {
	jest.restoreAllMocks();
});

/** Flatten the RN style prop (array | object) down to one resolved object. */
function flatten(style: any): Record<string, unknown> {
	if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
	return style ?? {};
}

function renderShell() {
	let tr!: renderer.ReactTestRenderer;
	act(() => {
		tr = renderer.create(
			<KeyboardAvoidingScreen>
				<View testID="child" />
			</KeyboardAvoidingScreen>,
		);
	});
	return tr;
}

/** The shell's own outer View — the `testID` child is nested inside it. */
function shellStyle(tr: renderer.ReactTestRenderer) {
	return flatten(tr.root.findAllByType(View)[0].props.style);
}

function showKeyboard(height?: number) {
	act(() => {
		handlers[SHOW_EVENT]?.(height === undefined ? undefined : { endCoordinates: { height } });
	});
}

function hideKeyboard() {
	act(() => {
		handlers[HIDE_EVENT]?.();
	});
}

describe("KeyboardAvoidingScreen", () => {
	it("forwards an optional testID to its shell View", () => {
		let tr!: renderer.ReactTestRenderer;
		act(() => {
			tr = renderer.create(
				<KeyboardAvoidingScreen testID="shell-under-test">
					<View testID="child" />
				</KeyboardAvoidingScreen>,
			);
		});
		expect(tr.root.findAllByType(View)[0].props.testID).toBe("shell-under-test");
	});

	it("subscribes to the show/hide pair this platform actually emits", () => {
		renderShell();
		expect(Object.keys(handlers).sort()).toEqual([HIDE_EVENT, SHOW_EVENT].sort());
	});

	it("adds no bottom padding while no keyboard is showing", () => {
		const tr = renderShell();
		expect(shellStyle(tr).paddingBottom).toBe(0);
		expect(shellStyle(tr).flex).toBe(1);
	});

	it("pads its bottom by exactly the keyboard height once the keyboard opens", () => {
		const tr = renderShell();
		showKeyboard(733);
		// Exactly the reported height: anything less leaves that much of the form
		// (and the pinned footer) unreachable behind the IME, which is the bug.
		expect(shellStyle(tr).paddingBottom).toBe(733);
	});

	it("releases the padding when the keyboard is dismissed", () => {
		const tr = renderShell();
		showKeyboard(733);
		hideKeyboard();
		expect(shellStyle(tr).paddingBottom).toBe(0);
	});

	it("tracks a height change without needing the keyboard to close first", () => {
		// Switching to an IME of a different height (emoji/number pad, or a
		// suggestion strip appearing) re-fires `keyboardDidShow` with no
		// intervening hide — the padding has to follow, not latch.
		const tr = renderShell();
		showKeyboard(733);
		showKeyboard(921);
		expect(shellStyle(tr).paddingBottom).toBe(921);
	});

	it("treats a height-less keyboard event as no keyboard rather than crashing", () => {
		const tr = renderShell();
		showKeyboard();
		expect(shellStyle(tr).paddingBottom).toBe(0);
	});

	it("unsubscribes on unmount so a later keyboard event cannot set state on a dead tree", () => {
		const tr = renderShell();
		act(() => {
			tr.unmount();
		});
		expect(removals[SHOW_EVENT]).toHaveBeenCalled();
		expect(removals[HIDE_EVENT]).toHaveBeenCalled();
	});
});
