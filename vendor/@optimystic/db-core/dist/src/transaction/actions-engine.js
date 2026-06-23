export const ACTIONS_ENGINE_ID = "actions@1.0.0";
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
export class ActionsEngine {
    coordinator;
    constructor(coordinator) {
        this.coordinator = coordinator;
    }
    async execute(transaction) {
        try {
            // Parse each statement as a CollectionActions object
            const allActions = [];
            for (const statement of transaction.statements) {
                const collectionActions = JSON.parse(statement);
                // Validate structure
                if (!collectionActions.collectionId || typeof collectionActions.collectionId !== 'string') {
                    return {
                        success: false,
                        error: 'Invalid statement: missing collectionId'
                    };
                }
                if (!collectionActions.actions || !Array.isArray(collectionActions.actions)) {
                    return {
                        success: false,
                        error: `Invalid statement: collection ${collectionActions.collectionId} missing or invalid actions array`
                    };
                }
                allActions.push(collectionActions);
                // Apply actions through coordinator (for validation/replay)
                await this.coordinator.applyActions([collectionActions], transaction.stamp.id);
            }
            // Return success (actions already applied)
            return {
                success: true,
                actions: allActions
            };
        }
        catch (error) {
            return {
                success: false,
                error: `Failed to execute transaction: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }
}
//# sourceMappingURL=actions-engine.js.map