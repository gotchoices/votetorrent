import type { IRepo, GetBlockResults, PendSuccess, StaleFailure, ActionBlocks, MessageOptions, CommitResult, PendRequest, CommitRequest, BlockGets, IPeerNetwork, PeerId } from "@optimystic/db-core";
import { ProtocolClient } from "../protocol-client.js";
export declare class RepoClient extends ProtocolClient implements IRepo {
    readonly protocolPrefix?: string | undefined;
    private constructor();
    /** Create a new client instance */
    static create(peerId: PeerId, peerNetwork: IPeerNetwork, protocolPrefix?: string): RepoClient;
    get(blockGets: BlockGets, options: MessageOptions): Promise<GetBlockResults>;
    pend(request: PendRequest, options: MessageOptions): Promise<PendSuccess | StaleFailure>;
    cancel(actionRef: ActionBlocks, options: MessageOptions): Promise<void>;
    commit(request: CommitRequest, options: MessageOptions): Promise<CommitResult>;
    private extractCorrelationId;
    private processRepoMessage;
    private extractKeyFromOperations;
    private recordCoordinatorForOpsIfSupported;
}
//# sourceMappingURL=client.d.ts.map