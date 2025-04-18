import type { IBlock, Action, ActionType, ActionHandler, BlockId, ITransactor, ActionEntry, BlockStore } from "../index.js";
import { Log, Atomic, Tracker, copyTransforms, CacheSource, isTransformsEmpty, TransactorSource, blockIdsForTransforms, transformsFromTransform } from "../index.js";
import type { CollectionHeaderBlock, CollectionId, ICollection } from "./index.js";
import { randomBytes } from '@libp2p/crypto';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import { Latches } from "../utility/latches.js";

const PendingRetryDelayMs = 100;

export type CollectionInitOptions<TAction> = {
	modules: Record<ActionType, ActionHandler<TAction>>;
	createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => IBlock;
	/** Called for each local action that is potentially in conflict with a remote action.
	 * @param action - The local action to check
	 * @param potential - The remote action that is potentially in conflict
	 * @returns The original action, a replacement action (return a new instance; will be
	 * 	applied through act()), or undefined to discard this action
	 */
	filterConflict?: (action: Action<TAction>, potential: Action<TAction>[]) => Action<TAction> | undefined
}

export class Collection<TAction> implements ICollection<TAction> {
	private pending: Action<TAction>[] = [];

	protected constructor(
		public readonly id: CollectionId,
		public readonly transactor: ITransactor,
		private readonly handlers: Record<ActionType, ActionHandler<TAction>>,
		private readonly source: TransactorSource<IBlock>,
		/** Cache of unmodified blocks from the source */
		private readonly sourceCache: CacheSource<IBlock>,
		/** Tracked Changes */
		public readonly tracker: Tracker<IBlock>,
		private readonly filterConflict?: (action: Action<TAction>, potential: Action<TAction>[]) => Action<TAction> | undefined,
	) {
	}

	static async createOrOpen<TAction>(transactor: ITransactor, id: CollectionId, init: CollectionInitOptions<TAction>) {
		// Start with a context that has an infinite revision number to ensure that we always fetch the latest log information
		const source = new TransactorSource(id, transactor, undefined);
		const sourceCache = new CacheSource(source);
		const tracker = new Tracker(sourceCache);
		const header = await source.tryGet(id) as CollectionHeaderBlock | undefined;

		if (header) {	// Collection already exists
			const log = (await Log.open<Action<TAction>>(tracker, id))!;
			source.trxContext = await log.getTrxContext();
		} else {	// Collection does not exist
			const headerBlock = init.createHeaderBlock(id, tracker);
			tracker.insert(headerBlock);
			source.trxContext = undefined;
			await Log.open<Action<TAction>>(tracker, id);
		}

		return new Collection(id, transactor, init.modules, source, sourceCache, tracker, init.filterConflict);
	}

	async act(...actions: Action<TAction>[]) {
		await this.internalTransact(...actions);
		this.pending.push(...actions);
	}

	private async internalTransact(...actions: Action<TAction>[]) {
		const trx = new Atomic(this.tracker);

		for (const action of actions) {
			const handler = this.handlers[action.type];
			if (!handler) {
				throw new Error(`No handler for action type ${action.type}`);
			}
			await handler(action, trx);
		}

		trx.commit();
	}

	/** Load external changes and update our context to the latest log revision - resolve any conflicts with our pending actions. */
	async update() {
		// Start with a context that can see to the end of the log
		const source = new TransactorSource(this.id, this.transactor, undefined);
		const tracker = new Tracker(source);

		// Get the latest entries from the log, starting from where we left off
		const trxContext = this.source.trxContext;
		const log = await Log.open<Action<TAction>>(tracker, this.id);
		const latest = log ? await log.getFrom(trxContext?.rev ?? 0) : undefined;

		// Process the entries and track the blocks they affect
		let anyConflicts = false;
		for (const entry of latest?.entries ?? []) {
			// Filter any pending actions that conflict with the remote actions
			this.pending = this.pending.map(p => this.doFilterConflict(p, entry.actions) ? p : undefined)
				.filter(Boolean) as Action<TAction>[];
			this.sourceCache.clear(entry.blockIds);
			anyConflicts = anyConflicts || tracker.conflicts(new Set(entry.blockIds)).length > 0;
		}

		// On conflicts, clear related caching and block-tracking and replay logical operations
		if (anyConflicts) {
			await this.replayActions();
		}

		// Update our context to the latest
		this.source.trxContext = latest?.context;
	}

	/** Push our pending actions to the transactor */
	async sync() {
		const lockId = `Collection.sync:${this.id}`;
		const release = await Latches.acquire(lockId);
		try {
			const bytes = randomBytes(16);
			const trxId = uint8ArrayToString(bytes, 'base64url');

			while (this.pending.length || !isTransformsEmpty(this.tracker.transforms)) {
				// Snapshot the pending actions so that any new actions aren't assumed to be part of this transaction
				const pending = [...this.pending];

				// Create a snapshot tracker for the transaction, so that we can ditch the log changes if we have to retry the transaction
				const snapshot = copyTransforms(this.tracker.transforms);
				const tracker = new Tracker(this.sourceCache, snapshot);

				// Add the transaction to the log (in local tracking space)
				const log = await Log.open<Action<TAction>>(tracker, this.id);
				if (!log) {
					throw new Error(`Log not found for collection ${this.id}`);
				}
				const newRev = (this.source.trxContext?.rev ?? 0) + 1;
				const addResult = await log.addActions(pending, trxId, newRev, () => tracker.transformedBlockIds());

				// Commit the transaction to the transactor
				const staleFailure = await this.source.transact(tracker.transforms, trxId, newRev, this.id, addResult.tailPath.block.header.id);
				if (staleFailure) {
					if (staleFailure.pending) {
						// Wait for short time to allow the pending transactions to commit
						await new Promise(resolve => setTimeout(resolve, PendingRetryDelayMs));
					}
					await this.update();
				} else {
					// Clear the pending actions that were part of this transaction
					this.pending = this.pending.slice(pending.length);
					// Reset cache and replay any actions that were added during the transaction
					const transforms = tracker.reset();
					await this.replayActions();
					this.sourceCache.transformCache(transforms);
					this.source.trxContext = this.source.trxContext
						? { committed: [...this.source.trxContext.committed, { trxId, rev: newRev }], rev: newRev }
						: { committed: [{ trxId, rev: newRev }], rev: newRev };
				}
			}
		} finally {
			release();
		}
	}

	async updateAndSync() {
		// TODO: introduce timer and potentially change stats to determine when to sync, rather than always syncing
		await this.update();
		await this.sync();
	}

	async *selectLog(forward = true): AsyncIterableIterator<Action<TAction>> {
		const log = await Log.open<Action<TAction>>(this.tracker, this.id);
		if (!log) {
			throw new Error(`Log not found for collection ${this.id}`);
		}
		for await (const entry of log.select(undefined, forward)) {
			if (entry.action) {
				yield* forward ? entry.action.actions : entry.action.actions.reverse();
			}
		}
	}

	private async replayActions() {
		this.tracker.reset();
		// Because pending could be appended while we're async, we need to snapshot and repeat until empty
		while (this.pending.length) {
			const pending = [...this.pending];
			this.pending = [];
			await this.internalTransact(...pending);
		}
	}

	/** Called for each local action that may be in conflict with a remote action.
	 * @param action - The local action to check
	 * @param potential - The remote action that is potentially in conflict
	 * @returns true if the action should be kept, false to discard it
	 */
	protected doFilterConflict(action: Action<TAction>, potential: Action<TAction>[]) {
		if (this.filterConflict) {
			const replacement = this.filterConflict(action, potential);
			if (!replacement) {
				return false;
			} else if (replacement !== action) {
				this.act(replacement);
			}
		}
		return true;
	}
}
