import type { PeerId } from "../network/types.js";
import type { BlockId } from "../index.js";
import { Pending } from "./pending.js";
/**
 * Represents a batch of operations for a specific block coordinated by a peer
 */
export type CoordinatorBatch<TPayload, TResponse> = {
    peerId: PeerId;
    blockId: BlockId;
    payload: TPayload;
    request?: Pending<TResponse>;
    /** Whether this batch has been subsumed by other successful batches */
    subsumedBy?: CoordinatorBatch<TPayload, TResponse>[];
    /** Peers that have already been tried (and failed) */
    excludedPeers?: PeerId[];
    /** When a batch coordinates multiple blocks (via cluster intersection), lists all block IDs */
    coordinatingBlockIds?: BlockId[];
};
/**
 * Creates batches for a given payload, grouped by the coordinating peer for each block id
 */
export declare function makeBatchesByPeer<TPayload, TResponse>(blockPeers: (readonly [BlockId, PeerId])[], payload: TPayload, getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload, excludedPeers?: PeerId[]): CoordinatorBatch<TPayload, TResponse>[];
/**
 * Iterates over all batches that have not completed, whether subsumed or not
 */
export declare function incompleteBatches<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[]): IterableIterator<CoordinatorBatch<TPayload, TResponse>>;
/**
 * Checks if all completed batches (ignoring failures) satisfy a predicate
 */
export declare function everyBatch<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[], predicate: (batch: CoordinatorBatch<TPayload, TResponse>) => boolean): boolean;
/**
 * Iterates over all batches that satisfy an optional predicate, whether subsumed or not
 */
export declare function allBatches<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[], predicate?: (batch: CoordinatorBatch<TPayload, TResponse>) => boolean): IterableIterator<CoordinatorBatch<TPayload, TResponse>>;
/**
 * Returns a new blockId list payload with the given block id appended
 */
export declare function mergeBlocks(_payload: BlockId[], blockId: BlockId, mergeWithPayload: BlockId[] | undefined): BlockId[];
/**
 * Processes a set of batches, retrying any failures until success or expiration
 * @param batches - The batches to process - each represents a group of blocks centered on a coordinating peer
 * @param process - The function to call for a given batch
 * @param getBlockIds - The function to call to get the block ids for a given batch
 * @param getBlockPayload - The function to call to get the payload given a parent payload and block id, and optionally merge with an existing payload
 * @param expiration - The expiration time for the operation
 * @param findCoordinator - The function to call to find a coordinator for a block id
 */
export declare function processBatches<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[], process: (batch: CoordinatorBatch<TPayload, TResponse>) => Promise<TResponse>, getBlockIds: (batch: CoordinatorBatch<TPayload, TResponse>) => BlockId[], getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload, expiration: number, findCoordinator: (blockId: BlockId, options: {
    excludedPeers: PeerId[];
}) => Promise<PeerId>): Promise<void>;
/**
 * Creates batches for a given payload, grouped by the coordinating peer for each block id
 * This is a placeholder function that will be implemented by the caller
 */
export declare function createBatchesForPayload<TPayload, TResponse>(blockIds: BlockId[], payload: TPayload, getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload, excludedPeers: PeerId[], findCoordinator: (blockId: BlockId, options: {
    excludedPeers: PeerId[];
}) => Promise<PeerId>): Promise<CoordinatorBatch<TPayload, TResponse>[]>;
//# sourceMappingURL=batch-coordinator.d.ts.map