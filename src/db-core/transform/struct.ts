import { IBlock, BlockOperations } from "../blocks/structs.js";

export type Transform = {
	inserts: Record<string, IBlock>;
	updates: Record<string, BlockOperations>;
	deletes: Set<string>;
};
