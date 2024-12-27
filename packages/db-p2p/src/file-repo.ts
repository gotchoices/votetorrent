import { IRepo, MessageOptions, applyOperation, BlockGet, BlockId, blockIdsForTransform, BlockTrxContext, CommitRequest, CommitResult, GetBlockResult, IBlock, PendRequest, PendResult, Transform, TrxBlocks, TrxId, TrxTransform, transformForBlockId, BlockTrxState, BlockTrxRev } from "../../db-core/src/index.js";
import * as fs from 'fs/promises';
import * as path from 'path';

type BlockMetadata = {
	latestRev: number;
	deleted?: BlockTrxRev;
};

type BlockRepo = {
	blockId: BlockId;
	pending: Record<TrxId, TrxTransform>;
	revisions: Record<number, { trx: TrxTransform, block?: IBlock }>;
}

type BlockWithTrxRev = {
	block?: IBlock;
	trxRev: BlockTrxRev;
}

/** Should return a BlockRepo with the given rev (materialized) if given,
 * else (no rev) at least the latest revision and any given pending transactions */
type RestoreCallback = (blockId: BlockId, rev?: number) => Promise<BlockRepo | undefined>;

export class FileRepo implements IRepo {
	private readonly restoreCallback?: RestoreCallback;

	constructor(
		private readonly path: string,
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
				const blockForTrx = await this.getBlock(get.blockId, get.context.trxId);
				if (blockForTrx) {
					// Already materialized
					result = { block: blockForTrx, state: await this.getLatestState(get.blockId, get.context) };
				} else if (get.context.rev !== undefined) {
					// Possible we don't know about the commit, check in pending
					const pending = await this.getPendingTrx(get.blockId, get.context.trxId);
					if (pending) {
						const commitResult = await this.commit({ blockIds: [get.blockId], trxId: get.context.trxId, expectedRev: get.context.rev });
						if (!commitResult.success) {
							throw new Error(`Inconsistent commit.  Transaction ${get.context.trxId} for block ${get.blockId} expected rev ${get.context.rev} but commits ahead: ${commitResult.missing.map(m => m.trxId).join(', ')}`);
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
			const pendingPath = this.getPendingPath(blockId);
			await fs.mkdir(pendingPath, { recursive: true });

			// For new blocks, create the block folder
			if (request.transform.inserts[blockId]) {
				await this.ensureAndWriteFile(
					path.join(this.path, blockId, 'meta.json'),
					JSON.stringify({ latestRev: 0 })
				);
			}

			// Check existing pending transactions
			const pending = await this.getPendingTransactions(blockId);
			if (request.pending === 'fail' && pending.size > 0) {
				return {
					success: false,
					missing: Array.from(pending.values())
				};
			}

			// Save block-specific transform
			const blockTransform = transformForBlockId(request.transform, blockId);
			await this.ensureAndWriteFile(
				path.join(pendingPath, `${request.trxId}.json`),
				JSON.stringify({
					trxId: request.trxId,
					transform: blockTransform
				})
			);
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
		for (const blockId of trxRef.blockIds) {
			const pendingPath = path.join(this.getPendingPath(blockId), `${trxRef.trxId}.json`);
			try {
				await fs.unlink(pendingPath);
			} catch (err) {
				// Ignore if file doesn't exist
			}
		}
	}

	async commit(request: CommitRequest, options?: MessageOptions): Promise<CommitResult> {
		for (const blockId of request.blockIds) {
			const meta = await this.getBlockMetadata(blockId);

			// Check if we missed any revisions
			if (meta.latestRev !== request.expectedRev) {
				// TODO: Implement recovery of missing revisions from peers
				throw new Error(`Missing revisions for block ${blockId}. Expected rev ${request.expectedRev} but found ${meta.latestRev}`);
			}

			const pendingPath = path.join(this.getPendingPath(blockId), `${request.trxId}.json`);

			try {
				// Read the pending transform
				const pendingContent = await fs.readFile(pendingPath, 'utf-8');
				const pendingTrx = JSON.parse(pendingContent) as TrxTransform;

				// Update metadata
				meta.latestRev++;
				if (pendingTrx.transform.deletes.has(blockId)) { // If this is a delete transform, mark the block as deleted
					meta.deleted = { trxId: request.trxId, rev: meta.latestRev };
				}
				await this.saveBlockMetadata(blockId, meta);

				// Move from pending to committed
				await fs.mkdir(path.join(this.path, blockId, 'trx'), { recursive: true });
				await fs.rename(pendingPath, path.join(this.path, blockId, 'trx', `${request.trxId}.json`));

				await this.saveBlockRevision(blockId, meta.latestRev, request.trxId);
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

	private async restoreBlock(blockId: string, rev?: number): Promise<BlockRepo | undefined> {
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
					this.saveBlockRevision(blockId, rev, data.trx.trxId),
					this.saveBlockTrx(blockId, data.trx.trxId, data.trx),
					data.block ? this.saveBlockMaterialization(blockId, data.trx.trxId, data.block) : Promise.resolve()
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

		const fromPending = await this.getPendingTrx(blockId, trxId);
		if (!fromPending) {
			throw new Error(`Pending transaction ${trxId} not found`);
		}

		const block = applyTransform(result.block, fromPending.transform);
		return { block, state: { ...result.state, pendingTrxId: trxId } };
	}

	private async getOrRestore(blockId: BlockId, rev: number): Promise<BlockWithTrxRev | undefined> {
		const trxId = await this.getBlockTrxId(blockId, rev);
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

		let block = await this.getBlock(blockId, trxId);
		return block ? { block, trxRev: { trxId, rev } } : undefined;
	}

	private async getOrMaterialize(blockId: BlockId, rev: number): Promise<BlockWithTrxRev> {
		const result = await this.getOrRestore(blockId, rev);
		if (!result) {
			return await this.materializeBlock(blockId, rev);
		}
		return result;
	}

	private async getBlock(blockId: string, trxId: TrxId): Promise<IBlock | undefined> {
		const blockPath = path.join(this.path, blockId, 'block', `${trxId}.json`);
		return this.readIfExists<IBlock>(blockPath);
	}

	private async getBlockTrxId(blockId: string, rev: number): Promise<TrxId | undefined> {
		const blockPath = path.join(this.path, blockId, 'revs', `${rev}.json`);
		return this.readIfExists<TrxId>(blockPath);
	}

	private async getPendingTrx(blockId: string, trxId: TrxId): Promise<TrxTransform | undefined> {
		const pendingFile = path.join(this.path, blockId, 'pend', `${trxId}.json`);
		return this.readIfExists<TrxTransform>(pendingFile);
	}

	private async getTrx(blockId: string, trxId: TrxId): Promise<TrxTransform | undefined> {
		const trxFile = path.join(this.path, blockId, 'trx', `${trxId}.json`);
		return this.readIfExists<TrxTransform>(trxFile);
	}

	private async getBlockMetadata(blockId: string): Promise<BlockMetadata> {
		const blockPath = path.join(this.path, blockId);
		try {
			const metaFile = await fs.readFile(path.join(blockPath, 'meta.json'), 'utf-8');
			return JSON.parse(metaFile);
		} catch (err) {
			if (this.restoreCallback) {
				// TODO: need to make this concurrent, so that multiple instances can share a file system
				const rev = await this.restoreBlock(blockId);
				const latestRev = rev ? Object.keys(rev.revisions).map(Number).reduce((a, b) => Math.max(a, b)) : 0;
				await this.saveBlockMetadata(blockId, { latestRev });
			}
			return { latestRev: 0 };
		}
	}

	private async readIfExists<T>(filePath: string): Promise<T | undefined> {
		return fs.readFile(filePath, 'utf-8')
			.then(content => JSON.parse(content) as T)
			.catch(err => {
				if (err.code === 'ENOENT') return undefined;
				throw err;
			});
	}

	private async saveBlockMetadata(blockId: string, meta: BlockMetadata): Promise<void> {
		const blockPath = path.join(this.path, blockId);
		await fs.mkdir(blockPath, { recursive: true });
		await fs.writeFile(path.join(blockPath, 'meta.json'), JSON.stringify(meta));
	}

	private async saveBlockRevision(blockId: string, rev: number, trxId: TrxId): Promise<void> {
		const blockPath = path.join(this.path, blockId, 'revs');
		await fs.mkdir(blockPath, { recursive: true });
		await fs.writeFile(
			path.join(blockPath, `${rev}.json`),
			trxId
		);
	}

	private async saveBlockTrx(blockId: string, trxId: TrxId, trx: TrxTransform): Promise<void> {
		const blockPath = path.join(this.path, blockId, 'trx');
		await fs.mkdir(blockPath, { recursive: true });
		await fs.writeFile(
			path.join(blockPath, `${trxId}.json`),
			JSON.stringify(trx)
		);
	}

	private async saveBlockMaterialization(blockId: string, trxId: TrxId, block: any): Promise<void> {
		const blockPath = path.join(this.path, blockId, 'blocks');
		await fs.mkdir(blockPath, { recursive: true });
		await fs.writeFile(
			path.join(blockPath, `${trxId}.json`),
			JSON.stringify(block)
		);
	}

	private getPendingPath(blockId: string): string {
		return path.join(this.path, blockId, 'pend');
	}

	private async getLatestState(blockId: string, context: BlockTrxContext | undefined): Promise<BlockTrxState> {
		const { latestRev, deleted } = await this.getBlockMetadata(blockId);
		const trxId = await this.getBlockTrxId(blockId, latestRev);
		if (!trxId) {
			throw new Error(`Missing revision entry (${latestRev}) for block ${blockId}`);
		}
		return {
			...(deleted ? { deleted } : { latest: { trxId, rev: latestRev } }),
			...(context && context.rev === undefined ? { pendingTrxId: context.trxId } : {})
		};
	}

	private async getPendingTransactions(blockId: string): Promise<Map<TrxId, TrxTransform>> {
		const pendingPath = this.getPendingPath(blockId);
		const pending = new Map<TrxId, TrxTransform>();

		try {
			const files = await fs.readdir(pendingPath);
			for (const file of files) {
				if (file.endsWith('.json')) {
					const rawTrxId = file.slice(0, -5); // Remove .json
					// Validate that this is a proper TrxId before using
					if (/^[\w\d]+-[\w\d]+-[\w\d]+-[\w\d]+-[\w\d]+$/.test(rawTrxId)) {
						const trxId = rawTrxId as TrxId;
						const pendingTrx = await this.getPendingTrx(blockId, trxId);
						if (pendingTrx) {
							pending.set(trxId, pendingTrx);
						}
					}
				}
			}
		} catch (err) {
			// Directory doesn't exist yet, return empty map
		}

		return pending;
	}

	private async ensureAndWriteFile(filePath: string, content: string): Promise<void> {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content);
	}

	private async materializeBlock(blockId: string, targetRev: number): Promise<BlockWithTrxRev> {
		// Find all available revisions up to target - note that revisions is sparse and may not include targetRev
		const revisions = await fs.readdir(path.join(this.path, blockId, 'revs'))
			.then(files => files
				.map(rev => parseInt(rev.slice(0, -5)))
				.filter(rev => !isNaN(rev) && rev <= targetRev)
				.sort((a, b) => b - a) // Sort descending to find the newest materialization
			)
			.catch(() => [] as number[]);

		if (revisions.length === 0) {
			throw new Error(`No revisions found for block ${blockId}`);
		}

		// Find the newest materialized revision
		const materialized = await this.latestMaterialized(blockId, revisions);

		// If the latest revision is materialized, return it
		if (materialized.trxRev.rev === revisions.at(-1)!) {
			return materialized;
		}

		// Apply all transforms from materialized to latest
		let block = materialized.block as IBlock | undefined;
		const revsToApply = revisions.filter(rev => rev > materialized.trxRev.rev!);
		for (let i = 0; i < revsToApply.length; ++i) {
			const rev = revsToApply[i];

			const trxId = await this.getBlockTrxId(blockId, rev);
			if (!trxId) {
				throw new Error(`Missing revision entry (${rev}) for block ${blockId}`);
			}

			const trx = await this.getTrx(blockId, trxId);
			if (!trx) {
				throw new Error(`Missing transaction ${trxId} for block ${blockId}`);
			}

			block = applyTransform(block, trx.transform);

			// TODO: Add a tuning option to save intermediate materializations
			// await this.saveBlockMaterialization(blockId, trxId, block);

			// If at the last revision, return the block
			if (i === revsToApply.length - 1) {
				// Save the final materialization
				await this.saveBlockMaterialization(blockId, trxId, block);
				return { block, trxRev: { trxId, rev } };
			}
		}

		throw new Error(`Failed to materialize block ${blockId} at revision ${targetRev}`);
	}

	private async latestMaterialized(blockId: string, revisions: number[]): Promise<BlockWithTrxRev> {
		for (const rev of revisions) {
			const trxId = await this.getBlockTrxId(blockId, rev);
			if (!trxId) {
				throw new Error(`Missing revision entry (${rev}) for block ${blockId}`);
			}

			const block = await this.getBlock(blockId, trxId);
			if (block) {
				return { block, trxRev: { trxId, rev } };
			}
		}
		throw new Error(`No materialized revision found for block ${blockId}`);
	}
}

function applyTransform(block: IBlock | undefined, transform: Transform) : IBlock | undefined {
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

