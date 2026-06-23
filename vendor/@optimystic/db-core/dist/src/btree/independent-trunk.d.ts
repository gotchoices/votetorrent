import type { ITreeTrunk } from './trunk.js';
import type { BlockId, BlockStore } from "../blocks/index.js";
import type { ITreeNode } from "./nodes.js";
import type { TreeBlock } from "./tree-block.js";
export declare class IndependentTrunk implements ITreeTrunk {
    readonly treeId: BlockId;
    readonly store: BlockStore<TreeBlock>;
    protected constructor(treeId: BlockId, store: BlockStore<TreeBlock>);
    static create(store: BlockStore<TreeBlock>, rootId: BlockId, newId?: BlockId): IndependentTrunk;
    static from(store: BlockStore<TreeBlock>, id: BlockId): Promise<IndependentTrunk>;
    block(): Promise<TreeBlock>;
    get(): Promise<ITreeNode>;
    set(node: ITreeNode): Promise<void>;
    getId(): Promise<BlockId>;
    drop(): void;
}
//# sourceMappingURL=independent-trunk.d.ts.map