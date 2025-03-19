import type { IRepo, ClusterRecord, Signature, RepoMessage } from "@votetorrent/db-core";
import type { ICluster } from "@votetorrent/db-core";
import type { IPeerNetwork } from "@votetorrent/db-core";
import { ClusterClient } from "./client.js";
import type { PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { sha256 } from "multiformats/hashes/sha2";
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

/** State of a transaction in the cluster */
enum TransactionPhase {
    Promising,       // Collecting promises from peers
    OurPromiseNeeded, // We need to provide our promise
    OurCommitNeeded, // We need to provide our commit
    Consensus,       // Transaction has reached consensus
    Rejected,        // Transaction was rejected
    Propagating     // Transaction is being propagated
}

interface TransactionState {
    record: ClusterRecord;
    promiseTimeout?: NodeJS.Timeout;
    resolutionTimeout?: NodeJS.Timeout;
    lastUpdate: number;
}

interface ClusterMemberComponents {
    storageRepo: IRepo;
    peerNetwork: IPeerNetwork;
    peerId: PeerId;
}

export function clusterMember(components: ClusterMemberComponents): ClusterMember {
    return new ClusterMember(components.storageRepo, components.peerNetwork, components.peerId);
}

/**
 * Handles cluster-side operations, managing promises and commits for cluster updates
 * and coordinating with the local storage repo.
 */
export class ClusterMember implements ICluster {
    // Track active transactions by their message hash
    private activeTransactions: Map<string, TransactionState> = new Map();
    // Queue of transactions to clean up
    private cleanupQueue: string[] = [];

    constructor(
        private readonly storageRepo: IRepo,
        private readonly peerNetwork: IPeerNetwork,
        private readonly peerId: PeerId
    ) {
        // Periodically clean up expired transactions
        setInterval(() => this.queueExpiredTransactions(), 60000);
        // Process cleanup queue
        setInterval(() => this.processCleanupQueue(), 1000);
    }

    /**
     * Handles an incoming cluster update, managing the two-phase commit process
     * and coordinating with the local storage repo
     */
    async update(record: ClusterRecord): Promise<ClusterRecord> {
        // Validate the incoming record
        await this.validateRecord(record);

        const existingState = this.activeTransactions.get(record.messageHash);
        let currentRecord = existingState?.record || record;

        // If we have an existing record, merge the signatures
        if (existingState) {
            currentRecord = await this.mergeRecords(existingState.record, record);
        }

        // Get the current transaction state
        const phase = await this.getTransactionPhase(currentRecord);

        // Handle the transaction based on its state
        switch (phase) {
            case TransactionPhase.OurPromiseNeeded:
                currentRecord = await this.handlePromiseNeeded(currentRecord);
                break;
            case TransactionPhase.OurCommitNeeded:
                currentRecord = await this.handleCommitNeeded(currentRecord);
                break;
            case TransactionPhase.Consensus:
                await this.handleConsensus(currentRecord);
                break;
            case TransactionPhase.Rejected:
                await this.handleRejection(currentRecord);
                break;
        }

        // Update transaction state
        const timeouts = this.setupTimeouts(currentRecord);
        this.activeTransactions.set(record.messageHash, {
            record: currentRecord,
            lastUpdate: Date.now(),
            promiseTimeout: timeouts.promiseTimeout,
            resolutionTimeout: timeouts.resolutionTimeout
        });

        // Propagate updates to peers if needed
        await this.propagateIfNeeded(currentRecord);

        return currentRecord;
    }

    /**
     * Merges two records, validating that non-signature fields match
     */
    private async mergeRecords(existing: ClusterRecord, incoming: ClusterRecord): Promise<ClusterRecord> {
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

        // Merge signatures, keeping the most recent valid ones
        return {
            ...existing,
            promises: { ...existing.promises, ...incoming.promises },
            commits: { ...existing.commits, ...incoming.commits }
        };
    }

    private async validateRecord(record: ClusterRecord): Promise<void> {
        // Validate message hash
        const computedHash = await this.computeMessageHash(record);
        if (computedHash !== record.messageHash) {
            throw new Error('Invalid message hash');
        }

        // Validate signatures
        await this.validateSignatures(record);

        // Validate expiration
        if (record.message.expiration && record.message.expiration < Date.now()) {
            throw new Error('Transaction expired');
        }
    }

    private async computeMessageHash(record: ClusterRecord): Promise<string> {
        const msgBytes = new TextEncoder().encode(record.messageHash + JSON.stringify(record.message));
        const hashBytes = await sha256.digest(msgBytes);
        return uint8ArrayToString(hashBytes.digest, 'base64url');
    }

    private async validateSignatures(record: ClusterRecord): Promise<void> {
        // Validate promise signatures
        const promiseHash = await this.computePromiseHash(record);
        for (const [peerId, signature] of Object.entries(record.promises)) {
            if (!await this.verifySignature(peerId, promiseHash, signature)) {
                throw new Error(`Invalid promise signature from ${peerId}`);
            }
        }

        // Validate commit signatures
        const commitHash = await this.computeCommitHash(record);
        for (const [peerId, signature] of Object.entries(record.commits)) {
            if (!await this.verifySignature(peerId, commitHash, signature)) {
                throw new Error(`Invalid commit signature from ${peerId}`);
            }
        }
    }

    private async computePromiseHash(record: ClusterRecord): Promise<string> {
        const msgBytes = new TextEncoder().encode(record.messageHash + JSON.stringify(record.message));
        const hashBytes = await sha256.digest(msgBytes);
        return uint8ArrayToString(hashBytes.digest, 'base64url');
    }

    private async computeCommitHash(record: ClusterRecord): Promise<string> {
        const msgBytes = new TextEncoder().encode(record.messageHash + JSON.stringify(record.message) + JSON.stringify(record.promises));
        const hashBytes = await sha256.digest(msgBytes);
        return uint8ArrayToString(hashBytes.digest, 'base64url');
    }

    private async verifySignature(peerId: string, hash: string, signature: Signature): Promise<boolean> {
        // TODO: Implement actual signature verification
        return true;
    }

    private async getTransactionPhase(record: ClusterRecord): Promise<TransactionPhase> {
        const peerCount = Object.keys(record.peers).length;
        const promiseCount = Object.keys(record.promises).length;
        const commitCount = Object.keys(record.commits).length;
        const ourId = this.peerId.toString();

        // Check for rejections
        const rejectedPromises = Object.values(record.promises).filter(s => s.type === 'reject');
        const rejectedCommits = Object.values(record.commits).filter(s => s.type === 'reject');
        if (rejectedPromises.length > 0 || this.hasMajority(rejectedCommits.length, peerCount)) {
            return TransactionPhase.Rejected;
        }

        // Check if we need to promise
        if (!record.promises[ourId] && !this.hasConflict(record)) {
            return TransactionPhase.OurPromiseNeeded;
        }

        // Check if still collecting promises
        if (promiseCount < peerCount) {
            return TransactionPhase.Promising;
        }

        // Check if we need to commit
        if (promiseCount === peerCount && !record.commits[ourId]) {
            return TransactionPhase.OurCommitNeeded;
        }

        // Check for consensus
        const approvedCommits = Object.values(record.commits).filter(s => s.type === 'approve');
        if (this.hasMajority(approvedCommits.length, peerCount)) {
            return TransactionPhase.Consensus;
        }

        return TransactionPhase.Propagating;
    }

    private hasMajority(count: number, total: number): boolean {
        return count > total / 2;
    }

    private async handlePromiseNeeded(record: ClusterRecord): Promise<ClusterRecord> {
        const signature: Signature = {
            type: 'approve',
            signature: 'approved' // TODO: Actually sign the promise hash
        };

        return {
            ...record,
            promises: {
                ...record.promises,
                [this.peerId.toString()]: signature
            }
        };
    }

    private async handleCommitNeeded(record: ClusterRecord): Promise<ClusterRecord> {
        const signature: Signature = {
            type: 'approve',
            signature: 'committed' // TODO: Actually sign the commit hash
        };

        return {
            ...record,
            commits: {
                ...record.commits,
                [this.peerId.toString()]: signature
            }
        };
    }

    private async handleConsensus(record: ClusterRecord): Promise<void> {
        // Execute the operations only if we haven't already
        const state = this.activeTransactions.get(record.messageHash);
        if (!state?.record.commits[this.peerId.toString()]) {
            for (const operation of record.message.operations) {
                if ('get' in operation) {
                    await this.storageRepo.get(operation.get);
                } else if ('pend' in operation) {
                    await this.storageRepo.pend(operation.pend);
                } else if ('commit' in operation) {
                    await this.storageRepo.commit(operation.commit);
                } else if ('cancel' in operation) {
                    await this.storageRepo.cancel(operation.cancel.trxRef);
                }
            }
        }
    }

    private async handleRejection(record: ClusterRecord): Promise<void> {
        // Clean up any resources
        this.activeTransactions.delete(record.messageHash);
    }

    private setupTimeouts(record: ClusterRecord): { promiseTimeout?: NodeJS.Timeout; resolutionTimeout?: NodeJS.Timeout } {
        if (!record.message.expiration) {
            return {};
        }

        return {
            promiseTimeout: setTimeout(
                () => this.handleExpiration(record.messageHash),
                record.message.expiration - Date.now()
            ),
            resolutionTimeout: setTimeout(
                () => this.resolveWithPeers(record.messageHash),
                record.message.expiration + 5000 - Date.now()
            )
        };
    }

    private hasConflict(record: ClusterRecord): boolean {
        for (const [_, state] of this.activeTransactions) {
            if (this.operationsConflict(state.record.message.operations, record.message.operations)) {
                return true;
            }
        }
        return false;
    }

    private operationsConflict(ops1: RepoMessage['operations'], ops2: RepoMessage['operations']): boolean {
        const blocks1 = new Set(this.getAffectedBlockIds(ops1));
        const blocks2 = new Set(this.getAffectedBlockIds(ops2));

        for (const block of blocks1) {
            if (blocks2.has(block)) return true;
        }

        return false;
    }

    private getAffectedBlockIds(operations: RepoMessage['operations']): string[] {
        const blockIds = new Set<string>();

        for (const operation of operations) {
            if ('get' in operation) {
                operation.get.blockIds.forEach(id => blockIds.add(id));
            } else if ('pend' in operation) {
                Object.keys(operation.pend.transforms).forEach(id => blockIds.add(id));
            } else if ('commit' in operation) {
                operation.commit.blockIds.forEach(id => blockIds.add(id));
            } else if ('cancel' in operation) {
                Object.keys(operation.cancel.trxRef).forEach(id => blockIds.add(id));
            }
        }

        return Array.from(blockIds);
    }

    private async propagateIfNeeded(record: ClusterRecord): Promise<void> {
        const promises = [];
        for (const [peerId, peer] of Object.entries(record.peers)) {
            if (peerId === this.peerId.toString()) continue;

            try {
                const client = ClusterClient.create(peerIdFromString(peerId), this.peerNetwork);
                promises.push(client.update(record));
            } catch (error) {
                console.error(`Failed to propagate to peer ${peerId}:`, error);
            }
        }
        await Promise.allSettled(promises);
    }

    private async handleExpiration(messageHash: string): Promise<void> {
        const state = this.activeTransactions.get(messageHash);
        if (!state) return;

        if (!state.record.promises[this.peerId.toString()]) {
            const signature: Signature = {
                type: 'reject',
                signature: 'rejected',
                rejectReason: 'Transaction expired'
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

    private async resolveWithPeers(messageHash: string): Promise<void> {
        const state = this.activeTransactions.get(messageHash);
        if (!state || Object.keys(state.record.commits).length > 0) return;

        for (const [peerId, peer] of Object.entries(state.record.peers)) {
            if (peerId === this.peerId.toString()) continue;

            try {
                const client = ClusterClient.create(peerIdFromString(peerId), this.peerNetwork);
                const peerRecord = await client.update(state.record);

                if (Object.keys(peerRecord.commits).length > 0) {
                    const updatedRecord = await this.mergeRecords(state.record, peerRecord);

                    // If consensus reached, apply operations
                    const phase = await this.getTransactionPhase(updatedRecord);
                    if (phase === TransactionPhase.Consensus) {
                        await this.handleConsensus(updatedRecord);
                    }

                    this.activeTransactions.set(messageHash, {
                        ...state,
                        record: updatedRecord
                    });

                    await this.propagateIfNeeded(updatedRecord);
                    break;
                }
            } catch (error) {
                console.error(`Failed to resolve with peer ${peerId}:`, error);
            }
        }
    }

    private queueExpiredTransactions(): void {
        const now = Date.now();
        for (const [messageHash, state] of this.activeTransactions) {
            if (state.record.message.expiration && state.record.message.expiration < now) {
                this.cleanupQueue.push(messageHash);
            }
        }
    }

    private async processCleanupQueue(): Promise<void> {
        while (this.cleanupQueue.length > 0) {
            const messageHash = this.cleanupQueue.shift();
            if (!messageHash) continue;

            const state = this.activeTransactions.get(messageHash);
            if (!state) continue;

            const phase = await this.getTransactionPhase(state.record);
            if (phase !== TransactionPhase.Consensus && phase !== TransactionPhase.Rejected) {
                this.activeTransactions.delete(messageHash);
            }
        }
    }
}
