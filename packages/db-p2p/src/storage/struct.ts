import { BlockId, IBlock, Transform, TrxId, TrxTransform } from "../../../db-core/src/index.js";

export type BlockMetadata = {
	latestRev: number;
	deleted?: {
		trxId: TrxId;
		rev: number;
	};
};

export type BlockRevision = {
	rev: number;
	trxId: TrxId;
};

export type BlockRestoration = {
	blockId: BlockId;
	pending: Record<TrxId, TrxTransform>;
	revisions: Record<number, { trx: TrxTransform, block?: IBlock }>;
}

/** Should return a BlockRepo with the given rev (materialized) if given,
 * else (no rev) at least the latest revision and any given pending transactions */
export type RestoreCallback = (blockId: BlockId, rev?: number) => Promise<BlockRestoration | undefined>;


export interface IBlockStorage {
	// Metadata operations
	getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined>;
	saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void>;

	// Revision operations
	getRevision(blockId: BlockId, rev: number): Promise<TrxId | undefined>;
	saveRevision(blockId: BlockId, rev: number, trxId: TrxId): Promise<void>;

	// Transaction operations
	getPendingTransaction(blockId: BlockId, trxId: TrxId): Promise<TrxTransform | undefined>;
	savePendingTransaction(blockId: BlockId, trxId: TrxId, transform: Transform): Promise<void>;
	deletePendingTransaction(blockId: BlockId, trxId: TrxId): Promise<void>;
	getAllPendingTransactions(blockId: BlockId): Promise<Map<TrxId, TrxTransform>>;

	getTransaction(blockId: BlockId, trxId: TrxId): Promise<TrxTransform | undefined>;
	saveTransaction(blockId: BlockId, trxId: TrxId, transform: TrxTransform): Promise<void>;

	// Block materialization operations
	getMaterializedBlock(blockId: BlockId, trxId: TrxId): Promise<IBlock | undefined>;
	saveMaterializedBlock(blockId: BlockId, trxId: TrxId, block: IBlock): Promise<void>;

	// Promote a pending transaction to a transaction
	promotePendingTransaction(blockId: BlockId, trxId: TrxId): Promise<void>;
}
