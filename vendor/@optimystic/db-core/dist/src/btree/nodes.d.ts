import type { BlockId, IBlock } from "../blocks/index.js";
export declare const TreeLeafBlockType: string;
export declare const TreeBranchBlockType: string;
export interface ITreeNode extends IBlock {
}
export interface LeafNode<TEntry> extends ITreeNode {
    entries: TEntry[];
}
export interface BranchNode<TKey> extends ITreeNode {
    partitions: TKey[];
    nodes: BlockId[];
}
export declare const entries$: string;
export declare const partitions$: string;
export declare const nodes$: string;
//# sourceMappingURL=nodes.d.ts.map