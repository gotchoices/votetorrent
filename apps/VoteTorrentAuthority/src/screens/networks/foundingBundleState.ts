/**
 * foundingBundleState.ts — import/export state unions and the exhaustive 62-16 result mapper
 * (D-35, D-36).
 *
 * `FoundingImportState` names the seven distinct bodies 62-UI-SPEC.md's Surface 2 import screen
 * renders (idle, picking, validating, invalidSignature, alreadyJoined, success, genericError).
 * `FoundingExportState` names the export card's six states (idle — "not mounted", owned by the
 * screen, not this card). `mapFoundingImportResult` is the ONE place 62-16's
 * `FoundingBundleImportResult` (see `62-16-SUMMARY.md`'s "Interfaces for downstream plans" /
 * `FOUNDING_FAILURE_CATEGORY`) is translated into a UI outcome:
 *   - `ok: true, outcome: 'replayed' | 'already-present'` -> `success` (carries `networkRef`)
 *   - `ok: false, category: 'already-joined'` -> `alreadyJoined` (carries `networkRef`)
 *   - `ok: false, category: 'invalid-bundle'` -> `invalidSignature`
 *   - `ok: false, category: 'error'` -> `genericError`
 * Every switch below ends in `assertNever`, so a future engine category addition fails
 * TYPECHECK here instead of silently falling through to an unhandled UI state.
 */

import type { FoundingBundleImportResult, NetworkReference } from '@votetorrent/vote-core'

export type FoundingImportState =
	| 'idle'
	| 'picking'
	| 'validating'
	| 'confirmFingerprint'
	| 'anchorRequired'
	| 'invalidSignature'
	| 'alreadyJoined'
	| 'success'
	| 'genericError'

export type FoundingExportState = 'idle' | 'confirming' | 'generating' | 'sharing' | 'ready' | 'error'

export type FoundingImportOutcome =
	| { readonly state: 'success'; readonly networkRef: NetworkReference; readonly fingerprint: string }
	| { readonly state: 'fingerprintMismatch' }
	| { readonly state: 'anchorRequired' }
	| { readonly state: 'alreadyJoined'; readonly networkRef: NetworkReference }
	| { readonly state: 'invalidSignature' }
	| { readonly state: 'genericError' }

function assertNever(value: never): never {
	throw new Error(`foundingBundleState: unreachable branch reached with ${JSON.stringify(value)}`)
}

export function mapFoundingImportResult(result: FoundingBundleImportResult): FoundingImportOutcome {
	if (result.ok) {
		switch (result.outcome) {
			case 'replayed':
			case 'already-present':
				return { state: 'success', networkRef: result.networkRef, fingerprint: result.fingerprint }
			default:
				return assertNever(result.outcome)
		}
	}

	// The typed-fingerprint outcomes come first, by reason: both are 'invalid-bundle' by category,
	// but they have their own copy and the mismatch stays on the confirm step.
	if (result.reason === 'anchor-mismatch') {
		return { state: 'fingerprintMismatch' }
	}
	if (result.reason === 'anchor-required') {
		return { state: 'anchorRequired' }
	}

	// A plain `switch` on `result.category` here defeats TypeScript's discriminated-union
	// narrowing: the second `FoundingBundleImportResult` member's `category` is itself the
	// 2-literal union `FoundingBundleFailureCategory` ('invalid-bundle' | 'error'), and a
	// multi-case switch cannot split that single member across its two case labels for
	// exhaustiveness purposes — the `default` branch's `assertNever(result.category)` then
	// fails to typecheck because TS narrows `result` to `never` before it, not because the
	// logic is wrong (confirmed in isolation against the installed TS version). A sequential
	// if-chain narrows correctly and keeps the exhaustiveness proof.
	if (result.category === 'already-joined') {
		return { state: 'alreadyJoined', networkRef: result.networkRef }
	}
	if (result.category === 'invalid-bundle') {
		return { state: 'invalidSignature' }
	}
	if (result.category === 'error') {
		return { state: 'genericError' }
	}
	return assertNever(result.category)
}

/**
 * Enables the Join button only: lowercase, strip spaces and dashes, exactly 16 hex characters.
 * The app never compares the value with anything; the engine does (the app never holds the
 * expected fingerprint, so it cannot decide a match).
 */
export function isCompleteFingerprintInput(text: string): boolean {
	return /^[0-9a-f]{16}$/.test(text.toLowerCase().replace(/[\s-]+/g, ''))
}
