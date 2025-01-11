import { IRepo, MessageOptions, BlockId, blockIdsForTransform, CommitRequest, CommitResult, GetBlockResults, IBlock, PendRequest, PendResult, TrxBlocks, TrxId, transformForBlockId, BlockTrxState, TrxRev, BlockGets, TrxPending, Transform, applyTransform, PendSuccess, TrxTransform, groupBy, concatTransform, emptyTransforms } from "../../../db-core/src/index.js";
import { asyncIteratorToArray } from "../it-utility.js";
import { IBlockStorage } from "./i-block-storage.js";

export class StorageRepo implements IRepo {
	constructor(
		private readonly createBlockStorage: (blockId: BlockId) => IBlockStorage
	) {}

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
		const blockIds = blockIdsForTransform(request.transforms);
		const pendings: TrxPending[] = [];

		// First handle any pending transactions
		for (const blockId of blockIds) {
			const blockStorage = this.createBlockStorage(blockId);
			const pending = await asyncIteratorToArray(blockStorage.listPendingTransactions());
			if (pending.length > 0) {
				if (request.pending === 'f') {
					return { success: false, pending: pending.map(trxId => ({ blockId, trxId })) };
				} else if (request.pending === 'r') {
					return {
						success: false,
						pending: await Promise.all(pending.map(async trxId => ({
							blockId,
							trxId,
							transform: (await blockStorage.getPendingTransaction(trxId))!
						})))
					};
				} else {
					pendings.push(...pending.map(trxId => ({ blockId, trxId } as TrxPending)));
				}
			}
		}

		// Save pending transaction for each block
		for (const blockId of blockIds) {
			const blockStorage = this.createBlockStorage(blockId);
			const blockTransform = transformForBlockId(request.transforms, blockId);
			await blockStorage.savePendingTransaction(request.trxId, blockTransform);
		}

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
				missedCommits.push({ blockId, transforms });
			}
		}

		if (missedCommits.length) {
			return {
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
		for (const { blockId, storage } of blockStorages) {
			try {
				await this.internalCommit(blockId, request.trxId, request.rev, storage);
			} catch (err) {
				return {
					success: false,
					reason: err instanceof Error ? err.message : 'Unknown error'
				};
			}
		}

		return { success: true };
	}

	private async internalCommit(blockId: BlockId, trxId: TrxId, rev: number, storage: IBlockStorage): Promise<void> {
		const transform = await storage.getPendingTransaction(trxId);
		if (!transform) {
			throw new Error(`Pending transaction ${trxId} not found for block ${blockId}`);
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

		// Update latest revision
		await storage.setLatest({ trxId, rev });

		// Save revision and promote transaction
		await storage.saveRevision(rev, trxId);
		await storage.promotePendingTransaction(trxId);
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
			rev: items[0].transform.rev,	// Assumption: all missing trxIds share the same revision
			transforms: emptyTransforms()
		})
	);
}
