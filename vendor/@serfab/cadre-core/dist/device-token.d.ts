/**
 * Device-token record helpers: the single source of truth for the bytes a node
 * signs when publishing its own `DeviceToken` row and re-verifies when resolving
 * another peer's row.
 *
 * Modeled directly on {@link peerRecordSignedPayload} (peer-record.ts): the signed
 * payload is a single SHA-256 digest of a delimited string of the authenticated
 * fields. It is intentionally NOT JSON-canonicalized — a delimited digest is
 * trivially deterministic across node/browser/RN (plain string concat + sha256, no
 * key ordering) and is reconstructable inside the `DeviceToken.AuthorizedUpdate` SQL
 * constraint from the row's own columns:
 *
 *   digest(new.PeerId || '|' || new.Platform || '|' || new.Token || '|'
 *          || cast(new.UpdatedAt as text), 'sha256', 'utf8')
 *
 * Keep {@link deviceTokenSignedPayload} and that constraint byte-for-byte in sync.
 * The `'|'` delimiter is safe: a base58btc PeerId, a fixed `'fcm'`/`'apns'` platform
 * string, and a base-10 integer never contain it. The opaque platform token is the
 * last variable-length field before the integer stamp, so even a token containing a
 * `'|'` cannot create a collision with a different field split.
 *
 * Unlike a peer-address record, a device-token record carries NO public key: the
 * signature is verified against the `CadrePeer.PublicKey` bound to the same PeerId
 * (the resolver supplies it), so the key binding is checked exactly once, where the
 * membership row already lives.
 */
import type { DeviceTokenRecord, PushPlatform } from './types.js';
/**
 * Build the base64url SHA-256 digest that the self-signature covers. Mirrors the
 * `DeviceToken.AuthorizedUpdate` constraint exactly; both sides take the default
 * base64url output of a single `digest(...)`, which round-trips cleanly.
 */
export declare function deviceTokenSignedPayload(record: Omit<DeviceTokenRecord, 'sig'>): string;
/**
 * Sign a device-token record with the ed25519 private key behind its `peerId`.
 * Returns a fully-populated {@link DeviceTokenRecord}.
 *
 * @param fields - the record fields to sign
 * @param privateKeyB64 - base64url ed25519 seed (see `authorityKeyFromLibp2p`)
 */
export declare function signDeviceTokenRecord(fields: Omit<DeviceTokenRecord, 'sig'>, privateKeyB64: string): DeviceTokenRecord;
/**
 * Verify a record's self-signature against the `CadrePeer.PublicKey` (base64url)
 * bound to its `peerId`. Reconstructs the signed bytes from the record exactly as
 * {@link signDeviceTokenRecord} produced them. Returns false on a missing key/sig or
 * any verification failure.
 */
export declare function verifyDeviceTokenSignature(record: DeviceTokenRecord, publicKeyB64: string): boolean;
/** Narrow an arbitrary stored string to a known {@link PushPlatform}. */
export declare function isPushPlatform(value: string): value is PushPlatform;
