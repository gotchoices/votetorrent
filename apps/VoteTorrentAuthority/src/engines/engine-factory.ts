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
 * getEstablishedContext result never returned to AppProvider/screens (T-15-03-04); the factory also
 * attaches the officer's intake opener (D-49) to that ctx, which is still never returned.
 * factory never calls rnDbFactory(hash) twice — only via networksEngine.open()/create()
 * which is cache-first (T-15-03-05 / Pitfall 2).
 */

import type { NetworkReference, User, IAttestationVerifier } from '@votetorrent/vote-core';
import type { ExpectedAppIdentity } from '@votetorrent/vote-engine/rn';
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
	PlayIntegrityVerifier,
	StubAttestationVerifier,
	AppAttestVerifier,
	PlatformDispatchingAttestationVerifier,
	LocalConfigKeyProvider,
	RegistrationEngine,
	AuthorityConfigEngine,
	IntakeEngine,
	P2pRegistrationTransport,
	P2pAssociationTransport,
	KeyholderDkgEngine,
	ElectionResultsEngine,
} from '@votetorrent/vote-engine/rn';
import type { DbFactory, EngineContext, ElectionSubject, StagingOpener, StagingDecisionSigner } from '@votetorrent/vote-engine/rn';
import type { BootstrapSnapshot } from '@votetorrent/vote-engine/bootstrap';
import { createStrandDbFactory } from './rn-db-factory';
import { wrapCreateWithFounding } from './founder-intent';
import { isJoinedNetwork } from './joined-networks';
import type { StrandHost } from './rn-db-factory';
import { createStrandPort } from './strand-port-adapter';
import type { StrandSqlDatabase } from './strand-port-adapter';
import { resolveKeyholderKeyVault } from './keyholder-vault';
import { resolveAuthorityKeyVault } from './key-vault';
import { USE_LOCAL_DB_FACTORY, USE_STUB_ATTESTATION_VERIFIER } from './proof-flags.generated';
import { PINNED_HARDWARE_ROOTS_DER } from './attestation-roots.generated';
import { REVOKED_ATTESTATION_SERIALS } from './attestation-status.generated';
import {
	EXPECTED_APP_PACKAGE,
	buildExpectedCertDigests,
	PLAY_CONSOLE_DECRYPTION_KEY_BASE64,
	PLAY_CONSOLE_VERIFICATION_KEY_BASE64,
} from './attestation-keys.generated';
import {
	PINNED_APP_ATTEST_ROOTS_DER,
	APPLE_APP_ID,
	APP_ATTEST_ENVIRONMENT,
	APP_ATTEST_PROVISIONED,
} from './appattest-keys.generated';

/**
 * Thrown when an engine is requested before any network has been opened.
 *
 * This is an EXPECTED state, not a failure: on first run (and after leaving a
 * network) there is legitimately no network context yet. The message stays
 * developer-facing because it is a real invariant guard and shows up in logs —
 * but screens MUST NOT render it. Use `isNoNetworkEstablishedError()` to detect
 * this case and show the friendly "choose a network" empty state instead
 * (see components/NoNetwork.tsx). Rendering `error.message` here is what put
 * `EngineFactory: Network context not established — call getEngine(...)` on the
 * Tasks and Settings tabs.
 */
export class NoNetworkEstablishedError extends Error {
	readonly noNetworkEstablished = true as const;

	constructor(message: string) {
		super(message);
		this.name = 'NoNetworkEstablishedError';
	}
}

/**
 * True when `error` means "no network selected yet" — the expected first-run
 * state that should surface as an empty state, not an error banner. Structural
 * check (not `instanceof`) so it survives the module duplication that Metro's
 * multi-root resolution can produce on-device.
 */
export function isNoNetworkEstablishedError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { noNetworkEstablished?: unknown }).noNetworkEstablished === true
	);
}

/**
 * Thrown by `createPeerStagingTransports` when the currently-established network cannot back a
 * peer staging transport (D-32). `reason`:
 *   - `'no-network'` — no network is established at all;
 *   - `'not-strand-backed'` — the established network was opened through the solo (non-strand)
 *     `rnDbFactory`, so no peer could ever reach its store; reporting "synced" against it would be
 *     a false assurance (T-62-21-05);
 *   - `'network-changed'` — `openStrand()` was called after the app switched to a different
 *     network than the one `strandId` was captured for.
 */
export class PeerStrandUnavailableError extends Error {
	readonly peerStrandUnavailable = true as const;
	readonly reason: 'no-network' | 'not-strand-backed' | 'network-changed';

	constructor(reason: 'no-network' | 'not-strand-backed' | 'network-changed', message: string) {
		super(message);
		this.name = 'PeerStrandUnavailableError';
		this.reason = reason;
	}
}

/** Structural check (not `instanceof`), mirroring `isNoNetworkEstablishedError` above. */
export function isPeerStrandUnavailableError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { peerStrandUnavailable?: unknown }).peerStrandUnavailable === true
	);
}

/** `EngineFactory.createPeerStagingTransports`'s return shape (D-32). */
export interface PeerStagingTransports {
	strandId: string;
	registration: P2pRegistrationTransport;
	association: P2pAssociationTransport;
}

export class EngineFactory {
	private readonly networksEngine: NetworksEngine;
	/** Cache keyed by engineName (+ ':' + JSON(initParams) for param-keyed engines). */
	private readonly engineCache = new Map<string, unknown>();
	/** The hash of the most recently opened/created network; gates requireEstablishedCtx. */
	private currentNetworkHash: string | undefined;
	/** The resolved device user to bind into ctx on every internal open() call. */
	private currentUser: User | undefined;

	/**
	 * ENG-05: live peer-count source, keyed by strandId (== networkHash, D-05).
	 * Registered by CadreNodeProvider after the CadreNode boots. When set, the
	 * network engine reports connected peers in getStatistics; absent, it falls
	 * back to the relay-count heuristic.
	 */
	private getPeerCount: ((strandId: string) => number) | undefined;

	/** Called by AppProvider after resolving the device user, before getEngine("network"). */
	setCurrentUser(user: User | undefined): void {
		this.currentUser = user;
	}

	/** Called by CadreNodeProvider after boot to wire live peer counts into NetworkEngine. */
	setGetPeerCount(getPeerCount: (strandId: string) => number): void {
		this.getPeerCount = getPeerCount;
	}

	/**
	 * D-04: The booted CadreNode (mirrors setGetPeerCount pattern).
	 * When non-null AND USE_LOCAL_DB_FACTORY is false, the DbFactory delegates to
	 * createStrandDbFactory(node); otherwise falls back to rnDbFactory (solo-safe).
	 * Set by AppProvider in the same useEffect that registers setGetPeerCount.
	 */
	private node: StrandHost | null = null;

	/**
	 * D-32: the set of network hashes whose DbFactory call resolved through the strand-backed
	 * path (`createStrandDbFactory`), as opposed to the solo `rnDbFactory`. `createPeerStagingTransports`
	 * refuses `'not-strand-backed'` for any hash not in this set — a solo store can never be reached
	 * by a peer, so reporting "synced" against it would be a false assurance (T-62-21-05).
	 */
	private strandBackedNetworkHashes = new Set<string>();

	/**
	 * First-sync gate wiring (quick task 260928-kkf — see strand-first-sync.ts /
	 * rn-db-factory.ts's `createStrandDbFactory` doc comments for the full gate
	 * semantics). One AbortController "owns" every `whenStrandWritable` wait a
	 * strand-backed DbFactory call is currently running; replacing it cancels
	 * whatever wait was pending, without touching future ones.
	 */
	private firstSyncAbort = new AbortController();
	/**
	 * Fires once per pending open, BEFORE the wait begins (never on retry), so a
	 * caller (AppProvider) can flip a "still syncing" UI flag. Registered by the
	 * provider via `setFirstSyncListener`; cleared on unmount.
	 */
	private firstSyncListener: ((strandId: string) => void) | undefined;

	/** Registers (or, passed undefined, deregisters) the first-sync "still syncing" callback. */
	setFirstSyncListener(listener: ((strandId: string) => void) | undefined): void {
		this.firstSyncListener = listener;
	}

	/**
	 * Cancels any `whenStrandWritable` wait currently in flight (via the shared
	 * AbortController) and arms a fresh controller for the NEXT strand-backed open.
	 * Called on a genuine node change (setNode below), on clearEngineCache()
	 * (network switch / Start Fresh), and by AppProvider on unmount / a superseded
	 * boot run — every place a pending wait must stop being the "active" one.
	 */
	cancelPendingStrandWaits(): void {
		this.firstSyncAbort.abort();
		this.firstSyncAbort = new AbortController();
	}

	/**
	 * Called by AppProvider when the CadreNode boots (mirrors setGetPeerCount / D-04).
	 *
	 * Cancels any pending first-sync wait ONLY when `node` actually changes — the
	 * provider's peer-count effect re-invokes `setNode` with the SAME node on every
	 * `connectedPeers` change, and aborting then would kill a live wait for no reason.
	 */
	setNode(node: StrandHost | null): void {
		if (node !== this.node) {
			this.cancelPendingStrandWaits();
		}
		this.node = node;
	}

	/**
	 * D-04b: the Play Console key material `PlayIntegrityVerifier` needs to
	 * decrypt+verify a classic-API token offline. Constructed once, app-lifetime
	 * (mirrors `networksEngine`'s once-per-factory lifecycle).
	 *
	 * CR-03: the keys come from bundled config (attestation-keys.generated.ts).
	 * They are EMPTY until real per-app Play Console keys are provisioned (D-10,
	 * SETUP.md). D-09: `playConsoleKeysProvisioned` is now threaded into
	 * `PlayIntegrityVerifier`'s `keysProvisioned` constructor parameter — the
	 * 'association' case constructs UNCONDITIONALLY, and `verify()` returns
	 * `{ ok: false, reason: 'Play Console key material is not provisioned — see
	 * SETUP.md' }` while unprovisioned, so `associate()`'s own
	 * `if (!verification.ok) throw` still fails the ceremony closed. Association
	 * and registrant **reads** deliberately work without key material — they
	 * never consult the verifier. Swapping in real keys is a config-only change
	 * (D-12).
	 */
	private readonly integrityKeyProvider = new LocalConfigKeyProvider({
		decryptionKeyBase64: PLAY_CONSOLE_DECRYPTION_KEY_BASE64,
		verificationKeyBase64: PLAY_CONSOLE_VERIFICATION_KEY_BASE64,
	});

	/**
	 * CR-03/D-09: true only when BOTH Play Console keys are present (non-empty).
	 * No longer gates construction — it is injected into `PlayIntegrityVerifier`
	 * as its 5th ctor argument (`case 'association'`) and exposed read-only via
	 * `isAttestationVerifierProvisioned()`.
	 */
	private readonly playConsoleKeysProvisioned =
		PLAY_CONSOLE_DECRYPTION_KEY_BASE64.length > 0 &&
		PLAY_CONSOLE_VERIFICATION_KEY_BASE64.length > 0;

	/**
	 * CR-04/WR-03: the injected app-identity pin BOTH attestation halves enforce
	 * — the token/key must name THIS authority app (package + signing-cert
	 * digest), not merely "some genuine Play app on a genuine device". Bundled
	 * config (attestation-keys.generated.ts), swappable without a code change.
	 *
	 * CR-02 (Phase 47 review): the committed default lists ONLY the standard
	 * Android SDK debug certificate, whose private key is public. Accepting it in
	 * a release build would make this pin prove nothing, so
	 * `buildExpectedCertDigests(__DEV__)` strips public debug digests outside
	 * `__DEV__` — leaving an empty allowlist that both verifier halves reject.
	 * Release attestation fails loudly rather than trusting a public key. Adding
	 * the real voter release digest to `EXPECTED_APP_CERT_SHA256_DIGESTS` is what
	 * actually closes this.
	 */
	private readonly expectedAppIdentity: ExpectedAppIdentity = {
		packageName: EXPECTED_APP_PACKAGE,
		certificateSha256Digests: buildExpectedCertDigests(__DEV__),
	};

	constructor(
		private readonly localStorage: LocalStorageReact,
		private readonly rnDbFactory: DbFactory
	) {
		// Construct NetworksEngine once — it owns the per-network ctx lifecycle (Phase-14 seam).
		// Never call rnDbFactory directly from the factory (Pitfall 2 / T-15-03-05).
		//
		// D-04: lazy-dispatch DbFactory — delegates to createStrandDbFactory(node) when a
		// node is set and the __DEV__ escape hatch USE_LOCAL_DB_FACTORY is false;
		// otherwise falls back to the injected rnDbFactory (solo-safe / SC1 no regression).
		// RESEARCH Pitfall 1: never call createStrandDbFactory(null) — guard on this.node truthy.
		this.networksEngine = new NetworksEngine(localStorage, async (networkHash: string) => {
			if (this.node && !(__DEV__ && USE_LOCAL_DB_FACTORY)) {
				// The signal is read AT CALL TIME (not captured once) so a controller
				// swapped in by a later cancelPendingStrandWaits() is the one this call
				// actually waits on.
				this.strandBackedNetworkHashes.add(networkHash);
				return createStrandDbFactory(this.node, {
					signal: this.firstSyncAbort.signal,
					onAwaitingFirstSync: (id) => this.firstSyncListener?.(id),
					isJoinedNetwork: (strandId) => isJoinedNetwork(strandId),
				})(networkHash);
			}
			this.strandBackedNetworkHashes.delete(networkHash);
			return this.rnDbFactory(networkHash);
		});
		// D-30: the founding window around the create path that Add Network's
		// `buildCreate().commit()` reaches. It is set here and never in a screen. Import and join
		// do not call `create`, so they keep the default.
		wrapCreateWithFounding(this.networksEngine);
	}

	/** Expose the shared NetworksEngine for initialize() in AppProvider. */
	getNetworksEngine(): NetworksEngine {
		return this.networksEngine;
	}

	/**
	 * D-14: Clear ALL cached sibling engines (uniform clear-all on network switch).
	 * Must be called by AppProvider on network switch or "Start Fresh" (not by the factory).
	 * After clearing, engines are rebuilt lazily on the next getEngine() call.
	 */
	clearEngineCache(): void {
		this.engineCache.clear();
		this.currentNetworkHash = undefined;
		// A network switch / Start Fresh must not leave a stale first-sync wait
		// running in the background against a network the user has just left.
		this.cancelPendingStrandWaits();
	}

	/** True if the named engine (with optional initParams) is already cached. */
	hasEngine(engineName: string, initParams?: unknown): boolean {
		const key = this.cacheKey(engineName, initParams);
		return this.engineCache.has(key);
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
			const ref = initParams as NetworkReference | undefined;
			if (
				ref?.hash !== undefined &&
				this.currentNetworkHash !== undefined &&
				ref.hash !== this.currentNetworkHash
			) {
				this.evictNetworkScopedEngines();
			}
		}

		const key = this.cacheKey(engineName, initParams);
		if (this.engineCache.has(key)) {
			return this.engineCache.get(key) as T;
		}
		const engine = await this.buildEngine(engineName, initParams);
		this.engineCache.set(key, engine);
		return engine as T;
	}

	/**
	 * D-09: the device-attestation capability probe. Bare getter — no ctx, no
	 * established network, no scope gate required. Key provisioning is a
	 * build/device concern independent of any network, so this is callable on
	 * a bare `new EngineFactory(...)` before any network has been opened.
	 * Consumed by `AttestationProvisioningStatusScreen` (47-19) and the inline
	 * banner on the challenge-admin surface (47-16), both via AppProvider's
	 * `isAttestationVerifierProvisioned` passthrough.
	 *
	 * SCOPE, since Phase 51 wired a second platform in: this reports the
	 * ANDROID half only. It is deliberately NOT widened to
	 * `playConsoleKeysProvisioned && APP_ATTEST_PROVISIONED` — the two halves
	 * fail closed independently inside the dispatcher, so an authority with
	 * working Play Console keys and no Apple root verifies Android devices
	 * correctly and should not be told its verifier is unprovisioned. Surfacing
	 * the iOS half is a UI change (a per-platform banner on
	 * AttestationProvisioningStatusScreen), not a factory change, and is not
	 * done here.
	 */
	isAttestationVerifierProvisioned(): boolean {
		return this.playConsoleKeysProvisioned;
	}

	/**
	 * 50-07 (D-07/D-09/D-13): the dashboard producer's snapshot seam. Calls
	 * `requireEstablishedCtx()` and passes `ctx.db` — together with the
	 * currently-established network's hash — to `exportDatabaseSnapshot`,
	 * returning the resulting 50-02 envelope.
	 *
	 * Preserves the SAME security rule `isAttestationVerifierProvisioned` and every
	 * sibling method above it already hold: the factory keeps `ctx` internal, and
	 * the caller (ultimately `DashboardSignInCodeScreen` via `AppProvider`) receives
	 * a snapshot VALUE, never a `Database` handle. That distinction is load-bearing
	 * here specifically because tier-2 authorization (`iad` / `ik`) has zero schema
	 * sites — it exists only as `context.Is*Valid` checks inside the engine layer —
	 * so a caller holding a raw `Database` handle would silently lose it. Phase 50
	 * makes no writes, and this read path must not become the precedent that erodes
	 * that rule: no `getDatabase()` is added here, and `ctx` itself is never
	 * returned.
	 *
	 * The producer module is imported LAZILY (dynamic `import()`, not a
	 * top-level `import`) rather than alongside this file's other engine
	 * imports above. `dashboard-bootstrap-producer.ts` pulls in
	 * `@votetorrent/vote-engine/bootstrap`, whose `snapshot-codec.ts` transitively
	 * reaches `database/initialize.ts`'s module-scope crypto-plugin registration
	 * (`FunctionFlags.UTF8` read at import time) — harmless in the real app, but
	 * `rn-db-factory.test.ts` virtual-mocks `@quereus/quereus` with a narrower
	 * surface that doesn't include `FunctionFlags`, so a top-level import here
	 * broke that PRE-EXISTING suite purely by being reachable from this file's
	 * module graph, without this method ever being called. Deferring the import
	 * to call time keeps every non-dashboard consumer of `EngineFactory`
	 * byte-for-byte unaffected by Phase 50's new dependency.
	 */
	async exportDashboardSnapshot(): Promise<BootstrapSnapshot> {
		const ctx = this.requireEstablishedCtx();
		const { exportDatabaseSnapshot } = await import('../services/dashboard-bootstrap-producer');
		return exportDatabaseSnapshot(ctx.db, this.currentNetworkHash!);
	}

	/**
	 * D-32: constructs the two staging-only P2P transports (`PeerStagingTransports`), bound to
	 * `strandId = currentNetworkHash` (matching `rn-db-factory.ts`'s own `strandId = networkHash`
	 * convention). The caller receives two transports, never a Database — the port is built AND
	 * consumed entirely inside this method, preserving the same no-raw-accessor rule
	 * `exportDashboardSnapshot`'s doc comment states above.
	 *
	 * Refuses `PeerStrandUnavailableError`:
	 *   - `'no-network'` when no network is established;
	 *   - `'not-strand-backed'` when the established network was opened solo (not via
	 *     `createStrandDbFactory`) — a solo store can never be reached by a peer (T-62-21-05);
	 *   - `'network-changed'` (thrown lazily, by `openStrand`, not here) if the app switches to a
	 *     different network between construction and first use.
	 *
	 * Neither transport is given a `sealer` — the Authority app never submits staged requests, it
	 * only intakes and decides them, so `computeDigest`/`computeAttestationDigest` are refusing
	 * stubs that reject if ever called (submission is a REQUESTER-side-only operation). The strand
	 * port is built and consumed entirely inside this method, the same no-raw-handle rule the
	 * comment above this one already states for the dashboard snapshot seam.
	 */
	createPeerStagingTransports(deps: { opener: StagingOpener; decisionSigner: StagingDecisionSigner }): PeerStagingTransports {
		if (this.currentNetworkHash === undefined) {
			throw new PeerStrandUnavailableError('no-network', 'EngineFactory.createPeerStagingTransports: no network established');
		}
		if (!this.strandBackedNetworkHashes.has(this.currentNetworkHash)) {
			throw new PeerStrandUnavailableError(
				'not-strand-backed',
				'EngineFactory.createPeerStagingTransports: the established network was opened solo, not strand-backed — no peer could ever reach it'
			);
		}
		const strandId = this.currentNetworkHash;

		const refuseSubmit = async (..._args: unknown[]): Promise<Uint8Array> => {
			throw new Error('The authority app never submits staged requests');
		};

		const openStrand = async () => {
			const ctx = this.requireEstablishedCtx();
			if (this.currentNetworkHash !== strandId) {
				throw new PeerStrandUnavailableError(
					'network-changed',
					'EngineFactory.createPeerStagingTransports: the app switched to a different network since this transport was constructed'
				);
			}
			// The real Quereus `Database`'s `eval`/`exec` param types (`SqlParameters | SqlValue[]`)
			// are narrower than `StrandSqlDatabase`'s engine-agnostic `Record<string, unknown>` —
			// the same structural-fit cast `intake/query-port.ts`'s `intakeQueryPortFromDb` makes at
			// its own call site. No behavior change: `createStrandPort` only ever forwards `params`
			// through unchanged.
			return createStrandPort(ctx.db as unknown as StrandSqlDatabase);
		};

		const registration = new P2pRegistrationTransport({
			openStrand,
			computeDigest: refuseSubmit,
			strandId,
			opener: deps.opener,
			decisionSigner: deps.decisionSigner,
		});
		const association = new P2pAssociationTransport({
			openStrand,
			computeDigest: refuseSubmit,
			computeAttestationDigest: refuseSubmit,
			strandId,
			opener: deps.opener,
			decisionSigner: deps.decisionSigner,
		});

		return { strandId, registration, association };
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
			if (key === 'defaultUser') continue;
			this.engineCache.delete(key);
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
			return 'network';
		}
		return initParams !== undefined ? `${engineName}:${JSON.stringify(initParams)}` : engineName;
	}

	/**
	 * Build a fresh engine instance for the given name.
	 *
	 * Covers all 16 engine names this switch handles:
	 *   network, defaultUser, user, authority,
	 *   elections, signing, registration, authorityConfig, intake, election, keysTasksEngine,
	 *   keyholderDkg, signatureTasksEngine, onboardingTasksEngine, invitations, association.
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
				const ref =
					(initParams as NetworkReference | undefined) ??
					(this.currentNetworkHash !== undefined
						? ({ hash: this.currentNetworkHash } as NetworkReference)
						: undefined);
				if (ref === undefined) {
					throw new NoNetworkEstablishedError(
						'EngineFactory: no network established — call getEngine("network", ref) during init'
					);
				}
				// Q3 open question 3: auto-open so screen-initiated network resolution works.
				// Thread the resolved device user so ctx.user is a real User after boot.
				// ENG-05: forward a live peer-count closure keyed by this network's hash
				// (== strandId, D-05) so NetworkEngine.getStatistics reports connected peers.
				// The closure reads getPeerCount lazily at call time, so it picks up the
				// CadreNodeProvider registration even if it lands after open().
				const peerCount = (): number => this.getPeerCount?.(ref.hash) ?? 0;
				const networkEngine = await this.networksEngine.open(
					ref,
					this.currentUser,
					true,
					peerCount
				);
				this.currentNetworkHash = ref.hash;
				return networkEngine;
			}

			case 'defaultUser':
				// LocalStorage-backed only — no ctx required. Cheap to rebuild; included in
				// uniform clear-all (D-14) for simplicity.
				return new DefaultUserEngine(this.localStorage);

			case 'user': {
				// Delegates to the cached NetworkEngine — not constructed directly.
				// Requires "network" to have been built first.
				const networkEngine = this.engineCache.get('network') as NetworkEngine | undefined;
				if (!networkEngine) {
					throw new Error('EngineFactory: "network" must be built before "user"');
				}
				return networkEngine.getCurrentUser();
			}

			case 'authority': {
				// Delegates to the cached NetworkEngine; initParams is the authority ID string.
				const networkEngine = this.engineCache.get('network') as NetworkEngine | undefined;
				if (!networkEngine) {
					throw new Error('EngineFactory: "network" must be built before "authority"');
				}
				return networkEngine.openAuthority(initParams as string);
			}

			case 'elections': {
				const ctx = this.requireEstablishedCtx();
				return new ElectionsEngine(ctx);
			}

			case 'signing': {
				const ctx = this.requireEstablishedCtx();
				return new SigningEngine(ctx);
			}

			case 'registration': {
				// Phase 46 (D-06): plumbing for RegistrationPolicyScreen (46-05..46-08).
				// T-46-03: the factory grants no authorization — requireEstablishedCtx()
				// is a network-lifecycle guard only. The real access control on every
				// policy write is the 'mel' AdminSignature CHECK enforced in the schema
				// (MutationValid/DeleteValid on ElectionRegistrationField /
				// ElectionDisclosurePolicy / ElectionAttestationPolicy). Any future UI
				// scope gate (D-10) is convenience, not a boundary.
				const ctx = this.requireEstablishedCtx();
				return new RegistrationEngine(ctx);
			}

			case 'authorityConfig': {
				// Phase 47 (D-09/Pattern 2): AuthorityPeer ('cap' scope) / PollingDevice
				// ('vrg' scope) administration. T-46-03 spirit: requireEstablishedCtx()
				// is a network-lifecycle guard only and grants NO authorization — the
				// real access control on every AuthorityPeer/PollingDevice mutation is
				// the schema's InsertValid/DeleteValid AdminSignature CHECK ('cap' for
				// peers, 'vrg' for polling devices). 47-17/47-18's UI scope gates
				// (useCurrentOfficerScopes()) are convenience, not a boundary.
				const ctx = this.requireEstablishedCtx();
				return new AuthorityConfigEngine(ctx);
			}

			case 'intake': {
				// D-32/D-04: the IntakeEngine over the established ctx — same lifecycle guard as
				// every other ctx-dependent sibling (requireEstablishedCtx rejects
				// NoNetworkEstablishedError with no network open).
				const ctx = this.requireEstablishedCtx();
				return new IntakeEngine(ctx);
			}

			case 'election': {
				// Real ElectionEngine requires ElectionSubject (id + authorityId).
				// initParams must carry ElectionSubject — unlike the mock which ignored it.
				const ctx = this.requireEstablishedCtx();
				return new ElectionEngine(initParams as ElectionSubject, ctx);
			}

			case 'keysTasksEngine': {
				// 62-26 (62-20 assignment): without the keyholder vault, 62-20's release-task
				// seeding finds no local keyholder (its `vault.hasSecret` check on
				// `keyholderDkgShareAlias` never matches) and no release task ever appears —
				// fail-closed, not a bug. `resolveKeyholderKeyVault()` is the SAME auth-required
				// vault `keyholderDkg` below uses; `hasSecret` itself never prompts.
				const ctx = this.requireEstablishedCtx();
				const ref = { hash: this.currentNetworkHash! } as NetworkReference;
				return new KeysTasksEngine(ref, ctx, { vault: resolveKeyholderKeyVault() });
			}

			case 'keyholderDkg': {
				// 62-26 (D-16/D-19): the keyholder DKG round driver, over the SAME auth-required
				// keyholder vault as 'keysTasksEngine' above — every round secret and share this
				// engine ever touches lives only in that vault.
				const ctx = this.requireEstablishedCtx();
				return new KeyholderDkgEngine(ctx, { vault: resolveKeyholderKeyVault() });
			}

			case 'electionResults': {
				// Decrypt + validate + tally after the key release. Read-only: reconstructs the election secret from the
				// PUBLIC released shares in memory and zero-fills it; needs no vault and no signer.
				const ctx = this.requireEstablishedCtx();
				return new ElectionResultsEngine(ctx);
			}

			case 'signatureTasksEngine': {
				const ctx = this.requireEstablishedCtx();
				const ref = { hash: this.currentNetworkHash! } as NetworkReference;
				return new SignatureTasksEngine(ref, ctx);
			}

			case 'onboardingTasksEngine': {
				const ctx = this.requireEstablishedCtx();
				return new OnboardingTasksEngine(ctx);
			}

			case 'invitations': {
				const ctx = this.requireEstablishedCtx();
				return new InvitationEngine(ctx);
			}

			case 'association': {
				// D-12/D-13/D-14: the real PlayIntegrityVerifier is the DEFAULT — the
				// stub is selected ONLY under an explicit __DEV__ dev gate, never a
				// silent prod fallback. The gate lives HERE in the factory, never
				// inside AssociationEngine/PlayIntegrityVerifier (D-12 seam-never-changes).
				const ctx = this.requireEstablishedCtx();
				const useStub = __DEV__ && USE_STUB_ATTESTATION_VERIFIER;
				// D-09: the CR-03 fail-closed decision is unchanged in EFFECT but no
				// longer lives here as a construction-time throw — it now lives inside
				// PlayIntegrityVerifier.verify() (47-03), so the engine constructs
				// UNCONDITIONALLY and association/registrant READS are never blocked by
				// absent key material. associate()'s `if (!verification.ok) throw`
				// (association-engine.ts:279-283) is what still converts the tuple back
				// into fail-closed behavior for the WRITE ceremony.
				//
				// CRITICAL: omitting this 5th argument silently RE-ENABLES the verifier,
				// because 47-03's `keysProvisioned` parameter defaults to `true`. This is
				// why engine-factory.association.test.ts asserts the argument COUNT, not
				// just its value.
				//
				// Phase 51: the injected verifier is the PLATFORM DISPATCHER, never a
				// bare PlayIntegrityVerifier. `PlayIntegrityVerifier` hard-gates on
				// `platformDetails?.type === 'Android'` and rejects everything else —
				// correct fail-closed behaviour that must NOT be relaxed — so before
				// this wiring an iOS submission was rejected by the Android verifier's
				// platform gate and the entire iOS half (pinned-root chain, aaguid
				// environment gate, credCert nonce binding, assertion replay counter,
				// K_vote proof-of-possession) was code the running app never reached.
				//
				// Each half keeps its OWN fail-closed provisioning gate, exactly as
				// D-09 requires: absent Play Console keys disable only the Android
				// branch, and an absent Apple root / App ID disables only the iOS one.
				// Neither can mask the other, because the dispatcher routes once, up
				// front, on the discriminant.
				//
				// CRITICAL, both halves: omitting the LAST constructor argument
				// silently RE-ENABLES that verifier, because `keysProvisioned` (47-03)
				// and `rootsProvisioned` (Phase 51) each default to `true`. This is why
				// engine-factory.association.test.ts asserts the argument COUNT on both,
				// not just its value.
				const androidVerifier: IAttestationVerifier = new PlayIntegrityVerifier(
					this.integrityKeyProvider,
					PINNED_HARDWARE_ROOTS_DER,
					this.expectedAppIdentity,
					REVOKED_ATTESTATION_SERIALS,
					this.playConsoleKeysProvisioned
				);
				// `NO_PRIOR_ASSERTIONS` is the AppAttestVerifier default for the
				// counter store and is correct here: this is a pure association-time
				// verifier, so no App Attest key has a stored counter yet. Passing a
				// real store would be the change if assertions are ever verified
				// outside association.
				const iosVerifier: IAttestationVerifier = new AppAttestVerifier(
					PINNED_APP_ATTEST_ROOTS_DER,
					APPLE_APP_ID,
					APP_ATTEST_ENVIRONMENT,
					undefined,
					APP_ATTEST_PROVISIONED
				);
				const verifier: IAttestationVerifier = useStub
					? new StubAttestationVerifier()
					: new PlatformDispatchingAttestationVerifier(androidVerifier, iosVerifier);
				return new AssociationEngine(ctx, verifier);
			}

			default:
				throw new Error(`EngineFactory: unknown engine type "${engineName}"`);
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
			throw new NoNetworkEstablishedError(
				'EngineFactory: Network context not established — call getEngine("network", ref) first'
			);
		}
		const ctx = this.networksEngine.getEstablishedContext(this.currentNetworkHash);
		if (ctx === undefined) {
			throw new NoNetworkEstablishedError(
				`EngineFactory: Network context not established for hash ${this.currentNetworkHash} — call getEngine("network", ref) first`
			);
		}
		this.bindIntakeOpener(ctx);
		return ctx;
	}

	/**
	 * D-49: 62-31 seals registration content to the officers current at write time. The engine reads
	 * it only through `ctx.intakeOpener`, which this host sets on the SHARED established ctx, so every
	 * engine built from that ctx sees it and no screen touches keys.
	 *
	 * D-04: the opener holds the vault reference and the user id, never a secret. It fetches the
	 * officer secret on each open from the native-wrapped vault (no prompt: requireUserAuth false), so
	 * an officer who enables encrypted intake after this bind reads 'opened' without a rebind.
	 *
	 * The user-id comparison exists because NetworksEngine.open() spreads the cached ctx on re-open.
	 * Without it, an opener bound to the previous user would follow a user switch.
	 *
	 * The catch is fail-closed: an unbuildable opener makes sealed rows read as 'no-opener'. It never
	 * blocks the engine, and it logs nothing (no plaintext or key-related detail may reach a log).
	 *
	 * D-51: officers who were not recipients read 'not-a-recipient'. No re-wrap exists.
	 */
	private bindIntakeOpener(ctx: EngineContext): void {
		const userId = ctx.user?.id;
		if (typeof userId !== 'string' || userId.length === 0) {
			if (ctx.intakeOpener !== undefined) {
				ctx.intakeOpener = undefined;
			}
			return;
		}
		if (ctx.intakeOpener?.userId === userId) {
			return;
		}
		try {
			ctx.intakeOpener = new IntakeEngine(ctx).createOpener(resolveAuthorityKeyVault());
		} catch {
			ctx.intakeOpener = undefined;
		}
	}
}
