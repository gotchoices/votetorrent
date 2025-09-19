import type {
	LocalStorage,
	INetworkEngine,
	NetworkInit,
	NetworkReference,
	User,
} from '@votetorrent/vote-core';
import type { INetworksEngine } from '@votetorrent/vote-core';
import type { EngineContext } from '../types';
import { NetworkEngine } from '../network/network-engine';
import { Database } from '@quereus/quereus';
import { initDB } from '../database/initialize';

export class NetworksEngine implements INetworksEngine {
	constructor(private readonly localStorage: LocalStorage) {}

	async clearRecentNetworks(): Promise<void> {
		this.localStorage.removeItem('recentNetworks');
	}

	async create(networkInit: NetworkInit, user: User): Promise<INetworkEngine> {
		const ctx = await this.createContext(user);
		const primaryAuthoritySid = (await ctx.db
			.prepare(`select Digest(?, ?, ?, ?, ?) as result`)
			.get([
				networkInit.primaryAuthority.name,
				networkInit.primaryAuthority.domainName,
				networkInit.imageUrl ?? null,
				null,
				null,
			])['result']) as string;
		if (!primaryAuthoritySid) {
			throw new Error(
				'Failed to create network: Primary authority SID is null'
			);
		}

		// Prepare json fields
		const imageRefJson = networkInit.imageUrl
			? JSON.stringify(networkInit.imageUrl)
			: null;
		const relaysJson = JSON.stringify(networkInit.relays ?? []);
		const tsaJson = JSON.stringify(
			networkInit.policies?.timestampAuthorities ?? []
		);
		const numberRequiredTSAs = networkInit.policies?.numberRequiredTSAs ?? 0;
		const electionType = networkInit.policies?.electionType ?? null;

		const networkSid = (await ctx.db
			.prepare(`select Digest(?, ?, ?, ?, ?, ?, ?) as result`)
			.get([
				primaryAuthoritySid,
				networkInit.name,
				imageRefJson,
				relaysJson,
				tsaJson,
				numberRequiredTSAs,
				electionType,
			])['result']) as string;
		if (!networkSid) {
			throw new Error('Failed to create network: Network SID is null');
		}
		const networkHash = (await ctx.db
			.prepare(`select H16(?) as result`)
			.get([networkSid])['result']) as string;
		if (!networkHash) {
			throw new Error('Failed to create network: Network hash is null');
		}

		try {
			// Insert Network
			await ctx.db.exec(
				`
				insert into Network (
					Sid,
					Hash,
					Name,
					ImageRef,
					Relays,
					TimestampAuthorities,
					NumberRequiredTSAs,
					ElectionType
				)
				values (
					:sid,
					:hash,
					:name,
					:imageRef,
					:relays,
					:timestampAuthorities,
					:numberRequiredTSAs,
					:electionType
				)
				`,
				{
					sid: networkSid,
					hash: networkHash,
					name: networkInit.name,
					imageRef: imageRefJson,
					relays: relaysJson,
					timestampAuthorities: tsaJson,
					numberRequiredTSAs: numberRequiredTSAs,
					electionType: electionType,
				}
			);
		} catch (error) {
			throw new Error('Failed to create network: ' + error);
		}

		// Update recent networks list
		const networkRef: NetworkReference = {
			hash: networkHash,
			imageUrl: networkInit.imageUrl,
			relays: networkInit.relays,
			name: networkInit.name,
			primaryAuthorityDomainName: networkInit.primaryAuthority.domainName,
		};
		const recentNetworks = (await this.localStorage.getItem(
			'recentNetworks'
		)) as NetworkReference[];
		this.localStorage.setItem('recentNetworks', [
			...recentNetworks,
			networkRef,
		]);

		return this.open(networkRef, user, true);
	}

	async discover(
		latitude: number,
		longitude: number
	): Promise<NetworkReference[]> {
		//TODO How are we going to discover networks?
		let networks: NetworkReference[] = [];
		return networks;
	}

	async getRecentNetworks(): Promise<NetworkReference[]> {
		return (
			((await this.localStorage.getItem('recentNetworks')) as
				| NetworkReference[]
				| undefined) ?? []
		);
	}

	async open(
		ref: NetworkReference,
		user: User | undefined,
		storeAsRecent?: boolean
	): Promise<INetworkEngine> {
		const ctx = await this.createContext(user);
		const qNetworkEngine = new NetworkEngine(ref, this.localStorage, ctx);
		if (storeAsRecent) {
			const recentNetworks =
				((await this.localStorage.getItem('recentNetworks')) as
					| NetworkReference[]
					| undefined) ?? [];
			if (recentNetworks.find((network) => network.hash === ref.hash)) {
				this.localStorage.setItem('recentNetworks', [
					ref,
					...recentNetworks.filter((network) => network.hash !== ref.hash),
				]);
			} else {
				this.localStorage.setItem('recentNetworks', [ref, ...recentNetworks]);
			}
		}
		return qNetworkEngine;
	}

	private async createContext(user: User | undefined): Promise<EngineContext> {
		const db = new Database();
		// Initialize database from schema
		await initDB(db);
		const ctx: EngineContext = { db, user };
		return ctx;
	}
}
