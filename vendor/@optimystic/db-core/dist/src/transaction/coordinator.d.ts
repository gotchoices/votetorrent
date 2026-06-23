import type { ITransactor, CollectionId, Transforms } from "../index.js";
import type { Transaction, ExecutionResult, ITransactionEngine, CollectionActions, ReadDependency } from "./transaction.js";
import type { Collection } from "../collection/collection.js";
import { TransactionContext } from "./context.js";
/**
 * Coordinates multi-collection transactions.
 *
 * This is the ONLY interface for all mutations (single or multi-collection).
 *
 * Responsibilities:
 * - Manage collections (create as needed)
 * - Apply actions to collections (run handlers, write to logs)
 * - Commit transactions by running consensus phases (GATHER, PEND, COMMIT)
 */
export declare class TransactionCoordinator {
    private readonly transactor;
    private readonly collections;
    /** Per-stampId tracking: snapshot before first apply + accumulated actions for replay */
    private stampData;
    private nextStampOrder;
    constructor(transactor: ITransactor, collections: Map<CollectionId, Collection<any>>);
    /**
     * Apply actions to collections (called by engines during statement execution).
     *
     * This is the core method that engines call to apply actions to collections.
     * Actions are tagged with the stamp ID and executed immediately through collections
     * to update the local snapshot.
     *
     * @param actions - The actions to apply (per collection)
     * @param stampId - The transaction stamp ID to tag actions with
     */
    applyActions(actions: CollectionActions[], stampId: string): Promise<void>;
    /**
     * Apply actions without tracking (used internally and for replay during rollback).
     */
    private applyActionsRaw;
    /**
     * Commit a transaction (actions already applied, orchestrate PEND/COMMIT).
     *
     * This is called by TransactionSession.commit() after all statements have been executed.
     * Actions have already been applied to collections via applyActions(), so this method
     * just orchestrates the distributed consensus.
     *
     * @param transaction - The transaction to commit
     */
    commit(transaction: Transaction): Promise<void>;
    /**
     * Rollback a transaction (undo only the given stampId's applied actions).
     *
     * Restores tracker state to the snapshot taken before the stampId's first
     * applyActions call, then replays any later stamps' actions to preserve
     * other sessions' transforms.
     *
     * @param stampId - The transaction stamp ID to rollback
     */
    rollback(stampId: string): Promise<void>;
    /**
     * Get current transforms from all collections.
     *
     * This collects transforms from each collection's tracker. Useful for
     * validation scenarios where transforms need to be extracted after
     * engine execution.
     */
    getTransforms(): Map<CollectionId, Transforms>;
    /**
     * Reset all collection trackers.
     *
     * This clears pending transforms from all collections. Useful for
     * cleaning up after validation or when starting a new transaction.
     */
    resetTransforms(): void;
    /**
     * Collect read dependencies from all participating collections.
     */
    getReadDependencies(): ReadDependency[];
    /**
     * Clear read dependencies from all collections.
     */
    clearReadDependencies(): void;
    /**
     * Compute hash of all operations in a transaction.
     * This hash is used for validation - validators re-execute the transaction
     * and compare their computed operations hash with this one.
     */
    private hashOperations;
    /**
     * Commit a transaction context.
     *
     * @deprecated Use TransactionSession instead of TransactionContext
     * This is called by TransactionContext.commit().
     *
     * @param context - The transaction context to commit
     * @returns Execution result with actions and results
     */
    commitTransaction(context: TransactionContext): Promise<ExecutionResult>;
    /**
     * Execute a fully-formed transaction.
     *
     * This can be called directly with a complete transaction (e.g., from Quereus),
     * or indirectly via commitTransaction().
     *
     * @param transaction - The transaction to execute
     * @param engine - The engine to use for executing the transaction
     * @returns Execution result with actions and results
     */
    execute(transaction: Transaction, engine: ITransactionEngine): Promise<ExecutionResult>;
    /**
     * Apply actions to a collection.
     *
     * This runs the action handlers, writes to the log, and collects transforms.
     */
    private applyActionsToCollection;
    /**
     * Coordinate a transaction across multiple collections.
     *
     * @param transaction - The transaction to coordinate
     * @param operationsHash - Hash of all operations for validation
     * @param collectionTransforms - Map of collectionId to its transforms
     * @param criticalBlocks - Map of collectionId to its log tail blockId
     */
    private coordinateTransaction;
    /**
     * GATHER phase: Collect nominees from critical clusters.
     *
     * Skip if only one collection affected (single-collection consensus).
     *
     * @param criticalBlockIds - Block IDs of all log tails
     * @returns Set of peer IDs to use for consensus, or null for single-collection
     */
    private gatherPhase;
    /**
     * PEND phase: Distribute transaction to all affected block clusters.
     *
     * @param transaction - The full transaction for replay/validation
     * @param operationsHash - Hash of all operations for validation
     * @param collectionTransforms - Map of collectionId to its transforms
     * @param superclusterNominees - Nominees for multi-collection consensus (null for single-collection)
     */
    private pendPhase;
    /**
     * COMMIT phase: Commit to all critical blocks with retry for transient failures.
     *
     * Once all collections are pended (Phase 1 passes), the coordinator has decided
     * to commit. Failed commits are retried (forward recovery) before giving up.
     * Returns which collections committed vs failed so the caller can do targeted cancel.
     */
    private commitPhase;
    /**
     * CANCEL phase: Cancel pending actions on affected blocks.
     *
     * Uses the authoritative pended block IDs from pendPhase rather than
     * recomputing from transforms. Optionally skips already-committed collections.
     */
    private cancelPhase;
}
//# sourceMappingURL=coordinator.d.ts.map