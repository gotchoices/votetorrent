import { type BlockId, type CollectionHeaderBlock, nameof, registerBlockType } from "../../index.js";

export const TreeHeaderBlockType = registerBlockType("TRE", "TreeHeaderBlock");

export type TreeCollectionHeaderBlock = CollectionHeaderBlock & {
	rootId: BlockId;
};

export const rootId$ = nameof<TreeCollectionHeaderBlock>("rootId");

/** Represents a unit of change to a tree collection. */
export type TreeReplaceAction<TKey, TEntry> = [
	// The key to replace
	key: TKey,
	// The new entry to replace the old entry with (if not provided, the key is deleted)
	entry?: TEntry,
][];

