import type { CollectionId, BlockId, IBlock, TrxId, Transform, Transforms } from "../index.js";
import type { TrxContext, TrxRev } from "../collection/transaction.js";

export type TrxBlocks = {
	blockIds: BlockId[];
	trxId: TrxId;
};

export type TrxTransforms = {
	trxId: TrxId;
	rev?: number;
	transforms: Transforms;
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

export type PendRequest = TrxTransforms & {
	/** What to do if there are any pending transactions.
	 * 'c' is continue normally,
	 * 'f' is fail, returning the pending TrxIds,
	 * 'r' is return, which fails but returns the pending TrxIds and their transforms */
	policy: 'c' | 'f' | 'r';
};

export type BlockTrxStatus = TrxBlocks & {
	statuses: ('pending' | 'committed' | 'checkpointed' | 'aborted')[];
};

export type PendSuccess = {
	success: true;
	/** List of already pending transactions that were found on blocks touched by this pend */
	pending: TrxPending[];
	/** The affected blocks */
	blockIds: BlockId[];
};

export type StaleFailure = {
	success: false;
	/** The reason for the failure */
	reason?: string;
	/** List of transactions that have already been committed and are newer than our known revision */
	missing?: TrxTransforms[];
	/** List of transactions that are pending on the blocks touched by this pend */
	pending?: TrxPending[];
};

export type PendResult = PendSuccess | StaleFailure;

export type CommitRequest = TrxBlocks & {
	/** The header block of the collection, if this is a new collection (commit first) */
	headerId?: BlockId;
	/** The tail block of the log (commit next) */
	tailId: BlockId;
	/** The new revision for the committed transaction */
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

export type GetBlockResults = Record<BlockId, GetBlockResult>;
