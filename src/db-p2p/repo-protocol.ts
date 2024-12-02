import { BlockGet, BlockTrxRef, Transform } from "../db-core/index.js";

export type RepoMessage = {
	operations: [{ get: BlockGet[] } | { pend: Transform } | { cancel: BlockTrxRef } | { commit: BlockTrxRef } | { abort: BlockTrxRef }],
	expiration?: number,
};
