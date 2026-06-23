import { registerBlockType } from "../blocks/index.js";
import { nameof } from "../utility/nameof.js";
export const TreeLeafBlockType = registerBlockType('TL', "TreeLeaf");
export const TreeBranchBlockType = registerBlockType('TB', "TreeBranch");
// Entities
export const entries$ = nameof("entries");
export const partitions$ = nameof("partitions");
export const nodes$ = nameof("nodes");
//# sourceMappingURL=nodes.js.map