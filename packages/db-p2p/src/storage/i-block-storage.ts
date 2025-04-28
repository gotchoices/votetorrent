import type { IBlock, Transform, TrxId, TrxRev } from "@votetorrent/db-core";

/** Interface for block-level storage operations */
export interface IBlockStorage {
    /** Gets the latest revision information for this block */
    getLatest(): Promise<TrxRev | undefined>;

    /** Gets a materialized block at the given revision */
    getBlock(rev?: number): Promise<{ block: IBlock, trxRev: TrxRev }>;

    /** Gets a transaction by ID */
    getTransaction(trxId: TrxId): Promise<Transform | undefined>;

    /** Gets a pending transaction by ID */
    getPendingTransaction(trxId: TrxId): Promise<Transform | undefined>;

    /** Lists all pending transaction IDs */
    listPendingTransactions(): AsyncIterable<TrxId>;

    /** Saves a pending transaction */
    savePendingTransaction(trxId: TrxId, transform: Transform): Promise<void>;

    /** Deletes a pending transaction */
    deletePendingTransaction(trxId: TrxId): Promise<void>;

    /** Lists revisions in ascending or descending order between startRev and endRev (inclusive) */
    listRevisions(startRev: number, endRev: number): AsyncIterable<TrxRev>;

    /** Saves a materialized block */
    saveMaterializedBlock(trxId: TrxId, block: IBlock | undefined): Promise<void>;

    /** Saves a revision */
    saveRevision(rev: number, trxId: TrxId): Promise<void>;

    /** Promotes a pending transaction to committed */
    promotePendingTransaction(trxId: TrxId): Promise<void>;

    /** Sets the latest revision information */
    setLatest(latest: TrxRev): Promise<void>;
}
