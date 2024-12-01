import { BlockGet, GetBlockResult, BlockTrxRef, BlockTrxStatus, PendResult, CommitResult, BlockTrxRequest, BlockId } from "../index.js";

export type BlockNetwork = {
	/** Get blocks by their IDs and versions or a specific transaction
		- Does not update the version of the block, but the transaction is available for explicit reading, and for committing
		- If the transaction targets the correct version, the call succeeds, unless failIfPending and there are any pending transactions - the caller may choose to wait for pending transactions to clear rather than risk racing with them
		- If the transaction targets an older version, the call fails, and the caller must resync using the missing transactions
	 */
	get(blockGets: BlockGet[]): Promise<GetBlockResult[]>;

	/** Get statuses of block transactions */
	getStatus(trxRefs: BlockTrxRef[]): Promise<BlockTrxStatus[]>;

	/** Post a transaction for a set of block
		- Does not update the version of the block, but the transaction is available for explicit reading, and for committing
		- If the transaction targets the correct version, the call succeeds, unless failIfPending and there are any pending transactions - the caller may choose to wait for pending transactions to clear rather than risk racing with them
		- If the transaction targets an older version, the call fails, and the caller must resync using the missing transactions
	 */
	pend(blockTrx: BlockTrxRequest, options: { pending: 'return' | 'fail' }): Promise<PendResult>;

	/** Cancel a pending transaction
		- If the given transaction ID is pending, it is canceled
	 */
	cancel(trxRef: BlockTrxRef): Promise<void>;

	/** Commit a pending transaction
		- If the transaction references the current version, the pending transaction is conditionally committed
		- The returned conditions are those uncommitted inherited from older transaction(s) - if any of those are aborted, this transaction will implicitly be aborted
		- If the transaction mentions other collections, those are assumed conditions - returned conditions only list inherited conditions
	 */
	commit(tailId: BlockId, trxRef: BlockTrxRef): Promise<CommitResult>;
}
