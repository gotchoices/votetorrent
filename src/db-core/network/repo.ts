import { BlockGet, BlockTrxRef, CommitResult, GetBlockResult, Transform, PendResult, BlockId } from "../index.js";

export type MessageOptions = {
	expiration: number;
	signal?: AbortSignal;
}

export type Repo = {
	get(blockGets: BlockGet[], options?: MessageOptions): Promise<GetBlockResult[]>;
	pend(transform: Transform, options?: MessageOptions): Promise<PendResult>;
	cancel(trxRef: BlockTrxRef, options?: MessageOptions): Promise<void>;
	commit(trxRef: BlockTrxRef, options?: MessageOptions): Promise<CommitResult>;
}
