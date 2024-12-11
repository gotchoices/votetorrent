import { IBlock, BlockOperations } from "../blocks/structs.js";

/** A transform is a set of block operations to be performed */
export type Transform = {
	inserts: Record<string, IBlock>;
	updates: Record<string, BlockOperations>;
	deletes: Set<string>;
};
