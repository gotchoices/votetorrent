import type { IBlock, BlockId, Action } from "../index.js";

export type CollectionId = BlockId;

export type CollectionHeaderType = 'CH';

export type CollectionHeaderBlock = IBlock & {
	header: {
		type: CollectionHeaderType;
	};
};

export interface ICollection<TAction> {
	update(): Promise<void>;
	sync(): Promise<void>;
}

export type CreateCollectionAction = Action<void> & {
	type: "create";
};
