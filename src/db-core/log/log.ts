import { Chain, LogEntry, BlockStore, IBlock, BlockId, TransactionId, LogHeaderBlockType, LogDataBlockType, ChainInitOptions, BlockTrxContext, ChainDataBlock, ActionEntry } from "../index.js";

export class Log<TAction> {
	protected constructor(
		private readonly chain: Chain<LogEntry<TAction>>,
		private readonly store: BlockStore<IBlock>,
	) {
	}

	/** Opens a presumably existing log. */
	static open<TAction>(store: BlockStore<IBlock>, id: BlockId) {
		return new Log<TAction>(new Chain(store, id, Log.getChainOptions(store)), store);
	}

	/** Creates a new log. */
	static async create<TAction>(store: BlockStore<IBlock>, newId?: BlockId) {
		return new Log<TAction>(await Chain.create<LogEntry<TAction>>(store, { ...Log.getChainOptions(store), newId }), store);
	}

	/** Adds a new entry to the log. */
	async add(actions: TAction[], transactionId: TransactionId, blockIds: BlockId[] = [], timestamp: number = Date.now()) {
		const entry = { actions, timestamp, transactionId, blockIds };
		const addResult = await this.chain.add(entry);
		return { entry, tailId: addResult.tail.block.id };
	}

	/** Gets the transaction context of the log. */
	async getTrxContext(): Promise<BlockTrxContext> {
		// Scan from the head until the first checkpoint is found
		const header = await this.chain.getHeader();
		const tail = await this.chain.getTail(header);

		const checkpoint = await this.findCheckpoint(tail);
		if (!checkpoint) {
			return { pendingIds: [], rev: 0 };
		}

		// Find the first action entry prior to the checkpoint
		const action = await this.findAction(checkpoint);
		if (!action) {
			return { pendingIds: checkpoint.pendings, rev: 0 };
		}

		return { pendingIds: checkpoint.pendings, rev: action.rev };
	}

	/** Gets the actions from startRev, to latest in the log. */
	async getFrom(startRev: number): Promise<{ context: BlockTrxContext, entries: ActionEntry<TAction>[] }> {
		const header = await this.chain.getHeader();
		const tail = await this.chain.getTail(header);

		const checkpoint = await this.findCheckpoint(tail);
		if (!checkpoint) {
			return { context: { pendingIds: [], rev: 0 }, entries: [] };
		}

		const action = await this.findAction(checkpoint);
		if (!action || action.rev <= startRev) {
			return { context: { pendingIds: checkpoint.pendings, rev: action?.rev ?? 0 }, entries: [] };
		}

		let block = action.block;
		let endIndex = action.index + 1;	// inclusive
		const deltas: ActionEntry<TAction>[] = [];
		while (true) {
			const leading = block.entries.slice(0, endIndex);
			const startIndex = leading.findLastIndex(e => e.action && e.action.rev <= startRev);
			deltas.push(...leading.slice(startIndex >= 0 ? startIndex + 1 : 0).filter(e => e.action).map(e => e.action!));
			if (startIndex >= 0) {
				return { context: { pendingIds: checkpoint.pendings, rev: action.rev }, entries: deltas.reverse() };
			}
			if (block.nextId) {
				block = await this.store.tryGet(block.nextId) as ChainDataBlock<LogEntry<TAction>>;
				endIndex = block.entries.length;
			} else {
				return { context: { pendingIds: checkpoint.pendings, rev: action.rev }, entries: deltas.reverse() };
			}
		}
	}

	/** Finds the most recent checkpoint in the log, starting from the given block. */
	private async findCheckpoint(block: ChainDataBlock<LogEntry<TAction>>) {
		const pendings = new Set<TransactionId>();
		while (true) {
			const index = block.entries.findLastIndex(e => e.checkpoint);
			if (index >= 0) {
				block.entries[index].checkpoint!.pendingIds.forEach(pendings.add.bind(pendings));
				block.entries.slice(index + 1).forEach(e => pendings.add(e.action!.transactionId));
				return { block, index, pendings: Array.from(pendings) };
			} else {	// Navigate to the next block
				if (block.nextId) {
					block = await this.store.tryGet(block.nextId) as ChainDataBlock<LogEntry<TAction>>;
				} else {
					return undefined;
				}
			}
		}
	}

	/** Finds the first action entry prior to the given checkpoint. */
	private async findAction(checkpoint: { block: ChainDataBlock<LogEntry<TAction>>, index: number }) {
		let block = checkpoint.block;
		let endIndex = checkpoint.index;
		while (true) {
			const index = block.entries.slice(0, endIndex).findLastIndex(e => e.action);
			if (index >= 0) {
				return { block, index, rev: block.entries[index].action!.rev };
			}
			if (block.nextId) {
				block = await this.store.tryGet(block.nextId) as ChainDataBlock<LogEntry<TAction>>;
				endIndex = block.entries.length;
			} else {
				return undefined;
			}
		}
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
