import { type BlockStore, type BlockId, type IBlock } from "../index.js";
import type { ChainDataNode, ChainHeaderNode } from "./chain-nodes.js";
export declare const EntriesPerBlock = 32;
export type ChainPath<TEntry> = {
    headerBlock: ChainHeaderNode;
    block: ChainDataNode<TEntry>;
    index: number;
};
export type ChainNodeInit<T> = IBlock & {
    [K in keyof Omit<T, keyof IBlock>]?: T[K];
};
export type ChainInitOptions<TEntry> = {
    createDataBlock?: () => ChainNodeInit<ChainDataNode<TEntry>>;
    createHeaderBlock?: (id?: BlockId) => ChainNodeInit<ChainHeaderNode>;
    newBlock?: (newTail: ChainDataNode<TEntry>, oldTail: ChainDataNode<TEntry> | undefined) => Promise<void>;
};
export type ChainCreateOptions<TEntry> = ChainInitOptions<TEntry> & {
    newId?: BlockId;
    /** Use an already-inserted block as the chain header instead of creating a new one.
     *  headId and tailId will be set on it via apply(). */
    existingHeaderId?: BlockId;
};
/** Represents a chain of blocks, forming a stack, queue, or log. */
export declare class Chain<TEntry> {
    readonly store: BlockStore<IBlock>;
    readonly id: BlockId;
    private readonly options?;
    private constructor();
    /** Creates a new queue, with an optional given id. */
    static create<TEntry>(store: BlockStore<IBlock>, options?: ChainCreateOptions<TEntry>): Promise<Chain<TEntry>>;
    private static createTailBlock;
    /** Opens an existing chain, verifying and potentially initializing the header. */
    static open<TEntry>(store: BlockStore<IBlock>, id: BlockId, options?: ChainInitOptions<TEntry>): Promise<Chain<TEntry> | undefined>;
    /**
     * Adds entries to the tail (last-in end) of the chain.  Equivalent of enqueue or push.
     * @param entries - The entries to add.
     * @returns Path to the new tail of the chain (entry just past the end).
     */
    add(...entries: TEntry[]): Promise<ChainPath<TEntry>>;
    /** Updates the entry at the given path. */
    updateAt(path: ChainPath<TEntry>, entry: TEntry): void;
    /**
     * Removes up to n entries from the tail (last-in end) of the chain.
     * @param n - The number of entries to remove.  If n is greater than the number of entries in the chain, the chain is emptied with no error.
     * @returns An array of the removed entries. May be less than n if the chain is exhausted.
     */
    pop(n?: number): Promise<TEntry[]>;
    /**
     * Removes up to n entries from the head (first-in end) of the queue.
     * @param n - The number of entries to remove.  If n is greater than the number of entries in the chain, the chain is emptied with no error.
     * @returns An array of the removed entries.  May be less than n if the queue is exhausted.
     */
    dequeue(n?: number): Promise<TEntry[]>;
    /** Iterates over the chain, starting at the given path, or the head or tail if not given.
     * If forward is true (default), the iteration is from head (oldest) to tail (latest); otherwise, it is from tail to head.
     */
    select(starting?: ChainPath<TEntry>, forward?: boolean): AsyncIterableIterator<ChainPath<TEntry>>;
    /** Returns the next entry in the chain; returns an off-the-end path if the end is reached. */
    next(path: ChainPath<TEntry>): Promise<{
        headerBlock: ChainHeaderNode;
        block: ChainDataNode<TEntry>;
        index: number;
    }>;
    /** Returns the previous entry in the chain; returns an off-the-start path if the start is reached. */
    prev(path: ChainPath<TEntry>): Promise<{
        headerBlock: ChainHeaderNode;
        block: ChainDataNode<TEntry>;
        index: number;
    }>;
    getTail(header?: ChainHeaderNode): Promise<ChainPath<TEntry> | undefined>;
    getHead(header?: ChainHeaderNode): Promise<ChainPath<TEntry> | undefined>;
    getHeader(): Promise<ChainHeaderNode | undefined>;
}
/** Returns true if the given path is located on an entry (not a crack). */
export declare function pathValid<TEntry>(path: ChainPath<TEntry>): boolean;
/** Gets the entry at the given path; undefined if the path is not valid. */
export declare function entryAt<TEntry>(path: ChainPath<TEntry>): TEntry | undefined;
//# sourceMappingURL=chain.d.ts.map