import { type ITransactor, type GetBlockResults, type ActionBlocks, type BlockActionStatus, type PendResult, type CommitResult, type PendRequest, type BlockId, type CommitRequest, type BlockGets, type ActionId, type ActionTransforms, type ClusterNomineesResult } from "../src/index.js";
export declare class TestTransactor implements ITransactor {
    private blocks;
    available: boolean;
    private getLocks;
    constructor();
    get(blockGets: BlockGets): Promise<GetBlockResults>;
    getStatus(actionRefs: ActionBlocks[]): Promise<BlockActionStatus[]>;
    pend(request: PendRequest): Promise<PendResult>;
    cancel(actionRef: ActionBlocks): Promise<void>;
    commit(request: CommitRequest): Promise<CommitResult>;
    reset(): void;
    getPendingActions(): Map<ActionId, ActionTransforms>;
    getCommittedActions(): Map<ActionId, ActionTransforms>;
    setAvailable(available: boolean): void;
    checkAvailable(): void;
    /** Optional method for querying cluster nominees (used in GATHER phase for multi-collection transactions) */
    queryClusterNominees?: (blockId: BlockId) => Promise<ClusterNomineesResult>;
}
//# sourceMappingURL=test-transactor.d.ts.map