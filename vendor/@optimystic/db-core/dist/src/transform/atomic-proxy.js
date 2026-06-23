import { Atomic } from './atomic.js';
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
export class AtomicProxy {
    _base;
    _active;
    constructor(store) {
        this._base = store;
        this._active = store;
    }
    async tryGet(id) { return this._active.tryGet(id); }
    insert(block) { this._active.insert(block); }
    update(blockId, op) { this._active.update(blockId, op); }
    delete(blockId) { this._active.delete(blockId); }
    generateId() { return this._active.generateId(); }
    createBlockHeader(type, newId) { return this._active.createBlockHeader(type, newId); }
    /** Execute fn within an atomic scope. All store mutations are collected
     *  and committed on success, or discarded on error. Re-entrant safe. */
    async atomic(fn) {
        if (this._active !== this._base) {
            return fn(); // Already in atomic context
        }
        const atomic = new Atomic(this._base);
        this._active = atomic;
        try {
            const result = await fn();
            atomic.commit();
            return result;
        }
        catch (e) {
            atomic.reset();
            throw e;
        }
        finally {
            this._active = this._base;
        }
    }
}
//# sourceMappingURL=atomic-proxy.js.map