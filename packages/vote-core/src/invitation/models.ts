import type { Signature } from "../common/signature.js";
import type { SID, Timestamp, UserInit } from "../index.js";
import type { NetworkReference } from "../network/models.js";

export type Invitation<T> = {
	slot: InvitationSlot<T>;
	privateKey: string;
	networkRef: NetworkReference;
}

export type InvitationSlot<T> = {
	invite: T;
	type: InvitationType;
	expiration: Timestamp;
}

export type InvitationStatus<T> = {
	slot: InvitationSlot<T>;
	sent?: InvitationSent;
	result?: InvitationResult;
}

export type InvitationResult = {
	/** SID of the user that accepted the invitation */
	userSid: SID;

	/** Whether the invitation was accepted */
	isAccepted: boolean;

	/** The digest is the invite slot, the isAccepted flag, and the acceptingSid. Signed by the private key given in the invitation */
	invitationSignature: string;

	/** SID of the result */
	invokedSid?: SID;
}

export type InvitationSent = {
	key: string; //This could be negotiated as a threshold key to allow multiple administrators to sign

	signatures: Signature[];
}

export type InvitationAction<TInvokes, TSlot> = {
	/** What the invitation is invoking */
	invokes: TInvokes;

	/** The user that is being created if this is a new user
	 * Use this or userSid, not both
	*/
	userInit?: UserInit;

	/** SID of the user that accepted the invitation if this is an existing user
	 * Use this or userInit, not both
	*/
	userSid?: SID;

	/** The slot that was accepted */
	invitationSlot: InvitationSlot<TSlot>;

	/** Whether the invitation was accepted */
	isAccepted: boolean;

	/** The digest is the invite slot, the isAccepted flag, and the acceptingSid. Signed by the private key given in the invitation */
	invitationSignature: string;
}

/** eg "Administrator" | "Authority" | "Keyholder" */
export type InvitationType = string;