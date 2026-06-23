import type { CollectionId } from "../index.js";
import type { TransactionCoordinator } from "./coordinator.js";
import type { ReadDependency, ExecutionResult } from "./transaction.js";
import type { Action } from "../collection/action.js";
/**
 * Transaction context for accumulating actions and reads.
 *
 * Usage:
 *   const txn = coordinator.begin();
 *   txn.addAction('users', { type: 'insert', data: {...} });
 *   txn.addAction('users', { type: 'get', data: { key: 1 } });
 *   const result = await txn.commit();
 */
export declare class TransactionContext {
    private readonly coordinator;
    readonly transactionId: string;
    readonly engine: string;
    private readonly collectionActions;
    private readonly reads;
    constructor(coordinator: TransactionCoordinator, transactionId: string, engine: string);
    /**
     * Add an action to a collection.
     *
     * Actions are collection-specific:
     * - Tree: 'insert', 'delete', 'get', 'scan'
     * - Diary: 'append', 'read'
     * - etc.
     */
    addAction(collectionId: CollectionId, action: Action<any>): Promise<void>;
    /**
     * Add a read dependency for optimistic concurrency control.
     */
    addRead(read: ReadDependency): void;
    /**
     * Commit the transaction.
     *
     * This executes all accumulated actions across all affected collections,
     * coordinating with the network as needed.
     */
    commit(): Promise<ExecutionResult>;
    /**
     * Rollback the transaction (just discard accumulated state).
     */
    rollback(): void;
    /**
     * Get all accumulated actions by collection.
     * Used by coordinator during commit.
     */
    getCollectionActions(): Map<CollectionId, Action<any>[]>;
    /**
     * Get all accumulated read dependencies.
     * Used by coordinator during commit.
     */
    getReads(): ReadDependency[];
    /**
     * Get the set of affected collection IDs.
     */
    getAffectedCollections(): Set<CollectionId>;
}
//# sourceMappingURL=context.d.ts.map