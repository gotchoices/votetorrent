import type {
	Authority,
	Cursor,
	Administration,
	Administrator,
} from '@votetorrent/vote-core';
import type { IUserEngine } from '@votetorrent/vote-core';
import type { NetworkReference } from '@votetorrent/vote-core';
import type { INetworkEngine } from '@votetorrent/vote-core';

const MOCK_AUTHORITIES: Authority[] = [
	{
		sid: '1',
		name: 'Utah State Elections',
		domainName: 'utah.gov',
		imageRef: {
			url: 'https://picsum.photos/500/500?random=2',
			cid: 'QmX40sdfn2T54',
		},
		signature: '[valid]',
	},
	{
		sid: '2',
		name: 'Salt Lake County',
		domainName: 'slco.gov',
		imageRef: {
			url: 'https://picsum.photos/500/500?random=2',
			cid: 'QmY40sdfn2T54',
		},
		signature: '[valid]',
	},
	{
		sid: '3',
		name: 'Utah County',
		domainName: 'utah.gov',
		imageRef: {
			url: 'https://picsum.photos/500/500?random=2',
			cid: 'QmZ40sdfn2T54',
		},
		signature: '[valid]',
	},
	{
		sid: '4',
		name: 'Davis County',
		domainName: 'davis.gov',
		imageRef: {
			url: 'https://picsum.photos/500/500?random=2',
			cid: 'QmX40sdfn2T54',
		},
		signature: '[valid]',
	},
	{
		sid: '5',
		name: 'Weber County',
		domainName: 'weber.gov',
		imageRef: {
			url: 'https://picsum.photos/500/500?random=2',
			cid: 'QmX40sdfn2T54',
		},
		signature: '[valid]',
	},
];

const MOCK_ADMINISTRATORS: Administrator[] = [
	{
		sid: '1',
		name: 'John Doe',
		title: 'County Clerk',
		imageRef: {
			url: 'https://picsum.photos/500/500?random=2',
			cid: 'QmX40sdfn2T54',
		},
		key: 'QmX40sdfn2T54',
		scopes: ['rad', 'vrg', 'iad', 'rnp', 'uai'],
		signatures: ['QmX40sdfn2T54'],
	},
	{
		sid: '2',
		name: 'Jane Smith',
		title: 'Assistant County Clerk',
		imageRef: {
			url: 'https://picsum.photos/500/500?random=2',
			cid: 'QmY40sdfn2T54',
		},
		key: 'QmY40sdfn2T54',
		scopes: ['rad', 'vrg', 'iad'],
		signatures: ['QmY40sdfn2T54'],
	},
];

const MOCK_ADMINISTRATION: Administration = {
	sid: '1',
	authoritySid: '1',
	expiration: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).getTime(),
	administrators: MOCK_ADMINISTRATORS,
};

export class MockNetworkEngine implements INetworkEngine {
	private pinnedAuthorities: Authority[] = [];
	private proposedAdministration?: Administration;
	constructor(public readonly init: NetworkReference) {
		this.pinnedAuthorities = MOCK_AUTHORITIES.slice(0, 3);
	}

	static async create(init: NetworkReference): Promise<MockNetworkEngine> {
		return new MockNetworkEngine(init);
	}

	async getPinnedAuthorities(): Promise<Authority[]> {
		return this.pinnedAuthorities;
	}

	async pinAuthority(authority: Authority): Promise<void> {
		const exists = this.pinnedAuthorities.some((a) => a.sid === authority.sid);
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

	async getAdministration(): Promise<Administration> {
		return MOCK_ADMINISTRATION;
	}

	async setProposedAdministration(
		authoritySid: string,
		administration: Administration
	): Promise<void> {
		this.proposedAdministration = administration;
	}

	async getProposedAdministration(
		authoritySid: string
	): Promise<Administration | undefined> {
		return this.proposedAdministration;
	}

	getUser(): IUserEngine {
		throw new Error('Not implemented');
	}
}
