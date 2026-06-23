import type { BlockId, IBlock, ActionId, ActionRev, ActionTransform, ActionTransforms } from "@optimystic/db-core";
export type RevisionRange = [
    /** Inclusive start */
    startRev: number,
    /** Exclusive end, or open-ended if undefined */
    endRev?: number
];
export type BlockMetadata = {
    ranges: RevisionRange[];
    /** Latest revision - present if the repo is not empty */
    latest?: ActionRev;
};
export type ArchiveRevisions = Record<number, {
    action: ActionTransform;
    block?: IBlock;
}>;
export type BlockArchive = {
    blockId: BlockId;
    /** Revisions in this archive */
    revisions: ArchiveRevisions;
    /** Explicit range covered by this archive since revisions may be sparse */
    range: RevisionRange;
    /** Pending actions - present if this range is open-ended */
    pending?: Record<ActionId, ActionTransforms>;
};
/** Should return a BlockRepo with the given rev (materialized) if given,
 * else (no rev) at least the latest revision and any given pending transactions */
export type RestoreCallback = (blockId: BlockId, rev?: number) => Promise<BlockArchive | undefined>;
//# sourceMappingURL=struct.d.ts.map