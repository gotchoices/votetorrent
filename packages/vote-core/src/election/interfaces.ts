import type { Authority, UserIdentity, Cursor } from '../index.js';
import type { ElectionEngineInit } from './struct.js';

export interface IElectionEngine {
	readonly init: ElectionEngineInit;
	getPinnedAuthorities(): Promise<Authority[]>;
	pinAuthority(authority: Authority): Promise<void>;
	unpinAuthority(authoritySid: string): Promise<void>;
	getAuthoritiesByName(name: string | undefined): Promise<Cursor<Authority>>;
	moveAuthoritiesByName(
		cursor: Cursor<Authority>,
		forward: boolean
	): Promise<Cursor<Authority>>;
	setUserIdentity(identity: UserIdentity): Promise<void>;
	getUserIdentity(): Promise<UserIdentity | undefined>;
	clearUserIdentity(): Promise<void>;
}
