import type { IKeyNetwork } from "@votetorrent/db-core";
import type { Authority, UserIdentity, LocalStorage as ILocalStorage, Cursor } from "../index.js";
import type { ElectionEngineInit } from "./struct.js";

export class ElectionEngine {
	protected constructor(
		public readonly init: ElectionEngineInit,
			/** The local storage to use for the network */
		private readonly localStorage: ILocalStorage,
		/** The key network to access */
		private readonly keyNetwork: IKeyNetwork,
	) { }

	static async connect(init: ElectionEngineInit, localStorage: ILocalStorage, keyNetwork: IKeyNetwork): Promise<ElectionEngine> {
		return new ElectionEngine(init, localStorage, keyNetwork);
	}

	/** Returns all authorities that are pinned by the user */
	async getPinnedAuthorities(): Promise<Authority[]> {
		return (await this.localStorage.getItem<Authority[]>("pinnedAuthorities")) ?? [];
	}

	/** Pins an authority to the user's device */
	async pinAuthority(authority: Authority): Promise<void> {
		const pinnedAuthorities = await this.getPinnedAuthorities();
		const unique = Object.fromEntries(pinnedAuthorities.map(authority => [authority.said, authority]));
		const appended = { ...unique, [authority.said]: authority };
		await this.localStorage.setItem("pinnedAuthorities", Object.values(appended));
	}

	/** Unpins an authority from the user's device */
	async unpinAuthority(authoritySaid: string): Promise<void> {
		const pinnedAuthorities = await this.getPinnedAuthorities();
		const filtered = pinnedAuthorities.filter(authority => authority.said !== authoritySaid);
		await this.localStorage.setItem("pinnedAuthorities", filtered);
	}

	/** Returns all authorities that match the name */
	async getAuthoritiesByName(name: string | undefined): Promise<Cursor<Authority>> {
		throw new Error("Not implemented");
	}

	async moveAuthoritiesByName(cursor: Cursor<Authority>, forward: boolean): Promise<Cursor<Authority>> {
		throw new Error("Not implemented");
	}

	async setUserIdentity(identity: UserIdentity): Promise<void> {
		await this.localStorage.setItem("userIdentity", identity);
	}

	async getUserIdentity(): Promise<UserIdentity | undefined> {
		return await this.localStorage.getItem<UserIdentity>("userIdentity");
	}

	async clearUserIdentity(): Promise<void> {
		await this.localStorage.removeItem("userIdentity");
	}
}
