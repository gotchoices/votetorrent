import * as fs from 'fs/promises';
import * as path from 'path';
import type { BlockId, IBlock, Transform, TrxId, TrxRev } from "@votetorrent/db-core";
import type { BlockMetadata } from "./struct.js";
import type { IRawStorage } from "./i-raw-storage.js";

export class FileRawStorage implements IRawStorage {
	constructor(private readonly basePath: string) {
		// TODO: use https://www.npmjs.com/package/proper-lockfile to take a lock on the basePath, also introduce explicit dispose pattern
	 }

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

	async getPendingTransaction(blockId: BlockId, trxId: TrxId): Promise<Transform | undefined> {
		return this.readIfExists<Transform>(this.getPendingTrxPath(blockId, trxId));
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

	async *listPendingTransactions(blockId: BlockId): AsyncIterable<TrxId> {
		const pendingPath = path.join(this.getBlockPath(blockId), 'pend');

		const files = await fs.readdir(pendingPath).catch(() => [] as string[]);
		for (const file of files) {
			if (!file.endsWith('.json')) continue;
			const rawTrxId = file.slice(0, -5);
			if (!/^[\w\d]+-[\w\d]+-[\w\d]+-[\w\d]+-[\w\d]+$/.test(rawTrxId)) continue;
			yield rawTrxId as TrxId;
		}
	}

	async getTransaction(blockId: BlockId, trxId: TrxId): Promise<Transform | undefined> {
		return this.readIfExists<Transform>(this.getTrxPath(blockId, trxId));
	}

	async *listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<TrxRev> {
		// TODO: Optimize this for sparse revs
		for (let rev = startRev; startRev <= endRev ? rev <= endRev : rev >= endRev; startRev <= endRev ? ++rev : --rev) {
			const trxId = await this.getRevision(blockId, rev);
			if (trxId) {
				yield { trxId, rev };
			}
		}
	}

	async saveTransaction(blockId: BlockId, trxId: TrxId, transform: Transform): Promise<void> {
		await this.ensureAndWriteFile(
			this.getTrxPath(blockId, trxId),
			JSON.stringify(transform)
		);
	}

	async getMaterializedBlock(blockId: BlockId, trxId: TrxId): Promise<IBlock | undefined> {
		return this.readIfExists<IBlock>(this.getMaterializedPath(blockId, trxId));
	}

	async saveMaterializedBlock(blockId: BlockId, trxId: TrxId, block?: IBlock): Promise<void> {
		if (block) {
			await this.ensureAndWriteFile(
				this.getMaterializedPath(blockId, trxId),
				JSON.stringify(block)
			);
		} else {
			await fs.unlink(this.getMaterializedPath(blockId, trxId))
				.catch(() => {
					// Ignore if file doesn't exist
				});
		}
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
