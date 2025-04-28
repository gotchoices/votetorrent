import type {
	IRepo, MessageOptions, BlockId, CommitRequest, CommitResult, GetBlockResults, PendRequest, PendResult, TrxBlocks,
	TrxId, BlockGets, TrxPending, PendSuccess, TrxTransform, TrxTransforms,
	Transforms
} from "@votetorrent/db-core";
import { Latches, transformForBlockId, applyTransform, groupBy, concatTransform, emptyTransforms,
	blockIdsForTransforms, transformsFromTransform } from "@votetorrent/db-core";
import { asyncIteratorToArray } from "../it-utility.js";
import type { IBlockStorage } from "./i-block-storage.js";

export class StorageRepo implements IRepo {
	constructor(
		private readonly createBlockStorage: (blockId: BlockId) => IBlockStorage
	) { }

	async get({ blockIds, context }: BlockGets, options?: MessageOptions): Promise<GetBlockResults> {
		const distinctBlockIds = Array.from(new Set(blockIds));
		const results = await Promise.all(distinctBlockIds.map(async (blockId) => {
			const blockStorage = this.createBlockStorage(blockId);

			// Ensure that all outstanding transactions in the context are committed
			if (context) {
				const latest = await blockStorage.getLatest();
				const missing = latest
					? context.committed.filter(c => c.rev > latest.rev)
					: context.committed;
				for (const { trxId, rev } of missing.toSorted((a, b) => a.rev - b.rev)) {
					const pending = await blockStorage.getPendingTransaction(trxId);
					if (pending) {
						await this.internalCommit(blockId, trxId, rev, blockStorage);
					}
				}
			}

			const blockRev = await blockStorage.getBlock(context?.rev);

			// Include pending transaction if requested
			if (context?.trxId !== undefined) {
				const pendingTransform = await blockStorage.getPendingTransaction(context.trxId);
				if (!pendingTransform) {
					throw new Error(`Pending transaction ${context.trxId} not found`);
				}
				const block = applyTransform(blockRev.block, pendingTransform);
				return [blockId, {
					block,
					state: {
						latest: await blockStorage.getLatest(),
						pendings: [context.trxId]
					}
				}];
			}

			const pendings = await asyncIteratorToArray(blockStorage.listPendingTransactions());
			return [blockId, {
				block: blockRev.block,
				state: {
					latest: await blockStorage.getLatest(),
					pendings
				}
			}];
		}));
		return Object.fromEntries(results);
	}

	async pend(request: PendRequest, options?: MessageOptions): Promise<PendResult> {
		const blockIds = blockIdsForTransforms(request.transforms);
		const pendings: TrxPending[] = [];
		const missing: TrxTransforms[] = [];

		// Potential race condition: A concurrent commit operation could complete
		// between the conflict checks (latest.rev, listPendingTransactions) and the
		// savePendingTransaction call below. This pend operation might succeed based on
		// stale information, but the subsequent commit for this pend would likely
		// fail correctly later if a conflict arose. Locking here could make the initial
		// check more accurate but adds overhead. The current approach prioritizes
		// letting the commit be the final arbiter.
		for (const blockId of blockIds) {
			const blockStorage = this.createBlockStorage(blockId);
			const transforms = transformForBlockId(request.transforms, blockId);

			// First handle any pending transactions
			const pending = await asyncIteratorToArray(blockStorage.listPendingTransactions());
			pendings.push(...pending.map(trxId => ({ blockId, trxId } as TrxPending)));

			// Handle any conflicting revisions
			if (request.rev !== undefined || transforms.insert) {
				const latest = await blockStorage.getLatest();
				if (latest && latest.rev >=	(request.rev ?? 0)) {
					const transforms = await asyncIteratorToArray(blockStorage.listRevisions(request.rev ?? 0, latest.rev));
					for (const trxRev of transforms) {
						const transform = await blockStorage.getTransaction(trxRev.trxId);
						if (!transform) {
							throw new Error(`Missing transaction ${trxRev.trxId} for block ${blockId}`);
						}
						missing.push({
							trxId: trxRev.trxId,
							rev: trxRev.rev,
							transforms: transformsFromTransform(transform, blockId)
						});
					}
				}
			}
		}

		if (missing.length) {
			return {
				success: false,
				missing
			};
		}

		if (pendings.length > 0) {
			if (request.policy === 'f') {	// Fail on pending transactions
				return { success: false, pending: pendings };
			} else if (request.policy === 'r') {	// Return populated pending transactions
				return {
					success: false,
					pending: await Promise.all(pendings.map(async trx => {
						const blockStorage = this.createBlockStorage(trx.blockId);
						return {
							blockId: trx.blockId,
							trxId: trx.trxId,
							transform: (await blockStorage.getPendingTransaction(trx.trxId))
								?? (await blockStorage.getTransaction(trx.trxId))!	// Possible that since enumeration, the transaction has been promoted
						}
					}))
				};
			}
		}


		// Simultaneously save pending transaction for each block
		// Note: that this is not atomic, after we checked for conflicts and pending transactions
		// new pending or committed transactions may have been added.  This is okay, because
		// this check during pend is conservative.
		await Promise.all(blockIds.map(blockId => {
			const blockStorage = this.createBlockStorage(blockId);
			const blockTransform = transformForBlockId(request.transforms, blockId);
			return blockStorage.savePendingTransaction(request.trxId, blockTransform);
		}));

		return {
			success: true,
			pending: pendings,
			blockIds
		} as PendSuccess;
	}

	async cancel(trxRef: TrxBlocks, options?: MessageOptions): Promise<void> {
		await Promise.all(trxRef.blockIds.map(blockId => {
			const blockStorage = this.createBlockStorage(blockId);
			return blockStorage.deletePendingTransaction(trxRef.trxId);
		}));
	}

	async commit(request: CommitRequest, options?: MessageOptions): Promise<CommitResult> {
		const uniqueBlockIds = [...new Set(request.blockIds)].sort();
		const releases: (() => void)[] = [];

		try {
			// Acquire locks sequentially based on sorted IDs to prevent deadlocks
			for (const id of uniqueBlockIds) {
				const lockId = `StorageRepo.commit:${id}`;
				const release = await Latches.acquire(lockId);
				releases.push(release);
			}

			// --- Start of Critical Section ---

			const blockStorages = request.blockIds.map(blockId => ({
				blockId,
				storage: this.createBlockStorage(blockId)
			}));

			// Check for stale revisions and collect missing transactions
			const missedCommits: { blockId: BlockId, transforms: TrxTransform[] }[] = [];
			for (const { blockId, storage } of blockStorages) {
				const latest = await storage.getLatest();
				if (latest && latest.rev >= request.rev) {
					const transforms: TrxTransform[] = [];
					for await (const trxRev of storage.listRevisions(request.rev, latest.rev)) {
						const transform = await storage.getTransaction(trxRev.trxId);
						if (!transform) {
							throw new Error(`Missing transaction ${trxRev.trxId} for block ${blockId}`);
						}
						transforms.push({
							trxId: trxRev.trxId,
							rev: trxRev.rev,
							transform
						});
					}
					missedCommits.push({ blockId, transforms });	// Push, even if transforms is empty, because we want to reject the older version
				}
			}

			if (missedCommits.length) {
				return { // Return directly, locks will be released in finally
					success: false,
					missing: perBlockTrxTransformsToPerTransaction(missedCommits)
				};
			}

			// Check for missing pending transactions
			const missingPends: { blockId: BlockId, trxId: TrxId }[] = [];
			for (const { blockId, storage } of blockStorages) {
				const pendingTrx = await storage.getPendingTransaction(request.trxId);
				if (!pendingTrx) {
					missingPends.push({ blockId, trxId: request.trxId });
				}
			}

			if (missingPends.length) {
				throw new Error(`Pending transaction ${request.trxId} not found for block(s): ${missingPends.map(p => p.blockId).join(', ')}`);
			}

			// Commit the transaction for each block
			// This loop will execute atomically for all blocks due to the acquired locks
			for (const { blockId, storage } of blockStorages) {
				try {
					// internalCommit will throw if it encounters an issue
					await this.internalCommit(blockId, request.trxId, request.rev, storage);
				} catch (err) {
					// TODO: Recover as best we can. Rollback or handle partial commit? For now, return failure.
					return {
						success: false,
						reason: err instanceof Error ? err.message : 'Unknown error during commit'
					};
				}
			}
		}
		finally {
			// Release locks in reverse order of acquisition
			releases.reverse().forEach(release => release());
		}

		return { success: true };
	}

	private async internalCommit(blockId: BlockId, trxId: TrxId, rev: number, storage: IBlockStorage): Promise<void> {
		// Note: This method is called within the locked critical section of commit()
		// So, operations like getPendingTransaction, getLatest, getBlock, saveMaterializedBlock,
		// saveRevision, promotePendingTransaction, setLatest are protected against
		// concurrent commits for the *same blockId*.

		const transform = await storage.getPendingTransaction(trxId);
		// No need to check if !transform here, as the caller (commit) already verified this.
		// If it's null here, it indicates a logic error or race condition bypassed the lock (unlikely).
		if (!transform) {
			throw new Error(`Consistency Error: Pending transaction ${trxId} disappeared for block ${blockId} within critical section.`);
		}

		// Get prior materialized block if it exists
		const latest = await storage.getLatest();
		const priorBlock = latest
			? (await storage.getBlock(latest.rev)).block
			: undefined;

		// Apply transform and save materialized block
		const newBlock = priorBlock
			? applyTransform(priorBlock, transform)
			: undefined;
		if (newBlock) {
			await storage.saveMaterializedBlock(trxId, newBlock);
		}

		// Save revision and promote transaction *before* updating latest
		// This ensures that if the process crashes between these steps,
		// the 'latest' pointer doesn't point to a revision that hasn't been fully recorded.
		await storage.saveRevision(rev, trxId);
		await storage.promotePendingTransaction(trxId);

		// Update latest revision *last*
		await storage.setLatest({ trxId, rev });
	}
}

/** Converts list of missing transactions per block into a list of missing transactions across blocks. */
function perBlockTrxTransformsToPerTransaction(missing: { blockId: BlockId; transforms: TrxTransform[]; }[]) {
	const missingFlat = missing.flatMap(({ blockId, transforms }) =>
		transforms.map(transform => ({ blockId, transform }))
	);
	const missingByTrxId = groupBy(missingFlat, ({ transform }) => transform.trxId);
	return Object.entries(missingByTrxId).map(([trxId, items]) =>
		items.reduce((acc, { blockId, transform }) => {
			concatTransform(acc.transforms, blockId, transform.transform);
			return acc;
		}, {
			trxId: trxId as TrxId,
			rev: items[0]!.transform.rev,	// Assumption: all missing trxIds share the same revision
			transforms: emptyTransforms()
		})
	);
}
