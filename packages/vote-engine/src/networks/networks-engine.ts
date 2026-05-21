import { randomUUID } from 'crypto';
import { Database, MisuseError, QuereusError } from '@quereus/quereus';
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
import { prepareDb } from '../database/initialize.js';

export class NetworksEngine implements INetworksEngine {
	// D-07: per-instance hash→EngineContext cache.
	// Lifetime is bound to this NetworksEngine instance (AppProvider owns one).
	// D-11: no eviction in v1.0 — revisit at the v2 persistence milestone.
	private readonly contexts = new Map<string, EngineContext>();

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
			// KNOWN ISSUE — this multi-INSERT batch is a silent no-op today.
			// `db.eval` returns an AsyncIterableIterator and only executes
			// during iteration; awaiting it (the historical pattern) unwraps
			// the iterator without running any SQL. Switching to `db.exec`
			// exposes a chain of compounding schema/engine issues that are
			// out of scope for Plan 03-01: (1) `TransactionId()` is a phantom
			// SQL function the schema invokes via `with context Tid = ...`,
			// (2) the `ElectionType` view's derived-column-alias form fails
			// at CHECK-eval time, (3) `NoSigningNonceOnInsert` references
			// bare `SigningNonce` without a `context.` prefix, (4) each
			// table's INSERT needs its full declared `with context (...)`
			// bound by the engine. See 03-01-SUMMARY.md for the full chain.
			// Tracked for a dedicated follow-up plan.
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
					PubKey,
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

		// D-08: cache the freshly-built EngineContext so subsequent open()
		// calls return a NetworkEngine bound to the same in-memory Database
		// (the only place Database instances are constructed in production).
		this.contexts.set(networkHash, ctx);

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
		// D-09/D-10: open() reads from the per-instance cache. The cached
		// EngineContext.db is shared verbatim; the caller-supplied `user`
		// is injected into a fresh wrapper without mutating the cached ctx
		// (Claude's-discretion bullet on cache-context user field).
		const cached = this.contexts.get(ref.hash);
		if (!cached) {
			throw new Error(
				'Network not opened in this session — use create() first',
			);
		}
		const ctx: EngineContext = { ...cached, user };
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
