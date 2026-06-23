import type { PeerId } from "../network/types.js";
import type { ActionTransforms, ActionBlocks, BlockActionStatus, ITransactor, IKeyNetwork, BlockId, GetBlockResults, PendResult, CommitResult, PendRequest, IRepo, BlockGets, CommitRequest, ClusterNomineesResult } from "../index.js";
type NetworkTransactorInit = {
    timeoutMs: number;
    abortOrCancelTimeoutMs: number;
    keyNetwork: IKeyNetwork;
    getRepo: (peerId: PeerId) => IRepo;
    /**
     * Per-peer dial deadline in ms applied to each downstream repo call.
     * `timeoutMs` is the overall transaction budget; `dialTimeoutMs` caps how
     * long a single peer can hold that budget hostage during its dial. When a
     * peer is unreachable, the dial fails fast and the batch-retry loop can
     * re-pick a different coordinator within the remaining overall budget.
     * Omit to fall back to a sensible default (3s); set 0 / negative to disable.
     */
    dialTimeoutMs?: number;
};
export declare class NetworkTransactor implements ITransactor {
    private readonly keyNetwork;
    private readonly timeoutMs;
    private readonly abortOrCancelTimeoutMs;
    private readonly dialTimeoutMs;
    private readonly getRepo;
    constructor(init: NetworkTransactorInit);
    get(blockGets: BlockGets): Promise<GetBlockResults>;
    getStatus(blockActions: ActionBlocks[]): Promise<BlockActionStatus[]>;
    private consolidateCoordinators;
    pend(blockAction: PendRequest): Promise<PendResult>;
    cancel(actionRef: ActionBlocks): Promise<void>;
    queryClusterNominees(blockId: BlockId): Promise<ClusterNomineesResult>;
    commit(request: CommitRequest): Promise<CommitResult>;
    private commitBlock;
    /** Attempts to commit a set of blocks, and handles failures and errors */
    private commitBlocks;
    /** Creates batches for a given payload, grouped by the coordinating peer for each block id */
    private batchesForPayload;
    /** Cancels a pending transaction by canceling all blocks associated with the transaction, including failed peers */
    private cancelBatch;
    private formatBatchStatuses;
}
/**
 * Returns the block actions grouped by action id and concatenated transforms
 */
export declare function distinctBlockActionTransforms(blockActions: ActionTransforms[]): ActionTransforms[];
export {};
//# sourceMappingURL=network-transactor.d.ts.map