import type { InviteStatus } from './models.js';
import type { SentOfficerInvite, SentAuthorityInvite } from '../authority/models.js';
import type { SentKeyholderInvite } from '../election/models.js';

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
	 * Respond to an invitation (accept or decline).
	 *
	 * @param invitationId  - The InviteSlot CID being responded to.
	 * @param accept        - true = accept, false = decline (signed authenticated "no", INV-05 / D-09).
	 * @param invitePrivate - Optional: hex-encoded ephemeral secp256k1 private key from the pasted
	 *                        invite share (D-06). When provided, the InviteSignature is produced under
	 *                        the LOCKED A1 encoding so it verifies against the slot's InviteKey.
	 *                        When omitted the engine generates a fresh ephemeral key for signing
	 *                        (test / stub path — the signature is real but not slot-bound).
	 *                        The device user's private key MUST NOT be passed here (T-21-04-05).
	 * @param digest        - Optional: on accept, the digest of the object being created. Omit for
	 *                        decline (engine enforces Digest=null per DigestValid) or when the
	 *                        caller wants the engine to derive a placeholder.
	 * @param invokedId     - Optional: ID of the object the invitation will invoke (Authority / User).
	 */
	respondToInvite(
		invitationId: string,
		accept: boolean,
		invitePrivate?: string,
		digest?: string,
		invokedId?: string,
	): Promise<void>;
}
