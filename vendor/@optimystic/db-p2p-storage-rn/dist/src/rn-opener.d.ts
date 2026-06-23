import type { LevelDBLike } from './leveldb-like.js';
/**
 * Minimal subset of `rn-leveldb`'s `LevelDB` we depend on. Re-declared
 * locally so this module's *types* don't pull in the plugin's declarations
 * (the plugin is a peer dependency that may not be installed at typecheck
 * time on non-RN consumers).
 *
 * Matches the shape used by `@quereus/plugin-react-native-leveldb` so apps
 * embedding both Optimystic and Quereus can share one native module.
 */
export interface RNLevelDBNative {
    put(key: ArrayBuffer | string, value: ArrayBuffer | string): void;
    getBuf(key: ArrayBuffer | string): ArrayBuffer | null;
    delete(key: ArrayBuffer | string): void;
    close(): void;
    newIterator(): RNLevelDBIteratorNative;
    write(batch: RNLevelDBWriteBatchNative): void;
}
export interface RNLevelDBWriteBatchNative {
    put(key: ArrayBuffer | string, value: ArrayBuffer | string): void;
    delete(key: ArrayBuffer | string): void;
    close(): void;
}
export interface RNLevelDBIteratorNative {
    valid(): boolean;
    seek(target: ArrayBuffer | string): RNLevelDBIteratorNative;
    seekToFirst(): RNLevelDBIteratorNative;
    seekLast(): RNLevelDBIteratorNative;
    next(): void;
    prev(): void;
    keyBuf(): ArrayBuffer;
    valueBuf(): ArrayBuffer;
    close(): void;
}
/** Constructor type for `rn-leveldb`'s `LevelDBWriteBatch`. */
export type RNLevelDBWriteBatchCtor = new () => RNLevelDBWriteBatchNative;
/**
 * Open function shape — typically `(name, createIfMissing, errorIfExists) =>
 * new LevelDB(name, createIfMissing, errorIfExists)`. The caller controls
 * how `rn-leveldb` is imported so this package never directly imports it,
 * which keeps the unit tests runnable under Node.
 */
export type RNLevelDBOpenFn = (name: string, createIfMissing: boolean, errorIfExists: boolean) => RNLevelDBNative;
export declare const DEFAULT_DB_NAME = "optimystic";
export interface OpenOptimysticRNDbOptions {
    /** `rn-leveldb`'s `LevelDB` constructor wrapped as an open function. */
    openFn: RNLevelDBOpenFn;
    /** `rn-leveldb`'s `LevelDBWriteBatch` constructor. */
    WriteBatch: RNLevelDBWriteBatchCtor;
    /** Database name (LevelDB directory). Default `optimystic`. */
    name?: string;
    /** Whether to create the database if it doesn't exist. Default `true`. */
    createIfMissing?: boolean;
    /** Whether to error if the database already exists. Default `false`. */
    errorIfExists?: boolean;
}
/**
 * Opens (creating if needed) the Optimystic LevelDB database used by
 * `LevelDBRawStorage`, `LevelDBKVStore`, and `loadOrCreateRNPeerKey`.
 *
 * The caller passes the `rn-leveldb` constructors in; this keeps the
 * native module out of the package's static import graph. Apps embedding
 * both Optimystic and Quereus can pass the same constructors to both —
 * one native module, one Podfile entry.
 */
export declare function openOptimysticRNDb(options: OpenOptimysticRNDbOptions): LevelDBLike;
/**
 * Wraps an already-open `rn-leveldb` `LevelDB` instance to satisfy the
 * `LevelDBLike` interface. Exported for callers that already hold a handle
 * (rare — usually `openOptimysticRNDb` is the right entry point).
 */
export declare function wrapRNLevelDB(native: RNLevelDBNative, WriteBatch: RNLevelDBWriteBatchCtor): LevelDBLike;
//# sourceMappingURL=rn-opener.d.ts.map