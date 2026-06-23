import { apply, get } from "../../index.js";
import { rootId$ } from "./struct.js";
export class CollectionTrunk {
    store;
    collectionId;
    constructor(store, collectionId) {
        this.store = store;
        this.collectionId = collectionId;
    }
    async get() {
        return await get(this.store, await this.getId());
    }
    async set(node) {
        const header = await get(this.store, this.collectionId);
        apply(this.store, header, [rootId$, 0, 1, node.header.id]);
    }
    async getId() {
        const header = await get(this.store, this.collectionId);
        return header.rootId;
    }
}
//# sourceMappingURL=collection-trunk.js.map