import { Collection } from "../../collection/index.js";
import { BTree } from "../../btree/index.js";
import { CollectionTrunk } from "./collection-trunk.js";
import { TreeHeaderBlockType } from "./struct.js";
export class Tree {
    collection;
    btree;
    constructor(collection, btree) {
        this.collection = collection;
        this.btree = btree;
    }
    static async createOrOpen(network, id, keyFromEntry = (entry) => entry, compare = (a, b) => a < b ? -1 : a > b ? 1 : 0) {
        // Tricky bootstrapping here:
        // We need the root id to initialize the collection header, so we create the btree in the create collection header callback.
        let btree;
        const init = {
            modules: {
                "replace": async ({ data: actions }, _trx) => {
                    for (const [key, entry] of actions) {
                        if (entry) {
                            await btree.upsert(entry);
                        }
                        else {
                            await btree.deleteAt((await btree.find(key)));
                        }
                    }
                }
            },
            createHeaderBlock: (id, store) => {
                let rootId;
                btree = BTree.create(store, (_s, r) => {
                    rootId = r;
                    return new CollectionTrunk(store, id);
                }, keyFromEntry, compare);
                return {
                    header: store.createBlockHeader(TreeHeaderBlockType, id),
                    rootId: rootId,
                };
            }
        };
        const collection = await Collection.createOrOpen(network, id, init);
        btree = btree ?? new BTree(collection.tracker, new CollectionTrunk(collection.tracker, collection.id), keyFromEntry, compare);
        return new Tree(collection, btree);
    }
    async replace(data) {
        await this.collection.act({ type: "replace", data });
        await this.collection.updateAndSync();
    }
    /**
     * Update the local state from the network.
     * Call this before reading to ensure you have the latest data.
     */
    async update() {
        await this.collection.update();
    }
    // Read actions
    async first() {
        return await this.btree.first();
    }
    async last() {
        return await this.btree.last();
    }
    async find(key) {
        return await this.btree.find(key);
    }
    async get(key) {
        return await this.btree.get(key);
    }
    at(path) {
        return this.btree.at(path);
    }
    range(range) {
        return this.btree.range(range);
    }
    ascending(path) {
        return this.btree.ascending(path);
    }
    descending(path) {
        return this.btree.descending(path);
    }
    async getCount(from) {
        return await this.btree.getCount(from);
    }
    async next(path) {
        return await this.btree.next(path);
    }
    async moveNext(path) {
        await this.btree.moveNext(path);
    }
    async prior(path) {
        return await this.btree.prior(path);
    }
    async movePrior(path) {
        await this.btree.movePrior(path);
    }
    isValid(path) {
        return this.btree.isValid(path);
    }
}
//# sourceMappingURL=tree.js.map