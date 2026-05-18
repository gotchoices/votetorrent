import { randomUUID } from 'crypto';
import { Database, MisuseError, QuereusError } from '@quereus/quereus';
import { initDB } from '../database/initialize.js';
import { NetworkEngine } from '../network/network-engine.js';
import { H16 } from '../utils.js';
import type { EngineContext } from '../types.js';
import type {
	LocalStorage,
	INetworkEngine,
	NetworkInit,
	NetworkReference,
	User,
} from '@votetorrent/vote-core';
import type { INetworksEngine } from '@votetorrent/vote-core';
import type { EngineContext } from '../types.js';
import { NetworkEngine } from '../network/network-engine.js';
import { Database, MisuseError, QuereusError } from '@quereus/quereus';
import { prepareDb } from '../database/initialize.js';
import { randomUUID } from 'crypto';
import { H16 } from '../utils.js';

export class NetworksEngine implements INetworksEngine {
	constructor(private readonly localStorage: LocalStorage) {}

	async clearRecentNetworks(): Promise<void> {
		this.localStorage.removeItem('recentNetworks');
	}

	async create(networkInit: NetworkInit, user: User): Promise<INetworkEngine> {
		let ctx: EngineContext;
		try {
			ctx = await this.createContext(user);
		} catch (error) {
			throw new Error('Failed to create database context: ' + error);
		}

		// Prepare json fields
		const networkImageRefJson = networkInit.imageUrl
			? JSON.stringify(networkInit.imageUrl)
			: null;
		const primaryAuthorityImageRefJson = networkInit.primaryAuthority.imageUrl
			? JSON.stringify(networkInit.primaryAuthority.imageUrl)
			: null;
		const relaysJson = JSON.stringify(networkInit.relays ?? []);
		const tsaJson = JSON.stringify(
			networkInit.policies?.timestampAuthorities ?? [],
		);
		const numberRequiredTSAs = networkInit.policies?.numberRequiredTSAs ?? 0;
		const electionType = networkInit.policies?.electionType ?? null;
		const thresholdPolicies = JSON.stringify(
			networkInit.admin.thresholdPolicies ?? [],
		);
		const userImageRefJson = user?.imageRef?.url
			? JSON.stringify(user.imageRef)
			: null;

		const networkId = randomUUID().toString();
		const primaryAuthorityId = randomUUID().toString();
		const networkHash = H16(networkId);

		const firstOfficer = networkInit.admin.officers?.[0];
		if (!firstOfficer?.init) {
			throw new Error('Failed to create network: Officer init is required');
		}
		const officerInit = firstOfficer.init;
		const officerScopesJson = JSON.stringify(officerInit.scopes);

		const firstKey = user.activeKeys?.[0];
		if (!firstKey) {
			throw new Error('Failed to create network: User key is required');
		}

		try {
			// TODO add context ( Tid )
			await ctx.db.eval(
				`
				insert into Network (
					Id,
					Hash,
					PrimaryAuthorityId,
					Name,
					ImageRef,
					Relays,
					TimestampAuthorities,
					NumberRequiredTSAs,
					ElectionType
				)
				with context Tid = TransactionId()
				values (
					:networkId,
					:networkHash,
					:primaryAuthorityId,
					:networkName,
					:networkImageRef,
					:relays,
					:timestampAuthorities,
					:numberRequiredTSAs,
					:electionType
				)

				insert into Authority (
					Id,
					Name,
					DomainName,
					ImageRef
				)
				values (:primaryAuthorityId, :primaryAuthorityName, :primaryAuthorityDomainName, :primaryAuthorityImageRef)

				insert into Admin (
					AuthorityId,
					EffectiveAt,
					ThresholdPolicies
				)
				values (:primaryAuthorityId, :adminEffectiveAt, :thresholdPolicies)

				insert into Officer (
					AuthorityId,
					AdminEffectiveAt,
					UserId,
					Title,
					Scopes
				)
				values (:primaryAuthorityId, :adminEffectiveAt, :userId, :title, :scopes)

				insert into User (
					Id,
					Name,
					ImageRef
				)
				values (:userId, :userName, :userImageRef)

				insert into UserKey (
					UserId,
					Type,
					Key,
					Expiration
				)
				with context now = datetime('now')
				values (:userId, :keyType, :keyValue, :expiration)
				`,
				{
					networkId,
					networkHash,
					networkName: networkInit.name,
					networkImageRef: networkImageRefJson,
					relays: relaysJson,
					timestampAuthorities: tsaJson,
					numberRequiredTSAs,
					electionType: electionType.toString(),
					primaryAuthorityId,
					primaryAuthorityName: networkInit.primaryAuthority.name,
					primaryAuthorityDomainName: networkInit.primaryAuthority.domainName,
					primaryAuthorityImageRef: primaryAuthorityImageRefJson,
					adminEffectiveAt: networkInit.admin.effectiveAt,
					thresholdPolicies,
					userId: user.id,
					title: officerInit.title,
					scopes: officerScopesJson,
					userName: user.name,
					userImageRef: userImageRefJson,
					keyType: 'user',
					keyValue: firstKey.key,
					expiration: firstKey.expiration,
				},
			);
		} catch (err) {
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}

		// Update recent networks list
		const networkRef: NetworkReference = {
			hash: networkHash,
			imageUrl: networkInit.imageUrl,
			relays: networkInit.relays,
			name: networkInit.name,
			primaryAuthorityDomainName: networkInit.primaryAuthority.domainName,
		};
		const recentNetworks: NetworkReference[] =
			(await this.localStorage.getItem('recentNetworks')) ?? [];
		this.localStorage.setItem('recentNetworks', [
			...recentNetworks,
			networkRef,
		]);

		return this.open(networkRef, user, true);
	}

	async getRecentNetworks(): Promise<NetworkReference[]> {
		return (await this.localStorage.getItem('recentNetworks')) ?? [];
	}

	async open(
		ref: NetworkReference,
		user: User | undefined,
		storeAsRecent: boolean = true,
	): Promise<INetworkEngine> {
		const ctx = await this.createContext(user);
		const qNetworkEngine = new NetworkEngine(ref, this.localStorage, ctx);
		if (storeAsRecent) {
			const recentNetworks: NetworkReference[] =
				(await this.localStorage.getItem('recentNetworks')) ?? [];
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
		// Register crypto plugin then load schema (Phase 2 D-02 / D-02b option (b)).
		await prepareDb(db);
		const ctx: EngineContext = { db, user };
		return ctx;
	}
}
