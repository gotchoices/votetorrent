import type { ITransactionEngine, Transaction, ExecutionResult } from './transaction.js';
import type { TransactionCoordinator } from './coordinator.js';
export declare const ACTIONS_ENGINE_ID = "actions@1.0.0";
/**
 * Built-in action-based transaction engine for testing.
 *
 * This engine treats each statement as a JSON-encoded CollectionActions object.
 * It's useful for testing the transaction infrastructure without needing SQL.
 *
 * Each statement format:
 * ```json
 * {
 *   "collectionId": "users",
 *   "actions": [
 *     { "type": "insert", "data": { "id": 1, "name": "Alice" } }
 *   ]
 * }
 * ```
 */
export declare class ActionsEngine implements ITransactionEngine {
    private coordinator;
    constructor(coordinator: TransactionCoordinator);
    execute(transaction: Transaction): Promise<ExecutionResult>;
}
//# sourceMappingURL=actions-engine.d.ts.map