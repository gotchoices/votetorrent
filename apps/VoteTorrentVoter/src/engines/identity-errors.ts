/**
 * identity-errors — dependency-free predicates over the device-identity error shapes.
 *
 * `device-user.ts` pulls in AsyncStorage, @noble and the native attestation module; the failure
 * classifier (`attestation-failure.ts`) and the provider only need to RECOGNISE its errors, so the
 * recognition lives here with no runtime imports. Errors are matched by `name` + `reason` (never by
 * message text, never by `instanceof`, which a duplicated module copy would defeat).
 */

/** The only reasons for which a record is PERMANENTLY unrecoverable (the wrap key is gone or the
 * ciphertext no longer matches). Transient reasons are never replaceable. */
export const REPLACEABLE_IDENTITY_REASONS = ['no-wrap-key', 'tag-mismatch', 'key-mismatch'] as const

export type ReplaceableIdentityReason = (typeof REPLACEABLE_IDENTITY_REASONS)[number]

/** True only for a `DeviceIdentityKeyUnavailableError` whose `reason` is one of the permanent
 * `REPLACEABLE_IDENTITY_REASONS`. */
export function isReplaceableIdentityError(err: unknown): boolean {
	if (typeof err !== 'object' || err === null) return false
	const e = err as { name?: unknown; reason?: unknown }
	return (
		e.name === 'DeviceIdentityKeyUnavailableError' &&
		typeof e.reason === 'string' &&
		(REPLACEABLE_IDENTITY_REASONS as readonly string[]).includes(e.reason)
	)
}

/** Why `replaceUnrecoverableDeviceIdentity` refused:
 * - `no-identity`: there is no record to replace;
 * - `readable`: the record unwraps fine (replacing it would be a silent identity swap);
 * - `not-permanent`: the unwrap failed for a transient reason;
 * - `not-wrapped`: the record is legacy plaintext or unparseable, never a locked wrapped record. */
export type IdentityNotReplaceableReason = 'no-identity' | 'readable' | 'not-permanent' | 'not-wrapped'

export const IDENTITY_NOT_REPLACEABLE_ERROR_NAME = 'IdentityNotReplaceableError'

export interface IdentityNotReplaceableError extends Error {
	readonly reason: IdentityNotReplaceableReason
}

/** Builds the typed refusal. The message is for logs only; callers branch on `reason`. */
export function identityNotReplaceableError(
	message: string,
	reason: IdentityNotReplaceableReason,
): IdentityNotReplaceableError {
	const err = new Error(message) as Error & { reason: IdentityNotReplaceableReason }
	err.name = IDENTITY_NOT_REPLACEABLE_ERROR_NAME
	err.reason = reason
	return err
}

/** True for an `IdentityNotReplaceableError`; when `reason` is given, only for that reason. */
export function isIdentityNotReplaceable(
	err: unknown,
	reason?: IdentityNotReplaceableReason,
): err is IdentityNotReplaceableError {
	if (typeof err !== 'object' || err === null) return false
	const e = err as { name?: unknown; reason?: unknown }
	if (e.name !== IDENTITY_NOT_REPLACEABLE_ERROR_NAME) return false
	return reason === undefined || e.reason === reason
}
