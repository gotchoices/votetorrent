import type { IAuthorityEngine } from '../authority/types.js';
import type {
	Authority,
	Cursor,
	NetworkSummary,
	NetworkDetails,
	NetworkInfrastructure,
	HostingProvider,
	NetworkRevision,
	AuthorityInit,
	AdminInit,
	Proposal,
	ElectionInit,
} from '../index.js';
import type { InviteAction } from '../invite/models.js';
import type { IUserEngine } from '../user/types.js';

export type INetworkEngine = {
	createAuthority(authority: AuthorityInit, admin: AdminInit): Promise<void>;
	getAuthoritiesByName(name: string | undefined): Promise<Cursor<Authority>>;
	getCurrentUser(): Promise<IUserEngine | undefined>;
	getDetails(): Promise<NetworkDetails>;
	getHostingProviders(): AsyncIterable<HostingProvider>;
	getInfrastructure(): Promise<NetworkInfrastructure>;
	getNetworkSummary(): Promise<NetworkSummary>;
	getPinnedAuthorities(): Promise<Authority[]>;
	getProposedElections(): Promise<Proposal<ElectionInit>[]>;
	getUser(userId: string): Promise<IUserEngine | undefined>;
	nextAuthoritiesByName(
		cursor: Cursor<Authority>,
		forward: boolean
	): Promise<Cursor<Authority>>;
	openAuthority(
		authorityId: string,
		authority?: Authority
	): Promise<IAuthorityEngine>;
	pinAuthority(authority: Authority): Promise<void>;
	proposeRevision(revision: NetworkRevision): Promise<void>;
	respondToInvite<TInvokes, TSlot>(
		invite: InviteAction<TInvokes, TSlot>
	): Promise<string>;
	unpinAuthority(authorityId: string): Promise<void>;
};
