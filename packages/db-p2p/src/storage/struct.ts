import type { BlockId, IBlock, TrxId, TrxRev, TrxTransform, TrxTransforms } from "@votetorrent/db-core";

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



