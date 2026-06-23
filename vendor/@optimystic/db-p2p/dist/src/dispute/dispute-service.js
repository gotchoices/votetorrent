import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { DEFAULT_DISPUTE_CONFIG } from './types.js';
import { EngineHealthMonitor } from './engine-health-monitor.js';
import { PenaltyReason } from '../reputation/types.js';
import { createLogger } from '../logger.js';
const log = createLogger('dispute');
/**
 * Manages the dispute escalation protocol.
 *
 * When a transaction proceeds despite minority rejections, the overridden
 * minority can escalate to independent arbitrators. The service coordinates
 * challenge initiation, arbitration vote collection, and resolution.
 */
export class DisputeService {
    peerId;
    privateKey;
    createDisputeClient;
    reputation;
    revalidate;
    config;
    engineHealth;
    selectArbitrators;
    /** Active disputes initiated by this node */
    activeDisputes = new Map();
    /** Resolved disputes (disputeId -> resolution) */
    resolvedDisputes = new Map();
    /** Challenges retained after resolution for status lookups */
    resolvedChallenges = new Map();
    /** Track which transactions we've already disputed (prevent spam) */
    disputedTransactions = new Set();
    constructor(init) {
        this.peerId = init.peerId;
        this.privateKey = init.privateKey;
        this.createDisputeClient = init.createDisputeClient;
        this.reputation = init.reputation;
        this.revalidate = init.revalidate;
        this.config = { ...DEFAULT_DISPUTE_CONFIG, ...init.config };
        this.engineHealth = new EngineHealthMonitor(this.config);
        this.selectArbitrators = init.selectArbitrators;
    }
    /** Get the engine health monitor */
    getEngineHealth() {
        return this.engineHealth;
    }
    /** Check if disputes are enabled */
    isEnabled() {
        return this.config.disputeEnabled;
    }
    /** Get the dispute status for a transaction, if any */
    getDisputeStatus(messageHash) {
        // Check if there's an active dispute for this transaction
        for (const [, challenge] of this.activeDisputes) {
            if (challenge.originalMessageHash === messageHash) {
                return 'committed-disputed';
            }
        }
        // Check resolved disputes
        for (const [, resolution] of this.resolvedDisputes) {
            const challenge = this.findChallengeForDispute(resolution.disputeId);
            if (challenge && challenge.originalMessageHash === messageHash) {
                if (resolution.outcome === 'challenger-wins')
                    return 'committed-invalidated';
                if (resolution.outcome === 'majority-wins')
                    return 'committed-validated';
                return 'committed-disputed'; // inconclusive
            }
        }
        return undefined;
    }
    /**
     * Initiate a dispute when this node's rejection was overridden.
     * Called by ClusterMember when it detects a disputed commit.
     */
    async initiateDispute(record, evidence) {
        if (!this.config.disputeEnabled) {
            log('dispute-disabled', { messageHash: record.messageHash });
            return undefined;
        }
        // One dispute per transaction
        if (this.disputedTransactions.has(record.messageHash)) {
            log('dispute-already-initiated', { messageHash: record.messageHash });
            return undefined;
        }
        // Don't dispute if our engine is unhealthy
        if (this.engineHealth.isUnhealthy()) {
            log('dispute-skipped-unhealthy', { messageHash: record.messageHash });
            return undefined;
        }
        this.disputedTransactions.add(record.messageHash);
        const timestamp = Date.now();
        const disputeId = await this.computeDisputeId(record.messageHash, this.peerId.toString(), timestamp);
        const signature = await this.signDispute(disputeId);
        const defaultTtl = record.message.expiration
            ? (record.message.expiration - Date.now()) * 2
            : this.config.disputeArbitrationTimeoutMs * 2;
        const expiration = timestamp + Math.max(defaultTtl, this.config.disputeArbitrationTimeoutMs);
        const challenge = {
            disputeId,
            originalMessageHash: record.messageHash,
            originalRecord: record,
            challengerPeerId: this.peerId.toString(),
            challengerEvidence: evidence,
            signature,
            timestamp,
            expiration,
        };
        this.activeDisputes.set(disputeId, challenge);
        log('dispute-initiated', { disputeId, messageHash: record.messageHash });
        // Select arbitrators and collect votes
        const blockIds = record.coordinatingBlockIds ?? [];
        const blockId = blockIds[0] ?? record.messageHash;
        const originalPeers = Object.keys(record.peers);
        const arbitratorCount = this.config.arbitratorCount ?? originalPeers.length;
        let arbitrators;
        try {
            arbitrators = await this.selectArbitrators(blockId, originalPeers, arbitratorCount);
        }
        catch (err) {
            log('dispute-arbitrator-selection-failed', { disputeId, error: err instanceof Error ? err.message : String(err) });
            this.activeDisputes.delete(disputeId);
            return undefined;
        }
        if (arbitrators.length === 0) {
            log('dispute-no-arbitrators', { disputeId });
            this.activeDisputes.delete(disputeId);
            return undefined;
        }
        // Send challenge to all arbitrators and collect votes
        const votes = await this.collectVotes(challenge, arbitrators);
        const resolution = this.resolveDispute(challenge, votes);
        this.resolvedChallenges.set(disputeId, challenge);
        this.activeDisputes.delete(disputeId);
        this.resolvedDisputes.set(disputeId, resolution);
        // Apply reputation effects
        this.applyReputationEffects(resolution, record);
        // Broadcast resolution
        await this.broadcastResolution(resolution, arbitrators, originalPeers);
        log('dispute-resolved', {
            disputeId,
            outcome: resolution.outcome,
            votes: votes.length,
            affectedPeers: resolution.affectedPeers.length,
        });
        return resolution;
    }
    /**
     * Handle an incoming dispute challenge (when this node is selected as arbitrator).
     * Re-executes the transaction and returns a vote.
     */
    async handleChallenge(challenge) {
        log('dispute-handle-challenge', { disputeId: challenge.disputeId });
        // Verify the challenge signature
        const validSignature = await this.verifyDisputeSignature(challenge.disputeId, challenge.signature, challenge.originalRecord.peers[challenge.challengerPeerId]?.publicKey);
        if (!validSignature) {
            log('dispute-invalid-challenge-signature', { disputeId: challenge.disputeId });
            return this.makeVote(challenge.disputeId, 'inconclusive', {
                computedHash: '',
                engineId: 'unknown',
                schemaHash: '',
                blockStateHashes: {},
            });
        }
        // Re-execute the transaction to produce our own evidence
        let evidence;
        if (this.revalidate) {
            try {
                evidence = await this.revalidate(challenge.originalRecord);
            }
            catch (err) {
                log('dispute-revalidation-failed', {
                    disputeId: challenge.disputeId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        if (!evidence) {
            // Can't re-execute — vote inconclusive
            return this.makeVote(challenge.disputeId, 'inconclusive', {
                computedHash: '',
                engineId: 'unknown',
                schemaHash: '',
                blockStateHashes: {},
            });
        }
        // Compare our evidence with the challenger's
        let vote;
        if (evidence.computedHash === challenge.challengerEvidence.computedHash) {
            // Our re-execution matches the challenger — the challenger is right
            vote = 'agree-with-challenger';
        }
        else {
            // Our re-execution differs from the challenger — the majority is likely right
            vote = 'agree-with-majority';
        }
        return this.makeVote(challenge.disputeId, vote, evidence);
    }
    /**
     * Handle an incoming dispute resolution (broadcast from the dispute initiator).
     */
    handleResolution(resolution) {
        this.resolvedDisputes.set(resolution.disputeId, resolution);
        log('dispute-resolution-received', {
            disputeId: resolution.disputeId,
            outcome: resolution.outcome,
        });
        // If we were penalized and the challenger won, check engine health
        const ourId = this.peerId.toString();
        const ourPenalty = resolution.affectedPeers.find(p => p.peerId === ourId);
        if (ourPenalty && ourPenalty.reason === 'false-approval') {
            this.engineHealth.recordDisputeLoss();
        }
    }
    /** Collect votes from arbitrators with a timeout */
    async collectVotes(challenge, arbitrators) {
        const timeoutMs = this.config.disputeArbitrationTimeoutMs;
        const votes = [];
        const votePromises = arbitrators.map(async (arbitratorPeerId) => {
            try {
                const client = this.createDisputeClient(arbitratorPeerId);
                const vote = await client.sendChallenge(challenge, timeoutMs);
                return vote;
            }
            catch (err) {
                log('dispute-vote-collection-failed', {
                    disputeId: challenge.disputeId,
                    arbitrator: arbitratorPeerId.toString(),
                    error: err instanceof Error ? err.message : String(err),
                });
                return undefined;
            }
        });
        const results = await Promise.allSettled(votePromises);
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                votes.push(result.value);
            }
        }
        return votes;
    }
    /** Determine dispute resolution from collected votes */
    resolveDispute(challenge, votes) {
        const challengerVotes = votes.filter(v => v.vote === 'agree-with-challenger').length;
        const majorityVotes = votes.filter(v => v.vote === 'agree-with-majority').length;
        const totalDecisive = challengerVotes + majorityVotes;
        // Need super-majority of decisive votes (>2/3)
        const superMajorityThreshold = Math.ceil(totalDecisive * 2 / 3);
        let outcome;
        const affectedPeers = [];
        if (totalDecisive === 0) {
            outcome = 'inconclusive';
        }
        else if (challengerVotes >= superMajorityThreshold) {
            outcome = 'challenger-wins';
            // Penalize majority peers who approved the transaction
            const originalRecord = challenge.originalRecord;
            for (const [peerId, signature] of Object.entries(originalRecord.promises)) {
                if (signature.type === 'approve' && peerId !== challenge.challengerPeerId) {
                    affectedPeers.push({ peerId, reason: 'false-approval' });
                }
            }
        }
        else if (majorityVotes >= superMajorityThreshold) {
            outcome = 'majority-wins';
            // Penalize the challenger
            affectedPeers.push({ peerId: challenge.challengerPeerId, reason: 'dispute-lost' });
        }
        else {
            outcome = 'inconclusive';
        }
        return {
            disputeId: challenge.disputeId,
            outcome,
            votes,
            affectedPeers,
            timestamp: Date.now(),
        };
    }
    /** Apply reputation effects based on dispute resolution */
    applyReputationEffects(resolution, _record) {
        if (!this.reputation)
            return;
        for (const affected of resolution.affectedPeers) {
            if (affected.reason === 'false-approval') {
                // Weight: 40 as specified in ticket
                this.reputation.reportPeer(affected.peerId, PenaltyReason.FalseApproval, `dispute:false-approval:${resolution.disputeId}`);
            }
            else if (affected.reason === 'dispute-lost') {
                // Weight: 30 as specified in ticket
                this.reputation.reportPeer(affected.peerId, PenaltyReason.DisputeLost, `dispute:dispute-lost:${resolution.disputeId}`);
            }
        }
        // If challenger wins, track engine health for majority peers
        if (resolution.outcome === 'challenger-wins') {
            const ourId = this.peerId.toString();
            if (resolution.affectedPeers.some(p => p.peerId === ourId)) {
                this.engineHealth.recordDisputeLoss();
            }
        }
    }
    /** Broadcast resolution to all interested parties */
    async broadcastResolution(resolution, arbitrators, originalPeers) {
        const allTargets = new Set();
        for (const arb of arbitrators)
            allTargets.add(arb.toString());
        for (const peer of originalPeers)
            allTargets.add(peer);
        // Don't send to self
        allTargets.delete(this.peerId.toString());
        const promises = Array.from(allTargets).map(async (peerIdStr) => {
            try {
                const { peerIdFromString } = await import('@libp2p/peer-id');
                const client = this.createDisputeClient(peerIdFromString(peerIdStr));
                await client.sendResolution(resolution);
            }
            catch (err) {
                log('dispute-broadcast-failed', {
                    disputeId: resolution.disputeId,
                    peer: peerIdStr,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        });
        await Promise.allSettled(promises);
    }
    async makeVote(disputeId, vote, evidence) {
        const payload = `${disputeId}:${vote}:${evidence.computedHash}`;
        const payloadBytes = new TextEncoder().encode(payload);
        const sigBytes = await this.privateKey.sign(payloadBytes);
        return {
            disputeId,
            arbitratorPeerId: this.peerId.toString(),
            vote,
            evidence,
            signature: uint8ArrayToString(sigBytes, 'base64url'),
        };
    }
    async computeDisputeId(messageHash, peerId, timestamp) {
        const input = `${messageHash}+${peerId}+${timestamp}`;
        const inputBytes = new TextEncoder().encode(input);
        const hashBytes = await sha256.digest(inputBytes);
        return base58btc.encode(hashBytes.digest);
    }
    async signDispute(disputeId) {
        const payload = new TextEncoder().encode(disputeId);
        const sigBytes = await this.privateKey.sign(payload);
        return uint8ArrayToString(sigBytes, 'base64url');
    }
    async verifyDisputeSignature(disputeId, signature, publicKey) {
        if (!publicKey?.length)
            return false;
        try {
            const keyBytes = typeof publicKey === 'string'
                ? uint8ArrayFromString(publicKey, 'base64url')
                : publicKey;
            const pubKey = publicKeyFromRaw(keyBytes);
            const payload = new TextEncoder().encode(disputeId);
            const sigBytes = uint8ArrayFromString(signature, 'base64url');
            return pubKey.verify(payload, sigBytes);
        }
        catch {
            return false;
        }
    }
    findChallengeForDispute(disputeId) {
        return this.activeDisputes.get(disputeId) ?? this.resolvedChallenges.get(disputeId);
    }
}
//# sourceMappingURL=dispute-service.js.map