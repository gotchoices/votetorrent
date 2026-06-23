import type { IKVStore } from '@optimystic/db-p2p';
import { type LevelDBLike } from './leveldb-like.js';
/**
 * LevelDB-backed `IKVStore` adapter for React Native peers.
 *
 * Shares one `LevelDBLike` database with `LevelDBRawStorage` and the identity
 * helper. KV keys are tagged with `TAG_KV` (and identity with `TAG_IDENTITY`),
 * so the three subsystems can't collide regardless of the user-chosen
 * `prefix`. `list(prefix)` is a range-bounded scan — never a full-database
 * iteration plus JS-side filter — so listing latency stays bounded.
 */
export declare class LevelDBKVStore implements IKVStore {
    private readonly db;
    private readonly prefix;
    constructor(db: LevelDBLike, prefix?: string);
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix: string): Promise<string[]>;
}
//# sourceMappingURL=leveldb-kv-store.d.ts.map