/**
 * Canonical digest an authority signs to authorize a peer.
 *
 * This is the exact byte construction {@link SeedBootstrapService.authorizePeer}
 * signs over when it inserts an authorized `CadrePeer` row:
 * `digest(peerId, 'sha256', 'utf8', 'base64url')`. Factored into one place so the
 * producer (authority signing) and the verifier (the offline `cadre enroll
 * register` check) can never drift apart — change the digest here and both move
 * together.
 */
export declare function peerAuthorizationDigest(peerId: string): string;
/**
 * Verify that `signature` is a valid authority ed25519 signature over `peerId`'s
 * authorization digest, using `authorityPublicKey` (base64url).
 *
 * This is the mirror of the signing done in
 * {@link SeedBootstrapService.authorizePeer}: it checks the signature against
 * {@link peerAuthorizationDigest}. A `true` result means the holder of the
 * authority private key vouched for this peer ID — it does NOT mean the peer is
 * registered anywhere.
 *
 * Returns a boolean and never throws: malformed base64url, a bad/garbage key, or
 * any crypto failure resolves to `false` (callers want a verdict, not an
 * exception). The catch is logged at debug.
 */
export declare function verifyPeerAuthorization(peerId: string, authorityPublicKey: string, signature: string): boolean;
