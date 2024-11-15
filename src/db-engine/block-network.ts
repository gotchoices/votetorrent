import { PeerId } from "@libp2p/interface";
import { BlockGet, BlockTrx, BlockTrxRef, BlockTrxStatus, CommitSuccess, IBlock, BlockNetwork as IBlockNetwork, PendSuccess, StaleFailure, KeyNetwork, BlockId, GetBlockResult, blockIdsForMutation, Mutations, emptyMutations, mutationsForBlockId, mergeMutations, Repo, TransactionId, PendResult, CommitResult, Condition } from "../db-core/index.js";
import { RepoClient } from "./repo-client.js";
import forEach from "it-foreach";
import { Pending } from "./pending.js";

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
		const distinctBlockIds = new Map(blockGets.map(bg => [bg.blockId.toString(), bg] as const));

		// Find coordinator for each key
		const infoByBlockId = await Promise.all(Array.from(distinctBlockIds.entries())
			.map(async ([bidStr, bg]) => [bidStr, { blockId: bg.blockId, peerId: await this.keyNetwork.findCoordinator(bg.blockId) }] as const));
		const infoByBlockIdMap = new Map(infoByBlockId);

		// Make a map of distinct coordinators and their associated blocks
		const coordinators = infoByBlockId.reduce((acc, [bidStr, info]) => {
			const peerId_str = info.peerId.toString();
			const coordinator = acc.get(peerId_str) ?? { peerId: info.peerId, blockGets: [] };
			coordinator.blockGets.push(...blockGets.filter(bg => bg.blockId === info.blockId));
			acc.set(peerId_str, coordinator);
			return acc;
		}, new Map<string, CoordinatorGets>());

		const expiration = Date.now() + this.timeoutMs;

		await Promise.all(Array.from(coordinators.values()).map(async coordinator => {
			// Dial coordinator
			coordinator.repoClient = RepoClient.create(coordinator.peerId, this.keyNetwork);
			// Send get request
			coordinator.results = await coordinator.repoClient.get(coordinator.blockGets, { expiration });
			// TODO: if something goes wrong, try to find a new coordinator (retry without cache)
		}));

		// Collect replies back into get order
		return blockGets.map(bg => {
			const coordinator = coordinators.get(infoByBlockIdMap.get(bg.blockId.toString())!.peerId.toString())!;
			const index = coordinator.blockGets.findIndex(r => r.blockId === bg.blockId);
			return coordinator.results![index];
		});
	}

	async getStatus(blockTrxes: BlockTrxRef[]): Promise<BlockTrxStatus[]> {
		throw new Error("Method not implemented.");
	}

	async pend(blockTrx: BlockTrx, options: { pending: "return" | "fail"; }): Promise<PendResult> {
		const mutationsForBlock = (payload: Mutations, blockId: Uint8Array, mergeWithPayload: Mutations | undefined): Mutations => {
			const filteredMutations = mutationsForBlockId(payload, blockId);
			return mergeWithPayload ? mergeMutations(mergeWithPayload, filteredMutations) : filteredMutations;
		};
		const blockIds = blockIdsForMutation(blockTrx.mutations);
		const batches = await this.batchesForPayload<Mutations, PendResult>(blockIds, blockTrx.mutations, mutationsForBlock, []);
		const expiration = Date.now() + this.timeoutMs;

		let error: Error | undefined;
		try {
			// Process all batches, noting all outstanding peers
			await this.processBatches<Mutations, PendResult>(
				batches,
				(repo, batch) => repo.pend(batch.payload, { expiration }),
				batch => blockIdsForMutation(batch.payload),
				mutationsForBlock,
				expiration
			);
		} catch (e) {
			error = e as Error;
		}

		if (!everyBatch(batches, b => b.request?.isResponse as boolean && b.request!.response!.success)) {
			error = Error(`Some peers did not complete: ${Array.from(incompleteBatches(batches)).map(b => b.peerId).join(", ")}`);
		}

		if (error) { // If any failures, cancel all pending transactions as background microtask
			Promise.resolve().then(() => this.abortOrCancelBatch(batches, { blockIds, transactionId: blockTrx.transactionId }, 'cancel'));
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
				blockIds: blockIdsForMutation(blockTrx.mutations)
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
		const expiration = Date.now() + this.timeoutMs;
		await this.processBatches(
			batches,
			(repo, batch) => repo.cancel({ transactionId: trxRef.transactionId, blockIds: batch.payload }, { expiration }),
			batch => batch.payload,
			mergeBlocks,
			expiration
		);
	}

	async commit(trxRef: BlockTrxRef): Promise<CommitResult> {
		const batches = await this.batchesForPayload<BlockId[], CommitResult>(
			trxRef.blockIds,
			trxRef.blockIds,
			mergeBlocks,
			[]
		);
		const expiration = Date.now() + this.timeoutMs;
		let error: Error | undefined;
		try {
			await this.processBatches(
				batches,
				(repo, batch) => repo.commit({ transactionId: trxRef.transactionId, blockIds: batch.payload }, { expiration }),
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

		if (error) { // If any failures, abort all pending transactions as background microtask
			Promise.resolve().then(() => this.abortOrCancelBatch(batches, trxRef, 'abort'));
			const stale = Array.from(allBatches(batches, b => b.request?.isResponse as boolean && !b.request!.response!.success));
			if (stale.length > 0) {	// Any active stale failures should preempt reporting connection or other potential transient errors (we have information)
				return { missing: distinctBlockTrx(stale.flatMap(b => (b.request!.response! as StaleFailure).missing)), success: false };
			}
			throw error;	// No stale failures, report the original error
		}

		// Collect replies back into result structure
		const completed = Array.from(allBatches(batches, b => b.request?.isResponse as boolean && b.request!.response!.success));
		return {
			conditions: distinctConditions(completed.flatMap(b => (b.request!.response! as CommitSuccess).conditions)),
			success: true,
		};
	}

	abort(trxRef: BlockTrxRef): Promise<void> {
		throw new Error("Method not implemented.");
	}

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
				[bid, await this.keyNetwork.findCoordinator(bid, { excludedPeers })] as const
			)
		);

		// Group blocks around their coordinating peers
		return makeBatchesByPeer<TPayload, TResponse>(blockIdPeerId, payload, getBlockPayload);
	}

	private async abortOrCancelBatch<TPayload, TResponse>(
		batches: CoordinatorBatch<TPayload, TResponse>[],
		trxRef: BlockTrxRef,
		operation: 'abort' | 'cancel'
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
			(repo, batch) => operation === 'abort'
				? repo.abort({ transactionId: trxRef.transactionId, blockIds: batch.payload })
				: repo.cancel({ transactionId: trxRef.transactionId, blockIds: batch.payload }),
			batch => batch.payload,
			mergeBlocks,
			expiration
		);
	}
}

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

function *incompleteBatches<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[]): IterableIterator<CoordinatorBatch<TPayload, TResponse>> {
	for (const batch of batches) {
		if (!batch.request || !batch.request.isResponse) yield batch;
		if (batch.subsumedBy) yield* incompleteBatches(batch.subsumedBy);
	}
}

function everyBatch<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[], predicate: (batch: CoordinatorBatch<TPayload, TResponse>) => boolean): boolean {
	return batches.every(b => (b.subsumedBy && everyBatch(b.subsumedBy, predicate)) ||predicate(b));
}

function *allBatches<TPayload, TResponse>(batches: CoordinatorBatch<TPayload, TResponse>[], predicate?: (batch: CoordinatorBatch<TPayload, TResponse>) => boolean): IterableIterator<CoordinatorBatch<TPayload, TResponse>> {
	for (const batch of batches) {
		if (!predicate || predicate(batch)) yield batch;
		if (batch.subsumedBy) yield* allBatches(batch.subsumedBy, predicate);
	}
}

function mergeBlocks(payload: Uint8Array[], blockId: Uint8Array, mergeWithPayload: Uint8Array[] | undefined): Uint8Array[] {
	return [...(mergeWithPayload ?? []), blockId];
}

function distinctConditions(conditions: Condition[]): Condition[] {
	return [...new Map(conditions.map(c => [c.blockId.toString() + c.transactionId.toString(), c])).values()];
}

function distinctBlockTrx(blockTrxes: BlockTrx[]): BlockTrx[] {
	return [...new Map(blockTrxes.map(t => [t.transactionId.toString() + t.mutations.toString(), t])).values()];
}

