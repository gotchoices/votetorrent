import { BlockId, IBlock, registerBlockType } from "../blocks";
import { nameof } from "../utility/nameof";

export const TreeLeafBlockType = registerBlockType('TL', "TreeLeaf");
export const TreeBranchBlockType = registerBlockType('TB', "TreeBranch");

export interface ITreeNode extends IBlock { }

export interface LeafNode<TEntry> extends ITreeNode {
	sequence: number[],    // Entry indexes sorted by key values (count also determined from this)
	entries: TEntry[];    // These don't move so that they can be externally referenced -- only inserted not deleted (to preserve indexes)
	occupancy: number[],  // Redundant with sequence, but would have to search for available entry (3-5x slower in tests)
}

export interface BranchNode<TKey> extends ITreeNode {
	partitions: TKey[];	// partition[0] refers to the lowest key in nodes[1]
	nodes: BlockId[];  // has one more entry than partitions, since partitions split nodes
}

// Entities

export const sequence$ = nameof<LeafNode<any>>("sequence");
export const entries$ = nameof<LeafNode<any>>("entries");
export const occupancy$ = nameof<LeafNode<any>>("occupancy");

export const partitions$ = nameof<BranchNode<any>>("partitions");
export const nodes$ = nameof<BranchNode<any>>("nodes");

