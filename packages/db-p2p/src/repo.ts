import { PendRequest, TrxBlocks, IRepo, MessageOptions, CommitResult, GetBlockResults, PendResult, BlockGets, CommitRequest } from "../../db-core/src/index.js";
import { KeyNetwork } from "./key-network.js";

/** Cluster coordination repo - uses local store, as well as distributes changes to other nodes using cluster consensus. */
export class Repo implements IRepo {
	constructor(
		private readonly network: KeyNetwork,
		private readonly storeRepo: IRepo,
	) {
	}

	async get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults> {
		throw new Error("Not implemented");
	}

	async pend(request: PendRequest, options?: MessageOptions): Promise<PendResult> {
		throw new Error("Not implemented");
	}

	async cancel(trxRef: TrxBlocks, options?: MessageOptions): Promise<void> {
		throw new Error("Not implemented");
	}

	async commit(request: CommitRequest, options?: MessageOptions): Promise<CommitResult> {
		throw new Error("Not implemented");
	}
}
