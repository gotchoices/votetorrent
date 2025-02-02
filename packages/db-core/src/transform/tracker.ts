import type { IBlock, BlockId, BlockStore as IBlockStore, BlockHeader, BlockOperation, BlockType, BlockSource as IBlockSource } from "../index.js";
import { applyOperation, emptyTransforms, blockIdsForTransform, copyTransforms, ensured } from "../index.js";

/** A block store that collects transformations, without applying them to the underlying source.
 * Transformations are also applied to the retrieved blocks, making it seem like the source has been modified.
 */
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
			if (Object.hasOwn(this.transform.deletes, id)) {
				return undefined;
			}
		} else if (Object.hasOwn(this.transform.inserts, id)) {
			return structuredClone(this.transform.inserts[id]) as T;
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
		this.transform.inserts[block.header.id] = structuredClone(block);
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
		return Array.from(new Set(blockIdsForTransform(this.transform)));
	}

	conflicts(blockIds: Set<BlockId>) {
		return this.transformedBlockIds().filter(id => blockIds.has(id));
	}
}
