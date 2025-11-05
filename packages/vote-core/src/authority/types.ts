import type { InviteStatus } from '../invite/models';
import type { Proposal, Signature } from '../common';
import type {
	AuthorityDetails,
	AdminDetails,
	AuthorityInvite,
	OfficerInvite,
	AdminInit,
	OfficerInit,
	Scope,
	SentAuthorityInvite,
} from './models';

export type IAuthorityEngine = {
	createOfficerInvite(init: OfficerInit): OfficerInvite;
	createAuthorityInvite(name: string): AuthorityInvite;
	getAdminDetails(): Promise<AdminDetails>;
	getAuthorityInvites(): Promise<InviteStatus<SentAuthorityInvite>[]>;
	getDetails(): Promise<AuthorityDetails>;
	proposeAdmin(admin: Proposal<AuthorityInvite & AdminInit>): Promise<void>;
	saveInviteWithSigning(
		invite: AuthorityInvite | OfficerInvite,
		scope: Scope,
		signature: Signature
	): Promise<void>;
};
