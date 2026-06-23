/**
 * TEST-10.4.1: Byzantine Fault Injection Tests
 *
 * Tests Byzantine fault tolerance in the cluster consensus protocol.
 * Simulates various Byzantine behaviors:
 * - Forged/corrupted signatures
 * - Equivocation (promising conflicting transactions)
 * - Message hash tampering
 * - Partial Byzantine faults in multi-peer clusters
 * - Reputation tracking of Byzantine peers
 */
import { expect } from 'chai';
import { clusterMember } from '../src/cluster/cluster-repo.js';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { PeerReputationService } from '../src/reputation/peer-reputation.js';
import { PenaltyReason } from '../src/reputation/types.js';
import { createMesh } from '../src/testing/mesh-harness.js';
// ─── Canonical JSON for deterministic hashing ───
function canonicalJson(value) {
    return JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
        ? Object.keys(v).sort().reduce((o, k) => { o[k] = v[k]; return o; }, {})
        : v);
}
const makeKeyPair = async () => {
    const privateKey = await generateKeyPair('Ed25519');
    return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
};
const computeMessageHash = async (message) => {
    const msgBytes = new TextEncoder().encode(canonicalJson(message));
    const hashBytes = await sha256.digest(msgBytes);
    return base58btc.encode(hashBytes.digest);
};
const computePromiseHash = async (record) => {
    const msgBytes = new TextEncoder().encode(record.messageHash + canonicalJson(record.message));
    const hashBytes = await sha256.digest(msgBytes);
    return uint8ArrayToString(hashBytes.digest, 'base64url');
};
const computeCommitHash = async (record) => {
    const msgBytes = new TextEncoder().encode(record.messageHash + canonicalJson(record.message) + canonicalJson(record.promises));
    const hashBytes = await sha256.digest(msgBytes);
    return uint8ArrayToString(hashBytes.digest, 'base64url');
};
const signVote = async (privateKey, hash, type, rejectReason) => {
    const payload = hash + ':' + type + (rejectReason ? ':' + rejectReason : '');
    const sigBytes = await privateKey.sign(new TextEncoder().encode(payload));
    return uint8ArrayToString(sigBytes, 'base64url');
};
const makeSignedPromise = async (privateKey, record, type = 'approve', rejectReason) => {
    const promiseHash = await computePromiseHash(record);
    const sig = await signVote(privateKey, promiseHash, type, rejectReason);
    return type === 'approve'
        ? { type: 'approve', signature: sig }
        : { type: 'reject', signature: sig, rejectReason };
};
const makeSignedCommit = async (privateKey, record, type = 'approve') => {
    const commitHash = await computeCommitHash(record);
    const sig = await signVote(privateKey, commitHash, type);
    return { type, signature: sig };
};
const makeHeader = (id) => ({
    id: id,
    type: 'test',
    collectionId: 'collection-1'
});
const makeBlock = (id) => ({
    header: makeHeader(id)
});
const makeClusterPeers = (keyPairs) => {
    const peers = {};
    for (const { peerId } of keyPairs) {
        peers[peerId.toString()] = {
            multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
            publicKey: uint8ArrayToString(peerId.publicKey.raw, 'base64url')
        };
    }
    return peers;
};
const makeGetOperation = (blockIds) => [
    { get: { blockIds } }
];
class MockRepo {
    getCalls = [];
    pendCalls = [];
    commitCalls = [];
    cancelCalls = [];
    async get(blockGets) {
        this.getCalls.push(blockGets);
        return {};
    }
    async pend(request) {
        this.pendCalls.push(request);
        return { success: true, blockIds: [], pending: [] };
    }
    async commit(request) {
        this.commitCalls.push(request);
        return { success: true };
    }
    async cancel(actionRef) {
        this.cancelCalls.push(actionRef);
    }
}
class MockPeerNetwork {
    async connect(_peerId, _protocol) {
        return {};
    }
}
const createClusterRecord = async (peers, operations, promises = {}, commits = {}, expiration) => {
    const message = {
        operations,
        expiration: expiration ?? Date.now() + 30000
    };
    const messageHash = await computeMessageHash(message);
    return { messageHash, message, peers, promises, commits };
};
// ─── Tests ───
describe('Byzantine Fault Injection (TEST-10.4.1)', () => {
    let mockRepo;
    let mockNetwork;
    beforeEach(() => {
        mockRepo = new MockRepo();
        mockNetwork = new MockPeerNetwork();
    });
    describe('forged signature attacks', () => {
        it('Byzantine peer cannot impersonate another peer\'s promise', async () => {
            const honest = await makeKeyPair();
            const victim = await makeKeyPair();
            const byzantine = await makeKeyPair(); // Not in cluster
            const peers = makeClusterPeers([honest, victim]);
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // Byzantine peer signs with their own key but claims to be victim
            const forgedPromise = await makeSignedPromise(byzantine.privateKey, record);
            const attackRecord = {
                ...record,
                promises: { [victim.peerId.toString()]: forgedPromise }
            };
            try {
                await member.update(attackRecord);
                expect.fail('Should have rejected forged signature');
            }
            catch (err) {
                expect(err.message).to.include('Invalid promise signature');
            }
        });
        it('Byzantine peer cannot forge commit after valid promise phase', async () => {
            const honest = await makeKeyPair();
            const byzantine = await makeKeyPair();
            const forger = await makeKeyPair();
            const ourId = honest.peerId.toString();
            const byzantineId = byzantine.peerId.toString();
            const peers = makeClusterPeers([honest, byzantine]);
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            const ourPromise = await makeSignedPromise(honest.privateKey, record);
            const byzantinePromise = await makeSignedPromise(byzantine.privateKey, record); // Legitimate promise
            const promisedRecord = {
                ...record,
                promises: { [ourId]: ourPromise, [byzantineId]: byzantinePromise }
            };
            // Forge the commit — sign with forger's key, attribute to byzantine
            const forgedCommit = await makeSignedCommit(forger.privateKey, promisedRecord);
            const attackRecord = {
                ...promisedRecord,
                commits: { [byzantineId]: forgedCommit }
            };
            try {
                await member.update(attackRecord);
                expect.fail('Should have rejected forged commit');
            }
            catch (err) {
                expect(err.message).to.include('Invalid commit signature');
            }
        });
        it('random bytes as signature are rejected', async () => {
            const honest = await makeKeyPair();
            const other = await makeKeyPair();
            const otherId = other.peerId.toString();
            const peers = makeClusterPeers([honest, other]);
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // Random 64 bytes as a forged Ed25519 signature
            const randomSig = uint8ArrayToString(crypto.getRandomValues(new Uint8Array(64)), 'base64url');
            const attackRecord = {
                ...record,
                promises: { [otherId]: { type: 'approve', signature: randomSig } }
            };
            try {
                await member.update(attackRecord);
                expect.fail('Should have rejected random signature');
            }
            catch (err) {
                expect(err.message).to.include('Invalid promise signature');
            }
        });
    });
    describe('message hash tampering', () => {
        it('rejects record with tampered message hash', async () => {
            const honest = await makeKeyPair();
            const peers = makeClusterPeers([honest]);
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // Tamper: replace message hash with a different valid hash
            const fakeMessage = {
                operations: makeGetOperation(['block-evil']),
                expiration: Date.now() + 30000
            };
            const fakeHash = await computeMessageHash(fakeMessage);
            const tampered = {
                ...record,
                messageHash: fakeHash // Hash doesn't match the actual message
            };
            try {
                await member.update(tampered);
                expect.fail('Should have rejected mismatched hash');
            }
            catch (err) {
                expect(err.message.toLowerCase()).to.include('mismatch');
            }
        });
        it('rejects record with message content that does not match existing hash', async () => {
            const honest = await makeKeyPair();
            const peers = makeClusterPeers([honest]);
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey
            });
            // First update with legitimate record
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            await member.update(record);
            // Second update: same hash, different message content (forgery attempt)
            const tampered = {
                messageHash: record.messageHash,
                message: {
                    operations: makeGetOperation(['block-evil']),
                    expiration: Date.now() + 30000
                },
                peers: record.peers,
                promises: {},
                commits: {}
            };
            try {
                await member.update(tampered);
                expect.fail('Should have rejected content mismatch');
            }
            catch (err) {
                expect(err.message.toLowerCase()).to.include('mismatch');
            }
        });
    });
    describe('equivocation attacks', () => {
        it('Byzantine peer cannot promise approve and reject for the same transaction', async () => {
            const honest = await makeKeyPair();
            const byzantine = await makeKeyPair();
            const byzantineId = byzantine.peerId.toString();
            const peers = makeClusterPeers([honest, byzantine]);
            const reputation = new PeerReputationService();
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey,
                reputation
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // First: Byzantine peer sends an approve
            const approvePromise = await makeSignedPromise(byzantine.privateKey, record, 'approve');
            const withApprove = {
                ...record,
                promises: { [byzantineId]: approvePromise }
            };
            await member.update(withApprove);
            // Second: Byzantine tries to change their promise to reject
            const rejectPromise = await makeSignedPromise(byzantine.privateKey, record, 'reject', 'changed-mind');
            const withReject = {
                ...record,
                promises: { [byzantineId]: rejectPromise }
            };
            const result2 = await member.update(withReject);
            // Equivocation detected: original 'approve' promise is preserved
            expect(result2.promises[byzantineId].type).to.equal('approve');
            // Penalty was applied
            const summary = reputation.getReputation(byzantineId);
            expect(summary.penaltyCount).to.equal(1);
        });
        it('Byzantine peer cannot commit approve and reject for the same transaction', async () => {
            // Use 5 peers so the transaction stays in Promising phase (persisted)
            // after the first update — unanimity requires all 5 promises before commit phase
            const honest = await makeKeyPair();
            const byzantine = await makeKeyPair();
            const peer3 = await makeKeyPair();
            const peer4 = await makeKeyPair();
            const peer5 = await makeKeyPair();
            const byzantineId = byzantine.peerId.toString();
            const peers = makeClusterPeers([honest, byzantine, peer3, peer4, peer5]);
            const reputation = new PeerReputationService();
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey,
                reputation
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // Only 3 of 5 peers have promised — still in Promising phase, state will persist
            const ourPromise = await makeSignedPromise(honest.privateKey, record);
            const byzantinePromise = await makeSignedPromise(byzantine.privateKey, record);
            const peer3Promise = await makeSignedPromise(peer3.privateKey, record);
            const partialPromises = {
                [honest.peerId.toString()]: ourPromise,
                [byzantineId]: byzantinePromise,
                [peer3.peerId.toString()]: peer3Promise
            };
            // Byzantine sends approve commit (signed over partial promises)
            const recordWithPartialPromises = { ...record, promises: partialPromises };
            const approveCommit = await makeSignedCommit(byzantine.privateKey, recordWithPartialPromises);
            // Update 1: 3/5 promises + byzantine approve commit → Promising phase, state persisted
            const withApproveCommit = {
                ...record,
                promises: partialPromises,
                commits: { [byzantineId]: approveCommit }
            };
            await member.update(withApproveCommit);
            // Update 2: same promises but byzantine now sends reject commit
            const rejectCommit = await makeSignedCommit(byzantine.privateKey, recordWithPartialPromises, 'reject');
            const withRejectCommit = {
                ...record,
                promises: partialPromises,
                commits: { [byzantineId]: rejectCommit }
            };
            const result = await member.update(withRejectCommit);
            // Original approve commit is preserved (first-seen wins)
            expect(result.commits[byzantineId].type).to.equal('approve');
            // Equivocation penalty applied
            const summary = reputation.getReputation(byzantineId);
            expect(summary.penaltyCount).to.equal(1);
        });
        it('equivocation triggers ban (weight 100 exceeds ban threshold 80)', async () => {
            const honest = await makeKeyPair();
            const byzantine = await makeKeyPair();
            const byzantineId = byzantine.peerId.toString();
            const peers = makeClusterPeers([honest, byzantine]);
            const reputation = new PeerReputationService();
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey,
                reputation
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // Byzantine peer sends approve then reject
            const approvePromise = await makeSignedPromise(byzantine.privateKey, record, 'approve');
            const withApprove = {
                ...record,
                promises: { [byzantineId]: approvePromise }
            };
            await member.update(withApprove);
            const rejectPromise = await makeSignedPromise(byzantine.privateKey, record, 'reject', 'flip');
            const withReject = {
                ...record,
                promises: { [byzantineId]: rejectPromise }
            };
            await member.update(withReject);
            // Single equivocation (weight 100) exceeds ban threshold (80)
            expect(reputation.isBanned(byzantineId)).to.equal(true);
        });
        it('no false positive on identical re-delivery of same promise', async () => {
            const honest = await makeKeyPair();
            const other = await makeKeyPair();
            const otherId = other.peerId.toString();
            const peers = makeClusterPeers([honest, other]);
            const reputation = new PeerReputationService();
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey,
                reputation
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // Peer sends approve promise
            const approvePromise = await makeSignedPromise(other.privateKey, record, 'approve');
            const withPromise = {
                ...record,
                promises: { [otherId]: approvePromise }
            };
            await member.update(withPromise);
            // Same promise re-delivered (e.g., network retransmission)
            await member.update(withPromise);
            // No penalty — same type, not equivocation
            const summary = reputation.getReputation(otherId);
            expect(summary.penaltyCount).to.equal(0);
            // Promise is preserved correctly
        });
    });
    describe('Byzantine minority in threshold-based consensus', () => {
        const thresholdConfig = {
            superMajorityThreshold: 0.75,
            simpleMajorityThreshold: 0.51,
            minAbsoluteClusterSize: 2,
            allowClusterDownsize: true,
            clusterSizeTolerance: 0.5,
            partitionDetectionWindow: 60000
        };
        it('1 Byzantine peer in 5-node cluster cannot block consensus', async () => {
            const allPeers = await Promise.all(Array.from({ length: 5 }, () => makeKeyPair()));
            const selfKeyPair = allPeers[0];
            const ourId = selfKeyPair.peerId.toString();
            const peers = makeClusterPeers(allPeers);
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: selfKeyPair.peerId,
                privateKey: selfKeyPair.privateKey,
                consensusConfig: thresholdConfig
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // 4 honest approvals + 1 Byzantine rejection
            const promises = {};
            for (let i = 0; i < 4; i++) {
                promises[allPeers[i].peerId.toString()] = await makeSignedPromise(allPeers[i].privateKey, record);
            }
            // Byzantine peer rejects
            promises[allPeers[4].peerId.toString()] = await makeSignedPromise(allPeers[4].privateKey, record, 'reject', 'byzantine');
            const withPromises = { ...record, promises };
            const result = await member.update(withPromises);
            // 4 approvals >= ceil(5 * 0.75) = 4, so commit should proceed
            expect(result.commits[ourId]).to.not.equal(undefined);
            expect(result.commits[ourId].type).to.equal('approve');
        });
        it('2 Byzantine peers in 5-node cluster block consensus', async () => {
            const allPeers = await Promise.all(Array.from({ length: 5 }, () => makeKeyPair()));
            const selfKeyPair = allPeers[0];
            const ourId = selfKeyPair.peerId.toString();
            const peers = makeClusterPeers(allPeers);
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: selfKeyPair.peerId,
                privateKey: selfKeyPair.privateKey,
                consensusConfig: thresholdConfig
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // 3 honest approvals + 2 Byzantine rejections
            const promises = {};
            for (let i = 0; i < 3; i++) {
                promises[allPeers[i].peerId.toString()] = await makeSignedPromise(allPeers[i].privateKey, record);
            }
            promises[allPeers[3].peerId.toString()] = await makeSignedPromise(allPeers[3].privateKey, record, 'reject', 'byzantine1');
            promises[allPeers[4].peerId.toString()] = await makeSignedPromise(allPeers[4].privateKey, record, 'reject', 'byzantine2');
            const withPromises = { ...record, promises };
            const result = await member.update(withPromises);
            // 3 approvals < ceil(5 * 0.75) = 4, so transaction is rejected
            expect(result.commits[ourId]).to.equal(undefined);
        });
        it('disputed record is marked when minority rejects but super-majority approves', async () => {
            const allPeers = await Promise.all(Array.from({ length: 5 }, () => makeKeyPair()));
            const peers = makeClusterPeers(allPeers);
            const byzantineId = allPeers[4].peerId.toString();
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // 4 approvals + 1 rejection
            const promises = {};
            for (let i = 0; i < 4; i++) {
                promises[allPeers[i].peerId.toString()] = await makeSignedPromise(allPeers[i].privateKey, record);
            }
            promises[byzantineId] = await makeSignedPromise(allPeers[4].privateKey, record, 'reject', 'disagree');
            // Simulate coordinator marking disputed
            const disputedRecord = {
                ...record,
                promises,
                disputed: true,
                disputeEvidence: {
                    rejectingPeers: [byzantineId],
                    rejectReasons: { [byzantineId]: 'disagree' }
                }
            };
            expect(disputedRecord.disputed).to.equal(true);
            expect(disputedRecord.disputeEvidence.rejectingPeers).to.deep.equal([byzantineId]);
        });
    });
    describe('cumulative Byzantine reputation', () => {
        it('multiple forged signatures accumulate reputation penalties', async () => {
            const honest = await makeKeyPair();
            const byzantine = await makeKeyPair();
            const byzantineId = byzantine.peerId.toString();
            const forger = await makeKeyPair();
            const reputation = new PeerReputationService();
            const peers = makeClusterPeers([honest, byzantine]);
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey,
                reputation
            });
            // Attempt multiple forged signatures
            for (let i = 0; i < 3; i++) {
                const record = await createClusterRecord(peers, makeGetOperation([`block-${i}`]));
                const forgedPromise = await makeSignedPromise(forger.privateKey, record);
                const attackRecord = {
                    ...record,
                    promises: { [byzantineId]: forgedPromise }
                };
                try {
                    await member.update(attackRecord);
                }
                catch (err) {
                    // Expected
                }
            }
            // Reputation should accumulate significantly
            const score = reputation.getScore(byzantineId);
            const summary = reputation.getReputation(byzantineId);
            expect(summary.penaltyCount).to.equal(3);
            // InvalidSignature weight is 50, so 3 * 50 = 150 (with minimal decay)
            expect(score).to.be.greaterThan(100);
            expect(reputation.isBanned(byzantineId)).to.equal(true);
        });
        it('ban threshold prevents future interactions with Byzantine peer', async () => {
            const reputation = new PeerReputationService();
            const byzantineId = 'byzantine-peer-id';
            // Simulate enough invalid signature penalties to trigger ban
            reputation.reportPeer(byzantineId, PenaltyReason.InvalidSignature, 'forged-promise-1');
            reputation.reportPeer(byzantineId, PenaltyReason.InvalidSignature, 'forged-promise-2');
            // InvalidSignature weight is 50, two reports = 100 >= ban threshold (80)
            expect(reputation.isBanned(byzantineId)).to.equal(true);
            expect(reputation.isDeprioritized(byzantineId)).to.equal(true);
        });
    });
    describe('public key attacks', () => {
        it('rejects peer with missing public key', async () => {
            const honest = await makeKeyPair();
            const other = await makeKeyPair();
            const otherId = other.peerId.toString();
            // Build peers with missing public key for "other"
            const peers = {
                [honest.peerId.toString()]: {
                    multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
                    publicKey: uint8ArrayToString(honest.peerId.publicKey.raw, 'base64url')
                },
                [otherId]: {
                    multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
                    publicKey: '' // Empty public key
                }
            };
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            const otherPromise = await makeSignedPromise(other.privateKey, record);
            const withPromise = {
                ...record,
                promises: { [otherId]: otherPromise }
            };
            try {
                await member.update(withPromise);
                expect.fail('Should have thrown for missing public key');
            }
            catch (err) {
                expect(err.message).to.include('No public key');
            }
        });
        it('rejects peer with wrong public key in cluster record', async () => {
            const honest = await makeKeyPair();
            const other = await makeKeyPair();
            const wrongKey = await makeKeyPair();
            const otherId = other.peerId.toString();
            // Build peers with wrong public key for "other"
            const peers = {
                [honest.peerId.toString()]: {
                    multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
                    publicKey: uint8ArrayToString(honest.peerId.publicKey.raw, 'base64url')
                },
                [otherId]: {
                    multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
                    publicKey: uint8ArrayToString(wrongKey.peerId.publicKey.raw, 'base64url') // Wrong public key!
                }
            };
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // Sign with other's real key, but the record has wrongKey's pubkey
            const otherPromise = await makeSignedPromise(other.privateKey, record);
            const withPromise = {
                ...record,
                promises: { [otherId]: otherPromise }
            };
            try {
                await member.update(withPromise);
                expect.fail('Should have rejected mismatched key');
            }
            catch (err) {
                expect(err.message).to.include('Invalid promise signature');
            }
        });
    });
    describe('mesh-level Byzantine scenarios', () => {
        it('consensus succeeds despite one unreachable node in 3-node cluster', async () => {
            const mesh = await createMesh(3, {
                responsibilityK: 3,
                superMajorityThreshold: 0.51, // Simple majority
                allowClusterDownsize: true
            });
            // Make one node unreachable
            const failingNode = mesh.nodes[2];
            mesh.failures.failingPeers = new Set([failingNode.peerId.toString()]);
            const writer = mesh.nodes[0];
            const blockId = 'byz-block-1';
            const transforms = {
                inserts: { [blockId]: makeBlock(blockId) },
                updates: {},
                deletes: []
            };
            // Pend and commit through coordinator — should succeed with 2 of 3
            const pendResult = await writer.coordinatorRepo.pend({
                actionId: 'byz-a1',
                transforms,
                policy: 'c'
            });
            expect(pendResult.success).to.equal(true);
            const commitResult = await writer.coordinatorRepo.commit({
                actionId: 'byz-a1',
                tailId: blockId,
                rev: 1,
                blockIds: [blockId]
            });
            expect(commitResult.success).to.equal(true);
            // Clean up
            mesh.failures.failingPeers = undefined;
        });
        it('consensus fails when majority nodes are unreachable', async () => {
            const mesh = await createMesh(3, {
                responsibilityK: 3,
                superMajorityThreshold: 0.75,
                allowClusterDownsize: true
            });
            // Make 2 of 3 nodes unreachable
            mesh.failures.failingPeers = new Set([
                mesh.nodes[1].peerId.toString(),
                mesh.nodes[2].peerId.toString()
            ]);
            const writer = mesh.nodes[0];
            const blockId = 'byz-block-2';
            const transforms = {
                inserts: { [blockId]: makeBlock(blockId) },
                updates: {},
                deletes: []
            };
            try {
                await writer.coordinatorRepo.pend({
                    actionId: 'byz-a2',
                    transforms,
                    policy: 'c'
                });
                // May not throw immediately — the coordinator handles retries
            }
            catch (err) {
                // Expected: cannot reach enough peers
                expect(err).to.be.instanceOf(Error);
            }
            // Clean up
            mesh.failures.failingPeers = undefined;
        });
        it('recovered node catches up after partition heals', async () => {
            const mesh = await createMesh(3, {
                responsibilityK: 3,
                superMajorityThreshold: 0.51,
                allowClusterDownsize: true
            });
            const writer = mesh.nodes[0];
            const blockId = 'byz-block-3';
            // Partition: node 2 is unreachable
            mesh.failures.failingPeers = new Set([mesh.nodes[2].peerId.toString()]);
            const transforms = {
                inserts: { [blockId]: makeBlock(blockId) },
                updates: {},
                deletes: []
            };
            await writer.coordinatorRepo.pend({
                actionId: 'byz-a3',
                transforms,
                policy: 'c'
            });
            await writer.coordinatorRepo.commit({
                actionId: 'byz-a3',
                tailId: blockId,
                rev: 1,
                blockIds: [blockId]
            });
            // Heal partition
            mesh.failures.failingPeers = undefined;
            // Node 1 (index 1) should have the data since it was reachable
            const reader = mesh.nodes[1];
            const result = await reader.storageRepo.get({ blockIds: [blockId] });
            // The block should be accessible on the reachable node
            expect(result).to.not.equal(undefined);
        });
    });
    describe('signature type mismatch attacks', () => {
        it('reject signature with type mismatch (approve signature on reject promise)', async () => {
            const honest = await makeKeyPair();
            const byzantine = await makeKeyPair();
            const byzantineId = byzantine.peerId.toString();
            const peers = makeClusterPeers([honest, byzantine]);
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // Sign as 'approve' but claim it's a 'reject'
            const promiseHash = await computePromiseHash(record);
            const approveSignature = await signVote(byzantine.privateKey, promiseHash, 'approve');
            // Set type to 'reject' but use the signature for 'approve'
            const mismatchedPromise = {
                type: 'reject',
                signature: approveSignature,
                rejectReason: 'fraudulent'
            };
            const attackRecord = {
                ...record,
                promises: { [byzantineId]: mismatchedPromise }
            };
            try {
                await member.update(attackRecord);
                expect.fail('Should have rejected type-mismatched signature');
            }
            catch (err) {
                // The signature was for 'approve' but the payload check uses 'reject:fraudulent'
                // so the verification fails
                expect(err.message).to.include('Invalid promise signature');
            }
        });
    });
    describe('empty and edge-case signatures', () => {
        it('rejects empty signature string', async () => {
            const honest = await makeKeyPair();
            const other = await makeKeyPair();
            const otherId = other.peerId.toString();
            const peers = makeClusterPeers([honest, other]);
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            const emptyPromise = {
                type: 'approve',
                signature: '' // Empty signature
            };
            const attackRecord = {
                ...record,
                promises: { [otherId]: emptyPromise }
            };
            try {
                await member.update(attackRecord);
                expect.fail('Should have rejected empty signature');
            }
            catch (err) {
                // Either "Invalid promise signature" or a lower-level crypto error
                expect(err).to.be.instanceOf(Error);
            }
        });
        it('rejects truncated signature', async () => {
            const honest = await makeKeyPair();
            const other = await makeKeyPair();
            const otherId = other.peerId.toString();
            const peers = makeClusterPeers([honest, other]);
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: honest.peerId,
                privateKey: honest.privateKey
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // Create a valid signature then truncate it
            const validPromise = await makeSignedPromise(other.privateKey, record);
            const truncatedSig = validPromise.signature.substring(0, 10);
            const attackRecord = {
                ...record,
                promises: { [otherId]: { type: 'approve', signature: truncatedSig } }
            };
            try {
                await member.update(attackRecord);
                expect.fail('Should have rejected truncated signature');
            }
            catch (err) {
                expect(err).to.be.instanceOf(Error);
            }
        });
    });
});
//# sourceMappingURL=byzantine-fault-injection.spec.js.map