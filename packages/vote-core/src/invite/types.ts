import type { InviteSlotResolution, InviteStatus, InviteType, KeyholderAcceptProvisioning } from './models.js';
import type { SentOfficerInvite, SentAuthorityInvite } from '../authority/models.js';
import type { SentKeyholderInvite } from '../election/models.js';

/** Facts about a keyholder ('k') invitation slot's seat, for the app's pre-prompt checks. */
export interface KeyholderSlotSeat {
	electionId: string;
	/** True when the calling officer is the one who sent the invitation (cannot accept it). */
	selfInvite: boolean;
}

/**
 * Engine for reading pending invitations and responding to them.
 * Implemented by MockInvitationEngine (vote-engine) for v1.1 mocks-only mode.
 */
export interface IInvitationEngine {
	getPendingOfficerInvites(): Promise<Array<InviteStatus<SentOfficerInvite>>>;
	getPendingAuthorityInvites(): Promise<Array<InviteStatus<SentAuthorityInvite>>>;
	getOfficerInvite(id: string): Promise<InviteStatus<SentOfficerInvite> | undefined>;
	getAuthorityInvite(id: string): Promise<InviteStatus<SentAuthorityInvite> | undefined>;
	getKeyholderInvite(id: string): Promise<InviteStatus<SentKeyholderInvite> | undefined>;
	/**
	 * Resolve the invitee's share to its InviteSlot chain and report its state (live, answered,
	 * no-longer-valid, not-found, ambiguous). A resend adds a row to the share's chain; the newest row
	 * (the head) is the one to accept. See `InviteSlotResolution`.
	 */
	resolveInviteSlot(inviteKey: string, type: InviteType): Promise<InviteSlotResolution>;
	/**
	 * Resolve the InviteSlot an invitee holds the share for, by the share's public key and type
	 * (D-05 pattern, as NetworkEngine.respondToInvite). Returns the head Cid only when
	 * `resolveInviteSlot` reports `live`, otherwise undefined (fail closed). This is the ONLY way an
	 * invitee obtains a Cid, because the Cid digests fields (ElectionId, InviteSignature,
	 * SigningNonce) the share does not carry.
	 */
	resolveInviteSlotCid(inviteKey: string, type: InviteType): Promise<string | undefined>;
	/**
	 * Respond to an invitation (accept or decline).
	 *
	 * @param invitationId  - The InviteSlot CID being responded to. Callers obtain it from
	 *                        `resolveInviteSlotCid`.
	 * @param accept        - true = accept, false = decline (signed authenticated "no", INV-05 / D-09).
	 * @param invitePrivate - REQUIRED: hex-encoded one-time secp256k1 private key from the pasted
	 *                        invite share (D-06). The InviteResult is signed under the LOCKED A1
	 *                        encoding and the engine verifies it against the slot's InviteKey. Without
	 *                        a well-formed key the engine throws code `invite-key-required`; a key that
	 *                        is not the slot's throws `invite-signature-invalid`. Never the device
	 *                        user's key (T-21-04-05).
	 * @param digest        - Optional: on accept, the digest of the object being created. Omit for
	 *                        decline (engine enforces Digest=null per DigestValid) or when the
	 *                        caller wants the engine to derive a placeholder.
	 * @param invokedId     - Optional: ID of the object the invitation will invoke (Authority / User).
	 * @param keyholder     - 62-02 (D-21, D-26): REQUIRED for a Type 'k' (keyholder) accept — absent
	 *                        means the engine throws before any write. Ignored for every other
	 *                        invite type. See `KeyholderAcceptProvisioning`'s doc comment.
	 */
	respondToInvite(
		invitationId: string,
		accept: boolean,
		invitePrivate: string,
		digest?: string,
		invokedId?: string,
		keyholder?: KeyholderAcceptProvisioning,
	): Promise<void>;
	/**
	 * Seat facts for a keyholder ('k') slot: its election and whether the calling officer sent it.
	 * Lets the app refuse a self-accept before any biometric prompt; `respondToInvite` is the
	 * authority (it throws code `self-invite`). Undefined for any other slot type or an unknown cid.
	 */
	getKeyholderSlotSeat(slotCid: string): Promise<KeyholderSlotSeat | undefined>;
}
