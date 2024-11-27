import { Log, BlockStore, IBlock, Action, ActionType, ActionHandler, Atomic, BlockId, BlockSource, Tracker, BlockNetwork, BlockTrxContext } from "../index.js";
import { NetworkSource } from "../network/network-source.js";
import { CollectionHeaderBlock } from "./index.js";

export type CollectionInitOptions<TAction> = {
	modules: Record<ActionType, ActionHandler<TAction>>;
	createHeaderBlock: (id: BlockId) => CollectionHeaderBlock;
}

export class Collection<TAction> {
	private readonly pending: Action<TAction>[] = [];
	private readonly tracker: Tracker<IBlock>;


	protected constructor(
		private readonly network: BlockNetwork,
		private readonly id: BlockId,
		private readonly log: Log<Action<TAction>>,
		private readonly actions: Record<ActionType, ActionHandler<TAction>>,
		private readonly store: BlockStore<IBlock>,
		private context: BlockTrxContext,
	) {
		this.tracker = new Tracker(source);
	}

	static async createOrOpen<TAction>(network: BlockNetwork, id: BlockId, init: CollectionInitOptions<TAction>) {
		let context: BlockTrxContext = { };	// Mutated as context changes
		const source = new NetworkSource(network, () => context);
		const store = new Tracker(source);
		const header = await source.tryGet(id) as CollectionHeaderBlock | undefined;
		let log: Log<Action<TAction>>;
		if (header) {
			log = Log.open<Action<TAction>>(store, header.logId);
			context = await log.getContext();
		} else {
			log = await Log.create<Action<TAction>>(store);
			const newHeader = {
				...init.createHeaderBlock(id),
				logId: log.getId(),
			};
			store.insert(newHeader);
		}

		return new Collection(network, id, log, init.modules, store, context);
	}

	async transact(...actions: Action<TAction>[]) {
		const transactionId = crypto.randomUUID();

		const trx = new Atomic(this.tracker);

		for (const action of actions) {
			const handler = this.actions[action.type];
			await handler(action, trx, transactionId);
		}

		const entry = await this.log.add(actions, transactionId);
		// Adding the transaction entry itself affects the blocks, so we need to patch the final set of blocks affected by the transaction
		entry.blockIds = trx.getBlockIds();

		trx.commit();
	}

	async sync(network: BlockNetwork) {
		network
	}
}
