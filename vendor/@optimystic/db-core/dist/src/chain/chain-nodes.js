import { registerBlockType } from "../blocks/index.js";
import { nameof } from "../utility/nameof.js";
export const entries$ = nameof("entries");
export const priorId$ = nameof("priorId");
export const nextId$ = nameof("nextId");
export const ChainDataBlockType = registerBlockType('CHD', 'ChainDataBlock');
export const headId$ = nameof("headId");
export const tailId$ = nameof("tailId");
export const ChainHeaderBlockType = registerBlockType('CHH', 'ChainHeaderBlock');
//# sourceMappingURL=chain-nodes.js.map