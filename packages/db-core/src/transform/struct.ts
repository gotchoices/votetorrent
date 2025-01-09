import { IBlock, BlockOperations } from "../blocks/structs.js";

/** A transform is a set of block operations to be performed */
export type Transform = {
	/** Inserted blocks by BlockId */
	inserts: Record<string, IBlock>;
	/** Block update operations by BlockId */
	updates: Record<string, BlockOperations>;
	/** Set of deleted BlockIds */
	deletes: Set<string>;
};
