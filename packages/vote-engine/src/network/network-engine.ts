import type { IKeyNetwork } from '@votetorrent/db-core';
import type {
	Authority,
	LocalStorage as ILocalStorage,
	Cursor,
	Administration,
} from '@votetorrent/vote-core';
import type { NetworkReference } from '@votetorrent/vote-core';
import type { INetworkEngine } from '@votetorrent/vote-core';
import type { IUserEngine } from '@votetorrent/vote-core';

export class NetworkEngine implements INetworkEngine {
	protected constructor(
		public readonly init: NetworkReference,
		/** The local storage to use for the network */
		private readonly localStorage: ILocalStorage,
		/** The key network to access */
		private readonly keyNetwork: IKeyNetwork
	) {}

	static async connect(
		init: NetworkReference,
		localStorage: ILocalStorage,
		keyNetwork: IKeyNetwork
	): Promise<NetworkEngine> {
		return new NetworkEngine(init, localStorage, keyNetwork);
	}

	/** Returns all authorities that are pinned by the user */
	async getPinnedAuthorities(): Promise<Authority[]> {
		return (
			(await this.localStorage.getItem<Authority[]>('pinnedAuthorities')) ?? []
		);
	}

	/** Pins an authority to the user's device */
	async pinAuthority(authority: Authority): Promise<void> {
		const pinnedAuthorities = await this.getPinnedAuthorities();
		const unique = Object.fromEntries(
			pinnedAuthorities.map((authority) => [authority.sid, authority])
		);
		const appended = { ...unique, [authority.sid]: authority };
		await this.localStorage.setItem(
			'pinnedAuthorities',
			Object.values(appended)
		);
	}

	/** Unpins an authority from the user's device */
	async unpinAuthority(authoritySid: string): Promise<void> {
		const pinnedAuthorities = await this.getPinnedAuthorities();
		const filtered = pinnedAuthorities.filter(
			(authority) => authority.sid !== authoritySid
		);
		await this.localStorage.setItem('pinnedAuthorities', filtered);
	}

	/** Returns all authorities that match the name */
	async getAuthoritiesByName(
		name: string | undefined
	): Promise<Cursor<Authority>> {
		throw new Error('Not implemented');
	}

	async moveAuthoritiesByName(
		cursor: Cursor<Authority>,
		forward: boolean
	): Promise<Cursor<Authority>> {
		throw new Error('Not implemented');
	}

	async getAdministration(): Promise<Administration> {
		throw new Error('Not implemented');
	}

	async setProposedAdministration(
		authoritySid: string,
		administration: Administration
	): Promise<void> {
		throw new Error('Not implemented');
	}

	async getProposedAdministration(
		authoritySid: string
	): Promise<Administration | undefined> {
		throw new Error('Not implemented');
	}

	getUser(): IUserEngine {
		throw new Error('Not implemented');
	}
}
