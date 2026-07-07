import { Latches, transformForBlockId, applyTransform, groupBy, concatTransform, emptyTransforms, blockIdsForTransforms, transformsFromTransform } from "@optimystic/db-core";
import { asyncIteratorToArray } from "../it-utility.js";
import { createLogger } from "../logger.js";
const log = createLogger('storage-repo');
export class StorageRepo {
    createBlockStorage;
    validatePend;
    constructor(createBlockStorage, options) {
        this.createBlockStorage = createBlockStorage;
        this.validatePend = options?.validatePend;
    }
    async get({ blockIds, context }, _options) {
        const distinctBlockIds = Array.from(new Set(blockIds));
        log('get blockIds=%d', distinctBlockIds.length);
        const results = await Promise.all(distinctBlockIds.map(async (blockId) => {
            const blockStorage = this.createBlockStorage(blockId);
            // Ensure that all outstanding transactions in the context are committed
            if (context) {
                const latest = await blockStorage.getLatest();
                const missing = latest
                    ? context.committed.filter(c => c.rev > latest.rev)
                    : context.committed;
                for (const { actionId, rev } of missing.sort((a, b) => a.rev - b.rev)) {
                    const pending = await blockStorage.getPendingTransaction(actionId);
                    if (pending) {
                        await this.internalCommit(blockId, actionId, rev, blockStorage);
                    }
                }
            }
            // 38-07 (P2P-11): narrow drone-side materialize-defer — see 38-04-SUMMARY
            // "Attempted-and-reverted: storage-repo.js" for why a blanket get()-level
            // catch is NOT used here (it broke solo bootstrap strand creation across 3
            // runs). This guard is scoped to ONLY the materialize read below, mirroring
            // the already-landed cluster-repo.js:498 validatePendOperations defer analog:
            // a cohort member with no locally-materialized state for a NEW block cannot
            // determine its content, so it defers (blockRev stays undefined, falling
            // through to the existing `if (!blockRev) return [blockId, { state: {} }];`
            // empty-state path below) instead of letting the throw propagate up through
            // cluster.update() into a StreamResetError. Surfaces the real error via the
            // module `log` first — never silently swallowed (V5). Only the
            // "Failed to find materialized block" class is caught; anything else
            // re-throws so unrelated failures still surface. The creation-path
            // `Pending action <id> not found` throw a few lines below is OUTSIDE this
            // try/catch and remains reachable and un-caught (load-bearing on the
            // creation path — this is exactly what the reverted broad catch swallowed).
            let blockRev;
            try {
                blockRev = await blockStorage.getBlock(context?.rev);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (message.includes('Failed to find materialized block')) {
                    log('get:materialize-defer blockId=%s err=%s', blockId, message);
                    blockRev = undefined;
                }
                else {
                    throw err;
                }
            }
            // Include pending action if requested — handled first so a pending-only
            // insert (no committed revision yet) can still be served by applying the
            // pending transform to an undefined prior block.
            if (context?.actionId !== undefined) {
                const pendingTransform = await blockStorage.getPendingTransaction(context.actionId);
                if (!pendingTransform) {
                    throw new Error(`Pending action ${context.actionId} not found`);
                }
                const block = applyTransform(blockRev?.block, pendingTransform);
                return [blockId, {
                        block,
                        state: {
                            latest: await blockStorage.getLatest(),
                            pendings: [context.actionId]
                        }
                    }];
            }
            if (!blockRev) {
                return [blockId, { state: {} }];
            }
            const pendings = await asyncIteratorToArray(blockStorage.listPendingTransactions());
            return [blockId, {
                    block: blockRev.block,
                    state: {
                        latest: await blockStorage.getLatest(),
                        pendings
                    }
                }];
        }));
        return Object.fromEntries(results);
    }
    async pend(request, _options) {
        // Validate transaction if present and validation hook is configured
        if (this.validatePend && request.transaction && request.operationsHash) {
            const validationResult = await this.validatePend(request.transaction, request.operationsHash);
            if (!validationResult.valid) {
                return {
                    success: false,
                    reason: validationResult.reason ?? 'Transaction validation failed'
                };
            }
        }
        const blockIds = blockIdsForTransforms(request.transforms);
        log('pend actionId=%s blockIds=%d rev=%s', request.actionId, blockIds.length, request.rev);
        const pendings = [];
        const missing = [];
        // Potential race condition: A concurrent commit operation could complete
        // between the conflict checks (latest.rev, listPendingTransactions) and the
        // savePendingTransaction call below. This pend operation might succeed based on
        // stale information, but the subsequent commit for this pend would likely
        // fail correctly later if a conflict arose. Locking here could make the initial
        // check more accurate but adds overhead. The current approach prioritizes
        // letting the commit be the final arbiter.
        for (const blockId of blockIds) {
            const blockStorage = this.createBlockStorage(blockId);
            const transforms = transformForBlockId(request.transforms, blockId);
            // First handle any pending actions
            const pending = await asyncIteratorToArray(blockStorage.listPendingTransactions());
            pendings.push(...pending.map(actionId => ({ blockId, actionId })));
            // Handle any conflicting revisions
            if (request.rev !== undefined || transforms.insert) {
                const latest = await blockStorage.getLatest();
                if (latest && latest.rev >= (request.rev ?? 0)) {
                    const transforms = await asyncIteratorToArray(blockStorage.listRevisions(request.rev ?? 0, latest.rev));
                    for (const actionRev of transforms) {
                        const transform = await blockStorage.getTransaction(actionRev.actionId);
                        if (!transform) {
                            throw new Error(`Missing action ${actionRev.actionId} for block ${blockId}`);
                        }
                        missing.push({
                            actionId: actionRev.actionId,
                            rev: actionRev.rev,
                            transforms: transformsFromTransform(transform, blockId)
                        });
                    }
                }
            }
        }
        if (missing.length) {
            log('pend:stale actionId=%s missing=%d', request.actionId, missing.length);
            return {
                success: false,
                missing
            };
        }
        if (pendings.length > 0) {
            if (request.policy === 'f') { // Fail on pending actions
                return { success: false, pending: pendings };
            }
            else if (request.policy === 'r') { // Return populated pending actions
                return {
                    success: false,
                    pending: await Promise.all(pendings.map(async (action) => {
                        const blockStorage = this.createBlockStorage(action.blockId);
                        return {
                            blockId: action.blockId,
                            actionId: action.actionId,
                            transform: (await blockStorage.getPendingTransaction(action.actionId))
                                ?? (await blockStorage.getTransaction(action.actionId)) // Possible that since enumeration, the action has been promoted
                        };
                    }))
                };
            }
        }
        // Simultaneously save pending action for each block
        // Note: that this is not atomic, after we checked for conflicts and pending actions
        // new pending or committed actions may have been added.  This is okay, because
        // this check during pend is conservative.
        await Promise.all(blockIds.map(blockId => {
            const blockStorage = this.createBlockStorage(blockId);
            const blockTransform = transformForBlockId(request.transforms, blockId);
            return blockStorage.savePendingTransaction(request.actionId, blockTransform);
        }));
        return {
            success: true,
            pending: pendings,
            blockIds
        };
    }
    async cancel(actionRef, _options) {
        log('cancel actionId=%s blockIds=%d', actionRef.actionId, actionRef.blockIds.length);
        await Promise.all(actionRef.blockIds.map(blockId => {
            const blockStorage = this.createBlockStorage(blockId);
            return blockStorage.deletePendingTransaction(actionRef.actionId);
        }));
    }
    async commit(request, _options) {
        log('commit actionId=%s rev=%d blockIds=%d', request.actionId, request.rev, request.blockIds.length);
        const uniqueBlockIds = Array.from(new Set(request.blockIds)).sort();
        const releases = [];
        try {
            // Acquire locks sequentially based on sorted IDs to prevent deadlocks
            for (const id of uniqueBlockIds) {
                const lockId = `StorageRepo.commit:${id}`;
                const release = await Latches.acquire(lockId);
                releases.push(release);
            }
            // --- Start of Critical Section ---
            const blockStorages = request.blockIds.map(blockId => ({
                blockId,
                storage: this.createBlockStorage(blockId)
            }));
            // Partition blocks into:
            //   - alreadyDone: latest.rev === request.rev && latest.actionId === request.actionId
            //     (idempotent retry — a prior commit of this same action already landed here;
            //     skip rather than treat as a conflict. Needed to rollforward stranded blocks
            //     after a mid-batch crash committed some but not all blocks.)
            //   - missedCommits: latest.rev >= request.rev but not the same actionId → real stale conflict.
            //   - toCommit: latest.rev < request.rev or no latest yet → run internalCommit.
            const toCommit = [];
            const missedCommits = [];
            for (const entry of blockStorages) {
                const { blockId, storage } = entry;
                const latest = await storage.getLatest();
                if (latest && latest.rev >= request.rev) {
                    if (latest.rev === request.rev && latest.actionId === request.actionId) {
                        // Idempotent no-op for this block — already committed with this exact (actionId, rev).
                        continue;
                    }
                    const transforms = [];
                    for await (const actionRev of storage.listRevisions(request.rev, latest.rev)) {
                        const transform = await storage.getTransaction(actionRev.actionId);
                        if (!transform) {
                            throw new Error(`Missing action ${actionRev.actionId} for block ${blockId}`);
                        }
                        transforms.push({
                            actionId: actionRev.actionId,
                            rev: actionRev.rev,
                            transform
                        });
                    }
                    missedCommits.push({ blockId, transforms }); // Push, even if transforms is empty, because we want to reject the older version
                    continue;
                }
                toCommit.push(entry);
            }
            if (missedCommits.length) {
                log('commit:stale actionId=%s missed=%d', request.actionId, missedCommits.length);
                return {
                    success: false,
                    missing: perBlockActionTransformsToPerAction(missedCommits)
                };
            }
            // Check for missing pending actions only on blocks that still need to commit.
            // Already-done blocks will have had their pending promoted, so skipping them here
            // is what makes the idempotent rollforward work.
            const missingPends = [];
            for (const { blockId, storage } of toCommit) {
                const pendingAction = await storage.getPendingTransaction(request.actionId);
                if (!pendingAction) {
                    missingPends.push({ blockId, actionId: request.actionId });
                }
            }
            if (missingPends.length) {
                throw new Error(`Pending action ${request.actionId} not found for block(s): ${missingPends.map(p => p.blockId).join(', ')}`);
            }
            // Commit the action for each block that still needs it.
            // This loop will execute atomically for all blocks due to the acquired locks.
            for (const { blockId, storage } of toCommit) {
                try {
                    // internalCommit will throw if it encounters an issue
                    await this.internalCommit(blockId, request.actionId, request.rev, storage);
                }
                catch (err) {
                    // Partial-commit recovery: a retry with the same (actionId, rev) will treat
                    // already-done blocks as idempotent no-ops and advance the remainder.
                    return {
                        success: false,
                        reason: err instanceof Error ? err.message : 'Unknown error during commit'
                    };
                }
            }
        }
        finally {
            // Release locks in reverse order of acquisition
            releases.reverse().forEach(release => release());
        }
        return { success: true };
    }
    /**
     * Reconciles `metadata.latest` for a single block with the highest contiguous
     * fully-promoted revision in durable storage. Use after a crash between
     * `promotePendingTransaction` and `setLatest` when retry-commit cannot help
     * (the pending record is already gone) but the revision and committed-log entry
     * are durable. Idempotent and monotonic.
     */
    async recoverBlock(blockId) {
        log('recoverBlock blockId=%s', blockId);
        const storage = this.createBlockStorage(blockId);
        await storage.recover();
    }
    async internalCommit(blockId, actionId, rev, storage) {
        // Note: This method is called within the locked critical section of commit()
        // So, operations like getPendingTransaction, getLatest, getBlock, saveMaterializedBlock,
        // saveRevision, promotePendingTransaction, setLatest are protected against
        // concurrent commits for the *same blockId*.
        const transform = await storage.getPendingTransaction(actionId);
        // No need to check if !transform here, as the caller (commit) already verified this.
        // If it's null here, it indicates a logic error or race condition bypassed the lock (unlikely).
        if (!transform) {
            throw new Error(`Consistency Error: Pending action ${actionId} disappeared for block ${blockId} within critical section.`);
        }
        // Get prior materialized block if it exists
        const latest = await storage.getLatest();
        const priorBlock = latest
            ? (await storage.getBlock(latest.rev))?.block
            : undefined;
        // Apply transform and save materialized block
        // applyTransform handles undefined priorBlock correctly for inserts
        const newBlock = applyTransform(priorBlock, transform);
        if (newBlock) {
            await storage.saveMaterializedBlock(actionId, newBlock);
        }
        // Save revision and promote action *before* updating latest
        // This ensures that if the process crashes between these steps,
        // the 'latest' pointer doesn't point to a revision that hasn't been fully recorded.
        await storage.saveRevision(rev, actionId);
        await storage.promotePendingTransaction(actionId);
        // Update latest revision *last*
        await storage.setLatest({ actionId, rev });
    }
}
/** Converts list of missing actions per block into a list of missing actions across blocks. */
function perBlockActionTransformsToPerAction(missing) {
    const missingFlat = missing.flatMap(({ blockId, transforms }) => transforms.map(transform => ({ blockId, transform })));
    const missingByActionId = groupBy(missingFlat, ({ transform }) => transform.actionId);
    return Object.entries(missingByActionId).map(([actionId, items]) => items.reduce((acc, { blockId, transform }) => {
        concatTransform(acc.transforms, blockId, transform.transform);
        return acc;
    }, {
        actionId: actionId,
        rev: items[0].transform.rev, // Assumption: all missing actionIds share the same revision
        transforms: emptyTransforms()
    }));
}
//# sourceMappingURL=storage-repo.js.map