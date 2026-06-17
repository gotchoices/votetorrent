/**
 * EngineFactory — Phase 15 (D-09/D-12/D-13/D-14 / SWAP-01 / SWAP-03).
 *
 * Single construction point for ALL engines in the app. Lives in the app layer
 * because it holds `rnDbFactory` (RN-specific via rn-leveldb /
 * @optimystic/db-p2p-storage-rn) — per Phase-14 D-03: RN-specific deps MUST NOT
 * appear under packages/vote-engine/.
 *
 * Lifecycle:
 *   - One EngineFactory instance per AppProvider (useRef, app-lifetime — D-12).
 *   - One NetworksEngine wrapping the shared LevelDB factory (D-10).
 *   - Sibling engines are lazily built and cached by name (+JSON-serialized initParams).
 *   - clearEngineCache() wipes ALL cached engines for a clean switch (D-14 uniform clear-all).
 *
 * Security: factory holds ctx internally; screens receive only IXxxEngine instances.
 * getEstablishedContext result never returned to AppProvider/screens (T-15-03-04).
 * factory never calls rnDbFactory(hash) twice — only via networksEngine.open()/create()
 * which is cache-first (T-15-03-05 / Pitfall 2).
 */

import type { NetworkReference, User } from '@votetorrent/vote-core'
import {
	NetworksEngine,
	NetworkEngine,
	ElectionsEngine,
	ElectionEngine,
	SigningEngine,
	DefaultUserEngine,
	KeysTasksEngine,
	SignatureTasksEngine,
	OnboardingTasksEngine,
	InvitationEngine,
	LocalStorageReact,
} from '@votetorrent/vote-engine/rn'
import type { DbFactory, EngineContext, ElectionSubject } from '@votetorrent/vote-engine/rn'

export class EngineFactory {
	private readonly networksEngine: NetworksEngine
	/** Cache keyed by engineName (+ ':' + JSON(initParams) for param-keyed engines). */
	private readonly engineCache = new Map<string, unknown>()
	/** The hash of the most recently opened/created network; gates requireEstablishedCtx. */
	private currentNetworkHash: string | undefined
	/** The resolved device user to bind into ctx on every internal open() call. */
	private currentUser: User | undefined

	/**
	 * ENG-05: live peer-count source, keyed by strandId (== networkHash, D-05).
	 * Registered by CadreNodeProvider after the CadreNode boots. When set, the
	 * network engine reports connected peers in getStatistics; absent, it falls
	 * back to the relay-count heuristic.
	 */
	private getPeerCount: ((strandId: string) => number) | undefined

	/** Called by AppProvider after resolving the device user, before getEngine("network"). */
	setCurrentUser(user: User | undefined): void {
		this.currentUser = user
	}

	/** Called by CadreNodeProvider after boot to wire live peer counts into NetworkEngine. */
	setGetPeerCount(getPeerCount: (strandId: string) => number): void {
		this.getPeerCount = getPeerCount
	}

	constructor(
		private readonly localStorage: LocalStorageReact,
		private readonly rnDbFactory: DbFactory,
	) {
		// Construct NetworksEngine once — it owns the per-network ctx lifecycle (Phase-14 seam).
		// Never call rnDbFactory directly from the factory (Pitfall 2 / T-15-03-05).
		this.networksEngine = new NetworksEngine(localStorage, rnDbFactory)
	}

	/** Expose the shared NetworksEngine for initialize() in AppProvider. */
	getNetworksEngine(): NetworksEngine {
		return this.networksEngine
	}

	/**
	 * D-14: Clear ALL cached sibling engines (uniform clear-all on network switch).
	 * Must be called by AppProvider on network switch or "Start Fresh" (not by the factory).
	 * After clearing, engines are rebuilt lazily on the next getEngine() call.
	 */
	clearEngineCache(): void {
		this.engineCache.clear()
		this.currentNetworkHash = undefined
	}

	/** True if the named engine (with optional initParams) is already cached. */
	hasEngine(engineName: string, initParams?: unknown): boolean {
		const key = this.cacheKey(engineName, initParams)
		return this.engineCache.has(key)
	}

	/**
	 * Return a cached engine or build one. Cache is keyed by name + JSON(initParams)
	 * so different subjects (e.g. different elections) each get their own entry.
	 */
	async getEngine<T>(engineName: string, initParams?: unknown): Promise<T> {
		// 16-08 item 3 fix (approach b): detect a NETWORK SWITCH before the cache-hit
		// short-circuit. cacheKey('network') is a CONSTANT 'network' (CR-01), so without this
		// guard a getEngine('network', refB) with a DIFFERENT hash would HIT the boot-time
		// proof-network entry and never re-point currentNetworkHash — NetworkDetails would then
		// render the proof network's data for every ref (root cause in 16-08-INVESTIGATION.md).
		// When the caller asks for a network whose hash differs from the currently-established
		// one, evict the stale 'network' entry + ctx-dependent siblings so buildEngine re-opens
		// against the new ref. Param-less / same-hash calls fall through unchanged (CR-01).
		if (engineName === 'network') {
			const ref = initParams as NetworkReference | undefined
			if (
				ref?.hash !== undefined &&
				this.currentNetworkHash !== undefined &&
				ref.hash !== this.currentNetworkHash
			) {
				this.evictNetworkScopedEngines()
			}
		}

		const key = this.cacheKey(engineName, initParams)
		if (this.engineCache.has(key)) {
			return this.engineCache.get(key) as T
		}
		const engine = await this.buildEngine(engineName, initParams)
		this.engineCache.set(key, engine)
		return engine as T
	}

	// ---------- private helpers ----------

	/**
	 * 16-08 item 3: evict the 'network' entry and every ctx-dependent sibling so they re-bind
	 * to the newly selected network's ctx. Keep 'defaultUser' (LocalStorage-only, no ctx).
	 * Called from getEngine() when a network switch is detected. Does NOT touch
	 * currentNetworkHash — buildEngine('network', ref) re-points it as part of the rebuild.
	 * The 'authority:<id>' and 'election:<subject>' entries are param-keyed, so we drop ALL
	 * cached engines except 'defaultUser' rather than enumerate every key.
	 */
	private evictNetworkScopedEngines(): void {
		for (const key of [...this.engineCache.keys()]) {
			if (key === 'defaultUser') continue
			this.engineCache.delete(key)
		}
	}

	private cacheKey(engineName: string, initParams?: unknown): string {
		// The "network" engine is a singleton for the currently-established network
		// (D-12/D-14). Screens call getEngine("network") with no params while
		// AppProvider establishes it via getEngine("network", ref); both MUST resolve
		// to the SAME cache entry. Force a stable, param-free key for "network" so the
		// screen call is a cache HIT (CR-01) rather than re-entering buildEngine with
		// undefined initParams (which dereferences ref.hash → crash).
		if (engineName === 'network') {
			return 'network'
		}
		return initParams !== undefined
			? `${engineName}:${JSON.stringify(initParams)}`
			: engineName
	}

	/**
	 * Build a fresh engine instance for the given name.
	 *
	 * Covers all 11 engine names currently handled by AppProvider:
	 *   network, defaultUser, user, authority,
	 *   elections, signing, election, keysTasksEngine, signatureTasksEngine,
	 *   onboardingTasksEngine, invitations.
	 *
	 * For sibling engines that require a live EngineContext, call
	 * requireEstablishedCtx() which throws if no ctx is yet established
	 * (Pitfall 3 / T-15-03-03 — never pass undefined to constructors).
	 */
	private async buildEngine(engineName: string, initParams?: unknown): Promise<unknown> {
		switch (engineName) {
			case 'network': {
				// open() is cache-first inside NetworksEngine (D-06).
				// It establishes ctx in the contexts Map and returns a NetworkEngine.
				// We track the hash so requireEstablishedCtx() can look it up (D-10).
				//
				// CR-01: screens call getEngine("network") with NO params; AppProvider
				// establishes the network via getEngine("network", ref). When no ref is
				// supplied, resolve it from the already-established hash rather than
				// dereferencing undefined.hash. Never overwrite currentNetworkHash with
				// undefined — that would break every sibling's requireEstablishedCtx().
				const ref = (initParams as NetworkReference | undefined)
					?? (this.currentNetworkHash !== undefined
						? ({ hash: this.currentNetworkHash } as NetworkReference)
						: undefined)
				if (ref === undefined) {
					throw new Error(
						'EngineFactory: no network established — call getEngine("network", ref) during init',
					)
				}
				// Q3 open question 3: auto-open so screen-initiated network resolution works.
				// Thread the resolved device user so ctx.user is a real User after boot.
				// ENG-05: forward a live peer-count closure keyed by this network's hash
				// (== strandId, D-05) so NetworkEngine.getStatistics reports connected peers.
				// The closure reads getPeerCount lazily at call time, so it picks up the
				// CadreNodeProvider registration even if it lands after open().
				const peerCount = (): number => this.getPeerCount?.(ref.hash) ?? 0
				const networkEngine = await this.networksEngine.open(
					ref,
					this.currentUser,
					true,
					peerCount,
				)
				this.currentNetworkHash = ref.hash
				return networkEngine
			}

			case 'defaultUser':
				// LocalStorage-backed only — no ctx required. Cheap to rebuild; included in
				// uniform clear-all (D-14) for simplicity.
				return new DefaultUserEngine(this.localStorage)

			case 'user': {
				// Delegates to the cached NetworkEngine — not constructed directly.
				// Requires "network" to have been built first.
				const networkEngine = this.engineCache.get('network') as NetworkEngine | undefined
				if (!networkEngine) {
					throw new Error('EngineFactory: "network" must be built before "user"')
				}
				return networkEngine.getCurrentUser()
			}

			case 'authority': {
				// Delegates to the cached NetworkEngine; initParams is the authority ID string.
				const networkEngine = this.engineCache.get('network') as NetworkEngine | undefined
				if (!networkEngine) {
					throw new Error('EngineFactory: "network" must be built before "authority"')
				}
				return networkEngine.openAuthority(initParams as string)
			}

			case 'elections': {
				const ctx = this.requireEstablishedCtx()
				return new ElectionsEngine(ctx)
			}

			case 'signing': {
				const ctx = this.requireEstablishedCtx()
				return new SigningEngine(ctx)
			}

			case 'election': {
				// Real ElectionEngine requires ElectionSubject (id + authorityId).
				// initParams must carry ElectionSubject — unlike the mock which ignored it.
				const ctx = this.requireEstablishedCtx()
				return new ElectionEngine(initParams as ElectionSubject, ctx)
			}

			case 'keysTasksEngine': {
				const ctx = this.requireEstablishedCtx()
				const ref = { hash: this.currentNetworkHash! } as NetworkReference
				return new KeysTasksEngine(ref, ctx)
			}

			case 'signatureTasksEngine': {
				const ctx = this.requireEstablishedCtx()
				const ref = { hash: this.currentNetworkHash! } as NetworkReference
				return new SignatureTasksEngine(ref, ctx)
			}

			case 'onboardingTasksEngine': {
				const ctx = this.requireEstablishedCtx()
				return new OnboardingTasksEngine(ctx)
			}

			case 'invitations': {
				const ctx = this.requireEstablishedCtx()
				return new InvitationEngine(ctx)
			}

			default:
				throw new Error(`EngineFactory: unknown engine type "${engineName}"`)
		}
	}

	/**
	 * Read the established EngineContext for the current network via the D-10 accessor.
	 *
	 * Throws a clear error (rather than passing undefined to a sibling constructor)
	 * when no network has been opened yet — Pitfall 3 / T-15-03-03 landmine guard.
	 * Call getEngine('network', ref) first to establish the ctx.
	 */
	private requireEstablishedCtx(): EngineContext {
		if (this.currentNetworkHash === undefined) {
			throw new Error(
				'EngineFactory: Network context not established — call getEngine("network", ref) first',
			)
		}
		const ctx = this.networksEngine.getEstablishedContext(this.currentNetworkHash)
		if (ctx === undefined) {
			throw new Error(
				`EngineFactory: Network context not established for hash ${this.currentNetworkHash} — call getEngine("network", ref) first`,
			)
		}
		return ctx
	}
}
