import { IBlock, BlockId, registerBlockType } from "../blocks";
import { nameof } from "../utility/nameof";

export type ChainDataBlock<TEntry> = IBlock & {
	entries: TEntry[];
	priorId?: BlockId;
	nextId?: BlockId;
};

export const entries$ = nameof<ChainDataBlock<any>>("entries");
export const priorId$ = nameof<ChainDataBlock<any>>("priorId");
export const nextId$ = nameof<ChainDataBlock<any>>("nextId");

export const ChainDataBlockType = registerBlockType('CHD', 'ChainDataBlock');

export type ChainHeaderBlock = IBlock & {
	headId: BlockId;
	tailId: BlockId;
};

export const headId$ = nameof<ChainHeaderBlock>("headId");
export const tailId$ = nameof<ChainHeaderBlock>("tailId");

export const ChainHeaderBlockType = registerBlockType('CHH', 'ChainHeaderBlock');
