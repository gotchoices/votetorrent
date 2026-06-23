import { type BlockId, type CollectionHeaderBlock } from "../../index.js";
export declare const TreeHeaderBlockType: string;
export type TreeCollectionHeaderBlock = CollectionHeaderBlock & {
    rootId: BlockId;
};
export declare const rootId$: string;
/** Represents a unit of change to a tree collection. */
export type TreeReplaceAction<TKey, TEntry> = [
    key: TKey,
    entry?: TEntry
][];
//# sourceMappingURL=struct.d.ts.map