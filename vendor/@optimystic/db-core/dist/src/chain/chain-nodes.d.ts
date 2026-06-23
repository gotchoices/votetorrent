import { type IBlock, type BlockId } from "../blocks/index.js";
export type ChainDataNode<TEntry> = IBlock & {
    entries: TEntry[];
    priorId: BlockId | undefined;
    nextId: BlockId | undefined;
};
export declare const entries$: string;
export declare const priorId$: string;
export declare const nextId$: string;
export declare const ChainDataBlockType: string;
export type IChainHeader = {
    headId: BlockId;
    tailId: BlockId;
};
export type ChainHeaderNode = IBlock & IChainHeader;
export declare const headId$: string;
export declare const tailId$: string;
export declare const ChainHeaderBlockType: string;
//# sourceMappingURL=chain-nodes.d.ts.map