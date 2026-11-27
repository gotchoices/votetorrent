import type { InviteStatus, SentKeyholderInvite } from "@votetorrent/vote-core";
import { KEYHOLDER_INVITE_STATE_META, keyholderInviteState } from "../keyholder-invite-status";

type S = InviteStatus<SentKeyholderInvite>;
const inv = { name: "A" } as unknown as SentKeyholderInvite;
const exp = "2030-01-01T00:00:00";

describe("keyholderInviteState", () => {
	it("accepted result -> accepted, regardless of sent", () => {
		const s = { invite: inv, result: { isAccepted: true }, sent: { state: "no-longer-valid", expiration: exp } } as unknown as S;
		expect(keyholderInviteState(s)).toBe("accepted");
	});
	it("declined result -> declined", () => {
		const s = { invite: inv, result: { isAccepted: false }, sent: { state: "answered", expiration: exp } } as unknown as S;
		expect(keyholderInviteState(s)).toBe("declined");
	});
	it("live -> sent", () => {
		expect(keyholderInviteState({ invite: inv, sent: { state: "live", expiration: exp } } as S)).toBe("sent");
	});
	it("answered without a result (replication lag) -> sent", () => {
		expect(keyholderInviteState({ invite: inv, sent: { state: "answered", expiration: exp } } as S)).toBe("sent");
	});
	it("sent declined without a result (the real engine's only shape for a decline) -> declined, never sent", () => {
		expect(keyholderInviteState({ invite: inv, sent: { state: "declined", expiration: exp } } as S)).toBe("declined");
		expect(KEYHOLDER_INVITE_STATE_META[keyholderInviteState({ invite: inv, sent: { state: "declined", expiration: exp } } as S)])
			.toEqual({ labelKey: "keyholderStatusDeclined", colorKey: "error" });
	});
	it("no-longer-valid (cancelled, expired or superseded) -> no-longer-valid", () => {
		expect(keyholderInviteState({ invite: inv, sent: { state: "no-longer-valid", expiration: exp } } as S)).toBe("no-longer-valid");
	});
	it("unknown (ambiguous chain or unreadable invitation table) -> unknown, never not-sent", () => {
		expect(keyholderInviteState({ invite: inv, sent: { state: "unknown", expiration: "" } } as S)).toBe("unknown");
	});
	it("unknown with a declined result -> declined (the response wins)", () => {
		const s = { invite: inv, result: { isAccepted: false }, sent: { state: "unknown", expiration: "" } } as unknown as S;
		expect(keyholderInviteState(s)).toBe("declined");
	});
	it("accepted-earlier-revision without a result -> accept-again (M1); a present result still wins", () => {
		const s = { invite: inv, sent: { state: "accepted-earlier-revision", expiration: exp } } as unknown as S;
		expect(keyholderInviteState(s)).toBe("accept-again");
		expect(KEYHOLDER_INVITE_STATE_META["accept-again"]).toEqual({ labelKey: "keyholderStatusAcceptAgain", colorKey: "warning" });
		expect(keyholderInviteState({ ...s, result: { isAccepted: true } } as unknown as S)).toBe("accepted");
		expect(keyholderInviteState({ ...s, result: { isAccepted: false } } as unknown as S)).toBe("declined");
	});
	it("no sent -> not-sent", () => {
		expect(keyholderInviteState({ invite: inv } as S)).toBe("not-sent");
	});
	it("META tones and labels", () => {
		expect(KEYHOLDER_INVITE_STATE_META.sent).toEqual({ labelKey: "keyholderStatusSent", colorKey: "warning" });
		expect(KEYHOLDER_INVITE_STATE_META["no-longer-valid"]).toEqual({ labelKey: "keyholderStatusNoLongerValid", colorKey: "error" });
		expect(KEYHOLDER_INVITE_STATE_META.unknown).toEqual({ labelKey: "keyholderStatusUnknown", colorKey: "warning" });
		expect(Object.keys(KEYHOLDER_INVITE_STATE_META).sort()).toEqual(
			["accept-again", "accepted", "declined", "no-longer-valid", "not-sent", "sent", "unknown"],
		);
		expect(KEYHOLDER_INVITE_STATE_META["not-sent"]).toEqual({ labelKey: "keyholderStatusNotSent", colorKey: "warning" });
		expect(KEYHOLDER_INVITE_STATE_META.accepted.colorKey).toBe("success");
		expect(KEYHOLDER_INVITE_STATE_META.declined.colorKey).toBe("error");
	});
});
