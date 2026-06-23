import { type CollectionId } from "../../collection/index.js";
import type { ITransactor } from "../../index.js";
import { type Path, type KeyRange } from "../../btree/index.js";
import { type TreeReplaceAction } from "./struct.js";
export declare class Tree<TKey, TEntry> {
    private readonly collection;
    private readonly btree;
    private constructor();
    static createOrOpen<TKey, TEntry>(network: ITransactor, id: CollectionId, keyFromEntry?: (entry: TEntry) => TKey, compare?: (a: TKey, b: TKey) => 0 | 1 | -1): Promise<Tree<TKey, TEntry>>;
    replace(data: TreeReplaceAction<TKey, TEntry>): Promise<void>;
    /**
     * Update the local state from the network.
     * Call this before reading to ensure you have the latest data.
     */
    update(): Promise<void>;
    first(): Promise<Path<TKey, TEntry>>;
    last(): Promise<Path<TKey, TEntry>>;
    find(key: TKey): Promise<Path<TKey, TEntry>>;
    get(key: TKey): Promise<TEntry | undefined>;
    at(path: Path<TKey, TEntry>): TEntry | undefined;
    range(range: KeyRange<TKey>): AsyncIterableIterator<Path<TKey, TEntry>>;
    ascending(path: Path<TKey, TEntry>): AsyncIterableIterator<Path<TKey, TEntry>>;
    descending(path: Path<TKey, TEntry>): AsyncIterableIterator<Path<TKey, TEntry>>;
    getCount(from?: {
        path: Path<TKey, TEntry>;
        ascending?: boolean;
    }): Promise<number>;
    next(path: Path<TKey, TEntry>): Promise<Path<TKey, TEntry>>;
    moveNext(path: Path<TKey, TEntry>): Promise<void>;
    prior(path: Path<TKey, TEntry>): Promise<Path<TKey, TEntry>>;
    movePrior(path: Path<TKey, TEntry>): Promise<void>;
    isValid(path: Path<TKey, TEntry>): boolean;
}
//# sourceMappingURL=tree.d.ts.map