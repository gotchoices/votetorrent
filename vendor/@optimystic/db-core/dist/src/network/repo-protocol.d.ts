import type { ActionBlocks, PendRequest, CommitRequest, BlockGets } from "../index.js";
export type RepoMessage = {
    operations: [
        {
            get: BlockGets;
        } | {
            pend: PendRequest;
        } | {
            cancel: {
                actionRef: ActionBlocks;
            };
        } | {
            commit: CommitRequest;
        }
    ];
    expiration?: number;
    coordinatingBlockIds?: string[];
};
//# sourceMappingURL=repo-protocol.d.ts.map