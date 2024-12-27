import { Collection, CollectionInitOptions, CollectionId } from "../../collection/index.js";
import { IBlockNetwork, Log, Action, BlockId, CacheStore, Tracker, BlockStore, IBlock } from "../../index.js";
import { DiaryHeaderBlockType } from "./index.js";

export class Diary<TEntry> {
    private constructor(
			private readonly collection: Collection<TEntry>
		) {
    }

    static async create<TEntry>(network: IBlockNetwork, id: CollectionId): Promise<Diary<TEntry>> {
        const init: CollectionInitOptions<TEntry> = {
            modules: {
							"append": async (action, trx) => {
								// Append-only diary doesn't need to modify any blocks
								// All entries are stored in the log
							}
            },
            createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => ({
                block: store.createBlockHeader(DiaryHeaderBlockType, id)
            })
        };

        const collection = await Collection.createOrOpen(network, id, init);
        return new Diary<TEntry>(collection);
    }

    async append(data: TEntry): Promise<void> {
        const action: Action<TEntry> = {
            type: "append",
            data: data
        };

        await this.collection.transact(action);
        await this.collection.updateAndSync();
    }

    async *select(reverse = false): AsyncIterableIterator<TEntry> {
        for await (const entry of this.collection.selectLog(reverse)) {
            yield entry.data;
        }
    }
}
