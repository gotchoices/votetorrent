import { IBlock, BlockType, BlockId, BlockHeader, BlockOperation } from ".";

export type IBlockStore<T extends IBlock> = {
	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader;
	tryGet(id: BlockId): Promise<T | undefined>;
	insert(block: T): void;
	update(blockId: BlockId, op: BlockOperation): void;
	delete(blockId: BlockId): void;
	generateId(): BlockId;
};
