/**
 * Key encoding for the LevelDB-backed storage. All keys live in a single
 * database and are sorted lexicographically by byte order. A leading tag
 * byte partitions the keyspace per logical store; a 4-byte big-endian
 * length prefix on the `blockId` ensures prefix scans cannot be confused
 * by the variable-length `actionId` suffix of the previous store.
 *
 * Layout:
 *   `tag (1)` || `len(blockId) (4 BE)` || `blockId UTF-8` || `suffix`
 *
 * Per-store suffix encoding:
 *   - metadata:     (empty)
 *   - revisions:    rev (8-byte big-endian unsigned via DataView.setBigUint64)
 *   - pending:      actionId UTF-8 (terminal)
 *   - transactions: actionId UTF-8 (terminal)
 *   - materialized: actionId UTF-8 (terminal)
 *
 * `kv` and `identity` keys are flat — no `blockId` envelope — under their
 * own tag bytes (`TAG_KV`, `TAG_IDENTITY`) and use UTF-8 of the full key.
 *
 * The tag bytes are deliberately spaced (`0x01`, `0x02`, …, `0x10`, `0x20`)
 * so a future logical store can slot in between without colliding with
 * existing prefix scans.
 */
export declare const TAG_METADATA = 1;
export declare const TAG_REVISIONS = 2;
export declare const TAG_PENDING = 3;
export declare const TAG_TRANSACTIONS = 4;
export declare const TAG_MATERIALIZED = 5;
export declare const TAG_KV = 16;
export declare const TAG_IDENTITY = 32;
export declare function metadataKey(blockId: string): Uint8Array;
export declare function revisionKey(blockId: string, rev: number): Uint8Array;
/** Decode the trailing 8-byte big-endian rev from a `revisionKey`-encoded key. */
export declare function revisionFromKey(key: Uint8Array): number;
export declare function pendingKey(blockId: string, actionId: string): Uint8Array;
export declare function transactionKey(blockId: string, actionId: string): Uint8Array;
export declare function materializedKey(blockId: string, actionId: string): Uint8Array;
/** Returns the inclusive lower / exclusive upper range covering every key for `(tag, blockId, *)`. */
export declare function blockEnvelopeRange(tag: number, blockId: string): {
    gte: Uint8Array;
    lt: Uint8Array;
};
/** Decode the `actionId` suffix from a `pendingKey` / `transactionKey` / `materializedKey`. */
export declare function actionIdFromKey(key: Uint8Array, blockId: string): string;
export declare function kvKey(key: string): Uint8Array;
/** Returns the inclusive lower / exclusive upper range covering every kv key starting with `prefix`. */
export declare function kvPrefixRange(prefix: string): {
    gte: Uint8Array;
    lt: Uint8Array;
};
/** Strip the leading `TAG_KV` byte from a key, returning the UTF-8 string portion. */
export declare function kvKeyToString(raw: Uint8Array): string;
export declare function identityKey(keyName: string): Uint8Array;
//# sourceMappingURL=keys.d.ts.map