import type { IBlock, BlockId, BlockStore, BlockType, BlockHeader, BlockOperation } from '../index.js';
/**
 * A BlockStore proxy that enables scoped atomic operations.
 * Operations normally delegate directly to the underlying store,
 * but during an `atomic()` call, they route through an Atomic tracker
 * that commits all-or-nothing on success, or rolls back on error.
 *
 * Both the BTree and its trunk should share the same AtomicProxy instance
 * so that all mutations (including root pointer updates) are part of the
 * same atomic batch.
 */
export declare class AtomicProxy<T extends IBlock> implements BlockStore<T> {
    private _base;
    private _active;
    constructor(store: BlockStore<T>);
    tryGet(id: BlockId): Promise<T | undefined>;
    insert(block: T): void;
    update(blockId: BlockId, op: BlockOperation): void;
    delete(blockId: BlockId): void;
    generateId(): BlockId;
    createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader;
    /** Execute fn within an atomic scope. All store mutations are collected
     *  and committed on success, or discarded on error. Re-entrant safe. */
    atomic<R>(fn: () => Promise<R>): Promise<R>;
}
//# sourceMappingURL=atomic-proxy.d.ts.map