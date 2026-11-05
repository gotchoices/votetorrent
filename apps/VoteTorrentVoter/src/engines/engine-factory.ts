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
 *   - the `'association'` case selecting its verifier through
 *     `selectAttestationVerifier` (`attestation-verifier.ts`): the stub ONLY under
 *     `__DEV__ && USE_STUB_ATTESTATION_VERIFIER`, otherwise a fail-closed verifier —
 *     the voter never verifies attestations, the authority does.
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
	KeyReleaseEngine,
	SignatureTasksEngine,
	OnboardingTasksEngine,
	InvitationEngine,
	LocalStorageReact,
	AssociationEngine,
	RegistrationEngine,
	ElectionResultsEngine,
	TallyPublicationEngine,
} from '@votetorrent/vote-engine/rn'
import type { DbFactory, EngineContext, ElectionSubject } from '@votetorrent/vote-engine/rn'
import { rnDbFactory, createStrandDbFactory } from './rn-db-factory'
import { takeFounderIntent, peekFounderIntent, wrapCreateWithFounding, FounderIntentBusyError } from './founder-intent'
import { readNetworkBackend, recordNetworkBackend } from './network-backend-store'
import type { StrandHost } from './rn-db-factory'
type DbHandle = Awaited<ReturnType<DbFactory>>
import { USE_LOCAL_DB_FACTORY, USE_STUB_ATTESTATION_VERIFIER } from './proof-flags.generated'
import { selectAttestationVerifier } from './attestation-verifier'
import { createVoterStrandPort } from './strand-port-adapter'
import { createVoterRequestTransportSource, VOTER_REQUEST_TRANSPORTS_ENGINE } from './voter-request-transports'
import { createVoteSendingPort, VOTE_SENDING_PORT_ENGINE } from './vote-sending-port'
import { readJoinedNetworkHashes } from './join-bootstrap'

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

	/**
	 * First-sync gate wiring (quick task 260928-kkf — mirrors the authority app's
	 * engine-factory.ts; see strand-first-sync.ts / rn-db-factory.ts's
	 * `createStrandDbFactory` doc comments for the full gate semantics). One
	 * AbortController "owns" every `whenStrandWritable` wait a strand-backed
	 * DbFactory call is currently running; replacing it cancels whatever wait was
	 * pending, without touching future ones.
	 */
	private firstSyncAbort = new AbortController()

	/**
	 * D-32 (Phase 62 Plan 22): tracks which established network hashes went through the strand
	 * path (vs. the solo/local-DB fallback) on their DbFactory call, so the `'requestTransports'`
	 * case can pass the right `peerBacked` flag without re-deriving it from `this.node` (which may
	 * have changed since the network was opened). Entries are added only AFTER
	 * `createStrandDbFactory(...)(networkHash)` resolves — never speculatively — and are never
	 * cleared: `NetworksEngine` caches each ctx for the session, so the marker stays true for the
	 * ctx it describes even across a later `setNode(null)`.
	 */
	private readonly strandBackedNetworks = new Set<string>()
	/**
	 * Fires once per pending open, BEFORE the wait begins (never on retry), so a
	 * caller (VoterAppProvider) can flip a "still syncing" UI flag. Registered via
	 * `setFirstSyncListener`; cleared on unmount.
	 */
	private firstSyncListener: ((strandId: string) => void) | undefined

	/** Registers (or, passed undefined, deregisters) the first-sync "still syncing" callback. */
	setFirstSyncListener(listener: ((strandId: string) => void) | undefined): void {
		this.firstSyncListener = listener
	}

	/**
	 * Cancels any `whenStrandWritable` wait currently in flight (via the shared
	 * AbortController) and arms a fresh controller for the NEXT strand-backed open.
	 * Called on a genuine node change (setNode below), on clearEngineCache()
	 * (network switch / Start Fresh), and by VoterAppProvider on unmount / a
	 * superseded boot run.
	 */
	cancelPendingStrandWaits(): void {
		this.firstSyncAbort.abort()
		this.firstSyncAbort = new AbortController()
	}

	/**
	 * Called by VoterAppProvider when the CadreNode boots (mirrors setGetPeerCount / D-04).
	 *
	 * Cancels any pending first-sync wait ONLY when `node` actually changes — the
	 * provider's peer-count effect re-invokes `setNode` with the SAME node on every
	 * `connectedPeers` change, and aborting then would kill a live wait for no reason.
	 */
	/** The strand id (== network hash) of the network engines currently open on, if any. */
	getCurrentNetworkHash(): string | undefined {
		return this.currentNetworkHash
	}

	setNode(node: StrandHost | null): void {
		if (node !== this.node) {
			this.cancelPendingStrandWaits()
		}
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
		//
		// D-98 (UAT 65 gap 4): an iPhone Debug install launches twice. Launch 1 seeds the dev network on
		// the SOLO store (node not up); launch 2 re-attaches it once the node is set, and a node-based
		// dispatch would open an empty strand store as a JOINER that waits for a Header nobody can push.
		// So the store that CREATED a network is recorded per hash and a solo-created network re-opens
		// on the solo store. Joined networks are never created here, so they have no record and keep
		// the node-based dispatch.
		this.networksEngine = new NetworksEngine(localStorage, async (networkHash: string) => {
			const creating = peekFounderIntent() === 'founding'
			const useStrand = (): boolean => !!this.node && !(__DEV__ && USE_LOCAL_DB_FACTORY)
			const openStrand = (): Promise<DbHandle> => {
				const node = this.node as StrandHost
				// The signal is read AT CALL TIME (not captured once) so a controller
				// swapped in by a later cancelPendingStrandWaits() is the one this call
				// actually waits on.
				return createStrandDbFactory(node, {
					signal: this.firstSyncAbort.signal,
					onAwaitingFirstSync: (id) => this.firstSyncListener?.(id),
					isJoinedNetwork: async (id) => (await readJoinedNetworkHashes()).includes(id),
				})(networkHash)
			}
			const finishStrand = async (pending: Promise<DbHandle>): Promise<DbHandle> => {
				const db = await pending
				// D-32: mark this hash peer-backed only AFTER the strand factory resolved —
				// never speculatively before the call.
				this.strandBackedNetworks.add(networkHash)
				return db
			}
			const openSolo = (): Promise<DbHandle> => {
				// D-30: the solo store has no founder flag, but this open still claims (and so frees) a
				// founding window installed for it, exactly as the strand factory's first statement does.
				takeFounderIntent(networkHash)
				return this.rnDbFactory(networkHash)
			}

			if (creating) {
				// Nothing is awaited before the open starts (D-30): the factory's synchronous first
				// statement takes the founding intent. Only then is the creating store recorded, and the
				// record lands before the open resolves, hence before create writes any network data.
				const strand = useStrand()
				const pending = strand ? openStrand() : openSolo()
				// Observed at once (round-1 WR-03): an open that rejects while the record below is being
				// written must not be reported as an unhandled rejection. The caller still gets the
				// rejection through the `pending` returned below.
				void pending.catch(() => undefined)
				try {
					await recordNetworkBackend(networkHash, strand ? 'strand' : 'solo')
				} catch {
					// A failed record must not fail the open (dev-seed-only residual hole).
				}
				return strand ? finishStrand(pending) : pending
			}

			const backend = await readNetworkBackend(networkHash)
			// A create started during the await above: never consume its founding window.
			if (peekFounderIntent() === 'founding') throw new FounderIntentBusyError()
			if (backend === 'solo') return openSolo()
			if (useStrand()) return finishStrand(openStrand())
			return openSolo()
		})
		// D-30 (the Authority's, ported): a network this factory CREATES (the __DEV__ dev seed's
		// NetworksEngine.create) founds even while the control node holds a relay connection. A join or
		// a re-open never calls create, so it keeps the default.
		wrapCreateWithFounding(this.networksEngine)
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
		// A network switch / Start Fresh must not leave a stale first-sync wait
		// running in the background against a network the user has just left.
		this.cancelPendingStrandWaits()
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
	 * keysTasksEngine, keyRelease, signatureTasksEngine, onboardingTasksEngine, invitations,
	 * association, registration, requestTransports.
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

			case 'keyRelease': {
				// Read-only release status (D-17): the Voter never holds a share, so this engine is
				// built with NO vault and no deps. `getKeyReleaseStatus` never needs one.
				const ctx = this.requireEstablishedCtx()
				return new KeyReleaseEngine(ctx)
			}

			case 'electionResults': {
				// Decrypt + validate + tally after the key release, from the replicated election data. Read-only:
				// the election secret is rebuilt from the PUBLIC released shares in memory and zero-filled.
				const ctx = this.requireEstablishedCtx()
				return new ElectionResultsEngine(ctx)
			}

			case 'tallyPublication': {
				// The published, officer-signed tally (ElectionTally): read it back with its checks; on an officer's
				// device, publish the tally computed by 'electionResults'. Signs only through the caller's signer.
				const ctx = this.requireEstablishedCtx()
				return new TallyPublicationEngine(ctx)
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

			case VOTER_REQUEST_TRANSPORTS_ENGINE: {
				// D-28/D-32: the joined network's OWN strand database is the delivery target —
				// strandId = currentNetworkHash (the value createStrandDbFactory passed to
				// addStrand). The raw port never leaves this factory: the screen layer gets only
				// the source's typed transports back from resolve(), matching this file's
				// "screens receive only engine-shaped objects" rule.
				const ctx = this.requireEstablishedCtx()
				const hash = this.currentNetworkHash!
				return createVoterRequestTransportSource({
					strandId: hash,
					port: createVoterStrandPort(ctx.db),
					peerBacked: this.strandBackedNetworks.has(hash),
				})
			}

			case VOTE_SENDING_PORT_ENGINE: {
				// Spike 102: the send flow's view of the joined network's strand (election key, voting
				// window, the one-transaction block commit, the recorded-vote lookup). Like the request
				// transports above, the raw database never leaves this factory.
				const ctx = this.requireEstablishedCtx()
				return createVoteSendingPort(ctx.db)
			}

			case 'association': {
				// The stub is selected ONLY under an explicit __DEV__ dev gate (mirroring the
				// authority app's USE_STUB_ATTESTATION_VERIFIER convention), never a silent prod
				// fallback. The non-stub branch fails closed — see attestation-verifier.ts for
				// why the voter does not carry the authority's real verifier.
				const ctx = this.requireEstablishedCtx()
				const verifier: IAttestationVerifier = selectAttestationVerifier(__DEV__, USE_STUB_ATTESTATION_VERIFIER)
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
