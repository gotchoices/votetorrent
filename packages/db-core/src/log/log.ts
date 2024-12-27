import { createHash } from "node:crypto";
import { Chain, BlockStore, IBlock, BlockId, TrxId, BlockTrxContext, ChainDataBlock, CollectionId } from "../index.js";
import { LogEntry, ActionEntry, LogDataBlockType, LogHeaderBlockType } from "./index.js";

export type LogBlock<TAction> = ChainDataBlock<LogEntry<TAction>>
	& {
		/** Base64url encoded Sha256 hash of the next block - present on every block except the head */
		nextHash?: string,
	};

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
	async addActions(actions: TAction[], transactionId: TrxId, rev: number, blockIds: BlockId[] = [], collectionIds: CollectionId[] = [], timestamp: number = Date.now()) {
		const entry = { timestamp, action: { transactionId, rev, actions, blockIds, collectionIds } } as LogEntry<TAction>;
		const addResult = await this.chain.add(entry);
		return { entry, tailId: addResult.tail.block.id };
	}

	/** Adds a checkpoint to the log. */
	async addCheckpoint(pendingIds: TrxId[], timestamp: number = Date.now()) {
		const entry = { timestamp, checkpoint: { pendingIds } };
		const addResult = await this.chain.add(entry);
		return { entry, tailId: addResult.tail.block.id };
	}

	/** Gets the transaction context of the log. */
	async getTrxContext(): Promise<BlockTrxContext[] | undefined> {
		// Scan from the head until the first checkpoint is found
		const header = await this.chain.getHeader();
		const tail = await this.chain.getTail(header);

		const checkpoint = await this.findCheckpoint(tail);
		if (!checkpoint) {
			return undefined;
		}

		// Find the first action entry prior to the checkpoint
		const action = await this.findAction(checkpoint);
		if (!action) {
			return checkpoint.pendings.map(trxId => ({ trxId, rev: 0 }));
		}

		return checkpoint.pendings.map(trxId => ({ trxId, rev: action.rev }));
	}

	/** Gets the actions from startRev, to latest in the log. */
	async getFrom(startRev: number): Promise<{ context: BlockTrxContext | undefined, entries: ActionEntry<TAction>[] }> {
		const header = await this.chain.getHeader();
		const tail = await this.chain.getTail(header);

		const checkpoint = await this.findCheckpoint(tail);
		if (!checkpoint) {
			return { context: undefined, entries: [] };
		}

		const action = await this.findAction(checkpoint);
		if (!action || action.rev <= startRev) {
			return { context: { trxId: checkpoint.pendings, rev: action?.rev ?? 0 }, entries: [] };
		}

		let block = action.block;
		let endIndex = action.index + 1;	// inclusive
		const deltas: ActionEntry<TAction>[] = [];
		while (true) {
			const leading = block.entries.slice(0, endIndex);
			const startIndex = leading.findLastIndex(e => e.action && e.action.rev <= startRev);
			deltas.push(...leading.slice(startIndex >= 0 ? startIndex + 1 : 0).filter(e => e.action).map(e => e.action!));
			if (startIndex >= 0) {
				return { context: { trxId: checkpoint.pendings, rev: action.rev }, entries: deltas.reverse() };
			}
			if (block.nextId) {
				block = await this.store.tryGet(block.nextId) as LogBlock<TAction>;
				endIndex = block.entries.length;
			} else {
				return { context: { trxId: checkpoint.pendings, rev: action.rev }, entries: deltas.reverse() };
			}
		}
	}

	getId() {
		return this.chain.id;
	}

	/** Finds the most recent checkpoint in the log, starting from the given block. */
	private async findCheckpoint(block: LogBlock<TAction>) {
		const pendings = new Set<TrxId>();
		while (true) {
			const index = block.entries.findLastIndex(e => e.checkpoint);
			if (index >= 0) {
				block.entries[index].checkpoint!.pendingIds.forEach(pendings.add.bind(pendings));
				block.entries.slice(index + 1).forEach(e => pendings.add(e.action!.transactionId));
				return { block, index, pendings: Array.from(pendings) };
			} else {	// Navigate to the next block
				if (block.nextId) {
					block = await this.store.tryGet(block.nextId) as LogBlock<TAction>;
				} else {
					return undefined;
				}
			}
		}
	}

	/** Finds the first action entry prior to the given checkpoint. */
	private async findAction(checkpoint: { block: LogBlock<TAction>, index: number }) {
		let block = checkpoint.block;
		let endIndex = checkpoint.index;
		while (true) {
			const index = block.entries.slice(0, endIndex).findLastIndex(e => e.action);
			if (index >= 0) {
				return { block, index, rev: block.entries[index].action!.rev };
			}
			if (block.nextId) {
				block = await this.store.tryGet(block.nextId) as LogBlock<TAction>;
				endIndex = block.entries.length;
			} else {
				return undefined;
			}
		}
	}

	async *select(reverse = false): AsyncIterableIterator<LogEntry<TAction>> {
		const header = await this.chain.getHeader();
		let block: LogBlock<TAction> | undefined
			= reverse ? await this.chain.getTail(header) : await this.chain.getHead(header);

		while (block) {
			for (const entry of reverse ? block.entries.reverse() : block.entries) {
				yield entry;
			}
			block = reverse
				? block.nextId ? await this.store.tryGet(block.nextId) as LogBlock<TAction> : undefined
				: block.priorId ? await this.store.tryGet(block.priorId) as LogBlock<TAction> : undefined;
		}
	}

	private static getChainOptions<TAction>(store: BlockStore<IBlock>) {
		return {
			createDataBlock: () => ({ block: store.createBlockHeader(LogDataBlockType) }),
			createHeaderBlock: (id?: BlockId) => ({ block: store.createBlockHeader(LogHeaderBlockType, id) }),
			blockAdded: (newTail: LogBlock<TAction>, oldTail: LogBlock<TAction> | undefined) => {
				if (oldTail) {
					newTail.nextHash = createHash('sha256').update(JSON.stringify(oldTail)).digest('base64url');
				}
			},
		};
	}
}
