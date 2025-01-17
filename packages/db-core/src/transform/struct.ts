import type { IBlock, BlockId, BlockOperations } from "../blocks/structs.js";

// TODO: make each of these optional (assumes empty)

/** A transform is a set of block mutations to be performed.
 * If a block is present in more than one field, they are applied in order of: insert, update, delete. */
export type Transforms = {
	/** Inserted blocks by BlockId */
	inserts: Record<BlockId, IBlock>;
	/** Block update operations by BlockId */
	updates: Record<BlockId, BlockOperations>;
	/** Set of deleted BlockIds */
	deletes: Set<BlockId>;
};

/** A transform is a block-level mutation.
 * If more than one field is set, they are applied in order of: insert, update, delete. */
export type Transform = {
	insert?: IBlock;
	updates?: BlockOperations;
	delete?: boolean;
};
