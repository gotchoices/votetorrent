import { apply, get } from "../blocks/index.js";
import { TreeRootBlockType, rootId$ } from "./tree-block.js";
export class IndependentTrunk {
    treeId;
    store;
    constructor(treeId, store) {
        this.treeId = treeId;
        this.store = store;
    }
    static create(store, rootId, newId) {
        const trunkBlock = {
            header: store.createBlockHeader(TreeRootBlockType, newId),
            rootId,
        };
        store.insert(trunkBlock);
        return new IndependentTrunk(trunkBlock.header.id, store);
    }
    static async from(store, id) {
        return new IndependentTrunk(id, store);
    }
    block() {
        return get(this.store, this.treeId);
    }
    async get() {
        return await get(this.store, await this.getId());
    }
    async set(node) {
        const block = await get(this.store, this.treeId);
        apply(this.store, block, [rootId$, 0, 1, node.header.id]);
    }
    async getId() {
        const block = await get(this.store, this.treeId);
        return block.rootId;
    }
    // Warning: only removes trunk.  Use BTree.drop for full tree removal
    drop() {
        this.store.delete(this.treeId);
    }
}
//# sourceMappingURL=independent-trunk.js.map