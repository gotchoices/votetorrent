import type { IBlock, BlockId, BlockStore as IBlockStore, BlockHeader, BlockOperation, BlockType, BlockSource as IBlockSource } from "../index.js";
import { applyOperation, emptyTransforms, blockIdsForTransforms, ensured } from "../index.js";

/** A block store that collects transformations, without applying them to the underlying source.
 * Transformations are also applied to the retrieved blocks, making it seem like the source has been modified.
 */
export class Tracker<T extends IBlock> implements IBlockStore<T> {
	constructor(
		private readonly source: IBlockSource<T>,
		/** The collected set of transformations to be applied. Treat as immutable */
		public transforms = emptyTransforms(),
	) { }

	async tryGet(id: BlockId): Promise<T | undefined> {
		const block = await this.source.tryGet(id);
		if (block) {
			const ops = this.transforms.updates[id] ?? [];
			ops.forEach(op => applyOperation(block!, op));
			if (Object.hasOwn(this.transforms.deletes, id)) {
				return undefined;
			}
		} else if (Object.hasOwn(this.transforms.inserts, id)) {
			return structuredClone(this.transforms.inserts[id]) as T;
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
		this.transforms.inserts[block.header.id] = structuredClone(block);
		this.transforms.deletes.delete(block.header.id);
	}

	update(blockId: BlockId, op: BlockOperation) {
		const inserted = this.transforms.inserts[blockId];
		if (inserted) {
			applyOperation(inserted, op);
		} else {
			ensured(this.transforms.updates, blockId, () => []).push(structuredClone(op));
		}
	}

	delete(blockId: BlockId) {
		delete this.transforms.inserts[blockId];
		delete this.transforms.updates[blockId];
		this.transforms.deletes.add(blockId);
	}

	reset(newTransform = emptyTransforms()) {
		const oldTransform = this.transforms;
		this.transforms = newTransform;
		return oldTransform;
	}

	transformedBlockIds(): BlockId[] {
		return Array.from(new Set(blockIdsForTransforms(this.transforms)));
	}

	conflicts(blockIds: Set<BlockId>) {
		return this.transformedBlockIds().filter(id => blockIds.has(id));
	}
}
