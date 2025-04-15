import { type PeerId } from "@libp2p/interface";
import type { TrxTransforms, TrxBlocks, BlockTrxStatus, ITransactor, PendSuccess, StaleFailure, IKeyNetwork, BlockId, GetBlockResults, PendResult, CommitResult, PendRequest, IRepo, BlockGets, Transforms, CommitRequest, TrxId, RepoCommitRequest } from "../index.js";
import { transformForBlockId, groupBy, concatTransforms, concatTransform, transformsFromTransform, blockIdsForTransforms } from "../index.js";
import { blockIdToBytes } from "../utility/block-id-to-bytes.js";
import { isRecordEmpty } from "../utility/is-record-empty.js";
import { type CoordinatorBatch, makeBatchesByPeer, incompleteBatches, everyBatch, allBatches, mergeBlocks, processBatches, createBatchesForPayload } from "../utility/batch-coordinator.js";

type NetworkTransactorInit = {
	timeoutMs: number;
	abortOrCancelTimeoutMs: number;
	keyNetwork: IKeyNetwork;
	getRepo: (peerId: PeerId) => IRepo;
}

export class NetworkTransactor implements ITransactor {
	private readonly keyNetwork: IKeyNetwork;
	private readonly timeoutMs: number;
	private readonly abortOrCancelTimeoutMs: number;
	private readonly getRepo: (peerId: PeerId) => IRepo;

	constructor(
		init: NetworkTransactorInit,
	) {
		this.keyNetwork = init.keyNetwork;
		this.timeoutMs = init.timeoutMs;
		this.abortOrCancelTimeoutMs = init.abortOrCancelTimeoutMs;
		this.getRepo = init.getRepo;
	}

	async get(blockGets: BlockGets): Promise<GetBlockResults> {
		// Group by block id
		const distinctBlockIds = Array.from(new Set(blockGets.blockIds));

		const batches = await this.batchesForPayload<BlockId[], GetBlockResults>(
			distinctBlockIds,
			distinctBlockIds,
			(gets, blockId, mergeWithGets) => [...(mergeWithGets ?? []), ...gets.filter(bid => bid === blockId)],
			[]
		);

		const expiration = Date.now() + this.timeoutMs;

		let error: Error | undefined;
		try {
			await processBatches(
				batches,
				(batch) => this.getRepo(batch.peerId).get({ blockIds: batch.payload, context: blockGets.context }, { expiration }),
				batch => batch.payload,
				(gets, blockId, mergeWithGets) => [...(mergeWithGets ?? []), ...gets.filter(bid => bid === blockId)],
				expiration,
				async (blockId, options) => this.keyNetwork.findCoordinator(blockIdToBytes(blockId), options)
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
		const completedBatches = Array.from(allBatches(batches, b => b.request?.isResponse as boolean && !isRecordEmpty(b.request!.response!)));

		// Create a lookup map from successful responses only
		return Object.fromEntries(
			completedBatches
				.flatMap((batch) =>
					Object.entries(batch.request!.response!).map(([blockId, result]) => [
						blockId,
						result
					])
				)
		) as GetBlockResults;
	}

	async getStatus(blockTrxes: TrxBlocks[]): Promise<BlockTrxStatus[]> {
		throw new Error("Method not implemented.");
	}

	async pend(blockTrx: PendRequest): Promise<PendResult> {
		const transformForBlock = (payload: Transforms, blockId: BlockId, mergeWithPayload: Transforms | undefined): Transforms => {
			const filteredTransform = transformForBlockId(payload, blockId);
			return mergeWithPayload
				? concatTransform(mergeWithPayload, blockId, filteredTransform)
				: transformsFromTransform(filteredTransform, blockId);
		};
		const blockIds = blockIdsForTransforms(blockTrx.transforms);
		const batches = await this.batchesForPayload<Transforms, PendResult>(blockIds, blockTrx.transforms, transformForBlock, []);
		const expiration = Date.now() + this.timeoutMs;

		let error: Error | undefined;
		try {
			// Process all batches, noting all outstanding peers
			await processBatches(
				batches,
				(batch) => this.getRepo(batch.peerId).pend({ ...blockTrx, transforms: batch.payload }, { expiration }),
				batch => blockIdsForTransforms(batch.payload),
				transformForBlock,
				expiration,
				async (blockId, options) => this.keyNetwork.findCoordinator(blockIdToBytes(blockId), options)
			);
		} catch (e) {
			error = e as Error;
		}

		if (!everyBatch(batches, b => b.request?.isResponse as boolean && b.request!.response!.success)) {
			error = Error(`Some peers did not complete: ${Array.from(incompleteBatches(batches)).map(b => b.peerId).join(", ")}`);
		}

		if (error) { // If any failures, cancel all pending transactions as background microtask
			Promise.resolve().then(() => this.cancelBatch(batches, { blockIds, trxId: blockTrx.trxId }));
			const stale = Array.from(allBatches(batches, b => b.request?.isResponse as boolean && !b.request!.response!.success));
			if (stale.length > 0) {	// Any active stale failures should preempt reporting connection or other potential transient errors (we have information)
				return {
					success: false,
					missing: distinctBlockTrxTransforms(stale.flatMap(b => (b.request!.response! as StaleFailure).missing).filter((x): x is TrxTransforms => x !== undefined)),
				};
			}
			throw error;	// No stale failures, report the original error
		}

		// Collect replies back into result structure
		const completed = Array.from(allBatches(batches, b => b.request?.isResponse as boolean && b.request!.response!.success));
		return {
			success: true,
			pending: completed.flatMap(b => (b.request!.response! as PendSuccess).pending),
			blockIds: blockIdsForTransforms(blockTrx.transforms)
		};
	}

	async cancel(trxRef: TrxBlocks): Promise<void> {
		const batches = await this.batchesForPayload<BlockId[], void>(
			trxRef.blockIds,
			trxRef.blockIds,
			mergeBlocks,
			[]
		);
		const expiration = Date.now() + this.abortOrCancelTimeoutMs;
		await processBatches(
			batches,
			(batch) => this.getRepo(batch.peerId).cancel({ trxId: trxRef.trxId, blockIds: batch.payload }, { expiration }),
			batch => batch.payload,
			mergeBlocks,
			expiration,
			async (blockId, options) => this.keyNetwork.findCoordinator(blockIdToBytes(blockId), options)
		);
	}

	async commit(request: CommitRequest): Promise<CommitResult> {
		const allBlockIds = [...new Set([...request.blockIds, request.tailId])];

		if (request.headerId) {	// Commit the header block if this is a first time commit
			const headerResult = await this.commitBlock(request.headerId, allBlockIds, request.trxId, request.rev);
			if (!headerResult.success) {
				return headerResult;
			}
		}

		// Commit the tail block
		const tailResult = await this.commitBlock(request.tailId, allBlockIds, request.trxId, request.rev);
		if (!tailResult.success) {
			return tailResult;
		}

		// Commit all remaining block ids
		const { batches, error } = await this.commitBlocks({ blockIds: request.blockIds.filter(bid => bid !== request.tailId), trxId: request.trxId, rev: request.rev });
		if (error) {
			// Errors must recover once the tail is committed
			// TODO: log failure
			// TODO: reproduce the original transaction and tell the failed blocks to force commit
			// TODO: remove this throw
			throw error;
		}

		return { success: true };
	}

	private async commitBlock(blockId: BlockId, blockIds: BlockId[], trxId: TrxId, rev: number): Promise<CommitResult> {
		const { batches: tailBatches, error: tailError } = await this.commitBlocks({ blockIds: [blockId], trxId, rev });
		if (tailError) {
			// Cancel all pending transactions as background microtask
			Promise.resolve().then(() => this.cancel({ blockIds, trxId }));
			// Collect and return any active stale failures
			const stale = Array.from(allBatches(tailBatches, b => b.request?.isResponse as boolean && !b.request!.response!.success));
			if (stale.length > 0) {
				return { missing: distinctBlockTrxTransforms(stale.flatMap(b => (b.request!.response! as StaleFailure).missing!)), success: false as const };
			}
			throw tailError;
		}
		return { success: true };
	}

	/** Attempts to commit a set of blocks, and handles failures and errors */
	private async commitBlocks({ blockIds, trxId, rev }: RepoCommitRequest) {
		const expiration = Date.now() + this.timeoutMs;
		const batches = await this.batchesForPayload<BlockId[], CommitResult>(blockIds, blockIds, mergeBlocks, []);
		let error: Error | undefined;
		try {
			await processBatches(
				batches,
				(batch) => this.getRepo(batch.peerId).commit({ trxId, blockIds: batch.payload, rev }, { expiration }),
				batch => batch.payload,
				mergeBlocks,
				expiration,
				async (blockId, options) => this.keyNetwork.findCoordinator(blockIdToBytes(blockId), options)
			);
		} catch (e) {
			error = e as Error;
		}

		if (!everyBatch(batches, b => b.request?.isResponse as boolean && b.request!.response!.success)) {
			error = Error(`Some peers did not complete: ${Array.from(incompleteBatches(batches)).map(b => b.peerId).join(", ")}`);
		}
		return { batches, error };
	};

	/** Creates batches for a given payload, grouped by the coordinating peer for each block id */
	private async batchesForPayload<TPayload, TResponse>(
		blockIds: BlockId[],
		payload: TPayload,
		getBlockPayload: (payload: TPayload, blockId: BlockId, mergeWithPayload: TPayload | undefined) => TPayload,
		excludedPeers: PeerId[]
	): Promise<CoordinatorBatch<TPayload, TResponse>[]> {
		return createBatchesForPayload<TPayload, TResponse>(
			blockIds,
			payload,
			getBlockPayload,
			excludedPeers,
			async (blockId, options) => this.keyNetwork.findCoordinator(blockIdToBytes(blockId), options)
		);
	}

	/** Cancels a pending transaction by canceling all blocks associated with the transaction, including failed peers */
	private async cancelBatch<TPayload, TResponse>(
		batches: CoordinatorBatch<TPayload, TResponse>[],
		trxRef: TrxBlocks,
	) {
		const expiration = Date.now() + this.abortOrCancelTimeoutMs;
		const operationBatches = makeBatchesByPeer(
			Array.from(allBatches(batches)).map(b => [b.blockId, b.peerId] as const),
			trxRef.blockIds,
			mergeBlocks,
			[]
		);
		await processBatches(
			operationBatches,
			(batch) => this.getRepo(batch.peerId).cancel({ trxId: trxRef.trxId, blockIds: batch.payload }, { expiration }),
			batch => batch.payload,
			mergeBlocks,
			expiration,
			async (blockId, options) => this.keyNetwork.findCoordinator(blockIdToBytes(blockId), options)
		);
	}
}


/**
 * Returns the block trxes grouped by transaction id and concatenated transforms
 */
export function distinctBlockTrxTransforms(blockTrxes: TrxTransforms[]): TrxTransforms[] {
	const grouped = groupBy(blockTrxes, ({ trxId }) => trxId);
	return Object.entries(grouped).map(([trxId, trxes]) =>
		({ trxId, transforms: concatTransforms(...trxes.map(t => t.transforms)) } as TrxTransforms));
}
