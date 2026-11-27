/**
 * attestation-failure.ts — D-09 three-way failure classifier for the device-side attestation
 * ceremony (`DeviceAttestationScreen`'s pre-`register()` capability probe and
 * `ConfirmationScreen`'s challenge/produce round-trip, Phase 45-06).
 *
 * The native producer (45-01/45-02/45-05) rejects with a stable `code` string. This module maps
 * that code to one of three UX classes so the screens never have to branch on raw codes:
 *
 *   - `'terminal'` — the device fundamentally cannot vote (no StrongBox/TEE, failed integrity,
 *     failed provisioning). No retry; the voter is stopped.
 *   - `'recoverable-action'` — the voter can fix this themselves (enroll biometrics) and retry.
 *   - `'recoverable-transient'` — a retry alone might succeed (network hiccup, lockout timeout,
 *     an unrecognized/future code). This is also the safe DEFAULT for any unknown code — a
 *     mystery error must never permanently wall a voter.
 *   - `'no-election'` — there is no election on this phone to register for (a
 *     `NoElectionConfiguredError`, thrown before any device step). Retry is not offered.
 *   - `'intake-unavailable'` — the device is fine, but the vote-engine intake refused to hand the
 *     request to the authority (an `IntakeError`, e.g. `no-recipients` when the authority has no
 *     officer able to receive it yet). Blaming the device here misleads the voter; the copy
 *     instead says the authority can't take the registration right now. Retry stays available.
 *   - `'identity-lost'` — the voter identity on this phone can no longer be unwrapped, PERMANENTLY
 *     (a `DeviceIdentityKeyUnavailableError` with reason `no-wrap-key` / `tag-mismatch` /
 *     `key-mismatch`). Retrying can never succeed; the screens render the identity recovery view
 *     (an explicit, confirmed "create a new identity"). Transient identity reasons stay
 *     `'recoverable-transient'`. Not subject to the `__DEV__` terminal downgrade.
 *
 * Release-only terminal invariant (D-09/D-07): a terminal-class code is downgraded to
 * `'recoverable-transient'` whenever `__DEV__` is true, so the emulator (which has no real
 * StrongBox/TEE) is never walled by this classifier. This downgrade is UX-ONLY — it does NOT
 * weaken the real fail-closed enforcement, which lives entirely in
 * `resolveAttestationProducer()`'s release branch (always returns the real producer, never the
 * stub, per CR-03) and in the native build never taking the D-07 dev-stub rung in a release
 * artifact. `__DEV__` here can only ever make the UX *more* permissive in a debug build; it
 * cannot be reached in release.
 */

import {isReplaceableIdentityError} from './identity-errors'

/** D-09 three-way failure UX class. */
export type AttestationFailureClass =
	| 'terminal'
	| 'recoverable-action'
	| 'recoverable-transient'
	| 'intake-unavailable'
	| 'no-election'
	/** WR-02: the device identity is permanently unrecoverable — offer the recovery view, never a retry. */
	| 'identity-lost'

/** Terminal-class native reject codes (45-02 native reject mapping / 45-05 wrapper contract). */
const TERMINAL_CODES = new Set(['NO_STRONGBOX_OR_TEE', 'DEVICE_INTEGRITY_FAILED', 'PROVISION_FAILED'])

/** Recoverable-action-class native reject codes — the voter can self-remediate and retry. */
const RECOVERABLE_ACTION_CODES = new Set(['NO_BIOMETRICS_ENROLLED'])

/**
 * Classify a rejection thrown by the attestation producer (`provisionDeviceKey()` /
 * `produce()`) into a D-09 UX class. Reads `(err as {code?: string}).code`; any unrecognized or
 * missing code classifies as `'recoverable-transient'` (never silently terminal). A vote-engine
 * `IntakeError` (matched by `name`, since its kebab-case codes are not native reject codes)
 * classifies as `'intake-unavailable'`.
 */
export function classifyAttestationFailure(err: unknown): AttestationFailureClass {
	// WR-02: a permanently lost identity (matched by name + one of the three permanent reasons,
	// never by message) can never succeed on retry — in release as in __DEV__.
	if (isReplaceableIdentityError(err)) {
		return 'identity-lost'
	}
	// No election on this phone (named error thrown by ConfirmationScreen before any ceremony
	// step): retrying cannot help and the device is not at fault.
	if ((err as {name?: unknown} | null | undefined)?.name === 'NoElectionConfiguredError') {
		return 'no-election'
	}
	if ((err as {name?: unknown} | null | undefined)?.name === 'IntakeError') {
		return 'intake-unavailable'
	}

	const code = (err as {code?: string} | null | undefined)?.code

	if (code !== undefined && TERMINAL_CODES.has(code)) {
		// D-09: never surface a terminal wall in __DEV__ — the emulator has no real
		// StrongBox/TEE, so a would-be-terminal code is downgraded to a retry.
		if (__DEV__) {
			return 'recoverable-transient'
		}
		return 'terminal'
	}

	if (code !== undefined && RECOVERABLE_ACTION_CODES.has(code)) {
		return 'recoverable-action'
	}

	// LOCKOUT, PLAY_INTEGRITY_ERROR, PLAY_INTEGRITY_NETWORK, and any unknown/missing code.
	return 'recoverable-transient'
}

/**
 * 63-18 fix: reject codes of the READ-ONLY `getCurrentDeviceKey()` lookup. They are NOT ceremony
 * failures, so `classifyAttestationFailure` deliberately leaves them as `'recoverable-transient'`;
 * lookup callers branch on these predicates instead.
 *   - `DEVICE_KEY_ABSENT`: no key under the alias yet (a fresh install) — nothing was created.
 *   - `DEVICE_KEY_INVALIDATED`: the key is permanently invalidated — surfaced, never deleted.
 */
export const DEVICE_KEY_ABSENT_CODE = 'DEVICE_KEY_ABSENT'
export const DEVICE_KEY_INVALIDATED_CODE = 'DEVICE_KEY_INVALIDATED'

export function isDeviceKeyAbsent(err: unknown): boolean {
	return (err as {code?: unknown} | null | undefined)?.code === DEVICE_KEY_ABSENT_CODE
}

export function isDeviceKeyInvalidated(err: unknown): boolean {
	return (err as {code?: unknown} | null | undefined)?.code === DEVICE_KEY_INVALIDATED_CODE
}
