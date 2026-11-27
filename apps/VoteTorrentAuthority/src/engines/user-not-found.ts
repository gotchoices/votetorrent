/**
 * True when `error` is vote-engine's `UserNotFoundError`: this device has no User row on the open
 * network. That is expected on a device that joined as an invited keyholder, so screens show their
 * "no user" state instead of a load error. Structural (the `userNotFound` marker), not instanceof,
 * so it survives Metro's module duplication and needs no vote-engine import here.
 */
export function isUserNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { userNotFound?: unknown }).userNotFound === true
	);
}
