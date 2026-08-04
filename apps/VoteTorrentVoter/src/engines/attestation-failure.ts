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

/** D-09 three-way failure UX class. */
export type AttestationFailureClass = 'terminal' | 'recoverable-action' | 'recoverable-transient'

/** Terminal-class native reject codes (45-02 native reject mapping / 45-05 wrapper contract). */
const TERMINAL_CODES = new Set(['NO_STRONGBOX_OR_TEE', 'DEVICE_INTEGRITY_FAILED', 'PROVISION_FAILED'])

/** Recoverable-action-class native reject codes — the voter can self-remediate and retry. */
const RECOVERABLE_ACTION_CODES = new Set(['NO_BIOMETRICS_ENROLLED'])

/**
 * Classify a rejection thrown by the attestation producer (`provisionDeviceKey()` /
 * `produce()`) into a D-09 UX class. Reads `(err as {code?: string}).code`; any unrecognized or
 * missing code classifies as `'recoverable-transient'` (never silently terminal).
 */
export function classifyAttestationFailure(err: unknown): AttestationFailureClass {
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
