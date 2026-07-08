import { blockIdsForTransforms } from "@optimystic/db-core";
import { ClusterClient } from "./client.js";
import { peerIdFromString } from "@libp2p/peer-id";
import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { sha256 } from "multiformats/hashes/sha2";
import { base58btc } from "multiformats/bases/base58";
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { createLogger } from '../logger.js';
import { PenaltyReason } from "../reputation/types.js";
const log = createLogger('cluster-member');
/** State of a transaction in the cluster */
var TransactionPhase;
(function (TransactionPhase) {
    TransactionPhase[TransactionPhase["Promising"] = 0] = "Promising";
    TransactionPhase[TransactionPhase["OurPromiseNeeded"] = 1] = "OurPromiseNeeded";
    TransactionPhase[TransactionPhase["OurCommitNeeded"] = 2] = "OurCommitNeeded";
    TransactionPhase[TransactionPhase["Consensus"] = 3] = "Consensus";
    TransactionPhase[TransactionPhase["Rejected"] = 4] = "Rejected";
    TransactionPhase[TransactionPhase["Propagating"] = 5] = "Propagating"; // Transaction is being propagated
})(TransactionPhase || (TransactionPhase = {}));
export function clusterMember(components) {
    return new ClusterMember(components.storageRepo, components.peerNetwork, components.peerId, components.privateKey, components.protocolPrefix, components.partitionDetector, components.fretService, components.validator, components.reputation, components.consensusConfig, components.stateStore);
}
// How long to keep executed transaction records (10 minutes)
const ExecutedTransactionTtlMs = 10 * 60 * 1000;
/**
 * Handles cluster-side operations, managing promises and commits for cluster updates
 * and coordinating with the local storage repo.
 */
export class ClusterMember {
    storageRepo;
    peerNetwork;
    peerId;
    privateKey;
    protocolPrefix;
    fretService;
    validator;
    reputation;
    stateStore;
    // Track active transactions by their message hash
    activeTransactions = new Map();
    // Track executed consensus transactions to prevent duplicate execution (messageHash -> executedAt timestamp)
    executedTransactions = new Map();
    // Queue of transactions to clean up
    cleanupQueue = [];
    // Serialize concurrent updates for the same transaction
    pendingUpdates = new Map();
    // Temporarily set during validateSignatures so verifySignature can access the record
    currentValidationRecord;
    // Interval handles for periodic cleanup (stored so dispose() can clear them)
    expirationInterval;
    cleanupInterval;
    /** Effective super-majority threshold. Defaults to 1.0 (unanimity) for backward compatibility. */
    superMajorityThreshold;
    constructor(storageRepo, peerNetwork, peerId, privateKey, protocolPrefix, 
    // Reserved for partition-healing (backlog ticket 6.5-partition-healing); held but not yet consumed.
    _partitionDetector, fretService, validator, reputation, consensusConfig, stateStore) {
        this.storageRepo = storageRepo;
        this.peerNetwork = peerNetwork;
        this.peerId = peerId;
        this.privateKey = privateKey;
        this.protocolPrefix = protocolPrefix;
        this.fretService = fretService;
        this.validator = validator;
        this.reputation = reputation;
        this.stateStore = stateStore;
        this.superMajorityThreshold = consensusConfig?.superMajorityThreshold ?? 1.0;
        // Periodically clean up expired transactions (.unref() so tests/short-lived processes can exit)
        this.expirationInterval = setInterval(() => this.queueExpiredTransactions(), 60000);
        this.expirationInterval.unref();
        // Process cleanup queue
        this.cleanupInterval = setInterval(() => this.processCleanupQueue(), 1000);
        this.cleanupInterval.unref();
    }
    /**
     * Clears all interval and timeout handles and empties active state.
     * Called during node shutdown to prevent leaked timers.
     */
    dispose() {
        clearInterval(this.expirationInterval);
        clearInterval(this.cleanupInterval);
        for (const [, state] of this.activeTransactions) {
            if (state.promiseTimeout)
                clearTimeout(state.promiseTimeout);
            if (state.resolutionTimeout)
                clearTimeout(state.resolutionTimeout);
        }
        this.activeTransactions.clear();
        this.cleanupQueue.length = 0;
    }
    /**
     * Checks if a transaction's operations were already executed during consensus.
     * Used by the coordinator to avoid duplicate execution in CoordinatorRepo.
     */
    wasTransactionExecuted(messageHash) {
        return this.executedTransactions.has(messageHash);
    }
    /**
     * Handles an incoming cluster update, managing the two-phase commit process
     * and coordinating with the local storage repo
     */
    async update(record) {
        // Serialize concurrent updates for the same transaction
        const existingUpdate = this.pendingUpdates.get(record.messageHash);
        if (existingUpdate) {
            log('cluster-member:concurrent-update-wait', { messageHash: record.messageHash });
            await existingUpdate;
            // After waiting, continue processing with the new incoming record
            // to ensure proper merging of promises/commits from coordinator
        }
        // Create a promise for this update operation
        const updatePromise = this.processUpdate(record);
        this.pendingUpdates.set(record.messageHash, updatePromise);
        try {
            const result = await updatePromise;
            return result;
        }
        finally {
            // Remove from pending updates after a short delay to allow concurrent calls to see it
            setTimeout(() => {
                this.pendingUpdates.delete(record.messageHash);
            }, 100).unref();
        }
    }
    async processUpdate(record) {
        const ourId = this.peerId.toString();
        const inboundPhase = record.commits[ourId] ? 'commit' : record.promises[ourId] ? 'promise' : 'initial';
        log('cluster-member:incoming', {
            messageHash: record.messageHash,
            phase: inboundPhase,
            peerCount: Object.keys(record.peers).length,
            promiseCount: Object.keys(record.promises).length,
            commitCount: Object.keys(record.commits).length,
            existingTransaction: this.activeTransactions.has(record.messageHash)
        });
        // Report network size hint to FRET if provided
        if (this.fretService && record.networkSizeHint && record.networkSizeConfidence) {
            try {
                this.fretService.reportNetworkSize(record.networkSizeHint, record.networkSizeConfidence, 'cluster');
            }
            catch (err) {
                // Ignore errors reporting to FRET
            }
        }
        // Validate the incoming record
        await this.validateRecord(record);
        const existingState = this.activeTransactions.get(record.messageHash);
        let currentRecord = existingState?.record || record;
        if (existingState) {
            log('cluster-member:merge-start', {
                messageHash: record.messageHash,
                existingPromises: Object.keys(existingState.record.promises ?? {}),
                existingCommits: Object.keys(existingState.record.commits ?? {}),
                incomingPromises: Object.keys(record.promises ?? {}),
                incomingCommits: Object.keys(record.commits ?? {})
            });
        }
        // If we have an existing record, merge the signatures
        if (existingState) {
            currentRecord = await this.mergeRecords(existingState.record, record);
            log('cluster-member:merge-complete', {
                messageHash: record.messageHash,
                mergedPromises: Object.keys(currentRecord.promises ?? {}),
                mergedCommits: Object.keys(currentRecord.commits ?? {})
            });
        }
        // Get the current transaction state
        const phase = await this.getTransactionPhase(currentRecord);
        log('cluster-member:phase', {
            messageHash: record.messageHash,
            phase,
            promises: Object.keys(currentRecord.promises ?? {}),
            commits: Object.keys(currentRecord.commits ?? {})
        });
        let shouldPersist = true;
        // Handle the transaction based on its state
        switch (phase) {
            case TransactionPhase.OurPromiseNeeded:
                log('cluster-member:action-promise', {
                    messageHash: record.messageHash
                });
                currentRecord = await this.handlePromiseNeeded(currentRecord);
                log('cluster-member:action-promise-complete', {
                    messageHash: record.messageHash,
                    promises: Object.keys(currentRecord.promises ?? {})
                });
                break;
            case TransactionPhase.OurCommitNeeded:
                log('cluster-member:action-commit', {
                    messageHash: record.messageHash
                });
                currentRecord = await this.handleCommitNeeded(currentRecord);
                log('cluster-member:action-commit-complete', {
                    messageHash: record.messageHash,
                    commits: Object.keys(currentRecord.commits ?? {})
                });
                // After adding our commit, check if we now have consensus and execute if so
                {
                    const newPhase = await this.getTransactionPhase(currentRecord);
                    if (newPhase === TransactionPhase.Consensus) {
                        log('cluster-member:action-consensus-after-commit', {
                            messageHash: record.messageHash
                        });
                        // Check persistent store for post-recovery dedup before synchronous guard
                        if (!await this.wasTransactionExecutedAsync(currentRecord.messageHash)) {
                            await this.handleConsensus(currentRecord);
                        }
                    }
                }
                shouldPersist = false;
                break;
            case TransactionPhase.Consensus:
                log('cluster-member:action-consensus', {
                    messageHash: record.messageHash
                });
                // Check persistent store for post-recovery dedup before synchronous guard
                if (await this.wasTransactionExecutedAsync(currentRecord.messageHash)) {
                    log('cluster-member:consensus-already-executed', { messageHash: record.messageHash });
                }
                else {
                    await this.handleConsensus(currentRecord);
                }
                // Don't call clearTransaction here - it happens in handleConsensus
                shouldPersist = false;
                break;
            case TransactionPhase.Rejected:
                log('cluster-member:action-rejected', {
                    messageHash: record.messageHash
                });
                // Don't call clearTransaction here - it happens in handleRejection
                await this.handleRejection(currentRecord);
                shouldPersist = false;
                break;
            case TransactionPhase.Propagating:
                // Transaction is complete and propagating - clean it up
                log('cluster-member:phase-propagating', {
                    messageHash: record.messageHash
                });
                shouldPersist = false;
                break;
            case TransactionPhase.Promising:
                // Still collecting promises from peers - if we haven't added ours and there's no conflict, add it
                // This state shouldn't normally be reached since OurPromiseNeeded is checked first
                log('cluster-member:phase-promising-blocked', {
                    messageHash: record.messageHash
                });
                break;
        }
        if (shouldPersist) {
            // Update transaction state
            const timeouts = this.setupTimeouts(currentRecord);
            this.activeTransactions.set(record.messageHash, {
                record: currentRecord,
                lastUpdate: Date.now(),
                promiseTimeout: timeouts.promiseTimeout,
                resolutionTimeout: timeouts.resolutionTimeout
            });
            this.persistParticipantState(record.messageHash, currentRecord);
            log('cluster-member:state-persist', {
                messageHash: record.messageHash,
                storedPromises: Object.keys(currentRecord.promises ?? {}),
                storedCommits: Object.keys(currentRecord.commits ?? {})
            });
        }
        else {
            log('cluster-member:state-clear', {
                messageHash: record.messageHash
            });
            this.clearTransaction(record.messageHash);
        }
        // Skip propagation - the coordinator manages distribution
        // await this.propagateIfNeeded(currentRecord);
        log('cluster-member:update-complete', {
            messageHash: record.messageHash,
            promiseCount: Object.keys(currentRecord.promises).length,
            commitCount: Object.keys(currentRecord.commits).length
        });
        return currentRecord;
    }
    /**
     * Merges two records, validating that non-signature fields match.
     * Detects equivocation (same peer changing vote type) and applies penalties.
     */
    async mergeRecords(existing, incoming) {
        log('cluster-member:merge-records', {
            messageHash: existing.messageHash,
            existingPromises: Object.keys(existing.promises ?? {}),
            existingCommits: Object.keys(existing.commits ?? {}),
            incomingPromises: Object.keys(incoming.promises ?? {}),
            incomingCommits: Object.keys(incoming.commits ?? {})
        });
        // Verify that immutable fields match
        if (existing.messageHash !== incoming.messageHash) {
            throw new Error('Message hash mismatch');
        }
        if (JSON.stringify(existing.message) !== JSON.stringify(incoming.message)) {
            throw new Error('Message content mismatch');
        }
        if (JSON.stringify(existing.peers) !== JSON.stringify(incoming.peers)) {
            throw new Error('Peers mismatch');
        }
        // Merge signatures with equivocation detection
        const mergedPromises = this.detectEquivocation(existing.promises, incoming.promises, 'promise', existing.messageHash);
        const mergedCommits = this.detectEquivocation(existing.commits, incoming.commits, 'commit', existing.messageHash);
        return {
            ...existing,
            promises: mergedPromises,
            commits: mergedCommits
        };
    }
    /**
     * Compares existing vs incoming signatures for the same peers.
     * If a peer's vote type changed (approve↔reject), that's equivocation:
     * report a penalty and keep the first-seen signature.
     * New peers are accepted normally.
     */
    detectEquivocation(existing, incoming, phase, messageHash) {
        const merged = { ...existing };
        for (const [peerId, incomingSig] of Object.entries(incoming)) {
            const existingSig = existing[peerId];
            if (existingSig) {
                if (existingSig.type !== incomingSig.type) {
                    // Equivocation detected: peer changed their vote type
                    log('cluster-member:equivocation-detected', {
                        peerId,
                        phase,
                        messageHash,
                        existingType: existingSig.type,
                        incomingType: incomingSig.type
                    });
                    this.reputation?.reportPeer(peerId, PenaltyReason.Equivocation, `${phase}:${messageHash}:${existingSig.type}->${incomingSig.type}`);
                    // Keep first-seen signature — do not let the peer flip their vote
                }
                // Same type: keep existing (no-op, already in merged)
            }
            else {
                // New peer — accept normally
                merged[peerId] = incomingSig;
            }
        }
        return merged;
    }
    async validateRecord(record) {
        // Validate message hash matches the message content
        const expectedHash = await this.computeMessageHash(record.message);
        if (expectedHash !== record.messageHash) {
            throw new Error(`Message hash mismatch: expected=${expectedHash}, received=${record.messageHash}`);
        }
        // Validate signatures
        await this.validateSignatures(record);
        // Validate expiration
        if (record.message.expiration && record.message.expiration < Date.now()) {
            throw new Error('Transaction expired');
        }
    }
    /**
     * Compute message hash using the same algorithm as the coordinator.
     * Must match cluster-coordinator.ts createMessageHash().
     */
    async computeMessageHash(message) {
        const msgBytes = new TextEncoder().encode(ClusterMember.canonicalJson(message));
        const hashBytes = await sha256.digest(msgBytes);
        return base58btc.encode(hashBytes.digest);
    }
    async validateSignatures(record) {
        this.currentValidationRecord = record;
        try {
            // Validate promise signatures
            const promiseHash = await this.computePromiseHash(record);
            for (const [peerId, signature] of Object.entries(record.promises)) {
                if (!await this.verifySignature(peerId, promiseHash, signature)) {
                    this.reputation?.reportPeer(peerId, PenaltyReason.InvalidSignature, `promise:${record.messageHash}`);
                    throw new Error(`Invalid promise signature from ${peerId}`);
                }
            }
            // Validate commit signatures
            const commitHash = await this.computeCommitHash(record);
            for (const [peerId, signature] of Object.entries(record.commits)) {
                if (!await this.verifySignature(peerId, commitHash, signature)) {
                    this.reputation?.reportPeer(peerId, PenaltyReason.InvalidSignature, `commit:${record.messageHash}`);
                    throw new Error(`Invalid commit signature from ${peerId}`);
                }
            }
        }
        finally {
            this.currentValidationRecord = undefined;
        }
    }
    /** Deterministic JSON: sorts object keys so hash is order-independent */
    static canonicalJson(value) {
        return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
            ? Object.keys(v).sort().reduce((o, k) => { o[k] = v[k]; return o; }, {})
            : v);
    }
    async computePromiseHash(record) {
        const msgBytes = new TextEncoder().encode(record.messageHash + ClusterMember.canonicalJson(record.message));
        const hashBytes = await sha256.digest(msgBytes);
        return uint8ArrayToString(hashBytes.digest, 'base64url');
    }
    async computeCommitHash(record) {
        const msgBytes = new TextEncoder().encode(record.messageHash + ClusterMember.canonicalJson(record.message) + ClusterMember.canonicalJson(record.promises));
        const hashBytes = await sha256.digest(msgBytes);
        return uint8ArrayToString(hashBytes.digest, 'base64url');
    }
    computeSigningPayload(hash, type, rejectReason) {
        const payload = hash + ':' + type + (rejectReason ? ':' + rejectReason : '');
        return new TextEncoder().encode(payload);
    }
    async signVote(hash, type, rejectReason) {
        const payload = this.computeSigningPayload(hash, type, rejectReason);
        const sigBytes = await this.privateKey.sign(payload);
        return uint8ArrayToString(sigBytes, 'base64url');
    }
    async verifySignature(peerId, hash, signature) {
        const peerInfo = this.currentValidationRecord?.peers[peerId];
        if (!peerInfo?.publicKey?.length) {
            throw new Error(`No public key for peer ${peerId}`);
        }
        // publicKey is base64url-encoded string (JSON-serialization safe)
        const keyBytes = uint8ArrayFromString(peerInfo.publicKey, 'base64url');
        const pubKey = publicKeyFromRaw(keyBytes);
        const payload = this.computeSigningPayload(hash, signature.type, signature.rejectReason);
        const sigBytes = uint8ArrayFromString(signature.signature, 'base64url');
        return pubKey.verify(payload, sigBytes);
    }
    async getTransactionPhase(record) {
        const peerCount = Object.keys(record.peers).length;
        const promiseCount = Object.keys(record.promises).length;
        const ourId = this.peerId.toString();
        const superMajority = Math.ceil(peerCount * this.superMajorityThreshold);
        const maxAllowedRejections = peerCount - superMajority;
        // Check for rejections — rejected if too many rejections to ever reach super-majority
        const rejectedPromises = Object.values(record.promises).filter(s => s.type === 'reject');
        const rejectedCommits = Object.values(record.commits).filter(s => s.type === 'reject');
        if (rejectedPromises.length > maxAllowedRejections || this.hasMajority(rejectedCommits.length, peerCount)) {
            return TransactionPhase.Rejected;
        }
        // Check if we need to promise
        if (!record.promises[ourId] && !this.hasConflict(record)) {
            return TransactionPhase.OurPromiseNeeded;
        }
        // Check if we have enough approved promises to proceed to commit
        const approvedPromises = Object.values(record.promises).filter(s => s.type === 'approve');
        if (approvedPromises.length >= superMajority && !record.commits[ourId]) {
            return TransactionPhase.OurCommitNeeded;
        }
        // Check if still collecting promises
        if (promiseCount < peerCount && approvedPromises.length < superMajority) {
            return TransactionPhase.Promising;
        }
        // Check for consensus
        const approvedCommits = Object.values(record.commits).filter(s => s.type === 'approve');
        if (this.hasMajority(approvedCommits.length, peerCount)) {
            return TransactionPhase.Consensus;
        }
        return TransactionPhase.Propagating;
    }
    hasMajority(count, total) {
        return count > total / 2;
    }
    async handlePromiseNeeded(record) {
        // Validate pend operations if we have a validator
        const validationResult = await this.validatePendOperations(record);
        const promiseHash = await this.computePromiseHash(record);
        const type = validationResult.valid ? 'approve' : 'reject';
        const rejectReason = validationResult.valid ? undefined : validationResult.reason;
        const sig = await this.signVote(promiseHash, type, rejectReason);
        const signature = validationResult.valid
            ? { type: 'approve', signature: sig }
            : { type: 'reject', signature: sig, rejectReason };
        if (!validationResult.valid) {
            log('cluster-member:validation-rejected', {
                messageHash: record.messageHash,
                reason: validationResult.reason
            });
        }
        return {
            ...record,
            promises: {
                ...record.promises,
                [this.peerId.toString()]: signature
            }
        };
    }
    /**
     * Validates pend operations in a cluster record using the transaction validator.
     * Also checks for stale revisions to prevent consensus on operations that would fail.
     * Returns success if no validator is configured (backwards compatibility).
     */
    async validatePendOperations(record) {
        // Find pend operations in the message
        for (const operation of record.message.operations) {
            if ('pend' in operation) {
                const pendRequest = operation.pend;
                // Check for stale revisions before allowing consensus
                if (pendRequest.rev !== undefined) {
                    const blockIds = blockIdsForTransforms(pendRequest.transforms);
                    // 38-04 (P2P-09 diagnose-first, captured on-device 2026-07-07): the
                    // staleness read below throws "Failed to find materialized block <id>
                    // for revision N" (BlockStorage.materializeBlock) when a cohort member
                    // has no locally-materialized content for the block — the expected state
                    // for a NEW block being created via distributed consensus. That throw
                    // propagated up through cluster.update() to ClusterService and was
                    // converted into a contentless StreamResetError ("The stream has been
                    // reset") the initiating peer observed, hanging the whole consensus round.
                    // Staleness detection is a local optimization: a member that cannot
                    // read its own block state simply cannot determine staleness, so it must
                    // DEFER to normal validation/consensus rather than crash the stream.
                    // Surface the real error to the drone log (not swallowed), then continue.
                    try {
                        // Get block states to check latest revisions
                        const blockResults = await this.storageRepo.get({ blockIds });
                        for (const blockId of blockIds) {
                            const blockResult = blockResults[blockId];
                            const latestRev = blockResult?.state?.latest?.rev;
                            if (latestRev !== undefined && latestRev >= pendRequest.rev) {
                                log('cluster-member:validation-stale-revision', {
                                    messageHash: record.messageHash,
                                    blockId,
                                    requestedRev: pendRequest.rev,
                                    latestRev
                                });
                                return { valid: false, reason: `stale revision: block ${blockId} at rev ${latestRev}, requested rev ${pendRequest.rev}` };
                            }
                        }
                    }
                    catch (err) {
                        // No locally-materialized state to compare against — cannot determine
                        // staleness locally. Do NOT fail consensus on this basis; defer to the
                        // custom validator below. Fail-safe: worst case is an extra approval
                        // that the validator/quorum still gates (consensus SAFETY preserved).
                        log('cluster-member:staleness-check-unavailable', {
                            messageHash: record.messageHash,
                            blockIds,
                            requestedRev: pendRequest.rev,
                            error: err instanceof Error ? err.message : String(err)
                        });
                    }
                }
                // Run custom validator if configured
                if (this.validator && pendRequest.transaction && pendRequest.operationsHash) {
                    const result = await this.validator.validate(pendRequest.transaction, pendRequest.operationsHash);
                    if (!result.valid) {
                        return { valid: false, reason: result.reason };
                    }
                }
            }
        }
        return { valid: true };
    }
    async handleCommitNeeded(record) {
        if (this.hasLocalCommit(record)) {
            return record;
        }
        const commitHash = await this.computeCommitHash(record);
        const sig = await this.signVote(commitHash, 'approve');
        const signature = {
            type: 'approve',
            signature: sig
        };
        return {
            ...record,
            commits: {
                ...record.commits,
                [this.peerId.toString()]: signature
            }
        };
    }
    /**
     * Executes operations after consensus is reached.
     *
     * @warning This method executes on ALL cluster peers, not just the coordinator.
     * Each peer independently applies the operations to its local storage.
     *
     * @pitfall **Check-then-act race** - Must check AND mark as executed atomically
     * (before any `await`) to prevent duplicate execution. JavaScript's single-threaded
     * nature makes synchronous check-and-set atomic.
     *
     * @pitfall **Independent node storage** - Each node has its own storage. After consensus,
     * each node applies operations locally. Nodes must fetch missing blocks from cluster
     * peers via `restoreCallback` if they don't have prior revisions.
     *
     * @see docs/internals.md "Check-Then-Act Race in Consensus" and "Independent Node Storage" pitfalls
     */
    async handleConsensus(record) {
        // Check-and-set ATOMICALLY to prevent race condition where multiple calls
        // pass the check before any completes. Since JavaScript is single-threaded,
        // this synchronous check-and-set is atomic before any await.
        if (this.executedTransactions.has(record.messageHash)) {
            log('cluster-member:consensus-already-executed', { messageHash: record.messageHash });
            return;
        }
        // Mark as executing IMMEDIATELY before any async operations
        const executedAt = Date.now();
        this.executedTransactions.set(record.messageHash, executedAt);
        this.stateStore?.markExecuted(record.messageHash, executedAt)
            .catch(err => log('cluster-member:persist-executed-error', { messageHash: record.messageHash, error: err.message }));
        try {
            // Execute the operations - check return values for failures
            for (const operation of record.message.operations) {
                if ('get' in operation) {
                    await this.storageRepo.get(operation.get);
                }
                else if ('pend' in operation) {
                    const result = await this.storageRepo.pend(operation.pend);
                    if (!result.success) {
                        // 38-10 (P2P-11 stale-revision/pend-race, diagnosed in
                        // 38-10-CONSENSUS-DIAGNOSIS.md): StorageRepo.pend() returns
                        // { success:false } WITHOUT a `reason` in two distinct cases,
                        // which the old `?? 'stale revision'` default collapsed into one
                        // mislabeled throw (308 occurrences in the 38-08 n=4 capture):
                        //   (a) result.missing — a GENUINE stale/conflicting prior revision
                        //       exists (storage-repo.js latest.rev>=request.rev path). This
                        //       is a real safety rejection and MUST still throw (T-38-10-01).
                        //   (b) result.pending — a pending action already exists for one of
                        //       the blocks. On a consensus RETRY (coordinator-repo.js in-line
                        //       + scheduled retries re-deliver the identical record; and this
                        //       method's own catch below un-marks executedTransactions "so it
                        //       can be retried"), that pending entry can be THIS EXACT action's
                        //       own prior partial pend — an idempotent self-pend, not a real
                        //       conflict. StorageRepo.commit() already recognizes the parallel
                        //       idempotent case (latest.actionId===request.actionId "already
                        //       done, skip"); pend() never did. Narrowly relax ONLY that case:
                        //       every reported pending entry belongs to this same actionId AND
                        //       there is no `missing` (no genuine stale revision). Any pending
                        //       entry for a DIFFERENT actionId, or any `missing`, still throws —
                        //       consensus SAFETY and the super-majority quorum gate preserved.
                        const isIdempotentSelfPend = !result.missing?.length
                            && !!result.pending?.length
                            && result.pending.every(p => p.actionId === operation.pend.actionId);
                        if (isIdempotentSelfPend) {
                            log('cluster-member:consensus-pend-idempotent-self', {
                                messageHash: record.messageHash,
                                actionId: operation.pend.actionId,
                                pendingCount: result.pending.length
                            });
                            // Treat as already-pended for this consensus round — do NOT throw;
                            // the pending transform this action saved on a prior attempt stands,
                            // so the later commit-phase precondition (a pending action exists for
                            // this actionId) is satisfied. Continue to the next operation.
                            continue;
                        }
                        log('cluster-member:consensus-pend-failed', {
                            messageHash: record.messageHash,
                            actionId: operation.pend.actionId,
                            reason: result.reason,
                            hasMissing: !!result.missing?.length,
                            hasPending: !!result.pending?.length
                        });
                        throw new Error(`Consensus pend failed for action ${operation.pend.actionId}: ${result.reason ?? 'stale revision'}`);
                    }
                }
                else if ('commit' in operation) {
                    const result = await this.storageRepo.commit(operation.commit);
                    if (!result.success) {
                        log('cluster-member:consensus-commit-failed', {
                            messageHash: record.messageHash,
                            actionId: operation.commit.actionId,
                            reason: result.reason,
                            hasMissing: !!result.missing?.length
                        });
                        throw new Error(`Consensus commit failed for action ${operation.commit.actionId}: ${result.reason ?? 'stale revision'}`);
                    }
                }
                else if ('cancel' in operation) {
                    await this.storageRepo.cancel(operation.cancel.actionRef);
                }
            }
        }
        catch (err) {
            // On failure, remove from executedTransactions so it can be retried
            this.executedTransactions.delete(record.messageHash);
            throw err;
        }
    }
    async handleRejection(_record) {
        // Clean up any resources - will be cleared by shouldPersist = false in the main flow
    }
    setupTimeouts(record) {
        if (!record.message.expiration) {
            return {};
        }
        return {
            promiseTimeout: setTimeout(() => this.handleExpiration(record.messageHash), record.message.expiration - Date.now()).unref(),
            resolutionTimeout: setTimeout(() => this.resolveWithPeers(record.messageHash), record.message.expiration + 5000 - Date.now()).unref()
        };
    }
    hasConflict(record) {
        const now = Date.now();
        const staleThresholdMs = 2000; // 2 seconds - allow more time for distributed consensus
        const incomingBlockIds = this.getAffectedBlockIds(record.message.operations);
        log('cluster-member:hasConflict-check', {
            messageHash: record.messageHash,
            activeCount: this.activeTransactions.size,
            incomingBlockIds
        });
        for (const [existingHash, state] of Array.from(this.activeTransactions.entries())) {
            if (existingHash === record.messageHash) {
                continue;
            }
            const existingBlockIds = this.getAffectedBlockIds(state.record.message.operations);
            log('cluster-member:hasConflict-compare', {
                existing: existingHash,
                incoming: record.messageHash,
                existingBlockIds,
                incomingBlockIds
            });
            // Clean up stale transactions that have been around too long
            if (now - state.lastUpdate > staleThresholdMs) {
                log('cluster-member:stale-cleanup', {
                    messageHash: existingHash,
                    age: now - state.lastUpdate
                });
                this.clearTransaction(existingHash);
                continue;
            }
            if (this.operationsConflict(state.record.message.operations, record.message.operations)) {
                // Use race resolution to determine winner
                const resolution = this.resolveRace(state.record, record);
                if (resolution === 'keep-existing') {
                    log('cluster-member:race-keep-existing', {
                        existing: existingHash,
                        incoming: record.messageHash
                    });
                    return true; // Reject incoming
                }
                else {
                    // Accept incoming, abort existing
                    log('cluster-member:race-accept-incoming', {
                        existing: existingHash,
                        incoming: record.messageHash
                    });
                    this.clearTransaction(existingHash);
                    continue; // Check other conflicts
                }
            }
        }
        return false; // No blocking conflicts
    }
    /**
     * Resolve race between two conflicting transactions.
     * Transaction with more promises wins. If tied, higher hash wins.
     */
    resolveRace(existing, incoming) {
        const existingCount = Object.keys(existing.promises).length;
        const incomingCount = Object.keys(incoming.promises).length;
        // Transaction with more promises wins
        if (existingCount > incomingCount) {
            return 'keep-existing';
        }
        if (incomingCount > existingCount) {
            return 'accept-incoming';
        }
        // Tie-breaker: higher message hash wins (deterministic)
        return existing.messageHash > incoming.messageHash ? 'keep-existing' : 'accept-incoming';
    }
    operationsConflict(ops1, ops2) {
        // Check if one is a commit for the same action as a pend - these don't conflict
        const actionId1 = this.getActionId(ops1);
        const actionId2 = this.getActionId(ops2);
        if (actionId1 && actionId2 && actionId1 === actionId2) {
            // Same action - commit is resolving the pend, not conflicting
            return false;
        }
        const blocks1 = new Set(this.getAffectedBlockIds(ops1));
        const blocks2 = new Set(this.getAffectedBlockIds(ops2));
        for (const block of Array.from(blocks1)) {
            if (blocks2.has(block)) {
                log('cluster-member:conflict-detected', {
                    blocks1: Array.from(blocks1),
                    blocks2: Array.from(blocks2),
                    conflictingBlock: block
                });
                return true;
            }
        }
        return false;
    }
    getActionId(operations) {
        for (const operation of operations) {
            if ('pend' in operation) {
                return operation.pend.actionId;
            }
            else if ('commit' in operation) {
                return operation.commit.actionId;
            }
            else if ('cancel' in operation) {
                return operation.cancel.actionRef.actionId;
            }
        }
        return undefined;
    }
    getAffectedBlockIds(operations) {
        const blockIds = new Set();
        for (const operation of operations) {
            if ('get' in operation) {
                operation.get.blockIds.forEach(id => blockIds.add(id));
            }
            else if ('pend' in operation) {
                // Use blockIdsForTransforms to correctly extract block IDs from Transforms structure
                blockIdsForTransforms(operation.pend.transforms).forEach(id => blockIds.add(id));
            }
            else if ('commit' in operation) {
                operation.commit.blockIds.forEach(id => blockIds.add(id));
            }
            else if ('cancel' in operation) {
                operation.cancel.actionRef.blockIds.forEach(id => blockIds.add(id));
            }
        }
        return Array.from(blockIds);
    }
    async propagateIfNeeded(record) {
        const promises = [];
        for (const peerId of Object.keys(record.peers)) {
            if (peerId === this.peerId.toString())
                continue;
            try {
                const client = ClusterClient.create(peerIdFromString(peerId), this.peerNetwork, this.protocolPrefix);
                promises.push(client.update(record));
            }
            catch (error) {
                console.error(`Failed to propagate to peer ${peerId}:`, error);
            }
        }
        await Promise.allSettled(promises);
    }
    async handleExpiration(messageHash) {
        const state = this.activeTransactions.get(messageHash);
        if (!state)
            return;
        if (!state.record.promises[this.peerId.toString()]) {
            const rejectReason = 'Transaction expired';
            const promiseHash = await this.computePromiseHash(state.record);
            const sig = await this.signVote(promiseHash, 'reject', rejectReason);
            const signature = {
                type: 'reject',
                signature: sig,
                rejectReason
            };
            const updatedRecord = {
                ...state.record,
                promises: {
                    ...state.record.promises,
                    [this.peerId.toString()]: signature
                }
            };
            this.activeTransactions.set(messageHash, {
                ...state,
                record: updatedRecord
            });
            await this.propagateIfNeeded(updatedRecord);
        }
    }
    async resolveWithPeers(messageHash) {
        // This method is disabled - the coordinator handles all retry logic
        // Keeping the skeleton in case we need peer-initiated recovery in the future
        log('cluster-member:resolve-skipped', { messageHash, reason: 'coordinator-handles-retry' });
    }
    queueExpiredTransactions() {
        const now = Date.now();
        for (const [messageHash, state] of Array.from(this.activeTransactions.entries())) {
            if (state.record.message.expiration && state.record.message.expiration < now) {
                this.cleanupQueue.push(messageHash);
            }
        }
        // Also clean up old executed transaction records
        const expirationThreshold = now - ExecutedTransactionTtlMs;
        for (const [messageHash, executedAt] of Array.from(this.executedTransactions.entries())) {
            if (executedAt < expirationThreshold) {
                this.executedTransactions.delete(messageHash);
            }
        }
        this.stateStore?.pruneExecuted(expirationThreshold)
            .catch(err => log('cluster-member:prune-executed-error', { error: err.message }));
    }
    async processCleanupQueue() {
        while (this.cleanupQueue.length > 0) {
            const messageHash = this.cleanupQueue.shift();
            if (!messageHash)
                continue;
            const state = this.activeTransactions.get(messageHash);
            if (!state)
                continue;
            const phase = await this.getTransactionPhase(state.record);
            if (phase !== TransactionPhase.Consensus && phase !== TransactionPhase.Rejected) {
                this.activeTransactions.delete(messageHash);
            }
        }
    }
    hasLocalCommit(record) {
        const ourId = this.peerId.toString();
        return Boolean(record.commits[ourId]);
    }
    clearTransaction(messageHash) {
        const state = this.activeTransactions.get(messageHash);
        if (!state) {
            log('cluster-member:clear-miss', { messageHash });
            return;
        }
        if (state.promiseTimeout) {
            clearTimeout(state.promiseTimeout);
        }
        if (state.resolutionTimeout) {
            clearTimeout(state.resolutionTimeout);
        }
        this.activeTransactions.delete(messageHash);
        this.stateStore?.deleteParticipantState(messageHash)
            .catch(err => log('cluster-member:persist-delete-error', { messageHash, error: err.message }));
        log('cluster-member:clear-done', {
            messageHash,
            remaining: Array.from(this.activeTransactions.keys())
        });
    }
    /** Fire-and-forget persist — errors are logged, never thrown. */
    persistParticipantState(messageHash, record) {
        if (!this.stateStore)
            return;
        this.stateStore.saveParticipantState(messageHash, {
            messageHash,
            record,
            lastUpdate: Date.now()
        }).catch(err => log('cluster-member:persist-error', { messageHash, error: err.message }));
    }
    /**
     * Recover member transactions from persistent store after a restart.
     * Called during node startup, before accepting new requests.
     */
    async recoverTransactions() {
        if (!this.stateStore)
            return;
        const now = Date.now();
        // 1. Prune expired executed entries from persistent store
        await this.stateStore.pruneExecuted(now - ExecutedTransactionTtlMs);
        // Note: executed transactions are checked via wasTransactionExecutedAsync() at runtime,
        // which falls back to the persistent store when the in-memory map misses.
        // 2. Restore active participant states
        const participantStates = await this.stateStore.getAllParticipantStates();
        for (const state of participantStates) {
            const { messageHash } = state;
            // Expired — clean up
            if (state.record.message.expiration && state.record.message.expiration < now) {
                log('cluster-member:recovery-expired', { messageHash });
                await this.stateStore.deleteParticipantState(messageHash);
                continue;
            }
            // Restore into activeTransactions with fresh timeouts
            log('cluster-member:recovery-restore', { messageHash });
            const timeouts = this.setupTimeouts(state.record);
            this.activeTransactions.set(messageHash, {
                record: state.record,
                lastUpdate: state.lastUpdate,
                promiseTimeout: timeouts.promiseTimeout,
                resolutionTimeout: timeouts.resolutionTimeout
            });
        }
        log('cluster-member:recovery-complete', {
            restoredActive: this.activeTransactions.size,
            restoredExecuted: this.executedTransactions.size
        });
    }
    /**
     * Checks if a transaction's operations were already executed during consensus.
     * Falls back to the persistent store when the in-memory map misses.
     */
    async wasTransactionExecutedAsync(messageHash) {
        if (this.executedTransactions.has(messageHash))
            return true;
        if (!this.stateStore)
            return false;
        const persisted = await this.stateStore.wasExecuted(messageHash);
        if (persisted) {
            // Re-populate in-memory map for future synchronous checks
            this.executedTransactions.set(messageHash, Date.now());
        }
        return persisted;
    }
}
//# sourceMappingURL=cluster-repo.js.map