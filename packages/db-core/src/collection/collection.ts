import type { IBlock, Action, ActionType, ActionHandler, BlockId, ITransactor, ActionEntry, BlockStore } from "../index.js";
import { Log, Atomic, Tracker, copyTransforms, CacheSource, isTransformsEmpty, TransactorSource } from "../index.js";
import type { CollectionHeaderBlock, CollectionId, ICollection } from "./index.js";
import { randomBytes } from '@libp2p/crypto';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

const PendingRetryDelayMs = 100;

export type CollectionInitOptions<TAction> = {
	modules: Record<ActionType, ActionHandler<TAction>>;
	createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => IBlock;
}

export class Collection<TAction> implements ICollection<TAction> {
	private readonly pending: Action<TAction>[] = [];

	protected constructor(
		public readonly id: CollectionId,
		public readonly transactor: ITransactor,
		public readonly logId: BlockId,
		private readonly handlers: Record<ActionType, ActionHandler<TAction>>,
		private readonly source: TransactorSource<IBlock>,
		/** Cache of unmodified blocks from the source */
		private readonly sourceCache: CacheSource<IBlock>,
		/** Tracked Changes */
		public readonly tracker: Tracker<IBlock>,
	) {
	}

	static async createOrOpen<TAction>(transactor: ITransactor, id: CollectionId, init: CollectionInitOptions<TAction>) {
		// Start with a context that has an infinite revision number to ensure that we always fetch the latest log information
		const source = new TransactorSource(id, transactor, undefined);
		const sourceCache = new CacheSource(source);
		const tracker = new Tracker(sourceCache);
		const header = await source.tryGet(id) as CollectionHeaderBlock | undefined;
		let logId: BlockId;

		if (header) {	// Collection already exists
			logId = header.logId;
			const log = Log.open<Action<TAction>>(tracker, logId);
			source.trxContext = await log.getTrxContext();
		} else {	// Collection does not exist
			source.trxContext = undefined;
			logId = source.generateId();
			const newHeader = {
				...init.createHeaderBlock(id, tracker),
				logId,
			};
			await Log.create<Action<TAction>>(tracker, logId);
			tracker.insert(newHeader);
		}

		return new Collection(id, transactor, logId, init.modules, source, sourceCache, tracker);
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
		const log = Log.open<Action<TAction>>(tracker, this.logId);
		const latest = await log.getFrom(trxContext?.rev ?? 0);

		// Process the entries and track the blocks they affect
		let anyConflicts = false;
		for (const entry of latest.entries) {
			this.processUpdateAction(entry);
			this.sourceCache.clear(entry.blockIds);
			anyConflicts = anyConflicts || tracker.conflicts(new Set(entry.blockIds)).length > 0;
		}

		// On conflicts, clear related caching and block-tracking and replay logical operations
		if (anyConflicts) {
			await this.replayActions();
		}

		// Update our context to the latest
		this.source.trxContext = latest.context;
	}

	/** Push our pending actions to the transactor */
	async sync() {
		const bytes = randomBytes(16);
		const trxId = uint8ArrayToString(bytes, 'base64url');

		while (this.pending.length || !isTransformsEmpty(this.tracker.transforms)) {
			// Create a snapshot tracker for the transaction, so that we can ditch the log changes if we have to retry the transaction
			const snapshot = copyTransforms(this.tracker.transforms);
			const tracker = new Tracker(this.sourceCache, snapshot);

			// Add the transaction to the log
			const log = Log.open<Action<TAction>>(tracker, this.logId);
			const newRev = (this.source.trxContext?.rev ?? 0) + 1;
			const addResult = await log.addActions(this.pending, trxId, newRev, () => tracker.transformedBlockIds());

			// Commit the transaction to the transactor
			const staleFailure = await this.source.transact(tracker.transforms, trxId, newRev, this.id, addResult.tailPath.block.header.id);
			if (staleFailure) {
				if (staleFailure.missing) {	// One or more transactions have been committed ahead of us, need to incorporate the changes and replay our actions
					for (const trx of staleFailure.missing) {
						this.sourceCache.transformCache(trx.transforms);
					}
				} else if (staleFailure.pending) {	// One or more transactions are pending on the same block(s) as us, need to wait for them to commit
					// Clear pending caches for the conflicting blocks
					this.sourceCache.clear(staleFailure.pending.map(p => p.blockId));
					// Wait for short time to allow the pending transactions to commit
					await new Promise(resolve => setTimeout(resolve, PendingRetryDelayMs));
				}
				await this.replayActions();
				this.source.trxContext = await log.getTrxContext();
			} else {
				this.pending.length = 0;
				this.tracker.reset();
				this.sourceCache.transformCache(tracker.reset());
				this.source.trxContext = this.source.trxContext
					? { committed: [...this.source.trxContext.committed, { trxId, rev: newRev }], rev: newRev }
					: { committed: [{ trxId, rev: newRev }], rev: newRev };
			}
		}
	}

	async updateAndSync() {
		// TODO: introduce timer and potentially change stats to determine when to sync, rather than always syncing
		await this.update();
		await this.sync();
	}

	async *selectLog(forward = true): AsyncIterableIterator<Action<TAction>> {
		const log = Log.open<Action<TAction>>(this.tracker, this.logId);
		for await (const entry of log.select(undefined, forward)) {
			if (entry.action) {
				yield* forward ? entry.action.actions : entry.action.actions.reverse();
			}
		}
	}

	private async replayActions() {
		this.tracker.reset();
		await this.internalTransact(...this.pending);
	}

	protected processUpdateAction(delta: ActionEntry<Action<TAction>>) {
		// Override to check for and resolve conflicts with our pending actions
		// This may affect the pending logical actions
	}
}
