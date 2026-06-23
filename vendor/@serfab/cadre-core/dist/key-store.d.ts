/**
 * Backend-agnostic store for raw private key material.
 *
 * Mobile cadre nodes hold sensitive key material at rest: the libp2p
 * peer/node identity key and (in the single-key reference model) the authority
 * signing key derived from it. This module defines the seam those keys flow
 * through so a platform-secure backend (iOS Keychain / Android Keystore) can be
 * plugged in without `@serfab/cadre-core` taking any platform dependency.
 *
 * This file is dependency-free (no node:/RN imports) so it is safe in every
 * entry graph. The Node reference {@link FileKeyStore} lives in a separate
 * subpath module (`./key-store-file.js`) so its `node:fs` import never lands in
 * the cross-platform default entry.
 */
/** Opaque identifier for a stored key slot (e.g. 'cadre/identity'). */
export type KeyId = string;
/**
 * Default slot id for the node identity key. `CadreNode` reads/persists its
 * libp2p identity here when a {@link KeyStore} is configured without an explicit
 * `identityKeyId`.
 */
export declare const DEFAULT_IDENTITY_KEY_ID: KeyId;
/**
 * Backend-agnostic store for raw private key material. Implementations may be
 * file-based, OS-keyring, or platform secure-enclave backed (iOS Keychain /
 * Android Keystore). The interface makes no assumption about the backend and
 * never logs, returns, or throws key material.
 *
 * Key material is raw bytes (e.g. libp2p protobuf-serialized private keys).
 * Text-only backends encode/decode (base64) internally; byte-native backends
 * (LevelDB) store as-is.
 */
export interface KeyStore {
    /** Resolves to the stored material, or undefined if the slot is empty. */
    get(keyId: KeyId): Promise<Uint8Array | undefined>;
    /** Writes/overwrites the slot. */
    set(keyId: KeyId, keyMaterial: Uint8Array): Promise<void>;
    /** Removes the slot. Idempotent — succeeds even if absent. */
    delete(keyId: KeyId): Promise<void>;
    /** Enumerates the keyIds this store knows about. */
    list(): Promise<KeyId[]>;
}
/**
 * Thrown by {@link KeyStore.get} when access was denied or could not be
 * satisfied (e.g. a biometric/device-unlock prompt was cancelled or failed).
 * Distinguishes "access refused" from "slot empty" (which is a plain `undefined`
 * return). Biometric gating itself is out of scope here, but `get` rejecting
 * with this error is the contract a gated backend uses, so callers must not
 * treat it as "no key" (which would trigger key regeneration and silent
 * identity loss).
 *
 * Carries only the {@link keyId} — never key material — so it is safe to log.
 */
export declare class KeyStoreAccessError extends Error {
    readonly keyId: KeyId;
    constructor(keyId: KeyId, message: string, options?: {
        cause?: unknown;
    });
}
/**
 * In-memory {@link KeyStore} backed by a `Map`. For tests and ephemeral nodes;
 * nothing is persisted across process restarts. Dependency-free, so it is safe
 * in every entry graph.
 *
 * Material is defensively copied on both {@link set} and {@link get} so a caller
 * mutating its own buffer cannot alter stored state (and vice versa), matching
 * the fresh-buffer semantics a file/keyring backend produces.
 */
export declare class InMemoryKeyStore implements KeyStore {
    private readonly slots;
    get(keyId: KeyId): Promise<Uint8Array | undefined>;
    set(keyId: KeyId, keyMaterial: Uint8Array): Promise<void>;
    delete(keyId: KeyId): Promise<void>;
    list(): Promise<KeyId[]>;
}
