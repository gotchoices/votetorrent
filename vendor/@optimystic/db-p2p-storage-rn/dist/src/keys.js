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
export const TAG_METADATA = 0x01;
export const TAG_REVISIONS = 0x02;
export const TAG_PENDING = 0x03;
export const TAG_TRANSACTIONS = 0x04;
export const TAG_MATERIALIZED = 0x05;
export const TAG_KV = 0x10;
export const TAG_IDENTITY = 0x20;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
function encodeBlockEnvelope(tag, blockId) {
    const blockIdBytes = textEncoder.encode(blockId);
    const out = new Uint8Array(1 + 4 + blockIdBytes.length);
    out[0] = tag;
    new DataView(out.buffer, out.byteOffset).setUint32(1, blockIdBytes.length, false);
    out.set(blockIdBytes, 5);
    return out;
}
function concat(...parts) {
    let total = 0;
    for (const p of parts)
        total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}
export function metadataKey(blockId) {
    return encodeBlockEnvelope(TAG_METADATA, blockId);
}
export function revisionKey(blockId, rev) {
    const envelope = encodeBlockEnvelope(TAG_REVISIONS, blockId);
    const out = new Uint8Array(envelope.length + 8);
    out.set(envelope, 0);
    new DataView(out.buffer, out.byteOffset).setBigUint64(envelope.length, BigInt(rev), false);
    return out;
}
/** Decode the trailing 8-byte big-endian rev from a `revisionKey`-encoded key. */
export function revisionFromKey(key) {
    const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
    return Number(view.getBigUint64(key.byteLength - 8, false));
}
export function pendingKey(blockId, actionId) {
    return concat(encodeBlockEnvelope(TAG_PENDING, blockId), textEncoder.encode(actionId));
}
export function transactionKey(blockId, actionId) {
    return concat(encodeBlockEnvelope(TAG_TRANSACTIONS, blockId), textEncoder.encode(actionId));
}
export function materializedKey(blockId, actionId) {
    return concat(encodeBlockEnvelope(TAG_MATERIALIZED, blockId), textEncoder.encode(actionId));
}
/** Returns the inclusive lower / exclusive upper range covering every key for `(tag, blockId, *)`. */
export function blockEnvelopeRange(tag, blockId) {
    const gte = encodeBlockEnvelope(tag, blockId);
    const lt = new Uint8Array(gte.length);
    lt.set(gte);
    // Increment the last byte to get the exclusive upper bound. The envelope
    // ends in the last byte of the blockId (UTF-8); since the longest possible
    // UTF-8 lead byte is 0xF4 and continuation bytes are <= 0xBF, no envelope
    // byte is ever 0xFF — incrementing the last byte is always well-defined.
    const lastIndex = lt.length - 1;
    const lastByte = lt[lastIndex];
    if (lastByte === undefined)
        throw new Error('empty blockId envelope');
    lt[lastIndex] = lastByte + 1;
    return { gte, lt };
}
/** Decode the `actionId` suffix from a `pendingKey` / `transactionKey` / `materializedKey`. */
export function actionIdFromKey(key, blockId) {
    const blockIdLen = textEncoder.encode(blockId).length;
    const suffixOffset = 1 + 4 + blockIdLen;
    return textDecoder.decode(key.subarray(suffixOffset));
}
export function kvKey(key) {
    return concat(Uint8Array.of(TAG_KV), textEncoder.encode(key));
}
/** Returns the inclusive lower / exclusive upper range covering every kv key starting with `prefix`. */
export function kvPrefixRange(prefix) {
    const prefixBytes = textEncoder.encode(prefix);
    const gte = new Uint8Array(1 + prefixBytes.length);
    gte[0] = TAG_KV;
    gte.set(prefixBytes, 1);
    // Upper bound: any string whose UTF-8 bytes start with `prefixBytes` sorts
    // strictly below `[TAG_KV, ...prefixBytes, 0xFF]`. UTF-8 never produces a
    // 0xFF byte (the maximum valid lead byte is 0xF4 and continuation bytes
    // top out at 0xBF), so appending 0xFF yields an exact exclusive upper bound.
    const lt = new Uint8Array(1 + prefixBytes.length + 1);
    lt[0] = TAG_KV;
    lt.set(prefixBytes, 1);
    lt[lt.length - 1] = 0xff;
    return { gte, lt };
}
/** Strip the leading `TAG_KV` byte from a key, returning the UTF-8 string portion. */
export function kvKeyToString(raw) {
    return textDecoder.decode(raw.subarray(1));
}
export function identityKey(keyName) {
    return concat(Uint8Array.of(TAG_IDENTITY), textEncoder.encode(keyName));
}
//# sourceMappingURL=keys.js.map