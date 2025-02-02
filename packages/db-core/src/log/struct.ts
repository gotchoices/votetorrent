import type { BlockId, CollectionId, TrxContext, TrxId, TrxRev } from "../index.js";

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
	/** Generated unique identifier for the transaction */
	readonly trxId: TrxId;
	/** Actions to be applied */
	readonly actions: TAction[];
	/** Block ids affected by the transaction - includes the log related blocks */
	blockIds: BlockId[]; // NOTE: this is updated after being generated to include the log-related block transforms
	/** Other collection ids affected by the transaction - this transaction is conditional on successful commit in all of these collections */
	readonly collectionIds?: CollectionId[];
};

/** A checkpoint entry restates the currently uncheckpointed transactions */
export type CheckpointEntry = {
	/** The current set of pending transaction/revs
	 * - actions implicitly increase the set of pending Ids
	 * - this restates the entire current set
	 * - missing from the set are the implicitly checkpointed ones */
	readonly pendings: TrxRev[];
};

export const LogDataBlockType = "LGD";
export const LogHeaderBlockType = "LGH";

export type GetFromResult<TAction> = {
	context: TrxContext | undefined;
	entries: ActionEntry<TAction>[];
};
