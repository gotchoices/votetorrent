import { Collection } from "../../index.js";
import type { ITransactor, Action, BlockId, BlockStore, IBlock, CollectionInitOptions, CollectionId } from "../../index.js";
import { DiaryHeaderBlockType } from "./index.js";

export class Diary<TEntry> {
    private constructor(
			private readonly collection: Collection<TEntry>
		) {
    }

    static async create<TEntry>(network: ITransactor, id: CollectionId): Promise<Diary<TEntry>> {
        const init: CollectionInitOptions<TEntry> = {
            modules: {
							"append": async (action, trx) => {
								// Append-only diary doesn't need to modify any blocks
								// All entries are stored in the log
							}
            },
            createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => ({
                header: store.createBlockHeader(DiaryHeaderBlockType, id)
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

        await this.collection.act(action);
        await this.collection.updateAndSync();
    }

    async *select(forward = true): AsyncIterableIterator<TEntry> {
        for await (const entry of this.collection.selectLog(forward)) {
            yield entry.data;
        }
    }
}
