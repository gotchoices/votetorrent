/** Portable async key-value store. Platform packages provide implementations. */
export interface IKVStore {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    /** Return all keys matching the given prefix */
    list(prefix: string): Promise<string[]>;
}
//# sourceMappingURL=i-kv-store.d.ts.map