import type { ActionBlocks, CommitResult, GetBlockResults, PendResult, PendRequest, BlockGets, BlockId, ActionId } from "../index.js";
export type MessageOptions = {
    expiration?: number;
    signal?: AbortSignal;
    /**
     * Per-peer dial deadline in ms. Bounds only the dial portion of a call, so
     * an unreachable peer fails fast and the caller's retry loop can re-pick
     * a different coordinator. Independent of `expiration` (the overall budget):
     * a 30s transaction with `dialTimeoutMs: 3000` can afford ten 3s dial
     * attempts against different peers. Once a dial succeeds, the response wait
     * is bound by the remaining `expiration` budget. Undefined means "do not
     * impose a separate dial cap; the overall budget is the cap".
     */
    dialTimeoutMs?: number;
};
export type RepoCommitRequest = {
    blockIds: BlockId[];
    actionId: ActionId;
    rev: number;
};
export type IRepo = {
    get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults>;
    pend(request: PendRequest, options?: MessageOptions): Promise<PendResult>;
    cancel(actionRef: ActionBlocks, options?: MessageOptions): Promise<void>;
    commit(request: RepoCommitRequest, options?: MessageOptions): Promise<CommitResult>;
};
//# sourceMappingURL=i-repo.d.ts.map