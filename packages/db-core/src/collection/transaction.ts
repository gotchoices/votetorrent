import type { BlockStore } from "../index.js";
import type { IBlock } from "../index.js";

export type TrxId = string;

export type ActionType = string;

export type Action<T> = {
	type: ActionType;
	data: T;
};

export type ActionHandler<T> = (action: Action<T>, store: BlockStore<IBlock>) => Promise<void>;

export type TrxRev = {
	trxId: TrxId;
	rev: number;
};

/** Situational awareness of the transaction state */
export type TrxContext = {
	/** Transactions that may not have been checkpointed */
	committed: TrxRev[];
	/** The latest known revision number */
	rev: number;
	/** Optional uncommitted pending transaction ID */
	trxId?: TrxId;
};

