import type { InvitationStatus } from "../invitation/models";
import type { Proposal } from "../common/proposal";
import type { AuthorityDetails, AdministrationDetails, AuthorityInvitation, AuthorityInvitationContent, AdministratorInvitationContent, AdministratorInvitation, AdministrationInit, AuthorityContent } from "./models";

export type IAuthorityEngine = {
	getAdministrationDetails(): Promise<AdministrationDetails>;
	getAuthorityInvitations(): Promise<InvitationStatus<AuthorityInvitation>[]>;
	getDetails(): Promise<AuthorityDetails>;
	inviteAdministrator(name: Proposal<AdministratorInvitationContent>): Promise<AdministratorInvitation>;
	inviteAuthority(name: Proposal<AuthorityInvitationContent>): Promise<AuthorityInvitation>;
	proposeAdministration(administration: Proposal<AuthorityContent & AdministrationInit>): Promise<void>;
	proposeAuthority(authority: Proposal<AuthorityInvitationContent>): Promise<void>;
};
