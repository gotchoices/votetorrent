import type { TrxBlocks, CommitResult, GetBlockResults, PendResult, PendRequest, CommitRequest, BlockGets, BlockId, TrxId } from "../index.js";

export type MessageOptions = {
	expiration?: number;
	signal?: AbortSignal;
}

export type RepoCommitRequest = {
	blockIds: BlockId[];
	trxId: TrxId;
	rev: number;
};

export type IRepo = {
	get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults>;
	pend(request: PendRequest, options?: MessageOptions): Promise<PendResult>;
	cancel(trxRef: TrxBlocks, options?: MessageOptions): Promise<void>;
	commit(request: RepoCommitRequest, options?: MessageOptions): Promise<CommitResult>;
}
