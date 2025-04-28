import { Atomic, type BlockStore, type BlockId, type IBlock } from "../index.js";
import { ChainDataBlockType, ChainHeaderBlockType, entries$, headId$, nextId$, priorId$, tailId$ } from "./chain-nodes.js";
import type { ChainDataNode, ChainHeaderNode } from "./chain-nodes.js";
import { apply } from "../blocks/index.js";

export const EntriesPerBlock = 32;

export type ChainPath<TEntry> = {
	headerBlock: ChainHeaderNode;
	block: ChainDataNode<TEntry>;
	index: number; // Index of the entry in the block
};

export type ChainNodeInit<T> = IBlock & {
	[K in keyof Omit<T, keyof IBlock>]?: T[K];
};

export type ChainInitOptions<TEntry> = {
	createDataBlock?: () => ChainNodeInit<ChainDataNode<TEntry>>;
	createHeaderBlock?: (id?: BlockId) => ChainNodeInit<ChainHeaderNode>;
	newBlock?: (newTail: ChainDataNode<TEntry>, oldTail: ChainDataNode<TEntry> | undefined) => Promise<void>;
}

export type ChainCreateOptions<TEntry> = ChainInitOptions<TEntry> & {
	newId?: BlockId;
};

// TODO: Generalize the header access so that it can be merged with upstream header (e.g. collection header) and thus avoid another level of indirection

/** Represents a chain of blocks, forming a stack, queue, or log. */
export class Chain<TEntry> {
	private constructor(
		readonly store: BlockStore<IBlock>,
		public readonly id: BlockId,
		private readonly options?: ChainInitOptions<TEntry>,
	) {
	}

	/** Creates a new queue, with an optional given id. */
	static async create<TEntry>(store: BlockStore<IBlock>, options?: ChainCreateOptions<TEntry>) {
		const tailBlock = Chain.createTailBlock<TEntry>(store, options);
		const headerBlock = {
			...(options?.createHeaderBlock?.(options?.newId) ?? { header: store.createBlockHeader(ChainHeaderBlockType, options?.newId) }),
			headId: tailBlock.header.id,
			tailId: tailBlock.header.id,
		} as ChainHeaderNode;
		store.insert(headerBlock);
		store.insert(tailBlock);
		return new Chain<TEntry>(store, headerBlock.header.id, options);
	}

	private static createTailBlock<TEntry>(store: BlockStore<IBlock>, options: ChainCreateOptions<TEntry> | undefined) {
		return {
			...(options?.createDataBlock?.() ?? { header: store.createBlockHeader(ChainDataBlockType) }),
			entries: [] as TEntry[],
			priorId: undefined,
			nextId: undefined,
		} as ChainDataNode<TEntry>;
	}

	/** Opens an existing chain, verifying and potentially initializing the header. */
	static async open<TEntry>(store: BlockStore<IBlock>, id: BlockId, options?: ChainInitOptions<TEntry>): Promise<Chain<TEntry> | undefined> {
		const headerBlock = await store.tryGet(id) as ChainHeaderNode | undefined;
		if (!headerBlock) {
			return undefined;
		}

		// If the header block is missing headId or tailId, create a tail block and update the header
		const headerAny = headerBlock as any; // Use 'any' for easier property checking/setting
		if (!Object.hasOwn(headerAny, 'headId') || !Object.hasOwn(headerAny, 'tailId')) {
			const tailBlock = Chain.createTailBlock<TEntry>(store, options);
			store.insert(tailBlock);
			apply(store, headerBlock, [headId$, 0, 0, tailBlock.header.id]);
			apply(store, headerBlock, [tailId$, 0, 0, tailBlock.header.id]);
		}

		return new Chain<TEntry>(store, id, options);
	}

	/**
	 * Adds entries to the tail (last-in end) of the chain.  Equivalent of enqueue or push.
	 * @param entries - The entries to add.
	 * @returns Path to the new tail of the chain (entry just past the end).
	 */
	async add(...entries: TEntry[]): Promise<ChainPath<TEntry>> {
		const path = await this.getTail();
		if (!path) {
			throw new Error("Cannot add to non-existent chain");
		}

		const { headerBlock, block: oldTail } = path;
		let tail = oldTail;

		const trx = new Atomic(this.store);

		// Attempt to fit in current block
		const copied = entries.slice(0, EntriesPerBlock - tail.entries.length);
		if (copied.length > 0) {
			apply(trx, tail, [entries$, tail.entries.length, 0, copied]);
			entries = entries.slice(copied.length);
		}

		while (entries.length > 0) {
			const newTail = {
				...(this.options?.createDataBlock?.() ?? { header: this.store.createBlockHeader(ChainDataBlockType) }),
				entries: entries.splice(0, Math.min(EntriesPerBlock, entries.length)),
				priorId: tail.header.id,
				nextId: undefined,
			} as ChainDataNode<TEntry>;
			await this.options?.newBlock?.(newTail, oldTail);
			trx.insert(newTail);
			apply(trx, tail, [nextId$, 0, 0, newTail.header.id]);
			tail = newTail;
		}

		if (tail !== oldTail) {
			apply(trx, headerBlock, [tailId$, 0, 0, tail.header.id]);
		}

		trx.commit();

		return { headerBlock, block: tail, index: tail.entries.length - 1 };
	}

	/** Updates the entry at the given path. */
	updateAt(path: ChainPath<TEntry>, entry: TEntry) {
		if (!pathValid(path)) {
			throw new Error("Invalid path");
		}
		const { index, block } = path;
		apply(this.store, block, [entries$, index, 1, [entry]]);
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

		const path = await this.getTail();
		if (!path) {
			return [];
		}

		const { headerBlock, block: oldTail } = path;
		let tail = oldTail;
		const result = [];

		const trx = new Atomic(this.store);

		while (n > 0) {
			if (tail.entries.length > n) { // Partial removal
				const removed = tail.entries.slice(-n);
				result.unshift(...removed);
				apply(trx, tail, [entries$, tail.entries.length - n, n, []]);
				break;
			} else {	// Entire block removal
				result.unshift(...tail.entries);
				n -= tail.entries.length;
				if (tail.priorId) {
					trx.delete(tail.header.id);
					tail = await trx.tryGet(tail.priorId) as ChainDataNode<TEntry>;
					apply(trx, tail, [nextId$, 0, 0, undefined]);
				} else {	// No more blocks... just empty what's left
					apply(trx, tail, [entries$, 0, tail.entries.length, []]);
					break;
				}
			}
		}

		if (tail !== oldTail) {
			apply(trx, headerBlock, [tailId$, 0, 0, tail.header.id]);
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

		const path = await this.getHead();
		if (!path) {
			return [];
		}

		const { headerBlock, block: oldHead } = path;
		let head = oldHead;
		const result = [];

		while (n > 0) {
			if (head.entries.length > n) {	// Consumes part of block
				result.push(...head.entries.slice(0, n));
				apply(trx, head, [entries$, 0, n, []]);
				break;
			} else {	// Consumes entire block
				result.push(...head.entries);
				n -= head.entries.length;
				if (head.nextId) {
					trx.delete(head.header.id);
					head = await trx.tryGet(head.nextId) as ChainDataNode<TEntry>;
					apply(trx, head, [priorId$, 0, 0, undefined]);
				} else {	// No more blocks... just empty what's left
					apply(trx, head, [entries$, 0, head.entries.length, []]);
					break;
				}
			}
		}
		if (head !== oldHead) {
			apply(trx, headerBlock, [headId$, 0, 0, head.header.id]);
		}

		trx.commit();

		return result;
	}

	/** Iterates over the chain, starting at the given path, or the head or tail if not given.
	 * If forward is true (default), the iteration is from head (oldest) to tail (latest); otherwise, it is from tail to head.
	 */
	async *select(starting?: ChainPath<TEntry>, forward = true): AsyncIterableIterator<ChainPath<TEntry>> {
		const path = starting ?? (forward ? await this.getHead() : await this.getTail());
		if (!path) {
			return;
		}
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
		const priorBlock = await this.store.tryGet(block.priorId) as ChainDataNode<TEntry>;
		return {
			headerBlock,
			block: priorBlock,
			index: priorBlock.entries.length - 1,
		};
	}

	async getTail(header?: ChainHeaderNode): Promise<ChainPath<TEntry> | undefined> {
		const headerBlock = header ?? await this.getHeader();
		let tail = headerBlock ? await this.store.tryGet(headerBlock.tailId) as ChainDataNode<TEntry> : undefined;
		// Possible that the block has filled between reading the header and reading the block... follow nextId links to find true end
		while (tail?.nextId) {
			tail = await this.store.tryGet(tail.nextId) as ChainDataNode<TEntry>;
		}
		return tail ? { headerBlock, block: tail, index: tail.entries.length - 1 } as ChainPath<TEntry> : undefined;
	}


	async getHead(header?: ChainHeaderNode): Promise<ChainPath<TEntry> | undefined> {
		const headerBlock = header ?? await this.getHeader();
		let head = headerBlock ? await this.store.tryGet(headerBlock.headId) as ChainDataNode<TEntry> : undefined;
		// Possible that the block has filled between reading the header and reading the block... follow priorId links to find true start
		while (head?.priorId) {
			head = await this.store.tryGet(head.priorId) as ChainDataNode<TEntry>;
		}
		return head ? { headerBlock, block: head, index: 0 } as ChainPath<TEntry> : undefined;
	}


	async getHeader() {
		return await this.store.tryGet(this.id) as ChainHeaderNode | undefined;
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
