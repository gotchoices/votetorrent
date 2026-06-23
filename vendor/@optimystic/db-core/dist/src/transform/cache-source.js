import { applyOperation } from "../index.js";
import { LruMap } from "../utility/lru-map.js";
import { createLogger } from "../logger.js";
const log = createLogger('cache');
const DefaultMaxSize = 128;
export class CacheSource {
    source;
    cache;
    constructor(source, maxSize = DefaultMaxSize) {
        this.source = source;
        this.cache = new LruMap(maxSize);
    }
    async tryGet(id) {
        let block = this.cache.get(id);
        if (block) {
            log('hit id=%s', id);
        }
        else {
            block = await this.source.tryGet(id);
            if (block) {
                this.cache.set(id, block);
                log('miss:loaded id=%s cacheSize=%d', id, this.cache.size);
            }
            else {
                log('miss:absent id=%s', id);
            }
        }
        return structuredClone(block);
    }
    generateId() {
        return this.source.generateId();
    }
    createBlockHeader(type, newId) {
        return this.source.createBlockHeader(type, newId);
    }
    clear(blockIds = undefined) {
        if (blockIds) {
            for (const id of blockIds) {
                this.cache.delete(id);
            }
        }
        else {
            this.cache.clear();
        }
    }
    /** Mutates the cache without affecting the source */
    transformCache(transform) {
        for (const blockId of transform.deletes ?? []) {
            this.cache.delete(blockId);
        }
        for (const [, block] of Object.entries(transform.inserts ?? {})) {
            this.cache.set(block.header.id, structuredClone(block));
        }
        for (const [blockId, operations] of Object.entries(transform.updates ?? {})) {
            for (const op of operations) {
                const block = this.cache.get(blockId);
                if (block) {
                    applyOperation(block, op);
                }
            }
        }
    }
}
//# sourceMappingURL=cache-source.js.map