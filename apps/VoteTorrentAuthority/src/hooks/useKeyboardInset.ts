import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * Height, in dp, that the on-screen keyboard currently occupies at the bottom
 * of the window — 0 when it is dismissed.
 *
 * Why this exists rather than relying on `android:windowSoftInputMode`:
 * the manifest asks for `adjustResize`, but from Android 15 (API 35) onwards
 * an app that targets SDK 35 is forced edge-to-edge, and in edge-to-edge the
 * platform stops resizing the window for the IME — `adjustResize` becomes a
 * no-op. The window therefore stays full height, the ScrollView's viewport
 * (and so its maximum scroll offset) never shrinks, and every field plus the
 * pinned Footer that falls in the bottom third of the screen becomes
 * unreachable while typing. Reproduced on a Pixel 8 emulator (API 37) against
 * Add Network: six full-length swipes could not bring `Title`, `SIGN`,
 * `Advanced` or `CREATE` above the keyboard, because the list was already at
 * max offset.
 *
 * `Keyboard`'s events still report the real IME inset in edge-to-edge, so the
 * app applies the inset itself — see [[KeyboardAvoidingScreen]].
 *
 * SCOPE — why this is gated on the API level rather than applied everywhere:
 * the forced-edge-to-edge behaviour above starts at API 35. BELOW that, an
 * `adjustResize` window is still resized by the platform, so the app adding
 * the inset on top would subtract the keyboard's height TWICE: once by the
 * shrunken window, once by our padding. The visible result is a form squeezed
 * into the top of the screen with a dead gap above the IME, and a pinned
 * footer that jumps into the middle of the screen the moment a field is
 * focused. Reproduced on a Redmi 8 (Android 10 / API 29, 360x760dp) against
 * Add Network: focusing the relay field lifted CREATE to roughly mid-screen
 * and collapsed the form to a single visible row.
 *
 * So: pad only when the platform will NOT resize for us — iOS always (it never
 * resizes the window), Android only from API 35.
 */

/**
 * True when the platform still resizes the window for the IME, which means the
 * app must NOT add its own inset. Evaluated per render rather than once at
 * module scope purely so it stays testable without module isolation — the
 * value cannot actually change while the process is alive.
 */
function platformResizesForIme(): boolean {
	return Platform.OS === "android" && (Platform.Version as number) < 35;
}
export function useKeyboardInset(): number {
	const [inset, setInset] = useState(0);

	useEffect(() => {
		// Nothing to track when the platform resizes the window itself — subscribing
		// would only invite a double-applied inset.
		if (platformResizesForIme()) return;

		// iOS gets the `Will` pair so the padding animates in step with the
		// keyboard; Android only ever emits the `Did` pair.
		const showEvent = Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow";
		const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

		const showSub = Keyboard.addListener(showEvent as "keyboardDidShow", event => {
			setInset(event?.endCoordinates?.height ?? 0);
		});
		const hideSub = Keyboard.addListener(hideEvent as "keyboardDidHide", () => {
			setInset(0);
		});

		return () => {
			showSub.remove();
			hideSub.remove();
		};
	}, []);

	return platformResizesForIme() ? 0 : inset;
}
