import { BlockGet, BlockTrxRef, Mutations } from "../db-core/index.js";

export type RepoMessage = {
	operations: [{ get: BlockGet[] } | { pend: Mutations } | { cancel: BlockTrxRef } | { commit: BlockTrxRef } | { abort: BlockTrxRef }],
	expiration?: number,
};
