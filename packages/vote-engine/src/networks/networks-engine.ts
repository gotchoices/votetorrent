import { randomUUID } from 'crypto';
import { Database, MisuseError, QuereusError } from '@quereus/quereus';
import { NetworkEngine } from '../network/network-engine.js';
import { H16, nowCanonicalDatetime, toCanonicalDatetime } from '../utils.js';
import type { EngineContext } from '../types.js';
import type { DbFactory } from '../types.js';
import type {
	LocalStorage,
	INetworkEngine,
	NetworkInit,
	NetworkReference,
	User,
} from '@votetorrent/vote-core';
import type {
	INetworksEngine,
	INetworksCreateBuilder,
} from '@votetorrent/vote-core';

import {
	registerDbPlugins,
	initDB,
	isSchemaInitialized,
	markSchemaInitialized,
	ensureTidSequence,
	readTidCounter,
	incrementTidCounter,
} from '../database/initialize.js';
import { NetworksCreateBuilder } from './builders/index.js';

// D-02: default in-memory factory — keeps all 581 existing tests passing unchanged.
// Lives at module scope (not inside the class) so it is a stable default parameter.
const inMemoryFactory: DbFactory = async (_hash: string) => new Database();

export class NetworksEngine implements INetworksEngine {
	// D-07: per-instance hash→EngineContext cache.
	// Lifetime is bound to this NetworksEngine instance (AppProvider owns one).
	// D-11: no eviction in v1.0 — revisit at the v2 persistence milestone.
	private readonly contexts = new Map<string, EngineContext>();

	// D-12: per-context monotonic Tid counter seeded from TidSequence on create/attach.
	private readonly tidCounters = new Map<string, number>();

	constructor(
		private readonly localStorage: LocalStorage,
		private readonly dbFactory: DbFactory = inMemoryFactory,
	) {}

	async clearRecentNetworks(): Promise<void> {
		// WR-04: await the async storage write so callers observe a settled state.
		await this.localStorage.removeItem('recentNetworks');
	}

	async create(networkInit: NetworkInit, user: User): Promise<INetworkEngine> {
		// Compute networkHash early so we can pass it to createContext (D-01).
		const networkId = crypto.randomUUID().toString();
		const networkHash = H16(networkId);

		let ctx: EngineContext;
		try {
			ctx = await this.createContext(user, networkHash);
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

		const primaryAuthorityId = crypto.randomUUID().toString();

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

		// D-12: per-context Tid from tidCounters Map (seeded in createContext).
		const tid = this.tidCounters.get(networkHash)!;
		this.tidCounters.set(networkHash, tid + 1);
		// Persist the bumped counter so re-attach resumes from the right value.
		await incrementTidCounter(ctx.db);

		const params = {
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
			adminEffectiveAt: toCanonicalDatetime(networkInit.admin.effectiveAt),
			thresholdPolicies,
			userId: user.id,
			title: officerInit.title,
			scopes: officerScopesJson,
			userName: user.name,
			userImageRef: userImageRefJson,
			keyType: 'user',
			keyValue: firstKey.key,
			expiration: toCanonicalDatetime(firstKey.expiration),
			now: nowCanonicalDatetime(),
		};

		try {
			// Phase 12.2 split-batch fix: split the six INSERTs into three
			// sequential exec() calls so that Admin is committed before
			// Officer (Officer.AdminValid CHECK requires Admin to exist).
			// Defensive against future quereus versions that may evaluate
			// CHECKs eagerly per-INSERT rather than deferring to batch end.
			//
			// 1. User + UserKey + Authority + Admin (no cross-table forward deps)
			// 2. Officer (depends on Admin existing)
			// 3. Network (depends on Authority existing, committed in batch 1)

			await ctx.db.exec(
				`
				insert into User (
					Id,
					Name,
					ImageRef
				)
				with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
				values (:userId, :userName, :userImageRef);

				insert into UserKey (
					UserId,
					Type,
					PubKey,
					Expiration
				)
				with context UserKey = null, Signature = null, Tid = ${tid}, now = :now, IsSignatureValid = true
				values (:userId, :keyType, :keyValue, :expiration);

				insert into Authority (
					Id,
					Name,
					DomainName,
					ImageRef
				)
				with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
				values (:primaryAuthorityId, :primaryAuthorityName, :primaryAuthorityDomainName, :primaryAuthorityImageRef);

				insert into Admin (
					AuthorityId,
					EffectiveAt,
					ThresholdPolicies
				)
				with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
				values (:primaryAuthorityId, :adminEffectiveAt, :thresholdPolicies);
				`,
				params,
			);

			await ctx.db.exec(
				`
				insert into Officer (
					AuthorityId,
					AdminEffectiveAt,
					UserId,
					Title,
					Scopes
				)
				with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
				values (:primaryAuthorityId, :adminEffectiveAt, :userId, :title, :scopes);
				`,
				params,
			);

			await ctx.db.exec(
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
				with context SigningNonce = null, Tid = ${tid}
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
				);
				`,
				params,
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

		// Cache the freshly-built EngineContext so subsequent open() calls return
		// a NetworkEngine bound to the same Database (single live handle, D-06).
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
		// WR-04: await so the recents write is durable before create() returns
		// (and before the persistence proof / AppProvider reads recentNetworks).
		await this.localStorage.setItem('recentNetworks', [
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
		/**
		 * ENG-05: optional live peer-count callback forwarded into the NetworkEngine
		 * so getStatistics can report connected peers. Plain (() => number) — D-03:
		 * no @serfab/@optimystic import enters packages/vote-engine; the app layer
		 * supplies the closure.
		 */
		getPeerCount?: () => number,
	): Promise<INetworkEngine> {
		// D-06: cache-first — single live handle per store.
		const cached = this.contexts.get(ref.hash);
		if (cached) {
			// WR-03: keep a single source of truth for ctx.user. Previously the
			// per-call ctx (with the freshly-supplied user) was returned to the
			// NetworkEngine but was NOT written back into this.contexts, so
			// siblings reading via getEstablishedContext() saw the ORIGINAL cached
			// ctx whose user could differ from what this open() call established.
			// Write the per-call ctx back so the NetworkEngine and all siblings
			// observe one consistent ctx.user for this network.
			const ctx: EngineContext = { ...cached, user };
			this.contexts.set(ref.hash, ctx);
			const qNetworkEngine = new NetworkEngine(ref, this.localStorage, ctx, getPeerCount);
			if (storeAsRecent) {
				const recentNetworks: NetworkReference[] =
					(await this.localStorage.getItem('recentNetworks')) ?? [];
				if (recentNetworks.find((network) => network.hash === ref.hash)) {
					// WR-04: await to remove the read-before-write race on recentNetworks.
					await this.localStorage.setItem('recentNetworks', [
						ref,
						...recentNetworks.filter((network) => network.hash !== ref.hash),
					]);
				} else {
					await this.localStorage.setItem('recentNetworks', [ref, ...recentNetworks]);
				}
			}
			return qNetworkEngine;
		}

		// D-05: cache miss — re-attach ONLY if an initialized store already exists.
		// open() MUST NOT route through createContext() (that path runs DDL and would
		// silently fabricate a fresh empty DB for an unknown hash). Call the factory
		// DIRECTLY, register plugins (no DDL), then gate on the schema-version marker.
		// D-13: hard fail — do NOT fall back to new Database() on a factory open error.
		let db: Database;
		try {
			db = await this.dbFactory(ref.hash);
		} catch (error) {
			throw new Error(
				'Network not opened in this session — use create() first: ' + error,
			);
		}

		// Always-run: register plugins and custom functions (per-Database-instance, not persisted).
		await registerDbPlugins(db);

		// Cross-backend-safe re-attach guard (14-04 — narrows D-05/D-07 with on-device evidence).
		// See patches/optimystic-quereus-plugin-composite-pk.md (second finding).
		//
		// hasDeclaredSchema('main') is false on ANY fresh handle (new process restart OR new
		// in-memory Database()). Running initDB on an already-declared handle triggers the
		// Quereus schema-differ to emit ALTER COLUMN DROP NOT NULL on a PK column, which then
		// throws "Cannot DROP NOT NULL on PRIMARY KEY column 'DependsOn'" — breaking the
		// in-memory suite. So initDB must ONLY run when the handle lacks the declaration.
		//
		// Correctness matrix:
		//   fresh in-memory (never declared)        → initDB runs (creates tables)  → D-05 gate throws (no marker)
		//   in-memory already prepared same session → initDB SKIPPED (already declared) → gate passes → re-attach OK
		//   persistent fresh handle (restart)       → initDB runs (binds LevelDB vtab catalog) → gate passes if initialized
		//   persistent genuinely uninitialized      → initDB runs (creates vtab bindings) → D-05 gate throws (no marker)
		if (!db.declaredSchemaManager.hasDeclaredSchema('main')) {
			await initDB(db);           // declare schema main {...} + apply: creates vtab bindings, binds LevelDB data.
			// initDB also declares the SchemaInit catalog (NO row) — 14-03 on-device fix: a fresh Quereus
			// handle does not auto-restore the catalog from LevelDB, so isSchemaInitialized's marker lookup
			// would otherwise hit an undeclared table → false → wrongly throw on a correctly-persisted store.
			await ensureTidSequence(db); // idempotent INSERT OR IGNORE — safe to re-run
		}

		// D-05/D-08: if the store has no schema-init flag, it is uninitialized — THROW.
		// initDB binds the catalog but does NOT write a SchemaInit flag (that is create()'s
		// job via markSchemaInitialized). So a truly uninitialized store still throws here.
		const initialized = await isSchemaInitialized(db);
		if (!initialized) {
			throw new Error(
				'Network not opened in this session — use create() first',
			);
		}

		// Re-attach (store exists + initialized): seed Tid from persisted counter (D-12),
		// then cache the single live handle (D-06).
		const seed = await readTidCounter(db);
		this.tidCounters.set(ref.hash, seed);

		const ctx: EngineContext = { db, user };
		this.contexts.set(ref.hash, ctx);
		const qNetworkEngine = new NetworkEngine(ref, this.localStorage, ctx, getPeerCount);
		if (storeAsRecent) {
			const recentNetworks: NetworkReference[] =
				(await this.localStorage.getItem('recentNetworks')) ?? [];
			if (recentNetworks.find((network) => network.hash === ref.hash)) {
				await this.localStorage.setItem('recentNetworks', [
					ref,
					...recentNetworks.filter((network) => network.hash !== ref.hash),
				]);
			} else {
				await this.localStorage.setItem('recentNetworks', [ref, ...recentNetworks]);
			}
		}
		return qNetworkEngine;
	}

	buildCreate(): INetworksCreateBuilder {
		return new NetworksCreateBuilder(this);
	}

	/**
	 * D-10: single minimal accessor for the EngineFactory to read the established
	 * context after open() or create(). Does NOT expose ctx.db to screens — only
	 * the factory holds the returned reference.
	 *
	 * Returns undefined if no context has been established for the given hash
	 * (caller must call open() or create() first).
	 */
	getEstablishedContext(networkHash: string): EngineContext | undefined {
		return this.contexts.get(networkHash);
	}

	// D-01: factory-backed createContext — this is the CREATE path. DDL runs here
	// on fresh stores (isSchemaInitialized gate). open() MUST NOT call this method.
	private async createContext(user: User | undefined, hash: string): Promise<EngineContext> {
		const db = await this.dbFactory(hash);           // D-01: factory, not new Database()
		await registerDbPlugins(db);                     // D-07: always-run (plugins/functions)

		// REL-01 strand-aware gate: detect whether the Database already had the App schema
		// applied by StrandDatabase.initialize() (cadre-core strand path).
		//
		// 'App' → strand path: StrandDatabase.executeSchema() ran `declare schema App { <DDL> }
		//         apply schema App;` before handing the handle to this factory. Running initDB
		//         here would declare a SECOND `main` schema over the same tree://default/{table}
		//         LevelDB collections, causing dual-Table ownership and stalling every subsequent
		//         INSERT (release-build infinite spinner / hang).
		//         FIX: skip initDB entirely; run only the idempotent marker helpers.
		//
		// 'main' / absent → rnDbFactory path (dev / in-memory): no prior schema declaration.
		//         Fall through to the existing isSchemaInitialized/initDB gate verbatim.
		//
		// Mirrors the open() guard at line ~334 which uses hasDeclaredSchema('main')
		// for the re-attach check — same pattern, different schema name (Pitfall 1: use
		// 'App' not 'main'; 'main' would never match on the strand path and the bug persists).
		const isStrandDb = db.declaredSchemaManager.hasDeclaredSchema('App');

		if (isStrandDb) {
			// Strand path: App schema already applied — skip initDB (no second main declaration).
			// Plant only the idempotent markers so isSchemaInitialized and readTidCounter work.
			// Both ensureTidSequence and markSchemaInitialized use INSERT OR IGNORE — fully
			// idempotent, so a second createContext() on an already-initialized strand store
			// (CR-01 fix) does not throw a PK-uniqueness violation.
			await ensureTidSequence(db);                 // D-12: create TidSequence table (idempotent)
			await markSchemaInitialized(db);             // D-08: plant the SchemaInit flag (idempotent)
		} else {
			// rnDbFactory path (dev / in-memory): existing logic verbatim (D-08/D-07/D-12).
			const initialized = await isSchemaInitialized(db); // D-08: sentinel check
			if (!initialized) {
				await initDB(db);                        // D-07: DDL only on fresh store
				await ensureTidSequence(db);             // D-12: create TidSequence table
				await markSchemaInitialized(db);         // D-08: plant the SchemaInit flag
			}
		}

		const seed = await readTidCounter(db);           // D-12: seed per-context Tid
		this.tidCounters.set(hash, seed);
		const ctx: EngineContext = { db, user };
		return ctx;
	}
}
