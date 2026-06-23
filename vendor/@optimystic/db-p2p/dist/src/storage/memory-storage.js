export class MemoryRawStorage {
    metadata = new Map();
    revisions = new Map(); // blockId:rev -> actionId
    pendingActions = new Map(); // blockId:actionId -> transform
    actions = new Map(); // blockId:actionId -> transform
    materializedBlocks = new Map(); // blockId:actionId -> block
    getRevisionKey(blockId, rev) {
        return `${blockId}:${rev}`;
    }
    getActionKey(blockId, actionId) {
        return `${blockId}:${actionId}`;
    }
    /**
     * Retrieves metadata for a block.
     *
     * @pitfall **MUST return a clone** - `BlockStorage.setLatest` mutates the returned
     * metadata in place (`meta.latest = latest`) before calling `saveMetadata`. Returning
     * the stored reference leaks that mutation into RAM even when a subsequent
     * `saveMetadata` call fails, masking mid-commit crashes that a persistent store
     * (file/sqlite/leveldb) would surface correctly.
     * @see docs/internals.md "Storage Returns References" pitfall
     */
    async getMetadata(blockId) {
        const meta = this.metadata.get(blockId);
        return meta ? structuredClone(meta) : undefined;
    }
    /**
     * Stores metadata for a block.
     *
     * @pitfall **MUST store a clone** - callers may continue mutating the metadata object
     * after saving; storing the reference lets those mutations corrupt persisted state.
     * @see docs/internals.md "Storage Returns References" pitfall
     */
    async saveMetadata(blockId, metadata) {
        this.metadata.set(blockId, structuredClone(metadata));
    }
    async getRevision(blockId, rev) {
        return this.revisions.get(this.getRevisionKey(blockId, rev));
    }
    async saveRevision(blockId, rev, actionId) {
        this.revisions.set(this.getRevisionKey(blockId, rev), actionId);
    }
    async *listRevisions(blockId, startRev, endRev) {
        const ascending = startRev <= endRev;
        const actualStart = ascending ? startRev : endRev;
        const actualEnd = ascending ? endRev : startRev;
        const results = [];
        for (let rev = actualStart; rev <= actualEnd; rev++) {
            const actionId = this.revisions.get(this.getRevisionKey(blockId, rev));
            if (actionId) {
                results.push({ rev, actionId });
            }
        }
        if (!ascending) {
            results.reverse();
        }
        for (const result of results) {
            yield result;
        }
    }
    async getPendingTransaction(blockId, actionId) {
        return this.pendingActions.get(this.getActionKey(blockId, actionId));
    }
    async savePendingTransaction(blockId, actionId, transform) {
        // Clone transform to prevent external modifications from affecting stored data
        this.pendingActions.set(this.getActionKey(blockId, actionId), structuredClone(transform));
    }
    async deletePendingTransaction(blockId, actionId) {
        this.pendingActions.delete(this.getActionKey(blockId, actionId));
    }
    async *listPendingTransactions(blockId) {
        const prefix = `${blockId}:`;
        for (const [key] of Array.from(this.pendingActions.entries())) {
            if (key.startsWith(prefix)) {
                yield key.substring(prefix.length);
            }
        }
    }
    async getTransaction(blockId, actionId) {
        return this.actions.get(this.getActionKey(blockId, actionId));
    }
    async saveTransaction(blockId, actionId, transform) {
        this.actions.set(this.getActionKey(blockId, actionId), transform);
    }
    /**
     * Retrieves a materialized block at a specific revision.
     *
     * @pitfall **MUST return a clone** - `applyTransform()` mutates blocks in place.
     * If we return the stored reference, mutations corrupt ALL revisions that share
     * the same underlying object.
     * @see docs/internals.md "Storage Returns References" pitfall
     */
    async getMaterializedBlock(blockId, actionId) {
        const block = this.materializedBlocks.get(this.getActionKey(blockId, actionId));
        // Clone to prevent external mutations from affecting stored data
        return block ? structuredClone(block) : undefined;
    }
    /**
     * Stores a materialized block at a specific revision.
     *
     * @pitfall **MUST store a clone** - callers may continue mutating the block after saving.
     * If we store the reference, those mutations corrupt the stored data.
     * @see docs/internals.md "Storage Returns References" pitfall
     */
    async saveMaterializedBlock(blockId, actionId, block) {
        const key = this.getActionKey(blockId, actionId);
        if (block) {
            // Clone to prevent external mutations from affecting stored data
            this.materializedBlocks.set(key, structuredClone(block));
        }
        else {
            this.materializedBlocks.delete(key);
        }
    }
    async promotePendingTransaction(blockId, actionId) {
        const key = this.getActionKey(blockId, actionId);
        const transform = this.pendingActions.get(key);
        if (transform) {
            this.actions.set(key, transform);
            this.pendingActions.delete(key);
        }
    }
    async getApproximateBytesUsed() {
        let total = 0;
        for (const [blockId, meta] of this.metadata) {
            total += blockId.length + jsonByteSize(meta);
        }
        for (const [key, actionId] of this.revisions) {
            total += key.length + actionId.length;
        }
        for (const [key, transform] of this.pendingActions) {
            total += key.length + jsonByteSize(transform);
        }
        for (const [key, transform] of this.actions) {
            total += key.length + jsonByteSize(transform);
        }
        for (const [key, block] of this.materializedBlocks) {
            total += key.length + jsonByteSize(block);
        }
        return total;
    }
}
function jsonByteSize(value) {
    try {
        return JSON.stringify(value)?.length ?? 0;
    }
    catch {
        return 0;
    }
}
//# sourceMappingURL=memory-storage.js.map