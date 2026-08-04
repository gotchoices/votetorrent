/**
 * EngineFactory — Phase 44-02 (D-03/D-04/D-05).
 *
 * Single construction point for ALL engines in the voter app. Lives in the app layer
 * because it holds `rnDbFactory` (RN-specific via rn-leveldb /
 * @optimystic/db-p2p-storage-rn) — RN-specific deps MUST NOT appear under
 * packages/vote-engine/.
 *
 * Ported from the authority app's `engine-factory.ts` (44-PATTERNS.md), with:
 *   - the attestation-key-material imports (`attestation-roots.generated`,
 *     `attestation-status.generated`, `attestation-keys.generated`, and the real
 *     Play-Integrity-backed verifier class) STRIPPED — the voter app has no real
 *     device-attestation verifier this phase;
 *   - a net-new `'registration'` case (RegistrationEngine — voter-app only, the
 *     authority app never builds one);
 *   - the `'association'` case UNCONDITIONALLY hardcoding `StubAttestationVerifier`
 *     (44-RESEARCH.md Open Question 2 — no real voter-side verifier exists yet;
 *     T-44-06 mitigation: this seam is explicit and reviewable, not a silent stub).
 *
 * Lifecycle:
 *   - One EngineFactory instance per VoterAppProvider (useRef, app-lifetime).
 *   - One NetworksEngine wrapping the shared LevelDB factory.
 *   - Sibling engines are lazily built and cached by name (+JSON-serialized initParams).
 *   - clearEngineCache() wipes ALL cached engines for a clean switch (uniform clear-all).
 *
 * Security: factory holds ctx internally; screens receive only IXxxEngine instances.
 * getEstablishedContext result never returned to VoterAppProvider/screens.
 * factory never calls rnDbFactory(hash) twice — only via networksEngine.open()/create()
 * which is cache-first.
 */

import type { NetworkReference, User, IAttestationVerifier } from '@votetorrent/vote-core'
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
	AssociationEngine,
	StubAttestationVerifier,
	RegistrationEngine,
} from '@votetorrent/vote-engine/rn'
import type { DbFactory, EngineContext, ElectionSubject } from '@votetorrent/vote-engine/rn'
import { rnDbFactory, createStrandDbFactory } from './rn-db-factory'
import type { StrandHost } from './rn-db-factory'
import { USE_LOCAL_DB_FACTORY } from './proof-flags.generated'

export class EngineFactory {
	private readonly networksEngine: NetworksEngine
	/** Cache keyed by engineName (+ ':' + JSON(initParams) for param-keyed engines). */
	private readonly engineCache = new Map<string, unknown>()
	/** The hash of the most recently opened/created network; gates requireEstablishedCtx. */
	private currentNetworkHash: string | undefined
	/** The resolved device user to bind into ctx on every internal open() call. */
	private currentUser: User | undefined

	/**
	 * Live peer-count source, keyed by strandId (== networkHash, D-05).
	 * Registered by CadreNodeProvider after the CadreNode boots. When set, the
	 * network engine reports connected peers in getStatistics; absent, it falls
	 * back to the relay-count heuristic.
	 */
	private getPeerCount: ((strandId: string) => number) | undefined

	/** Called by VoterAppProvider after resolving the device user, before getEngine("network"). */
	setCurrentUser(user: User | undefined): void {
		this.currentUser = user
	}

	/** Called by CadreNodeProvider after boot to wire live peer counts into NetworkEngine. */
	setGetPeerCount(getPeerCount: (strandId: string) => number): void {
		this.getPeerCount = getPeerCount
	}

	/**
	 * D-04: The booted CadreNode (mirrors setGetPeerCount pattern).
	 * When non-null AND USE_LOCAL_DB_FACTORY is false, the DbFactory delegates to
	 * createStrandDbFactory(node); otherwise falls back to rnDbFactory (solo-safe).
	 * Set by VoterAppProvider in the same useEffect that registers setGetPeerCount.
	 */
	private node: StrandHost | null = null

	/** Called by VoterAppProvider when the CadreNode boots (mirrors setGetPeerCount / D-04). */
	setNode(node: StrandHost | null): void {
		this.node = node
	}

	constructor(
		private readonly localStorage: LocalStorageReact,
		private readonly rnDbFactory: DbFactory,
	) {
		// Construct NetworksEngine once — it owns the per-network ctx lifecycle.
		// Never call rnDbFactory directly from the factory.
		//
		// D-04: lazy-dispatch DbFactory — delegates to createStrandDbFactory(node) when a
		// node is set and the __DEV__ escape hatch USE_LOCAL_DB_FACTORY is false;
		// otherwise falls back to the injected rnDbFactory (solo-safe / no regression).
		// Never call createStrandDbFactory(null) — guard on this.node truthy.
		this.networksEngine = new NetworksEngine(localStorage, async (networkHash: string) => {
			if (this.node && !(__DEV__ && USE_LOCAL_DB_FACTORY)) {
				return createStrandDbFactory(this.node)(networkHash)
			}
			return this.rnDbFactory(networkHash)
		})
	}

	/** Expose the shared NetworksEngine for initialize() in VoterAppProvider. */
	getNetworksEngine(): NetworksEngine {
		return this.networksEngine
	}

	/**
	 * Clear ALL cached sibling engines (uniform clear-all on network switch).
	 * Must be called by VoterAppProvider on network switch or "Start Fresh" (not by
	 * the factory). After clearing, engines are rebuilt lazily on the next getEngine() call.
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
		// Detect a NETWORK SWITCH before the cache-hit short-circuit. cacheKey('network')
		// is a CONSTANT 'network', so without this guard a getEngine('network', refB) with
		// a DIFFERENT hash would HIT the boot-time entry and never re-point currentNetworkHash.
		// When the caller asks for a network whose hash differs from the currently-established
		// one, evict the stale 'network' entry + ctx-dependent siblings so buildEngine re-opens
		// against the new ref. Param-less / same-hash calls fall through unchanged.
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
	 * Evict the 'network' entry and every ctx-dependent sibling so they re-bind
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
		// The "network" engine is a singleton for the currently-established network.
		// Screens call getEngine("network") with no params while VoterAppProvider
		// establishes it via getEngine("network", ref); both MUST resolve to the SAME
		// cache entry. Force a stable, param-free key for "network" so the screen call
		// is a cache HIT rather than re-entering buildEngine with undefined initParams
		// (which dereferences ref.hash → crash).
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
	 * Covers: network, defaultUser, user, authority, elections, signing, election,
	 * keysTasksEngine, signatureTasksEngine, onboardingTasksEngine, invitations,
	 * association, registration.
	 *
	 * For sibling engines that require a live EngineContext, call
	 * requireEstablishedCtx() which throws if no ctx is yet established
	 * (never pass undefined to constructors).
	 */
	private async buildEngine(engineName: string, initParams?: unknown): Promise<unknown> {
		switch (engineName) {
			case 'network': {
				// open() is cache-first inside NetworksEngine.
				// It establishes ctx in the contexts Map and returns a NetworkEngine.
				// We track the hash so requireEstablishedCtx() can look it up.
				//
				// Screens call getEngine("network") with NO params; VoterAppProvider
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
				// Auto-open so screen-initiated network resolution works.
				// Thread the resolved device user so ctx.user is a real User after boot.
				// Forward a live peer-count closure keyed by this network's hash
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
				// uniform clear-all for simplicity.
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

			case 'registration': {
				// Voter-app net-new (not present in the authority factory — the authority
				// app never builds RegistrationEngine).
				const ctx = this.requireEstablishedCtx()
				return new RegistrationEngine(ctx)
			}

			case 'association': {
				// T-44-06: no real voter-side attestation verifier exists yet this phase —
				// hardcode StubAttestationVerifier unconditionally (44-RESEARCH.md Open
				// Question 2). Kept as a single `verifier` local so a later __DEV__ gate
				// (mirroring the authority app's USE_STUB_ATTESTATION_VERIFIER convention)
				// can be re-added without restructuring this case.
				const ctx = this.requireEstablishedCtx()
				const verifier: IAttestationVerifier = new StubAttestationVerifier()
				return new AssociationEngine(ctx, verifier)
			}

			default:
				throw new Error(`EngineFactory: unknown engine type "${engineName}"`)
		}
	}

	/**
	 * Read the established EngineContext for the current network.
	 *
	 * Throws a clear error (rather than passing undefined to a sibling constructor)
	 * when no network has been opened yet. Call getEngine('network', ref) first to
	 * establish the ctx.
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
