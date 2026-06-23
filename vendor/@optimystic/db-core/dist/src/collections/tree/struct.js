import { registerBlockType, registerCollectionType } from "../../index.js";
import { nameof } from "../../utility/nameof.js";
export const TreeHeaderBlockType = registerBlockType("TRE", "TreeHeaderBlock");
registerCollectionType({
    blockType: TreeHeaderBlockType,
    name: "Tree",
});
export const rootId$ = nameof("rootId");
//# sourceMappingURL=struct.js.map