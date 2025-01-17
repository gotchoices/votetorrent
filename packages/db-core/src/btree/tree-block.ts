import type { BlockId, IBlock } from "../blocks";
import { registerBlockType } from "../blocks";
import { nameof } from "../utility/nameof";

export const TreeRootBlockType = registerBlockType("TR", "TreeRoot");

export interface TreeBlock extends IBlock {
	rootId: BlockId;
}

export const rootId$ = nameof<TreeBlock>("rootId");
