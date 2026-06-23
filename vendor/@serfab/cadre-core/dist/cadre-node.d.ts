import type { Libp2p, PeerId } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import type { CadreNodeConfig, StrandInstance, StrandConfig, SAppConfig, CadreNodeEvents, ControlNetworkSeed, ApplySeedResult, AddDroneOptions, AddPhoneOptions, DroneInitResult, InviteResult, CadreInvite, OpenInvitation, FormStrandResult, StrandFormationDisclosure, ResolveOpts, SelfRegistrationOutcome, ServiceWakeResult, PushPlatform, DeviceTokenRecord, ResolveDeviceTokenOpts } from './types.js';
import { type AuthorityKeyPair } from './authority-key.js';
import { type SAppIdLookup } from './strand-watcher.js';
import { EnrollmentService } from './enrollment.js';
import { ControlDatabase } from './control-database.js';
import { SeedBootstrapService } from './seed-bootstrap.js';
import type { SeedTrustPolicy } from './seed-trust-policy.js';
import { StrandSolicitationService, type StrandSolicitationServiceOptions } from './strand-solicitation.js';
import type { WakeAck } from './types.js';
import { type ConnectionPathSummary } from './diagnostics/connection-path.js';
type EventHandler<T> = (data: T) => void;
/**
 * CadreNode is the main entry point for a cadre member.
 * It manages:
 * - Connection to the control network
 * - Watching for strand changes
 * - Starting/stopping strand instances
 * - Strand hibernation lifecycle
 * - Peer enrollment
 */
export declare class CadreNode implements SAppIdLookup {
    private readonly config;
    /**
     * The resolved node identity key, set once by {@link resolveIdentityKey}
     * during {@link start} (from `config.keyStore`, else `config.privateKey`).
     * Left undefined when neither is configured — libp2p then generates an
     * ephemeral key internally and there is no exposed authority key. Every
     * identity-dependent path (control node creation, self-record signing, strand
     * launch) reads this resolved field, never `config.privateKey` directly.
     */
    private identityKey;
    private controlNode;
    private controlDatabase;
    private strandWatcher;
    private strandManager;
    private hibernationManager;
    private enrollmentService;
    private seedBootstrapService;
    private strandSolicitationService;
    private strandWakeService;
    /**
     * Server-side push-wake fan-out. Constructed by {@link start} only when
     * `config.push` (FCM/APNs credentials) is present — without it the node behaves
     * exactly as before (no notifier, no fan-out). Owns who/when to wake
     * hibernating mobile peers on strand activity.
     */
    private pushFanoutService;
    /** Backing field for the {@link running} / {@link isRunning} getters. */
    private _running;
    /**
     * In-flight {@link serviceWake} operations keyed by strandId. Coalesces
     * concurrent on-demand wakes for the same strand into one runtime build + one
     * window + one re-hibernate decision (a second caller joins the first's
     * promise), complementing {@link HibernationManager}'s wake coalescing.
     */
    private serviceWakePromises;
    /**
     * Live wake-window waiters (see {@link holdWakeWindow}). Tracked so
     * {@link cleanup} can clear the timer AND resolve the promise on teardown — a
     * window must never fire (or hang an in-flight serviceWake) after stop().
     */
    private windowWaiters;
    private eventHandlers;
    /** Map of strandId -> sAppConfig for sAppId filtering and management */
    private sAppConfigs;
    /**
     * Most-recently pushed invite addresses (see {@link setInviteAddresses}).
     * When non-null these take priority over `libp2pNode.getMultiaddrs()` when
     * minting invites — the host pushes NAT-resolved addresses here so the
     * control-network node never needs to dial back to the manager.
     */
    private latestInviteAddresses;
    /** Initial self-registration timer (see {@link scheduleSelfRegistration}). */
    private selfRegistrationTimer;
    /** TTL heartbeat that re-publishes the self record before it goes stale. */
    private recordRefreshTimer;
    /** Listener that re-publishes the self record when reachable addresses change. */
    private selfPeerUpdateHandler;
    /**
     * Single-flight guard for {@link registerSelf}. Concurrent callers (the explicit
     * CLI `--authority` publish, the 1s startup timer, the TTL heartbeat, and the
     * address-change listener) share one in-flight publish so two of them can never
     * both read "no row yet" and race a duplicate INSERT (a `CadrePeer` PK conflict).
     */
    private registerSelfInFlight;
    constructor(config: CadreNodeConfig);
    /**
     * SAppIdLookup implementation - get sAppId for a strand
     */
    getSAppId(strandId: string): string | undefined;
    /**
     * Get the peer ID of this node (available after start)
     */
    get peerId(): PeerId | undefined;
    /**
     * The party ID this node serves (control-network identity).
     */
    get partyId(): string;
    /**
     * Get the multiaddrs of this node (available after start)
     */
    getMultiaddrs(): string[];
    /**
     * Check if the node is running
     */
    get isRunning(): boolean;
    /**
     * Synchronous lifecycle snapshot for headless callers (a mobile
     * `BackgroundRunner` that boots in a background task and must *query* state
     * rather than subscribe to `control:connected`/`control:disconnected`).
     * Equivalent to {@link isRunning}.
     */
    get running(): boolean;
    /**
     * Synchronous readiness snapshot: whether the control network is currently
     * connected (the node is running and its control-network libp2p node is up).
     * Tracks the same edge the `control:connected`/`control:disconnected` events
     * announce, but pollable.
     */
    get controlConnected(): boolean;
    /**
     * Classify every open control-network connection as relayed
     * (`/p2p-circuit`) vs direct, tag its transport, and summarise counts plus a
     * stuck-on-relay condition. Pure, read-only snapshot over
     * `controlNode.getConnections()`. Returns an empty (all-zero) summary when
     * the node has not been started.
     *
     * @param settleWindowMs - grace period before a relayed connection with no
     *   direct sibling is considered stuck (default 10_000ms)
     */
    getConnectionPaths(settleWindowMs?: number): ConnectionPathSummary;
    /**
     * Get all strand instances
     */
    getStrands(): Map<string, StrandInstance>;
    /**
     * Get a specific strand instance
     */
    getStrand(strandId: string): StrandInstance | undefined;
    /**
     * Get the enrollment service for adding new peers
     */
    getEnrollmentService(): EnrollmentService;
    /**
     * Start the cadre node
     */
    start(): Promise<void>;
    /**
     * Stop the cadre node
     */
    stop(): Promise<void>;
    /**
     * Subscribe to events
     */
    on<K extends keyof CadreNodeEvents>(event: K, handler: EventHandler<CadreNodeEvents[K]>): void;
    /**
     * Unsubscribe from events
     */
    off<K extends keyof CadreNodeEvents>(event: K, handler: EventHandler<CadreNodeEvents[K]>): void;
    private emit;
    /**
     * Resolve the node identity into {@link identityKey} exactly once, fail-closed,
     * before any network bring-up. Resolution order:
     *
     * 1. Both `keyStore` and `privateKey` set ⇒ configuration error (throws).
     * 2. `keyStore` set ⇒ load protobuf bytes from `identityKeyId` (default
     *    {@link DEFAULT_IDENTITY_KEY_ID}). Found ⇒ deserialize; empty ⇒ generate a
     *    fresh Ed25519 key, persist it, and use it. A rejected `get` (access denied
     *    / backend failure) PROPAGATES — we never generate a new key on a read
     *    error, which would silently orphan the real identity.
     * 3. `privateKey` set ⇒ use it directly.
     * 4. Neither ⇒ leave undefined; libp2p generates an ephemeral key.
     *
     * Idempotent: a second call (or a stop()→start() cycle) reuses the already
     * resolved key rather than regenerating or re-persisting.
     */
    private resolveIdentityKey;
    private createControlNode;
    private createStrandQueryable;
    /**
     * Schedule the node's initial self-record publish + ongoing refresh shortly
     * after start (non-blocking). {@link registerSelf} is idempotent and safely
     * no-ops when it cannot yet sign/insert (e.g. authority key not installed),
     * so the timer is harmless even when registration only becomes possible later.
     */
    private scheduleSelfRegistration;
    /**
     * Publish (or refresh) this node's own signed `CadrePeer` address record so
     * other members can resolve its current signaling/relay multiaddrs from its
     * PeerId alone. Public, awaitable, and idempotent.
     *
     * - Builds a `PeerAddressRecord` from the node's current dialable addrs
     *   (signaling/`p2p-circuit` first), signed with the ed25519 key behind its
     *   PeerId (the resolved node identity from `keyStore`/`config.privateKey`).
     * - If the row already exists: a self-signed UPDATE bumping `UpdatedAt`.
     * - If not, and the node is its own authority: an authority-signed INSERT that
     *   also carries the self-signature.
     * - Otherwise: logs and returns (a non-authority node with no row yet must
     *   wait for an authority to insert it; it can then self-refresh).
     *
     * Safe to call repeatedly (heartbeat / address-change driven); each successful
     * publish strictly increases `UpdatedAt`. Concurrent calls are collapsed into a
     * single in-flight publish (see {@link registerSelfInFlight}) so the explicit
     * startup publish and the background timers can never race a duplicate INSERT.
     *
     * @returns what the publish did — `inserted`, `refreshed`, or `skipped`.
     */
    registerSelf(): Promise<SelfRegistrationOutcome>;
    /** The body of {@link registerSelf}; serialised by its single-flight guard. */
    private publishSelfRecord;
    /**
     * The ed25519 keypair (base64url) the node signs its own record with — the key
     * behind its libp2p PeerId. Sourced from the resolved {@link identityKey}
     * (which a `keyStore` or `config.privateKey` supplies); returns null when
     * absent (ephemeral identity) or (defensively) when it does not match the
     * control node's PeerId, in which case self-publish is skipped rather than
     * producing an unresolvable row.
     */
    private getSelfSigningKey;
    /**
     * The authority keypair (base64url Ed25519) derived from this node's resolved
     * identity key. In the single-key reference model the authority signing key is
     * *derived from* the node identity (see {@link authorityKeyFromLibp2p}), so the
     * same key material protected in a secure enclave backs both.
     *
     * Exposed so the hosting app retains control of authority genesis: cadre-core
     * resolves + protects the identity, then the app sources this pair to drive
     * `ensureAuthorityKey(pub)` + `initializeSeedBootstrap(priv)` itself — cadre-core
     * never silently runs genesis. A future separate-authority slot would return a
     * distinct key here instead of the identity-derived one.
     *
     * @returns The base64url seed/public-key authority pair.
     * @throws If called before {@link start} has resolved the identity, or when the
     *   node runs on an ephemeral libp2p key (no `keyStore`/`privateKey` configured),
     *   since that key is internal to libp2p and not exposed.
     */
    getIdentityAuthorityKey(): AuthorityKeyPair;
    /**
     * Collect this node's current dialable addresses for publication, signaling
     * (`/p2p-circuit`) first. Prefers the best invite/NAT-resolved set and folds
     * in the relay/signaling address (the WebRTC dial input) when not already
     * present.
     */
    private collectSelfAddrs;
    /**
     * Wire the ongoing self-record refresh: re-publish whenever libp2p reports an
     * address change (relay reservation rotation, NAT change) and on a TTL
     * heartbeat at half the freshness ceiling. Idempotent — repeated calls do not
     * stack listeners/timers.
     */
    private startRecordRefresh;
    /** Tear down the self-record refresh timers + listener (see {@link cleanup}). */
    private stopRecordRefresh;
    /**
     * Resolve a peer's current, signed, trust-checkable multiaddrs from only its
     * PeerId — the transport-agnostic input a NAT-to-NAT WebRTC (or any) dial path
     * consumes, with no copy/paste of a relayed dial string.
     *
     * Reads the peer's `CadrePeer` record and gates it through, in order:
     *   1. record present (else `[]`),
     *   2. `publicKey <-> peerId` binding (the stored key's libp2p identity must be
     *      the requested peerId),
     *   3. self-signature verifies against `publicKey`,
     *   4. freshness — rejected once older than `maxAgeMs` (never a dead relay
     *      reservation),
     *   5. the pluggable trust gate (`opts.trustPolicy`).
     * Survivors are returned signaling (`/p2p-circuit`) first, filtered to
     * signaling-only when requested, as parsed `Multiaddr`s (unparsable addrs
     * dropped). Any gate failure yields an empty array rather than throwing.
     */
    resolvePeerAddrs(peerId: string, opts?: ResolveOpts): Promise<Multiaddr[]>;
    /** Parse multiaddr strings, dropping (and logging) any that fail to parse. */
    private parseMultiaddrs;
    /**
     * Publish (or refresh) this node's own self-signed `DeviceToken` row so a server
     * peer can resolve its FCM/APNs push token from its PeerId alone. Mirrors
     * {@link registerSelf}:
     *
     * - If the row already exists: a self-signed UPDATE bumping `UpdatedAt` (works
     *   for any member — the `AuthorizedUpdate` self-branch verifies the new `Sig`
     *   against the bound `CadrePeer.PublicKey`). Platform/Token may change here
     *   (rotation / platform switch / reinstall are all normal self-updates).
     * - If not, and the node holds an authority service: an authority-signed INSERT
     *   that also carries the self-signature.
     * - Otherwise: throws. Like `CadrePeer`, the first `DeviceToken` row requires an
     *   authority signature; a non-authority peer (e.g. a phone) must have its row
     *   seeded by an authority — typically the server it enrolled with — before it
     *   can self-refresh. (Establishing that phone→server registration handshake is
     *   the downstream "RN registration" ticket; this node only owns the cadre-core
     *   write path.)
     *
     * `UpdatedAt` strictly increases on every publish (even a same-millisecond
     * re-publish), so a replayed older record is rejected by the schema.
     *
     * @param platform - `'fcm'` (Android/Firebase) or `'apns'` (Apple).
     * @param token - the opaque platform device/registration token.
     * @throws if the node is not started, exposes no self-signing key, or has no
     *   existing row and no authority service to self-insert.
     */
    registerDeviceToken(platform: PushPlatform, token: string): Promise<void>;
    /**
     * Resolve a cadre peer's FCM/APNs push token from only its PeerId — the input a
     * server's push-wake fan-out consumes to deliver a platform push to a suspended
     * app. Applies the same gating shape as {@link resolvePeerAddrs}, returning
     * `null` (never throwing) on any failure:
     *
     *   1. membership — the peer has a `CadrePeer` row with a `PublicKey`,
     *   2. `publicKey <-> peerId` binding — the stored key's libp2p identity is the
     *      requested peerId,
     *   3. a `DeviceToken` row exists with a known {@link PushPlatform},
     *   4. self-signature verifies against the bound `CadrePeer.PublicKey`,
     *   5. freshness — `updatedAt` is positive and within `opts.maxAgeMs` (default:
     *      no ceiling, since a push token is valid until it rotates).
     *
     * A peer that is not a current member, or whose token has no backing `CadrePeer`
     * record, resolves to `null` — a server must not attempt to push to a non-cadre
     * peer.
     */
    resolveDeviceToken(peerId: string, opts?: ResolveDeviceTokenOpts): Promise<DeviceTokenRecord | null>;
    /**
     * Delete this node's own `DeviceToken` row (logout / token invalidation). No-op
     * when no row exists. Like {@link registerDeviceToken}'s first insert, the delete
     * is gated on an authority signature (`DeviceToken.AuthorizedInsert` covers insert
     * AND delete), so it requires this node's authority service; a non-authority peer
     * must route the clear through its authority (downstream RN registration path).
     *
     * @throws if the node is not started, or a row exists but no authority service is
     *   available to sign the delete.
     */
    clearDeviceToken(): Promise<void>;
    /**
     * Expire ANOTHER peer's stale `DeviceToken` after a platform reported it
     * unregistered during a push-wake fan-out. Unlike {@link clearDeviceToken}
     * (self-only — it hardcodes the local peerId), this takes an arbitrary peerId.
     *
     * - When this node holds an authority seed service, it deletes the row
     *   (`deleteDeviceToken` is authority-gated and accepts any peerId), so the peer
     *   is not retried until it re-registers.
     * - When this node is NOT an authority it cannot delete the row, so it only logs
     *   that a re-registration is needed. The fan-out's own in-memory dead-token set
     *   is what actually stops re-pushing to the dead token this process — see
     *   {@link PushFanoutService}. That set is acceptably lossy across restarts (a
     *   restart re-learns staleness on the next failed send).
     *
     * Best-effort: never throws to the (best-effort) fan-out caller.
     */
    expireDeviceToken(peerId: string): Promise<void>;
    private handleStrandAdded;
    private handleStrandRemoved;
    private cleanup;
    private handleStrandIdle;
    /**
     * Hibernate a strand: release its strand-network resources via the strand
     * manager (stop the libp2p node, close the StrandDatabase) and mark it
     * `hibernating`. A quiesced strand holds no open strand-network connections,
     * transports, or DB handles. No-ops if the strand is missing; if already
     * quiesced (defensive), just marks status and emits.
     */
    private handleStrandHibernate;
    /**
     * Wake a strand. If it was hibernating (quiesced — no libp2p node), re-resolve
     * the cohort discovery seed and mode exactly as `launchStrand` does and rebuild
     * its runtime via the strand manager. If it is still live (e.g. waking an idle
     * strand, which retains its resources), just flip the status. Overlapping wake
     * triggers are coalesced upstream by `HibernationManager`, so this runs once
     * per wake; `resumeStrand` is itself idempotent as a backstop.
     */
    private handleStrandWake;
    /**
     * Rebuild a quiesced strand's runtime, re-resolving the volatile cohort inputs
     * first: the discovery seed may have grown and cohort membership may have
     * shifted the mode `bootstrap → networked` since the strand last ran. Shared by
     * the wake (`handleStrandWake`) and check-in (`handleStrandCheckIn`) paths so
     * both apply the same fresh seed/mode resolution. `resumeStrand` is idempotent
     * (returns the live instance unchanged) as a backstop against double-resume.
     */
    private resumeStrandRuntime;
    /**
     * Real cohort check-in for a hibernating strand (the `onCheckIn` callback).
     *
     * Optimystic syncs pull-on-read, not on connect, and exposes no cheap
     * repo-level "pull pending" hook (`IRepo` is get/pend/commit/cancel only —
     * see the review handoff). So "query the cohort for pending activity" is
     * realized as a resume → bounded window → re-hibernate-if-idle cycle that
     * reuses the existing quiesce/resume primitives rather than a bespoke probe:
     *
     *   1. Resume the strand (rebuild node + db, re-resolve cohort seed/mode) so
     *      its strand network can reach cohort peers — exactly as a wake does.
     *   2. Hold it resumed for a bounded window, during which the app may drive
     *      reads (pull-on-read) and record activity.
     *   3. If activity was recorded during the window, leave the strand `active`
     *      (the idle/hibernate timers + backoff reset take over). Otherwise
     *      quiesce again and leave it `hibernating`, so `HibernationManager`
     *      schedules the next, longer-delayed check-in.
     *
     * No-ops unless the strand is currently `hibernating` — a concurrent wake may
     * have already resumed it.
     */
    private handleStrandCheckIn;
    /**
     * Window-then-decide for a just-resumed strand, shared by the check-in timer
     * path ({@link handleStrandCheckIn}) and the on-demand {@link serviceWake}:
     *
     *   1. Capture the post-resume activity marker. `recordActivity` assigns a
     *      FRESH `Date`, so a changed reference after the window means real
     *      activity landed during it — not millisecond-resolution noise.
     *   2. Hold the strand live for `windowMs` so its strand network reaches the
     *      cohort and the app can drive pull-on-read activity.
     *   3. If activity landed, leave the strand `active` (return `true`); otherwise
     *      quiesce and mark it `hibernating` again (return `false`).
     *
     * @returns whether activity was observed during the window (strand left active).
     */
    private runWakeWindow;
    /**
     * Hold a just-resumed strand live for `windowMs` (default
     * {@link DEFAULT_CHECKIN_WINDOW_MS} is applied by callers). A non-positive
     * window resolves immediately. The pending timer is tracked in
     * {@link windowWaiters} so {@link cleanup} can both clear it and resolve the
     * promise on teardown — a `stop()` during an in-flight window must neither fire
     * the timer afterward nor hang the awaiting check-in/serviceWake. Extracted as
     * its own method so tests can stub the wait (and inject activity during it).
     */
    private holdWakeWindow;
    /**
     * Clear every in-flight wake window: cancel its timer and resolve its promise
     * so any awaiting check-in/serviceWake completes promptly rather than hanging
     * past teardown. Called from {@link cleanup}.
     */
    private clearWindowWaiters;
    /**
     * Add a strand with its sApp configuration.
     * The hosting application must provide the sApp schema when creating a strand.
     */
    addStrand(config: StrandConfig): Promise<StrandInstance>;
    /**
     * Publish a strand row to the shared control database under this node's own
     * authority identity, so other cadre members discover it via control-network
     * sync (their {@link StrandWatcher} fires `strand:discovered`).
     *
     * This is the authority-signed `Strand` INSERT that {@link addStrand}
     * deliberately omits: `addStrand` only starts the LOCAL strand instance,
     * whereas publishing makes the strand visible cadre-wide. A typical creator
     * does both (start locally + publish); a discovering peer only does
     * `addStrand` (the row already exists).
     *
     * The insert is signed with the ed25519 key behind this node's PeerId — which
     * {@link authorityKeyFromLibp2p} also exposes as the node's authority keypair,
     * so peer identity and authority key are one and the same. That key must be
     * enrolled in `AuthorityKey` (e.g. via {@link ControlDatabase.ensureAuthorityKey}
     * at genesis) or the schema's `Strand.Authorized` constraint rejects the write.
     * Failing loudly here is intentional: a silently-unpublished strand would run
     * as a local-only island that no peer could ever discover or join.
     *
     * @param strandId - Unique strand identifier (typically the same id passed to
     *   {@link addStrand}).
     * @param type - `'o'` for open (default) or `'c'` for closed.
     * @param memberPrivateKey - Optional membership key for a closed strand.
     * @throws if the node is not started, exposes no authority signing key, or the
     *   control DB rejects the (unauthorized) insert.
     */
    publishStrand(strandId: string, type?: 'o' | 'c', memberPrivateKey?: string): Promise<void>;
    /**
     * Publish an authority-signed `FormationInvite` (open-invitation token) to the
     * shared control database, so a later {@link formStrand} redemption can be
     * validated against it (the consent branch of `Strand.Authorized`).
     *
     * Counterpart to {@link createOpenInvitation}, which only mints the
     * out-of-band {@link OpenInvitation} envelope: persisting the matching
     * `FormationInvite` row is what makes the token *redeemable* — the host's
     * {@link ControlFormationUsageRecorder} answers `isTokenValid`/`isTokenUsed`
     * from this row. A host minting a closed-strand invite does both (mint +
     * publish), exactly as the integration harness's `createInvitation` does.
     *
     * Signs with the same self-authority key as {@link publishStrand} (the ed25519
     * key behind this node's PeerId, which must be an enrolled `AuthorityKey`).
     * Throws loudly if the node isn't started or exposes no signing key.
     *
     * @param token - Invitation token (the `FormationInvite` primary key); use the
     *   `token` of the {@link OpenInvitation} from {@link createOpenInvitation}.
     * @param sAppId - The sApp a redeemed strand will use.
     * @param options - Optional `expiresAtMs` (epoch ms), `totalUses`, `validationUrl`,
     *   `strandId` (bind a closed/pre-existing host strand for provision-then-record).
     */
    publishFormationInvite(token: string, sAppId: string, options?: {
        expiresAtMs?: number;
        totalUses?: number;
        validationUrl?: string;
        strandId?: string;
    }): Promise<void>;
    /**
     * Shared strand launch path for both the explicit (`addStrand`) and the
     * control-discovered (`handleStrandAdded`) entry points. Resolves the cohort
     * seed, selects the mode, starts the strand, and registers it with the
     * hibernation manager before emitting `strand:started`.
     */
    private launchStrand;
    /**
     * Derive the cohort discovery seed from the control network's CadrePeer rows,
     * excluding this node. Returns an empty seed when no control database exists.
     */
    private resolveCohortSeed;
    /**
     * Remove a strand
     */
    removeStrand(strandId: string): Promise<void>;
    /**
     * Record activity on a strand (resets hibernation timer).
     *
     * Also drives the server push-wake fan-out: whatever already drives activity on
     * this node's strand (its relay/app layer doing pull-on-read) additionally wakes
     * hibernating mobile peers — the same imperative seam local-wake uses, with no
     * new contract. No-op for the fan-out when push is not configured.
     */
    recordStrandActivity(strandId: string): void;
    /**
     * Explicit fan-out trigger: an always-on host/relay/sApp calls this when it
     * observes activity for a strand this node participates in, to wake hibernating
     * mobile members over a direct control-network dial (falling back to FCM/APNs
     * for suspended phones). This is the supported, honest v1 trigger — Optimystic
     * exposes no passive repo-level "new transaction" hook to drive it automatically
     * (see the deferred passive-detector follow-up). No-op when push is not
     * configured; best-effort (never throws — the check-in wake is the backstop).
     *
     * @param strandId - the strand that saw activity.
     * @param reason - free-form cause hint carried in the wake (default `activity`).
     */
    notifyStrandActivity(strandId: string, reason?: string): void;
    /**
     * Force wake a hibernating strand
     */
    wakeStrand(strandId: string): Promise<void>;
    /**
     * Force a single strand to hibernate immediately, bypassing the idle/hibernate
     * timers — the background-entry path. No-op if the strand is realtime
     * (never-hibernate latency hint), already hibernating, or unknown.
     *
     * Routes through {@link HibernationManager.forceHibernate}, which cancels the
     * strand's pending idle/hibernate (and check-in) timers — so a stale timer
     * can't re-fire on or resurrect the strand — then runs the same `onHibernate`
     * path as the timer (`quiesceStrand` + `status='hibernating'` +
     * `strand:hibernating`). Unlike the timer path it does NOT re-arm check-ins:
     * the strand stays down until the caller drives a wake (e.g. {@link serviceWake}).
     */
    hibernateStrand(strandId: string): Promise<void>;
    /**
     * Force-hibernate every tracked strand whose latency hint is not realtime,
     * tolerating per-strand failure (one strand failing to quiesce never aborts
     * the others). Realtime strands are left running — the caller keeps the control
     * connection and realtime strands alive for as long as the OS permits.
     *
     * @returns the strandIds actually hibernated (now in `hibernating` status);
     *   realtime strands are excluded.
     */
    hibernateAll(): Promise<string[]>;
    /**
     * On-demand equivalent of a check-in cycle, for a push-delivered wake on
     * mobile: resume the strand, hold it live for `windowMs` so its strand network
     * reaches the cohort and the app can pull pending activity, then re-hibernate
     * if no activity was recorded (else leave it active).
     *
     * Idempotent / coalesced two ways: concurrent `serviceWake`s for the same
     * strand share one in-flight operation ({@link serviceWakePromises}), and the
     * underlying resume coalesces with a racing push-wake via
     * {@link HibernationManager}'s wake coalescing — one runtime build, one window,
     * one re-hibernate decision. Returns `{ serviced: false }` (never throws) when
     * the node is not running or the strand is unknown, and surfaces a resume
     * failure as `{ serviced: true, hadActivity: false }` after re-hibernating.
     *
     * @param strandId - the strand a push said has pending activity.
     * @param opts.windowMs - override the live-window duration (defaults to the
     *   configured `checkInWindowMs` / {@link DEFAULT_CHECKIN_WINDOW_MS}).
     */
    serviceWake(strandId: string, opts?: {
        windowMs?: number;
    }): Promise<ServiceWakeResult>;
    /** Body of {@link serviceWake}; serialised per-strand by its coalescing guard. */
    private runServiceWake;
    /**
     * Get the control network node (for advanced use)
     */
    getControlNode(): Libp2p | null;
    /**
     * Get the control database (for advanced queries)
     */
    getControlDatabase(): ControlDatabase | null;
    /**
     * Force a poll of the strand watcher (for testing)
     */
    forceStrandPoll(): Promise<void>;
    /**
     * Get the sApp configuration for a strand
     */
    getSAppConfig(strandId: string): SAppConfig | undefined;
    /**
     * Initialize the seed bootstrap service with an authority key.
     * Must be called before using seed-related methods that require signing.
     *
     * @param authorityPrivateKey - The authority's private key (base64url encoded)
     */
    initializeSeedBootstrap(authorityPrivateKey: string): void;
    /**
     * Push the multiaddrs that future invites should advertise. Pass `null` to
     * revert to the libp2p-reported addresses (the default). The host calls this
     * at spawn and on every NAT change.
     */
    setInviteAddresses(addresses: string[] | null): void;
    /**
     * Resolve the addresses to embed in invites. Prefers pushed addresses, then
     * any config-supplied resolver, then the libp2p-observed multiaddrs.
     */
    private resolveInviteAddresses;
    /**
     * Enumerate the cadre's `CadrePeer` membership.
     */
    listMembers(): Promise<Array<{
        peerId: string;
        multiaddr: string | null;
    }>>;
    /**
     * Probe whether a given peer is a `CadrePeer` member.
     */
    isMember(peerId: string): Promise<boolean>;
    /**
     * Push-wake a hibernating cadre peer over the control network.
     *
     * Resolves the target's signed control-network address from its `CadrePeer`
     * record (via {@link resolvePeerAddrs}, signaling/relay first — so a NAT'd peer
     * is reachable through its circuit-relay address), dials `WAKE_PROTOCOL`, sends
     * the {@link WakeRequest}, and returns the peer's {@link WakeAck}. The receiver
     * gates the request on cadre membership and only resumes a strand it already
     * participates in.
     *
     * @param targetPeerId - The hibernating cadre peer to wake.
     * @param strandId - The strand the caller knows has pending activity.
     * @param reason - Optional cause hint, e.g. `"activity"` or `"manual"`.
     * @throws if the node is not started or the target has no dialable address.
     */
    pushWake(targetPeerId: string, strandId: string, reason?: string): Promise<WakeAck>;
    /**
     * Enable the seed listener for receiving seeds via the /sereus/seed/1.0.0 protocol.
     * This is for drone nodes that need to receive seeds without being an authority.
     * Does not require an authority key.
     */
    enableSeedListener(): void;
    /**
     * Get the seed bootstrap service (for advanced use)
     */
    getSeedBootstrapService(): SeedBootstrapService | null;
    /**
     * Authorize a new peer to join the cadre.
     * Signs the peer ID with the authority key and inserts into CadrePeer table.
     *
     * @param peerId - The peer ID to authorize
     * @param multiaddrs - Optional multiaddrs for the peer
     */
    authorizePeer(peerId: string, multiaddrs?: string[]): Promise<void>;
    /**
     * Remove a previously-authorized peer from the cadre.
     * Signs the peer ID with the authority key and deletes the CadrePeer row.
     *
     * @param peerId - The peer ID to remove
     */
    removePeer(peerId: string): Promise<void>;
    /**
     * Create a seed from the current control network state.
     * The seed contains peer information and is signed by an authority.
     */
    createSeed(): Promise<ControlNetworkSeed>;
    /**
     * Apply a seed to populate the peer cache and enable connections.
     *
     * Validates the seed signature, then evaluates a trust anchor for the signer
     * key (see `SeedTrustPolicy`). An enrollment caller can pass a per-seed
     * `trustPolicy` override — e.g. a `pinnedKeyTrustPolicy` built from a
     * `CadreInvite.authorityKeys` — so a cold-start node can accept its first
     * seed without reconfiguring the service.
     */
    applySeed(seed: ControlNetworkSeed, options?: {
        trustPolicy?: SeedTrustPolicy;
    }): Promise<ApplySeedResult>;
    /**
     * Deliver a seed directly to a peer via the /sereus/seed/1.0.0 protocol.
     */
    deliverSeed(targetMultiaddr: string, seed: ControlNetworkSeed): Promise<{
        accepted: boolean;
        reason?: string;
    }>;
    /**
     * Encode a seed for out-of-band delivery (e.g., QR code, copy/paste).
     */
    encodeSeed(seed: ControlNetworkSeed): string;
    /**
     * Decode a seed from base64url encoding.
     */
    decodeSeed(encoded: string): ControlNetworkSeed;
    /**
     * Get this node's circuit relay address for inclusion in seeds.
     * Returns null if no relay address is available.
     */
    getRelayAddress(): Promise<string | null>;
    /**
     * Add a drone to the cadre (for phone/server adding provider-hosted node).
     * Creates authorization and seed for drone initialization.
     */
    addDrone(options: AddDroneOptions): Promise<DroneInitResult>;
    /**
     * Create an invite for a phone to join the cadre.
     * Use when a server wants to invite a NAT'd phone.
     */
    createInvite(token?: string, expiresIn?: number): Promise<InviteResult>;
    /**
     * Accept a phone connection using an invite.
     * Call this when a phone dials in with an invite token.
     */
    acceptPhone(options: AddPhoneOptions, issuedInvite?: CadreInvite): Promise<void>;
    /**
     * Add a phone to the cadre with relay support.
     * Use when both nodes are NAT'd (phone-to-phone).
     */
    addPhoneWithRelay(phonePeerId: string): Promise<DroneInitResult>;
    /**
     * Encode an invite for out-of-band delivery (QR, link, etc.).
     */
    encodeInvite(invite: CadreInvite): string;
    /**
     * Decode an invite from base64url encoding.
     */
    decodeInvite(encoded: string): CadreInvite;
    /**
     * Dial an authority from an invite (for phone joining via invite).
     */
    dialInvite(invite: CadreInvite): Promise<void>;
    /**
     * Initialize the strand solicitation service.
     * This enables forming strands with other parties via open invitations.
     *
     * @param options - Configuration for the solicitation service
     */
    initializeStrandSolicitation(options?: StrandSolicitationServiceOptions): void;
    /**
     * Get the strand solicitation service (for advanced use)
     */
    getStrandSolicitationService(): StrandSolicitationService | null;
    /**
     * Create an open invitation for others to form strands with this party.
     *
     * @param sAppId - The sApp to use for formed strands
     * @param expirationMs - How long the invitation is valid (ms from now)
     * @returns The open invitation to share out-of-band
     */
    createOpenInvitation(sAppId: string, expirationMs?: number): Promise<OpenInvitation>;
    /**
     * Form a strand with a responder via an open invitation.
     *
     * @param invitation - The open invitation received out-of-band
     * @param disclosure - Identity/context information to share with the responder
     * @returns The member key and strand info if successful
     */
    formStrand(invitation: OpenInvitation, disclosure?: StrandFormationDisclosure): Promise<FormStrandResult>;
    /**
     * Encode an open invitation for out-of-band delivery (QR, link, etc.).
     */
    encodeInvitation(invitation: OpenInvitation): string;
    /**
     * Decode an open invitation from base64url encoding.
     */
    decodeInvitation(encoded: string): OpenInvitation;
}
export {};
