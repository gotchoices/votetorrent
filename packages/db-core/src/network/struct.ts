import { CollectionId, BlockId, IBlock, TrxId, Transform } from "../index.js";
import { TrxContext, TrxRev } from "../transaction/struct.js";

export type TrxBlocks = {
	blockIds: BlockId[];
	trxId: TrxId;
};

export type TrxTransform = {
	trxId: TrxId;
	rev?: number;
	transform: Transform;
};

export type TrxPending = {
	blockId: BlockId;
	trxId: TrxId;
	transform?: Transform;
};

export type PendRequest = TrxTransform & {
	/** What to do if there are any pending transactions.
	 * 'c' is continue normally,
	 * 'f' is fail, returning the pending TrxIds,
	 * 'r' is return, which fails but returns the pending TrxIds and their transforms */
	pending: 'c' | 'f' | 'r';
};

export type BlockTrxStatus = TrxBlocks & {
	statuses: ('pending' | 'committed' | 'checkpointed' | 'aborted')[];
};

export type PendSuccess = {
	success: true;
	/** List of already pending transactions that were found on blocks touched by this pend */
	pending: TrxPending[];
	/** The transactionId and affected blocks */
	trxRef: TrxBlocks;
};

export type StaleFailure = {
	success: false;
	/** List of transactions that have already been committed and are newer than our known revision */
	missing?: TrxTransform[];
	/** List of transactions that are pending on the blocks touched by this pend */
	pending?: TrxPending[];
};

export type PendResult = PendSuccess | StaleFailure;

export type CommitRequest = TrxBlocks & {
	rev: number;
};

export type CommitResult = CommitSuccess | StaleFailure;

export type CommitSuccess = {
	success: true;
	/** If present, the identified collection acts as the coordinator for the multi-collection transaction */
	coordinatorId?: CollectionId;
};

export type BlockTrxState = {
	/** The latest transaction that has been committed */
	latest?: TrxRev;
	/** If present, the specified transactions are pending */
	pendings?: TrxId[];
};

export type BlockGets = {
	blockIds: BlockId[];
	context?: TrxContext;	// Latest if this is omitted
};

export type GetBlockResult = {
	/** The retrieved block - undefined if the block was deleted	 */
	block?: IBlock;
	/** The latest and pending states of the repo that retrieved the block */
	state: BlockTrxState;
};
