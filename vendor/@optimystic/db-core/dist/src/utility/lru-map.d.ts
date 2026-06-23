/**
 * A simple LRU (Least Recently Used) map backed by JavaScript's Map insertion order.
 * Accessing or setting an entry refreshes it to the most-recently-used position.
 * When the map exceeds maxSize, the least-recently-used entry is evicted.
 */
export declare class LruMap<K, V> {
    private readonly maxSize;
    private readonly map;
    constructor(maxSize: number);
    get(key: K): V | undefined;
    set(key: K, value: V): this;
    has(key: K): boolean;
    delete(key: K): boolean;
    clear(): void;
    get size(): number;
    [Symbol.iterator](): IterableIterator<[K, V]>;
}
//# sourceMappingURL=lru-map.d.ts.map