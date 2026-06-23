import { drain } from './leveldb-like.js';
import { kvKey, kvKeyToString, kvPrefixRange } from './keys.js';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
/**
 * LevelDB-backed `IKVStore` adapter for React Native peers.
 *
 * Shares one `LevelDBLike` database with `LevelDBRawStorage` and the identity
 * helper. KV keys are tagged with `TAG_KV` (and identity with `TAG_IDENTITY`),
 * so the three subsystems can't collide regardless of the user-chosen
 * `prefix`. `list(prefix)` is a range-bounded scan — never a full-database
 * iteration plus JS-side filter — so listing latency stays bounded.
 */
export class LevelDBKVStore {
    db;
    prefix;
    constructor(db, prefix = 'optimystic:txn:') {
        this.db = db;
        this.prefix = prefix;
    }
    async get(key) {
        const bytes = await this.db.get(kvKey(this.prefix + key));
        if (!bytes)
            return undefined;
        return textDecoder.decode(bytes);
    }
    async set(key, value) {
        await this.db.put(kvKey(this.prefix + key), textEncoder.encode(value));
    }
    async delete(key) {
        await this.db.delete(kvKey(this.prefix + key));
    }
    async list(prefix) {
        const range = kvPrefixRange(this.prefix + prefix);
        const entries = await drain(this.db.iterator({ gte: range.gte, lt: range.lt, keys: true }));
        return entries.map(([rawKey]) => kvKeyToString(rawKey).slice(this.prefix.length));
    }
}
//# sourceMappingURL=leveldb-kv-store.js.map