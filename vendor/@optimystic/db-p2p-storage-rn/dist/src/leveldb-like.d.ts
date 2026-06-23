/**
 * Package-private LevelDB driver surface.
 *
 * The storage classes (`LevelDBRawStorage`, `LevelDBKVStore`) and the identity
 * helper (`loadOrCreateRNPeerKey`) only depend on the interfaces declared here
 * — never on `rn-leveldb` directly. That lets the suite run under Node mocha
 * against `classic-level`, matching the pattern `db-p2p-storage-ns` uses with
 * `node:sqlite` and `db-p2p-storage-web` uses with `fake-indexeddb`.
 *
 * Only `openOptimysticRNDb`, the user-facing constructors, and the identity
 * helper are exported from `index.ts`; the interfaces in this file are
 * internal — consumers never see them.
 */
/** Range options for a `LevelDBLike.iterator` scan. */
export interface LevelDBIteratorOptions {
    /** Inclusive lower bound. */
    gte?: Uint8Array;
    /** Exclusive lower bound. */
    gt?: Uint8Array;
    /** Inclusive upper bound. */
    lte?: Uint8Array;
    /** Exclusive upper bound. */
    lt?: Uint8Array;
    /** Reverse iteration order. */
    reverse?: boolean;
    /** Maximum number of entries to yield. */
    limit?: number;
    /** Skip values (return zero-length Uint8Array for value). Used by `getApproximateBytesUsed`. */
    keys?: boolean;
}
/** Cursor over a `LevelDBLike` range scan. Caller must `close()` exactly once. */
export interface LevelDBIteratorLike {
    /** Return the next entry, or `undefined` when the range is exhausted. */
    next(): Promise<[Uint8Array, Uint8Array] | undefined>;
    /** Release any native resources held by the iterator. */
    close(): Promise<void>;
}
/** Atomic batch of `put` / `delete` operations against a single database. */
export interface LevelDBWriteBatchLike {
    put(key: Uint8Array, value: Uint8Array): this;
    delete(key: Uint8Array): this;
    /** Commit the batch atomically. */
    write(): Promise<void>;
}
/**
 * Minimal LevelDB driver surface used by this package.
 *
 * Wraps either `rn-leveldb` (in production) or `classic-level` (in tests).
 * The interface is `Promise`-returning on every method so the rn-leveldb
 * adapter — which forwards to a synchronous native module — can stay
 * uniform with `classic-level`'s native async API.
 */
export interface LevelDBLike {
    get(key: Uint8Array): Promise<Uint8Array | undefined>;
    put(key: Uint8Array, value: Uint8Array): Promise<void>;
    delete(key: Uint8Array): Promise<void>;
    batch(): LevelDBWriteBatchLike;
    iterator(options?: LevelDBIteratorOptions): LevelDBIteratorLike;
    /** Release the underlying database handle. */
    close(): Promise<void>;
}
/**
 * Drain an iterator into an array. Used by storage classes so a native
 * iterator never stays open across consumer awaits — same rationale as the
 * IndexedDB and SQLite backends.
 */
export declare function drain(iter: LevelDBIteratorLike): Promise<Array<[Uint8Array, Uint8Array]>>;
//# sourceMappingURL=leveldb-like.d.ts.map