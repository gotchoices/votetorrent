import { IBlock, BlockHeader, BlockId, BlockSource, BlockType, Transform, applyOperation } from "../index.js";

export class CacheSource<T extends IBlock> implements BlockSource<T> {
	protected cache = new Map<BlockId, T>();

	constructor(
		protected readonly source: BlockSource<T>
	) { }

	async tryGet(id: BlockId): Promise<T | undefined> {
		let block = this.cache.get(id);
		if (!block) {
			block = await this.source.tryGet(id);
		}
		return block;
	}

	generateId(): BlockId {
		return this.source.generateId();
	}

	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader {
		return this.source.createBlockHeader(type, newId);
	}

	clear(blockIds: BlockId[] | undefined = undefined) {
		if (blockIds) {
			for (const id of blockIds) {
				this.cache.delete(id);
			}
		} else {
			this.cache.clear();
		}
	}

	/** Mutates the cache without affecting the source */
	transformCache(transform: Transform) {
		for (const blockId of transform.deletes) {
			this.cache.delete(blockId);
		}
		for (const [, block] of Object.entries(transform.inserts)) {
			this.cache.set(block.block.id, block as T);
		}
		for (const [blockId, operations] of Object.entries(transform.updates)) {
			for (const op of operations) {
				const block = this.cache.get(blockId);
				if (block) {
					applyOperation(block, op);
				}
			}
		}
	}
}
