import { Path, type ITreeTrunk, type KeyRange, type getTrunkFunc } from "./index.js";
import type { BlockId, BlockStore } from "../blocks/index.js";
import type { BranchNode, ITreeNode, LeafNode } from "./nodes.js";
import type { TreeBlock } from "./tree-block.js";
export declare const NodeCapacity = 64;
/**
 * Represents a lightweight B+(ish)Tree (data at leaves, but no linked list of leaves).
 * Allows for efficient storage and retrieval of data in a sorted manner.
 * @template TEntry The type of entries stored in the B-tree.
 * @template TKey The type of keys used for indexing the entries.  This might be an element of TEntry, or TEntry itself.
 */
export declare class BTree<TKey, TEntry> {
    readonly store: BlockStore<ITreeNode>;
    readonly trunk: ITreeTrunk;
    readonly keyFromEntry: (entry: TEntry) => TKey;
    readonly compare: (a: TKey, b: TKey) => number;
    protected _version: number;
    private _proxy?;
    /**
     * @param [compare=(a: TKey, b: TKey) => a < b ? -1 : a > b ? 1 : 0] a comparison function for keys.  The default uses < and > operators.
     * @param [keyFromEntry=(entry: TEntry) => entry as unknown as TKey] a function to extract the key from an entry.  The default assumes the key is the entry itself.
     */
    constructor(store: BlockStore<ITreeNode>, trunk: ITreeTrunk, keyFromEntry?: (entry: TEntry) => TKey, compare?: (a: TKey, b: TKey) => number);
    private atomic;
    static createRoot(store: BlockStore<ITreeNode>): LeafNode<never>;
    static create<TKey, TEntry>(store: BlockStore<ITreeNode | TreeBlock>, createTrunk: getTrunkFunc, keyFromEntry?: (entry: TEntry) => TKey, compare?: (a: TKey, b: TKey) => 0 | 1 | -1, newId?: BlockId): BTree<TKey, TEntry>;
    /** @returns a path to the first entry (on = false if no entries) */
    first(): Promise<Path<TKey, TEntry>>;
    /** @returns a path to the last entry (on = false if no entries) */
    last(): Promise<Path<TKey, TEntry>>;
    /** Attempts to find the given key
     * @returns Path to the key or the "crack" before it.  If `on` is true on the resulting path, the key was found.
     * 	If `on` is false, next() and prior() can attempt to move to the nearest match. */
    find(key: TKey): Promise<Path<TKey, TEntry>>;
    /** Retrieves the entry for the given key.
     * Use find instead for a path to the key, the nearest match, or as a basis for navigation.
     * @returns the entry for the given key if found; undefined otherwise. */
    get(key: TKey): Promise<TEntry | undefined>;
    /** @returns the entry for the given path if on an entry; undefined otherwise. */
    at(path: Path<TKey, TEntry>): TEntry | undefined;
    /** Iterates based on the given range
     * WARNING: mutation during iteration will result in an exception
    */
    range(range: KeyRange<TKey>): AsyncIterableIterator<Path<TKey, TEntry>>;
    /** @returns true if the given path remains valid; false if the tree has been mutated, invalidating the path. */
    isValid(path: Path<TKey, TEntry>): boolean;
    /**
     * Adds a value to the tree.  Be sure to check the result, as the tree does not allow duplicate keys.
     * Added entries are frozen to ensure immutability
     * @returns path to the new (on = true) or conflicting (on = false) row. */
    insert(entry: TEntry): Promise<Path<TKey, TEntry>>;
    /** Updates the entry at the given path to the given value.  Deletes and inserts if the key changes.
     * @returns path to resulting entry and whether it was an update (as opposed to an insert).
     * 	* on = true if update/insert succeeded.
     * 		* wasUpdate = true if updated; false if inserted.
     * 		* Returned path is on entry
     * 	* on = false if update/insert failed.
     * 		* wasUpdate = true, given path is not on an entry
     * 		* else newEntry's new key already present; returned path is "near" existing entry */
    updateAt(path: Path<TKey, TEntry>, newEntry: TEntry): Promise<[path: Path<TKey, TEntry>, wasUpdate: boolean]>;
    /** Inserts the entry if it doesn't exist, or updates it if it does.
     * The entry is frozen to ensure immutability.
     * @returns path to the new entry.  on = true if existing; on = false if new. */
    upsert(entry: TEntry): Promise<Path<TKey, TEntry>>;
    /** Inserts or updates depending on the existence of the given key, using callbacks to generate the new value.
     * @param newEntry the new entry to insert if the key doesn't exist.
     * @param getUpdated a callback to generate an updated entry if the key does exist.  WARNING: mutation in this callback will cause merge to error.
     * @returns path to new entry and whether an update or insert attempted.
     * If getUpdated callback returns a row that is already present, the resulting path will not be on. */
    merge(newEntry: TEntry, getUpdated: (existing: TEntry) => TEntry): Promise<[path: Path<TKey, TEntry>, wasUpdate: boolean]>;
    /** Deletes the entry at the given path.
     * The on property of the path will be cleared.
     * @returns true if the delete succeeded (the key was found); false otherwise.
    */
    deleteAt(path: Path<TKey, TEntry>): Promise<boolean>;
    drop(): Promise<void>;
    /** Iterates forward starting from the path location (inclusive) to the end.
     * WARNING: mutation during iteration will result in an exception.
    */
    ascending(path: Path<TKey, TEntry>): AsyncIterableIterator<Path<TKey, TEntry>>;
    /** Iterates backward starting from the path location (inclusive) to the end.
     * WARNING: mutation during iteration will result in an exception
    */
    descending(path: Path<TKey, TEntry>): AsyncIterableIterator<Path<TKey, TEntry>>;
    /** Computed (not stored) count.  Computes the sum using leaf-node lengths.  O(n/af) where af is average fill.
     * @param from if provided, the count will start from the given path (inclusive).  If ascending is false,
     * 	the count will start from the end of the tree.  Ascending is true by default.
     */
    getCount(from?: {
        path: Path<TKey, TEntry>;
        ascending?: boolean;
    }): Promise<number>;
    /** @returns a path one step forward.  on will be true if the path hasn't hit the end. */
    next(path: Path<TKey, TEntry>): Promise<Path<TKey, TEntry>>;
    /** Attempts to advance the given path one step forward. (mutates the path) */
    moveNext(path: Path<TKey, TEntry>): Promise<void>;
    /** @returns a path one step backward.  on will be true if the path hasn't hit the end. */
    prior(path: Path<TKey, TEntry>): Promise<Path<TKey, TEntry>>;
    /** Attempts to advance the given path one step backwards. (mutates the path) */
    movePrior(path: Path<TKey, TEntry>): Promise<void>;
    /** @remarks Assumes the path is "on" */
    protected keyFromPath(path: Path<TKey, TEntry>): TKey;
    private internalAscending;
    private internalDescending;
    private findFirst;
    private findLast;
    protected getPath(node: ITreeNode, key: TKey): Promise<Path<TKey, TEntry>>;
    private indexOfEntry;
    protected indexOfKey(keys: TKey[], key: TKey): number;
    private internalNext;
    private internalPrior;
    private internalUpdate;
    protected internalDelete(path: Path<TKey, TEntry>): Promise<boolean>;
    private internalInsert;
    private internalInsertAt;
    /** Starting from the given node, recursively working down to the leaf, build onto the path based on the beginning-most entry. */
    private moveToFirst;
    /** Starting from the given node, recursively working down to the leaf, build onto the path based on the end-most entry. */
    private moveToLast;
    /** Construct a path based on the first-most edge of the given. */
    private getFirst;
    /** Construct a path based on the last-most edge of the given node */
    private getLast;
    private leafInsert;
    private branchInsert;
    protected rebalanceLeaf(path: Path<TKey, TEntry>, depth: number): Promise<ITreeNode | undefined>;
    protected rebalanceBranch(path: Path<TKey, TEntry>, depth: number): Promise<ITreeNode | undefined>;
    protected updatePartition(nodeIndex: number, path: Path<TKey, TEntry>, depth: number, newKey: TKey): void;
    protected insertPartition(branch: BranchNode<TKey>, index: number, key: TKey, node: BlockId, nodeOffset?: number): void;
    protected deletePartition(branch: BranchNode<TKey>, index: number, nodeOffset?: number): void;
    private validatePath;
    /** Iterates every node ID below and including the given node. */
    private nodeIds;
    protected getEntry(path: Path<TKey, TEntry>): TEntry;
    protected updateEntry(path: Path<TKey, TEntry>, entry: TEntry): void;
}
//# sourceMappingURL=btree.d.ts.map