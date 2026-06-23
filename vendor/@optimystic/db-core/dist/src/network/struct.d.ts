import type { CollectionId, BlockId, IBlock, ActionId, Transform, Transforms } from "../index.js";
import type { ActionContext, ActionRev } from "../collection/action.js";
import type { Transaction } from "../transaction/transaction.js";
import type { PeerId } from "./types.js";
export type ActionBlocks = {
    blockIds: BlockId[];
    actionId: ActionId;
};
export type ActionTransforms = {
    actionId: ActionId;
    rev?: number;
    transforms: Transforms;
};
export type ActionTransform = {
    actionId: ActionId;
    rev?: number;
    transform: Transform;
};
export type ActionPending = {
    blockId: BlockId;
    actionId: ActionId;
    transform?: Transform;
};
export type PendRequest = ActionTransforms & {
    /** What to do if there are any pending actions.
     * 'c' is continue normally,
     * 'f' is fail, returning the pending ActionIds,
     * 'r' is return, which fails but returns the pending ActionIds and their transforms */
    policy: 'c' | 'f' | 'r';
    /** For multi-collection transactions: the full transaction for replay/validation */
    transaction?: Transaction;
    /** For multi-collection transactions: hash of ALL operations across all blocks */
    operationsHash?: string;
    /** For multi-collection transactions: supercluster nominees for consensus */
    superclusterNominees?: PeerId[];
};
export type BlockActionStatus = ActionBlocks & {
    statuses: ('pending' | 'committed' | 'checkpointed' | 'aborted')[];
};
export type PendSuccess = {
    success: true;
    /** List of already pending actions that were found on blocks touched by this pend */
    pending: ActionPending[];
    /** The affected blocks */
    blockIds: BlockId[];
};
export type StaleFailure = {
    success: false;
    /** The reason for the failure */
    reason?: string;
    /** List of actions that have already been committed and are newer than our known revision */
    missing?: ActionTransforms[];
    /** List of actions that are pending on the blocks touched by this pend */
    pending?: ActionPending[];
};
export type PendResult = PendSuccess | StaleFailure;
export type CommitRequest = ActionBlocks & {
    /** The header block of the collection, if this is a new collection (commit first) */
    headerId?: BlockId;
    /** The tail block of the log (commit next) */
    tailId: BlockId;
    /** The new revision for the committed action */
    rev: number;
};
export type CommitResult = CommitSuccess | StaleFailure;
export type CommitSuccess = {
    success: true;
    /** If present, the identified collection acts as the coordinator for the multi-collection transaction */
    coordinatorId?: CollectionId;
};
export type BlockActionState = {
    /** The latest action that has been committed */
    latest?: ActionRev;
    /** If present, the specified actions are pending */
    pendings?: ActionId[];
};
export type BlockGets = {
    blockIds: BlockId[];
    context?: ActionContext;
};
export type GetBlockResult = {
    /** The retrieved block - undefined if the block was deleted	 */
    block?: IBlock;
    /** The latest and pending states of the repo that retrieved the block */
    state: BlockActionState;
};
export type GetBlockResults = Record<BlockId, GetBlockResult>;
/**
 * Result of validating a transaction in a PendRequest.
 */
export type PendValidationResult = {
    /** Whether validation passed */
    valid: boolean;
    /** Reason for validation failure (if valid=false) */
    reason?: string;
};
/**
 * Hook for validating transactions in PendRequests.
 *
 * This hook is called by the storage layer when receiving a PendRequest
 * that includes a transaction and operationsHash. If validation fails,
 * the pend operation is rejected.
 *
 * If the hook is not provided, validation is skipped (storage-only nodes).
 */
export type PendValidationHook = (transaction: Transaction, operationsHash: string) => Promise<PendValidationResult>;
/** @deprecated Use ActionBlocks instead */
export type TrxBlocks = ActionBlocks;
/** @deprecated Use ActionTransforms instead */
export type TrxTransforms = ActionTransforms;
/** @deprecated Use ActionTransform instead */
export type TrxTransform = ActionTransform;
/** @deprecated Use ActionPending instead */
export type TrxPending = ActionPending;
//# sourceMappingURL=struct.d.ts.map