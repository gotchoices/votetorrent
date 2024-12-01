import { Log, Cache, IBlock, Action, ActionType, ActionHandler, Atomic, BlockId, Tracker, BlockNetwork, ActionEntry, blockIdsForTransform, copyTransform, applyTransformToStore } from "../index.js";
import { NetworkSource } from "../network/network-source.js";
import { CollectionHeaderBlock, CollectionId } from "./index.js";

export type CollectionInitOptions<TAction> = {
	modules: Record<ActionType, ActionHandler<TAction>>;
	createHeaderBlock: (id: BlockId) => CollectionHeaderBlock;
}

export class Collection<TAction> {
	private readonly pending: Action<TAction>[] = [];

	protected constructor(
		private readonly id: CollectionId,
		private readonly network: BlockNetwork,
		private readonly logId: BlockId,
		private readonly handlers: Record<ActionType, ActionHandler<TAction>>,
		private readonly source: NetworkSource<IBlock>,
		private readonly tracker: Tracker<IBlock>,
		private readonly cache: Cache<IBlock>,
	) {
	}

	static async createOrOpen<TAction>(network: BlockNetwork, id: CollectionId, init: CollectionInitOptions<TAction>) {
		// Start with a context that has an infinite revision number to ensure that we always fetch the latest log information
		const source = new NetworkSource(id, network, { rev: Number.POSITIVE_INFINITY });
		const tracker = new Tracker(source);
		const cache = new Cache(tracker);
		const header = await source.tryGet(id) as CollectionHeaderBlock | undefined;
		let logId: BlockId;
		if (header) {
			logId = header.logId;
			const log = Log.open<Action<TAction>>(tracker, logId);
			source.trxContext = await log.getTrxContext();
		} else {
			source.trxContext = { rev: 0 };
			logId = source.generateId();
			const newHeader = {
				...init.createHeaderBlock(id),
				logId,
			};
			await Log.create<Action<TAction>>(tracker, logId);
			tracker.insert(newHeader);
		}

		return new Collection(id, network, logId, init.modules, source, tracker, cache);
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
		const source = new NetworkSource(this.id, this.network, { rev: Number.POSITIVE_INFINITY });
		const tracker = new Tracker(source);
		const cache = new Cache(tracker);

		// Get the latest entries from the log, starting from where we left off
		const log = Log.open<Action<TAction>>(cache, this.logId);
		const latest = await log.getFrom(this.source.trxContext.rev);

		// Process the entries and track the blocks they affect
		const blockIds = new Set<BlockId>();
		for (const entry of latest.entries) {
			this.processUpdateAction(entry);
			entry.blockIds.forEach(blockIds.add.bind(blockIds));
		}

		// On conflicts, clear the caching and block tracking and reply logical operations
		const conflicts = tracker.conflicts(blockIds);
		if (conflicts.length > 0) {
			this.tracker.reset();
			this.cache.clear(conflicts);
			await this.internalTransact(...this.pending);
		}

		// Update our context to the latest
		this.source.trxContext = latest.context;
	}

	async sync() {
		// Create a snapshot tracker for the transaction, so that we can ditch the log changes if we have to retry the transaction
		const transactionId = crypto.randomUUID();
		const snapshot = copyTransform(this.tracker.transform);
		const tracker = new Tracker(this.source, snapshot);
		const cache = new Cache(tracker);

		while (true) {
			// Add the transaction to the log
			const log = Log.open<Action<TAction>>(cache, this.logId);
			const addResult = await log.add(this.pending, transactionId);
			// Adding to the log affects the transaction's blocks - patch the final set of blocks affected by the transaction
			addResult.entry.blockIds = tracker.transformedBlockIds();

			// Commit the transaction to the network
			const staleFailure = await this.source.transact(tracker.transform, transactionId, addResult.tailId);
			if (staleFailure) {
				// If the transaction failed: apply the block changes to the store's cache, update the context, and retry the transaction
				for (const trx of staleFailure.missing) {
					applyTransformToStore(trx.transform, this.cache);
				}
				// Revert the tracker to the snapshot
				tracker.reset(copyTransform(this.tracker.transform));
				this.source.trxContext = await log.getTrxContext();
			} else {
				break;
			}
		}
	}

	async updateAndSync() {
		// TODO: introduce timer and potentially change stats to determine when to sync, rather than always syncing
		await this.update();
		await this.sync();
	}

	protected processUpdateAction(delta: ActionEntry<Action<TAction>>) {
		// Override to check for and resolve conflicts with our pending actions
		// This may affect the pending logical actions
	}
}
