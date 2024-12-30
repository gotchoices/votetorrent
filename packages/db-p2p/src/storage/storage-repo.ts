import { IRepo, MessageOptions, applyOperation, BlockGet, BlockId, blockIdsForTransform, BlockTrxContext, CommitRequest, CommitResult, GetBlockResult, IBlock, PendRequest, PendResult, Transform, TrxBlocks, TrxId, transformForBlockId, BlockTrxState, BlockTrxRev } from "../../../db-core/src/index.js";
import { BlockRestoration, IBlockStorage, RestoreCallback } from "./struct.js";

type BlockWithTrxRev = {
	block?: IBlock;
	trxRev: BlockTrxRev;
}

export class StorageRepo implements IRepo {
	private readonly restoreCallback?: RestoreCallback;

	constructor(
		private readonly storage: IBlockStorage,
		options?: {
			restoreCallback?: RestoreCallback;
		}
	) {
		this.restoreCallback = options?.restoreCallback;
	}

	async get(blockGets: BlockGet[], options?: MessageOptions): Promise<GetBlockResult[]> {
		return Promise.all(blockGets.map(async get => {
			let result: GetBlockResult;

			if (!get.context) { // Get latest
				result = await this.getLatestBlock(get.blockId);
			} else {
				const blockForTrx = await this.storage.getMaterializedBlock(get.blockId, get.context.trxId);
				if (blockForTrx) {
					// Already materialized
					result = { block: blockForTrx, state: await this.getLatestState(get.blockId, get.context) };
				} else if (get.context.rev !== undefined) {
					// Possible we don't know about the commit, check in pending
					const pending = await this.storage.getPendingTransaction(get.blockId, get.context.trxId);
					if (pending) {
						const commitResult = await this.commit({ blockIds: [get.blockId], trxId: get.context.trxId, expectedRev: get.context.rev });
						if (!commitResult.success) {
							throw new Error(`Inconsistent commit. Transaction ${get.context.trxId} for block ${get.blockId} expected rev ${get.context.rev} but commits ahead: ${commitResult.missing.map(m => m.trxId).join(', ')}`);
						}
					}
					// Get specific revision
					const blockRev = await this.getOrMaterialize(get.blockId, get.context.rev);
					result = { block: blockRev.block, state: await this.getLatestState(get.blockId, get.context) };
				} else {
					// Get pending transaction
					result = await this.getLatestWithPending(get.blockId, get.context.trxId);
				}
			}

			return result;
		}));
	}

	async pend(request: PendRequest, options?: MessageOptions): Promise<PendResult> {
		const blockIds = blockIdsForTransform(request.transform);

		for (const blockId of blockIds) {
			// For new blocks, create metadata
			if (request.transform.inserts[blockId]) {
				await this.storage.saveMetadata(blockId, { latestRev: 0 });
			}

			// Check existing pending transactions
			const pending = await this.storage.getAllPendingTransactions(blockId);
			if (request.pending === 'fail' && pending.size > 0) {
				return {
					success: false,
					missing: Array.from(pending.values())
				};
			}

			// Save block-specific transform
			const blockTransform = transformForBlockId(request.transform, blockId);
			await this.storage.savePendingTransaction(blockId, request.trxId, blockTransform);
		}

		return {
			success: true,
			pending: [], // TODO: Return actual pending transactions
			trxRef: {
				blockIds,
				trxId: request.trxId
			}
		};
	}

	async cancel(trxRef: TrxBlocks, options?: MessageOptions): Promise<void> {
		await Promise.all(trxRef.blockIds.map(blockId =>
			this.storage.deletePendingTransaction(blockId, trxRef.trxId)
		));
	}

	async commit(request: CommitRequest, options?: MessageOptions): Promise<CommitResult> {
		for (const blockId of request.blockIds) {
			const meta = await this.storage.getMetadata(blockId);
			if (!meta) {
				throw new Error(`Block ${blockId} not found`);
			}

			// Check if we missed any revisions
			if (meta.latestRev !== request.expectedRev) {
				// TODO: Implement recovery of missing revisions from peers
				throw new Error(`Missing revisions for block ${blockId}. Expected rev ${request.expectedRev} but found ${meta.latestRev}`);
			}

			try {
				// Read the pending transform
				const pendingTrx = await this.storage.getPendingTransaction(blockId, request.trxId);
				if (!pendingTrx) {
					throw new Error(`Pending transaction ${request.trxId} not found for block ${blockId}`);
				}

				// Update metadata
				meta.latestRev++;
				if (pendingTrx.transform.deletes.has(blockId)) {
					meta.deleted = { trxId: request.trxId, rev: meta.latestRev };
				}
				await this.storage.saveMetadata(blockId, meta);

				// Save revision and promote the pending transaction
				await this.storage.saveRevision(blockId, meta.latestRev, request.trxId);
				await this.storage.promotePendingTransaction(blockId, request.trxId);

			} catch (err) {
				return {
					success: false,
					missing: [] // TODO: Return actual missing transactions
				};
			}
		}

		return {
			success: true
		};
	}

	private async restoreBlock(blockId: string, rev?: number): Promise<BlockRestoration | undefined> {
		if (!this.restoreCallback) {
			return undefined;
		}
		const restored = await this.restoreCallback(blockId, rev);
		if (restored) {
			// Process revisions in order to ensure proper materialization chain
			const revisions = Object.entries(restored.revisions)
				.map(([rev, data]) => ({ rev: Number(rev), data }))
				.sort((a, b) => a.rev - b.rev);

			// Ensure the oldest revision has a materialization
			if (!revisions[0].data.block) {
				throw new Error(`Restored block ${blockId} missing materialization for oldest revision ${revisions[0].rev}`);
			}

			// Save all revisions, transactions, and materializations
			for (const { rev, data } of revisions) {
				await Promise.all([
					this.storage.saveRevision(blockId, rev, data.trx.trxId),
					this.storage.saveTransaction(blockId, data.trx.trxId, data.trx),
					data.block ? this.storage.saveMaterializedBlock(blockId, data.trx.trxId, data.block) : Promise.resolve()
				]);
			}
			return restored;
		}
	}

	private async getLatestBlock(blockId: BlockId): Promise<GetBlockResult> {
		const state = await this.getLatestState(blockId, undefined);
		if (state.deleted) {
			return { block: undefined, state };
		}
		const blockRev = await this.getOrMaterialize(blockId, state.latest!.rev);
		return { block: blockRev.block, state };
	}

	private async getLatestWithPending(blockId: BlockId, trxId: TrxId): Promise<GetBlockResult> {
		const result = await this.getLatestBlock(blockId);
		if (result.state.deleted) {
			throw new Error(`Block ${blockId} deleted`);
		}

		const fromPending = await this.storage.getPendingTransaction(blockId, trxId);
		if (!fromPending) {
			throw new Error(`Pending transaction ${trxId} not found`);
		}

		const block = applyTransform(result.block, fromPending.transform);
		return { block, state: { ...result.state, pendingTrxId: trxId } };
	}

	private async getOrRestore(blockId: BlockId, rev: number): Promise<BlockWithTrxRev | undefined> {
		const trxId = await this.storage.getRevision(blockId, rev);
		if (!trxId) {
			const restored = await this.restoreBlock(blockId, rev);
			if (!restored) {
				throw new Error(`Block ${blockId} revision ${rev} not found`);
			}
			const restoredRev = Object.entries(restored.revisions)
				.map(([r, data]) => ({ rev: Number(r), data }))
				.filter(r => r.rev <= rev)
				.sort((a, b) => b.rev - a.rev)[0];

			if (restoredRev?.data.block) {
				return {
					block: restoredRev.data.block,
					trxRev: { trxId: restoredRev.data.trx.trxId, rev: restoredRev.rev }
				};
			}
			return undefined;
		}

		const block = await this.storage.getMaterializedBlock(blockId, trxId);
		return block ? { block, trxRev: { trxId, rev } } : undefined;
	}

	private async getOrMaterialize(blockId: BlockId, rev: number): Promise<BlockWithTrxRev> {
		const result = await this.getOrRestore(blockId, rev);
		if (!result) {
			return await this.materializeBlock(blockId, rev);
		}
		return result;
	}

	private async getLatestState(blockId: string, context: BlockTrxContext | undefined): Promise<BlockTrxState> {
		const meta = await this.storage.getMetadata(blockId);
		if (!meta) {
			throw new Error(`Block ${blockId} not found`);
		}

		const trxId = await this.storage.getRevision(blockId, meta.latestRev);
		if (!trxId) {
			throw new Error(`Missing revision entry (${meta.latestRev}) for block ${blockId}`);
		}

		return {
			...(meta.deleted ? { deleted: meta.deleted } : { latest: { trxId, rev: meta.latestRev } }),
			...(context && context.rev === undefined ? { pendingTrxId: context.trxId } : {})
		};
	}

	private async materializeBlock(blockId: string, targetRev: number): Promise<BlockWithTrxRev> {
		// Find all available revisions up to target
		const meta = await this.storage.getMetadata(blockId);
		if (!meta) {
			throw new Error(`Block ${blockId} not found`);
		}

		let currentRev = 1;
		let block: IBlock | undefined;
		let latestTrxId: TrxId | undefined;

		while (currentRev <= targetRev) {
			const trxId = await this.storage.getRevision(blockId, currentRev);
			if (!trxId) {
				throw new Error(`Missing revision ${currentRev} for block ${blockId}`);
			}

			// Try to get materialized block first
			const materializedBlock = await this.storage.getMaterializedBlock(blockId, trxId);
			if (materializedBlock) {
				block = materializedBlock;
			} else {
				// Apply transform
				const trx = await this.storage.getTransaction(blockId, trxId);
				if (!trx) {
					throw new Error(`Missing transaction ${trxId} for block ${blockId}`);
				}
				block = applyTransform(block, trx.transform);
			}

			latestTrxId = trxId;
			currentRev++;
		}

		if (!block || !latestTrxId) {
			throw new Error(`Failed to materialize block ${blockId} at revision ${targetRev}`);
		}

		// Save the final materialization
		await this.storage.saveMaterializedBlock(blockId, latestTrxId, block);
		return { block, trxRev: { trxId: latestTrxId, rev: targetRev } };
	}
}

function applyTransform(block: IBlock | undefined, transform: Transform): IBlock | undefined {
	if (Object.keys(transform.inserts).length) {
		block = Object.values(transform.inserts).at(0)!;
	}
	if (block) {
		for (const operations of Object.values(transform.updates)) {
			for (const op of operations) {
				applyOperation(block, op);
			}
		}
	}
	if (transform.deletes.size) {
		return undefined;
	}
	return block;
}
