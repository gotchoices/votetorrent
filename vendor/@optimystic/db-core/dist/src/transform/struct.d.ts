import type { IBlock, BlockId, BlockOperations } from "../blocks/structs.js";
/** A transform is a set of block mutations to be performed.
 * If a block is present in more than one field, they are applied in order of: insert, update, delete.
 * All fields are optional and default to empty when not present. */
export type Transforms = {
    /** Inserted blocks by BlockId */
    inserts?: Record<BlockId, IBlock>;
    /** Block update operations by BlockId */
    updates?: Record<BlockId, BlockOperations>;
    /** Set of deleted BlockIds */
    deletes?: BlockId[];
};
/** A transform is a block-level mutation.
 * If more than one field is set, they are applied in order of: insert, update, delete. */
export type Transform = {
    insert?: IBlock;
    updates?: BlockOperations;
    delete?: boolean;
};
//# sourceMappingURL=struct.d.ts.map