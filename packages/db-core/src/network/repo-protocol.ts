import { BlockGet, TrxBlocks, Transform, PendRequest } from "../index.js";

export type RepoMessage = {
	operations: [{ get: BlockGet[] } | { pend: PendRequest } | { cancel: TrxBlocks } | { commit: TrxBlocks }],
	expiration?: number,
};
