import type { BlockId, IBlock, Transform, ActionId, ActionRev } from "@optimystic/db-core";
import type { RestoreCallback } from "./struct.js";
import type { IRawStorage } from "./i-raw-storage.js";
import type { IBlockStorage } from "./i-block-storage.js";
export declare class BlockStorage implements IBlockStorage {
    private readonly blockId;
    private readonly storage;
    private readonly restoreCallback?;
    constructor(blockId: BlockId, storage: IRawStorage, restoreCallback?: RestoreCallback | undefined);
    getLatest(): Promise<ActionRev | undefined>;
    getBlock(rev?: number): Promise<{
        block: IBlock;
        actionRev: ActionRev;
    } | undefined>;
    getTransaction(actionId: ActionId): Promise<Transform | undefined>;
    getPendingTransaction(actionId: ActionId): Promise<Transform | undefined>;
    listPendingTransactions(): AsyncIterable<ActionId>;
    savePendingTransaction(actionId: ActionId, transform: Transform): Promise<void>;
    deletePendingTransaction(actionId: ActionId): Promise<void>;
    listRevisions(startRev: number, endRev: number): AsyncIterable<ActionRev>;
    saveMaterializedBlock(actionId: ActionId, block: IBlock | undefined): Promise<void>;
    saveRevision(rev: number, actionId: ActionId): Promise<void>;
    promotePendingTransaction(actionId: ActionId): Promise<void>;
    setLatest(latest: ActionRev): Promise<void>;
    recover(): Promise<{
        reconciled: boolean;
        latest?: ActionRev;
    }>;
    private ensureRevision;
    private materializeBlock;
    private restoreBlock;
    private saveRestored;
    private inRanges;
}
//# sourceMappingURL=block-storage.d.ts.map