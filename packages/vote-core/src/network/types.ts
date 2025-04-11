import type { Authority, Cursor, Administration } from '../index.js';
import type { NetworkReference } from './network-reference.js';
import type { IUserEngine } from '../user/types.js';

export type INetworkEngine = {
	readonly init: NetworkReference;
	getPinnedAuthorities(): Promise<Authority[]>;
	pinAuthority(authority: Authority): Promise<void>;
	unpinAuthority(authoritySid: string): Promise<void>;
	getAuthoritiesByName(name: string | undefined): Promise<Cursor<Authority>>;
	moveAuthoritiesByName(
		cursor: Cursor<Authority>,
		forward: boolean
	): Promise<Cursor<Authority>>;
	getAdministration(authoritySid: string): Promise<Administration>;
	setProposedAdministration(authoritySid: string, administration: Administration): Promise<void>;
	getProposedAdministration(authoritySid: string): Promise<Administration | undefined>;
	getUser(): IUserEngine;
}
