import { drain } from './leveldb-like.js';
import { TAG_PENDING, actionIdFromKey, blockEnvelopeRange, materializedKey, metadataKey, pendingKey, revisionFromKey, revisionKey, transactionKey, } from './keys.js';
import { createLogger } from './logger.js';
const log = createLogger('storage:leveldb');
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
/**
 * LevelDB-backed `IRawStorage` implementation for React Native peers.
 *
 * All data lives in a single LevelDB database; per-store partitioning is by a
 * leading tag byte (see `./keys.ts`). `listRevisions` and
 * `listPendingTransactions` use range iterators with explicit bounds, drained
 * into an array before yielding (same rationale as the IndexedDB / SQLite
 * backends — a native iterator must not stay open across consumer awaits).
 *
 * `promotePendingTransaction` runs as a single `WriteBatch`, making the
 * pending → committed move atomic against crashes.
 */
export class LevelDBRawStorage {
    db;
    constructor(db) {
        this.db = db;
    }
    async getMetadata(blockId) {
        const bytes = await this.db.get(metadataKey(blockId));
        if (!bytes)
            return undefined;
        return JSON.parse(textDecoder.decode(bytes));
    }
    async saveMetadata(blockId, metadata) {
        await this.db.put(metadataKey(blockId), textEncoder.encode(JSON.stringify(metadata)));
    }
    async getRevision(blockId, rev) {
        const bytes = await this.db.get(revisionKey(blockId, rev));
        if (!bytes)
            return undefined;
        return textDecoder.decode(bytes);
    }
    async saveRevision(blockId, rev, actionId) {
        await this.db.put(revisionKey(blockId, rev), textEncoder.encode(actionId));
    }
    async *listRevisions(blockId, startRev, endRev) {
        const ascending = startRev <= endRev;
        const lo = ascending ? startRev : endRev;
        const hi = ascending ? endRev : startRev;
        // `revisionKey(blockId, hi)` is exactly the inclusive upper bound; LevelDB
        // uses exclusive `lt`, so request `lte` via `lt = key(hi)+0x01` would
        // require an extra byte. Easier: use `lt = revisionKey(blockId, hi+1)`.
        const gte = revisionKey(blockId, lo);
        const lt = revisionKey(blockId, hi + 1);
        const entries = await drain(this.db.iterator({ gte, lt, reverse: !ascending }));
        for (const [key, value] of entries) {
            yield {
                rev: revisionFromKey(key),
                actionId: textDecoder.decode(value),
            };
        }
    }
    async getPendingTransaction(blockId, actionId) {
        const bytes = await this.db.get(pendingKey(blockId, actionId));
        if (!bytes)
            return undefined;
        return JSON.parse(textDecoder.decode(bytes));
    }
    async savePendingTransaction(blockId, actionId, transform) {
        await this.db.put(pendingKey(blockId, actionId), textEncoder.encode(JSON.stringify(transform)));
    }
    async deletePendingTransaction(blockId, actionId) {
        await this.db.delete(pendingKey(blockId, actionId));
    }
    async *listPendingTransactions(blockId) {
        const range = blockEnvelopeRange(TAG_PENDING, blockId);
        const entries = await drain(this.db.iterator({ gte: range.gte, lt: range.lt, keys: true }));
        for (const [key] of entries) {
            yield actionIdFromKey(key, blockId);
        }
    }
    async getTransaction(blockId, actionId) {
        const bytes = await this.db.get(transactionKey(blockId, actionId));
        if (!bytes)
            return undefined;
        return JSON.parse(textDecoder.decode(bytes));
    }
    async saveTransaction(blockId, actionId, transform) {
        await this.db.put(transactionKey(blockId, actionId), textEncoder.encode(JSON.stringify(transform)));
    }
    async getMaterializedBlock(blockId, actionId) {
        const bytes = await this.db.get(materializedKey(blockId, actionId));
        if (!bytes)
            return undefined;
        return JSON.parse(textDecoder.decode(bytes));
    }
    async saveMaterializedBlock(blockId, actionId, block) {
        const key = materializedKey(blockId, actionId);
        if (block) {
            await this.db.put(key, textEncoder.encode(JSON.stringify(block)));
        }
        else {
            await this.db.delete(key);
        }
    }
    async getApproximateBytesUsed() {
        try {
            let total = 0;
            const iter = this.db.iterator();
            try {
                while (true) {
                    const entry = await iter.next();
                    if (!entry)
                        break;
                    total += entry[0].byteLength + entry[1].byteLength;
                }
            }
            finally {
                await iter.close();
            }
            return total;
        }
        catch (err) {
            log('getApproximateBytesUsed iterator failed: %o', err);
            return 0;
        }
    }
    async promotePendingTransaction(blockId, actionId) {
        const pKey = pendingKey(blockId, actionId);
        const value = await this.db.get(pKey);
        if (!value) {
            throw new Error(`Pending action ${actionId} not found for block ${blockId}`);
        }
        const tKey = transactionKey(blockId, actionId);
        await this.db
            .batch()
            .put(tKey, value)
            .delete(pKey)
            .write();
    }
}
//# sourceMappingURL=leveldb-storage.js.map