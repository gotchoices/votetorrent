import type {
	InvitationEnvelope,
	InvitationSigned,
	InvitationStatus,
} from '../invitation/models';
import type { Proposal } from '../common';
import type {
	AuthorityDetails,
	AdministrationDetails,
	AuthorityInvitation,
	AuthorityInvitationContent,
	AdministratorInvitationContent,
	AdministrationInit,
	AdministratorInit,
} from './models';

export type IAuthorityEngine = {
	createAdministratorInvitation(
		init: AdministratorInit
	): InvitationEnvelope<AdministratorInvitationContent>;
	createAuthorityInvitation(
		name: string
	): InvitationEnvelope<AuthorityInvitationContent>;
	getAdministrationDetails(): Promise<AdministrationDetails>;
	getAuthorityInvitations(): Promise<InvitationStatus<AuthorityInvitation>[]>;
	getDetails(): Promise<AuthorityDetails>;
	proposeAdministration(
		administration: Proposal<AuthorityInvitationContent & AdministrationInit>
	): Promise<void>;
	saveAdministratorInvite(
		invitation: InvitationSigned<AdministratorInvitationContent>
	): Promise<void>;
	saveAuthorityInvite(
		invitation: InvitationSigned<AuthorityInvitationContent>
	): Promise<void>;
};
