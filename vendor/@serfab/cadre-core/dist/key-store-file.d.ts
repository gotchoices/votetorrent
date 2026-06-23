import type { KeyId, KeyStore } from './key-store.js';
/**
 * File-backed {@link KeyStore}. Each slot is `<dir>/<encoded keyId>.key`
 * containing the raw material bytes. The directory is created lazily on first
 * {@link set}. Suitable for headless Node cadre nodes and tests; for mobile use
 * a platform secure-enclave backend instead.
 */
export declare class FileKeyStore implements KeyStore {
    private readonly dir;
    constructor(dir: string);
    private slotPath;
    get(keyId: KeyId): Promise<Uint8Array | undefined>;
    set(keyId: KeyId, keyMaterial: Uint8Array): Promise<void>;
    delete(keyId: KeyId): Promise<void>;
    list(): Promise<KeyId[]>;
}
