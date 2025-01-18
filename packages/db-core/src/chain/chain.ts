import { Atomic, type BlockStore, type BlockId, type IBlock } from "../index.js";
import { ChainDataBlockType, ChainHeaderBlockType } from "./chain-nodes.js";
import type { ChainDataNode, ChainHeaderNode } from "./chain-nodes.js";
import { apply } from "../blocks/index.js";

export const EntriesPerBlock = 32;

export type ChainPath<TEntry> = {
	headerBlock: ChainHeaderNode;
	block: ChainDataNode<TEntry>;
	index: number; // Index of the entry in the block
};

export type ChainInitOptions<TEntry> = {
	createDataBlock?: () => Partial<ChainDataNode<TEntry>>;
	createHeaderBlock?: (id?: BlockId) => Partial<ChainHeaderNode>;
	blockAdded?: (newTail: ChainDataNode<TEntry>, oldTail: ChainDataNode<TEntry> | undefined) => Promise<void>;
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
			...(options?.createDataBlock?.() ?? { header: store.createBlockHeader(ChainDataBlockType) }),
			entries: [],
		} as ChainDataNode<TEntry>;
		const headerBlock = {
			...(options?.createHeaderBlock?.(options?.newId) ?? { header: store.createBlockHeader(ChainHeaderBlockType, options?.newId) }),
			headId: tailBlock.header.id,
			tailId: tailBlock.header.id,
		} as ChainHeaderNode;
		store.insert(headerBlock);
		store.insert(tailBlock);
		return new Chain<TEntry>(store, headerBlock.header.id, options);
	}

	/**
	 * Adds entries to the tail (last-in end) of the chain.  Equivalent of enqueue or push.
	 * @param entries - The entries to add.
	 * @returns Path to the new tail of the chain (entry just past the end).
	 */
	async add(...entries: TEntry[]): Promise<ChainPath<TEntry>> {
		const { headerBlock, block: oldTail } = await this.getTail();
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
				...(this.options?.createDataBlock?.() ?? { header: this.store.createBlockHeader(ChainDataBlockType) }),
				entries: entries.slice(0, Math.min(EntriesPerBlock, entries.length)),
				priorId: undefined,
				nextId: tail.header.id,	// Tail's next is the old tail
			} as ChainDataNode<TEntry>;
			trx.insert(newTail);
			apply(trx, tail, ['priorId', 0, 0, newTail.header.id]);
			await this.options?.blockAdded?.(newTail, oldTail);
			tail = newTail;
			entries = entries.slice(newTail.entries.length);
		}

		if (tail !== oldTail) {
			apply(trx, headerBlock, ['tailId', 0, 0, tail.header.id]);
		}

		trx.commit();

		return { headerBlock, block: tail, index: tail.entries.length };
	}

	/**
	 * Removes up to n entries from the tail (last-in end) of the chain.
	 * @param n - The number of entries to remove.  If n is greater than the number of entries in the chain, the chain is emptied with no error.
	 * @returns An array of the removed entries. May be less than n if the chain is exhausted.
	 */
	async pop(n = 1) {
		if (n <= 0) {
			return [];
		}

		const { headerBlock, block: oldTail } = await this.getTail();
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
					trx.delete(tail.header.id);
					tail = await trx.tryGet(tail.nextId) as ChainDataNode<TEntry>;
					apply(trx, tail, ['priorId', 0, 0, undefined]);
				} else {	// No more blocks... just empty what's left
					apply(trx, tail, ['entries', 0, tail.entries.length, []]);
					break;
				}
			}
		}

		if (tail !== oldTail) {
			apply(trx, headerBlock, ['tailId', 0, 0, tail.header.id]);
		}

		trx.commit();

		return result;
	}

	/**
	 * Removes up to n entries from the head (first-in end) of the queue.
	 * @param n - The number of entries to remove.  If n is greater than the number of entries in the chain, the chain is emptied with no error.
	 * @returns An array of the removed entries.  May be less than n if the queue is exhausted.
	 */
	async dequeue(n = 1) {
		if (n <= 0) {
			return [];
		}

		const trx = new Atomic(this.store);

		const { headerBlock, block: oldHead } = await this.getHead();
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
					trx.delete(head.header.id);
					head = await trx.tryGet(head.nextId) as ChainDataNode<TEntry>;
					apply(trx, head, ['nextId', 0, 0, undefined]);
				} else {	// No more blocks... just empty what's left
					apply(trx, head, ['entries', 0, head.entries.length, []]);
					break;
				}
			}
		}
		if (head !== oldHead) {
			apply(trx, headerBlock, ['headId', 0, 0, head.header.id]);
		}

		trx.commit();

		return result;
	}

	async *select(starting?: ChainPath<TEntry>, forward = true): AsyncIterableIterator<ChainPath<TEntry>> {
		const path = starting ?? (forward ? await this.getTail() : await this.getHead());
		let block: ChainDataNode<TEntry> | undefined = path.block;

		let index = path.index;
		if (forward) {
			while (block) {
				for (; index < block.entries.length; ++index) {
					yield { headerBlock: path.headerBlock, block, index };
				}
				block = block.nextId ? await this.store.tryGet(block.nextId) as ChainDataNode<TEntry> : undefined;
				index = 0;
			}
		} else {
			while (block) {
				for (; index >= 0; --index) {
					yield { headerBlock: path.headerBlock, block, index };
				}
				block = block.priorId ? await this.store.tryGet(block.priorId) as ChainDataNode<TEntry> : undefined;
				index = (block?.entries.length ?? 0) - 1;
			}
		}
	}

	/** Returns the next entry in the chain; returns an off-the-end path if the end is reached. */
	async next(path: ChainPath<TEntry>) {
		const { headerBlock, block, index } = path;
		if (index < block.entries.length - 1 || !block.nextId) {
			return { headerBlock, block, index: index + 1 };
		}
		return {
			headerBlock,
			block: await this.store.tryGet(block.nextId) as ChainDataNode<TEntry>,
			index: 0,
		};
	}

	/** Returns the previous entry in the chain; returns an off-the-start path if the start is reached. */
	async prev(path: ChainPath<TEntry>) {
		const { headerBlock, block, index } = path;
		if (index > 0 || !block.priorId) {
			return { headerBlock, block, index: index - 1 };
		}
		return {
			headerBlock,
			block: await this.store.tryGet(block.priorId) as ChainDataNode<TEntry>,
			index: block.entries.length - 1,
		};
	}

	async getTail(header?: ChainHeaderNode): Promise<ChainPath<TEntry>> {
		const headerBlock = header ?? await this.getHeader();
		let tail = await this.store.tryGet(headerBlock.tailId) as ChainDataNode<TEntry>;
		// Possible that the block has filled between reading the header and reading the block... follow priorId links to find true end
		while (tail?.priorId) {
			tail = await this.store.tryGet(tail.priorId) as ChainDataNode<TEntry>;
		}
		return { headerBlock, block: tail, index: tail.entries.length - 1 };
	}

	async getHead(header?: ChainHeaderNode): Promise<ChainPath<TEntry>> {
		const headerBlock = header ?? await this.getHeader();
		let head = await this.store.tryGet(headerBlock.headId) as ChainDataNode<TEntry>;
		// Possible that the block has filled between reading the header and reading the block... follow nextId links to find true start
		while (head.nextId) {
			head = await this.store.tryGet(head.nextId) as ChainDataNode<TEntry>;
		}
		return { headerBlock, block: head, index: 0 };
	}

	async getHeader() {
		return await this.store.tryGet(this.id) as ChainHeaderNode;
	}
}

/** Returns true if the given path is located on an entry (not a crack). */
export function pathValid<TEntry>(path: ChainPath<TEntry>) {
	return path.block.entries.length > path.index && path.index >= 0;
}

/** Gets the entry at the given path; undefined if the path is not valid. */
export function entryAt<TEntry>(path: ChainPath<TEntry>): TEntry | undefined {
	return path.block.entries[path.index];
}
