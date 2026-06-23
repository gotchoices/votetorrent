import type { TransactionCoordinator } from "./coordinator.js";
import type { ExecutionResult, ITransactionEngine, TransactionStamp, CollectionActions } from "./transaction.js";
/**
 * TransactionSession manages incremental transaction building.
 *
 * This is the high-level API for building transactions incrementally:
 * - Stamp is created at BEGIN (stable throughout transaction)
 * - Execute statements one at a time
 * - Engine translates statements to actions (if not already provided)
 * - Actions are immediately applied to collections via coordinator.applyActions()
 * - On commit, all statements are compiled into a complete Transaction
 * - The Transaction is then committed through coordinator.commit() for PEND/COMMIT orchestration
 *
 * Usage:
 *   const session = await TransactionSession.create(coordinator, engine);
 *   await session.execute('INSERT INTO users (id, name) VALUES (?, ?)', [1, 'Alice']);
 *   await session.execute('SELECT * FROM orders WHERE user_id = ?', [1]);
 *   const result = await session.commit();
 *
 * For validation/replay, use engine.execute() directly with a complete Transaction.
 */
export declare class TransactionSession {
    private readonly coordinator;
    private readonly engine;
    private readonly statements;
    private readonly stamp;
    private committed;
    private rolledBack;
    private constructor();
    /**
     * Create a new TransactionSession.
     * Uses async factory because stamp creation requires SHA-256 hashing.
     */
    static create(coordinator: TransactionCoordinator, engine: ITransactionEngine, peerId?: string, schemaHash?: string, ttlMs?: number): Promise<TransactionSession>;
    /**
     * Execute a statement.
     *
     * If actions are provided, they are applied directly.
     * Otherwise, the engine translates the statement to actions.
     *
     * @param statement - The statement to execute (engine-specific, e.g., SQL statement)
     * @param actions - Optional pre-computed actions (for Quereus module case)
     * @returns Execution result with any returned values
     */
    execute(statement: string, actions?: CollectionActions[]): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * Commit the transaction.
     *
     * Compiles all statements into a complete Transaction and commits through coordinator.
     */
    commit(): Promise<ExecutionResult>;
    /**
     * Rollback the transaction (undo this session's applied actions).
     *
     * Delegates to coordinator.rollback(stampId) which restores collection
     * trackers to the pre-session snapshot and replays any later sessions'
     * actions to preserve their transforms.
     */
    rollback(): Promise<void>;
    /**
     * Get the transaction stamp ID (stable throughout transaction).
     */
    getStampId(): string;
    /**
     * Get the transaction stamp (full metadata).
     */
    getStamp(): TransactionStamp;
    /**
     * Get the list of accumulated statements.
     */
    getStatements(): readonly string[];
    /**
     * Check if the transaction has been committed.
     */
    isCommitted(): boolean;
    /**
     * Check if the transaction has been rolled back.
     */
    isRolledBack(): boolean;
}
//# sourceMappingURL=session.d.ts.map