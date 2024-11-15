import { IBlock, BlockId, BlockOperations } from "./structs.js";

export type TransactionId = string;

export type Mutations = {
	inserts: IBlock[];
	updates: Map<BlockId, BlockOperations>;
	deletes: BlockId[];
};

export type BlockTrxRef = {
	blockIds: BlockId[];
	transactionId: TransactionId;
};

export type BlockTrx = {
	transactionId: TransactionId;
	mutations: Mutations;
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

export type Condition = {
	blockId: BlockId;
	transactionId: TransactionId;
};

export type CommitSuccess = {
	success: true;
	conditions: Condition[];
};

export type BlockGet = {
	blockId: BlockId;
	transactionId?: TransactionId;
	collectionRev?: number;
};

export type GetBlockResult = {
	block: IBlock;
	transactionId?: TransactionId;
	collectionRev?: number;
};

