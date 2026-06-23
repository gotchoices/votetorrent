import type { Libp2p, PeerId, PrivateKey } from '@libp2p/interface';
import type { IRawStorage, Libp2pTransports } from '@optimystic/db-p2p';
import type { IRepo } from '@optimystic/db-core';
import type { StrandDatabase } from './strand-database.js';
import type { SeedTrustPolicy } from './seed-trust-policy.js';
import type { KeyStore, KeyId } from './key-store.js';
/**
 * Extended Libp2p node with the coordinatedRepo attached by db-p2p's
 * createLibp2pNode after node creation (not surfaced on the base Libp2p type).
 */
export interface Libp2pNodeWithRepo extends Libp2p {
    coordinatedRepo: IRepo;
}
/**
 * Node profile determines storage participation
 */
export type NodeProfile = 'transaction' | 'storage';
/**
 * Strand filter configuration - determines which strands this node participates in
 */
export type StrandFilter = {
    mode: 'all';
} | {
    mode: 'sAppId';
    sAppId: string;
} | {
    mode: 'strandId';
    strandId: string;
} | {
    mode: 'none';
};
/**
 * Latency hint for strand hibernation behavior
 */
export type LatencyHint = 'realtime' | 'interactive' | 'background' | 'archive';
/**
 * Hibernation timeout configuration per latency hint (in milliseconds)
 */
export interface HibernationTimeouts {
    /** Time before transitioning from active to idle */
    idleTimeout: number;
    /** Time before transitioning from idle to hibernating */
    hibernateTimeout: number;
    /**
     * Base interval for the FIRST check-in after hibernating. Successive
     * no-activity check-ins escalate this delay by {@link checkInBackoffFactor}
     * (see {@link HibernationManager}'s self-rescheduling check-in chain).
     */
    checkInInterval: number;
    /**
     * Multiplier applied to the check-in delay after each check-in that finds no
     * pending activity (must be >= 1; 1 disables escalation). Default 2 →
     * doubling: base, base×2, base×4, … until {@link checkInMaxInterval}.
     */
    checkInBackoffFactor: number;
    /**
     * Upper bound on the escalating check-in delay — the concrete realization of
     * the architecture's "minutes → hours → days" ceiling for this hint. Backoff
     * never schedules a delay longer than this.
     */
    checkInMaxInterval: number;
}
/**
 * Default hibernation timeouts per latency hint.
 *
 * `checkInInterval` is the BASE delay; `checkInMaxInterval` is the per-hint
 * ceiling the exponential backoff escalates toward (interactive minutes→~1h,
 * background minutes→~6h, archive ~1h→~3 days).
 */
export declare const HIBERNATION_TIMEOUTS: Record<LatencyHint, HibernationTimeouts>;
/**
 * Storage provider type - either an IRawStorage instance or a factory function.
 * Factory functions are useful for creating strand-specific storage instances.
 */
export type RawStorageProvider = IRawStorage | ((strandId: string) => IRawStorage);
/**
 * Storage configuration for storage profile nodes
 */
export interface StorageConfig {
    /**
     * Storage provider - either an IRawStorage instance or a factory function.
     *
     * For Node.js environments, use FileRawStorage from @optimystic/db-p2p-storage-fs:
     * ```typescript
     * import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
     * storage: { provider: (strandId) => new FileRawStorage(`./data/${strandId}`) }
     * ```
     *
     * For React Native, use the appropriate storage from @optimystic/db-p2p-storage-rn:
     * ```typescript
     * import { RNRawStorage } from '@optimystic/db-p2p-storage-rn';
     * storage: { provider: (strandId) => new RNRawStorage(strandId) }
     * ```
     *
     * For in-memory storage (testing):
     * ```typescript
     * import { MemoryRawStorage } from '@optimystic/db-p2p';
     * storage: { provider: () => new MemoryRawStorage() }
     * ```
     */
    provider: RawStorageProvider;
    quotaBytes?: number;
}
/**
 * Network configuration for libp2p
 */
export interface NetworkConfig {
    listenAddrs?: string[];
    announceAddrs?: string[];
    relayAddrs?: string[];
    /**
     * Optional libp2p connectionGater forwarded to createLibp2pNode for both the
     * control node and each strand node. React Native nodes supply a permissive
     * gater (e.g. `{ denyDialMultiaddr: async () => false }`) so they can dial
     * insecure-ws / private addresses — VoteTorrent spike 009/011.
     */
    connectionGater?: unknown;
    /**
     * Enable circuit relay server - allows this node to relay connections for other peers.
     * When undefined, defaults to true for storage profile nodes (they typically have
     * better connectivity and uptime), false for transaction profile nodes.
     */
    enableRelay?: boolean;
    /**
     * Custom libp2p transports. When omitted, the default transports from
     * `@optimystic/db-p2p` are used (TCP + circuit relay for Node.js).
     *
     * React Native apps must supply WebSocket-based transports because TCP
     * is not available in the RN runtime:
     * ```typescript
     * import { webSockets } from '@libp2p/websockets';
     * import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
     *
     * network: {
     *   transports: [webSockets(), circuitRelayTransport()],
     *   listenAddrs: []  // RN nodes typically cannot listen
     * }
     * ```
     */
    transports?: Libp2pTransports;
    /**
     * Optional async resolver returning the multiaddrs to embed in invites
     * (and other authority-address contexts). When unset, `libp2pNode.getMultiaddrs()`
     * is used. Hosts behind NAT supply this to substitute their DDNS hostname
     * and externally-mapped port — see `@serfab/cadre-host`'s NatService.
     */
    inviteAddressResolver?: () => Promise<string[]>;
}
/**
 * Hibernation configuration
 */
export interface HibernationConfig {
    enabled: boolean;
    defaultLatencyHint?: LatencyHint;
    /** Custom timeouts per latency hint (overrides defaults) */
    customTimeouts?: Partial<Record<LatencyHint, Partial<HibernationTimeouts>>>;
    /**
     * How long a hibernating strand stays resumed during a check-in to let its
     * strand network connect to reachable cohort peers (and the app drive
     * pull-on-read activity) before re-hibernating if still idle. Defaults to
     * {@link DEFAULT_CHECKIN_WINDOW_MS}.
     */
    checkInWindowMs?: number;
}
/**
 * Default duration of the resume-and-probe window during a strand check-in.
 * See {@link HibernationConfig.checkInWindowMs}.
 */
export declare const DEFAULT_CHECKIN_WINDOW_MS: number;
/**
 * Control network configuration
 */
export interface ControlNetworkConfig {
    partyId: string;
    bootstrapNodes: string[];
    /** Optional path to the control schema file (defaults to bundled schema) */
    schemaPath?: string;
}
/**
 * Main configuration for a CadreNode
 */
export interface CadreNodeConfig {
    /**
     * If provided, use this keypair for the node identity (direct injection).
     * Mutually exclusive with {@link keyStore} — supplying both is a configuration
     * error (fail closed) thrown by `start()` before any network bring-up.
     */
    privateKey?: PrivateKey;
    /**
     * Pluggable secure store for node key material. When set, the node loads its
     * identity from `keyStore` under {@link identityKeyId}, generating + persisting
     * a fresh Ed25519 key on first run (protobuf bytes are the canonical stored
     * form). Mutually exclusive with {@link privateKey}. Absent ⇒ legacy behavior
     * (use `privateKey`, else libp2p generates an ephemeral key).
     *
     * In the single-key reference model the authority signing key is *derived from*
     * the node identity (see {@link CadreNode.getIdentityAuthorityKey}), so
     * protecting the identity in a secure enclave protects the authority key too.
     * A future separate-authority slot (`authorityKeyId`) is anticipated but not
     * built here.
     */
    keyStore?: KeyStore;
    /** Slot id for the node identity in {@link keyStore}. Default: `'cadre/identity'`. */
    identityKeyId?: KeyId;
    /** Control network connection settings */
    controlNetwork: ControlNetworkConfig;
    /** Node profile: transaction-only or storage */
    profile: NodeProfile;
    /** Which strands to participate in */
    strandFilter?: StrandFilter;
    /** Storage configuration (only for storage profile) */
    storage?: StorageConfig;
    /** Network configuration */
    network?: NetworkConfig;
    /** Hibernation configuration */
    hibernation?: HibernationConfig;
    /** Polling interval for strand watcher in ms (default: 5000) */
    strandWatchInterval?: number;
    /**
     * Require a valid author signature on every sApp schema before a strand is
     * formed or joined. Defaults to true (fail closed): an unsigned schema is
     * rejected before any libp2p node or schema DDL is brought up. Set false ONLY
     * for dev/test where unsigned demo schemas are used.
     */
    requireSignedSchemas?: boolean;
    /**
     * Node-wide default trust anchor for INBOUND control-network seeds. Forwarded
     * into every SeedBootstrapService this node constructs (authority, receive-only
     * listener, and the temp service used by applySeed when no service exists), and
     * used as the service-level default the libp2p seed-protocol handler relies on
     * (that path has no per-call override seam). Defaults to dbAnchoredTrustPolicy()
     * inside SeedBootstrapService when unset — a cold-start node then rejects every
     * seed. A per-call `applySeed(seed, { trustPolicy })` override still wins over
     * this default for callers that hold out-of-band material (e.g. a pinned key
     * from a CadreInvite).
     */
    seedTrustPolicy?: SeedTrustPolicy;
    /**
     * Platform push-delivery credentials (FCM and/or APNs). When present, the node
     * can deliver strand-wake data messages to suspended mobile peers over the
     * platform push channel — the server fan-out constructs a `PushNotifier` from
     * this. Absent ⇒ no platform push (control-network push-wake only). Injected
     * per node by `cadre-host`; `privateKey` fields are secrets and are never logged.
     */
    push?: PushCredentials;
}
/**
 * Status of a strand instance
 */
export type StrandStatus = 'starting' | 'active' | 'idle' | 'hibernating' | 'stopping' | 'stopped' | 'error';
/**
 * App information from strand header
 */
export interface SAppInfo {
    id: string;
    version: string;
    schema: string;
    signature?: string;
}
/**
 * Strand instance state
 */
export interface StrandInstance {
    strandId: string;
    status: StrandStatus;
    sAppInfo?: SAppInfo;
    /** The libp2p node for this strand (only when active/idle) */
    libp2pNode?: Libp2p;
    /** The Quereus database for this strand (only when active/idle) */
    database?: StrandDatabase;
    /** Membership info for closed strands */
    memberKey?: string;
    memberPrivateKey?: string;
    /** Activity tracking */
    connectedPeers: number;
    lastActivity: Date;
    nextCheckIn?: Date;
    /** Latency hint from app or override */
    latencyHint: LatencyHint;
    /** Error message if status is 'error' */
    error?: string;
}
/**
 * Outcome of an on-demand {@link CadreNode.serviceWake} — the mobile push-wake
 * cycle (resume → bounded window → re-hibernate-if-idle) run imperatively for a
 * single strand.
 */
export interface ServiceWakeResult {
    /** The strand the wake was requested for. */
    strandId: string;
    /**
     * Whether the wake was actually serviced. `false` when the node is not
     * running, or the strand is unknown to this node (not a member-participated
     * strand) — never a thrown error, so a background task can branch on it.
     */
    serviced: boolean;
    /**
     * Whether activity landed during the wake window. `true` leaves the strand
     * active; `false` re-hibernates it (or the strand was already live, in which
     * case it reflects current liveness). Always `false` when `serviced` is `false`.
     */
    hadActivity: boolean;
}
/**
 * Strand row from control network - basic membership info
 */
export interface StrandRow {
    Id: string;
    MemberPrivateKey: string | null;
    Type: 'o' | 'c';
}
/**
 * sApp configuration provided by the hosting application when creating a strand.
 * This is what the app developer provides - NOT loaded from the network.
 */
export interface SAppConfig {
    /** Public key of the sApp author */
    id: string;
    /** Version of the sApp */
    version: string;
    /** The declarative schema DDL */
    schema: string;
    /**
     * Author's signature over the schema for verification. Required under the
     * default `requireSignedSchemas` node policy — a config without it is rejected
     * before strand bring-up. Optional in the type because authoring/serialization
     * must represent an as-yet-unsigned config; omitting it is honored only when
     * the node explicitly relaxes the policy (`requireSignedSchemas: false`, dev/test).
     */
    signature?: string;
    /** Latency hint for hibernation behavior (optional, defaults to config) */
    latencyHint?: LatencyHint;
}
/**
 * Lifecycle mode for a strand.
 *
 * - `bootstrap`: newly created locally; no remote peers exist for this strand yet.
 *   Schema apply and data operations route through a local (non-network) transactor
 *   so a solo node can fully initialize without any peer round trips.
 * - `networked`: strand has (or is expected to have) remote peers. Operations route
 *   through the network transactor.
 *
 * Transition `bootstrap -> networked` happens at first remote-peer enrollment for
 * the strand; because the transactor is fixed at plugin registration time, the
 * transition requires stopping and restarting the strand.
 */
export type StrandMode = 'bootstrap' | 'networked';
/**
 * Full strand configuration when adding a strand via the API
 */
export interface StrandConfig {
    /** Strand row from control network */
    strandRow: StrandRow;
    /** sApp configuration provided by the hosting application */
    sAppConfig: SAppConfig;
    /**
     * Lifecycle mode for this strand instance. When omitted, CadreNode infers the
     * mode from cohort membership (`bootstrap` for a solo/first node with no other
     * `CadrePeer` rows, `networked` once the cohort has other members). An explicit
     * value always wins.
     */
    mode?: StrandMode;
}
/**
 * Result of creating a new cadre peer
 */
export interface CreatePeerResult {
    peerId: PeerId;
    privateKey: Uint8Array;
}
/**
 * Registration data for joining a strand as a member.
 * Sent from invited member to any cadre member to accept invitation.
 */
export interface MemberRegistration {
    /** The strand being joined */
    strandId: string;
    /** The member's public key for this strand */
    key: string;
    /** Peer IDs of the member's cadre nodes that will participate */
    peerIds: string[];
}
/**
 * Result of member registration
 */
export interface MemberRegistrationResult {
    success: boolean;
    reason?: string;
}
/**
 * Open invitation for strand formation.
 * Shared out-of-band to allow strangers to form strands.
 */
export interface OpenInvitation {
    /** Unique token identifying this invitation */
    token: string;
    /** The sApp that will be used for the strand */
    sAppId: string;
    /** When this invitation expires */
    expiration: Date;
    /** Bootstrap addresses to contact the inviter's cadre */
    bootstrap: string[];
}
/**
 * Result of forming a strand via open invitation
 */
export interface FormStrandResult {
    /** The member key assigned to the initiator for this strand */
    memberKey: string;
    /** Private key for the invitation (for signing future messages) */
    invitePrivateKey: string;
    /** The strand that was created */
    strandId: string;
    /**
     * The strand's membership key (closed-strand read-gating secret), delivered through
     * the formation protocol after consent (provision-then-record). Present only for a
     * closed strand the responder returned with its key; undefined otherwise. Distinct
     * from {@link invitePrivateKey} (the initiator's own generated signing key).
     */
    memberPrivateKey?: string;
}
/**
 * Result of validating a strand formation request
 */
export interface ValidateFormationResult {
    /** Public key for validating this formation */
    validationKey: string;
    /** Signature over the formation approval */
    validationSignature: string;
}
/**
 * Disclosure object provided during strand formation.
 * Contains identity and context information from the initiator.
 */
export interface StrandFormationDisclosure {
    /** Initiator's party identifier */
    partyId?: string;
    /** Additional identity bundle (app-specific) */
    identityBundle?: unknown;
    /** Human-readable purpose/reason for forming the strand */
    purpose?: string;
    /** Additional app-specific metadata */
    metadata?: Record<string, unknown>;
}
/**
 * Arachnode ring participation stub - will be implemented when arachnode is built
 */
export interface ArachnodeConfig {
    /** Enable Arachnode subsystem (Ring Zulu + storage rings). Storage-profile only. */
    enableRingZulu: boolean;
    /** Storage ring participation (storage profile only) */
    storageRing?: {
        /** Which ring to participate in based on capacity */
        ring: number;
        /** Partition within the ring */
        partition?: number;
    };
}
/**
 * Events emitted by CadreNode
 */
export interface CadreNodeEvents {
    'strand:started': {
        strandId: string;
    };
    'strand:stopped': {
        strandId: string;
    };
    'strand:error': {
        strandId: string;
        error: Error;
    };
    'strand:idle': {
        strandId: string;
    };
    'strand:hibernating': {
        strandId: string;
    };
    'strand:waking': {
        strandId: string;
    };
    /**
     * Emitted when the control network advertises a strand this node has no
     * registered `sAppConfig` for — i.e. a strand created by another member. The
     * hosting app decides whether to join it (register a config + `addStrand`,
     * e.g. via a chat `joinChatStrand` helper). Carries the full {@link StrandRow}
     * so the app can join without re-querying the control DB.
     */
    'strand:discovered': {
        strandId: string;
        strand: StrandRow;
    };
    'control:connected': void;
    'control:disconnected': void;
    /** Emitted when a seed is received via the seed protocol */
    'seed:received': {
        partyId: string;
        peerId: string;
    };
    /** Emitted when a seed is successfully applied */
    'seed:applied': {
        partyId: string;
        peersAdded: number;
    };
    /** Emitted when seed application fails */
    'seed:error': {
        partyId: string;
        error: string;
    };
}
/**
 * A peer's self-published, freshness-stamped, self-signed address record.
 *
 * This is the logical shape of a `CadreControl.CadrePeer` row. A node publishes
 * its own record (signing with the ed25519 key behind its PeerId); any node can
 * resolve another member's current signaling/relay multiaddrs from only its
 * PeerId by reading the record, re-verifying the self-signature against
 * `publicKey`, checking freshness, and applying a trust gate.
 *
 * The signature covers `peerId`, the comma-joined `addrs`, and `updatedAt` — see
 * `peerRecordSignedPayload`. `publicKey` is NOT inside the signed payload: it is
 * the key the signature is verified *with*, and its libp2p-identity binding to
 * `peerId` is checked separately at resolve time, so re-signing it would be
 * redundant.
 */
export interface PeerAddressRecord {
    /** libp2p peer ID (base58btc) — the row key. */
    peerId: string;
    /** ed25519 public key (base64url) whose libp2p identity IS `peerId`. */
    publicKey: string;
    /** Current dialable multiaddrs, signaling (`/p2p-circuit`) first. */
    addrs: string[];
    /** epoch ms — freshness; strictly increasing per peer. */
    updatedAt: number;
    /** ed25519 self-signature over the signed payload, base64url. */
    sig: string;
}
/**
 * Outcome of {@link CadreNode.registerSelf}, surfaced so callers (e.g. the CLI
 * `--authority` branch) can log what happened:
 * - `inserted` — the first authority-signed INSERT of this node's `CadrePeer` row.
 * - `refreshed` — a self-signed UPDATE of an existing row (heartbeat / addr change).
 * - `skipped` — nothing written (no self-signing key, or not yet a member with no
 *   authority service to self-insert).
 */
export type SelfRegistrationOutcome = 'inserted' | 'refreshed' | 'skipped';
/**
 * Options for {@link CadreNode.resolvePeerAddrs}.
 */
export interface ResolveOpts {
    /**
     * Freshness ceiling in ms. A record older than this is filtered out (a
     * resolver must never hand back a dead relay reservation). Defaults to
     * {@link DEFAULT_PEER_RECORD_MAX_AGE_MS}.
     */
    maxAgeMs?: number;
    /** Return only `/p2p-circuit` signaling addrs (the WebRTC dial input). */
    signalingOnly?: boolean;
    /**
     * Pluggable trust gate, evaluated after signature + freshness pass. Defaults
     * to {@link currentMemberTrustPolicy} (any existing — therefore
     * authority-vouched — CadrePeer member is trusted). Inject a stricter policy
     * (e.g. from `seed-signerkey-trust-policy`) to reject otherwise-valid records
     * before dialing.
     */
    trustPolicy?: PeerResolveTrustPolicy;
}
/**
 * Context handed to a {@link PeerResolveTrustPolicy} when gating a resolution.
 */
export interface PeerResolveContext {
    /** The peer being resolved. */
    peerId: string;
    /** The record's ed25519 public key (already bound to `peerId` and verified). */
    publicKey: string;
    /** The party whose control network produced the record. */
    partyId: string;
    /** The full verified, fresh record. */
    record: PeerAddressRecord;
}
/**
 * Decides whether a signature-verified, fresh peer-address record should be
 * trusted enough to dial. The seam through which a richer trust model
 * (trust circle, pinned keys) composes with `resolvePeerAddrs`.
 */
export interface PeerResolveTrustPolicy {
    evaluate(ctx: PeerResolveContext): Promise<boolean> | boolean;
}
/** Platform push channel a {@link DeviceTokenRecord} targets. */
export type PushPlatform = 'fcm' | 'apns';
/**
 * A mobile cadre peer's self-published, freshness-stamped, self-signed platform
 * push token.
 *
 * This is the logical shape of a `CadreControl.DeviceToken` row. A phone publishes
 * its own record (signing with the ed25519 key behind its PeerId); a server peer
 * resolves it from the phone's PeerId to deliver a push-wake over FCM/APNs when a
 * control-network dial cannot reach the OS-suspended process. The signature covers
 * `peerId`, `platform`, `token`, and `updatedAt` — see `deviceTokenSignedPayload`.
 *
 * Unlike {@link PeerAddressRecord}, the record carries NO public key: it is verified
 * against the `CadrePeer.PublicKey` bound to the same `peerId`, so a `DeviceToken`
 * with no backing `CadrePeer` row can never be resolved.
 */
export interface DeviceTokenRecord {
    /** libp2p peer ID (base58btc) — the row key and the CadrePeer this token belongs to. */
    peerId: string;
    /** Push channel: `'fcm'` (Android/Firebase) or `'apns'` (Apple). */
    platform: PushPlatform;
    /** Opaque platform device/registration token. */
    token: string;
    /** epoch ms — freshness; strictly increasing per self-update (replay guard). */
    updatedAt: number;
    /** ed25519 self-signature over the signed payload, base64url. */
    sig: string;
}
/**
 * Options for {@link CadreNode.resolveDeviceToken}.
 */
export interface ResolveDeviceTokenOpts {
    /**
     * Optional freshness ceiling in ms. Defaults to NO ceiling (a record is fresh
     * as long as its `updatedAt` is positive): unlike a relay reservation, a device
     * push token stays valid until it rotates, so a long-suspended phone must remain
     * resolvable for push-wake. Set this to bound staleness explicitly.
     */
    maxAgeMs?: number;
}
/**
 * Platform push-delivery credentials injected into a participating node's config
 * (`CadreNodeConfig.push`). Provisioned per spawned node by `cadre-host` and read
 * by `createPushNotifier` to construct the FCM and/or APNs senders. A platform
 * whose block is absent is simply not deliverable (the router returns a
 * best-effort "no credentials" failure rather than throwing).
 *
 * Secret hygiene: every `privateKey` field is a secret — never logged (treated
 * like the node's startup/seed tokens).
 */
export interface PushCredentials {
    /** FCM (Android / Firebase) service-account credentials. */
    fcm?: FcmCredentials;
    /** APNs (Apple) auth-key credentials. */
    apns?: ApnsCredentials;
    /**
     * Per-`(peer, strand)` minimum gap between push-wakes the server fan-out emits —
     * the anti-spam cooldown a chatty strand needs. Default
     * {@link DEFAULT_PUSH_COOLDOWN_MS} (5 min). In-memory, acceptably lossy across
     * restarts (`serviceWake` is idempotent, so a duplicate wake is harmless).
     */
    cooldownMs?: number;
    /**
     * Per-strand burst-coalescing window for the fan-out: a second activity trigger
     * within this window is dropped (one wake is enough). Default
     * {@link DEFAULT_PUSH_DEBOUNCE_MS} (10 s).
     */
    debounceMs?: number;
}
/** Google service-account fields needed for FCM HTTP v1 OAuth2. */
export interface FcmCredentials {
    /** GCP project id → `POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send`. */
    projectId: string;
    /** Service-account email (JWT `iss`/`sub`). */
    clientEmail: string;
    /** Service-account RSA private key, PEM. Secret — never logged. */
    privateKey: string;
}
/** Apple APNs auth-key (.p8) fields. */
export interface ApnsCredentials {
    /** APNs key id (JWT header `kid`). */
    keyId: string;
    /** Apple team id (JWT `iss`). */
    teamId: string;
    /** App bundle id → `apns-topic` header. */
    bundleId: string;
    /** `.p8` ES256 private key, PEM. Secret — never logged. */
    privateKey: string;
    /** `true` → `api.push.apple.com`; false/undefined → `api.sandbox.push.apple.com`. */
    production?: boolean;
}
/**
 * A peer entry in a control network seed.
 * Contains connection information for a cadre peer.
 */
export interface SeedPeer {
    /** Peer ID (libp2p identity) */
    peerId: string;
    /** Multiaddrs for connecting to this peer */
    multiaddrs: string[];
    /** Whether this peer holds an authority key */
    isAuthority: boolean;
    /** ed25519 public key (base64url) — present on authority peers for signerKey verification */
    publicKey?: string;
}
/**
 * Control network seed for bootstrapping new nodes.
 * Pre-populates a new node's cache to solve the cold-start problem:
 * new nodes need control data to validate connections, but can't get
 * data without connecting first.
 */
export interface ControlNetworkSeed {
    /** Party ID this seed belongs to */
    partyId: string;
    /** Known peers in the cadre */
    peers: SeedPeer[];
    /** Signature over the seed by an authority key */
    signature: string;
    /** The authority key that signed this seed */
    signerKey: string;
}
/**
 * Message sent from instigator to new node during seed delivery.
 * Delivered via /sereus/seed/1.0.0 libp2p protocol.
 */
export interface SeedMessage {
    /** Party ID for the cadre */
    partyId: string;
    /** Known peers in the cadre */
    peers: SeedPeer[];
    /** Signature by an authority key */
    signature: string;
    /** The authority key that signed this message */
    signerKey: string;
}
/**
 * Acknowledgment message from new node to instigator.
 */
export interface SeedAckMessage {
    /** Whether the seed was accepted */
    accepted: boolean;
    /** Reason for rejection (if not accepted) */
    reason?: string;
}
/**
 * Request sent over the control network's `WAKE_PROTOCOL` from a same-cadre peer
 * to a hibernating peer, asking it to bring a strand online and pull pending
 * activity. The receiver gates this on cadre membership before honoring it.
 */
export interface WakeRequest {
    /** The strand the sender knows has pending activity. */
    strandId: string;
    /** Optional cause hint, e.g. `"activity"` (a server saw new traffic) or `"manual"`. */
    reason?: string;
}
/**
 * Acknowledgment of a {@link WakeRequest}, returned on the same stream.
 */
export interface WakeAck {
    /** Whether the receiver honored the wake (member + participated strand). */
    accepted: boolean;
    /** The strand's status after the wake (present when `accepted`). */
    status?: StrandStatus;
    /** Reason for rejection (non-member, unknown strand, malformed frame). */
    reason?: string;
}
/**
 * Options for authorizing a new peer in the cadre.
 */
export interface AuthorizePeerOptions {
    /** Peer ID to authorize */
    peerId: string;
    /** Optional multiaddrs for the peer */
    multiaddrs?: string[];
}
/**
 * Result of applying a seed to a node.
 */
export interface ApplySeedResult {
    /** Whether the seed was successfully applied */
    success: boolean;
    /** Number of peers added to the peer store */
    peersAdded: number;
    /** Error message if not successful */
    error?: string;
}
/**
 * Node network topology type for seed helper scenarios.
 */
export type NodeTopology = 'public' | 'nat';
/**
 * Invite code for phone-to-server enrollment.
 * Used when a server invites a phone to join the cadre.
 */
export interface CadreInvite {
    /** Party ID of the cadre */
    partyId: string;
    /** Multiaddrs to dial the authority */
    authorityAddrs: string[];
    /**
     * Authority ed25519 public keys (base64url) of the cadre, carried out-of-band
     * so a cold-start invitee can pin the trusted authority set before applying
     * any seed (the seed itself cannot vouch for its own signer). Populated by
     * `createInvite` from the issuer's `AuthorityKey` table.
     */
    authorityKeys?: string[];
    /** Optional invite token for validation */
    token?: string;
    /** Timestamp when invite was created */
    createdAt: number;
    /** Optional expiration timestamp */
    expiresAt?: number;
}
/**
 * Options for adding a drone via provider API.
 */
export interface AddDroneOptions {
    /** Peer ID of the new drone (returned from provider) */
    dronePeerId: string;
    /** Multiaddrs of the drone (returned from provider) */
    droneMultiaddrs: string[];
}
/**
 * Options for adding a phone via invite flow.
 */
export interface AddPhoneOptions {
    /** Peer ID of the phone (sent by phone when it connects) */
    phonePeerId: string;
    /** Invite token for validation (must match issued invite) */
    token?: string;
}
/**
 * Result of preparing a seed for drone initialization.
 */
export interface DroneInitResult {
    /** The seed to send to the provider API */
    seed: ControlNetworkSeed;
    /** Base64url encoded seed for transport */
    encodedSeed: string;
}
/**
 * Result of creating an invite for a phone.
 */
export interface InviteResult {
    /** The invite to share out-of-band */
    invite: CadreInvite;
    /** Base64url encoded invite for QR/link */
    encodedInvite: string;
}
