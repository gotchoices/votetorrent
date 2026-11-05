import type { UserInit } from '../index.js';
import type { AuthorityInvite, OfficerInvite } from '../authority/models.js';
import type { UserKey } from '../user/models.js';
import type { Signature } from '../common/signature.js';

/**
 * 62-02 (D-21, D-26): what the app provides to `IInvitationEngine.respondToInvite` for a Type 'k'
 * (keyholder) accept. The PRIVATE halves of both keys never cross into vote-engine — only the
 * public `signingKey`, the public `dkgPublicKey`, and a `sign` callback that signs with the
 * private half of `signingKey.key` on the caller's side.
 *
 * - `signingKey`: the fresh keyholder identity's OWN public signing key (type 'M' or 'P', a
 *   future expiration) — D-21: never the inviting officer's key, never reused across accepts.
 * - `dkgPublicKey`: the 66-char hex compressed secp256k1 DKG share-encryption RECEIVING key
 *   (62-05's `generateDkgReceivingKey().publicKey`) — never the joint election key.
 * - `sign`: signs a digest with `signingKey`'s private half. `respondToInvite` calls this BEFORE
 *   opening the accept transaction (never holds a transaction open across a signing prompt) and
 *   verifies the returned `signerKey` equals `signingKey.key` before writing anything.
 */
export interface KeyholderAcceptProvisioning {
	signingKey: UserKey;
	dkgPublicKey: string;
	sign: (digest: Uint8Array) => Promise<Signature>;
}

export interface Invite {
	/** The type of the invitation */
	type: InviteType;

	/** The expiration date of the invitation */
	expiration: string;

	/** Hex-encoded secp256k1 compressed public key (66 chars, 33 bytes). */
	inviteKey: string;

	/** Hex-encoded secp256k1 compact signature (128 chars, 64 bytes). */
	inviteSignature: string;
}

/**
 * Whether an invitation slot was sent, and whether it is still usable.
 * 'live' = sent and still answerable;
 * 'answered' = the invitee ACCEPTED (a signed InviteResult with IsAccepted true; the Keyholder row
 * may still be replicating);
 * 'accepted-earlier-revision' = the name's accepted invitation belongs to an earlier revision of the election than
 * the one being projected (its acceptor has Keyholder rows only in earlier revisions); keyholders accept each
 * revision separately (user ruling 2026-10-07: keep re-accept), so a new invitation is needed;
 * 'declined' = the invitee said no (a signed InviteResult with IsAccepted false). A decline writes no
 * Keyholder row, so this is the only place a decline is visible;
 * 'no-longer-valid' = cancelled, expired, or superseded and closed;
 * 'unknown' = the chain exists but its state could not be decided: structurally ambiguous, or the
 * network could not serve the invitation tables. It is deliberately NOT "not sent".
 */
export interface InviteSentState {
	state: 'live' | 'answered' | 'accepted-earlier-revision' | 'declined' | 'no-longer-valid' | 'unknown';
	/**
	 * Expiration of the invitation (the chain head's when it is live, answered or declined; the latest of the
	 * chain's rows otherwise). '' when nothing could be read ('unknown' from an unreadable table).
	 */
	expiration: string;
}

export interface InviteStatus<TSentInvite> {
	invite: TSentInvite;
	result?: InviteResult;
	/**
	 * Set only by projections that can read invitation slots (today the election keyholder
	 * projection). Absent means "no invitation slot was found" - never "not sent" for other
	 * invite kinds, which do not fill it.
	 */
	sent?: InviteSentState;
}

// TODO(compat): Legacy shape used by older vote-engine mocks.
// Replace `InvitationStatus` + `InvitationSlot` usage with `InviteStatus<TSentInvite>` once mock data is migrated.
export interface InvitationSlot<TInvite> {
	invite: TInvite;
	type: InviteType;
	expiration: string | number;
}

// TODO(compat): Legacy shape used by older vote-engine mocks.
// `sent` and `result.userId` are inferred from current mock code and are optional for compatibility.
export interface InvitationStatus<TInvite> {
	slot: InvitationSlot<TInvite>;
	sent?: {
		key: string;
		signatures: Array<{
			signature: string;
			signerKey: string;
			signerUserId?: string;
		}>;
	};
	result?: InviteResult & {
		userId?: string;
	};
}

export interface InviteResult {
	// /** ID of the user that accepted the invitation */
	// userId: string;

	/** Whether the invitation was accepted */
	isAccepted: boolean;

	/** The digest is the invite slot cid, the isAccepted flag, and the digest of whatever is being created.
	 * Signed by the private key given in the invitation */
	invitationSignature: string;

	/** ID of the result */
	invokedId?: string;
}

export interface InviteAction<TInvokes> {
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

	/**
	 * The invite's one-time private key (hex). REQUIRED by
	 * NetworkEngine.respondToInvite, which signs the result with it itself.
	 * Never the device key (T-21-04-05).
	 */
	invitePrivate?: string;

	/**
	 * The digest is the invite, the isAccepted flag, and the acceptingId. Signed by the private key given in the invitation
	 * @deprecated ignored by NetworkEngine.respondToInvite, which signs with invitePrivate
	 */
	inviteSignature: string;
}

/** "au" for authority, "of" for officer, "k" for keyholder, "r" for registrant */
export type InviteType = 'au' | 'of' | 'k' | 'r';

/**
 * Outcome of resolving an invitee's share to its InviteSlot (see IInvitationEngine.resolveInviteSlot).
 *
 * A share maps to a CHAIN of slots: every InviteSlot with the share's InviteKey and Type (a resend adds
 * a row). The chain HEAD is the newest row (the ResendSalt-null original is oldest; resend rows order by
 * the Tid in `resend|<tid>|<now>`). The head decides: a cancelled or expired head closes the share and
 * the resolver never falls back to an older row. Backstop: a non-head cancellation strictly later than
 * the head's resend time also closes the share.
 *
 * Precedence: any chain member with an InviteResult -> 'answered'; else any structural ambiguity (two
 * signing nonces, two originals, an unparseable salt or timestamp, equal order keys) -> 'ambiguous';
 * else cancelled / expired -> 'no-longer-valid'; else 'live' with the head's Cid; no rows ->
 * 'not-found'.
 */
export type InviteSlotResolution =
	| { status: 'live'; cid: string }
	| { status: 'answered'; cid: string }
	| { status: 'no-longer-valid' }
	| { status: 'not-found' }
	| { status: 'ambiguous' };

/**
 * Officer invite + the one-time invite private key. One-time use only —
 * discard the OfficerInviteShare reference after the share-link / QR
 * moment per Phase 3 D-27. The base `OfficerInvite` type intentionally
 * has no `invitePrivate` field; only this `Share` variant carries it.
 */
export interface OfficerInviteShare extends OfficerInvite {
	/** Hex-encoded secp256k1 private key (64 chars, 32 bytes). One-time use only. */
	invitePrivate: string;
}

/**
 * Authority invite + the one-time invite private key. Same lifecycle
 * contract as `OfficerInviteShare` — discard after the share-link / QR
 * moment per Phase 3 D-27.
 */
export interface AuthorityInviteShare extends AuthorityInvite {
	/** Hex-encoded secp256k1 private key (64 chars, 32 bytes). One-time use only. */
	invitePrivate: string;
}
