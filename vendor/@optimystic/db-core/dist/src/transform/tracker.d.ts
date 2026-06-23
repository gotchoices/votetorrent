import type { IBlock, BlockId, BlockStore as IBlockStore, BlockHeader, BlockOperation, BlockType, BlockSource as IBlockSource } from "../index.js";
/** A block store that collects transformations, without applying them to the underlying source.
 * Transformations are also applied to the retrieved blocks, making it seem like the source has been modified.
 */
export declare class Tracker<T extends IBlock> implements IBlockStore<T> {
    private readonly source;
    /** The collected set of transformations to be applied. Treat as immutable */
    transforms: import("./struct.js").Transforms;
    constructor(source: IBlockSource<T>, 
    /** The collected set of transformations to be applied. Treat as immutable */
    transforms?: import("./struct.js").Transforms);
    tryGet(id: BlockId): Promise<T | undefined>;
    generateId(): BlockId;
    createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader;
    insert(block: T): void;
    update(blockId: BlockId, op: BlockOperation): void;
    delete(blockId: BlockId): void;
    reset(newTransform?: import("./struct.js").Transforms): import("./struct.js").Transforms;
    transformedBlockIds(): BlockId[];
    conflicts(blockIds: Set<BlockId>): string[];
}
//# sourceMappingURL=tracker.d.ts.map