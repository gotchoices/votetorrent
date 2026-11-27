/**
 * secure-surface.ts — typed JS wrapper over the Phase 63 review's screen and clipboard TurboModule
 * methods: `setSecureScreen` (CR-01, FLAG_SECURE) and `copySensitiveText` (WR-03, a clipboard copy
 * marked sensitive). Same lazy-native rule as secret-wrap.ts: the TurboModule is required inside each
 * call, never at module scope, so importing this file is safe under jest and on a binary that lacks
 * the methods.
 *
 * Both functions NEVER throw. A missing module or method is reported as such, so a caller can fall
 * back (the clipboard) or simply carry on (the secure flag is a best-effort hardening).
 */

import type { Spec as NativeAttestationSpec } from './specs/NativeAttestation'

function getNative(): NativeAttestationSpec | undefined {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, mirrors secret-wrap.ts.
		return require('./specs/NativeAttestation').default as NativeAttestationSpec
	} catch {
		return undefined
	}
}

/**
 * CR-01: Android sets (`true`) or clears (`false`) FLAG_SECURE on the current window. Resolves `true`
 * only when native reports the flag applied; `false` on iOS (no such flag), when the module or method
 * is missing, or when native rejects.
 */
export async function setSecureScreen(enabled: boolean): Promise<boolean> {
	const native = getNative()
	if (native === undefined || typeof native.setSecureScreen !== 'function') return false
	try {
		const raw = (await native.setSecureScreen(enabled)) as { applied?: unknown } | null
		return raw?.applied === true
	} catch {
		return false
	}
}

export type SensitiveCopyResult = 'copied' | 'failed' | 'unsupported'

/**
 * WR-03: synchronous sensitive copy. `'unsupported'` means this binary has no native method (the
 * caller may fall back to a plain copy); `'failed'` means native tried and failed.
 */
export function copySensitiveText(text: string): SensitiveCopyResult {
	const native = getNative()
	if (native === undefined || typeof native.copySensitiveText !== 'function') return 'unsupported'
	try {
		const raw: unknown = native.copySensitiveText(text)
		return raw === true || raw === 1 ? 'copied' : 'failed'
	} catch {
		return 'failed'
	}
}
