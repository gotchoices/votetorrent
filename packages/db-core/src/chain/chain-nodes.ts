import { type IBlock, type BlockId, registerBlockType } from "../blocks/index.js";
import { nameof } from "../utility/nameof.js";

export type ChainDataNode<TEntry> = IBlock & {
	entries: TEntry[];
	priorId: BlockId | undefined;
	nextId: BlockId | undefined;
};

export const entries$ = nameof<ChainDataNode<any>>("entries");
export const priorId$ = nameof<ChainDataNode<any>>("priorId");
export const nextId$ = nameof<ChainDataNode<any>>("nextId");

export const ChainDataBlockType = registerBlockType('CHD', 'ChainDataBlock');

export type ChainHeaderNode = IBlock & {
	headId: BlockId;
	tailId: BlockId;
};

export const headId$ = nameof<ChainHeaderNode>("headId");
export const tailId$ = nameof<ChainHeaderNode>("tailId");

export const ChainHeaderBlockType = registerBlockType('CHH', 'ChainHeaderBlock');
