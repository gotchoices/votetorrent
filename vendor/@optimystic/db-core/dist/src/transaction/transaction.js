import { hashString } from "../utility/hash-string.js";
/** Default transaction time-to-live in milliseconds (30 seconds). */
export const DEFAULT_TRANSACTION_TTL_MS = 30_000;
/** Check whether a transaction stamp has expired. */
export function isTransactionExpired(stamp) {
    return Date.now() > stamp.expiration;
}
/**
 * Create a transaction stamp with computed id.
 * The id is a hash of the stamp fields (including expiration).
 */
export async function createTransactionStamp(peerId, timestamp, schemaHash, engineId, ttlMs = DEFAULT_TRANSACTION_TTL_MS) {
    const expiration = timestamp + ttlMs;
    const stampData = JSON.stringify({ peerId, timestamp, schemaHash, engineId, expiration });
    const id = `stamp:${await hashString(stampData)}`;
    return { peerId, timestamp, schemaHash, engineId, expiration, id };
}
/**
 * Create a transaction id from stamp id, statements, and reads.
 * This is the final transaction identity used in logs.
 */
export async function createTransactionId(stampId, statements, reads) {
    const txData = JSON.stringify({ stampId, statements, reads });
    return `tx:${await hashString(txData)}`;
}
/**
 * Helper to create an actions-based transaction statements array.
 * Each CollectionActions becomes a separate JSON-encoded statement.
 */
export function createActionsStatements(collections) {
    return collections.map(c => JSON.stringify(c));
}
//# sourceMappingURL=transaction.js.map