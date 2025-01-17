import type { TrxBlocks, PendRequest, CommitRequest, BlockGets } from "../index.js";

export type RepoMessage = {
	operations: [
		{ get: BlockGets } |
		{ pend: PendRequest } |
		{ cancel: { trxRef: TrxBlocks } } |
		{ commit: CommitRequest }
	],
	expiration?: number,
};
