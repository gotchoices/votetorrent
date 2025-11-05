import type { UserInit } from '../index.js';

export type Invite = {
	/** The type of the invitation */
	type: InviteType;

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

export type InviteStatus<TSentInvite> = {
	invite: TSentInvite;
	result?: InviteResult;
};

export type InviteResult = {
	// /** ID of the user that accepted the invitation */
	// userId: string;

	/** Whether the invitation was accepted */
	isAccepted: boolean;

	/** The digest is the invite slot cid, the isAccepted flag, and the digest of whatever is being created.
	 * Signed by the private key given in the invitation */
	invitationSignature: string;

	/** ID of the result */
	invokedId?: string;
};

export type InviteAction<TInvokes, TInvite> = {
	/** What the invitation is invoking */
	invokes: TInvokes;

	/** The user that is being created if this is a new user
	 * Use this or userId, not both
	 */
	userInit?: UserInit;

	/** ID of the user that accepted the invitation if this is an existing user
	 * Use this or userInit, not both
	 */
	userId?: string;

	/** The invite that was accepted */
	invite: Invite;

	/** Whether the invitation was accepted */
	isAccepted: boolean;

	/** The digest is the invite, the isAccepted flag, and the acceptingId. Signed by the private key given in the invitation */
	inviteSignature: string;
};

/** "au" for authority, "of" for officer, "k" for keyholder, "r" for registrant */
export type InviteType = 'au' | 'of' | 'k' | 'r';
