import type { IBlock, BlockId } from "../index.js";

export type CollectionId = BlockId;

export type CollectionHeaderType = 'CH';

export type CollectionHeaderBlock = IBlock & {
	block: {
		type: CollectionHeaderType;
	};
	logId: BlockId;
};

export interface ICollection<TAction> {
	update(): Promise<void>;
	sync(): Promise<void>;
}
