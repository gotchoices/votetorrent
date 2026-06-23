import type { BlockId, BlockStore, IBlock, ITreeTrunk } from "../../index.js";
import type { ITreeNode } from "../../btree/nodes.js";
export declare class CollectionTrunk implements ITreeTrunk {
    private readonly store;
    private readonly collectionId;
    constructor(store: BlockStore<IBlock>, collectionId: BlockId);
    get(): Promise<ITreeNode>;
    set(node: ITreeNode): Promise<void>;
    getId(): Promise<BlockId>;
}
//# sourceMappingURL=collection-trunk.d.ts.map