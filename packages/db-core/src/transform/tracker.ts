import { IBlock, BlockId, BlockStore as IBlockStore, BlockHeader, BlockOperation, BlockType, applyOperation, emptyTransforms, BlockSource as IBlockSource, blockIdsForTransform, copyTransforms, TrxTransforms, ensured } from "../index.js";

export class Tracker<T extends IBlock> implements IBlockStore<T> {
	constructor(
		private readonly source: IBlockSource<T>,
		/** The collected set of transformations to be applied. Treat as immutable */
		public transform = emptyTransforms(),
	) { }

	async tryGet(id: BlockId): Promise<T | undefined> {
		const block = await this.source.tryGet(id);
		if (block) {
			const ops = this.transform.updates[id] ?? [];
			ops.forEach(op => applyOperation(block!, op));
		}
		return block;
	}

	generateId(): BlockId {
		return this.source.generateId();
	}

	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader {
		return this.source.createBlockHeader(type, newId);
	}

	insert(block: T) {
		this.transform.inserts[block.header.id] = block;
		this.transform.deletes.delete(block.header.id);
	}

	update(blockId: BlockId, op: BlockOperation) {
		const inserted = this.transform.inserts[blockId];
		if (inserted) {
			applyOperation(inserted, op);
		} else {
			ensured(this.transform.updates, blockId, () => []).push(op);
		}
	}

	delete(blockId: BlockId) {
		delete this.transform.inserts[blockId];
		delete this.transform.updates[blockId];
		this.transform.deletes.add(blockId);
	}

	reset(newTransform = emptyTransforms()) {
		const oldTransform = this.transform;
		this.transform = newTransform;
		return oldTransform;
	}

	transformedBlockIds(): BlockId[] {
		return blockIdsForTransform(this.transform);
	}

	conflicts(blockIds: Set<BlockId>) {
		return this.transformedBlockIds().filter(id => blockIds.has(id));
	}
}
