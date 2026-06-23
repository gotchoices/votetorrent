import type { BlockId, IBlock, Transform, ActionId, ActionRev } from "@optimystic/db-core";
import type { BlockMetadata } from "./struct.js";
import type { IRawStorage } from "./i-raw-storage.js";
export declare class MemoryRawStorage implements IRawStorage {
    private metadata;
    private revisions;
    private pendingActions;
    private actions;
    private materializedBlocks;
    private getRevisionKey;
    private getActionKey;
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
    getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined>;
    /**
     * Stores metadata for a block.
     *
     * @pitfall **MUST store a clone** - callers may continue mutating the metadata object
     * after saving; storing the reference lets those mutations corrupt persisted state.
     * @see docs/internals.md "Storage Returns References" pitfall
     */
    saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void>;
    getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined>;
    saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void>;
    listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev>;
    getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined>;
    savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void>;
    deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void>;
    listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId>;
    getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined>;
    saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void>;
    /**
     * Retrieves a materialized block at a specific revision.
     *
     * @pitfall **MUST return a clone** - `applyTransform()` mutates blocks in place.
     * If we return the stored reference, mutations corrupt ALL revisions that share
     * the same underlying object.
     * @see docs/internals.md "Storage Returns References" pitfall
     */
    getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined>;
    /**
     * Stores a materialized block at a specific revision.
     *
     * @pitfall **MUST store a clone** - callers may continue mutating the block after saving.
     * If we store the reference, those mutations corrupt the stored data.
     * @see docs/internals.md "Storage Returns References" pitfall
     */
    saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void>;
    promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void>;
    getApproximateBytesUsed(): Promise<number>;
}
//# sourceMappingURL=memory-storage.d.ts.map