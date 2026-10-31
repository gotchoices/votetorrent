/**
 * sign-cancel.ts — typed JS wrapper over the TurboModule's `cancelPendingSign` (D-110).
 *
 * Why: UAT 65 Run 3 showed a biometric sign prompt left unanswered blocks every later native sign
 * (androidx.biometric swallows the second prompt; iOS has no timeout). The app needs one way to
 * dismiss the pending sign. Same lazy-native rule as secure-surface.ts: the TurboModule is required
 * inside the call, never at module scope, so importing this file is safe under jest and on a binary
 * that lacks the method.
 *
 * `cancelPendingSign` NEVER throws.
 */

import type { Spec as NativeAttestationSpec } from './specs/NativeAttestation'

/**
 * JS backstop above the 2 s native cap: a native call that never settles must not hold the consent
 * queue, which awaits the cancel before moving on.
 */
export const SIGN_CANCEL_JS_CAP_MS = 3000

function getNative(): NativeAttestationSpec | undefined {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, mirrors secure-surface.ts.
		return require('./specs/NativeAttestation').default as NativeAttestationSpec
	} catch {
		return undefined
	}
}

/**
 * Resolves `true` only when native reports a pending device-key or recovery-key sign existed and
 * has settled; `false` for nothing pending, a missing module or method, a native reject, a
 * malformed result, or a native call that does not settle within `SIGN_CANCEL_JS_CAP_MS`.
 */
export async function cancelPendingSign(): Promise<boolean> {
	const native = getNative()
	if (native === undefined || typeof native.cancelPendingSign !== 'function') return false
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const capped = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), SIGN_CANCEL_JS_CAP_MS)
		})
		const raw = (await Promise.race([native.cancelPendingSign(), capped])) as { canceled?: unknown } | null | false
		return raw !== false && raw?.canceled === true
	} catch {
		return false
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}
