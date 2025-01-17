import type { BlockType, IBlock, BlockId, BlockHeader, BlockOperation } from "./index.js";

export type BlockSource<T extends IBlock> = {
	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader;
	tryGet(id: BlockId): Promise<T | undefined>;
	generateId(): BlockId;
};

export type BlockStore<T extends IBlock> = BlockSource<T> & {
	insert(block: T): void;
	update(blockId: BlockId, op: BlockOperation): void;
	delete(blockId: BlockId): void;
};
