import type { Libp2p } from '@libp2p/interface';
import type { ControlNetworkSeed, SeedAckMessage, AuthorizePeerOptions, ApplySeedResult, AddDroneOptions, AddPhoneOptions, DroneInitResult, InviteResult, CadreInvite, PeerAddressRecord, DeviceTokenRecord } from './types.js';
import type { ControlDatabase } from './control-database.js';
import { type SeedTrustPolicy } from './seed-trust-policy.js';
/** Protocol ID for seed delivery */
export declare const SEED_PROTOCOL = "/sereus/seed/1.0.0";
/**
 * Decode a 4-byte big-endian length-prefixed frame; returns the body bytes.
 *
 * Guards every parse site against malformed input: a buffer too short to hold
 * the prefix, a declared length exceeding `maxLength`, and a declared length
 * exceeding the bytes actually present. Returns a view (`subarray`, no copy) —
 * the body is handed straight to `TextDecoder`.
 */
export declare function decodeLengthPrefixedFrame(data: Uint8Array, maxLength?: number): Uint8Array;
/**
 * Derive the base64url ed25519 public key embedded in an Ed25519 libp2p PeerId.
 *
 * An Ed25519 PeerId is an identity multihash of the public key, so
 * `peerIdFromString(id).publicKey.raw` is the 32-byte ed25519 key whose
 * base64url form matches the `AuthorityKey.Key` representation (and
 * `authorityKeyFromLibp2p().publicKeyB64`). Returns null for a non-Ed25519
 * id, a missing embedded key, or any parse failure — callers treat null as
 * "not an authority" rather than throwing.
 */
export declare function ed25519PublicKeyB64FromPeerId(peerId: string): string | null;
/**
 * Canonical byte representation of the authenticated seed fields.
 *
 * Routes both the creator (`createSeed`) and the verifier
 * (`validateSeedSignature`) through one builder so the signed bytes are
 * identical regardless of key insertion order. `canonicalJson` sorts keys and
 * drops `undefined`, so the signed payload is exactly `{ partyId, peers }` —
 * the fields the producer actually emits.
 */
export declare function canonicalSeedPayload(seed: Pick<ControlNetworkSeed, 'partyId' | 'peers'>): string;
/**
 * Configuration for the SeedBootstrapService
 */
export interface SeedBootstrapConfig {
    /** Party ID for this cadre */
    partyId: string;
    /** Authority private key for signing seeds and peer authorizations (base64url) */
    authorityPrivateKey?: string;
    /** Authority public key (base64url) - derived from private key if not provided */
    authorityPublicKey?: string;
    /**
     * Optional async resolver returning the multiaddrs to embed in invites.
     * When unset, `libp2pNode.getMultiaddrs()` is used. Hosts behind NAT supply
     * this (via `@serfab/cadre-host`'s NatService) to substitute the host's
     * DDNS hostname and externally-mapped port.
     */
    inviteAddressResolver?: () => Promise<string[]>;
    /**
     * Trust anchor for incoming seeds. Decides whether a signature-verified
     * `signerKey` should be trusted, against the receiver's known authority
     * keys (NOT the seed body). Defaults to `dbAnchoredTrustPolicy()`, which
     * rejects any signer not already in the `AuthorityKey` table. An enrollment
     * caller can pass a per-seed override to `applySeed` instead.
     *
     * A `CadreNode` forwards its node-wide `CadreNodeConfig.seedTrustPolicy` here
     * — that is the only seam the inbound libp2p seed-protocol handler can use,
     * since a network-delivered seed has no per-call override.
     */
    trustPolicy?: SeedTrustPolicy;
}
/**
 * Event callbacks for seed-related events
 */
export interface SeedEventCallbacks {
    /** Called when a seed is received via the protocol */
    onSeedReceived?: (partyId: string, peerId: string) => void;
    /** Called when a seed is successfully applied */
    onSeedApplied?: (partyId: string, peersAdded: number) => void;
    /** Called when seed application fails */
    onSeedError?: (partyId: string, error: string) => void;
}
/**
 * SeedBootstrapService handles control network seed generation and delivery.
 *
 * Seeds solve the cold-start problem: new nodes need control data to validate
 * connections, but can't get data without connecting first. Seeds pre-populate
 * the new node's cache with peer information.
 */
export declare class SeedBootstrapService {
    private readonly config;
    private libp2pNode;
    private controlDatabase;
    private readonly authorityPublicKey;
    private readonly trustPolicy;
    private eventCallbacks;
    constructor(config: SeedBootstrapConfig);
    /**
     * Set event callbacks for seed-related events.
     * Used by CadreNode to emit events.
     */
    setEventCallbacks(callbacks: SeedEventCallbacks): void;
    /**
     * Initialize the service with libp2p node and control database.
     *
     * `registerHandler` (default true) gates registration of the shared inbound
     * `/sereus/seed/1.0.0` handler on `libp2pNode`. Persistent services
     * (`initializeSeedBootstrap`, `enableSeedListener`) own that handler and leave
     * it on. The throwaway temp services CadreNode builds in `applySeed` /
     * `dialInvite` pass `false`: they only need the stored `libp2pNode` /
     * `controlDatabase` for dialing and known-key lookup, and must NOT bind a
     * discarded closure to the shared node (a handler leak, and a second
     * `handle()` of the same protocol throws `DuplicateProtocolHandlerError`).
     */
    initialize(libp2pNode: Libp2p, controlDatabase: ControlDatabase, options?: {
        registerHandler?: boolean;
    }): void;
    /**
     * Authorize a new peer to join the cadre.
     * Signs the peer ID with the authority key and inserts into CadrePeer table.
     *
     * The authority vouches the `PublicKey <-> PeerId` binding: rather than trust a
     * caller-supplied key, the binding is enforced by construction — `PublicKey` is
     * DERIVED from the (Ed25519) `peerId`. A non-Ed25519 peer id yields a null
     * `PublicKey`, and such a row can never be self-updated (it has no key to
     * verify against), which is correct. The row is inserted with a fresh
     * `UpdatedAt` but no self-signature (`Sig` null) — the authority cannot produce
     * the peer's self-signature, so the peer must self-publish (see
     * {@link CadreNode.registerSelf}) before the row resolves.
     */
    authorizePeer(options: AuthorizePeerOptions): Promise<void>;
    /**
     * Authority-signed INSERT of this node's OWN self-signed address record.
     *
     * Used by {@link CadreNode.registerSelf} when the node is not yet a member and
     * is its own authority (it holds the authority key): the row is authority-signed
     * (satisfying `AuthorizedInsert`) AND carries a valid self-`Sig`, so it resolves
     * immediately without a follow-up self-update.
     */
    insertSelfPeerRecord(record: PeerAddressRecord): Promise<void>;
    /**
     * Shared authority-signed `CadrePeer` INSERT. Signs `digest(peerId)` with the
     * authority key (satisfying `AuthorizedInsert`) and writes the full record
     * row. The authority signature does NOT cover the address columns — those are
     * vouched only as far as the authority asserts them, and a peer's own `Sig`
     * (when present) is what makes the row resolvable.
     */
    private insertCadrePeerRow;
    /**
     * Authority-signed INSERT of a peer's OWN self-signed `DeviceToken` row.
     *
     * Counterpart to {@link insertSelfPeerRecord} for the device-token registry: the
     * row is authority-signed (satisfying `DeviceToken.AuthorizedInsert`, which vouches
     * membership exactly as `CadrePeer.AuthorizedInsert` does) AND carries the peer's
     * own self-`Sig` over the token payload. The authority signature covers only the
     * PeerId — it does NOT vouch the token contents; the peer's `Sig` (verified at
     * resolve time against the bound `CadrePeer.PublicKey`) is what makes the row
     * resolvable. Used by {@link CadreNode.registerDeviceToken} for the first publish
     * when the node is its own authority.
     */
    insertSelfDeviceToken(record: DeviceTokenRecord): Promise<void>;
    /**
     * Authority-signed DELETE of a peer's `DeviceToken` row (logout / token
     * invalidation). The `DeviceToken.AuthorizedInsert` constraint gates both insert
     * AND delete on an authority signature over `digest(old.PeerId)`, so — like
     * {@link removePeer} for `CadrePeer` — clearing a token requires the authority key.
     */
    deleteDeviceToken(peerId: string): Promise<void>;
    /**
     * Sign a peer ID with the authority key for a `CadrePeer` / `DeviceToken`
     * insert-or-delete. The signed bytes come from the shared
     * {@link peerAuthorizationDigest} helper so the offline `cadre enroll register`
     * verifier checks the exact same construction. Throws if no authority key is set.
     */
    private signPeerAuthorization;
    /**
     * Remove a peer from the cadre by authority signature.
     *
     * The constraint over CadrePeer's `check on insert, delete` validates a
     * signature over `digest(old.PeerId, 'sha256', 'utf8')` by an authority
     * key. We use the same digest pattern as authorizePeer.
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
     * Validates the seed signature, then evaluates a trust anchor for the
     * `signerKey` that does NOT come from the seed body: the receiver's
     * `AuthorityKey` table (DB-anchored), optionally augmented by pinned keys or
     * TOFU via the configured/overriding `SeedTrustPolicy`. A forged
     * self-asserting seed — one that merely lists its own signer as an authority
     * peer — no longer passes.
     *
     * @param seed - The seed to apply (already transport-decoded).
     * @param options.trustPolicy - Per-call policy override (e.g. a
     *   `pinnedKeyTrustPolicy` derived from a `CadreInvite`) used instead of the
     *   service-configured default for this seed only.
     */
    applySeed(seed: ControlNetworkSeed, options?: {
        trustPolicy?: SeedTrustPolicy;
    }): Promise<ApplySeedResult>;
    /**
     * Encode a seed for out-of-band delivery (e.g., QR code, copy/paste).
     */
    encodeSeed(seed: ControlNetworkSeed): string;
    /**
     * Decode a seed from base64url encoding.
     */
    decodeSeed(encoded: string): ControlNetworkSeed;
    /**
     * Deliver a seed directly to a peer via the /sereus/seed/1.0.0 protocol.
     */
    deliverSeed(targetMultiaddr: string, seed: ControlNetworkSeed): Promise<SeedAckMessage>;
    /**
     * Get this node's circuit relay address for inclusion in seeds.
     * Returns null if no relay address is available.
     */
    getRelayAddress(): Promise<string | null>;
    /**
     * Validate a seed's signature.
     */
    validateSeedSignature(seed: ControlNetworkSeed): boolean;
    /**
     * Query peers from the control database.
     *
     * Authority identity is sourced from the `AuthorityKey` table, not from the
     * transport peer ID. An Ed25519 libp2p PeerId embeds its public key (identity
     * multihash), so each peer's ed25519 key is derivable from its `PeerId`; a
     * peer is an authority iff that derived key is in the `AuthorityKey` set.
     * This makes any authority node markable — not just the local one — and ties
     * `isAuthority` to the control table rather than to `peerId === self`.
     */
    private queryPeers;
    /**
     * Register the seed protocol handler.
     */
    private registerProtocolHandler;
    /**
     * Shutdown the service.
     */
    shutdown(): Promise<void>;
    /**
     * Add a drone to the cadre (phone/server adds provider-hosted node).
     *
     * Use this when you've spawned a drone via provider API and received its
     * peer ID and multiaddrs. This method:
     * 1. Authorizes the drone peer
     * 2. Creates a seed including all current peers
     * 3. Returns the seed for sending to provider API
     *
     * @param options - Drone peer info from provider API
     * @returns Seed and encoded seed for drone initialization
     */
    addDrone(options: AddDroneOptions): Promise<DroneInitResult>;
    /**
     * Create an invite for a phone to join the cadre.
     *
     * Use this when a server (public IP) wants to invite a phone (NAT'd).
     * The invite is shared out-of-band (QR code, link, etc.) and contains
     * the server's address so the phone can dial in.
     *
     * @param token - Optional invite token for validation
     * @param expiresIn - Optional expiration time in milliseconds
     * @returns Invite and encoded invite for sharing
     */
    createInvite(token?: string, expiresIn?: number): Promise<InviteResult>;
    /**
     * Accept a phone connection using an invite.
     *
     * Use this when a phone dials in with an invite token. This method:
     * 1. Validates the token if provided
     * 2. Authorizes the phone peer
     *
     * After this, the phone can sync the control database normally.
     *
     * @param options - Phone peer info and invite token
     * @param issuedInvite - The original invite for validation
     */
    acceptPhone(options: AddPhoneOptions, issuedInvite?: CadreInvite): Promise<void>;
    /**
     * Add a phone to the cadre with relay support.
     *
     * Use this when both nodes are NAT'd (phone-to-phone). This method:
     * 1. Authorizes the new phone peer
     * 2. Creates a seed with relay addresses for dialing
     *
     * @param phonePeerId - Peer ID of the new phone
     * @returns Seed with relay addresses for out-of-band delivery
     */
    addPhoneWithRelay(phonePeerId: string): Promise<DroneInitResult>;
    /**
     * Encode an invite for out-of-band delivery.
     */
    encodeInvite(invite: CadreInvite): string;
    /**
     * Decode an invite from base64url encoding.
     */
    decodeInvite(encoded: string): CadreInvite;
    /**
     * Dial an authority from an invite.
     * Use this on a phone after receiving an invite to connect to the authority.
     *
     * @param invite - The invite received out-of-band
     * @returns Connection to the authority
     */
    dialInvite(invite: CadreInvite): Promise<void>;
}
