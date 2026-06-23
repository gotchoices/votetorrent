import type { IBlock, BlockHeader, BlockId, BlockSource, BlockType, Transforms } from "../index.js";
import { LruMap } from "../utility/lru-map.js";
export declare class CacheSource<T extends IBlock> implements BlockSource<T> {
    protected readonly source: BlockSource<T>;
    protected cache: LruMap<BlockId, T>;
    constructor(source: BlockSource<T>, maxSize?: number);
    tryGet(id: BlockId): Promise<T | undefined>;
    generateId(): BlockId;
    createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader;
    clear(blockIds?: BlockId[] | undefined): void;
    /** Mutates the cache without affecting the source */
    transformCache(transform: Transforms): void;
}
//# sourceMappingURL=cache-source.d.ts.map