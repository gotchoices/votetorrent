import type { IRepo, MessageOptions, BlockId, CommitRequest, CommitResult, GetBlockResults, PendRequest, PendResult, ActionBlocks, BlockGets, PendValidationHook } from "@optimystic/db-core";
import type { IBlockStorage } from "./i-block-storage.js";
export type StorageRepoOptions = {
    /** Optional hook to validate transactions in PendRequests */
    validatePend?: PendValidationHook;
};
export declare class StorageRepo implements IRepo {
    private readonly createBlockStorage;
    private readonly validatePend?;
    constructor(createBlockStorage: (blockId: BlockId) => IBlockStorage, options?: StorageRepoOptions);
    get({ blockIds, context }: BlockGets, _options?: MessageOptions): Promise<GetBlockResults>;
    pend(request: PendRequest, _options?: MessageOptions): Promise<PendResult>;
    cancel(actionRef: ActionBlocks, _options?: MessageOptions): Promise<void>;
    commit(request: CommitRequest, _options?: MessageOptions): Promise<CommitResult>;
    /**
     * Reconciles `metadata.latest` for a single block with the highest contiguous
     * fully-promoted revision in durable storage. Use after a crash between
     * `promotePendingTransaction` and `setLatest` when retry-commit cannot help
     * (the pending record is already gone) but the revision and committed-log entry
     * are durable. Idempotent and monotonic.
     */
    recoverBlock(blockId: BlockId): Promise<void>;
    private internalCommit;
}
//# sourceMappingURL=storage-repo.d.ts.map