import { IBlock, BlockId } from "../index.js";

export const EntriesPerBlock = 32;

export type ChainDataBlock<TEntry> = IBlock & {
	entries: TEntry[],
	priorId?: BlockId,
	nextId?: BlockId,
}

export const ChainDataBlockType = 'CHD';

export type ChainHeaderBlock = IBlock & {
	headId: BlockId,
	tailId: BlockId,
}

export const ChainHeaderBlockType = 'CHH';
