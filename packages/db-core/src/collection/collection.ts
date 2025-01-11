import { Log, CacheStore, IBlock, Action, ActionType, ActionHandler, Atomic, BlockId, Tracker, IBlockNetwork, ActionEntry, copyTransforms, CacheSource, BlockStore } from "../index.js";
import { NetworkSource } from "../network/network-source.js";
import { CollectionHeaderBlock, CollectionId, ICollection } from "./index.js";

export type CollectionInitOptions<TAction> = {
	modules: Record<ActionType, ActionHandler<TAction>>;
	createHeaderBlock: (id: BlockId, store: BlockStore<IBlock>) => IBlock;
}

export class Collection<TAction> implements ICollection<TAction> {
	private readonly pending: Action<TAction>[] = [];
	private cache: CacheStore<IBlock>;

	protected constructor(
		public readonly id: CollectionId,
		public readonly network: IBlockNetwork,
		public readonly logId: BlockId,
		private readonly handlers: Record<ActionType, ActionHandler<TAction>>,
		private readonly source: NetworkSource<IBlock>,
		private readonly sourceCache: CacheSource<IBlock>,
		private readonly tracker: Tracker<IBlock>,
	) {
		this.cache = new CacheStore(tracker);
	}

	static async createOrOpen<TAction>(network: IBlockNetwork, id: CollectionId, init: CollectionInitOptions<TAction>) {
		// Start with a context that has an infinite revision number to ensure that we always fetch the latest log information
		const source = new NetworkSource(id, network, undefined);
		const sourceCache = new CacheSource(source);
		const tracker = new Tracker(sourceCache);
		const header = await source.tryGet(id) as CollectionHeaderBlock | undefined;
		let logId: BlockId;
		if (header) {
			logId = header.logId;
			const log = Log.open<Action<TAction>>(tracker, logId);
			source.trxContext = await log.getTrxContext();
		} else {
			source.trxContext = undefined;
			logId = source.generateId();
			const newHeader = {
				...init.createHeaderBlock(id, tracker),
				logId,
			};
			await Log.create<Action<TAction>>(tracker, logId);
			tracker.insert(newHeader);
		}

		return new Collection(id, network, logId, init.modules, source, sourceCache, tracker);
	}

	async transact(...actions: Action<TAction>[]) {
		await this.internalTransact(...actions);
		this.pending.push(...actions);
	}

	private async internalTransact(...actions: Action<TAction>[]) {
		const trx = new Atomic(this.cache);

		for (const action of actions) {
			const handler = this.handlers[action.type];
			await handler(action, trx);
		}

		trx.commit();
	}

	/** Sync incoming changes and update our context to the latest log revision - resolve any conflicts with our pending actions. */
	async update() {
		// Start with a context that can see to the end of the log
		const source = new NetworkSource(this.id, this.network, undefined);
		const tracker = new Tracker(source);
		const cache = new CacheStore(tracker);

		// Get the latest entries from the log, starting from where we left off
		const log = Log.open<Action<TAction>>(cache, this.logId);
		const latest = await log.getFrom(this.source.trxContext?.rev ?? 0);

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

	/** Push our pending actions to the network */
	async sync() {
		const trxId = crypto.randomUUID();

		while (true) {
			// Create a snapshot tracker for the transaction, so that we can ditch the log changes if we have to retry the transaction
			const snapshot = copyTransforms(this.tracker.transform);
			const tracker = new Tracker(this.sourceCache, snapshot);
			const cache = new CacheStore(tracker);

			// Add the transaction to the log
			const log = Log.open<Action<TAction>>(cache, this.logId);
			const newRev = (this.source.trxContext?.rev ?? 0) + 1;
			const addResult = await log.addActions(this.pending, trxId, newRev);
			// HACK: Adding to the log affects the transaction's blocks - patch the final set of blocks affected by the transaction
			addResult.entry.action!.blockIds = tracker.transformedBlockIds();

			// Commit the transaction to the network
			const staleFailure = await this.source.transact(tracker.transform, trxId, newRev, addResult.tailPath.block.header.id);
			if (staleFailure) {
				// Apply the block changes to the source cache
				for (const trx of staleFailure.missing) {
					this.sourceCache.transformCache(trx.transforms);
				}
				await this.replayActions();
				this.source.trxContext = await log.getTrxContext();
			} else {
				this.cache.clear();
				this.pending.length = 0;
				this.sourceCache.transformCache(this.tracker.reset());
				this.source.trxContext = { rev: newRev, trxId };
				break;
			}
		}
	}

	async updateAndSync() {
		// TODO: introduce timer and potentially change stats to determine when to sync, rather than always syncing
		await this.update();
		await this.sync();
	}

	async *selectLog(reverse = false): AsyncIterableIterator<Action<TAction>> {
		const log = Log.open<Action<TAction>>(this.cache, this.logId);
		for await (const entry of log.select(undefined, reverse)) {
			if (entry.action) {
				yield* entry.action.actions;
			}
		}
	}

	private async replayActions() {
		this.tracker.reset();
		this.cache.clear();
		await this.internalTransact(...this.pending);
	}

	protected processUpdateAction(delta: ActionEntry<Action<TAction>>) {
		// Override to check for and resolve conflicts with our pending actions
		// This may affect the pending logical actions
	}
}
