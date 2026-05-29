import type { InviteStatus } from './models.js';
import type { SentOfficerInvite, SentAuthorityInvite } from '../authority/models.js';

/**
 * Engine for reading pending invitations and responding to them.
 * Implemented by MockInvitationEngine (vote-engine) for v1.1 mocks-only mode.
 */
export interface IInvitationEngine {
	getPendingOfficerInvites(): Promise<Array<InviteStatus<SentOfficerInvite>>>;
	getPendingAuthorityInvites(): Promise<Array<InviteStatus<SentAuthorityInvite>>>;
	getOfficerInvite(id: string): Promise<InviteStatus<SentOfficerInvite> | undefined>;
	getAuthorityInvite(id: string): Promise<InviteStatus<SentAuthorityInvite> | undefined>;
	respondToInvite(invitationId: string, accept: boolean): Promise<void>;
}
