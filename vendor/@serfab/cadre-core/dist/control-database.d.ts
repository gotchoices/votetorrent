import { Database } from '@quereus/quereus';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { StrandRow, PeerAddressRecord, DeviceTokenRecord } from './types.js';
/**
 * Build the canonical authorization message that authority signatures are bound to.
 *
 * The message is the byte concatenation of the per-field SHA-256 digests, in a fixed
 * field order, with the single-use StampId as the final field:
 *
 *   message = sha256(utf8(field_1)) ++ sha256(utf8(field_2)) ++ ... ++ sha256(utf8(StampId))
 *
 * ed25519 signs these raw bytes DIRECTLY (no pre-hash). The SQL constraints verify the
 * identical bytes by concatenating the hex-encoded digests
 * (`digest(field, 'sha256', 'utf8', 'hex') || ...`) and decoding with verify's `'hex'`
 * input encoding — so signer and verifier operate on the same bytes. This binds the
 * signature to the row contents (not a bare stamp), closing the captured-stamp replay /
 * privilege-escalation hole. Single source of truth: every signed writer (and every
 * test/harness signer) MUST build the message through this function in the schema's field
 * order, or `verify` will reject the row.
 */
export declare function buildAuthorizationMessage(fields: string[]): Uint8Array;
/**
 * Names of the CadreControl tables that {@link ControlDatabase.countRows} can
 * read. Constraining to this union keeps the dynamic `from` clause off the
 * SQL-injection surface and hands callers (e.g. the integration harness's
 * `waitForControlSync`) a typo-proof table argument.
 */
export type ControlTable = 'AuthorityKey' | 'ValidationKey' | 'Strand' | 'CadrePeer' | 'DeviceToken' | 'FormationInvite' | 'FormationUsage';
export interface ControlDatabaseConfig {
    /** Party ID for the control network */
    partyId: string;
    /**
     * Optional path to the control schema file.
     * If not provided, uses the embedded schema for cross-platform compatibility.
     * Only use this if you need to override the default schema (e.g., for testing).
     */
    schemaPath?: string;
    /** Libp2p node for the control network (injected) */
    libp2pNode: Libp2p;
    /** Coordinated repo from the libp2p node */
    coordinatedRepo: IRepo;
}
/**
 * ControlDatabase manages the CadreControl schema using Quereus with Optimystic backend.
 * It provides typed query methods for accessing control network data.
 */
export declare class ControlDatabase {
    private db;
    private collectionFactory;
    private readonly config;
    private initialized;
    constructor(config: ControlDatabaseConfig);
    /**
     * Initialize the database - load schema and register plugins
     */
    initialize(): Promise<void>;
    private loadSchema;
    /**
     * Query all strands from the control database
     */
    queryStrands(): Promise<StrandRow[]>;
    /**
     * Read a single strand row by id, or null when absent. Single-row sibling of
     * {@link queryStrands}; the responder uses it to read a host strand's
     * `MemberPrivateKey` (the closed-strand read-gating secret) for delivery to a
     * validated invitee during provision-then-record formation.
     */
    queryStrand(strandId: string): Promise<StrandRow | null>;
    /**
     * Count rows in a CadreControl table as seen by THIS database instance.
     *
     * `table` is validated against {@link CONTROL_TABLES} before it is interpolated
     * into the `from` clause: the names are not user input, but the check keeps the
     * dynamic query off the injection surface and fails loudly on a typo instead of
     * emitting a malformed statement. The count reflects only the rows this node's
     * control DB has converged on — in the integration harness that is the authority
     * node (one ControlDatabase per party), i.e. the authoritative control-network
     * view, not a per-drone convergence guarantee.
     */
    countRows(table: ControlTable): Promise<number>;
    /**
     * Get the underlying database for advanced queries
     */
    getDatabase(): Database;
    /**
     * Check whether any authority key exists in the control database.
     * Used to decide whether a fresh-party genesis insert is required.
     */
    hasAuthorityKey(): Promise<boolean>;
    /**
     * Idempotent genesis: insert `key` as the founding authority key only when
     * the party has none yet. Returns true if it inserted, false if an authority
     * key already existed (so a repeat `--authority` start is a no-op).
     */
    ensureAuthorityKey(key: string): Promise<boolean>;
    /**
     * Collect every authority key (`CadreControl.AuthorityKey.Key`) as a set.
     *
     * This is the steady-state trust anchor for seeds: a seed's signer key is
     * trusted only if it is already enrolled here (see `SeedTrustPolicy`). It is
     * also the authority-identity source for `queryPeers`, decoupling authority
     * status from the libp2p transport peer ID.
     */
    getAuthorityKeys(): Promise<Set<string>>;
    /**
     * Enumerate the CadrePeer rows (cadre membership) for admin/membership reads.
     */
    queryCadrePeers(): Promise<Array<{
        peerId: string;
        multiaddr: string | null;
    }>>;
    /**
     * Read a single peer's address record (the full `CadrePeer` row) by PeerId.
     *
     * Returns null when no row exists. Missing/legacy column values are coalesced
     * to their empty form (`''` key/sig, `[]` addrs, `0` stamp) so the caller's
     * verify/freshness gates uniformly reject an unpublished or malformed row.
     * The split `addrs` re-join to the exact stored `Multiaddr` (split-on-`,` is
     * the inverse of join-on-`,`), so the resolver re-verifies over the same bytes
     * the publisher signed.
     */
    queryPeerRecord(peerId: string): Promise<PeerAddressRecord | null>;
    /**
     * Apply a peer's own self-signed address-record update to an existing row.
     *
     * Authorization is carried entirely by the record: the `Sig` column (verified
     * by the `AuthorizedUpdate` self-branch against the stored `PublicKey`) plus
     * the strictly-increasing `UpdatedAt`. No authority key is involved, so this
     * is the refresh path for any member — authority or drone — once its row
     * exists. `PublicKey` is intentionally not in the SET list (it is immutable on
     * self-update and the constraint enforces `new.PublicKey = old.PublicKey`).
     */
    updateSelfPeerRecord(record: PeerAddressRecord): Promise<void>;
    /**
     * Read a single peer's device push token (the full `DeviceToken` row) by PeerId.
     *
     * Returns null when no row exists. Missing/legacy column values are coalesced to
     * their empty form (`''` token/sig, `0` stamp) so the caller's verify/freshness
     * gates uniformly reject an unpublished or malformed row. `platform` is returned
     * verbatim (the resolver validates it against {@link PushPlatform} and re-verifies
     * the self-signature, which covers the platform field).
     */
    queryDeviceToken(peerId: string): Promise<DeviceTokenRecord | null>;
    /**
     * Apply a peer's own self-signed device-token update to an existing row.
     *
     * Authorization is carried entirely by the record: the `Sig` column (verified by
     * the `DeviceToken.AuthorizedUpdate` self-branch against the stored
     * `CadrePeer.PublicKey`) plus the strictly-increasing `UpdatedAt`. No authority key
     * is involved, so this is the refresh / rotation path for any member once both its
     * `CadrePeer` row (for the PublicKey) and its `DeviceToken` row exist. `PeerId` is
     * intentionally not in the SET list (immutable; the constraint enforces
     * `new.PeerId = old.PeerId`). Mirrors {@link updateSelfPeerRecord}.
     */
    updateSelfDeviceToken(record: DeviceTokenRecord): Promise<void>;
    /**
     * Insert the initial authority key (bootstrap - no existing authorities required)
     */
    insertAuthorityKey(key: string): Promise<void>;
    /**
     * Insert a strand into the control database using an authority signature.
     *
     * The authority signs the canonical row-bound authorization message (see
     * {@link buildAuthorizationMessage}) — NOT a bare stamp — so the signature is bound to
     * this strand's contents and cannot be transplanted onto an attacker-chosen row. The
     * StampId is persisted as a unique column for single-use anti-replay.
     *
     * @param strandId - Unique identifier for the strand
     * @param type - Strand type: 'o' for open, 'c' for closed
     * @param authorityKey - Public key of the authorizing authority
     * @param signMessage - Function that ed25519-signs the raw message bytes (no pre-hash)
     *   with the authority's private key, returning a base64url signature
     * @param memberPrivateKey - Optional private key for membership in closed strands
     */
    insertStrand(strandId: string, type: 'o' | 'c', authorityKey: string, signMessage: (message: Uint8Array) => string, memberPrivateKey?: string): Promise<void>;
    /**
     * Insert a validation key into the control database using an authority signature.
     *
     * Mirrors {@link insertStrand}: the authority signs the canonical row-bound
     * authorization message over (Key, StampId), and the StampId is persisted as a unique
     * column for single-use anti-replay. A `ValidationKey` authorizes verifying strand
     * formation disclosures.
     *
     * @param key - The validation public key to enroll
     * @param authorityKey - Public key of the authorizing authority
     * @param signMessage - Function that ed25519-signs the raw message bytes (no pre-hash)
     *   with the authority's private key, returning a base64url signature
     */
    insertValidationKey(key: string, authorityKey: string, signMessage: (message: Uint8Array) => string): Promise<void>;
    /**
     * Insert an authority-signed `FormationInvite` (open invitation token).
     *
     * The invite is the on-network record that later authorizes an
     * authority-signature-FREE `Strand` creation: an invited cadre peer redeems it
     * by inserting a matching `FormationUsage` row (see {@link redeemInvitation}),
     * which satisfies the consent branch of `Strand.Authorized`.
     *
     * Like {@link insertStrand}/{@link insertValidationKey}, the authority signs the
     * canonical row-bound authorization message (see {@link buildAuthorizationMessage})
     * over (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId, StampId) — NOT a
     * bare stamp — so the signature is bound to this invite's contents and cannot be
     * transplanted onto an attacker-chosen row. The StampId is persisted as a unique
     * column for single-use anti-replay. `FormationInvite.AuthorizedAddOrRemove` gates
     * both insert and delete; its `coalesce(new, old)` verify binds the NEW row on
     * insert and the OLD row on delete.
     *
     * `StrandId` binds the invite to a pre-existing host strand (provision-then-record):
     * when set, a responder redeeming this token records a `FormationUsage` against that
     * strand and returns it (see {@link ControlFormationUsageRecorder.resolveStrand}); a
     * null `StrandId` (the default) leaves the legacy responder-provisions path in place.
     * Like ValidationUrl it is a nullable bound field, signed as `''` when absent.
     *
     * The ExpiresAt and TotalUses message fields must byte-match what the (auto-deferred,
     * because it has a subquery) CHECK sees AFTER column coercion: TotalUses becomes a
     * decimal string (`String(totalUses)` ⇔ `cast(new.TotalUses as text)`) and ExpiresAt
     * becomes the engine's canonical `PlainDateTime` string — sourced here from
     * {@link canonicalDatetime} (a `select datetime(?)` round-trip) rather than a hand-rolled
     * ISO formatter, so signer and verifier agree exactly. A null ExpiresAt / TotalUses /
     * ValidationUrl signs as `''`, matching the schema's `coalesce(..., '')`.
     *
     * @param token - Invitation token (the `FormationInvite` primary key)
     * @param sAppId - The sApp a redeemed strand will use
     * @param authorityKey - Public key of the authorizing authority
     * @param signMessage - ed25519-signs the raw message bytes (no pre-hash),
     *   returning a base64url signature — the same callback shape {@link insertStrand} uses
     * @param options - Optional `expiresAtMs` (epoch ms), `totalUses`, `validationUrl`,
     *   `strandId` (bind to a pre-existing host strand for provision-then-record)
     */
    insertFormationInvite(token: string, sAppId: string, authorityKey: string, signMessage: (message: Uint8Array) => string, options?: {
        expiresAtMs?: number;
        totalUses?: number;
        validationUrl?: string;
        strandId?: string;
    }): Promise<void>;
    /**
     * Canonicalise an epoch-ms timestamp to the exact `datetime` string Quereus stores,
     * by round-tripping through the engine's own `datetime(?)` scalar — the same parse the
     * `datetime` column coercion uses. This avoids a hand-rolled ISO formatter whose
     * fractional-second handling could diverge from Temporal, keeping the signed ExpiresAt
     * field byte-identical to the value the deferred CHECK verifies. Pure scalar eval (no
     * network), mirroring the {@link nextUseNumber} eval pattern.
     */
    private canonicalDatetime;
    /**
     * Redeem a `FormationInvite` by inserting the `Strand` row and a matching
     * `FormationUsage` row **atomically, in one transaction**.
     *
     * The two CHECK constraints are mutually circular under immediate evaluation:
     * `Strand.Authorized`'s consent branch requires the `FormationUsage` row, while
     * `FormationUsage.StrandExists` requires the `Strand` row. Both CHECKs contain
     * subqueries, so Quereus auto-defers them to transaction commit — wrapping both
     * inserts in a single explicit `begin … commit` lets both deferred CHECKs see
     * both rows at commit. The strand is authorised WITHOUT an authority signature
     * (the `FormationUsage` branch of `Strand.Authorized`) but still gets a fresh,
     * unique `StampId` column to satisfy the not-null/unique anti-replay column.
     *
     * `UseNumber` is computed as `max(UseNumber)+1` for the token (the `Monotonic`
     * constraint); callers redeeming concurrently against the same token must
     * serialise, since the next use number is read before the insert.
     */
    redeemInvitation(params: {
        token: string;
        strandId: string;
        type?: 'o' | 'c';
        memberPrivateKey?: string;
        disclosure?: string;
        peerId?: string;
        peerSignature?: string;
        nowMs?: number;
        validationKey?: string;
        validationSignature?: string;
    }): Promise<void>;
    /**
     * Record a `FormationUsage` against an **already-existing** `Strand` (no strand
     * insert). This is the redemption path when the strand was provisioned
     * separately (e.g. authority-signed) and the consent record is added after the
     * fact: the single insert auto-commits, and the deferred `StrandExists` CHECK
     * is satisfied by the pre-existing committed strand row. Returns the assigned
     * `UseNumber`.
     *
     * Use {@link redeemInvitation} instead when the strand must be created by
     * consent atomically with the usage.
     */
    recordFormationUsage(params: {
        token: string;
        strandId: string;
        disclosure?: string;
        peerId?: string;
        peerSignature?: string;
        nowMs?: number;
        validationKey?: string;
        validationSignature?: string;
    }): Promise<number>;
    /** Parameterised `FormationUsage` insert shared by redeem + record paths. */
    private execFormationUsageInsert;
    /**
     * Read a `FormationInvite` row by token, or null when absent. `expiresAtMs` is
     * the parsed epoch-ms of the stored `datetime` (null when the invite never
     * expires); the caller compares it against the wall clock for freshness.
     */
    queryFormationInvite(token: string): Promise<{
        token: string;
        sAppId: string;
        expiresAtMs: number | null;
        totalUses: number | null;
        validationUrl: string | null;
        strandId: string | null;
    } | null>;
    /**
     * Count `FormationUsage` rows recorded against a token (uses consumed so far).
     */
    countFormationUsage(token: string): Promise<number>;
    /** Next `UseNumber` for a token = max(existing)+1, per the `Monotonic` constraint. */
    private nextUseNumber;
    /**
     * Close the database and cleanup resources
     */
    close(): Promise<void>;
    private ensureInitialized;
}
