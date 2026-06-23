import { Collection, registerCollectionType } from "../../index.js";
import { DiaryHeaderBlockType } from "./struct.js";
export class Diary {
    collection;
    constructor(collection) {
        this.collection = collection;
    }
    static async create(network, id) {
        const init = {
            modules: {
                "append": async (_action, _trx) => {
                    // Append-only diary doesn't need to modify any blocks
                    // All entries are stored in the log
                }
            },
            createHeaderBlock: (id, store) => ({
                header: store.createBlockHeader(DiaryHeaderBlockType, id)
            })
        };
        const collection = await Collection.createOrOpen(network, id, init);
        return new Diary(collection);
    }
    async append(data) {
        const action = {
            type: "append",
            data: data
        };
        await this.collection.act(action);
        await this.collection.updateAndSync();
    }
    /** Fetch the latest state from the network */
    async update() {
        await this.collection.update();
    }
    async *select(forward = true) {
        for await (const entry of this.collection.selectLog(forward)) {
            yield entry.data;
        }
    }
}
registerCollectionType({
    blockType: DiaryHeaderBlockType,
    name: "Diary",
    open: (transactor, id) => Collection.createOrOpen(transactor, id, {
        modules: { "append": async () => { } },
        createHeaderBlock: (hid, store) => ({
            header: store.createBlockHeader(DiaryHeaderBlockType, hid)
        })
    }),
});
//# sourceMappingURL=diary.js.map