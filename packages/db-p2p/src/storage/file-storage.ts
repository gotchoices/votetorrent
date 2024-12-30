import * as fs from 'fs/promises';
import * as path from 'path';
import { BlockId, IBlock, Transform, TrxId, TrxTransform } from "../../../db-core/src/index.js";
import { BlockMetadata, IBlockStorage } from "./struct.js";

export class FileBlockStorage implements IBlockStorage {
	constructor(private readonly basePath: string) { }

	async getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
		return this.readIfExists<BlockMetadata>(this.getMetadataPath(blockId));
	}

	async saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
		await this.ensureAndWriteFile(
			this.getMetadataPath(blockId),
			JSON.stringify(metadata)
		);
	}

	async getRevision(blockId: BlockId, rev: number): Promise<TrxId | undefined> {
		return this.readIfExists<TrxId>(this.getRevisionPath(blockId, rev));
	}

	async saveRevision(blockId: BlockId, rev: number, trxId: TrxId): Promise<void> {
		await this.ensureAndWriteFile(
			this.getRevisionPath(blockId, rev),
			trxId
		);
	}

	async getPendingTransaction(blockId: BlockId, trxId: TrxId): Promise<TrxTransform | undefined> {
		return this.readIfExists<TrxTransform>(this.getPendingTrxPath(blockId, trxId));
	}

	async savePendingTransaction(blockId: BlockId, trxId: TrxId, transform: Transform): Promise<void> {
		await this.ensureAndWriteFile(
			this.getPendingTrxPath(blockId, trxId),
			JSON.stringify(transform)
		);
	}

	async deletePendingTransaction(blockId: BlockId, trxId: TrxId): Promise<void> {
		const pendingPath = this.getPendingTrxPath(blockId, trxId);
		await fs.unlink(pendingPath)
			.catch(() => {
				// Ignore if file doesn't exist
			});
	}

	async getAllPendingTransactions(blockId: BlockId): Promise<Map<TrxId, TrxTransform>> {
		const pending = new Map<TrxId, TrxTransform>();
		const pendingPath = path.join(this.getBlockPath(blockId), 'pend');

		return fs.readdir(pendingPath)
			.then(async files => {
				for (const file of files) {
					if (file.endsWith('.json')) {
						const rawTrxId = file.slice(0, -5);
						if (/^[\w\d]+-[\w\d]+-[\w\d]+-[\w\d]+-[\w\d]+$/.test(rawTrxId)) {
							const trxId = rawTrxId as TrxId;
							const pendingTrx = await this.getPendingTransaction(blockId, trxId);
							if (pendingTrx) {
								pending.set(trxId, pendingTrx);
							}
						}
					}
				}
				return pending;
			})
			.catch(() => {
				// Directory doesn't exist yet, return empty map
				return pending;
			});
	}

	async getTransaction(blockId: BlockId, trxId: TrxId): Promise<TrxTransform | undefined> {
		return this.readIfExists<TrxTransform>(this.getTrxPath(blockId, trxId));
	}

	async saveTransaction(blockId: BlockId, trxId: TrxId, transform: TrxTransform): Promise<void> {
		await this.ensureAndWriteFile(
			this.getTrxPath(blockId, trxId),
			JSON.stringify(transform)
		);
	}

	async getMaterializedBlock(blockId: BlockId, trxId: TrxId): Promise<IBlock | undefined> {
		return this.readIfExists<IBlock>(this.getMaterializedPath(blockId, trxId));
	}

	async saveMaterializedBlock(blockId: BlockId, trxId: TrxId, block: IBlock): Promise<void> {
		await this.ensureAndWriteFile(
			this.getMaterializedPath(blockId, trxId),
			JSON.stringify(block)
		);
	}

	async promotePendingTransaction(blockId: BlockId, trxId: TrxId): Promise<void> {
		const pendingPath = this.getPendingTrxPath(blockId, trxId);
		const trxPath = this.getTrxPath(blockId, trxId);

		// Ensure target directory exists
		await fs.mkdir(path.dirname(trxPath), { recursive: true });

		return fs.rename(pendingPath, trxPath)
			.catch(err => {
				if (err.code === 'ENOENT') {
					throw new Error(`Pending transaction ${trxId} not found for block ${blockId}`);
				}
				throw err;
			});
	}

	private getBlockPath(blockId: BlockId): string {
		return path.join(this.basePath, blockId);
	}

	private getMetadataPath(blockId: BlockId): string {
		return path.join(this.getBlockPath(blockId), 'meta.json');
	}

	private getRevisionPath(blockId: BlockId, rev: number): string {
		return path.join(this.getBlockPath(blockId), 'revs', `${rev}.json`);
	}

	private getPendingTrxPath(blockId: BlockId, trxId: TrxId): string {
		return path.join(this.getBlockPath(blockId), 'pend', `${trxId}.json`);
	}

	private getTrxPath(blockId: BlockId, trxId: TrxId): string {
		return path.join(this.getBlockPath(blockId), 'trx', `${trxId}.json`);
	}

	private getMaterializedPath(blockId: BlockId, trxId: TrxId): string {
		return path.join(this.getBlockPath(blockId), 'blocks', `${trxId}.json`);
	}

	private async readIfExists<T>(filePath: string): Promise<T | undefined> {
		return fs.readFile(filePath, 'utf-8')
			.then(content => JSON.parse(content) as T)
			.catch(err => {
				if (err.code === 'ENOENT') return undefined;
				throw err;
			});
	}

	private async ensureAndWriteFile(filePath: string, content: string): Promise<void> {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content);
	}
}
