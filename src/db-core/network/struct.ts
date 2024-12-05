import { CollectionId, BlockId, IBlock, TrxId, Transform } from "../index.js";

export type TrxBlocks = {
	blockIds: BlockId[];
	trxId: TrxId;
};

export type TrxTransform = {
	trxId: TrxId;
	transform: Transform;
};

export type PendRequest = TrxTransform & {
	/** If 'fail', the call fails if there are any pending transactions.  Always fails if there are any committed ahead of this transaction */
	pending: 'return' | 'fail';
};

export type BlockTrxStatus = TrxBlocks & {
	statuses: ('pending' | 'committed' | 'checkpointed' | 'aborted')[];
};

export type PendSuccess = {
	success: true;
	/** List of already pending transactions that were found on blocks touched by this pend */
	pending: TrxTransform[];
	/** The transactionId and affected blocks */
	trxRef: TrxBlocks;
};

export type StaleFailure = {
	success: false;
	/** List of transactions that have already been committed and are newer than our known revision */
	missing: TrxTransform[];
};

export type PendResult = PendSuccess | StaleFailure;

export type CommitResult = CommitSuccess | StaleFailure;

export type CommitSuccess = {
	success: true;
	/** If present, the identified collection acts as the coordinator for the multi-collection transaction */
	coordinatorId?: CollectionId;
};

export type BlockTrxContext = {
	/** Set of transactions to explicitly include - may not be checkpointed yet, but are committed */
	pendingIds?: TrxId[];
	/** Revision number of the collection */
	rev: number;
};

export type BlockGet = {
	blockId: BlockId;
} & BlockTrxContext;

export type GetBlockResult = {
	block: IBlock;
} & BlockTrxContext;
