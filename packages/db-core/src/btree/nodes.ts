import type { BlockId, IBlock } from "../blocks/index.js";
import { registerBlockType } from "../blocks/index.js";
import { nameof } from "../utility/nameof.js";

export const TreeLeafBlockType = registerBlockType('TL', "TreeLeaf");
export const TreeBranchBlockType = registerBlockType('TB', "TreeBranch");

export interface ITreeNode extends IBlock { }

export interface LeafNode<TEntry> extends ITreeNode {
	entries: TEntry[];    // Entries stored in order by key
}

export interface BranchNode<TKey> extends ITreeNode {
	partitions: TKey[];	// partition[0] refers to the lowest key in nodes[1]
	nodes: BlockId[];  // has one more entry than partitions, since partitions split nodes
}

// Entities

export const entries$ = nameof<LeafNode<any>>("entries");

export const partitions$ = nameof<BranchNode<any>>("partitions");
export const nodes$ = nameof<BranchNode<any>>("nodes");

