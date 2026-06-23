import type { BlockId, ActionId, ActionRev, Transform, IBlock } from "@optimystic/db-core";
import type { BlockMetadata } from "./struct.js";
export interface IRawStorage {
    getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined>;
    saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void>;
    getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined>;
    saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void>;
    /** List revisions in ascending or descending order, depending on startRev and endRev - startRev and endRev are inclusive */
    listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev>;
    getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined>;
    savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void>;
    deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void>;
    listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId>;
    getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined>;
    saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void>;
    getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined>;
    saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void>;
    promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void>;
    /**
     * Approximate bytes currently stored by this backend.
     *
     * Used by `StorageMonitor` to feed real used-space figures into ring selection.
     * Implementations should return their best cheap estimate (e.g. on-disk size for
     * filesystem backends, tracked footprint for in-memory backends). The result is
     * advisory — `StorageMonitor` treats a missing implementation as 0.
     */
    getApproximateBytesUsed?(): Promise<number>;
}
//# sourceMappingURL=i-raw-storage.d.ts.map