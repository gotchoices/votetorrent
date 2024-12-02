import { CollectionId, BlockId, IBlock, TransactionId, Transform } from "../index.js";

export type BlockTrxRef = {
	blockIds: BlockId[];
	transactionId: TransactionId;
};

export type BlockTrx = {
	transactionId: TransactionId;
	transform: Transform;
};

export type BlockTrxRequest = BlockTrx & {
	expiration: number;
};

export type BlockTrxStatus = BlockTrxRef & {
	statuses: ('pending' | 'committed' | 'checkpointed' | 'aborted')[];
};

export type PendSuccess = {
	success: true;
	/** List of already pending transactions that were found on blocks touched by this pend */
	pending: BlockTrx[];
	/** The transactionId and affected blocks */
	trxRef: BlockTrxRef;
};

export type StaleFailure = {
	success: false;
	/** List of transactions that have already been committed and are newer than our known revision */
	missing: BlockTrx[];
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
	pendingIds?: TransactionId[];
	/** Revision number of the collection */
	rev: number;
};

export type BlockGet = {
	blockId: BlockId;
} & BlockTrxContext;

export type GetBlockResult = {
	block: IBlock;
} & BlockTrxContext;
