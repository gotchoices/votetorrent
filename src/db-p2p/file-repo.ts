import { applyOperation, BlockId, CommitRequest, CommitResult, GetBlockResult, IBlock, PendRequest, PendResult, Transform, TrxBlocks, TrxId, TrxTransform } from "../db-core/index.js";
import { BlockGet } from "../db-core/index.js";
import { IRepo, MessageOptions } from "../db-core/network/i-repo.js";
import * as fs from 'fs/promises';
import * as path from 'path';

type BlockMetadata = {
	latestRev: number;
	deleted?: boolean;
};

type BlockRepo = {
	blockId: BlockId;
	pending: Record<TrxId, TrxTransform>;
	revisions: Record<number, { trx: TrxTransform, block?: IBlock }>;
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

	private async restoreBlock(blockId: string, rev?: number): Promise<BlockRepo | undefined> {
		if (!this.restoreCallback) {
			return undefined;
		}
		const restored = await this.restoreCallback(blockId, rev);
		if (restored) {
			for (const [rev, { trx, block }] of Object.entries(restored.revisions)) {
				Promise.all([
					this.saveBlockRevision(blockId, Number(rev), trx.trxId),
					this.saveBlockTrx(blockId, trx.trxId, trx),
					block ? this.saveBlockMaterialization(blockId, trx.trxId, block) : Promise.resolve()
				]);
			}
			return restored;
		}
	}

	async get(blockGets: BlockGet[], options?: MessageOptions): Promise<GetBlockResult[]> {
		const results: GetBlockResult[] = [];
		for (const get of blockGets) {
			const blockForTrx = await this.getBlock(get.blockId, get.context.trxId);
			if (blockForTrx) {	// If already materialized, return it
				results.push({ block: blockForTrx, context: get.context });
			} else {
				if (typeof get.context.rev === 'number') { // must be positive infinity (get latest)
					const targetRev = Number.POSITIVE_INFINITY === get.context.rev
						? (await this.getBlockMetadata(get.blockId)).latestRev
						: get.context.rev;
					results.push(await this.getFromRev(get, targetRev));
				} else {
					const fromPending = await this.getPendingTrx(get.blockId, get.context.trxId);
					if (!fromPending) {
						throw new Error(`Pending transaction ${get.context.trxId} not found`);
					}
					const { latestRev, deleted } = await this.getBlockMetadata(get.blockId);
					if (deleted) {
						results.push({ block: undefined, context: get.context });
					} else {
						const result = await this.getFromRevOrMaterialize(get, latestRev);
						if (result.block) {
							applyTransform(result.block, fromPending.transform);
							results.push(result);
						} else {
							results.push({ block: undefined, context: get.context });
						}
					}
				}
			}
		}
		return results;
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
					meta.deleted = true;
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

	private async getFromRev(get: BlockGet, rev: number): Promise<IBlock | undefined> {
		const meta = await this.getBlockMetadata(get.blockId);
		if (meta.deleted) {
			throw new Error(`Block ${get.blockId} has been deleted`);
		}

		const trxId = await this.getBlockTrxId(get.blockId, rev);
		if (!trxId) {
			const restored = await this.restoreBlock(get.blockId, rev);
			if (restored) {
				const restoredBlock = restored.revisions[rev].block;
				if (!restoredBlock) { // should never happen, restoration should materialize the block if a rev given
					throw new Error(`Block ${get.blockId} revision ${rev} not materialized`);
				}
				return { block: restoredBlock, context: get.context };
			}
			throw new Error(`Block ${get.blockId} revision ${rev} not found`);
		}

		let block = await this.getBlock(get.blockId, trxId);
		return block;
	}

	private async getFromRevOrMaterialize(get: BlockGet, rev: number): Promise<GetBlockResult> {
		let block = await this.getFromRev(get, rev);
		if (!block) {
			block = await this.materializeBlock(get.blockId, rev);
		}

		return { block, context: get.context };
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

	private async materializeBlock(blockId: string, targetRev: number): Promise<IBlock> {
		// Find nearest materialized revision
		const revisions = await fs.readdir(path.join(this.path, blockId, 'revs'))
			.then(files => files
				.map(f => ({ rev: parseInt(f.slice(0, -5)), file: f }))	// Strip off extension
				.filter(f => !isNaN(f.rev) && f.rev <= targetRev)	// Skip future revisions.  TODO: allow rolling back from future revs
				.sort((a, b) => b.rev - a.rev) // Sort descending
			)
			.catch(() => [] as { rev: number, file: string }[]);

		// Find nearest materialized prior block
		let nearestBlock: IBlock | undefined;
		let nearestRev = 0;
		for (const { rev } of revisions) {
			const trxId = await this.getBlockTrxId(blockId, rev);
			if (!trxId) continue;
			nearestBlock = await this.getBlock(blockId, trxId);
			if (nearestBlock) {
				nearestRev = rev;
				break;
			}
		}

		if (!nearestBlock) {
			return this.getFromRevOrMaterialize({ blockId, context: { rev: targetRev } });
		}

		// Apply all transforms from nearest to target
		const block = { ...nearestBlock };
		for (let rev = nearestRev + 1; rev <= targetRev; ++rev) {
			const trxId = await this.getBlockTrxId(blockId, rev);
			if (!trxId) {
				throw new Error(`Missing revision ${rev} for block ${blockId}`);
			}
			const trx = await this.getTrx(blockId, trxId);
			if (!trx) {
				throw new Error(`Missing transaction ${trxId} for block ${blockId}`);
			}
			applyTransform(block, trx.transform);
		}

		// Save the materialized block
		const finalTrxId = await this.getBlockTrxId(blockId, targetRev);
		if (finalTrxId) {
			await this.saveBlockMaterialization(blockId, finalTrxId, block);
		}

		return block;
	}
}

// TODO: what to do with delete transforms
function applyTransform(block: IBlock, transform: Transform) {
	for (const [blockId, operations] of Object.entries(transform.updates)) {
		for (const op of operations) {
			applyOperation(block, op);
		}
	}
}

