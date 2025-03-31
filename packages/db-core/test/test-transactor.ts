import { type ITransactor, type GetBlockResults, type TrxBlocks, type BlockTrxStatus, type PendResult, type CommitResult, type PendRequest, type BlockId, type CommitRequest, type BlockGets, type IBlock, type TrxId, type TrxTransforms, type Transform, type BlockOperations, type Transforms, ensuredMap } from "../src/index.js";
import { applyTransform, blockIdsForTransforms, transformForBlockId, emptyTransforms, concatTransform, transformsFromTransform } from "../src/transform/index.js";

type RevisionNumber = number;

type BlockState = {
  /** The current materialized block at each revision */
  materializedBlocks: Map<RevisionNumber, IBlock>;
  /** The latest revision number */
  latestRev: RevisionNumber;
  /** The transaction that created each revision */
  revisionTrxs: Map<RevisionNumber, TrxId>;
  /** Currently pending transactions */
  pendingTrxs: Map<TrxId, Transform>;
	/** Committed transactions */
	committedTrxs: Map<TrxId, Transform>;
}

// Simple in-memory transactor for testing that maintains materialized blocks for every revision
export class TestTransactor implements ITransactor {
  private blocks = new Map<BlockId, BlockState>();
	available = true;

  constructor() {}

  async get(blockGets: BlockGets): Promise<GetBlockResults> {
		this.checkAvailable();
    const results: GetBlockResults = {};
    for (const blockId of blockGets.blockIds) {
      const blockState = this.blocks.get(blockId);
      if (!blockState) {
        // Block doesn't exist yet
        results[blockId] = {
          block: undefined,
          state: { latest: undefined, pendings: [] }
        };
        continue;
      }

      // Get the appropriate materialized block based on context
      let block: IBlock | undefined;
      if (blockGets.context?.trxId !== undefined) {
        // If requesting a specific transaction, apply pending transform if it exists
        const pendingTransform = blockState.pendingTrxs.get(blockGets.context.trxId);
        if (pendingTransform) {
          const baseBlock = blockState.materializedBlocks.get(blockState.latestRev);
          block = applyTransformSafe(baseBlock, pendingTransform);
        }
      } else if (blockGets.context?.rev !== undefined) {
        // If requesting a specific revision, get the materialized block at that revision
        block = structuredClone(blockState.materializedBlocks.get(blockGets.context.rev));
      } else {
        // Otherwise return latest materialized block
        block = structuredClone(blockState.materializedBlocks.get(blockState.latestRev));
      }


      const trxId = blockState.revisionTrxs.get(blockState.latestRev);
      results[blockId] = {
        block,
        state: {
          latest: trxId !== undefined ? {
            rev: blockState.latestRev,
            trxId
          } : undefined,
          pendings: Array.from(blockState.pendingTrxs.keys())
        }
      };
    }
    return results;
  }

  async getStatus(trxRefs: TrxBlocks[]): Promise<BlockTrxStatus[]> {
    return trxRefs.map(ref => ({
      ...ref,
      statuses: ref.blockIds.map(blockId => {
        const blockState = this.blocks.get(blockId);
        if (!blockState) return 'aborted';
        return blockState.pendingTrxs.has(ref.trxId) ? 'pending'
					: Array.from(blockState.revisionTrxs.values()).some(trxId => trxId === ref.trxId) ? 'committed'
					: 'aborted';
      })
    }));
  }

  async pend(request: PendRequest): Promise<PendResult> {
		this.checkAvailable();
    const { trxId, transforms, policy } = request;
    const updatedBlockIds = Object.keys(transforms.updates) as BlockId[];

		const conflictingUpdates = updatedBlockIds.filter(blockId => {
			const blockState = this.blocks.get(blockId);
			return blockState && blockState.pendingTrxs.size > 0;
		});
		const pending = conflictingUpdates.map(blockId => {
			const blockState = this.blocks.get(blockId);
			return {
				blockId,
				trxId: Array.from(blockState!.pendingTrxs.keys())[0]!
			};
		});

		const insertBlockIds = Object.keys(transforms.inserts) as BlockId[];
		const conflictingInserts = insertBlockIds.filter(blockId => this.blocks.has(blockId));
		pending.push(...conflictingInserts.map(blockId => {
			const blockState = this.blocks.get(blockId);
			return {
				blockId,
				trxId: Array.from(blockState!.pendingTrxs.keys())[0]!
			};
		}));

		// Check for existing pending transactions or conflicting inserts if needed
    if (policy === 'f' && (pending.length > 0 || conflictingInserts.length > 0)) {
      return { success: false, pending };
    }

    // Initialize block states if needed and store pending transaction
		const blockIds = blockIdsForTransforms(transforms);
    for (const blockId of blockIds) {
			const blockState = ensuredMap(this.blocks, blockId, () => newBlockState());
      blockState.pendingTrxs.set(trxId, transformForBlockId(transforms, blockId));
    }

    return {
      success: true,
      pending,
      blockIds
    };
  }

  async cancel(trxRef: TrxBlocks): Promise<void> {
		this.checkAvailable();
    for (const blockId of trxRef.blockIds) {
      const blockState = this.blocks.get(blockId);
      if (blockState) {
        blockState.pendingTrxs.delete(trxRef.trxId);
      }
    }
  }

  async commit(request: CommitRequest): Promise<CommitResult> {
		this.checkAvailable();
    const { trxId, rev, blockIds } = request;

    // Check for stale revisions
    const staleBlocks = blockIds.filter(blockId => {
      const blockState = this.blocks.get(blockId);
      return blockState && blockState.latestRev >= rev;
    });

    if (staleBlocks.length > 0) {
      // Collect missing transactions for stale blocks
      const missingByTrx = new Map<TrxId, Transforms>();
      for (const blockId of staleBlocks) {
        const blockState = this.blocks.get(blockId)!;
        for (let r = rev; r <= blockState.latestRev; r++) {
          const trxId = blockState.revisionTrxs.get(r);
          if (trxId) {
            const transform = blockState.pendingTrxs.get(trxId);
            if (transform) {
              const existing = missingByTrx.get(trxId) ?? emptyTransforms();
              missingByTrx.set(trxId, concatTransform(existing, blockId, transform));
            }
          }
        }
      }

      const missing: TrxTransforms[] = Array.from(missingByTrx.entries()).map(([trxId, transforms]) => ({
        trxId,
        transforms
      }));
      return { success: false, missing };
    }

    // Verify all blocks have the pending transaction
    for (const blockId of blockIds) {
      const blockState = this.blocks.get(blockId);
      if (!blockState || !blockState.pendingTrxs.has(trxId)) {
        return {
          success: false,
          reason: `Transaction ${trxId} not found for block ${blockId}`
        };
      }
    }

    // Commit the transaction for each block
    for (const blockId of blockIds) {
      const blockState = this.blocks.get(blockId)!;
      const transform = blockState.pendingTrxs.get(trxId)!;

      // Get base block to apply transform to
      const baseBlock = blockState.materializedBlocks.get(blockState.latestRev);
      if (!baseBlock) {
				if (!transform.insert) {
					throw new Error(`Transaction ${trxId} has no insert for block ${blockId}`);
				}
				blockState.materializedBlocks.set(rev, structuredClone(transform.insert));
			} else {
				const newBlock = applyTransformSafe(baseBlock, transform);
				if (newBlock) {
					blockState.materializedBlocks.set(rev, newBlock);
				}	else {// Presumably a delete otherwise.  Verify...
					if (!transform.delete) {
						throw new Error(`Transaction ${trxId} has no delete for block ${blockId}`);
					}
				}
			}

      // Update block state
      blockState.latestRev = rev;
      blockState.revisionTrxs.set(rev, trxId);
			blockState.committedTrxs.set(trxId, transform);
      blockState.pendingTrxs.delete(trxId);
    }

    return { success: true };
  }

  // Helper methods for testing
  reset() {
    this.blocks.clear();
  }

  getPendingTransactions(): Map<TrxId, TrxTransforms> {
    const allPending = new Map<TrxId, TrxTransforms>();
    for (const [blockId, blockState] of this.blocks.entries()) {
      for (const [trxId, transform] of blockState.pendingTrxs) {
        const existing = allPending.get(trxId);
        if (!existing) {
          allPending.set(trxId, { trxId, transforms: transformsFromTransform(transform, blockId) });
        } else {
          existing.transforms = concatTransform(existing.transforms, blockId, transform);
        }
      }
    }
    return allPending;
  }

  getCommittedTransactions(): Map<TrxId, TrxTransforms> {
    const allCommitted = new Map<TrxId, TrxTransforms>();
    for (const [blockId, blockState] of this.blocks.entries()) {
      for (const [rev, trxId] of blockState.revisionTrxs) {
        const transform = blockState.committedTrxs.get(trxId);
        if (transform) {
          const existing = allCommitted.get(trxId);
          if (!existing) {
            allCommitted.set(trxId, {
              trxId,
              rev,
              transforms: transformsFromTransform(transform, blockId)
            });
          } else {
            existing.transforms = concatTransform(existing.transforms, blockId, transform);
          }
        }
      }
    }
    return allCommitted;
  }

	setAvailable(available: boolean) {
		this.available = available;
	}

	checkAvailable() {
		if (!this.available) {
			throw new Error('Transactor is not available');
		}
	}
}

function newBlockState(): BlockState {
	return {
		materializedBlocks: new Map(),
		latestRev: 0,
		revisionTrxs: new Map(),
		pendingTrxs: new Map(),
		committedTrxs: new Map()
	};
}

function applyTransformSafe(block: IBlock | undefined, transform: Transform): IBlock | undefined {
  if (!block) return undefined;
  return applyTransform(structuredClone(block), transform);
}
