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
/**
 * Drain an iterator into an array. Used by storage classes so a native
 * iterator never stays open across consumer awaits — same rationale as the
 * IndexedDB and SQLite backends.
 */
export async function drain(iter) {
    const out = [];
    try {
        while (true) {
            const entry = await iter.next();
            if (!entry)
                break;
            out.push(entry);
        }
    }
    finally {
        await iter.close();
    }
    return out;
}
//# sourceMappingURL=leveldb-like.js.map