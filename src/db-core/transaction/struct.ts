import { UUID } from "crypto";
import { BlockStore, IBlock } from "../index.js";

export type TransactionId = UUID;

export type ActionType = string;

export type Action<T> = {
	type: ActionType;
	data: T;
};

export type ActionHandler<T> = (action: Action<T>, store: BlockStore<IBlock>, transactionId: TransactionId) => Promise<void>;
