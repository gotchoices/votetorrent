import type {
	InvitationEnvelope,
	InvitationSigned,
	InvitationStatus,
} from '../invitation/models';
import type { Proposal, Signature } from '../common';
import type {
	AuthorityDetails,
	AdministrationDetails,
	AuthorityInvitation,
	AuthorityInvitationContent,
	AdministratorInvitationContent,
	AdministratorInvitation,
	AdministrationInit,
} from './models';

export type IAuthorityEngine = {
	createAuthorityInvitation(
		name: string
	): InvitationEnvelope<AuthorityInvitationContent>;
	getAdministrationDetails(): Promise<AdministrationDetails>;
	getAuthorityInvitations(): Promise<InvitationStatus<AuthorityInvitation>[]>;
	getDetails(): Promise<AuthorityDetails>;
	inviteAdministrator(
		name: Proposal<AdministratorInvitationContent>
	): Promise<AdministratorInvitation>;
	proposeAdministration(
		administration: Proposal<AuthorityInvitationContent & AdministrationInit>
	): Promise<void>;
	saveAuthorityInvite(
		invitation: InvitationSigned<AuthorityInvitationContent>
	): Promise<void>;
};
