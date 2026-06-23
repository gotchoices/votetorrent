/**
 * A simple LRU (Least Recently Used) map backed by JavaScript's Map insertion order.
 * Accessing or setting an entry refreshes it to the most-recently-used position.
 * When the map exceeds maxSize, the least-recently-used entry is evicted.
 */
export class LruMap {
    maxSize;
    map = new Map();
    constructor(maxSize) {
        this.maxSize = maxSize;
        if (maxSize < 1)
            throw new Error('LruMap maxSize must be >= 1');
    }
    get(key) {
        const value = this.map.get(key);
        if (value !== undefined) {
            // Refresh: delete and re-insert to move to end (most recent)
            this.map.delete(key);
            this.map.set(key, value);
        }
        return value;
    }
    set(key, value) {
        // If already present, delete first to refresh position
        if (this.map.has(key)) {
            this.map.delete(key);
        }
        else if (this.map.size >= this.maxSize) {
            // Evict the oldest (first) entry
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
        }
        this.map.set(key, value);
        return this;
    }
    has(key) {
        return this.map.has(key);
    }
    delete(key) {
        return this.map.delete(key);
    }
    clear() {
        this.map.clear();
    }
    get size() {
        return this.map.size;
    }
    [Symbol.iterator]() {
        return this.map[Symbol.iterator]();
    }
}
//# sourceMappingURL=lru-map.js.map