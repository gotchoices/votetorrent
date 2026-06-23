import type { PrivateKey } from '@libp2p/interface';
/**
 * A household authority keypair expressed in the base64url Ed25519 form that
 * `@optimystic/quereus-plugin-crypto` (`sign`/`verify`/`getPublicKey`) consumes.
 */
export interface AuthorityKeyPair {
    /** 32-byte Ed25519 seed, base64url-encoded — the crypto-plugin private key. */
    privateKeyB64: string;
    /** 32-byte Ed25519 public key, base64url-encoded. */
    publicKeyB64: string;
}
/**
 * Bridge a libp2p Ed25519 private key into the base64url keypair used by the
 * control-database authority constraints.
 *
 * libp2p stores an Ed25519 private key as 64 raw bytes: the first 32 are the
 * seed (the actual scalar source), the last 32 are the public key — see
 * `@libp2p/crypto`'s `Ed25519PrivateKey`. `@optimystic/quereus-plugin-crypto`
 * (via `@noble/curves`) treats the 32-byte seed *as* the private key and
 * derives the public key from it with standard Ed25519. The two derivations
 * agree, so the node's peer identity and its authority key are one keypair:
 * `getPublicKey(privateKeyB64)` === `publicKeyB64`.
 *
 * @param privateKey - The node's libp2p Ed25519 private key.
 * @returns The base64url seed/public-key pair for authority operations.
 * @throws If the key is not Ed25519 or the raw bytes aren't the expected length.
 */
export declare function authorityKeyFromLibp2p(privateKey: PrivateKey): AuthorityKeyPair;
/**
 * Derive the base64url Ed25519 public key from a base64url 32-byte private seed
 * — the same derivation the seed-bootstrap signer uses internally
 * (`SeedBootstrapService` constructor). Use this to enroll a standalone
 * (non-libp2p) authority key into the control DB via
 * `ControlDatabase.ensureAuthorityKey` before minting an invite, when the
 * authority key is *not* the node's peer identity (so `authorityKeyFromLibp2p`,
 * which needs a libp2p key object, does not apply).
 *
 * @param privateKeyB64 - The base64url-encoded 32-byte Ed25519 seed.
 * @returns The base64url-encoded Ed25519 public key.
 */
export declare function authorityPublicKeyFromPrivate(privateKeyB64: string): string;
