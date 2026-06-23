import { ActionsEngine } from "./actions-engine.js";
import { createActionsStatements, createTransactionStamp, createTransactionId, isTransactionExpired } from "./transaction.js";
import { Log, blockIdsForTransforms, hashString } from "../index.js";
import { createLogger } from "../logger.js";
const log = createLogger('trx:coordinator');
/**
 * Coordinates multi-collection transactions.
 *
 * This is the ONLY interface for all mutations (single or multi-collection).
 *
 * Responsibilities:
 * - Manage collections (create as needed)
 * - Apply actions to collections (run handlers, write to logs)
 * - Commit transactions by running consensus phases (GATHER, PEND, COMMIT)
 */
export class TransactionCoordinator {
    transactor;
    collections;
    /** Per-stampId tracking: snapshot before first apply + accumulated actions for replay */
    stampData = new Map();
    nextStampOrder = 0;
    constructor(transactor, collections) {
        this.transactor = transactor;
        this.collections = collections;
    }
    /**
     * Apply actions to collections (called by engines during statement execution).
     *
     * This is the core method that engines call to apply actions to collections.
     * Actions are tagged with the stamp ID and executed immediately through collections
     * to update the local snapshot.
     *
     * @param actions - The actions to apply (per collection)
     * @param stampId - The transaction stamp ID to tag actions with
     */
    async applyActions(actions, stampId) {
        // On first call for this stampId, snapshot all collections for potential rollback
        if (!this.stampData.has(stampId)) {
            const snapshot = new Map();
            for (const [id, col] of this.collections) {
                snapshot.set(id, structuredClone(col.tracker.transforms));
            }
            this.stampData.set(stampId, {
                order: this.nextStampOrder++,
                preSnapshot: snapshot,
                actionBatches: []
            });
        }
        this.stampData.get(stampId).actionBatches.push(actions);
        await this.applyActionsRaw(actions, stampId);
    }
    /**
     * Apply actions without tracking (used internally and for replay during rollback).
     */
    async applyActionsRaw(actions, stampId) {
        for (const { collectionId, actions: collectionActions } of actions) {
            const collection = this.collections.get(collectionId);
            if (!collection) {
                throw new Error(`Collection not found: ${collectionId}`);
            }
            for (const action of collectionActions) {
                const taggedAction = { ...action, transaction: stampId };
                await collection.act(taggedAction);
            }
        }
    }
    /**
     * Commit a transaction (actions already applied, orchestrate PEND/COMMIT).
     *
     * This is called by TransactionSession.commit() after all statements have been executed.
     * Actions have already been applied to collections via applyActions(), so this method
     * just orchestrates the distributed consensus.
     *
     * @param transaction - The transaction to commit
     */
    async commit(transaction) {
        if (isTransactionExpired(transaction.stamp)) {
            throw new Error(`Transaction expired at ${transaction.stamp.expiration}`);
        }
        // Collect transforms and determine critical blocks for each affected collection
        const collectionData = Array.from(this.collections.entries())
            .map(([collectionId, collection]) => ({
            collectionId,
            collection,
            transforms: collection.tracker.transforms
        }))
            .filter(({ transforms }) => Object.keys(transforms.inserts ?? {}).length +
            Object.keys(transforms.updates ?? {}).length +
            (transforms.deletes?.length ?? 0) > 0);
        if (collectionData.length === 0) {
            return; // Nothing to commit
        }
        // Get critical block IDs (log tail) for each affected collection
        // The critical block is the current log tail that must participate in consensus
        const collectionTransforms = new Map();
        const criticalBlocks = new Map();
        for (const { collectionId, collection, transforms } of collectionData) {
            collectionTransforms.set(collectionId, transforms);
            // Get the current log tail block ID (critical block)
            const log = await Log.open(collection.tracker, collectionId);
            if (!log) {
                throw new Error(`Log not found for collection ${collectionId}`);
            }
            const tailPath = await log.chain.getTail();
            if (tailPath) {
                criticalBlocks.set(collectionId, tailPath.block.header.id);
            }
        }
        // Compute hash of ALL operations across ALL collections
        // This hash is used for validation - validators re-execute the transaction
        // and compare their computed operations hash with this one
        const allOperations = collectionData.flatMap(({ collectionId, transforms }) => [
            ...Object.entries(transforms.inserts ?? {}).map(([blockId, block]) => ({ type: 'insert', collectionId, blockId, block })),
            ...Object.entries(transforms.updates ?? {}).map(([blockId, operations]) => ({ type: 'update', collectionId, blockId, operations })),
            ...(transforms.deletes ?? []).map(blockId => ({ type: 'delete', collectionId, blockId }))
        ]);
        const operationsHash = await this.hashOperations(allOperations);
        // Execute consensus phases (GATHER, PEND, COMMIT)
        const coordResult = await this.coordinateTransaction(transaction, operationsHash, collectionTransforms, criticalBlocks);
        if (!coordResult.success) {
            throw new Error(`Transaction commit failed: ${coordResult.error}`);
        }
        // Reset trackers and update actionContext after successful commit
        for (const { collection } of collectionData) {
            const newRev = (collection['source'].actionContext?.rev ?? 0) + 1;
            collection['source'].actionContext = {
                committed: [
                    ...(collection['source'].actionContext?.committed ?? []),
                    { actionId: transaction.id, rev: newRev }
                ],
                rev: newRev,
            };
            collection.tracker.reset();
        }
        // Clean up stamp tracking data
        this.stampData.delete(transaction.stamp.id);
    }
    /**
     * Rollback a transaction (undo only the given stampId's applied actions).
     *
     * Restores tracker state to the snapshot taken before the stampId's first
     * applyActions call, then replays any later stamps' actions to preserve
     * other sessions' transforms.
     *
     * @param stampId - The transaction stamp ID to rollback
     */
    async rollback(stampId) {
        const data = this.stampData.get(stampId);
        if (!data)
            return;
        this.stampData.delete(stampId);
        // Collect all remaining stamps to replay
        const toReplay = [...this.stampData.entries()]
            .sort(([, a], [, b]) => a.order - b.order);
        // Find the earliest snapshot among the rolled-back stamp and all remaining stamps.
        // This is necessary because interleaved execution means a lower-order stamp
        // may have batches applied after a higher-order stamp's snapshot was taken.
        let earliestSnapshot = data.preSnapshot;
        let earliestOrder = data.order;
        for (const [, d] of toReplay) {
            if (d.order < earliestOrder) {
                earliestSnapshot = d.preSnapshot;
                earliestOrder = d.order;
            }
        }
        // Restore to the earliest snapshot
        for (const [collectionId, transforms] of earliestSnapshot) {
            const collection = this.collections.get(collectionId);
            if (collection) {
                collection.tracker.reset(structuredClone(transforms));
            }
        }
        // Replay all remaining stamps' batches in order
        for (const [replayStampId, replayData] of toReplay) {
            // Update the snapshot to reflect current (post-replay) state
            const newSnapshot = new Map();
            for (const [id, col] of this.collections) {
                newSnapshot.set(id, structuredClone(col.tracker.transforms));
            }
            replayData.preSnapshot = newSnapshot;
            for (const actionBatch of replayData.actionBatches) {
                await this.applyActionsRaw(actionBatch, replayStampId);
            }
        }
    }
    /**
     * Get current transforms from all collections.
     *
     * This collects transforms from each collection's tracker. Useful for
     * validation scenarios where transforms need to be extracted after
     * engine execution.
     */
    getTransforms() {
        const transforms = new Map();
        for (const [collectionId, collection] of this.collections.entries()) {
            const collectionTransforms = collection.tracker.transforms;
            const hasChanges = Object.keys(collectionTransforms.inserts ?? {}).length > 0 ||
                Object.keys(collectionTransforms.updates ?? {}).length > 0 ||
                (collectionTransforms.deletes?.length ?? 0) > 0;
            if (hasChanges) {
                transforms.set(collectionId, collectionTransforms);
            }
        }
        return transforms;
    }
    /**
     * Reset all collection trackers.
     *
     * This clears pending transforms from all collections. Useful for
     * cleaning up after validation or when starting a new transaction.
     */
    resetTransforms() {
        for (const collection of this.collections.values()) {
            collection.tracker.reset();
        }
    }
    /**
     * Collect read dependencies from all participating collections.
     */
    getReadDependencies() {
        const reads = [];
        for (const collection of this.collections.values()) {
            reads.push(...collection.getReadDependencies());
        }
        return reads;
    }
    /**
     * Clear read dependencies from all collections.
     */
    clearReadDependencies() {
        for (const collection of this.collections.values()) {
            collection.clearReadDependencies();
        }
    }
    /**
     * Compute hash of all operations in a transaction.
     * This hash is used for validation - validators re-execute the transaction
     * and compare their computed operations hash with this one.
     */
    async hashOperations(operations) {
        const operationsData = JSON.stringify(operations);
        return `ops:${await hashString(operationsData)}`;
    }
    /**
     * Commit a transaction context.
     *
     * @deprecated Use TransactionSession instead of TransactionContext
     * This is called by TransactionContext.commit().
     *
     * @param context - The transaction context to commit
     * @returns Execution result with actions and results
     */
    async commitTransaction(context) {
        const collectionActions = Array.from(context.getCollectionActions().entries()).map(([collectionId, actions]) => ({ collectionId, actions }));
        if (collectionActions.length === 0) {
            return { success: true }; // Nothing to commit
        }
        // Create transaction statements
        const statements = createActionsStatements(collectionActions);
        const reads = context.getReads();
        // Create stamp from context
        const stamp = await createTransactionStamp('local', // TODO: Get from context or coordinator
        Date.now(), '', // TODO: Get from engine
        context.engine);
        const transaction = {
            stamp,
            statements,
            reads,
            id: await createTransactionId(stamp.id, statements, reads)
        };
        const engine = new ActionsEngine(this);
        // Execute through standard path
        return await this.execute(transaction, engine);
    }
    /**
     * Execute a fully-formed transaction.
     *
     * This can be called directly with a complete transaction (e.g., from Quereus),
     * or indirectly via commitTransaction().
     *
     * @param transaction - The transaction to execute
     * @param engine - The engine to use for executing the transaction
     * @returns Execution result with actions and results
     */
    async execute(transaction, engine) {
        const trxId = transaction.id;
        const t0 = Date.now();
        if (isTransactionExpired(transaction.stamp)) {
            return { success: false, error: `Transaction expired at ${transaction.stamp.expiration}` };
        }
        // 1. Validate engine matches transaction
        // Note: We don't enforce this strictly since the engine is passed in explicitly
        // The caller is responsible for ensuring the correct engine is used
        const tEngine = Date.now();
        const result = await engine.execute(transaction);
        const engineMs = Date.now() - tEngine;
        if (!result.success) {
            log('execute:done trxId=%s engine=%dms success=false total=%dms', trxId, engineMs, Date.now() - t0);
            return result;
        }
        if (!result.actions || result.actions.length === 0) {
            return { success: true }; // Nothing to do
        }
        // 2. Apply actions to collections and collect transforms
        const tApply = Date.now();
        const collectionTransforms = new Map();
        const criticalBlocks = new Map();
        const actionResults = new Map();
        const allCollectionIds = result.actions.map(ca => ca.collectionId);
        for (const collectionActions of result.actions) {
            const applyResult = await this.applyActionsToCollection(collectionActions, transaction, allCollectionIds);
            if (!applyResult.success) {
                return { success: false, error: applyResult.error };
            }
            collectionTransforms.set(collectionActions.collectionId, applyResult.transforms);
            criticalBlocks.set(collectionActions.collectionId, applyResult.logTailBlockId);
            actionResults.set(collectionActions.collectionId, applyResult.results);
        }
        // 3. Compute operations hash for validation
        const allOperations = Array.from(collectionTransforms.entries()).flatMap(([collectionId, transforms]) => [
            ...Object.entries(transforms.inserts ?? {}).map(([blockId, block]) => ({ type: 'insert', collectionId, blockId, block })),
            ...Object.entries(transforms.updates ?? {}).map(([blockId, operations]) => ({ type: 'update', collectionId, blockId, operations })),
            ...(transforms.deletes ?? []).map(blockId => ({ type: 'delete', collectionId, blockId }))
        ]);
        const operationsHash = await this.hashOperations(allOperations);
        const applyMs = Date.now() - tApply;
        // 4. Coordinate (GATHER if multi-collection)
        const tCoord = Date.now();
        const coordResult = await this.coordinateTransaction(transaction, operationsHash, collectionTransforms, criticalBlocks);
        const coordMs = Date.now() - tCoord;
        if (!coordResult.success) {
            log('execute:done trxId=%s engine=%dms apply=%dms coordinate=%dms success=false total=%dms', trxId, engineMs, applyMs, coordMs, Date.now() - t0);
            return coordResult;
        }
        // 5. Update actionContext and reset trackers after successful commit
        for (const collectionActions of result.actions) {
            const collection = this.collections.get(collectionActions.collectionId);
            if (collection) {
                const newRev = (collection['source'].actionContext?.rev ?? 0) + 1;
                const actionId = transaction.id;
                collection['source'].actionContext = {
                    committed: [
                        ...(collection['source'].actionContext?.committed ?? []),
                        { actionId, rev: newRev }
                    ],
                    rev: newRev,
                };
                collection.tracker.reset();
            }
        }
        // Clean up stamp tracking data
        this.stampData.delete(transaction.stamp.id);
        // 6. Return results from actions
        log('execute:done trxId=%s engine=%dms apply=%dms coordinate=%dms total=%dms', trxId, engineMs, applyMs, coordMs, Date.now() - t0);
        return {
            success: true,
            actions: result.actions,
            results: actionResults
        };
    }
    /**
     * Apply actions to a collection.
     *
     * This runs the action handlers, writes to the log, and collects transforms.
     */
    async applyActionsToCollection(collectionActions, transaction, allCollectionIds) {
        const collection = this.collections.get(collectionActions.collectionId);
        if (!collection) {
            return {
                success: false,
                error: `Collection not found: ${collectionActions.collectionId}`
            };
        }
        // At this point, actions have already been executed through collection.act()
        // when they were added to the TransactionContext. The collection's tracker
        // already has the transforms, and the actions are in the pending buffer.
        // Get transforms from the collection's tracker
        const transforms = collection.tracker.transforms;
        // Write actions to the collection's log to get the log tail block ID
        const log = await Log.open(collection.tracker, collectionActions.collectionId);
        if (!log) {
            return {
                success: false,
                error: `Log not found for collection ${collectionActions.collectionId}`
            };
        }
        // Generate action ID from transaction ID
        const actionId = transaction.id;
        const newRev = (collection['source'].actionContext?.rev ?? 0) + 1;
        // Add actions to log (this updates the tracker with log block changes)
        const addResult = await log.addActions(collectionActions.actions, actionId, newRev, () => blockIdsForTransforms(transforms), allCollectionIds);
        // Return the transforms and log tail block ID
        return {
            success: true,
            transforms,
            logTailBlockId: addResult.tailPath.block.header.id,
            results: [] // TODO: Collect results from action handlers when we support read operations
        };
    }
    /**
     * Coordinate a transaction across multiple collections.
     *
     * @param transaction - The transaction to coordinate
     * @param operationsHash - Hash of all operations for validation
     * @param collectionTransforms - Map of collectionId to its transforms
     * @param criticalBlocks - Map of collectionId to its log tail blockId
     */
    async coordinateTransaction(transaction, operationsHash, collectionTransforms, criticalBlocks) {
        const trxId = transaction.id;
        const t0 = Date.now();
        // 1. GATHER phase: collect critical cluster nominees (skip if single collection)
        const criticalBlockIds = Array.from(criticalBlocks.values());
        const tGather = Date.now();
        const superclusterNominees = await this.gatherPhase(criticalBlockIds);
        const gatherMs = Date.now() - tGather;
        // 2. PEND phase: distribute to all block clusters
        const tPend = Date.now();
        const pendResult = await this.pendPhase(transaction, operationsHash, collectionTransforms, superclusterNominees);
        const pendMs = Date.now() - tPend;
        if (!pendResult.success) {
            log('trx:phases trxId=%s gather=%dms pend=%dms (failed) total=%dms', trxId, gatherMs, pendMs, Date.now() - t0);
            return pendResult;
        }
        // 3. COMMIT phase: commit to all critical blocks (with retry for forward recovery)
        const tCommit = Date.now();
        const commitResult = await this.commitPhase(transaction.id, criticalBlockIds, pendResult.pendedBlockIds);
        const commitMs = Date.now() - tCommit;
        if (!commitResult.success) {
            // Targeted cancel: only cancel collections that are still pending (not already committed)
            await this.cancelPhase(transaction.id, pendResult.pendedBlockIds, commitResult.committedCollections);
            log('trx:phases trxId=%s gather=%dms pend=%dms commit=%dms (failed) total=%dms', trxId, gatherMs, pendMs, commitMs, Date.now() - t0);
            return { success: false, error: commitResult.error };
        }
        // 4. PROPAGATE and CHECKPOINT phases are handled by clusters automatically
        // (as per user's note: "managed by each cluster, the client doesn't have to worry about them")
        log('trx:phases trxId=%s gather=%dms pend=%dms commit=%dms total=%dms', trxId, gatherMs, pendMs, commitMs, Date.now() - t0);
        return { success: true };
    }
    /**
     * GATHER phase: Collect nominees from critical clusters.
     *
     * Skip if only one collection affected (single-collection consensus).
     *
     * @param criticalBlockIds - Block IDs of all log tails
     * @returns Set of peer IDs to use for consensus, or null for single-collection
     */
    async gatherPhase(criticalBlockIds) {
        // Skip GATHER if only one collection affected
        if (criticalBlockIds.length === 1) {
            return null; // Use normal single-collection consensus
        }
        // Check if transactor supports cluster queries (optional method)
        if (!this.transactor.queryClusterNominees) {
            // Transactor doesn't support cluster queries - proceed without supercluster
            return null;
        }
        // Query each critical cluster for their nominees and merge into supercluster
        const nomineePromises = criticalBlockIds.map(blockId => this.transactor.queryClusterNominees(blockId));
        const results = await Promise.all(nomineePromises);
        // Merge all nominees into a single set
        const supercluster = results.reduce((acc, result) => {
            result.nominees.forEach(nominee => acc.add(nominee));
            return acc;
        }, new Set());
        return supercluster;
    }
    /**
     * PEND phase: Distribute transaction to all affected block clusters.
     *
     * @param transaction - The full transaction for replay/validation
     * @param operationsHash - Hash of all operations for validation
     * @param collectionTransforms - Map of collectionId to its transforms
     * @param superclusterNominees - Nominees for multi-collection consensus (null for single-collection)
     */
    async pendPhase(transaction, operationsHash, collectionTransforms, superclusterNominees) {
        if (collectionTransforms.size === 0) {
            return { success: false, error: 'No transforms to pend' };
        }
        const pendedBlockIds = new Map();
        const actionId = transaction.id;
        const nominees = superclusterNominees ? Array.from(superclusterNominees) : undefined;
        // Pend each collection's transforms
        for (const [collectionId, transforms] of collectionTransforms.entries()) {
            const collection = this.collections.get(collectionId);
            if (!collection) {
                return { success: false, error: `Collection not found: ${collectionId}` };
            }
            // Get revision from the collection's source
            const rev = (collection['source'].actionContext?.rev ?? 0) + 1;
            // Create pend request with transaction and operations hash for validation
            const pendRequest = {
                actionId,
                rev,
                transforms,
                policy: 'r', // Return policy: fail but return pending actions
                transaction,
                operationsHash,
                superclusterNominees: nominees
            };
            // Pend the transaction
            const pendResult = await this.transactor.pend(pendRequest);
            if (!pendResult.success) {
                // Cancel any already-pended collections before returning
                for (const [, pendedBlockIdList] of pendedBlockIds.entries()) {
                    await this.transactor.cancel({ actionId, blockIds: pendedBlockIdList });
                }
                return {
                    success: false,
                    error: `Pend failed for collection ${collectionId}: ${pendResult.reason}`
                };
            }
            // Store the pended block IDs for commit phase
            pendedBlockIds.set(collectionId, pendResult.blockIds);
        }
        return { success: true, pendedBlockIds };
    }
    /**
     * COMMIT phase: Commit to all critical blocks with retry for transient failures.
     *
     * Once all collections are pended (Phase 1 passes), the coordinator has decided
     * to commit. Failed commits are retried (forward recovery) before giving up.
     * Returns which collections committed vs failed so the caller can do targeted cancel.
     */
    async commitPhase(actionId, criticalBlockIds, pendedBlockIds) {
        const committedCollections = new Set();
        const failedCollections = new Set();
        // Commit each collection's transaction with retry
        for (const [collectionId, blockIds] of pendedBlockIds.entries()) {
            const collection = this.collections.get(collectionId);
            if (!collection) {
                failedCollections.add(collectionId);
                return {
                    success: false,
                    error: `Collection not found: ${collectionId}`,
                    committedCollections,
                    failedCollections
                };
            }
            // Get revision
            const rev = (collection['source'].actionContext?.rev ?? 0) + 1;
            // Find the critical block (log tail) for this collection
            const logTailBlockId = criticalBlockIds.find(blockId => blockIds.includes(blockId));
            if (!logTailBlockId) {
                failedCollections.add(collectionId);
                return {
                    success: false,
                    error: `Log tail block not found for collection ${collectionId}`,
                    committedCollections,
                    failedCollections
                };
            }
            // Create commit request
            const commitRequest = {
                actionId,
                blockIds,
                tailId: logTailBlockId,
                rev
            };
            // Retry up to 3 attempts for transient failures
            let committed = false;
            for (let attempt = 0; attempt < 3 && !committed; attempt++) {
                const commitResult = await this.transactor.commit(commitRequest);
                if (commitResult.success) {
                    committed = true;
                    committedCollections.add(collectionId);
                }
                else if (attempt === 2) {
                    failedCollections.add(collectionId);
                    return {
                        success: false,
                        error: `Commit failed for collection ${collectionId} after 3 attempts`,
                        committedCollections,
                        failedCollections
                    };
                }
            }
        }
        return { success: true, committedCollections, failedCollections };
    }
    /**
     * CANCEL phase: Cancel pending actions on affected blocks.
     *
     * Uses the authoritative pended block IDs from pendPhase rather than
     * recomputing from transforms. Optionally skips already-committed collections.
     */
    async cancelPhase(actionId, pendedBlockIds, excludeCollections) {
        for (const [collectionId, blockIds] of pendedBlockIds.entries()) {
            if (excludeCollections?.has(collectionId))
                continue;
            await this.transactor.cancel({ actionId, blockIds });
        }
    }
}
//# sourceMappingURL=coordinator.js.map