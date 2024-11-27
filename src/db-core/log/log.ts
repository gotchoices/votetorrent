import { Chain, LogEntry, BlockStore, IBlock, BlockId, TransactionId, LogHeaderBlockType, LogDataBlockType, ChainInitOptions, BlockTrxContext } from "../index.js";

export class Log<TAction> {
	private readonly chain: Chain<LogEntry<TAction>>;

	protected constructor(chain: Chain<LogEntry<TAction>>) {
		this.chain = chain;
	}

	static open<TAction>(store: BlockStore<IBlock>, id: BlockId) {
		return new Log<TAction>(new Chain(store, id, Log.getChainOptions(store)));
	}

	static async create<TAction>(store: BlockStore<IBlock>, newId?: BlockId) {
		return new Log<TAction>(await Chain.create<LogEntry<TAction>>(store, { ...Log.getChainOptions(store), newId }));
	}

	async add(actions: TAction[], transactionId: TransactionId, blockIds: BlockId[] = []) {
		const entry = {
			actions,
			timestamp: Date.now(),
			transactionId,
			blockIds,
		};
		await this.chain.add(entry);
		return entry;
	}

	async getTrxContext(): Promise<BlockTrxContext> {
		// Read checkpoint rev from the tail block
		const tail = await this.chain.getTail();
		return tail.checkpointRev;
	}

	getId() {
		return this.chain.id;
	}

	private static getChainOptions(store: BlockStore<IBlock>) {
		return {
			createDataBlock: () => ({ block: store.createBlockHeader(LogDataBlockType) }),
			createHeaderBlock: (id?: BlockId) => ({ block: store.createBlockHeader(LogHeaderBlockType, id) }),
		};
	}
}
