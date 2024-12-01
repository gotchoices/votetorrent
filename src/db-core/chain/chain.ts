import { Atomic, BlockStore, apply, BlockId, IBlock, BlockType } from "../index.js";
import { EntriesPerBlock, ChainDataBlockType, ChainHeaderBlockType, ChainDataBlock, ChainHeaderBlock } from "./struct.js";

export type ChainInitOptions<TEntry> = {
	createDataBlock?: () => Partial<ChainDataBlock<TEntry>>;
	createHeaderBlock?: (id?: BlockId) => Partial<ChainHeaderBlock>;
}

export type ChainCreateOptions<TEntry> = ChainInitOptions<TEntry> & {
	newId?: BlockId;
};

// TODO: Generalize the header access so that it can be merged with upstream header (e.g. collection header) and thus avoid another level of indirection

/** Represents a chain of blocks, forming a stack, queue, or log. */
export class Chain<TEntry> {
	constructor(
		readonly store: BlockStore<IBlock>,
		public readonly id: BlockId,
		private readonly options?: ChainInitOptions<TEntry>,
	) {
	}

	/** Creates a new queue, with an optional given id. */
	static async create<TEntry>(store: BlockStore<IBlock>, options?: ChainCreateOptions<TEntry>) {
		const tailBlock = {
			...(options?.createDataBlock?.() ?? (() => ({ block: store.createBlockHeader(ChainDataBlockType) }))),
		} as ChainDataBlock<TEntry>;
		const headerBlock = {
			...(options?.createHeaderBlock?.(options?.newId) ?? ((id: BlockId) => ({ block: store.createBlockHeader(ChainHeaderBlockType, id) }))),
			headId: tailBlock.block.id,
			tailId: tailBlock.block.id,
		} as ChainHeaderBlock;
		store.insert(headerBlock);
		store.insert(tailBlock);
		return new Chain<TEntry>(store, headerBlock.block.id, options);
	}

	/**
	 * Adds entries to the tail (last-in end) of the chain.  Equivalent of enqueue or push.
	 * @param entries - The entries to add.
	 */
	async add(...entries: TEntry[]) {
		const header = await this.getHeader();
		const oldTail = await this.getTail(header);
		let tail = oldTail;

		const trx = new Atomic(this.store);

		// Attempt to fit in current block
		const copied = entries.slice(0, EntriesPerBlock - tail.entries.length);
		if (copied.length > 0) {
			apply(trx, tail, ['entries', tail.entries.length, 0, copied]);
			entries = entries.slice(copied.length);
		}

		while (entries.length > 0) {
			const newTail = {
				...(this.options?.createDataBlock?.() ?? (() => ({ block: this.store.createBlockHeader(ChainDataBlockType) }))),
				entries: entries.slice(0, Math.min(EntriesPerBlock, entries.length)),
				priorId: undefined,
				nextId: tail.block.id,	// Tail's next is the old tail
			} as ChainDataBlock<TEntry>;
			trx.insert(newTail);
			apply(trx, tail, ['priorId', 0, 0, newTail.block.id]);
			tail = newTail;
			entries = entries.slice(newTail.entries.length);
		}

		if (tail !== oldTail) {
			apply(trx, header, ['tailId', 0, 0, tail.block.id]);
		}

		trx.commit();

		return { tail /*: structuredClone(tail) */ }; // not going to incur the cost of deep cloning, but don't mutate
	}

	/**
	 * Removes up to n entries from the tail (last-in end) of the chain.
	 * @param n - The number of entries to remove.
	 * @returns An array of the removed entries. May be less than n if the chain is exhausted.
	 */
	async pop(n = 1) {
		if (n <= 0) {
			return [];
		}

		const header = await this.getHeader();
		const oldTail = await this.getTail(header);
		let tail = oldTail;
		const result = [];

		const trx = new Atomic(this.store);

		while (n > 0) {
			if (tail.entries.length > n) { // Partial removal
				const removed = tail.entries.slice(-n);
				result.unshift(...removed);
				apply(trx, tail, ['entries', tail.entries.length - n, n, []]);
				break;
			} else {	// Entire block removal
				result.unshift(...tail.entries);
				n -= tail.entries.length;
				if (tail.nextId) {
					trx.delete(tail.block.id);
					tail = await trx.tryGet(tail.nextId) as ChainDataBlock<TEntry>;
					apply(trx, tail, ['priorId', 0, 0, undefined]);
				} else {	// No more blocks... just empty what's left
					apply(trx, tail, ['entries', 0, tail.entries.length, []]);
					break;
				}
			}
		}

		if (tail !== oldTail) {
			apply(trx, header, ['tailId', 0, 0, tail.block.id]);
		}

		trx.commit();

		return result;
	}

	/**
	 * Removes up to n entries from the head (first-in end) of the queue.
	 * @param n - The number of entries to remove.
	 * @returns An array of the removed entries.  May be less than n if the queue is exhausted.
	 */
	async dequeue(n = 1) {
		if (n <= 0) {
			return [];
		}

		const trx = new Atomic(this.store);

		const header = await this.getHeader();
		const oldHead = await this.getHead(header);
		let head = oldHead;
		const result = [];

		while (n > 0) {
			if (head.entries.length > n) {	// Subsumes part of block
				result.push(...head.entries.slice(0, n));
				apply(trx, head, ['entries', 0, n, []]);
				break;
			} else {	// Subsumes entire block
				result.push(...head.entries);
				n -= head.entries.length;
				if (head.nextId) {
					trx.delete(head.block.id);
					head = await trx.tryGet(head.nextId) as ChainDataBlock<TEntry>;
					apply(trx, head, ['nextId', 0, 0, undefined]);
				} else {	// No more blocks... just empty what's left
					apply(trx, head, ['entries', 0, head.entries.length, []]);
					break;
				}
			}
		}
		if (head !== oldHead) {
			apply(trx, header, ['headId', 0, 0, head.block.id]);
		}

		trx.commit();

		return result;
	}

	async getTail(header?: ChainHeaderBlock) {
		const actualHeader = header ?? await this.getHeader();
		let tail = await this.store.tryGet(actualHeader.tailId) as ChainDataBlock<TEntry>;
		// Possible that the block has filled between reading the header and reading the block... follow priorId links to find true end
		while (tail.priorId) {
			tail = await this.store.tryGet(tail.priorId) as ChainDataBlock<TEntry>;
		}
		return tail;
	}

	async getHead(header?: ChainHeaderBlock) {
		const actualHeader = header ?? await this.getHeader();
		let head = await this.store.tryGet(actualHeader.headId) as ChainDataBlock<TEntry>;
		while (head.nextId) {
			head = await this.store.tryGet(head.nextId) as ChainDataBlock<TEntry>;
		}
		return head;
	}

	async getHeader() {
		return await this.store.tryGet(this.id) as ChainHeaderBlock;
	}
}
