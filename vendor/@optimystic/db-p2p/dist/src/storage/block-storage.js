import { Latches, applyTransform } from "@optimystic/db-core";
import { mergeRanges } from "./helpers.js";
import { createLogger } from "../logger.js";
const log = createLogger('block-storage');
export class BlockStorage {
    blockId;
    storage;
    restoreCallback;
    constructor(blockId, storage, restoreCallback) {
        this.blockId = blockId;
        this.storage = storage;
        this.restoreCallback = restoreCallback;
    }
    async getLatest() {
        const meta = await this.storage.getMetadata(this.blockId);
        return meta?.latest;
    }
    async getBlock(rev) {
        const meta = await this.storage.getMetadata(this.blockId);
        if (!meta) {
            return undefined;
        }
        // Pending-only state: metadata was seeded by savePendingTransaction but no
        // revision has been committed yet. Treat as "doesn't exist" for the default
        // request path — matches StorageRepo.get()'s contract that undefined => empty.
        if (rev === undefined && meta.latest === undefined) {
            return undefined;
        }
        const targetRev = rev ?? meta.latest.rev;
        await this.ensureRevision(meta, targetRev);
        return await this.materializeBlock(meta, targetRev);
    }
    async getTransaction(actionId) {
        return await this.storage.getTransaction(this.blockId, actionId);
    }
    async getPendingTransaction(actionId) {
        return await this.storage.getPendingTransaction(this.blockId, actionId);
    }
    async *listPendingTransactions() {
        yield* this.storage.listPendingTransactions(this.blockId);
    }
    async savePendingTransaction(actionId, transform) {
        log('pend blockId=%s actionId=%s', this.blockId, actionId);
        let meta = await this.storage.getMetadata(this.blockId);
        if (!meta) {
            meta = { latest: undefined, ranges: [[0]] };
            await this.storage.saveMetadata(this.blockId, meta);
        }
        await this.storage.savePendingTransaction(this.blockId, actionId, transform);
    }
    async deletePendingTransaction(actionId) {
        log('cancel blockId=%s actionId=%s', this.blockId, actionId);
        await this.storage.deletePendingTransaction(this.blockId, actionId);
    }
    async *listRevisions(startRev, endRev) {
        yield* this.storage.listRevisions(this.blockId, startRev, endRev);
    }
    async saveMaterializedBlock(actionId, block) {
        await this.storage.saveMaterializedBlock(this.blockId, actionId, block);
    }
    async saveRevision(rev, actionId) {
        await this.storage.saveRevision(this.blockId, rev, actionId);
    }
    async promotePendingTransaction(actionId) {
        log('commit blockId=%s actionId=%s', this.blockId, actionId);
        await this.storage.promotePendingTransaction(this.blockId, actionId);
    }
    async setLatest(latest) {
        const meta = await this.storage.getMetadata(this.blockId);
        if (!meta) {
            throw new Error(`Block ${this.blockId} not found`);
        }
        meta.latest = latest;
        await this.storage.saveMetadata(this.blockId, meta);
    }
    async recover() {
        const meta = await this.storage.getMetadata(this.blockId);
        if (!meta) {
            return { reconciled: false };
        }
        const currentRev = meta.latest?.rev ?? 0;
        let maxRev = currentRev;
        let maxActionId = meta.latest?.actionId;
        // Probe forward until we hit a gap or a revision whose action is not yet
        // in the committed log (Crash-D2 state — retry-commit owns that advance).
        for (let next = currentRev + 1;; next++) {
            const actionId = await this.storage.getRevision(this.blockId, next);
            if (actionId === undefined)
                break;
            const promoted = await this.storage.getTransaction(this.blockId, actionId);
            if (promoted === undefined)
                break;
            maxRev = next;
            maxActionId = actionId;
        }
        if (maxRev > currentRev && maxActionId !== undefined) {
            const advanced = { rev: maxRev, actionId: maxActionId };
            meta.latest = advanced;
            await this.storage.saveMetadata(this.blockId, meta);
            log('recover blockId=%s advanced latest from rev=%d to rev=%d', this.blockId, currentRev, maxRev);
            return { reconciled: true, latest: advanced };
        }
        return { reconciled: false, latest: meta.latest };
    }
    async ensureRevision(meta, rev) {
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
        }
        finally {
            release();
        }
    }
    async materializeBlock(_meta, targetRev) {
        let block;
        let materializedActionRev;
        const actions = [];
        // Find the materialized block
        for await (const actionRev of this.storage.listRevisions(this.blockId, targetRev, 1)) {
            const materializedBlock = await this.storage.getMaterializedBlock(this.blockId, actionRev.actionId);
            if (materializedBlock) {
                block = materializedBlock;
                materializedActionRev = actionRev;
                break;
            }
            else {
                actions.push(actionRev);
            }
        }
        if (!block || !materializedActionRev) {
            // There is an implicit requirement that there must be a materialization of the block somewhere in it's history.  If the log is truncated, a materialization must be made at the truncation point..
            throw new Error(`Failed to find materialized block ${this.blockId} for revision ${targetRev}`);
        }
        // Apply transforms in reverse order
        for (let i = actions.length - 1; i >= 0; --i) {
            const { actionId } = actions[i];
            const transform = await this.storage.getTransaction(this.blockId, actionId);
            if (!transform) {
                throw new Error(`Missing action ${actionId} for block ${this.blockId}`);
            }
            block = applyTransform(block, transform);
        }
        if (!block) {
            throw new Error(`Block ${this.blockId} has been deleted`);
        }
        if (actions.length) {
            await this.storage.saveMaterializedBlock(this.blockId, actions[0].actionId, block);
            return { block, actionRev: actions[0] };
        }
        return { block, actionRev: materializedActionRev };
    }
    async restoreBlock(rev) {
        if (!this.restoreCallback)
            return undefined;
        return await this.restoreCallback(this.blockId, rev);
    }
    async saveRestored(archive) {
        const revisions = Object.entries(archive.revisions)
            .map(([rev, data]) => ({ rev: Number(rev), data }));
        // Save all revisions, actions, and materializations
        for (const { rev, data: { action, block } } of revisions) {
            await Promise.all([
                this.storage.saveRevision(this.blockId, rev, action.actionId),
                this.storage.saveTransaction(this.blockId, action.actionId, action.transform),
                block ? this.storage.saveMaterializedBlock(this.blockId, action.actionId, block) : Promise.resolve()
            ]);
        }
    }
    inRanges(rev, ranges) {
        return ranges.some(range => rev >= range[0] && (range[1] === undefined || rev < range[1]));
    }
}
//# sourceMappingURL=block-storage.js.map