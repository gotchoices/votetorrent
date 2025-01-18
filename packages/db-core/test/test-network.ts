import type { IBlockNetwork, GetBlockResults, TrxBlocks, BlockTrxStatus, PendResult, CommitResult, PendRequest, BlockId, CommitRequest, BlockGets, IBlock, TrxId, TrxTransforms } from "../src/index.js";

// Simple in-memory network for testing
export class TestNetwork implements IBlockNetwork {
  private blocks = new Map<BlockId, IBlock>();
  private pendingTrx = new Map<TrxId, TrxTransforms>();
  private committedTrx = new Map<TrxId, TrxTransforms>();
  private blockVersions = new Map<BlockId, number>();

  constructor() {}

  async get(blockGets: BlockGets): Promise<GetBlockResults> {
    const results: GetBlockResults = {};
    for (const blockId of blockGets.blockIds) {
      const block = this.blocks.get(blockId);
      const pendings = Array.from(this.pendingTrx.keys());
      const version = this.blockVersions.get(blockId) ?? 0;
      results[blockId] = {
        block: block ? structuredClone(block) : undefined,
        state: {
          latest: { rev: version, trxId: `trx-${version}` as TrxId },
          pendings
        }
      };
    }
    return results;
  }

  async getStatus(trxRefs: TrxBlocks[]): Promise<BlockTrxStatus[]> {
    return trxRefs.map(ref => ({
      ...ref,
      statuses: ref.blockIds.map(() =>
        this.committedTrx.has(ref.trxId) ? 'committed' :
        this.pendingTrx.has(ref.trxId) ? 'pending' : 'aborted'
      )
    }));
  }

  async pend(request: PendRequest): Promise<PendResult> {
    const { trxId, transforms } = request;

    // Check if any blocks have pending transactions
    const affectedBlocks = Object.keys(transforms.updates);
    const pendingOnBlocks = affectedBlocks.filter(blockId =>
      Array.from(this.pendingTrx.values()).some(t =>
        Object.keys(t.transforms.updates).includes(blockId)
      )
    );

    if (request.pending === 'f' && pendingOnBlocks.length > 0) {
      return {
        success: false,
        reason: 'Blocks have pending transactions',
        pending: pendingOnBlocks.map(blockId => ({
          blockId,
          trxId: Array.from(this.pendingTrx.keys())[0]
        }))
      };
    }

    // Apply the transforms
    for (const [blockId, block] of Object.entries(transforms.inserts)) {
      this.blocks.set(blockId, structuredClone(block));
    }

    this.pendingTrx.set(trxId, { trxId, transforms });

    return {
      success: true,
      pending: [],
      blockIds: affectedBlocks
    };
  }

  async cancel(trxRef: TrxBlocks): Promise<void> {
    this.pendingTrx.delete(trxRef.trxId);
  }

  async commit(tailId: BlockId, request: CommitRequest): Promise<CommitResult> {
    const { trxId, rev } = request;
    const pendingTrx = this.pendingTrx.get(trxId);

    if (!pendingTrx) {
      return {
        success: false,
        reason: 'Transaction not found'
      };
    }

    // Check if any affected blocks have been modified since we started
    const affectedBlocks = Object.keys(pendingTrx.transforms.updates);
    const staleBlocks = affectedBlocks.filter(blockId =>
      (this.blockVersions.get(blockId) ?? 0) > rev
    );

    if (staleBlocks.length > 0) {
      return {
        success: false,
        reason: 'Blocks have been modified',
        missing: Array.from(this.committedTrx.values())
          .filter(t => t.rev && t.rev > rev)
      };
    }

    // Commit the transaction
    this.committedTrx.set(trxId, { ...pendingTrx, rev });
    this.pendingTrx.delete(trxId);

    // Update block versions
    for (const blockId of affectedBlocks) {
      this.blockVersions.set(blockId, rev);
    }

    return { success: true };
  }

  // Helper methods for testing
  reset() {
    this.blocks.clear();
    this.pendingTrx.clear();
    this.committedTrx.clear();
    this.blockVersions.clear();
  }

  getPendingTransactions(): Map<TrxId, TrxTransforms> {
    return new Map(this.pendingTrx);
  }

  getCommittedTransactions(): Map<TrxId, TrxTransforms> {
    return new Map(this.committedTrx);
  }
}
