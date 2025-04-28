import { type ITransactor, type GetBlockResults, type TrxBlocks, type BlockTrxStatus, type PendResult, type CommitResult, type PendRequest, type BlockId, type CommitRequest, type BlockGets, type IBlock, type TrxId, type TrxTransforms, type Transform, type Transforms, ensuredMap, Latches } from "../src/index.js";
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
		const { trxId, transforms, policy, rev } = request;
		const blockIds = blockIdsForTransforms(transforms);
		const conflictingPendings: { blockId: BlockId, trxId: TrxId }[] = [];
		const missing: TrxTransforms[] = [];

		// Check for conflicts (pending or committed based on rev/insert)
		for (const blockId of blockIds) {
			const blockState = this.blocks.get(blockId);
			const blockTransform = transformForBlockId(transforms, blockId);
			if (!blockTransform) continue; // Should not happen

			if (blockState) {
				// Check for existing pending transactions
				if (blockState.pendingTrxs.size > 0) {
					blockState.pendingTrxs.forEach((_, pendingTrxId) => {
						conflictingPendings.push({ blockId, trxId: pendingTrxId });
					});
				}

				// Check for conflicting committed revisions (if rev specified or it's an insert)
				if (rev !== undefined || blockTransform.insert) {
					const checkRev = rev ?? 0; // Check from revision 0 if it's an insert
					if (blockState.latestRev >= checkRev) {
						// Collect conflicting committed transactions
						const missingForBlock = new Map<TrxId, { rev: number, transform: Transform }>();
						for (let r = checkRev as number; r <= blockState.latestRev; r++) {
							const committedTrxId = blockState.revisionTrxs.get(r);
							if (committedTrxId !== undefined) {
								const committedTransform = blockState.committedTrxs.get(committedTrxId);
								if (committedTransform) {
									missingForBlock.set(committedTrxId, { rev: r, transform: committedTransform });
								}
							}
						}

						// Add collected missing transforms for this block to the main missing list
						for (const [mTrxId, data] of missingForBlock.entries()) {
							let existing = missing.find(m => m.trxId === mTrxId);
							if (!existing) {
								existing = { trxId: mTrxId, rev: data.rev, transforms: emptyTransforms() };
								missing.push(existing);
							}
							existing.rev = Math.max(existing.rev ?? 0, data.rev);
							existing.transforms = concatTransform(existing.transforms, blockId, data.transform);
						}
					}
				}
			}
		}

		// Handle failure due to committed conflicts first
		if (missing.length > 0) {
			return {
				success: false,
				missing
			};
		}

		// Handle failure/retry due to pending conflicts
		if (conflictingPendings.length > 0) {
			if (policy === 'f') {
				return { success: false, pending: conflictingPendings };
			} else if (policy === 'r') {
				// Simulate fetching pending transforms for 'r' policy
				const pendingWithTransforms = conflictingPendings
					.map(({ blockId: pBlockId, trxId: pTrxId }) => {
						const pBlockState = this.blocks.get(pBlockId);
						const pTransform = pBlockState?.pendingTrxs.get(pTrxId)
							?? pBlockState?.committedTrxs.get(pTrxId); // Might have been committed since check
						if (pTransform) {
							return { blockId: pBlockId, trxId: pTrxId, transform: pTransform };
						}
						return null; // Handle case where it disappeared (cancelled?)
					})
					.filter(p => p !== null) as { blockId: BlockId, trxId: TrxId, transform: Transform }[];

				return {
					success: false,
					pending: pendingWithTransforms
				};
			}
			// Policy 'w' allows proceeding despite pending transactions
		}

		// No fatal conflicts found, proceed to pend
		for (const blockId of blockIds) {
			const blockTransform = transformForBlockId(transforms, blockId);
			if (blockTransform) {
				const blockState = ensuredMap(this.blocks, blockId, () => newBlockState());
				blockState.pendingTrxs.set(trxId, blockTransform);
			}
		}

		// Return success, include pending list as per StorageRepo behavior
		return {
			success: true,
			pending: conflictingPendings,
			blockIds
		} as PendResult;
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
    const uniqueBlockIds = [...new Set(blockIds)].sort();
    const releases: (() => void)[] = [];

    try {
      // Simulate acquiring locks sequentially like StorageRepo
      for (const id of uniqueBlockIds) {
        const lockId = `TestTransactor.commit:${id}`;
        const release = await Latches.acquire(lockId);
        releases.push(release);
      }

      // --- Start of Critical Section (Simulated) ---

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
            const committedTrxId = blockState.revisionTrxs.get(r);
            if (committedTrxId) {
              const transform = blockState.committedTrxs.get(committedTrxId);
              if (transform) {
                const existing = missingByTrx.get(committedTrxId) ?? emptyTransforms();
                missingByTrx.set(committedTrxId, concatTransform(existing, blockId, transform));
              }
            }
          }
        }

        const missing: TrxTransforms[] = Array.from(missingByTrx.entries()).map(([trxId, transforms]) => ({
          trxId,
          rev: Array.from(this.blocks.values())
            .flatMap(bs => Array.from(bs.revisionTrxs.entries()))
            .find(([, tId]) => tId === trxId)?.[0] ?? rev,
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
            reason: `Transaction ${trxId} not found or not pending for block ${blockId}`
          };
        }
      }

      // Commit the transaction for each block
      for (const blockId of blockIds) {
        const blockState = this.blocks.get(blockId)!;
        const transform = blockState.pendingTrxs.get(trxId)!;

        // Get base block to apply transform to
        const baseBlock = blockState.materializedBlocks.get(blockState.latestRev);

        let newBlock: IBlock | undefined;
        if (!baseBlock) {
          if (!transform.insert) {
            throw new Error(`Commit Error: Transaction ${trxId} has no insert for new block ${blockId}`);
          }
          newBlock = structuredClone(transform.insert);
        } else {
          newBlock = applyTransformSafe(baseBlock, transform);
          if (!newBlock && !transform.delete) {
            throw new Error(`Commit Error: Transaction ${trxId} resulted in undefined block but had no delete flag for block ${blockId}`);
          }
        }

        if (newBlock) {
          blockState.materializedBlocks.set(rev, newBlock);
        }

        // Update block state
        blockState.latestRev = rev;
        blockState.revisionTrxs.set(rev, trxId);
        blockState.committedTrxs.set(trxId, transform);
        blockState.pendingTrxs.delete(trxId);
      }

      // --- End of Critical Section (Simulated) ---

      return { success: true };

    } finally {
      // Release locks in reverse order
      releases.reverse().forEach(release => release());
    }
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
