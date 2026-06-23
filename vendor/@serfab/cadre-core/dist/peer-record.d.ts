/**
 * Peer-address record helpers: the single source of truth for the bytes a node
 * signs when publishing its own `CadrePeer` row and re-verifies when resolving
 * another peer's row.
 *
 * The signed payload is a single SHA-256 digest of a delimited string of the
 * authenticated fields. It is intentionally NOT JSON-canonicalized: a delimited
 * digest is trivially deterministic across node/browser/RN (plain string concat
 * + sha256, no key ordering) and — crucially — is reconstructable inside the
 * `CadrePeer.AuthorizedUpdate` SQL constraint from the row's own columns:
 *
 *   digest(new.PeerId || '|' || new.Multiaddr || '|' || cast(new.UpdatedAt as text),
 *          'sha256', 'utf8')
 *
 * Keep {@link peerRecordSignedPayload} and that constraint byte-for-byte in
 * sync. The `'|'` delimiter is safe: a base58btc PeerId, a multiaddr (which uses
 * `/`), and a base-10 integer never contain it.
 *
 * `publicKey` is deliberately excluded from the payload — it is the key the
 * signature is verified *with* (so a signature already commits to exactly one
 * key), and its binding to `peerId` is checked separately at resolve time.
 */
import type { PeerAddressRecord, PeerResolveTrustPolicy } from './types.js';
/**
 * Default freshness ceiling for resolved peer-address records (15 minutes).
 * A record older than this is treated as stale and filtered out, so a resolver
 * never hands back a dead relay reservation. The publish path re-stamps at
 * roughly half this interval (see {@link DEFAULT_PEER_RECORD_HEARTBEAT_MS}).
 */
export declare const DEFAULT_PEER_RECORD_MAX_AGE_MS: number;
/**
 * TTL heartbeat interval for re-publishing the self record — half the freshness
 * ceiling, so a record is refreshed well before it can go stale.
 */
export declare const DEFAULT_PEER_RECORD_HEARTBEAT_MS: number;
/**
 * Build the base64url SHA-256 digest that the self-signature covers. Mirrors the
 * `CadrePeer.AuthorizedUpdate` constraint exactly; both sides take the default
 * base64url output of a single `digest(...)`, which round-trips cleanly (unlike
 * concatenating several base64url digests).
 *
 * @param peerId - base58btc libp2p peer id (the row key)
 * @param multiaddr - the comma-joined `Multiaddr` string EXACTLY as stored
 * @param updatedAt - epoch-ms freshness stamp
 */
export declare function peerRecordSignedPayload(peerId: string, multiaddr: string, updatedAt: number): string;
/**
 * Sign a peer-address record with the ed25519 private key behind its `peerId`.
 * Returns a fully-populated {@link PeerAddressRecord} (the `addrs` order is
 * preserved and is the order signed over).
 *
 * @param fields - the record fields to sign (signaling addr first by convention)
 * @param privateKeyB64 - base64url ed25519 seed (see `authorityKeyFromLibp2p`)
 */
export declare function signPeerRecord(fields: {
    peerId: string;
    publicKey: string;
    addrs: string[];
    updatedAt: number;
}, privateKeyB64: string): PeerAddressRecord;
/**
 * Verify a record's self-signature against its own `publicKey`. Reconstructs the
 * signed bytes from the record exactly as {@link signPeerRecord} produced them.
 * Returns false on a missing key/sig or any verification failure.
 */
export declare function verifyPeerRecordSignature(record: PeerAddressRecord): boolean;
/**
 * Freshness predicate: true when `updatedAt` is a positive stamp within
 * `maxAgeMs` of `now`. A non-positive `updatedAt` (never self-published) is
 * never fresh.
 */
export declare function isPeerRecordFresh(updatedAt: number, maxAgeMs: number, now: number): boolean;
/** True if `addr` is a `/p2p-circuit` signaling/relay multiaddr. */
export declare function isSignalingAddr(addr: string): boolean;
/**
 * Return `addrs` with signaling (`/p2p-circuit`) addrs first, otherwise stable.
 * Used to present the WebRTC dial input ahead of direct addrs. Does NOT mutate
 * the input and must not be used before signature verification (verification
 * uses the original on-record order).
 */
export declare function orderSignalingFirst(addrs: string[]): string[];
/**
 * Default resolve trust gate: trust any peer that has a `CadrePeer` row.
 *
 * A row only exists because an authority signed its `AuthorizedInsert`, so row
 * presence already means "authority-vouched member". This is the seam where a
 * stricter policy (trust circle, pinned keys) plugs in — see
 * {@link PeerResolveTrustPolicy}.
 */
export declare function currentMemberTrustPolicy(): PeerResolveTrustPolicy;
