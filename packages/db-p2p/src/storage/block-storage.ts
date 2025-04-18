import type { BlockId, IBlock, Transform, TrxId, TrxRev } from "@votetorrent/db-core";
import { Latches, applyTransform } from "@votetorrent/db-core";
import type { BlockArchive, BlockMetadata, RestoreCallback, RevisionRange } from "./struct.js";
import type { IRawStorage } from "./i-raw-storage.js";
import { mergeRanges } from "./helpers.js";
import type { IBlockStorage } from "./i-block-storage.js";

export class BlockStorage implements IBlockStorage {
    constructor(
        private readonly blockId: BlockId,
        private readonly storage: IRawStorage,
        private readonly restoreCallback?: RestoreCallback
    ) {}

    async getLatest(): Promise<TrxRev | undefined> {
        const meta = await this.storage.getMetadata(this.blockId);
        return meta?.latest;
    }

    async getBlock(rev?: number): Promise<{ block: IBlock, trxRev: TrxRev }> {
        const meta = await this.storage.getMetadata(this.blockId);
        if (!meta) {
            throw new Error(`Block ${this.blockId} not found`);
        }

        const targetRev = rev ?? meta.latest?.rev;
        if (targetRev === undefined) {
            throw new Error(`No revision specified and no latest revision exists for block ${this.blockId}`);
        }

        await this.ensureRevision(meta, targetRev);
        return await this.materializeBlock(meta, targetRev);
    }

    async getTransaction(trxId: TrxId): Promise<Transform | undefined> {
        return await this.storage.getTransaction(this.blockId, trxId);
    }

    async getPendingTransaction(trxId: TrxId): Promise<Transform | undefined> {
        return await this.storage.getPendingTransaction(this.blockId, trxId);
    }

    async *listPendingTransactions(): AsyncIterable<TrxId> {
        yield* this.storage.listPendingTransactions(this.blockId);
    }

    async savePendingTransaction(trxId: TrxId, transform: Transform): Promise<void> {
        let meta = await this.storage.getMetadata(this.blockId);
        if (!meta) {
            meta = { latest: undefined, ranges: [[0]] };
            await this.storage.saveMetadata(this.blockId, meta);
        }
        await this.storage.savePendingTransaction(this.blockId, trxId, transform);
    }

    async deletePendingTransaction(trxId: TrxId): Promise<void> {
        await this.storage.deletePendingTransaction(this.blockId, trxId);
    }

    async *listRevisions(startRev: number, endRev: number): AsyncIterable<TrxRev> {
        yield* this.storage.listRevisions(this.blockId, startRev, endRev);
    }

    async saveMaterializedBlock(trxId: TrxId, block: IBlock | undefined): Promise<void> {
        await this.storage.saveMaterializedBlock(this.blockId, trxId, block);
    }

    async saveRevision(rev: number, trxId: TrxId): Promise<void> {
        await this.storage.saveRevision(this.blockId, rev, trxId);
    }

    async promotePendingTransaction(trxId: TrxId): Promise<void> {
        await this.storage.promotePendingTransaction(this.blockId, trxId);
    }

    async setLatest(latest: TrxRev): Promise<void> {
        const meta = await this.storage.getMetadata(this.blockId);
        if (!meta) {
            throw new Error(`Block ${this.blockId} not found`);
        }
        meta.latest = latest;
        await this.storage.saveMetadata(this.blockId, meta);
    }

    private async ensureRevision(meta: BlockMetadata, rev: number): Promise<void> {
        if (this.inRanges(rev, meta.ranges)) {
            return;
        }

        const lockId = `BlockStorage.ensureRevision:${this.blockId}`;
        const release = await Latches.acquire(lockId);
        try {
            const currentMeta = await this.storage.getMetadata(this.blockId);
            if (!currentMeta) {
                throw new Error(`Block ${this.blockId} metadata disappeared unexpectedly.`);
            }
            if (this.inRanges(rev, currentMeta.ranges)) {
                return;
            }

            const restored = await this.restoreBlock(rev);
            if (!restored) {
                throw new Error(`Block ${this.blockId} revision ${rev} not found during restore attempt.`);
            }
            await this.saveRestored(restored);

            currentMeta.ranges.unshift(restored.range);
            currentMeta.ranges = mergeRanges(currentMeta.ranges);
            await this.storage.saveMetadata(this.blockId, currentMeta);

        } finally {
            release();
        }
    }

    private async materializeBlock(meta: BlockMetadata, targetRev: number): Promise<{ block: IBlock, trxRev: TrxRev }> {
        let block: IBlock | undefined;
        let materializedTrxRev: TrxRev | undefined;
        const transactions: TrxRev[] = [];

        // Find the materialized block
        for await (const trxRev of this.storage.listRevisions(this.blockId, targetRev, 1)) {
            const materializedBlock = await this.storage.getMaterializedBlock(this.blockId, trxRev.trxId);
            if (materializedBlock) {
                block = materializedBlock;
                materializedTrxRev = trxRev;
                break;
            } else {
                transactions.push(trxRev);
            }
        }

        if (!block || !materializedTrxRev) {
            throw new Error(`Failed to find materialized block ${this.blockId} for revision ${targetRev}`);
        }

        // Apply transforms in reverse order
        for (let i = transactions.length - 1; i >= 0; --i) {
            const { trxId } = transactions[i]!;
            const transform = await this.storage.getTransaction(this.blockId, trxId);
            if (!transform) {
                throw new Error(`Missing transaction ${trxId} for block ${this.blockId}`);
            }
            block = applyTransform(block, transform);
        }

        if (!block) {
            throw new Error(`Block ${this.blockId} has been deleted`);
        }
        if (transactions.length) {
            await this.storage.saveMaterializedBlock(this.blockId, transactions[0]!.trxId, block);
            return { block, trxRev: transactions[0]! };
        }
        return { block, trxRev: materializedTrxRev };
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

    private inRanges(rev: number, ranges: RevisionRange[]): boolean {
        return ranges.some(range =>
            rev >= range[0] && (range[1] === undefined || rev < range[1])
        );
    }
}
