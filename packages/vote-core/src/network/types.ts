import type { IAuthorityEngine } from '../authority/types.js';
import type { SID } from '../common';
import type {
	Authority,
	Cursor,
	NetworkSummary,
	NetworkDetails,
	NetworkInfrastructure,
	HostingProvider,
	NetworkRevisionInit,
} from '../index.js';
import type { InvitationAction } from '../invitation/models.js';
import type { IUserEngine } from '../user/types.js';

export type INetworkEngine = {
	getAuthoritiesByName(name: string | undefined): Promise<Cursor<Authority>>;
	getCurrentUser(): Promise<IUserEngine | undefined>;
	getDetails(): Promise<NetworkDetails>;
	getHostingProviders(): AsyncIterable<HostingProvider>;
	getInfrastructure(): Promise<NetworkInfrastructure>;
	getNetworkSummary(): Promise<NetworkSummary>;
	getPinnedAuthorities(): Promise<Authority[]>;
	getUser(userSid: SID): Promise<IUserEngine | undefined>;
	nextAuthoritiesByName(
		cursor: Cursor<Authority>,
		forward: boolean
	): Promise<Cursor<Authority>>;
	openAuthority(authoritySid: SID): Promise<IAuthorityEngine>;
	pinAuthority(authority: Authority): Promise<void>;
	proposeRevision(revision: NetworkRevisionInit): Promise<void>;
	respondToInvitation<TInvokes, TSlot>(
		invitation: InvitationAction<TInvokes, TSlot>
	): Promise<SID>;
	unpinAuthority(authoritySid: SID): Promise<void>;
};
