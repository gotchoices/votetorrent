import { peerIdFromString } from "@libp2p/peer-id";
import { base58btc } from "multiformats/bases/base58";
import { sha256 } from "multiformats/hashes/sha2";
import { Pending } from "@optimystic/db-core";
import { createLogger, verbose } from '../logger.js';
import { PenaltyReason } from "../reputation/types.js";
const log = createLogger('cluster');
/** Manages distributed transactions across clusters */
export class ClusterCoordinator {
    keyNetwork;
    createClusterClient;
    cfg;
    localCluster;
    fretService;
    reputation;
    stateStore;
    transactions = new Map();
    retryInitialIntervalMs;
    retryBackoffFactor;
    retryMaxIntervalMs;
    retryMaxAttempts;
    commitBroadcastImmediateRetries;
    constructor(keyNetwork, createClusterClient, cfg, localCluster, fretService, reputation, stateStore) {
        this.keyNetwork = keyNetwork;
        this.createClusterClient = createClusterClient;
        this.cfg = cfg;
        this.localCluster = localCluster;
        this.fretService = fretService;
        this.reputation = reputation;
        this.stateStore = stateStore;
        this.retryInitialIntervalMs = cfg.commitBroadcastRetryInitialMs ?? 250;
        this.retryBackoffFactor = cfg.commitBroadcastRetryBackoffFactor ?? 2;
        this.retryMaxIntervalMs = cfg.commitBroadcastRetryMaxIntervalMs ?? 8000;
        this.retryMaxAttempts = cfg.commitBroadcastRetryMaxAttempts ?? 5;
        this.commitBroadcastImmediateRetries = cfg.commitBroadcastImmediateRetries ?? 1;
    }
    /**
     * Creates a base 58 BTC string hash for a message to uniquely identify a transaction
     */
    /** Deterministic JSON: sorts object keys so hash is order-independent */
    static canonicalJson(value) {
        return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
            ? Object.keys(v).sort().reduce((o, k) => { o[k] = v[k]; return o; }, {})
            : v);
    }
    async createMessageHash(message) {
        const msgBytes = new TextEncoder().encode(ClusterCoordinator.canonicalJson(message));
        const hashBytes = await sha256.digest(msgBytes);
        return base58btc.encode(hashBytes.digest);
    }
    /**
     * Gets all peers in the cluster for a specific block ID
     */
    async getClusterForBlock(blockId) {
        const blockIdBytes = new TextEncoder().encode(blockId);
        try {
            const peers = await this.keyNetwork.findCluster(blockIdBytes);
            const peerIds = Object.keys(peers ?? {});
            log('cluster-tx:cluster-members', { blockId, peerIds });
            return peers;
        }
        catch (e) {
            log('WARN findCluster failed for %s: %o', blockId, e);
            return {};
        }
    }
    makeRecord(peers, messageHash, message) {
        const peerCount = Object.keys(peers ?? {}).length;
        const record = {
            messageHash,
            peers,
            message,
            coordinatingBlockIds: message.coordinatingBlockIds,
            promises: {},
            commits: {},
            suggestedClusterSize: peerCount || undefined,
            minRequiredSize: this.cfg.allowClusterDownsize ? undefined : this.cfg.clusterSize
        };
        // Add network size hint if available
        if (this.fretService) {
            try {
                const estimate = this.fretService.getNetworkSizeEstimate();
                if (estimate.size_estimate > 0) {
                    record.networkSizeHint = estimate.size_estimate;
                    record.networkSizeConfidence = estimate.confidence;
                }
            }
            catch (err) {
                // Ignore errors getting size estimate
            }
        }
        return record;
    }
    /**
     * Initiates a 2-phase transaction for a specific block ID.
     * Returns the cluster record and whether the local cluster already executed the operations.
     */
    async executeClusterTransaction(blockId, message, _options) {
        // Get the cluster peers for this block
        const peers = await this.getClusterForBlock(blockId);
        // Create a unique hash for this transaction
        const messageHash = await this.createMessageHash(message);
        // Create a cluster record for this transaction
        const record = this.makeRecord(peers, messageHash, message);
        log('cluster-tx:start', {
            messageHash,
            blockId,
            peerCount: Object.keys(peers ?? {}).length,
            allowDownsize: this.cfg.allowClusterDownsize,
            configuredSize: this.cfg.clusterSize,
            suggestedSize: record.suggestedClusterSize,
            minRequiredSize: record.minRequiredSize
        });
        // Create a new pending transaction
        const transactionPromise = this.executeTransaction(peers, record);
        const pending = new Pending(transactionPromise);
        // Store the transaction state
        const state = {
            messageHash,
            record,
            pending,
            lastUpdate: Date.now()
        };
        this.transactions.set(messageHash, state);
        this.persistCoordinatorState(messageHash, record, 'promising');
        log('cluster-tx:transaction-store', {
            messageHash,
            transactionKeys: Array.from(this.transactions.keys())
        });
        // Wait for the transaction to complete
        try {
            const result = await pending.result();
            // Check if the local cluster already executed the operations during consensus
            const localExecuted = this.localCluster?.wasTransactionExecuted?.(messageHash) ?? false;
            return { record: result, localExecuted };
        }
        finally {
            const stored = this.transactions.get(messageHash);
            const retrySnapshot = stored?.retry ? {
                attempt: stored.retry.attempt,
                pending: Array.from(stored.retry.pendingPeers ?? [])
            } : undefined;
            log('cluster-tx:complete', {
                messageHash,
                finalPromises: stored ? Object.keys(stored.record.promises ?? {}) : undefined,
                finalCommits: stored ? Object.keys(stored.record.commits ?? {}) : undefined,
                retry: retrySnapshot
            });
            // Don't remove transaction immediately if retries are scheduled
            // Let the retry completion or abort handle cleanup
            if (!stored?.retry) {
                // Wait a bit before cleanup to allow any in-flight responses to arrive
                setTimeout(() => {
                    this.transactions.delete(messageHash);
                    this.deleteCoordinatorState(messageHash);
                    log('cluster-tx:transaction-remove', {
                        messageHash,
                        remaining: Array.from(this.transactions.keys())
                    });
                }, 100);
            }
        }
    }
    /**
     * Executes the full transaction process
     */
    async executeTransaction(peers, record) {
        const peerCount = Object.keys(peers).length;
        // Validate against minimum cluster size
        if (peerCount < this.cfg.minAbsoluteClusterSize) {
            const validated = await this.validateSmallCluster(peerCount, peers);
            if (!validated) {
                log('cluster-tx:reject-too-small', {
                    peerCount,
                    minRequired: this.cfg.minAbsoluteClusterSize
                });
                throw new Error(`Cluster size ${peerCount} below minimum ${this.cfg.minAbsoluteClusterSize} and not validated`);
            }
            log('cluster-tx:small-cluster-validated', { peerCount });
        }
        // Check configured cluster size
        if (!this.cfg.allowClusterDownsize && peerCount < this.cfg.clusterSize) {
            log('cluster-tx:reject-downsize', { peerCount, required: this.cfg.clusterSize });
            throw new Error(`Cluster size ${peerCount} below configured minimum ${this.cfg.clusterSize}`);
        }
        // Collect promises with super-majority requirement
        const promised = await this.collectPromises(peers, record);
        const superMajority = Math.ceil(peerCount * this.cfg.superMajorityThreshold);
        // Count approvals and rejections separately
        const promises = promised.record.promises;
        const approvalCount = Object.values(promises).filter(sig => sig.type === 'approve').length;
        const rejectionCount = Object.values(promises).filter(sig => sig.type === 'reject').length;
        // Check if rejections make super-majority impossible
        // If more than (peerCount - superMajority) nodes reject, we can never reach super-majority
        const maxAllowedRejections = peerCount - superMajority;
        if (rejectionCount > maxAllowedRejections) {
            const rejectReasons = Object.entries(promises)
                .filter(([_, sig]) => sig.type === 'reject')
                .map(([peerId, sig]) => `${peerId}: ${sig.rejectReason ?? 'unknown'}`)
                .join('; ');
            log('cluster-tx:rejected-by-validators', {
                messageHash: record.messageHash,
                peerCount,
                rejections: rejectionCount,
                maxAllowed: maxAllowedRejections,
                reasons: rejectReasons
            });
            this.updateTransactionRecord(promised.record, 'rejected-by-validators');
            throw new Error(`Transaction rejected by validators (${rejectionCount}/${peerCount} rejected): ${rejectReasons}`);
        }
        if (peerCount > 1 && approvalCount < superMajority) {
            log('cluster-tx:supermajority-failed', {
                messageHash: record.messageHash,
                peerCount,
                approvals: approvalCount,
                rejections: rejectionCount,
                superMajority,
                threshold: this.cfg.superMajorityThreshold
            });
            this.updateTransactionRecord(promised.record, 'supermajority-failed');
            throw new Error(`Failed to get super-majority: ${approvalCount}/${peerCount} approvals (needed ${superMajority}, ${rejectionCount} rejections)`);
        }
        // Mark as disputed when minority rejections exist but super-majority approves
        if (rejectionCount > 0 && approvalCount >= superMajority) {
            const rejectingPeers = [];
            const rejectReasons = {};
            for (const [peerId, sig] of Object.entries(promises)) {
                if (sig.type === 'reject') {
                    rejectingPeers.push(peerId);
                    rejectReasons[peerId] = sig.rejectReason ?? 'unknown';
                }
            }
            promised.record.disputed = true;
            promised.record.disputeEvidence = { rejectingPeers, rejectReasons };
            log('cluster-tx:disputed', {
                messageHash: record.messageHash,
                rejectingPeers,
                rejectReasons,
                approvalCount,
                rejectionCount,
                peerCount
            });
        }
        this.persistCoordinatorState(promised.record.messageHash, promised.record, 'committing');
        return await this.commitTransaction(promised.record);
    }
    async getClusterSize(blockId) {
        const peers = await this.getClusterForBlock(blockId);
        return Object.keys(peers ?? {}).length;
    }
    /**
     * Validate that a small cluster size is legitimate by querying remote peers
     * for their network size estimates. Returns true if estimates roughly agree.
     */
    async validateSmallCluster(localSize, _peers) {
        // If we have FRET and it shows confident estimate
        if (this.fretService) {
            try {
                const estimate = this.fretService.getNetworkSizeEstimate();
                if (estimate.confidence > 0.5) {
                    // Check if FRET estimate roughly matches observed cluster size
                    const orderOfMagnitude = Math.floor(Math.log10(estimate.size_estimate + 1));
                    const localOrderOfMagnitude = Math.floor(Math.log10(localSize + 1));
                    // If within same order of magnitude, accept it
                    if (Math.abs(orderOfMagnitude - localOrderOfMagnitude) <= 1) {
                        log('cluster-tx:small-cluster-validated-by-fret', {
                            localSize,
                            fretEstimate: estimate.size_estimate,
                            confidence: estimate.confidence,
                            sources: estimate.sources
                        });
                        return true;
                    }
                }
            }
            catch (err) {
                // Ignore errors
            }
        }
        // Fallback: accept small clusters in development/testing scenarios
        // In production, FRET should provide validation
        log('cluster-tx:small-cluster-accepted-without-validation', {
            localSize,
            reason: 'no-confident-network-size-estimate'
        });
        return true;
    }
    /**
     * Collects promises from all peers in the cluster
     */
    async collectPromises(peers, record) {
        const peerIds = Object.keys(peers);
        const summary = [];
        if (verbose) {
            const peerDetail = peerIds.map(id => ({
                id: id.substring(0, 12),
                addrs: peers[id]?.multiaddrs?.length ?? 0
            }));
            log('cluster-tx:promise-peers', { messageHash: record.messageHash, peers: peerDetail });
        }
        // For each peer, create a client and request a promise
        const promiseRequests = peerIds.map(peerIdStr => {
            const isLocal = this.localCluster && peerIdStr === this.localCluster.peerId.toString();
            log('cluster-tx:promise-request', { messageHash: record.messageHash, peerId: peerIdStr, isLocal });
            const promise = isLocal
                ? this.localCluster.update(record)
                : this.createClusterClient(peerIdFromString(peerIdStr)).update(record);
            return new Pending(promise);
        });
        // Wait for all promises to complete
        const results = await Promise.all(promiseRequests.map((p, idx) => p.result().then(res => {
            const peerIdStr = peerIds[idx];
            log('cluster-tx:promise-response', {
                messageHash: record.messageHash,
                peerId: peerIdStr,
                success: true,
                returnedPromises: Object.keys(res.promises ?? {}),
                returnedCommits: Object.keys(res.commits ?? {})
            });
            summary.push({ peerId: peerIdStr, success: true });
            return res;
        }).catch(err => {
            const peerIdStr = peerIds[idx];
            log('cluster-tx:promise-response', { messageHash: record.messageHash, peerId: peerIdStr, success: false, error: err });
            summary.push({ peerId: peerIdStr, success: false, error: err instanceof Error ? err.message : String(err) });
            this.reputation?.reportPeer(peerIdStr, PenaltyReason.ConsensusTimeout, `promise:${record.messageHash}`);
            return null;
        })));
        const successes = summary.filter(entry => entry.success).map(entry => entry.peerId);
        const failures = summary.filter(entry => !entry.success);
        log('cluster-tx:promise-summary', {
            messageHash: record.messageHash,
            successes,
            failures
        });
        log('cluster-tx:promise-merge-begin', {
            messageHash: record.messageHash,
            initialPromises: Object.keys(record.promises ?? {}),
            transactionsKeys: Array.from(this.transactions.keys()),
            hasTransaction: this.transactions.has(record.messageHash)
        });
        // Merge all promises into the record
        for (const result of results.filter(Boolean)) {
            log('cluster-tx:promise-merge-input', {
                messageHash: record.messageHash,
                resultFrom: Object.keys(result.promises ?? {}),
                recordBefore: Object.keys(record.promises ?? {})
            });
            const resultPromises = Object.keys(result.promises ?? {});
            log('cluster-tx:promise-merge-result', {
                messageHash: record.messageHash,
                peerPromises: resultPromises
            });
            if (typeof record.suggestedClusterSize === 'number' && typeof result.suggestedClusterSize === 'number') {
                const expected = result.suggestedClusterSize;
                const actual = Object.keys(peers).length;
                const maxDiff = Math.ceil(Math.max(1, expected * this.cfg.clusterSizeTolerance));
                if (Math.abs(actual - expected) > maxDiff) {
                    log('cluster-tx:size-variance', { expected, actual, tolerance: this.cfg.clusterSizeTolerance });
                }
            }
            record.promises = { ...record.promises, ...result.promises };
            log('cluster-tx:promise-merge-after', {
                messageHash: record.messageHash,
                mergedPromises: Object.keys(record.promises ?? {})
            });
        }
        log('cluster-tx:promise-merge', {
            messageHash: record.messageHash,
            mergedPromises: Object.keys(record.promises ?? {})
        });
        log('cluster-tx:promise-merge-end', {
            messageHash: record.messageHash,
            finalPromises: Object.keys(record.promises ?? {}),
            transactionsEntry: this.transactions.get(record.messageHash)
        });
        this.updateTransactionRecord(record, 'after-promises');
        return { record };
    }
    /**
     * Commits the transaction to all peers in the cluster
     */
    async commitTransaction(record) {
        // For each peer, create a client and send the commit
        const peerIds = Object.keys(record.peers);
        const summary = [];
        if (verbose) {
            const peerDetail = peerIds.map(id => ({
                id: id.substring(0, 12),
                addrs: record.peers[id]?.multiaddrs?.length ?? 0
            }));
            log('cluster-tx:commit-peers', { messageHash: record.messageHash, peers: peerDetail });
        }
        // Send the record with promises to all peers
        // Each peer will add its own commit signature
        const commitPayload = {
            ...record
        };
        const commitRequests = peerIds.map(peerIdStr => {
            const isLocal = this.localCluster && peerIdStr === this.localCluster.peerId.toString();
            log('cluster-tx:commit-request', { messageHash: record.messageHash, peerId: peerIdStr, isLocal });
            const promise = isLocal
                ? this.localCluster.update(commitPayload)
                : this.createClusterClient(peerIdFromString(peerIdStr)).update(commitPayload);
            return new Pending(promise);
        });
        // Wait for all commits to complete
        const results = await Promise.all(commitRequests.map((p, idx) => p.result().then(res => {
            const peerIdStr = peerIds[idx];
            log('cluster-tx:commit-response', { messageHash: record.messageHash, peerId: peerIdStr, success: true });
            summary.push({ peerId: peerIdStr, success: true });
            return res;
        }).catch(err => {
            const peerIdStr = peerIds[idx];
            log('cluster-tx:commit-response', { messageHash: record.messageHash, peerId: peerIdStr, success: false, error: err });
            summary.push({ peerId: peerIdStr, success: false, error: err instanceof Error ? err.message : String(err) });
            this.reputation?.reportPeer(peerIdStr, PenaltyReason.ConsensusTimeout, `commit:${record.messageHash}`);
            return null;
        })));
        const commitSuccesses = summary.filter(entry => entry.success).map(entry => entry.peerId);
        const commitFailures = summary.filter(entry => !entry.success);
        log('cluster-tx:commit-summary', {
            messageHash: record.messageHash,
            successes: commitSuccesses,
            failures: commitFailures
        });
        log('cluster-tx:commit-merge-begin', {
            messageHash: record.messageHash,
            initialCommits: Object.keys(record.commits ?? {}),
            transactionsEntry: this.transactions.get(record.messageHash)
        });
        // Merge all commits into the record
        for (const result of results.filter(Boolean)) {
            log('cluster-tx:commit-merge-input', {
                messageHash: record.messageHash,
                resultFrom: Object.keys(result.commits ?? {}),
                recordBefore: Object.keys(record.commits ?? {})
            });
            log('cluster-tx:commit-merge-result', {
                messageHash: record.messageHash,
                peerCommits: Object.keys(result.commits ?? {})
            });
            record.commits = { ...record.commits, ...result.commits };
            log('cluster-tx:commit-merge-after', {
                messageHash: record.messageHash,
                mergedCommits: Object.keys(record.commits ?? {})
            });
        }
        log('cluster-tx:commit-merge', {
            messageHash: record.messageHash,
            mergedCommits: Object.keys(record.commits ?? {})
        });
        log('cluster-tx:commit-merge-end', {
            messageHash: record.messageHash,
            finalCommits: Object.keys(record.commits ?? {}),
            transactionsEntry: this.transactions.get(record.messageHash)
        });
        this.updateTransactionRecord(record, 'after-commit');
        // Check for simple majority (>50%) - this proves commitment
        const peerCount = Object.keys(record.peers).length;
        const simpleMajority = Math.floor(peerCount * this.cfg.simpleMajorityThreshold) + 1;
        const commitCount = Object.keys(record.commits).length;
        if (commitCount >= simpleMajority) {
            log('cluster-tx:commit-majority-reached', {
                messageHash: record.messageHash,
                commitCount,
                simpleMajority,
                peerCount,
                threshold: this.cfg.simpleMajorityThreshold
            });
            // Broadcast the merged record (with all commit signatures) to ALL peers
            // so each peer can independently reach consensus and execute the operations.
            // Without this, only the coordinator's local cluster executes — remote peers
            // never see enough commits to reach consensus on their own.
            const { failures: broadcastFailures } = await this.broadcastMergedRecord(record, peerIds);
            if (broadcastFailures.length > 0) {
                this.scheduleCommitRetry(record.messageHash, record, broadcastFailures);
            }
            else {
                this.clearRetry(record.messageHash);
            }
        }
        else {
            const missingPeers = commitFailures.map(entry => entry.peerId);
            if (missingPeers.length > 0) {
                this.scheduleCommitRetry(record.messageHash, record, missingPeers);
            }
            else {
                this.clearRetry(record.messageHash);
            }
        }
        return record;
    }
    /**
     * Broadcast the merged commit record to every peer, with `commitBroadcastImmediateRetries`
     * in-line re-attempts per peer before giving up. The libp2p connection used during
     * the prior commit phase is typically still warm, so a single immediate retry recovers
     * most transient stream errors without falling back to the scheduled retry timer.
     * Local cluster is invoked exactly once — local failures are fatal, not transient.
     */
    async broadcastMergedRecord(record, peerIds) {
        const maxAttempts = 1 + Math.max(0, this.commitBroadcastImmediateRetries);
        const results = await Promise.all(peerIds.map(async (peerIdStr) => {
            const isLocal = this.localCluster && peerIdStr === this.localCluster.peerId.toString();
            if (isLocal) {
                try {
                    await this.localCluster.update(record);
                    return { peerId: peerIdStr, success: true };
                }
                catch (err) {
                    log('cluster-tx:consensus-broadcast-error', {
                        messageHash: record.messageHash,
                        peerId: peerIdStr,
                        error: err.message
                    });
                    return { peerId: peerIdStr, success: false };
                }
            }
            let lastError;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    await this.createClusterClient(peerIdFromString(peerIdStr)).update(record);
                    return { peerId: peerIdStr, success: true };
                }
                catch (err) {
                    lastError = err;
                    if (attempt < maxAttempts) {
                        log('cluster-tx:consensus-broadcast-retry', {
                            messageHash: record.messageHash,
                            peerId: peerIdStr,
                            attempt,
                            error: err.message
                        });
                    }
                }
            }
            log('cluster-tx:consensus-broadcast-error', {
                messageHash: record.messageHash,
                peerId: peerIdStr,
                attempts: maxAttempts,
                error: lastError instanceof Error ? lastError.message : String(lastError)
            });
            return { peerId: peerIdStr, success: false };
        }));
        const failures = results.filter(r => !r.success).map(r => r.peerId);
        return { failures };
    }
    updateTransactionRecord(record, stage) {
        const state = this.transactions.get(record.messageHash);
        if (!state) {
            log('cluster-tx:transaction-update-miss', { messageHash: record.messageHash, stage });
            return;
        }
        state.record = { ...record };
        state.lastUpdate = Date.now();
        log('cluster-tx:transaction-update', {
            messageHash: record.messageHash,
            stage,
            promises: Object.keys(record.promises ?? {}),
            commits: Object.keys(record.commits ?? {})
        });
    }
    scheduleCommitRetry(messageHash, _record, missingPeers) {
        const state = this.transactions.get(messageHash);
        if (!state) {
            return;
        }
        const existing = state.retry;
        const nextAttempt = (existing?.attempt ?? 0) + 1;
        if (nextAttempt > this.retryMaxAttempts) {
            log('cluster-tx:retry-abort', { messageHash, missingPeers });
            return;
        }
        if (missingPeers.length === 0) {
            this.clearRetry(messageHash);
            return;
        }
        const pendingPeers = new Set(missingPeers);
        const baseInterval = existing ? Math.min(existing.intervalMs * this.retryBackoffFactor, this.retryMaxIntervalMs) : this.retryInitialIntervalMs;
        if (existing?.timer) {
            clearTimeout(existing.timer);
        }
        const timer = setTimeout(() => {
            void this.retryCommits(messageHash);
        }, baseInterval);
        state.retry = {
            pendingPeers,
            attempt: nextAttempt,
            intervalMs: baseInterval,
            timer
        };
        this.persistCoordinatorState(messageHash, state.record, 'broadcasting', {
            pendingPeers: Array.from(pendingPeers),
            attempt: nextAttempt,
            intervalMs: baseInterval
        });
        log('cluster-tx:retry-scheduled', { messageHash, attempt: nextAttempt, missingPeers, delayMs: baseInterval });
    }
    async retryCommits(messageHash) {
        const state = this.transactions.get(messageHash);
        if (!state?.retry) {
            return;
        }
        const { pendingPeers, attempt } = state.retry;
        if (pendingPeers.size === 0) {
            this.clearRetry(messageHash);
            return;
        }
        const peerIds = Array.from(pendingPeers);
        const record = state.record;
        log('cluster-tx:retry-start', { messageHash, attempt, peerIds });
        const results = await Promise.all(peerIds.map(async (peerIdStr) => {
            const isLocal = this.localCluster && peerIdStr === this.localCluster.peerId.toString();
            const payload = {
                ...record,
                commits: record.commits
            };
            try {
                const res = isLocal
                    ? await this.localCluster.update(payload)
                    : await this.createClusterClient(peerIdFromString(peerIdStr)).update(payload);
                state.record.commits = { ...state.record.commits, ...res.commits };
                return { peerId: peerIdStr, success: true };
            }
            catch (err) {
                return {
                    peerId: peerIdStr,
                    success: false,
                    error: err instanceof Error ? err.message : String(err)
                };
            }
        }));
        const successes = results.filter(r => r.success).map(r => r.peerId);
        const failures = results.filter(r => !r.success);
        for (const peerId of successes) {
            pendingPeers.delete(peerId);
        }
        log('cluster-tx:retry-complete', { messageHash, attempt, successes, failures });
        if (pendingPeers.size === 0) {
            log('cluster-tx:retry-finished', { messageHash });
            this.clearRetry(messageHash);
            return;
        }
        if (!this.transactions.has(messageHash)) {
            return;
        }
        this.scheduleCommitRetry(messageHash, state.record, Array.from(pendingPeers));
    }
    clearRetry(messageHash) {
        const state = this.transactions.get(messageHash);
        if (!state?.retry) {
            return;
        }
        if (state.retry.timer) {
            clearTimeout(state.retry.timer);
        }
        state.retry = undefined;
        // Clean up the transaction after retry is complete
        setTimeout(() => {
            this.transactions.delete(messageHash);
            this.deleteCoordinatorState(messageHash);
            log('cluster-tx:transaction-remove', {
                messageHash,
                remaining: Array.from(this.transactions.keys())
            });
        }, 100);
    }
    /** Fire-and-forget persist — errors are logged, never thrown. */
    persistCoordinatorState(messageHash, record, phase, retryState) {
        if (!this.stateStore)
            return;
        this.stateStore.saveCoordinatorState(messageHash, {
            messageHash,
            record,
            lastUpdate: Date.now(),
            phase,
            retryState
        }).catch(err => log('cluster-tx:persist-error', { messageHash, error: err.message }));
    }
    /** Fire-and-forget delete — errors are logged, never thrown. */
    deleteCoordinatorState(messageHash) {
        if (!this.stateStore)
            return;
        this.stateStore.deleteCoordinatorState(messageHash)
            .catch(err => log('cluster-tx:persist-delete-error', { messageHash, error: err.message }));
    }
    /**
     * Recover coordinator transactions from persistent store after a restart.
     * Called during node startup, before accepting new requests.
     */
    async recoverTransactions() {
        if (!this.stateStore)
            return;
        const states = await this.stateStore.getAllCoordinatorStates();
        for (const state of states) {
            const { messageHash } = state;
            // Expired — clean up
            if (state.record.message.expiration && state.record.message.expiration < Date.now()) {
                log('cluster-tx:recovery-expired', { messageHash });
                await this.stateStore.deleteCoordinatorState(messageHash);
                continue;
            }
            // Broadcasting phase with retry state — resume retries
            if (state.phase === 'broadcasting' && state.retryState) {
                log('cluster-tx:recovery-resume-broadcast', { messageHash, attempt: state.retryState.attempt });
                const pending = new Pending(Promise.resolve(state.record));
                const txState = {
                    messageHash,
                    record: state.record,
                    pending,
                    lastUpdate: state.lastUpdate
                };
                this.transactions.set(messageHash, txState);
                // Schedule retry from where we left off
                this.scheduleCommitRetry(messageHash, state.record, state.retryState.pendingPeers);
                continue;
            }
            // Promising or committing — cannot resume (caller context is gone)
            log('cluster-tx:recovery-stale', { messageHash, phase: state.phase });
            await this.stateStore.deleteCoordinatorState(messageHash);
        }
    }
}
//# sourceMappingURL=cluster-coordinator.js.map