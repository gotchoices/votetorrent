/**
 * Log-safe error description for the registration screens (T-62-28-01).
 *
 * A caught error on the registration and continuity paths may carry the registration code,
 * identity evidence or engine detail in its message. Logs carry at most the error's class name,
 * never its message, its String() form, the error object, or any evidence, code or identity value.
 * `__tests__/no-error-text-logging.continuity.test.ts` gates the call sites.
 */
export function errorClassName(err: unknown): string {
	return err instanceof Error ? err.name : typeof err;
}
