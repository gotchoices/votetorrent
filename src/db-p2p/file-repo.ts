import { CommitResult, GetBlockResult, PendRequest, PendResult, TrxBlocks } from "../db-core/index.js";
import { BlockGet } from "../db-core/index.js";
import { IRepo, MessageOptions } from "../db-core/network/i-repo.js";

export class FileRepo implements IRepo {
	constructor(
		private readonly path: string,
	) {
	}

	async get(blockGets: BlockGet[], options?: MessageOptions): Promise<GetBlockResult[]> {
		throw new Error("Not implemented");
	}

	async pend(request: PendRequest, options?: MessageOptions): Promise<PendResult> {
		throw new Error("Not implemented");
	}

	async cancel(trxRef: TrxBlocks, options?: MessageOptions): Promise<void> {
		throw new Error("Not implemented");
	}

	async commit(trxRef: TrxBlocks, options?: MessageOptions): Promise<CommitResult> {
		throw new Error("Not implemented");
	}
}
