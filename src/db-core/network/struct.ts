import { BlockId, IBlock, TransactionId, Transform } from "../index.js";

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
	pending: BlockTrx[];
	trxRef: BlockTrxRef;
};

export type StaleFailure = {
	success: false;
	missing: BlockTrx[];
};

export type PendResult = PendSuccess | StaleFailure;

export type CommitResult = CommitSuccess | StaleFailure;

export type CommitSuccess = {
	success: true;
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
