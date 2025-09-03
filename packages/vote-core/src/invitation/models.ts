import type { Envelope } from '../common/envelope.js';
import type { Signature } from '../common/signature.js';
import type { Signed } from '../common/signed.js';
import type { SID, Timestamp, UserInit } from '../index.js';
import type { NetworkReference } from '../network/models.js';

export type Invitation<T> = {
	slot: InvitationSlot<T>;
	privateKey: string;
	networkRef: NetworkReference;
};

export type InvitationSlot<T> = {
	invite: T;
	type: InvitationType;
	expiration: Timestamp;
};

export type InvitationStatus<T> = {
	slot: InvitationSlot<T>;
	sent?: InvitationSent;
	result?: InvitationResult;
};

export type InvitationResult = {
	/** SID of the user that accepted the invitation */
	userSid: SID;

	/** Whether the invitation was accepted */
	isAccepted: boolean;

	/** The digest is the invite slot, the isAccepted flag, and the acceptingSid. Signed by the private key given in the invitation */
	invitationSignature: string;

	/** SID of the result */
	invokedSid?: SID;
};

export type InvitationSent = {
	key: string; //This could be negotiated as a threshold key to allow multiple administrators to sign

	signatures: Signature[];
};

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
};

/** "au" for authority, "ad" for administrator, "k" for keyholder, "r" for registrant */
export type InvitationType = 'au' | 'ad' | 'k' | 'r';

export type InvitationContent = {
	/** The type of the invitation */
	type: InvitationType;

	/** The expiration date of the invitation */
	expiration: string;

	/** The public key of the invitation */
	inviteKey: string;

	/** The private key of the invitation */
	invitePrivate: string;

	/** The signature of the invitation */
	inviteSignature: string;

	/** The digest of the invitation */
	digest: string;
};

export type InvitationEnvelope<TContent extends Record<string, string>> = {
	envelope: Envelope<TContent>;
	privateKey: string;
};

export type InvitationSigned<TContent extends Record<string, string>> = {
	/** The CID is of the InvitationSlot. It consists of the digest of the signed content */
	cid: string;

	/** The signed content of the invitation */
	signed: Signed<TContent>;

	/** The invitation private key which is sent to the invitee but is not part of the cid of the InvitationSlot */
	privateKey: string;
};
