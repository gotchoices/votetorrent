import type { Authority, UserIdentity, Cursor } from '../index.js';
import type { ElectionEngineInit } from './struct.js';
import type { IElectionEngine } from './interfaces.js';

const MOCK_AUTHORITIES: Authority[] = [
	{
		sid: '1',
		name: 'Utah State Elections',
		domainName: 'utah.gov',
		imageCid: 'QmZjkl4GIafds123',
		signature: '[valid]',
	},
	{
		sid: '2',
		name: 'Salt Lake County',
		domainName: 'slco.gov',
		imageCid: 'QmZjkl4GIafds123',
		signature: '[valid]',
	},
  {
    sid: '3',
    name: 'Utah County',
    domainName: 'utah.gov',
    imageCid: 'QmZjkl4GIafds123',
    signature: '[valid]',
  },
  {
    sid: '4',
    name: 'Davis County',
    domainName: 'davis.gov',
    imageCid: 'QmZjkl4GIafds123',
    signature: '[valid]',
  },
  {
    sid: '5',
    name: 'Weber County',
    domainName: 'weber.gov',
    imageCid: 'QmZjkl4GIafds123',
    signature: '[valid]',
  },
];

export class MockElectionEngine implements IElectionEngine {
	private pinnedAuthorities: Authority[] = [];
	private userIdentity?: UserIdentity;

	constructor(public readonly init: ElectionEngineInit) {}

	static async create(init: ElectionEngineInit): Promise<MockElectionEngine> {
		return new MockElectionEngine(init);
	}

	async getPinnedAuthorities(): Promise<Authority[]> {
		return this.pinnedAuthorities;
	}

	async pinAuthority(authority: Authority): Promise<void> {
		const exists = this.pinnedAuthorities.some(
			(a) => a.sid === authority.sid
		);
		if (!exists) {
			this.pinnedAuthorities.push(authority);
		}
	}

	async unpinAuthority(authoritySid: string): Promise<void> {
		this.pinnedAuthorities = this.pinnedAuthorities.filter(
			(a) => a.sid !== authoritySid
		);
	}

	async getAuthoritiesByName(
		name: string | undefined
	): Promise<Cursor<Authority>> {
		const filtered = name
			? MOCK_AUTHORITIES.filter((a) =>
					a.name.toLowerCase().includes(name.toLowerCase())
			  )
			: MOCK_AUTHORITIES;

		return {
			buffer: filtered,
			offset: 0,
			firstBOF: true,
			lastEOF: true,
		};
	}

	async moveAuthoritiesByName(
		cursor: Cursor<Authority>,
		forward: boolean
	): Promise<Cursor<Authority>> {
		// In this mock, we always return the same cursor since we're not implementing pagination
		return cursor;
	}

	async setUserIdentity(identity: UserIdentity): Promise<void> {
		this.userIdentity = identity;
	}

	async getUserIdentity(): Promise<UserIdentity | undefined> {
		return this.userIdentity;
	}

	async clearUserIdentity(): Promise<void> {
		this.userIdentity = undefined;
	}
}
