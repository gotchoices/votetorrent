export const DEFAULT_DB_NAME = 'optimystic';
/**
 * Opens (creating if needed) the Optimystic LevelDB database used by
 * `LevelDBRawStorage`, `LevelDBKVStore`, and `loadOrCreateRNPeerKey`.
 *
 * The caller passes the `rn-leveldb` constructors in; this keeps the
 * native module out of the package's static import graph. Apps embedding
 * both Optimystic and Quereus can pass the same constructors to both —
 * one native module, one Podfile entry.
 */
export function openOptimysticRNDb(options) {
    const native = options.openFn(options.name ?? DEFAULT_DB_NAME, options.createIfMissing ?? true, options.errorIfExists ?? false);
    return wrapRNLevelDB(native, options.WriteBatch);
}
/**
 * Wraps an already-open `rn-leveldb` `LevelDB` instance to satisfy the
 * `LevelDBLike` interface. Exported for callers that already hold a handle
 * (rare — usually `openOptimysticRNDb` is the right entry point).
 */
export function wrapRNLevelDB(native, WriteBatch) {
    return new RNLevelDBAdapter(native, WriteBatch);
}
class RNLevelDBAdapter {
    native;
    WriteBatch;
    constructor(native, WriteBatch) {
        this.native = native;
        this.WriteBatch = WriteBatch;
    }
    async get(key) {
        const result = this.native.getBuf(toArrayBuffer(key));
        return result === null ? undefined : new Uint8Array(result);
    }
    async put(key, value) {
        this.native.put(toArrayBuffer(key), toArrayBuffer(value));
    }
    async delete(key) {
        this.native.delete(toArrayBuffer(key));
    }
    batch() {
        return new RNLevelDBWriteBatchAdapter(this.native, new this.WriteBatch());
    }
    iterator(options = {}) {
        return new RNLevelDBIteratorAdapter(this.native.newIterator(), options);
    }
    async close() {
        this.native.close();
    }
}
class RNLevelDBWriteBatchAdapter {
    native;
    batch;
    constructor(native, batch) {
        this.native = native;
        this.batch = batch;
    }
    put(key, value) {
        this.batch.put(toArrayBuffer(key), toArrayBuffer(value));
        return this;
    }
    delete(key) {
        this.batch.delete(toArrayBuffer(key));
        return this;
    }
    async write() {
        try {
            this.native.write(this.batch);
        }
        finally {
            this.batch.close();
        }
    }
}
class RNLevelDBIteratorAdapter {
    iter;
    opts;
    positioned = false;
    yielded = 0;
    done = false;
    constructor(iter, opts) {
        this.iter = iter;
        this.opts = opts;
    }
    async next() {
        if (this.done)
            return undefined;
        if (this.opts.limit !== undefined && this.yielded >= this.opts.limit) {
            this.done = true;
            return undefined;
        }
        if (!this.positioned) {
            this.positionInitial();
            this.positioned = true;
        }
        else if (this.opts.reverse) {
            this.iter.prev();
        }
        else {
            this.iter.next();
        }
        if (!this.iter.valid()) {
            this.done = true;
            return undefined;
        }
        const key = new Uint8Array(this.iter.keyBuf());
        // Range bounds: bail out as soon as we cross.
        if (this.opts.reverse) {
            if (this.opts.gte && compareBytes(key, this.opts.gte) < 0) {
                this.done = true;
                return undefined;
            }
            if (this.opts.gt && compareBytes(key, this.opts.gt) <= 0) {
                this.done = true;
                return undefined;
            }
        }
        else {
            if (this.opts.lt && compareBytes(key, this.opts.lt) >= 0) {
                this.done = true;
                return undefined;
            }
            if (this.opts.lte && compareBytes(key, this.opts.lte) > 0) {
                this.done = true;
                return undefined;
            }
        }
        // `keys: true` means caller wants only keys; skip the `valueBuf` native call.
        const value = this.opts.keys ? new Uint8Array(0) : new Uint8Array(this.iter.valueBuf());
        this.yielded++;
        return [key, value];
    }
    async close() {
        this.iter.close();
    }
    positionInitial() {
        if (this.opts.reverse) {
            if (this.opts.lte !== undefined) {
                this.iter.seek(toArrayBuffer(this.opts.lte));
                if (!this.iter.valid()) {
                    this.iter.seekLast();
                }
                else {
                    const key = new Uint8Array(this.iter.keyBuf());
                    if (compareBytes(key, this.opts.lte) > 0)
                        this.iter.prev();
                }
            }
            else if (this.opts.lt !== undefined) {
                this.iter.seek(toArrayBuffer(this.opts.lt));
                if (this.iter.valid()) {
                    this.iter.prev();
                }
                else {
                    this.iter.seekLast();
                }
            }
            else {
                this.iter.seekLast();
            }
        }
        else {
            if (this.opts.gte !== undefined) {
                this.iter.seek(toArrayBuffer(this.opts.gte));
            }
            else if (this.opts.gt !== undefined) {
                this.iter.seek(toArrayBuffer(this.opts.gt));
                if (this.iter.valid()) {
                    const key = new Uint8Array(this.iter.keyBuf());
                    if (compareBytes(key, this.opts.gt) === 0)
                        this.iter.next();
                }
            }
            else {
                this.iter.seekToFirst();
            }
        }
    }
}
function toArrayBuffer(bytes) {
    const buffer = bytes.buffer;
    if (buffer instanceof ArrayBuffer
        && bytes.byteOffset === 0
        && bytes.byteLength === buffer.byteLength) {
        return buffer;
    }
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return copy;
}
function compareBytes(a, b) {
    const minLength = Math.min(a.length, b.length);
    for (let i = 0; i < minLength; i++) {
        const av = a[i];
        const bv = b[i];
        if (av !== bv)
            return av - bv;
    }
    return a.length - b.length;
}
//# sourceMappingURL=rn-opener.js.map