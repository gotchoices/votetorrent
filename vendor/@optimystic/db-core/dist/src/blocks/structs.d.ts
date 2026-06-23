export type BlockId = string;
export type BlockType = string;
export type BlockHeader = {
    id: BlockId;
    type: BlockType;
    collectionId: BlockId;
};
/** A simple block with only a header.  Blocks should be treated as immutable */
export type IBlock = {
    header: BlockHeader;
};
export type BlockOperation = [entity: string, index: number, deleteCount: number, inserted: unknown[] | unknown];
export type BlockOperations = BlockOperation[];
//# sourceMappingURL=structs.d.ts.map