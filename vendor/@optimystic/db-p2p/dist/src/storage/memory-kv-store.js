/** In-memory IKVStore backed by a Map. Used for testing. */
export class MemoryKVStore {
    store = new Map();
    async get(key) {
        return this.store.get(key);
    }
    async set(key, value) {
        this.store.set(key, value);
    }
    async delete(key) {
        this.store.delete(key);
    }
    async list(prefix) {
        const result = [];
        for (const key of this.store.keys()) {
            if (key.startsWith(prefix)) {
                result.push(key);
            }
        }
        return result;
    }
}
//# sourceMappingURL=memory-kv-store.js.map