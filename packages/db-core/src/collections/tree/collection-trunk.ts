import { apply, type BlockId, type BlockStore, get, type IBlock } from "../../blocks";
import type { ITreeNode } from "../../btree/nodes";
import type { ITreeTrunk } from "../../btree/trunk";
import { rootId$, type TreeCollectionHeaderBlock } from "./struct";

export class CollectionTrunk implements ITreeTrunk {
    constructor(
        private readonly store: BlockStore<IBlock>,
        private readonly collectionId: BlockId,
    ) {}

    async get(): Promise<ITreeNode> {
        return await get(this.store, await this.getId());
    }

    async set(node: ITreeNode): Promise<void> {
				const header = await get(this.store, this.collectionId) as TreeCollectionHeaderBlock;
				apply(this.store, header, [rootId$, 0, 1, node.header.id]);
    }

    async getId(): Promise<BlockId> {
				const header = await get(this.store, this.collectionId) as TreeCollectionHeaderBlock;
        return header.rootId;
    }
}
