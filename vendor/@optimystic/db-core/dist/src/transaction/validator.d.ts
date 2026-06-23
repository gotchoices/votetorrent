import type { BlockId, CollectionId, Transforms } from '../index.js';
import type { Transaction, ITransactionEngine, ITransactionValidator, ValidationResult, CollectionActions } from './transaction.js';
import type { BlockActionState } from '../network/struct.js';
/**
 * Engine registration for validation.
 */
export type EngineRegistration = {
    /** The transaction engine instance */
    engine: ITransactionEngine;
    /** Get the current schema hash for this engine */
    getSchemaHash: () => Promise<string>;
};
/**
 * Factory function to create a validation coordinator.
 * This allows isolated execution of transactions for validation.
 */
export type ValidationCoordinatorFactory = () => {
    /** Apply actions to collections in isolated state */
    applyActions(actions: CollectionActions[], stampId: string): Promise<void>;
    /** Get all transforms from the validation state */
    getTransforms(): Map<CollectionId, Transforms>;
    /** Dispose of the validation coordinator */
    dispose(): void;
};
/**
 * Provides current block state for read dependency validation.
 * Returns the latest BlockActionState for a given block, or undefined if the block doesn't exist.
 */
export type BlockStateProvider = (blockId: BlockId) => Promise<BlockActionState | undefined>;
/**
 * Transaction validator implementation.
 *
 * Validates transactions by re-executing them and comparing operations hash.
 * Used by cluster participants when receiving PendRequests.
 */
export declare class TransactionValidator implements ITransactionValidator {
    private readonly engines;
    private readonly createValidationCoordinator;
    private readonly blockStateProvider?;
    constructor(engines: Map<string, EngineRegistration>, createValidationCoordinator: ValidationCoordinatorFactory, blockStateProvider?: BlockStateProvider | undefined);
    validate(transaction: Transaction, operationsHash: string): Promise<ValidationResult>;
    getSchemaHash(engineId: string): Promise<string | undefined>;
    /**
     * Collect all operations from transforms.
     */
    private collectOperations;
    /**
     * Compute hash of all operations.
     * Must match TransactionCoordinator.hashOperations for consistent validation.
     */
    private hashOperations;
}
//# sourceMappingURL=validator.d.ts.map