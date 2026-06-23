import type { ActionId, ActionRev, BlockId, IBlock, Transform } from '@optimystic/db-core';
import type { BlockMetadata, IRawStorage } from '@optimystic/db-p2p';
import { type LevelDBLike } from './leveldb-like.js';
/**
 * LevelDB-backed `IRawStorage` implementation for React Native peers.
 *
 * All data lives in a single LevelDB database; per-store partitioning is by a
 * leading tag byte (see `./keys.ts`). `listRevisions` and
 * `listPendingTransactions` use range iterators with explicit bounds, drained
 * into an array before yielding (same rationale as the IndexedDB / SQLite
 * backends — a native iterator must not stay open across consumer awaits).
 *
 * `promotePendingTransaction` runs as a single `WriteBatch`, making the
 * pending → committed move atomic against crashes.
 */
export declare class LevelDBRawStorage implements IRawStorage {
    private readonly db;
    constructor(db: LevelDBLike);
    getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined>;
    saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void>;
    getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined>;
    saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void>;
    listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev>;
    getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined>;
    savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void>;
    deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void>;
    listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId>;
    getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined>;
    saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void>;
    getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined>;
    saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void>;
    getApproximateBytesUsed(): Promise<number>;
    promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void>;
}
//# sourceMappingURL=leveldb-storage.d.ts.map