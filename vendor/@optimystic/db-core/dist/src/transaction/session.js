import { createTransactionStamp, createTransactionId, isTransactionExpired } from "./transaction.js";
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
export class TransactionSession {
    coordinator;
    engine;
    statements = [];
    stamp;
    committed = false;
    rolledBack = false;
    constructor(coordinator, engine, stamp) {
        this.coordinator = coordinator;
        this.engine = engine;
        this.stamp = stamp;
    }
    /**
     * Create a new TransactionSession.
     * Uses async factory because stamp creation requires SHA-256 hashing.
     */
    static async create(coordinator, engine, peerId = 'local', schemaHash = '', ttlMs) {
        const stamp = await createTransactionStamp(peerId, Date.now(), schemaHash, 'unknown', // TODO: Get engine ID from engine
        ttlMs);
        return new TransactionSession(coordinator, engine, stamp);
    }
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
    async execute(statement, actions) {
        if (this.committed) {
            return { success: false, error: 'Transaction already committed' };
        }
        if (this.rolledBack) {
            return { success: false, error: 'Transaction already rolled back' };
        }
        try {
            // If actions not provided, enlist engine to translate statement
            let actionsToApply;
            if (actions) {
                actionsToApply = actions;
            }
            else {
                // Create a temporary transaction with just this statement for translation
                const tempTransaction = {
                    stamp: this.stamp,
                    statements: [statement],
                    reads: [],
                    id: 'temp' // Temporary ID for translation only
                };
                const result = await this.engine.execute(tempTransaction);
                if (!result.success || !result.actions) {
                    return { success: false, error: result.error || 'Failed to translate statement' };
                }
                actionsToApply = result.actions;
            }
            // Apply actions through coordinator
            await this.coordinator.applyActions(actionsToApply, this.stamp.id);
            // Accumulate the statement for later compilation
            this.statements.push(statement);
            return { success: true };
        }
        catch (error) {
            return {
                success: false,
                error: `Failed to execute statement: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
    /**
     * Commit the transaction.
     *
     * Compiles all statements into a complete Transaction and commits through coordinator.
     */
    async commit() {
        if (this.committed) {
            return { success: false, error: 'Transaction already committed' };
        }
        if (this.rolledBack) {
            return { success: false, error: 'Transaction already rolled back' };
        }
        if (isTransactionExpired(this.stamp)) {
            return { success: false, error: `Transaction expired at ${this.stamp.expiration}` };
        }
        // Collect read dependencies from all participating collections
        const reads = this.coordinator.getReadDependencies();
        // Create the complete transaction
        const transaction = {
            stamp: this.stamp,
            statements: this.statements,
            reads,
            id: await createTransactionId(this.stamp.id, this.statements, reads)
        };
        // Commit through coordinator (which will orchestrate PEND/COMMIT)
        await this.coordinator.commit(transaction);
        // Clear read dependencies after successful commit
        this.coordinator.clearReadDependencies();
        this.committed = true;
        return { success: true };
    }
    /**
     * Rollback the transaction (undo this session's applied actions).
     *
     * Delegates to coordinator.rollback(stampId) which restores collection
     * trackers to the pre-session snapshot and replays any later sessions'
     * actions to preserve their transforms.
     */
    async rollback() {
        if (this.committed) {
            throw new Error('Cannot rollback: transaction already committed');
        }
        if (this.rolledBack) {
            throw new Error('Transaction already rolled back');
        }
        // Rollback through coordinator
        await this.coordinator.rollback(this.stamp.id);
        this.coordinator.clearReadDependencies();
        this.rolledBack = true;
        this.statements.length = 0;
    }
    /**
     * Get the transaction stamp ID (stable throughout transaction).
     */
    getStampId() {
        return this.stamp.id;
    }
    /**
     * Get the transaction stamp (full metadata).
     */
    getStamp() {
        return this.stamp;
    }
    /**
     * Get the list of accumulated statements.
     */
    getStatements() {
        return this.statements;
    }
    /**
     * Check if the transaction has been committed.
     */
    isCommitted() {
        return this.committed;
    }
    /**
     * Check if the transaction has been rolled back.
     */
    isRolledBack() {
        return this.rolledBack;
    }
}
//# sourceMappingURL=session.js.map