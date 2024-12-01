import { IBlock, BlockId, BlockStore as IBlockStore, BlockHeader, BlockOperation, BlockType, Transform, applyOperation, emptyTransform, BlockSource as IBlockSource, blockIdsForTransform, copyTransform, BlockTrx, applyTransformToStore } from "../index.js";
import { ensured } from "../../db-p2p/helpers.js";

export class Cache<T extends IBlock> implements IBlockStore<T> {
	protected cache = new Map<BlockId, T>();

	constructor(
		private readonly store: IBlockStore<T>,
	) { }

	async tryGet(id: BlockId): Promise<T | undefined> {
		let block = this.cache.get(id);
		if (!block) {
			block = await this.store.tryGet(id);
		}
		return block;
	}

	generateId(): BlockId {
		return this.store.generateId();
	}

	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader {
		return this.store.createBlockHeader(type, newId);
	}

	insert(block: T) {
		this.cache.set(block.block.id, block);
		this.store.insert(block);
	}

	update(blockId: BlockId, op: BlockOperation) {
		const block = this.cache.get(blockId);
		if (block) {
			applyOperation(block, op);
		}
		this.store.update(blockId, op);
	}

	delete(blockId: BlockId) {
		this.cache.delete(blockId);
		this.store.delete(blockId);
	}

	clear(blockIds: BlockId[] | undefined) {
		if (blockIds) {
			for (const id of blockIds) {
				this.cache.delete(id);
			}
		} else {
			this.cache.clear();
		}
	}
}
