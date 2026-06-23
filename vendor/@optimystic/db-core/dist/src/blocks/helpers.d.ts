import type { BlockOperation, IBlock, BlockId, BlockStore } from "../index.js";
export declare function get<T extends IBlock>(store: BlockStore<T>, id: BlockId): Promise<T>;
export declare function apply<T extends IBlock>(store: BlockStore<T>, block: IBlock, op: BlockOperation): void;
//# sourceMappingURL=helpers.d.ts.map