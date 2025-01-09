import { IBlock, BlockId, BlockStore, BlockOperation, applyOperation } from "../index.js";
import { CacheSource } from "./index.js";

export class CacheStore<T extends IBlock> extends CacheSource<T> implements BlockStore<T> {
	declare protected readonly source: BlockStore<T>;

	constructor(store: BlockStore<T>) {
		super(store);
	}

	insert(block: T) {
		this.cache.set(block.header.id, block);
		this.source.insert(block);
	}

	update(blockId: BlockId, op: BlockOperation) {
		const block = this.cache.get(blockId);
		if (block) {
			applyOperation(block, op);
		}
		this.source.update(blockId, op);
	}

	delete(blockId: BlockId) {
		this.cache.delete(blockId);
		this.source.delete(blockId);
	}
}
