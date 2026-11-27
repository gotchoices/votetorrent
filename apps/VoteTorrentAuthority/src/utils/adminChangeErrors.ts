import { ADMIN_CHANGE_ERROR_CODES } from "@votetorrent/vote-core";

/**
 * Administration-change refusals mapped to copy. Screens map a coded refusal to a translated key
 * here and never render engine text: only the error's own or inherited string `code` is read.
 *
 * The promotion outcome type lives in vote-engine and is not on IAuthorityEngine, which is why
 * `promotionWasRefused` is a structural probe.
 */

const KEY_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
	[ADMIN_CHANGE_ERROR_CODES.pending]: "adminChangePendingRefusal",
	[ADMIN_CHANGE_ERROR_CODES.noRadHolder]: "adminChangeNoRadRefusal",
	[ADMIN_CHANGE_ERROR_CODES.inviteeNotAccepted]: "adminChangeInviteNotAccepted",
	[ADMIN_CHANGE_ERROR_CODES.cancelNotAuthorized]: "adminChangeCancelNotAuthorized",
	[ADMIN_CHANGE_ERROR_CODES.cancelNotPending]: "adminChangeCancelNotPending",
	[ADMIN_CHANGE_ERROR_CODES.cancelRefused]: "adminChangeCancelRefused",
	// Thrown by the officer accept path; not one of the shared administration-change codes.
	"officer-provisioning-required": "adminChangeAcceptNeedsSigningKey",
});

/** The copy key for a coded administration-change refusal, or undefined for anything else. */
export function adminChangeErrorKey(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	const code = (err as { code?: unknown }).code;
	if (typeof code !== "string") return undefined;
	if (!Object.prototype.hasOwnProperty.call(KEY_BY_CODE, code)) return undefined;
	return KEY_BY_CODE[code];
}

/** True only when the engine's last promotion outcome has status `refused`. */
export function promotionWasRefused(engine: unknown): boolean {
	if (typeof engine !== "object" || engine === null) return false;
	const outcome = (engine as { lastPromotionOutcome?: unknown }).lastPromotionOutcome;
	if (typeof outcome !== "object" || outcome === null) return false;
	return (outcome as { status?: unknown }).status === "refused";
}
