import { ensuredMap, Latches } from "../src/index.js";
import { applyTransform, blockIdsForTransforms, transformForBlockId, emptyTransforms, concatTransform, transformsFromTransform } from "../src/transform/index.js";
// Simple in-memory transactor for testing that maintains materialized blocks for every revision
export class TestTransactor {
    blocks = new Map();
    available = true;
    getLocks = new Map(); // Track lock releases
    constructor() { }
    async get(blockGets) {
        this.checkAvailable();
        const results = {};
        const uniqueBlockIds = [...new Set(blockGets.blockIds)].sort(); // Ensure consistent lock order if needed, though get is read-only
        const releases = [];
        try {
            // Acquire locks for all requested blocks to ensure consistent read
            for (const blockId of uniqueBlockIds) {
                const lockId = `TestTransactor.commit:${blockId}`; // Use the same lock as commit
                // Wait for any existing lock promise to resolve before acquiring the next
                let release = await this.getLocks.get(lockId);
                if (release)
                    await Promise.resolve(release); // Ensure previous lock released if overlapping calls happen
                const releasePromise = Latches.acquire(lockId);
                this.getLocks.set(blockId, releasePromise.then(r => () => {
                    r();
                    this.getLocks.delete(blockId); // Clean up map entry after release
                }));
                release = await releasePromise;
                releases.push(release);
            }
            // --- Start of Critical Section (Read) ---
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
                let block;
                if (blockGets.context?.actionId !== undefined) {
                    // If requesting a specific action, apply pending transform if it exists
                    const pendingTransform = blockState.pendingActions.get(blockGets.context.actionId);
                    if (pendingTransform) {
                        // Read latest committed block as base for pending transform
                        const baseBlock = blockState.materializedBlocks.get(blockState.latestRev);
                        block = applyTransformSafe(baseBlock, pendingTransform);
                    }
                    else {
                        // Action not pending, maybe committed? Or maybe invalid actionId for context.
                        // For simplicity, return undefined block if specific pending action not found.
                        // A more complex impl might check committedActions history.
                        block = undefined;
                    }
                }
                else if (blockGets.context?.committed) {
                    // Check context.committed for matching pending actions — mirrors coordinator
                    // behavior: context.committed proves the action succeeded, so pending blocks
                    // for that action should be served.
                    for (const { actionId: cId } of blockGets.context.committed) {
                        const pendingTransform = blockState.pendingActions.get(cId);
                        if (pendingTransform) {
                            const baseBlock = blockState.materializedBlocks.get(blockState.latestRev);
                            block = applyTransformSafe(baseBlock, pendingTransform);
                            break;
                        }
                    }
                    // Fall through to standard resolution if no pending match
                    if (block === undefined) {
                        if (blockGets.context.rev !== undefined) {
                            block = structuredClone(latestMaterializedAt(blockState, blockGets.context.rev));
                        }
                        else {
                            block = structuredClone(blockState.materializedBlocks.get(blockState.latestRev));
                        }
                    }
                }
                else if (blockGets.context?.rev !== undefined) {
                    // Return the materialized block at the highest revision ≤ requested
                    block = structuredClone(latestMaterializedAt(blockState, blockGets.context.rev));
                }
                else {
                    // Otherwise return latest materialized block
                    block = structuredClone(blockState.materializedBlocks.get(blockState.latestRev));
                }
                const actionId = blockState.revisionActions.get(blockState.latestRev);
                results[blockId] = {
                    block,
                    state: {
                        latest: actionId !== undefined ? {
                            rev: blockState.latestRev,
                            actionId
                        } : undefined,
                        pendings: Array.from(blockState.pendingActions.keys())
                    }
                };
            }
            // --- End of Critical Section (Read) ---
        }
        finally {
            // Release locks in reverse order
            releases.reverse().forEach(release => release());
        }
        return results;
    }
    async getStatus(actionRefs) {
        return actionRefs.map(ref => ({
            ...ref,
            statuses: ref.blockIds.map(blockId => {
                const blockState = this.blocks.get(blockId);
                if (!blockState)
                    return 'aborted';
                return blockState.pendingActions.has(ref.actionId) ? 'pending'
                    : Array.from(blockState.revisionActions.values()).some(actionId => actionId === ref.actionId) ? 'committed'
                        : 'aborted';
            })
        }));
    }
    async pend(request) {
        this.checkAvailable();
        const { actionId, transforms, policy, rev } = request;
        const blockIds = blockIdsForTransforms(transforms);
        const conflictingPendings = [];
        const missing = [];
        // Check for conflicts (pending or committed based on rev/insert)
        for (const blockId of blockIds) {
            const blockState = this.blocks.get(blockId);
            const blockTransform = transformForBlockId(transforms, blockId);
            if (!blockTransform)
                continue; // Should not happen
            if (blockState) {
                // Check for existing pending actions
                if (blockState.pendingActions.size > 0) {
                    blockState.pendingActions.forEach((_, pendingActionId) => {
                        conflictingPendings.push({ blockId, actionId: pendingActionId });
                    });
                }
                // Check for conflicting committed revisions (if rev specified or it's an insert)
                if (rev !== undefined || blockTransform.insert) {
                    const checkRev = rev ?? 0; // Check from revision 0 if it's an insert
                    if (blockState.latestRev >= checkRev) {
                        // Collect conflicting committed actions
                        const missingForBlock = new Map();
                        for (let r = checkRev; r <= blockState.latestRev; r++) {
                            const committedActionId = blockState.revisionActions.get(r);
                            if (committedActionId !== undefined) {
                                const committedTransform = blockState.committedActions.get(committedActionId);
                                if (committedTransform) {
                                    missingForBlock.set(committedActionId, { rev: r, transform: committedTransform });
                                }
                            }
                        }
                        // Add collected missing transforms for this block to the main missing list
                        for (const [mActionId, data] of missingForBlock.entries()) {
                            let existing = missing.find(m => m.actionId === mActionId);
                            if (!existing) {
                                existing = { actionId: mActionId, rev: data.rev, transforms: emptyTransforms() };
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
            }
            else if (policy === 'r') {
                // Simulate fetching pending transforms for 'r' policy
                const pendingWithTransforms = conflictingPendings
                    .map(({ blockId: pBlockId, actionId: pActionId }) => {
                    const pBlockState = this.blocks.get(pBlockId);
                    const pTransform = pBlockState?.pendingActions.get(pActionId)
                        ?? pBlockState?.committedActions.get(pActionId); // Might have been committed since check
                    if (pTransform) {
                        return { blockId: pBlockId, actionId: pActionId, transform: pTransform };
                    }
                    return null; // Handle case where it disappeared (cancelled?)
                })
                    .filter(p => p !== null);
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
                blockState.pendingActions.set(actionId, blockTransform);
            }
        }
        // Return success, include pending list as per StorageRepo behavior
        return {
            success: true,
            pending: conflictingPendings,
            blockIds
        };
    }
    async cancel(actionRef) {
        this.checkAvailable();
        for (const blockId of actionRef.blockIds) {
            const blockState = this.blocks.get(blockId);
            if (blockState) {
                blockState.pendingActions.delete(actionRef.actionId);
            }
        }
    }
    async commit(request) {
        this.checkAvailable();
        const { actionId, rev, blockIds } = request;
        const uniqueBlockIds = [...new Set(blockIds)].sort();
        const releases = [];
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
                // Collect missing actions for stale blocks
                const missingByAction = new Map();
                for (const blockId of staleBlocks) {
                    const blockState = this.blocks.get(blockId);
                    for (let r = rev; r <= blockState.latestRev; r++) {
                        const committedActionId = blockState.revisionActions.get(r);
                        if (committedActionId) {
                            const transform = blockState.committedActions.get(committedActionId);
                            if (transform) {
                                const existing = missingByAction.get(committedActionId) ?? emptyTransforms();
                                missingByAction.set(committedActionId, concatTransform(existing, blockId, transform));
                            }
                        }
                    }
                }
                const missing = Array.from(missingByAction.entries()).map(([actionId, transforms]) => ({
                    actionId,
                    rev: Array.from(this.blocks.values())
                        .flatMap(bs => Array.from(bs.revisionActions.entries()))
                        .find(([, aId]) => aId === actionId)?.[0] ?? rev,
                    transforms
                }));
                return { success: false, missing };
            }
            // Verify all blocks have the pending action
            for (const blockId of blockIds) {
                const blockState = this.blocks.get(blockId);
                if (!blockState || !blockState.pendingActions.has(actionId)) {
                    return {
                        success: false,
                        reason: `Action ${actionId} not found or not pending for block ${blockId}`
                    };
                }
            }
            // Commit the action for each block
            for (const blockId of blockIds) {
                const blockState = this.blocks.get(blockId);
                const transform = blockState.pendingActions.get(actionId);
                // Get base block to apply transform to
                const baseBlock = blockState.materializedBlocks.get(blockState.latestRev);
                let newBlock;
                if (!baseBlock) {
                    if (!transform.insert) {
                        throw new Error(`Commit Error: Action ${actionId} has no insert for new block ${blockId}`);
                    }
                    newBlock = structuredClone(transform.insert);
                }
                else {
                    newBlock = applyTransformSafe(baseBlock, transform);
                    if (!newBlock && !transform.delete) {
                        throw new Error(`Commit Error: Action ${actionId} resulted in undefined block but had no delete flag for block ${blockId}`);
                    }
                }
                if (newBlock) {
                    blockState.materializedBlocks.set(rev, newBlock);
                }
                // Update block state
                blockState.latestRev = rev;
                blockState.revisionActions.set(rev, actionId);
                blockState.committedActions.set(actionId, transform);
                blockState.pendingActions.delete(actionId);
            }
            // --- End of Critical Section (Simulated) ---
            return { success: true };
        }
        finally {
            // Release locks in reverse order
            releases.reverse().forEach(release => release());
        }
    }
    // Helper methods for testing
    reset() {
        this.blocks.clear();
    }
    getPendingActions() {
        const allPending = new Map();
        for (const [blockId, blockState] of this.blocks.entries()) {
            for (const [actionId, transform] of blockState.pendingActions) {
                const existing = allPending.get(actionId);
                if (!existing) {
                    allPending.set(actionId, { actionId, transforms: transformsFromTransform(transform, blockId) });
                }
                else {
                    existing.transforms = concatTransform(existing.transforms, blockId, transform);
                }
            }
        }
        return allPending;
    }
    getCommittedActions() {
        const allCommitted = new Map();
        for (const [blockId, blockState] of this.blocks.entries()) {
            for (const [rev, actionId] of blockState.revisionActions) {
                const transform = blockState.committedActions.get(actionId);
                if (transform) {
                    const existing = allCommitted.get(actionId);
                    if (!existing) {
                        allCommitted.set(actionId, {
                            actionId,
                            rev,
                            transforms: transformsFromTransform(transform, blockId)
                        });
                    }
                    else {
                        existing.transforms = concatTransform(existing.transforms, blockId, transform);
                    }
                }
            }
        }
        return allCommitted;
    }
    setAvailable(available) {
        this.available = available;
    }
    checkAvailable() {
        if (!this.available) {
            throw new Error('Transactor is not available');
        }
    }
    /** Optional method for querying cluster nominees (used in GATHER phase for multi-collection transactions) */
    queryClusterNominees;
}
function newBlockState() {
    return {
        materializedBlocks: new Map(),
        latestRev: 0,
        revisionActions: new Map(),
        pendingActions: new Map(),
        committedActions: new Map()
    };
}
/** Returns the materialized block at the highest revision ≤ the given revision */
function latestMaterializedAt(blockState, maxRev) {
    for (let rev = maxRev; rev >= 0; rev--) {
        const block = blockState.materializedBlocks.get(rev);
        if (block)
            return block;
    }
    return undefined;
}
function applyTransformSafe(block, transform) {
    if (!block)
        return undefined;
    return applyTransform(structuredClone(block), transform);
}
//# sourceMappingURL=test-transactor.js.map