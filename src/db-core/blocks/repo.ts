import { BlockGet, BlockTrxRef, CommitResult, CommitSuccess, GetBlockResult, Mutations, PendResult, PendSuccess, StaleFailure } from "./index.js";

export type MessageOptions = {
	expiration: number;
	signal?: AbortSignal;
}

export type Repo = {
	get(blockGets: BlockGet[], options?: MessageOptions): Promise<GetBlockResult[]>;
	pend(mutations: Mutations, options?: MessageOptions): Promise<PendResult>;
	cancel(trxRef: BlockTrxRef, options?: MessageOptions): Promise<void>;
	commit(trxRef: BlockTrxRef, options?: MessageOptions): Promise<CommitResult>;
	abort(trxRef: BlockTrxRef, options?: MessageOptions): Promise<void>;
}
