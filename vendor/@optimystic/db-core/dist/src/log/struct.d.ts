import type { BlockId, CollectionId, ActionContext, ActionId, ActionRev } from "../index.js";
/** A log entry - either an action or a checkpoint */
export type LogEntry<TAction> = {
    /** Linux timestamp of the entry */
    readonly timestamp: number;
    /** Revision number - monotonically increasing from the prior entry's rev.  Starts at 1. */
    readonly rev: number;
    readonly action?: ActionEntry<TAction>;
    readonly checkpoint?: CheckpointEntry;
};
/** An action entry represents a unit of work that is atomic */
export type ActionEntry<TAction> = {
    /** Generated unique identifier for the action */
    readonly actionId: ActionId;
    /** Actions to be applied */
    readonly actions: TAction[];
    /** Block ids affected by the action - includes the log related blocks */
    blockIds: BlockId[];
    /** Other collection ids affected by the action - this action is conditional on successful commit in all of these collections */
    readonly collectionIds?: CollectionId[];
};
/** A checkpoint entry restates the currently uncheckpointed actions */
export type CheckpointEntry = {
    /** The current set of pending action/revs
     * - actions implicitly increase the set of pending Ids
     * - this restates the entire current set
     * - missing from the set are the implicitly checkpointed ones */
    readonly pendings: ActionRev[];
};
export declare const LogDataBlockType = "LGD";
export declare const LogHeaderBlockType = "LGH";
export type GetFromResult<TAction> = {
    context: ActionContext | undefined;
    entries: ActionEntry<TAction>[];
};
//# sourceMappingURL=struct.d.ts.map