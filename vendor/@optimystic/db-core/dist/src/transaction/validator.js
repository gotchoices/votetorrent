import { isTransactionExpired } from './transaction.js';
import { hashString } from '../utility/hash-string.js';
/**
 * Transaction validator implementation.
 *
 * Validates transactions by re-executing them and comparing operations hash.
 * Used by cluster participants when receiving PendRequests.
 */
export class TransactionValidator {
    engines;
    createValidationCoordinator;
    blockStateProvider;
    constructor(engines, createValidationCoordinator, blockStateProvider) {
        this.engines = engines;
        this.createValidationCoordinator = createValidationCoordinator;
        this.blockStateProvider = blockStateProvider;
    }
    async validate(transaction, operationsHash) {
        const { stamp } = transaction;
        // 0. Check expiration before any other work
        if (isTransactionExpired(stamp)) {
            return {
                valid: false,
                reason: `Transaction expired at ${stamp.expiration}`
            };
        }
        // 1. Verify engine exists
        const registration = this.engines.get(stamp.engineId);
        if (!registration) {
            return {
                valid: false,
                reason: `Unknown engine: ${stamp.engineId}`
            };
        }
        // 2. Verify schema hash matches
        const localSchemaHash = await registration.getSchemaHash();
        if (localSchemaHash !== stamp.schemaHash) {
            return {
                valid: false,
                reason: `Schema mismatch: local=${localSchemaHash}, sender=${stamp.schemaHash}`
            };
        }
        // 3. Verify read dependencies (optimistic concurrency)
        if (this.blockStateProvider && transaction.reads.length > 0) {
            for (const read of transaction.reads) {
                const currentState = await this.blockStateProvider(read.blockId);
                const currentRev = currentState?.latest?.rev ?? 0;
                if (currentRev !== read.revision) {
                    return {
                        valid: false,
                        reason: `Stale read: block ${read.blockId} was at revision ${read.revision} but is now at ${currentRev}`
                    };
                }
            }
        }
        // 4. Create isolated validation coordinator
        const validationCoordinator = this.createValidationCoordinator();
        try {
            // 5. Re-execute transaction through engine
            const result = await registration.engine.execute(transaction);
            if (!result.success) {
                return {
                    valid: false,
                    reason: `Re-execution failed: ${result.error}`
                };
            }
            // 6. Apply actions to validation coordinator (builds transforms)
            if (result.actions && result.actions.length > 0) {
                await validationCoordinator.applyActions(result.actions, stamp.id);
            }
            // 7. Collect operations from validation coordinator
            const transforms = validationCoordinator.getTransforms();
            const allOperations = this.collectOperations(transforms);
            // 8. Compute hash
            const computedHash = await this.hashOperations(allOperations);
            // 9. Compare with sender's hash
            if (computedHash !== operationsHash) {
                return {
                    valid: false,
                    reason: `Operations hash mismatch`,
                    computedHash
                };
            }
            return { valid: true, computedHash };
        }
        finally {
            validationCoordinator.dispose();
        }
    }
    async getSchemaHash(engineId) {
        const registration = this.engines.get(engineId);
        return registration ? await registration.getSchemaHash() : undefined;
    }
    /**
     * Collect all operations from transforms.
     */
    collectOperations(transforms) {
        return Array.from(transforms.entries()).flatMap(([collectionId, t]) => [
            ...Object.entries(t.inserts ?? {}).map(([blockId, block]) => ({ type: 'insert', collectionId, blockId, block })),
            ...Object.entries(t.updates ?? {}).map(([blockId, operations]) => ({ type: 'update', collectionId, blockId, operations })),
            ...(t.deletes ?? []).map(blockId => ({ type: 'delete', collectionId, blockId }))
        ]);
    }
    /**
     * Compute hash of all operations.
     * Must match TransactionCoordinator.hashOperations for consistent validation.
     */
    async hashOperations(operations) {
        const operationsData = JSON.stringify(operations);
        return `ops:${await hashString(operationsData)}`;
    }
}
//# sourceMappingURL=validator.js.map