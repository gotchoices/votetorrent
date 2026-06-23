import type { IBlock, Transform, ActionId, ActionRev } from "@optimystic/db-core";
/** Interface for block-level storage operations */
export interface IBlockStorage {
    /** Gets the latest revision information for this block */
    getLatest(): Promise<ActionRev | undefined>;
    /**
     * Gets a materialized block at the given revision.
     * Returns undefined when the block has no materialized content yet — either
     * no metadata exists, or metadata exists (seeded by a pending transaction)
     * but no revision has been committed. Throws only when a specific `rev` was
     * requested but cannot be located.
     */
    getBlock(rev?: number): Promise<{
        block: IBlock;
        actionRev: ActionRev;
    } | undefined>;
    /** Gets an action by ID */
    getTransaction(actionId: ActionId): Promise<Transform | undefined>;
    /** Gets a pending action by ID */
    getPendingTransaction(actionId: ActionId): Promise<Transform | undefined>;
    /** Lists all pending action IDs */
    listPendingTransactions(): AsyncIterable<ActionId>;
    /** Saves a pending action */
    savePendingTransaction(actionId: ActionId, transform: Transform): Promise<void>;
    /** Deletes a pending action */
    deletePendingTransaction(actionId: ActionId): Promise<void>;
    /** Lists revisions in ascending or descending order between startRev and endRev (inclusive) */
    listRevisions(startRev: number, endRev: number): AsyncIterable<ActionRev>;
    /** Saves a materialized block */
    saveMaterializedBlock(actionId: ActionId, block: IBlock | undefined): Promise<void>;
    /** Saves a revision */
    saveRevision(rev: number, actionId: ActionId): Promise<void>;
    /** Promotes a pending action to committed */
    promotePendingTransaction(actionId: ActionId): Promise<void>;
    /** Sets the latest revision information */
    setLatest(latest: ActionRev): Promise<void>;
    /**
     * Reconciles `metadata.latest` with the highest contiguous fully-promoted revision in
     * the revisions table. Intended for post-crash recovery of the Crash-D3 gap, where
     * `promotePendingTransaction` succeeded but `setLatest` did not: the revision and
     * committed-log entry are durable, but `meta.latest` still points at the prior rev
     * (or is undefined), and retry-commit is rejected because the pending record is gone.
     *
     * Stops at the first rev whose action is not yet in the committed log, preserving the
     * Crash-D2 invariant that retry-commit — not recovery — owns advancement past a half-
     * promoted state.
     *
     * Idempotent and monotonic (latest only advances forward).
     */
    recover(): Promise<{
        reconciled: boolean;
        latest?: ActionRev;
    }>;
}
//# sourceMappingURL=i-block-storage.d.ts.map