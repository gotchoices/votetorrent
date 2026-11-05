/**
 * useKeyboardInset — the Voter app's answer to Android's forced edge-to-edge.
 *
 * The manifest asks for `windowSoftInputMode="adjustResize"`, but an app that targets SDK 35 is
 * forced edge-to-edge from Android 15 onwards, and in edge-to-edge the platform stops resizing
 * the window for the IME. The ScrollView viewport (and so its maximum scroll offset) therefore
 * never shrinks, stranding the lower register fields and the pinned Continue CTA behind the
 * keyboard at every scroll position.
 *
 * The invariant these tests pin is what the register screens then do with the reported height:
 * report it exactly, release it on dismiss, and follow it without latching.
 *
 * `Keyboard.addListener` is stubbed rather than driven through the real emitter — the RN jest
 * preset has no IME to raise events, and stubbing keeps the assertions on OUR contract (what we
 * do with a reported height) instead of on RN's emitter internals.
 */
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Keyboard, Platform, View} from 'react-native';
import {useKeyboardInset} from '../useKeyboardInset';

/**
 * The hook subscribes to the `Will` pair on iOS (so the padding animates in step with the
 * keyboard) and the `Did` pair on Android, which only emits those. Tests resolve the names off
 * `Platform.OS` rather than hard-coding one pair, so this suite asserts the same behaviour
 * whichever platform the jest preset reports.
 */
const SHOW_EVENT = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
const HIDE_EVENT = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

type KeyboardEventName = string;

/** Callbacks the hook registered, keyed by the event it asked for. */
let handlers: Partial<Record<KeyboardEventName, (event?: unknown) => void>>;
/** The `remove()` of each returned subscription, so unmount can be asserted. */
let removals: Partial<Record<KeyboardEventName, jest.Mock>>;

beforeEach(() => {
	handlers = {};
	removals = {};
	jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: KeyboardEventName, cb: any) => {
		handlers[event] = cb;
		removals[event] = jest.fn();
		return {remove: removals[event]};
	}) as any);
});

afterEach(() => {
	jest.restoreAllMocks();
});

/**
 * Probe that exposes the hook's value, and — mirroring how the register screens consume it —
 * the `safeArea + inset` bottom padding actually applied to the root View.
 */
const SAFE_AREA_BOTTOM = 12; // the screens' `insets.bottom + 12` with the test mock's 0 inset

/** Last value the hook returned, captured on render — `View` has no prop to publish it on. */
let lastInset = 0;

function Probe() {
	const value = useKeyboardInset();
	lastInset = value;
	return <View testID="probe" style={{paddingBottom: SAFE_AREA_BOTTOM + value}} />;
}

function renderProbe() {
	let tr!: renderer.ReactTestRenderer;
	act(() => {
		tr = renderer.create(<Probe />);
	});
	return tr;
}

function inset(_tr: renderer.ReactTestRenderer): number {
	return lastInset;
}

function paddingBottom(tr: renderer.ReactTestRenderer): number {
	return tr.root.findByProps({testID: 'probe'}).props.style.paddingBottom;
}

function showKeyboard(height?: number) {
	act(() => {
		handlers[SHOW_EVENT]?.(height === undefined ? undefined : {endCoordinates: {height}});
	});
}

function hideKeyboard() {
	act(() => {
		handlers[HIDE_EVENT]?.();
	});
}

describe('useKeyboardInset', () => {
	it('subscribes to the show/hide pair this platform actually emits', () => {
		renderProbe();
		expect(Object.keys(handlers).sort()).toEqual([HIDE_EVENT, SHOW_EVENT].sort());
	});

	it('reports no inset while no keyboard is showing', () => {
		const tr = renderProbe();
		expect(inset(tr)).toBe(0);
	});

	it('reports exactly the keyboard height once the keyboard opens', () => {
		const tr = renderProbe();
		showKeyboard(733);
		// Exactly the reported height: anything less leaves that much of the form
		// (and the pinned Continue CTA) unreachable behind the IME, which is the bug.
		expect(inset(tr)).toBe(733);
	});

	it('releases the inset when the keyboard is dismissed', () => {
		const tr = renderProbe();
		showKeyboard(733);
		hideKeyboard();
		expect(inset(tr)).toBe(0);
	});

	it('tracks a height change without needing the keyboard to close first', () => {
		// Switching to an IME of a different height (emoji/number pad, or a suggestion strip
		// appearing) re-fires `keyboardDidShow` with no intervening hide — the inset has to
		// follow, not latch. The register form's number-pad DOB field makes this a real path.
		const tr = renderProbe();
		showKeyboard(733);
		showKeyboard(921);
		expect(inset(tr)).toBe(921);
	});

	it('treats a height-less keyboard event as no keyboard rather than crashing', () => {
		const tr = renderProbe();
		showKeyboard();
		expect(inset(tr)).toBe(0);
	});

	it('unsubscribes on unmount so a later keyboard event cannot set state on a dead tree', () => {
		const tr = renderProbe();
		act(() => {
			tr.unmount();
		});
		expect(removals[SHOW_EVENT]).toHaveBeenCalled();
		expect(removals[HIDE_EVENT]).toHaveBeenCalled();
	});

	describe('as the register screens combine it with the safe-area inset', () => {
		it('keeps the safe-area padding while no keyboard is showing', () => {
			const tr = renderProbe();
			expect(paddingBottom(tr)).toBe(SAFE_AREA_BOTTOM);
		});

		it('ADDS the keyboard height to the safe-area inset once the keyboard opens', () => {
			// The reported height stops at the top of the NAVIGATION BAR, not the bottom of the
			// screen, so it does not subsume `insets.bottom`. Max-ing the two instead of adding
			// them falls short by the nav bar and leaves the Continue CTA clipped — measured at
			// exactly 64px of overlap on a Pixel 8 emulator (API 37) before this was corrected.
			const tr = renderProbe();
			showKeyboard(733);
			expect(paddingBottom(tr)).toBe(SAFE_AREA_BOTTOM + 733);
		});

		it('returns to the safe-area padding alone once the keyboard is dismissed', () => {
			const tr = renderProbe();
			showKeyboard(733);
			hideKeyboard();
			expect(paddingBottom(tr)).toBe(SAFE_AREA_BOTTOM);
		});
	});
});
