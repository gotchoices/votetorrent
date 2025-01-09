import { IRepo, MessageOptions, applyOperation, BlockGet, BlockId, blockIdsForTransform, CommitRequest, CommitResult, GetBlockResult, IBlock, PendRequest, PendResult, Transform, TrxBlocks, TrxId, transformForBlockId, BlockTrxState, TrxRev, TrxContext, BlockGets, TrxTransform, applyOperations, TrxPending } from "../../../db-core/src/index.js";
import { recordEmpty } from "../helpers.js";
import { asyncIteratorToArray, first } from "../it-utility.js";
import { BlockMetadata, BlockArchive, IBlockStorage, RestoreCallback, RevisionRange, ArchiveRevisions } from "./struct.js";

type BlockWithTrxRev = {
	block?: IBlock;
	trxRev: TrxRev;
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

	async get({ blockIds, context }: BlockGets, options?: MessageOptions): Promise<GetBlockResult[]> {
		return Promise.all(blockIds.map(async (blockId) => {
			let status = await this.getStatus(blockId);
			if (!status) {	// Restore block if not present
				const restored = await this.restoreBlock(blockId, context?.rev);
				if (!restored) {
					throw new Error(`Block ${blockId}${context ? ` revision ${context.rev}` : ''} not found`);
				}
				status = await this.getStatus(blockId);
			}

			// Ensure that all outstanding transactions in the context are committed
			if (context) {
				const missing = status!.state.latest
					? context.committed.filter(c => c.rev > status!.state.latest!.rev)
					: context.committed;
				for (const { trxId } of missing.toSorted((a, b) => a.rev - b.rev)) {
					const pending = await this.storage.getPendingTransaction(blockId, trxId);
					if (pending) {
						await this.internalCommit(blockId, trxId, status!.meta);
						status = await this.getStatus(blockId);
					}
				}
			}

			const blockRev = await this.getOrRestore(status!.meta, blockId, context?.rev);

			// Include pending transaction if requested
			if (context?.trxId !== undefined) {
				const fromPending = await this.storage.getPendingTransaction(blockId, context.trxId);
				if (!fromPending) {
					throw new Error(`Pending transaction ${context.trxId} not found`);
				}
				const block = applyTransform(blockRev.block, fromPending.transform);
				return { block, state: status!.state };
			}

			return { block: blockRev.block, state: status!.state };
		}));
	}

	async pend(request: PendRequest, options?: MessageOptions): Promise<PendResult> {
		const blockIds = blockIdsForTransform(request.transform);
		const pendings: TrxPending[] = [];

		// First handle any pending transactions
		for (const blockId of blockIds) {
			// Check existing pending transactions
			const pending = await asyncIteratorToArray(this.storage.listPendingTransactions(blockId));
			if (pending.length > 0) {
				if (request.pending === 'f') {
					return { success: false, pending: pending.map(trxId => ({ blockId, trxId })) };
				} else if (request.pending === 'r') {
					return { success: false, pending: await Promise.all(pending.map(async trxId => ({
						blockId,
						trxId,
						transform: (await this.storage.getPendingTransaction(blockId, trxId))?.transform
					}))) };
				} else {
					pendings.push(...pending.map(trxId => ({ blockId, trxId } as TrxPending)));
				}
			}
		}

		// Save pending transaction for each block
		for (const blockId of blockIds) {
			// For new blocks, create metadata
			if (request.transform.inserts[blockId]) {
				if (!await this.storage.getMetadata(blockId)) {
					await this.storage.saveMetadata(blockId, { latest: undefined, ranges: [[0] as RevisionRange] });
				}
			} else {
				// Save block-specific portion of transform
				const blockTransform = transformForBlockId(request.transform, blockId);
				await this.storage.savePendingTransaction(blockId, request.trxId, blockTransform);
			}
		}

		return {
			success: true,
			pending: pendings,
			trxRef: { blockIds, trxId: request.trxId }
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

			if (meta.latestRev > request.rev) {
				const trxRevs = await this.storage.listRevisionRange(blockId, request.rev + 1, meta.latestRev);
				return {
					success: false,
					missing: trxRevs.map(async ({ trxId, rev }) => ({
						trxId,
						rev,
						transform: (await this.getOrRestore(blockId, rev))?.
					}))
				};
			}

			// Check if we missed any revisions
			if (meta.latestRev !== request.expectedRev) {
				// TODO: Implement recovery of missing revisions from peers
				throw new Error(`Missing revisions for block ${blockId}. Expected rev ${request.expectedRev} but found ${meta.latestRev}`);
			}

			try {
				// Read the pending transform
				await this.internalCommit(blockId, request.trxId, meta);

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

	private async internalCommit(blockId: string, trxId: TrxId, meta: BlockMetadata) {
		const pendingTrx = await this.storage.getPendingTransaction(blockId, trxId);
		if (!pendingTrx) {
			throw new Error(`Pending transaction ${trxId} not found for block ${blockId}`);
		}

		// Get the prior latest block so we can keep the latest block materialized
		const block = meta.latest ? await this.getOrRestore(meta, blockId, meta.latest.rev) : undefined;

		// Update metadata
		const newRev = (meta.latest?.rev ?? 0) + 1;
		meta.latest = { trxId, rev: newRev };
		await this.storage.saveMetadata(blockId, meta);

		// Apply transformations
		if (block?.block && Object.hasOwn(pendingTrx.transform.updates, blockId)) {
			applyOperations(block.block, pendingTrx.transform.updates[blockId]);
			await this.storage.saveMaterializedBlock(blockId, trxId, block.block);
		} else if (Object.hasOwn(pendingTrx.transform.inserts, blockId)) {
			await this.storage.saveMaterializedBlock(blockId, trxId, pendingTrx.transform.inserts[blockId]);
		} else if (pendingTrx.transform.deletes.has(blockId)) {
			await this.storage.saveMaterializedBlock(blockId, trxId, undefined);
		}

		// Save revision and promote the pending transaction
		await this.storage.saveRevision(blockId, newRev, trxId);
		await this.storage.promotePendingTransaction(blockId, trxId);
	}

	/** Attempts to restore the given block revision, or the latest if rev is undefined.
	 * If the block is not present, also restores the latest.
	 * @returns The restored block archive that contains the requested revision (or latest), or undefined if no restore callback is provided
	 */
	private async restoreBlock(blockId: string, rev?: number): Promise<BlockArchive | undefined> {
		if (!this.restoreCallback) {
			return undefined;
		}
		const restored = await this.restoreCallback(blockId, rev);
		if (restored) {
			let meta = await this.storage.getMetadata(blockId);
			if (!meta) {	// No repository - make one
				// If the restored range is open-ended, restore the latest
				let latestRestored: BlockArchive;
				if (restored.range[1]) {
					latestRestored = (await this.restoreCallback(blockId))!;
					await this.saveRestored(blockId, latestRestored);
				} else {
					latestRestored = restored;
				}
				if (recordEmpty(latestRestored.revisions)) {	// No revisions at all
					meta = { ranges: [latestRestored.range], latest: undefined };
				} else {
					const [revMax, { trx: { trxId } }] = maxRev(latestRestored.revisions);
					meta = { ranges: [latestRestored.range], latest: { trxId, rev: revMax } as TrxRev};
				}
			} else {
				// Add the explicit range from restoration
				meta.ranges.unshift(restored.range);
				// Sort and merge overlapping ranges
				meta.ranges = mergeRanges(meta.ranges);
				// Update latest if necessary - this should never happen but in the event that a restored block has a newer revision than our latest, use it
				if (!recordEmpty(restored.revisions)) {
					const [revMax, { trx: { trxId } }] = maxRev(restored.revisions);
					meta.latest = meta.latest && meta.latest.rev > revMax
						? meta.latest : { trxId, rev: revMax };
				}
			}
			await this.storage.saveMetadata(blockId, meta);

			// Convert revisions to array
			await this.saveRestored(blockId, restored);
			return restored;
		}
	}

	private async saveRestored(blockId: string, restored: BlockArchive) {
		const revisions = Object.entries(restored.revisions)
			.map(([rev, data]) => ({ rev: Number(rev), data }));

		// Save all revisions, transactions, and materializations
		for (const { rev, data: { trx, block } } of revisions) {
			await Promise.all([
				this.storage.saveRevision(blockId, rev, trx.trxId),
				this.storage.saveTransaction(blockId, trx.trxId, trx),
				block ? this.storage.saveMaterializedBlock(blockId, trx.trxId, block) : Promise.resolve()
			]);
		}
	}

	private async getOrRestore(meta: BlockMetadata, blockId: BlockId, rev?: number): Promise<BlockWithTrxRev> {
		// Is the rev in a present range?
		if (rev !== undefined && !inRanges(rev, meta.ranges)) {
			const restored = await this.restoreBlock(blockId, rev);
			if (!restored) {
				throw new Error(`Block ${blockId} revision ${rev} not found`);
			}
			this.saveRestored(blockId, restored);
		}
		const targetRev = rev ?? meta.latest?.rev ?? 0;
		return await this.materializeBlock(blockId, targetRev);
	}

	private async getStatus(blockId: string): Promise<{ state: BlockTrxState, meta: BlockMetadata } | undefined> {
		const meta = await this.storage.getMetadata(blockId);
		if (!meta) {
			return undefined;
		}

		const pendings = await asyncIteratorToArray(this.storage.listPendingTransactions(blockId));
		return { state: { latest: meta.latest, pendings }, meta };
	}

	private async materializeBlock(blockId: string, targetRev: number): Promise<BlockWithTrxRev> {
		let block: IBlock | undefined;
		let materializedTrxRev: TrxRev | undefined;
		const transactions: TrxRev[] = [];

		// Find the materialized block
		for await (const trxRev of this.storage.listRevisions(blockId, targetRev, 1)) {
			const materializedBlock = await this.storage.getMaterializedBlock(blockId, trxRev.trxId);
			if (materializedBlock) {
				block = materializedBlock;
				materializedTrxRev = trxRev;
				break;
			} else {
				transactions.push(trxRev);
			}
		}

		if (!block || !materializedTrxRev) {
			throw new Error(`Failed to find materialized block ${blockId} for revision ${targetRev}`);
		}

		// Apply transforms in reverse order
		for (let i = transactions.length - 1; i >= 0; --i) {
			const { trxId } = transactions[i];
			const trx = await this.storage.getTransaction(blockId, trxId);
			if (!trx) {
				throw new Error(`Missing transaction ${trxId} for block ${blockId}`);
			}
			block = applyTransform(block, trx.transform);
		}

		if (transactions.length) {	// Save materialization closest to targetRev and return it
			await this.storage.saveMaterializedBlock(blockId, transactions[0].trxId, block!);
			return { block, trxRev: transactions[0] };
		}
		// Found materialization is closest to targetRev
		return { block, trxRev: materializedTrxRev };
	}
}

/** Applies a transform to the given block, or if no block is passed, will take the first inserted block in the transform if there is one */
function applyTransform(block: IBlock | undefined, transform: Transform): IBlock | undefined {
	if (Object.keys(transform.inserts).length) {
		block = Object.values(transform.inserts).at(0)!;
	}
	if (block && Object.hasOwn(transform.updates, block.header.id)) {
		applyOperations(block, transform.updates[block.header.id]);
	}
	if (block && transform.deletes.has(block.header.id)) {
		return undefined;
	}
	return block;
}

// Helper function to merge overlapping ranges
function mergeRanges(ranges: RevisionRange[]): RevisionRange[] {
	if (ranges.length <= 1) return ranges;

	ranges.sort((a, b) => a[0] - b[0]);
	const merged: RevisionRange[] = [ranges[0]];

	for (const range of ranges.slice(1)) {
		const last = merged[merged.length - 1];
		// If last range is open-ended, it consumes all following ranges
		if (last[1] === undefined) {
			continue;
		}
		// If this range starts at or before last range's end (exclusive)
		if (range[0] <= last[1]) {
			// If this range is open-ended, make last range open-ended
			if (range[1] === undefined) {
				last[1] = undefined;
			} else {
				last[1] = Math.max(last[1], range[1]);
			}
		} else {
			merged.push(range);
		}
	}

	return merged;
}

function maxRev<T>(revisions: Record<number, T>): readonly [number, T] {
	return Object.entries(revisions).map(([rev, data]) => [Number(rev), data] as const)
		.reduce((a, b) => (a[0] > b[0] ? a : b), [0, undefined] as [number, T]);
}

function inRanges(rev: number, ranges: RevisionRange[]): boolean {
	for (const range of ranges) {
		if (rev >= range[0] && (range[1] === undefined || rev < range[1])) {
			return true;
		}
	}
	return false;
}

