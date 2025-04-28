import { type PeerId } from "@libp2p/interface";
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
}

/**
 * Creates batches for a given payload, grouped by the coordinating peer for each block id
 */
export function makeBatchesByPeer<TPayload, TResponse>(
	blockPeers: (readonly [BlockId, PeerId])[],
	payload: TPayload,
	getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload,
	excludedPeers?: PeerId[]
): CoordinatorBatch<TPayload, TResponse>[] {
	const groups = blockPeers.reduce((acc, [blockId, peerId]) => {
		const peerId_str = peerId.toString();
		const coordinator = acc.get(peerId_str) ?? { peerId, blockId, excludedPeers } as Partial<CoordinatorBatch<TPayload, TResponse>>;
		acc.set(peerId_str, { ...coordinator, payload: getBlockPayload(payload, blockId, coordinator.payload) } as CoordinatorBatch<TPayload, TResponse>);
		return acc;
	}, new Map<string, CoordinatorBatch<TPayload, TResponse>>());
	return Array.from(groups.values());
}

/**
 * Iterates over all batches that have not completed, whether subsumed or not
 */
export function* incompleteBatches<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[]): IterableIterator<CoordinatorBatch<TPayload, TResponse>> {
	for (const batch of batches) {
		if (!batch.request || !batch.request.isResponse) yield batch;
		if (batch.subsumedBy) yield* incompleteBatches(batch.subsumedBy);
	}
}

/**
 * Checks if all completed batches (ignoring failures) satisfy a predicate
 */
export function everyBatch<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[], predicate: (batch: CoordinatorBatch<TPayload, TResponse>) => boolean): boolean {
	return batches.every(b => (b.subsumedBy && everyBatch(b.subsumedBy, predicate)) || predicate(b));
}

/**
 * Iterates over all batches that satisfy an optional predicate, whether subsumed or not
 */
export function* allBatches<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[], predicate?: (batch: CoordinatorBatch<TPayload, TResponse>) => boolean): IterableIterator<CoordinatorBatch<TPayload, TResponse>> {
	for (const batch of batches) {
		if (!predicate || predicate(batch)) yield batch;
		if (batch.subsumedBy) yield* allBatches(batch.subsumedBy, predicate);
	}
}

/**
 * Returns a new blockId list payload with the given block id appended
 */
export function mergeBlocks(payload: BlockId[], blockId: BlockId, mergeWithPayload: BlockId[] | undefined): BlockId[] {
	return [...(mergeWithPayload ?? []), blockId];
}

/**
 * Processes a set of batches, retrying any failures until success or expiration
 * @param batches - The batches to process - each represents a group of blocks centered on a coordinating peer
 * @param process - The function to call for a given batch
 * @param getBlockIds - The function to call to get the block ids for a given batch
 * @param getBlockPayload - The function to call to get the payload given a parent payload and block id, and optionally merge with an existing payload
 * @param expiration - The expiration time for the operation
 * @param findCoordinator - The function to call to find a coordinator for a block id
 */
export async function processBatches<TPayload, TResponse>(
	batches: CoordinatorBatch<TPayload, TResponse>[],
	process: (batch: CoordinatorBatch<TPayload, TResponse>) => Promise<TResponse>,
	getBlockIds: (batch: CoordinatorBatch<TPayload, TResponse>) => BlockId[],
	getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload,
	expiration: number,
	findCoordinator: (blockId: BlockId, options: { excludedPeers: PeerId[] }) => Promise<PeerId>
): Promise<void> {
	await Promise.all(batches.map(async (batch) => {
		batch.request = new Pending(process(batch)
			.catch(async e => {
				// TODO: log failure
				// logger.log(`operation failed for ${batch.peerId}`);
				if (expiration > Date.now()) {
					const excludedPeers = [batch.peerId, ...(batch.excludedPeers ?? [])];
					// Redistribute failed attempts and append to original batches
					const retries = await createBatchesForPayload<TPayload, TResponse>(
						getBlockIds(batch),
						batch.payload,
						getBlockPayload,
						excludedPeers,
						findCoordinator
					);
					// Process the new attempts
					if (retries.length > 0 && expiration > Date.now()) {
						batch.subsumedBy = retries;
						// Append new attempts to the original batches map
						await processBatches(retries, process, getBlockIds, getBlockPayload, expiration, findCoordinator);
					}
				}
				throw e;
			}));
	}));

	// Wait for all pending requests to settle (resolve or reject)
	await Promise.all(batches.map(b => b.request?.result().catch(() => {
		/* Ignore errors here, handled by Pending state */
	})));
}

/**
 * Creates batches for a given payload, grouped by the coordinating peer for each block id
 * This is a placeholder function that will be implemented by the caller
 */
export async function createBatchesForPayload<TPayload, TResponse>(
	blockIds: BlockId[],
	payload: TPayload,
	getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload,
	excludedPeers: PeerId[],
	findCoordinator: (blockId: BlockId, options: { excludedPeers: PeerId[] }) => Promise<PeerId>
): Promise<CoordinatorBatch<TPayload, TResponse>[]> {
	// Group by block id
	const distinctBlockIds = new Set(blockIds);

	// Find coordinator for each key
	const blockIdPeerId = await Promise.all(
		Array.from(distinctBlockIds).map(async (bid) =>
			[bid, await findCoordinator(bid, { excludedPeers })] as const
		)
	);

	// Group blocks around their coordinating peers
	return makeBatchesByPeer<TPayload, TResponse>(blockIdPeerId, payload, getBlockPayload, excludedPeers);
}
