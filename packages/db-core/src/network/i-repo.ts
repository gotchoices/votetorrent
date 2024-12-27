import { BlockGet, TrxBlocks, CommitResult, GetBlockResult, PendResult, PendRequest } from "../index.js";

export type MessageOptions = {
	expiration: number;
	signal?: AbortSignal;
}

export type IRepo = {
	get(blockGets: BlockGet[], options?: MessageOptions): Promise<GetBlockResult[]>;
	pend(request: PendRequest, options?: MessageOptions): Promise<PendResult>;
	cancel(trxRef: TrxBlocks, options?: MessageOptions): Promise<void>;
	commit(trxRef: TrxBlocks, options?: MessageOptions): Promise<CommitResult>;
}
