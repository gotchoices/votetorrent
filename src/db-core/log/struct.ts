import { BlockId, CollectionId, TransactionId } from "../index.js";

/** A log entry - either an action or a checkpoint */
export type LogEntry<TAction> = {
	readonly timestamp: number;
	readonly action?: ActionEntry<TAction>;
	readonly checkpoint?: CheckpointEntry;
};

/** An action entry represents a unit of work that is atomic */
export type ActionEntry<TAction> = {
	/** Generated unique identifier for the transaction */
	readonly transactionId: TransactionId;
	/** Revision number - monotonically increasing from the prior action's rev.  Starts at 1. */
	readonly rev: number;
	/** Actions to be applied */
	readonly actions: TAction[];
	/** Block ids affected by the transaction - includes the log related blocks */
	blockIds: BlockId[]; // NOTE: not readonly because it is updated after being generated
	/** Other collection ids affected by the transaction */
	collectionIds?: CollectionId[];
};

/** A checkpoint entry restates the currently uncheckpointed transactions */
export type CheckpointEntry = {
	/** The current set of pending transaction ids
	 * - actions implicitly increase the set of pending Ids
	 * - this restates the entire current set
	 * - missing from the set are the implicitly checkpointed ones */
	readonly pendingIds: TransactionId[];
};

export const LogDataBlockType = "LGD";
export const LogHeaderBlockType = "LGH";

