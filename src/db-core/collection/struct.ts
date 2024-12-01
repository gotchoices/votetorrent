import { IBlock, BlockId } from "../index.js";

export type CollectionId = BlockId;

export type CollectionHeaderType = 'CH';

export type CollectionHeaderBlock = IBlock & {
	block: {
		type: CollectionHeaderType;
	};
	logId: BlockId;
};
