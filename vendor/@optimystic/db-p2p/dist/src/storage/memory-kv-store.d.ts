import type { IKVStore } from "./i-kv-store.js";
/** In-memory IKVStore backed by a Map. Used for testing. */
export declare class MemoryKVStore implements IKVStore {
    private readonly store;
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix: string): Promise<string[]>;
}
//# sourceMappingURL=memory-kv-store.d.ts.map