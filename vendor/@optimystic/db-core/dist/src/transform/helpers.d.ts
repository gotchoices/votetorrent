import type { BlockId, BlockOperation, BlockOperations, BlockStore, IBlock, Transform, Transforms } from "../index.js";
/**
 * Mutates the given block with a copy of the given operation.
 *
 * @warning **MUTATES IN PLACE** - Callers must clone the block first if the original needs preservation.
 * Storage implementations must clone on get/save to prevent cross-revision contamination.
 * @see docs/internals.md for mutation contracts
 */
export declare function applyOperation(block: IBlock, [entity, index, deleteCount, inserted]: BlockOperation): void;
/**
 * Mutates the given block with the given set of operations.
 *
 * @warning **MUTATES IN PLACE** - Callers must clone the block first if the original needs preservation.
 * @see docs/internals.md for mutation contracts
 */
export declare function applyOperations(block: IBlock, operations: BlockOperations): void;
/** Returns a copy of the block with the given operation applied */
export declare function withOperation(block: IBlock, [entity, index, deleteCount, inserted]: BlockOperation): {
    header: import("../index.js").BlockHeader;
};
/** The set of distinct block ids affected by the transform */
export declare function blockIdsForTransforms(transforms: Transforms | undefined): string[];
/** Returns an empty transform */
export declare function emptyTransforms(): Transforms;
/**
 * Creates a deep copy of a Transforms object.
 *
 * @pitfall Both `inserts` and `updates` MUST be deep cloned. A shallow copy like
 * `{ ...transform.updates }` or `{ ...transform.inserts }` shares references, causing
 * mutations in one consumer to affect others. Specifically, `Tracker.update` mutates
 * inserted block objects in place via `applyOperation`, so a shallow-cloned snapshot
 * tracker will leak ops back into the original `Transforms.inserts`.
 * @see docs/internals.md "Shallow Copy of Transforms" pitfall
 */
export declare function copyTransforms(transform: Transforms): Transforms;
export declare function mergeTransforms(a: Transforms, b: Transforms): Transforms;
export declare function isTransformsEmpty(transform: Transforms): boolean;
export declare function concatTransforms(...transforms: Transforms[]): Transforms;
/**
 * Extracts the transform for a specific block from a Transforms object.
 *
 * @pitfall Updates array MUST be deep cloned - extracting without cloning shares
 * the array reference, causing mutations to affect the original Transforms.
 * @see docs/internals.md "Shallow Copy of Transforms" pitfall
 */
export declare function transformForBlockId(transform: Transforms, blockId: BlockId): Transform;
export declare function transformsFromTransform(transform: Transform, blockId: BlockId): Transforms;
export declare function applyTransformToStore<T extends IBlock>(transform: Transforms, store: BlockStore<T>): void;
/** Applies a transform to the given block */
export declare function applyTransform(block: IBlock | undefined, transform: Transform): IBlock | undefined;
/** Concatenates a transform to the given transforms */
export declare function concatTransform(transforms: Transforms, blockId: BlockId, transform: Transform): Transforms;
//# sourceMappingURL=helpers.d.ts.map