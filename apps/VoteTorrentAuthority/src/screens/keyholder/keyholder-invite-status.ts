import type { InviteStatus, SentKeyholderInvite } from "@votetorrent/vote-core";

export type KeyholderInviteState = "accepted" | "declined" | "sent" | "no-longer-valid" | "unknown" | "not-sent" | "accept-again";

/**
 * What a keyholder's `InviteStatus` says. `result` is set only from a real `Keyholder` row (the
 * invitee ACCEPTED) or an `InviteResult`, so it means "responded". The election engine's keyholder
 * projection also reports `sent` (live | answered | declined | no-longer-valid | unknown) read from the
 * invitation slots, which is what lets the officer see "Sent" before any response. The engine ranks
 * every invitation sent to one name, so after "send again" the newest live one decides.
 *
 * - response wins: accepted / declined regardless of `sent`
 * - sent declined: declined. A decline writes no Keyholder row, so the engine never sets `result` for
 *   it; `sent` is the only carrier. A newer live resend outranks the decline and reads sent.
 * - live, or answered without a visible result yet (replication lag): sent
 * - no-longer-valid covers cancelled, expired and superseded invitations: "no longer valid, send again"
 * - unknown is the fail-closed reading of an ambiguous invitation or an invitation table the network
 *   could not serve. It is deliberately NOT "not sent": the invitation may well exist.
 * - accepted-earlier-revision (no result in the current revision): accept-again. Keyholders accept each
 *   revision of an election separately, so a keyholder who accepted an earlier version needs a new invitation.
 *   The app itself has no apply-revision path today, so this state appears only after an engine-produced
 *   revision change.
 * - no slot found: not sent
 *
 * The copy for every label key below lives in the locale file.
 */
export function keyholderInviteState(status: InviteStatus<SentKeyholderInvite>): KeyholderInviteState {
	if (status.result) return status.result.isAccepted ? "accepted" : "declined";
	switch (status.sent?.state) {
		case "live":
		case "answered":
			return "sent";
		case "declined":
			return "declined";
		case "accepted-earlier-revision":
			return "accept-again";
		case "no-longer-valid":
			return "no-longer-valid";
		case "unknown":
			return "unknown";
		default:
			return "not-sent";
	}
}

/** i18n key + theme color key for a keyholder invite state. */
export const KEYHOLDER_INVITE_STATE_META: Record<
	KeyholderInviteState,
	{ labelKey: string; colorKey: "success" | "error" | "warning" }
> = {
	accepted: { labelKey: "accepted", colorKey: "success" },
	declined: { labelKey: "keyholderStatusDeclined", colorKey: "error" },
	sent: { labelKey: "keyholderStatusSent", colorKey: "warning" },
	"no-longer-valid": { labelKey: "keyholderStatusNoLongerValid", colorKey: "error" },
	unknown: { labelKey: "keyholderStatusUnknown", colorKey: "warning" },
	"accept-again": { labelKey: "keyholderStatusAcceptAgain", colorKey: "warning" },
	"not-sent": { labelKey: "keyholderStatusNotSent", colorKey: "warning" },
};
