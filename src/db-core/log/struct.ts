import { BlockId, TransactionId } from "../index.js";

export type LogEntry<TAction> = {
	readonly transactionId: TransactionId;
	readonly actions: TAction[];
	readonly timestamp: number;
	blockIds: BlockId[]; // NOTE: this has to be updated after the log entry is written, so as to reflect the block Ids affected by enqueuing the log entry itself
};

export const LogDataBlockType = "LGD";
export const LogHeaderBlockType = "LGH";

