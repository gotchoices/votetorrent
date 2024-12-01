import { PeerId } from "@libp2p/interface";
import { BlockGet, BlockTrx, BlockTrxRef, BlockTrxStatus, CommitSuccess, IBlock, BlockNetwork as IBlockNetwork, PendSuccess, StaleFailure, KeyNetwork, BlockId, GetBlockResult, blockIdsForTransform, Transform, emptyTransform, transformForBlockId, mergeTransforms, Repo, TransactionId, PendResult, CommitResult, BlockTrxRequest, concatTransforms } from "../db-core/index.js";
import { RepoClient, Pending, blockIdToBytes } from "./index.js";
import map from "it-map";

type CoordinatorGets = {
	peerId: PeerId;
	blockGets: BlockGet[];
	repoClient?: RepoClient;
	results?: GetBlockResult[];
}

type CoordinatorBatch<TPayload, TResponse> = {
	peerId: PeerId;
	blockId: BlockId;
	payload: TPayload;
	repo?: Repo;
	request?: Pending<TResponse>;
	/** Whether this batch has been subsumed by other successful batches */
	subsumedBy?: CoordinatorBatch<TPayload, TResponse>[];
	/** Peers that have already been tried (and failed) */
	excludedPeers?: PeerId[];
}

type BlockNetworkInit = {
	timeoutMs: number;
	abortOrCancelTimeoutMs: number;
	keyNetwork: KeyNetwork;
}

export class BlockNetwork implements IBlockNetwork {
	private readonly keyNetwork: KeyNetwork;
	private readonly timeoutMs: number;
	private readonly abortOrCancelTimeoutMs: number;

	constructor(
		init: BlockNetworkInit,
	) {
		this.keyNetwork = init.keyNetwork;
		this.timeoutMs = init.timeoutMs;
		this.abortOrCancelTimeoutMs = init.abortOrCancelTimeoutMs;
	}

	async get(blockGets: BlockGet[]): Promise<GetBlockResult[]> {
		// Group by block id
		const distinctBlockIds = new Map(blockGets.map(bg => [bg.blockId, bg] as const));

		const batches = await this.batchesForPayload<BlockGet[], GetBlockResult[]>(
			Array.from(map(distinctBlockIds.values(), bg => bg.blockId)),
			blockGets,
			(gets, blockId, mergeWithGets) => [...(mergeWithGets ?? []), ...gets.filter(g => g.blockId === blockId)],
			[]
		);

		const expiration = Date.now() + this.timeoutMs;

		let error: Error | undefined;
		try {
			await this.processBatches(
				batches,
				(repo, batch) => repo.get(batch.payload, { expiration }),
				batch => batch.payload.map(bg => bg.blockId),
				(gets, blockId, mergeWithGets) => [...(mergeWithGets ?? []), ...gets.filter(g => g.blockId === blockId)],
				expiration
			);
		} catch (e) {
			error = e as Error;
		}

		// Only throw if we had actual failures and no successful retries
		if (!everyBatch(batches, b => b.request?.isResponse as boolean)) {
			error = Error(`Some peers did not complete: ${Array.from(incompleteBatches(batches)).map(b => b.peerId).join(", ")}`);
		}

		if (error) {
			throw error;
		}

		// Cache the completed batches that had actual responses (not just coordinator not found)
		const completedBatches = Array.from(allBatches(batches, b => b.request?.isResponse as boolean && b.request!.response!.length > 0));

		// Create a lookup map from successful responses only
		const blockResultMap = new Map(
			completedBatches
				.flatMap(batch =>
					batch.request!.response!.map((result, index) => [
						batch.payload[index].blockId,
						result
					])
				)
		);

		// Use the map for faster lookups
		return blockGets.map(bg => blockResultMap.get(bg.blockId)!);
	}

	async getStatus(blockTrxes: BlockTrxRef[]): Promise<BlockTrxStatus[]> {
		throw new Error("Method not implemented.");
	}

	async pend(blockTrx: BlockTrxRequest, options: { pending: "return" | "fail"; }): Promise<PendResult> {
		const transformForBlock = (payload: Transform, blockId: BlockId, mergeWithPayload: Transform | undefined): Transform => {
			const filteredTransform = transformForBlockId(payload, blockId);
			return mergeWithPayload ? mergeTransforms(mergeWithPayload, filteredTransform) : filteredTransform;
		};
		const blockIds = blockIdsForTransform(blockTrx.transform);
		const batches = await this.batchesForPayload<Transform, PendResult>(blockIds, blockTrx.transform, transformForBlock, []);
		const expiration = Date.now() + this.timeoutMs;

		let error: Error | undefined;
		try {
			// Process all batches, noting all outstanding peers
			await this.processBatches<Transform, PendResult>(
				batches,
				(repo, batch) => repo.pend(batch.payload, { expiration }),
				batch => blockIdsForTransform(batch.payload),
				transformForBlock,
				expiration
			);
		} catch (e) {
			error = e as Error;
		}

		if (!everyBatch(batches, b => b.request?.isResponse as boolean && b.request!.response!.success)) {
			error = Error(`Some peers did not complete: ${Array.from(incompleteBatches(batches)).map(b => b.peerId).join(", ")}`);
		}

		if (error) { // If any failures, cancel all pending transactions as background microtask
			Promise.resolve().then(() => this.cancelBatch(batches, { blockIds, transactionId: blockTrx.transactionId }));
			const stale = Array.from(allBatches(batches, b => b.request?.isResponse as boolean && !b.request!.response!.success));
			if (stale.length > 0) {	// Any active stale failures should preempt reporting connection or other potential transient errors (we have information)
				return { missing: stale.flatMap(b => (b.request!.response! as StaleFailure).missing), success: false };
			}
			throw error;	// No stale failures, report the original error
		}

		// Collect replies back into result structure
		const completed = Array.from(allBatches(batches, b => b.request?.isResponse as boolean && b.request!.response!.success));
		return {
			pending: completed.flatMap(b => (b.request!.response! as PendSuccess).pending),
			success: true,
			trxRef: {
				transactionId: blockTrx.transactionId,
				blockIds: blockIdsForTransform(blockTrx.transform)
			}
		};
	}

	async cancel(trxRef: BlockTrxRef): Promise<void> {
		const batches = await this.batchesForPayload<BlockId[], void>(
			trxRef.blockIds,
			trxRef.blockIds,
			mergeBlocks,
			[]
		);
		const expiration = Date.now() + this.abortOrCancelTimeoutMs;
		await this.processBatches(
			batches,
			(repo, batch) => repo.cancel({ transactionId: trxRef.transactionId, blockIds: batch.payload }, { expiration }),
			batch => batch.payload,
			mergeBlocks,
			expiration
		);
	}

	async commit(tailId: BlockId, trxRef: BlockTrxRef): Promise<CommitResult> {
		// Commit the tail block
		const { batches: tailBatches, error: tailError } = await this.processBlocks([tailId], trxRef.transactionId);
		if (tailError) {
			// Cancel all pending transactions as background microtask
			Promise.resolve().then(() => this.cancel({ blockIds: [...trxRef.blockIds, tailId], transactionId: trxRef.transactionId }));
			// Collect and return any active stale failures
			const stale = Array.from(allBatches(tailBatches, b => b.request?.isResponse as boolean && !b.request!.response!.success));
			if (stale.length > 0) {
				return { missing: distinctBlockTrx(stale.flatMap(b => (b.request!.response! as StaleFailure).missing)), success: false as const };
			}
			throw tailError;
		}

		// Commit all remaining block ids
		const { batches, error } = await this.processBlocks(trxRef.blockIds.filter(bid => bid !== tailId), trxRef.transactionId);
		if (error) {
			// Errors should not happen once the tail is committed
			// TODO: log failure
			// TODO: reproduce the original transaction for tell the failed blocks to force commit
			// TODO: remove this throw
			throw error;
		}

		return { success: true };
	}

	/** Attempts to commit a set of blocks, and handles failures and errors */
	private async processBlocks(blockIds: BlockId[], transactionId: TransactionId) {
		const expiration = Date.now() + this.timeoutMs;
		const batches = await this.batchesForPayload<BlockId[], CommitResult>(blockIds, blockIds, mergeBlocks, []);
		let error: Error | undefined;
		try {
			await this.processBatches(
				batches,
				(repo, batch) => repo.commit({ transactionId, blockIds: batch.payload }, { expiration }),
				batch => batch.payload,
				mergeBlocks,
				expiration
			);
		} catch (e) {
			error = e as Error;
		}

		if (!everyBatch(batches, b => b.request?.isResponse as boolean && b.request!.response!.success)) {
			error = Error(`Some peers did not complete: ${Array.from(incompleteBatches(batches)).map(b => b.peerId).join(", ")}`);
		}
		return { batches, error };
	};

	/** Processes a set of batches, retrying any failures until success or expiration
	 * @param batches - The batches to process - each represents a group of blocks centered on a coordinating peer
	 * @param process - The function to call for a given batch
	 * @param getBlockIds - The function to call to get the block ids for a given batch
	 * @param getBlockPayload - The function to call to get the payload given a parent payload and block id, and optionally merge with an existing payload
	 * @param expiration - The expiration time for the operation
	*/
	private async processBatches<TPayload, TResponse>(
		batches: CoordinatorBatch<TPayload, TResponse>[],
		process: (repo: Repo, batch: CoordinatorBatch<TPayload, TResponse>) => Promise<TResponse>,
		getBlockIds: (batch: CoordinatorBatch<TPayload, TResponse>) => BlockId[],
		getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload,
		expiration: number
	): Promise<void> {
		await Promise.all(batches.map(async (batch) => {
			batch.repo = RepoClient.create(batch.peerId, this.keyNetwork);
			batch.request = new Pending(process(batch.repo, batch)
				.catch(async e => {
					// TODO: log failure
					// logger.log(`operation failed for ${batch.peerId}`);
					if (expiration > Date.now()) {
						const excludedPeers = [batch.peerId, ...(batch.excludedPeers ?? [])];
						// Redistribute failed attempts and append to original batches
						const retries = await this.batchesForPayload<TPayload, TResponse>(getBlockIds(batch), batch.payload, getBlockPayload, excludedPeers);
						// Process the new attempts
						if (retries.length > 0 && expiration > Date.now()) {
							batch.subsumedBy = retries;
							// Append new attempts to the original batches map
							await this.processBatches(retries, process, getBlockIds, getBlockPayload, expiration);
						}
					}
					throw e;
				}));
		}));
	}

	/** Creates batches for a given payload, grouped by the coordinating peer for each block id */
	private async batchesForPayload<TPayload, TResponse>(
		blockIds: BlockId[],
		payload: TPayload,
		getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload,
		excludedPeers: PeerId[]
	): Promise<CoordinatorBatch<TPayload, TResponse>[]> {
		// Group by block id
		const distinctBlockIds = new Set(blockIds);

		// Find coordinator for each key
		const blockIdPeerId = await Promise.all(
			Array.from(distinctBlockIds).map(async (bid) =>
				[bid, await this.keyNetwork.findCoordinator(blockIdToBytes(bid), { excludedPeers })] as const
			)
		);

		// Group blocks around their coordinating peers
		return makeBatchesByPeer<TPayload, TResponse>(blockIdPeerId, payload, getBlockPayload);
	}

	/** Cancels a pending transaction by canceling all blocks associated with the transaction, including failed peers */
	private async cancelBatch<TPayload, TResponse>(
		batches: CoordinatorBatch<TPayload, TResponse>[],
		trxRef: BlockTrxRef,
	) {
		const expiration = Date.now() + this.abortOrCancelTimeoutMs;
		const operationBatches = makeBatchesByPeer(
			Array.from(allBatches(batches)).map(b => [b.blockId, b.peerId] as const),
			trxRef.blockIds,
			mergeBlocks,
			[]
		);
		await this.processBatches(
			operationBatches,
			(repo, batch) => repo.cancel({ transactionId: trxRef.transactionId, blockIds: batch.payload }),
			batch => batch.payload,
			mergeBlocks,
			expiration
		);
	}
}

/** Creates batches for a given payload, grouped by the coordinating peer for each block id */
function makeBatchesByPeer<TPayload, TResponse>(
	blockPeers: (readonly [BlockId, PeerId])[],
	payload: TPayload,
	getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload,
	excludedPeers?: PeerId[]
) {
	const groups = blockPeers.reduce((acc, [blockId, peerId]) => {
		const peerId_str = peerId.toString();
		const coordinator = acc.get(peerId_str) ?? { peerId, blockId, excludedPeers } as Partial<CoordinatorBatch<TPayload, TResponse>>;
		acc.set(peerId_str, { ...coordinator, payload: getBlockPayload(payload, blockId, coordinator.payload) } as CoordinatorBatch<TPayload, TResponse>);
		return acc;
	}, new Map<string, CoordinatorBatch<TPayload, TResponse>>());
	return Array.from(groups.values());
}

/** Iterates over all batches that have not completed, whether subsumed or not */
function *incompleteBatches<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[]): IterableIterator<CoordinatorBatch<TPayload, TResponse>> {
	for (const batch of batches) {
		if (!batch.request || !batch.request.isResponse) yield batch;
		if (batch.subsumedBy) yield* incompleteBatches(batch.subsumedBy);
	}
}

/** Checks if all completed batches (ignoring failures) satisfy a predicate */
function everyBatch<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[], predicate: (batch: CoordinatorBatch<TPayload, TResponse>) => boolean): boolean {
	return batches.every(b => (b.subsumedBy && everyBatch(b.subsumedBy, predicate)) ||predicate(b));
}

/** Iterates over all batches that satisfy an optional predicate, whether subsumed or not */
function *allBatches<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[], predicate?: (batch: CoordinatorBatch<TPayload, TResponse>) => boolean): IterableIterator<CoordinatorBatch<TPayload, TResponse>> {
	for (const batch of batches) {
		if (!predicate || predicate(batch)) yield batch;
		if (batch.subsumedBy) yield* allBatches(batch.subsumedBy, predicate);
	}
}

/** Returns a new blockId list payload with the given block id appended */
function mergeBlocks(payload: BlockId[], blockId: BlockId, mergeWithPayload: BlockId[] | undefined): BlockId[] {
	return [...(mergeWithPayload ?? []), blockId];
}

/** Returns a new set of block trxes grouped by transaction id and concatenated transforms */
function distinctBlockTrx(blockTrxes: BlockTrx[]): BlockTrx[] {
	const grouped = Object.groupBy(blockTrxes, ({ transactionId }) => transactionId);
	return Object.entries(grouped).map(([transactionId, trxes]) => ({ transactionId, transform: concatTransforms(trxes!.map(t => t.transform)) } as BlockTrx));
}
