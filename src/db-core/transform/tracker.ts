import { IBlock, BlockId, BlockStore as IBlockStore, BlockHeader, BlockOperation, BlockType, Transform, applyOperation, emptyTransform, BlockSource as IBlockSource, blockIdsForTransform } from "../index.js";
import { ensured } from "../../db-p2p/helpers.js";

export class Tracker<T extends IBlock> implements IBlockStore<T> {
	transform = emptyTransform();
	cache = new Map<BlockId, T>();

	constructor(
		readonly source: IBlockSource<T>,
	) { }

	async tryGet(id: BlockId): Promise<T | undefined> {
		let block = this.cache.get(id);
		if (!block) {
			block = await this.source.tryGet(id);
			if (block) {
				const ops = this.transform.updates[id] ?? [];
				ops.forEach(op => applyOperation(block!, op));
			}
		}
		return structuredClone(block);
	}

	generateId(): BlockId {
		return this.source.generateId();
	}

	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader {
		return this.source.createBlockHeader(type, newId);
	}

	insert(block: T) {
		const clone = structuredClone(block);
		this.cache.set(block.block.id, clone);
		this.transform.inserts[block.block.id] = clone;
		this.transform.deletes.delete(block.block.id);
	}

	update(blockId: BlockId, op: BlockOperation) {
		const block = this.cache.get(blockId);
		if (block) {
			applyOperation(block, op);
		}
		ensured(this.transform.updates, blockId, () => []).push(op);
	}

	delete(blockId: BlockId) {
		delete this.transform.inserts[blockId];
		delete this.transform.updates[blockId];
		this.transform.deletes.add(blockId);
		this.cache.delete(blockId);
	}

	reset() {
		const oldTransform = this.transform;
		this.transform = emptyTransform();
		this.cache.clear();
		return oldTransform;
	}

	getBlockIds(): BlockId[] {
		return blockIdsForTransform(this.transform);
	}
}
