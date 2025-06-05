import type {
	AdministrationDetails,
	AdministrationInit,
	AdministratorInvitation,
	AdministratorInvitationContent,
	Authority,
	AuthorityDetails,
	AuthorityInvitation,
	AuthorityInvitationContent,
	InvitationStatus,
	Proposal,
} from '@votetorrent/vote-core';
import type { IAuthorityEngine } from '@votetorrent/vote-core';

export class AuthorityEngine implements IAuthorityEngine {
	constructor(private authority: Authority) {}

	async getAdministrationDetails(): Promise<AdministrationDetails> {
		throw new Error('Not implemented');
	}

	async getAuthorityInvitations(): Promise<InvitationStatus<AuthorityInvitation>[]> {
		return [];
	}

	async getDetails(): Promise<AuthorityDetails> {
		throw new Error('Not implemented');
	}

	async inviteAdministrator(name: Proposal<AdministratorInvitationContent>): Promise<AdministratorInvitation> {
		throw new Error('Not implemented');
	}

	async inviteAuthority(name: Proposal<AuthorityInvitationContent>): Promise<AuthorityInvitation> {
		throw new Error('Not implemented');
	}

	async proposeAdministration(administration: Proposal<AdministrationInit>): Promise<void> {
		throw new Error('Not implemented');
	}

	async proposeAuthority(authority: Proposal<AuthorityInvitationContent>): Promise<void> {
		throw new Error('Not implemented');
	}
}
