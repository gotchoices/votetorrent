import { BlockId, IBlock, Transform, Transforms, TrxId, TrxRev, TrxTransform, TrxTransforms } from "../../../db-core/src/index.js";

export type RevisionRange = [
	/** Inclusive start */
	startRev: number,
	/** Exclusive end, or open-ended if undefined */
	endRev?: number,
];

export type BlockMetadata = {
	// Revision ranges that are present in storage
	ranges: RevisionRange[];
	/** Latest revision - present if the repo is not empty */
	latest?: TrxRev;
};

export type ArchiveRevisions = Record<number, { trx: TrxTransform, block?: IBlock }>;

export type BlockArchive = {
	blockId: BlockId;
	/** Revisions in this archive */
	revisions: ArchiveRevisions;
	/** Explicit range covered by this archive since revisions may be sparse */
	range: RevisionRange;
	/** Pending transactions - present if this range is open-ended */
	pending?: Record<TrxId, TrxTransforms>;
}

/** Should return a BlockRepo with the given rev (materialized) if given,
 * else (no rev) at least the latest revision and any given pending transactions */
export type RestoreCallback = (blockId: BlockId, rev?: number) => Promise<BlockArchive | undefined>;


export interface IBlockStorage {
	// Metadata operations
	getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined>;
	saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void>;

	// Revision operations
	getRevision(blockId: BlockId, rev: number): Promise<TrxId | undefined>;
	saveRevision(blockId: BlockId, rev: number, trxId: TrxId): Promise<void>;
	/** List revisions in ascending or descending order, depending on startRev and endRev - startRev and endRev are inclusive */
	listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<TrxRev>;

	// Transaction operations
	getPendingTransaction(blockId: BlockId, trxId: TrxId): Promise<Transform | undefined>;
	savePendingTransaction(blockId: BlockId, trxId: TrxId, transform: Transform): Promise<void>;
	deletePendingTransaction(blockId: BlockId, trxId: TrxId): Promise<void>;
	listPendingTransactions(blockId: BlockId): AsyncIterable<TrxId>;

	getTransaction(blockId: BlockId, trxId: TrxId): Promise<Transform | undefined>;
	saveTransaction(blockId: BlockId, trxId: TrxId, transform: Transform): Promise<void>;

	// Block materialization operations
	getMaterializedBlock(blockId: BlockId, trxId: TrxId): Promise<IBlock | undefined>;
	saveMaterializedBlock(blockId: BlockId, trxId: TrxId, block?: IBlock): Promise<void>;

	// Promote a pending transaction to a transaction
	promotePendingTransaction(blockId: BlockId, trxId: TrxId): Promise<void>;
}
