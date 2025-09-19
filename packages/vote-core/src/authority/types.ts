import type {
	InvitationEnvelope,
	InvitationSigned,
	InvitationStatus,
} from '../invitation/models';
import type { Proposal } from '../common';
import type {
	AuthorityDetails,
	AdminDetails,
	AuthorityInvitation,
	AuthorityInvitationContent,
	OfficerInvitationContent,
	AdminInit,
	OfficerInit,
} from './models';

export type IAuthorityEngine = {
	createOfficerInvitation(
		init: OfficerInit
	): InvitationEnvelope<OfficerInvitationContent>;
	createAuthorityInvitation(
		name: string
	): InvitationEnvelope<AuthorityInvitationContent>;
	getAdminDetails(): Promise<AdminDetails>;
	getAuthorityInvitations(): Promise<InvitationStatus<AuthorityInvitation>[]>;
	getDetails(): Promise<AuthorityDetails>;
	proposeAdmin(
		admin: Proposal<AuthorityInvitationContent & AdminInit>
	): Promise<void>;
	saveAdminInvite(
		invitation: InvitationSigned<OfficerInvitationContent>
	): Promise<void>;
	saveAuthorityInvite(
		invitation: InvitationSigned<AuthorityInvitationContent>
	): Promise<void>;
};
