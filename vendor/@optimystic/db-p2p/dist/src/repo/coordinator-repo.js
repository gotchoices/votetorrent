import { LruMap, blockIdsForTransforms } from "@optimystic/db-core";
import { ClusterCoordinator } from "./cluster-coordinator.js";
import { peerIdFromString } from "@libp2p/peer-id";
import { createLogger } from '../logger.js';
const log = createLogger('coordinator-repo');
export function coordinatorRepo(keyNetwork, createClusterClient, cfg, fretService, reputation, stateStore) {
    return (components) => new CoordinatorRepo(keyNetwork, createClusterClient, components.storageRepo, cfg, components.localCluster, components.localPeerId, fretService, components.clusterLatestCallback, reputation, stateStore);
}
/** Cluster coordination repo - uses local store, as well as distributes changes to other nodes using cluster consensus. */
export class CoordinatorRepo {
    keyNetwork;
    createClusterClient;
    storageRepo;
    clusterLatestCallback;
    coordinator;
    DEFAULT_TIMEOUT = 30000; // 30 seconds default timeout
    localPeerId;
    responsibilityCache = new LruMap(1000);
    static RESPONSIBILITY_TTL_MS = 60_000;
    lastSeenCommitMs = new LruMap(1000);
    readRepairMode;
    readRepairWindowMs;
    readRepairSampleRate;
    /** Test seam: overridable clock for window-based read-repair gating. */
    now = () => Date.now();
    /** Test seam: overridable RNG (0..1) for sample-rate gating. */
    rand = () => Math.random();
    constructor(keyNetwork, createClusterClient, storageRepo, cfg, localCluster, localPeerId, fretService, clusterLatestCallback, reputation, stateStore) {
        this.keyNetwork = keyNetwork;
        this.createClusterClient = createClusterClient;
        this.storageRepo = storageRepo;
        this.clusterLatestCallback = clusterLatestCallback;
        this.localPeerId = localPeerId;
        const policy = {
            clusterSize: cfg?.clusterSize ?? 10,
            superMajorityThreshold: cfg?.superMajorityThreshold ?? 0.75,
            simpleMajorityThreshold: cfg?.simpleMajorityThreshold ?? 0.51,
            minAbsoluteClusterSize: cfg?.minAbsoluteClusterSize ?? 3,
            allowClusterDownsize: cfg?.allowClusterDownsize ?? true,
            clusterSizeTolerance: cfg?.clusterSizeTolerance ?? 0.5,
            partitionDetectionWindow: cfg?.partitionDetectionWindow ?? 60000,
            commitBroadcastRetryInitialMs: cfg?.commitBroadcastRetryInitialMs ?? 250,
            commitBroadcastRetryBackoffFactor: cfg?.commitBroadcastRetryBackoffFactor ?? 2,
            commitBroadcastRetryMaxIntervalMs: cfg?.commitBroadcastRetryMaxIntervalMs ?? 8000,
            commitBroadcastRetryMaxAttempts: cfg?.commitBroadcastRetryMaxAttempts ?? 5,
            commitBroadcastImmediateRetries: cfg?.commitBroadcastImmediateRetries ?? 1,
            readRepairMode: cfg?.readRepairMode ?? 'lazy',
            readRepairWindowMs: cfg?.readRepairWindowMs ?? 10000,
            readRepairSampleRate: cfg?.readRepairSampleRate ?? 0
        };
        this.readRepairMode = policy.readRepairMode;
        this.readRepairWindowMs = policy.readRepairWindowMs;
        this.readRepairSampleRate = policy.readRepairSampleRate;
        const localClusterRef = localCluster && localPeerId ? {
            update: localCluster.update.bind(localCluster),
            peerId: localPeerId,
            wasTransactionExecuted: localCluster.wasTransactionExecuted?.bind(localCluster)
        } : undefined;
        this.coordinator = new ClusterCoordinator(keyNetwork, createClusterClient, policy, localClusterRef, fretService, reputation, stateStore);
    }
    /** Recover coordinator transactions from persistent store after a restart. */
    async recoverTransactions() {
        await this.coordinator.recoverTransactions();
    }
    /**
     * Check if this node is in the cluster for a given block.
     * Uses findCluster membership — in the real network layer, self is always
     * included in the cohort when this node is responsible. This serves as a
     * defense-in-depth guard for requests that arrive at the wrong node.
     * Returns true if localPeerId is not set (backward compat for single-node/test setups).
     */
    async isResponsibleForBlock(blockId) {
        if (!this.localPeerId)
            return true;
        const cached = this.responsibilityCache.get(blockId);
        if (cached && cached.expires > Date.now()) {
            return cached.inCluster;
        }
        const blockIdBytes = new TextEncoder().encode(blockId);
        let inCluster;
        try {
            const peers = await this.keyNetwork.findCluster(blockIdBytes);
            inCluster = this.localPeerId.toString() in peers;
        }
        catch (err) {
            log('proximity:check-error', { blockId, error: err.message });
            // On failure, assume responsible to avoid false rejections
            return true;
        }
        this.responsibilityCache.set(blockId, { inCluster, expires: Date.now() + CoordinatorRepo.RESPONSIBILITY_TTL_MS });
        log('proximity:checked', { blockId, inCluster });
        return inCluster;
    }
    /**
     * Verify this node is responsible for all given block IDs. Throws if not.
     */
    async verifyResponsibility(blockIds) {
        const notResponsible = [];
        for (const blockId of blockIds) {
            if (!await this.isResponsibleForBlock(blockId)) {
                notResponsible.push(blockId);
            }
        }
        if (notResponsible.length > 0) {
            log('proximity:rejected', { blockIds: notResponsible });
            throw new Error(`Not responsible for block(s): ${notResponsible.join(', ')}`);
        }
    }
    async get(blockGets, options) {
        // Soft proximity check — warn but still serve reads for graceful degradation
        for (const blockId of blockGets.blockIds) {
            if (!await this.isResponsibleForBlock(blockId)) {
                log('proximity:get-warning', { blockId, msg: 'serving read for non-responsible block' });
            }
        }
        // First try local storage
        const localResult = await this.storageRepo.get(blockGets, options);
        // Decide per-block whether to consult cluster peers. Two triggers:
        //   (a) Missing — block isn't present locally at all (legacy behavior).
        //   (b) Stale-by-policy — block is present but read-repair policy says verify.
        // Skip cluster fetch if this is already a sync request (to prevent recursive queries).
        const skipClusterFetch = options?.skipClusterFetch;
        if (this.clusterLatestCallback && !skipClusterFetch) {
            for (const blockId of blockGets.blockIds) {
                const localEntry = localResult[blockId];
                const localRev = localEntry?.state?.latest?.rev;
                const isMissing = !localEntry?.state?.latest;
                const isStale = !isMissing && this.shouldReadRepair(blockId);
                if (!isMissing && !isStale)
                    continue;
                if (isStale) {
                    log('cluster-tx:read-repair-triggered', {
                        blockId,
                        mode: this.readRepairMode,
                        ageMs: this.ageMs(blockId),
                        localRev
                    });
                }
                try {
                    await this.fetchBlockFromCluster(blockId, blockGets.context);
                    const refreshed = await this.storageRepo.get({ blockIds: [blockId], context: blockGets.context }, options);
                    const newRev = refreshed[blockId]?.state?.latest?.rev;
                    if (refreshed[blockId]) {
                        localResult[blockId] = refreshed[blockId];
                    }
                    if (isStale) {
                        if (typeof newRev === 'number' && typeof localRev === 'number' && newRev > localRev) {
                            log('cluster-tx:read-repair-applied', { blockId, oldRev: localRev, newRev });
                        }
                        else {
                            log('cluster-tx:read-repair-noop', { blockId });
                        }
                    }
                }
                catch (err) {
                    log('cluster-fetch:error', { blockId, error: err.message });
                }
            }
        }
        return localResult;
    }
    /** Decide whether the read-repair policy wants us to consult the cluster for a present-but-possibly-stale block. */
    shouldReadRepair(blockId) {
        switch (this.readRepairMode) {
            case 'off': return false;
            case 'paranoid': return true;
            case 'lazy': {
                const lastSeen = this.lastSeenCommitMs.get(blockId);
                if (lastSeen == null)
                    return true;
                if (this.now() - lastSeen > this.readRepairWindowMs)
                    return true;
                if (this.readRepairSampleRate > 0 && this.rand() < this.readRepairSampleRate)
                    return true;
                return false;
            }
        }
    }
    /** Milliseconds since we last marked this block fresh, or undefined if never. */
    ageMs(blockId) {
        const lastSeen = this.lastSeenCommitMs.get(blockId);
        return lastSeen == null ? undefined : this.now() - lastSeen;
    }
    /** Mark blocks as freshly observed from cluster authority (post-commit or post-fetch). */
    markBlocksSeen(blockIds) {
        const now = this.now();
        for (const id of blockIds) {
            this.lastSeenCommitMs.set(id, now);
        }
    }
    /**
     * Test seam: directly set the last-seen timestamp for a block. Used by read-repair
     * specs to simulate "the local commit happened at time T" without needing to drive
     * a full pend/commit cycle through the cluster coordinator.
     */
    setLastSeenForTest(blockId, ts) {
        this.lastSeenCommitMs.set(blockId, ts);
    }
    async fetchBlockFromCluster(blockId, context) {
        if (!this.clusterLatestCallback)
            return;
        const blockIdBytes = new TextEncoder().encode(blockId);
        const peers = await this.keyNetwork.findCluster(blockIdBytes);
        const peerIds = peers ? Object.keys(peers) : [];
        if (peerIds.length === 0)
            return;
        // Solo-cluster short-circuit: the only responsible peer is us. There is no
        // remote to sync from, so skip the callback entirely. Querying ourselves
        // would dial self via SyncClient — pointless at best, and on nodes without
        // listen addresses (e.g. solo WebSocket-only) the dial can hang.
        if (peerIds.length === 1
            && this.localPeerId
            && peerIds[0] === this.localPeerId.toString()) {
            log('cluster-fetch:solo-self-skip', { blockId });
            return;
        }
        const clusterLatest = await this.queryClusterForLatest(peerIds, blockId, context);
        if (clusterLatest) {
            // Found on cluster - trigger restoration to sync the block
            await this.storageRepo.get({ blockIds: [blockId], context: { committed: [clusterLatest], rev: clusterLatest.rev } });
            log('cluster-fetch:synced', { blockId, rev: clusterLatest.rev });
            this.markBlocksSeen([blockId]);
        }
    }
    /**
     * Query cluster peers to find the maximum latest revision for a block.
     */
    async queryClusterForLatest(peerIds, blockId, context) {
        let maxLatest;
        // Add timeout wrapper to prevent hanging on unresponsive peers
        const withTimeout = (promise, timeoutMs) => Promise.race([
            promise,
            new Promise(resolve => setTimeout(() => resolve(undefined), timeoutMs))
        ]);
        // Query peers in parallel for their latest revision (with 1s timeout per peer)
        const latestResults = await Promise.allSettled(peerIds.map(peerIdStr => {
            const peerId = peerIdFromString(peerIdStr);
            return withTimeout(this.clusterLatestCallback(peerId, blockId, context), 1000);
        }));
        for (const result of latestResults) {
            if (result.status === 'fulfilled' && result.value) {
                const peerLatest = result.value;
                if (!maxLatest || peerLatest.rev > maxLatest.rev) {
                    maxLatest = peerLatest;
                }
            }
        }
        return maxLatest;
    }
    async pend(request, options) {
        const allBlockIds = blockIdsForTransforms(request.transforms);
        await this.verifyResponsibility(allBlockIds);
        const coordinatingBlockIds = options?.coordinatingBlockIds ?? allBlockIds;
        const peerCount = await this.coordinator.getClusterSize(coordinatingBlockIds[0]);
        if (peerCount <= 1) {
            return await this.storageRepo.pend(request, options);
        }
        const message = {
            operations: [{ pend: request }],
            expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT,
            coordinatingBlockIds
        };
        try {
            const { localExecuted } = await this.coordinator.executeClusterTransaction(coordinatingBlockIds[0], message, options);
            log('coordinator-repo:pend-cluster-complete', {
                actionId: request.actionId,
                localExecuted
            });
            // Only call storageRepo if local cluster didn't already execute during consensus
            if (!localExecuted) {
                const result = await this.storageRepo.pend(request, options);
                log('coordinator-repo:pend-fallback-result', {
                    actionId: request.actionId,
                    success: result.success,
                    hasMissing: !!result.missing?.length,
                    hasPending: !!result.pending?.length
                });
                return result;
            }
            // Local cluster already executed - return success
            return {
                success: true,
                pending: [],
                blockIds: allBlockIds
            };
        }
        catch (error) {
            log('coordinator-repo:pend-error', { actionId: request.actionId, error: error.message });
            throw error;
        }
    }
    async cancel(actionRef, options) {
        const blockIds = actionRef.blockIds;
        await this.verifyResponsibility(blockIds);
        // Create a message for this cancel operation with timeout
        const message = {
            operations: [{ cancel: { actionRef } }],
            expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT
        };
        try {
            // For each block ID, execute a cluster transaction
            const clusterPromises = blockIds.map(blockId => this.coordinator.executeClusterTransaction(blockId, message, options));
            // Wait for all cluster transactions to complete
            const results = await Promise.all(clusterPromises);
            // Only call storageRepo if local cluster didn't already execute during consensus
            const anyLocalExecuted = results.some(r => r.localExecuted);
            if (!anyLocalExecuted) {
                await this.storageRepo.cancel(actionRef, options);
            }
        }
        catch (error) {
            log('coordinator-repo:cancel-error', { actionId: actionRef.actionId, error: error.message });
            throw error;
        }
    }
    async commit(request, options) {
        const blockIds = request.blockIds;
        await this.verifyResponsibility(blockIds);
        const peerCount = await this.coordinator.getClusterSize(blockIds[0]);
        if (peerCount <= 1) {
            const result = await this.storageRepo.commit(request, options);
            if (result.success)
                this.markBlocksSeen(blockIds);
            return result;
        }
        const message = {
            operations: [{ commit: request }],
            expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT
        };
        try {
            const { record, localExecuted } = await this.coordinator.executeClusterTransaction(blockIds[0], message, options);
            if (localExecuted) {
                this.markBlocksSeen(blockIds);
                return { success: true };
            }
            // Local cluster didn't execute during consensus. Attempt a local commit,
            // but tolerate failure (e.g., "pending action not found") when the cluster
            // already reached consensus — this coordinator was likely picked for commit
            // after missing the pend phase (unreachable during pend, fresh join, etc.).
            // The cluster's majority is authoritative; this peer will catch up via sync.
            try {
                const result = await this.storageRepo.commit(request, options);
                if (result.success)
                    this.markBlocksSeen(blockIds);
                return result;
            }
            catch (err) {
                if (clusterReachedCommitConsensus(record)) {
                    log('coordinator-repo:commit-local-failed-cluster-succeeded', {
                        actionId: request.actionId,
                        error: err.message
                    });
                    this.markBlocksSeen(blockIds);
                    return { success: true };
                }
                throw err;
            }
        }
        catch (error) {
            log('coordinator-repo:commit-error', { actionId: request.actionId, error: error.message });
            throw error;
        }
    }
}
/** True if a simple majority of cluster peers signed an approving commit. */
function clusterReachedCommitConsensus(record) {
    const peerCount = Object.keys(record.peers).length;
    if (peerCount === 0)
        return false;
    const approvedCommits = Object.values(record.commits).filter(s => s.type === 'approve').length;
    return approvedCommits > peerCount / 2;
}
//# sourceMappingURL=coordinator-repo.js.map