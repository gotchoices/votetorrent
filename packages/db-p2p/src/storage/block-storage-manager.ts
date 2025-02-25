import type { BlockId, TrxRev } from "@votetorrent/db-core";
import type { BlockArchive, BlockMetadata, RestoreCallback, RevisionRange } from "./struct.js";
import type { IRawStorage } from "./i-raw-storage.js";
import { mergeRanges } from "./helpers.js";

export class BlockStorageManager {
    private metadata?: BlockMetadata;
    private initialized = false;

    constructor(
        private readonly blockId: BlockId,
        private readonly storage: IRawStorage,
        private readonly restoreCallback?: RestoreCallback
    ) {}

    /** Gets the latest revision information for this block */
    get latest(): TrxRev | undefined {
        return this.metadata?.latest;
    }

    /** Ensures the block storage is initialized */
    async init(): Promise<void> {
        if (this.initialized) return;

        this.metadata = await this.storage.getMetadata(this.blockId);
        if (!this.metadata) {
            // Initialize empty block storage
            this.metadata = {
                latest: undefined,
                ranges: [[0]] // Start with empty range
            };
            await this.storage.saveMetadata(this.blockId, this.metadata);
        }
        this.initialized = true;
    }

    /** Ensures the given revision is available in storage */
    async ensureRevision(rev: number): Promise<void> {
        await this.init();

        if (!this.inRanges(rev)) {
            const restored = await this.restoreBlock(rev);
            if (!restored) {
                throw new Error(`Block ${this.blockId} revision ${rev} not found`);
            }
            await this.saveRestored(restored);

            // Update metadata with new range
            this.metadata!.ranges.unshift(restored.range);
            this.metadata!.ranges = mergeRanges(this.metadata!.ranges);

            // Update latest if necessary
            if (restored.revisions) {
                const [revMax, { trx: { trxId } }] = this.maxRev(restored.revisions);
                this.metadata!.latest = this.metadata!.latest && this.metadata!.latest.rev > revMax
                    ? this.metadata!.latest
                    : { trxId, rev: revMax };
            }

            await this.storage.saveMetadata(this.blockId, this.metadata!);
        }
    }

    private async restoreBlock(rev: number): Promise<BlockArchive | undefined> {
        if (!this.restoreCallback) return undefined;
        return await this.restoreCallback(this.blockId, rev);
    }

    private async saveRestored(archive: BlockArchive) {
        const revisions = Object.entries(archive.revisions)
            .map(([rev, data]) => ({ rev: Number(rev), data }));

        // Save all revisions, transactions, and materializations
        for (const { rev, data: { trx, block } } of revisions) {
            await Promise.all([
                this.storage.saveRevision(this.blockId, rev, trx.trxId),
                this.storage.saveTransaction(this.blockId, trx.trxId, trx.transform),
                block ? this.storage.saveMaterializedBlock(this.blockId, trx.trxId, block) : Promise.resolve()
            ]);
        }
    }

    private inRanges(rev: number): boolean {
        if (!this.metadata) return false;
        return this.metadata.ranges.some(range =>
            rev >= range[0] && (range[1] === undefined || rev < range[1])
        );
    }

    private maxRev<T>(revisions: Record<number, T>): readonly [number, T] {
        return Object.entries(revisions)
            .map(([rev, data]) => [Number(rev), data] as const)
            .reduce((a, b) => (a[0] > b[0] ? a : b), [0, undefined] as [number, T]);
    }
}
