import type { BlockId, TrxId, TrxRev, Transform, IBlock } from "@votetorrent/db-core";
import type { BlockMetadata } from "./struct";

export interface IRawStorage {
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
