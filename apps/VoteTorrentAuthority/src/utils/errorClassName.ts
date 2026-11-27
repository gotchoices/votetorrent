/**
 * Log-safe error description for the D-26 network-join flow (D-06).
 *
 * A caught error on the join path may carry the join code, the invitation or engine detail in its
 * text. Logs carry at most the error's class name, never its text, its string form, the error
 * object, the code or the result detail. The Authority-wide strict raw-error guard and the
 * console-leak tests gate the call sites. This copies
 * `apps/VoteTorrentVoter/src/utils/errorClassName.ts`.
 */
export function errorClassName(err: unknown): string {
	return err instanceof Error ? err.name : typeof err;
}
