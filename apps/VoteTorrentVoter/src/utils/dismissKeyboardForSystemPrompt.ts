import { Keyboard } from 'react-native'

/**
 * Upper bound on waiting for the IME to report hidden. The prompt must never hang on a missed
 * `keyboardDidHide` event, so after this it proceeds anyway.
 */
export const KEYBOARD_HIDE_WAIT_MS = 500

/**
 * Close the soft keyboard BEFORE a native system prompt (BiometricPrompt / device-credential
 * sheet) is started, and wait until it is gone.
 *
 * Device finding (Redmi 8, MIUI 12.5, Android 10): starting a BiometricPrompt while the IME is
 * open leaves the system fingerprint dialog undrawn: it holds window focus but nothing is
 * visible, and the officer waits ~10 min until the HAL cancels (errorCode 5 CANCELED). The same
 * call with the keyboard closed shows the dialog immediately. A typical trigger is typing into a
 * field (a rejection reason, a registration code) and tapping the confirm button with the IME
 * still up.
 *
 * Always calls `Keyboard.dismiss()` (a no-op when nothing is focused). When the keyboard is
 * reported visible, also resolves only after `keyboardDidHide` or `KEYBOARD_HIDE_WAIT_MS`,
 * whichever comes first.
 */
export async function dismissKeyboardForSystemPrompt(): Promise<void> {
	let visible = false
	try {
		visible = typeof Keyboard.isVisible === 'function' ? Keyboard.isVisible() : false
	} catch {
		visible = false
	}
	if (!visible) {
		Keyboard.dismiss()
		return
	}
	await new Promise<void>(resolve => {
		let settled = false
		let timer: ReturnType<typeof setTimeout> | undefined
		const subscription = Keyboard.addListener('keyboardDidHide', () => finish())
		function finish() {
			if (settled) return
			settled = true
			subscription.remove()
			if (timer !== undefined) clearTimeout(timer)
			resolve()
		}
		timer = setTimeout(finish, KEYBOARD_HIDE_WAIT_MS)
		Keyboard.dismiss()
	})
}
