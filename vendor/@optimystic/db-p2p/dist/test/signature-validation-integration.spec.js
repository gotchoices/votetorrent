/**
 * TEST-6.2.1: Signature Validation Integration Tests
 *
 * Tests the integration between quereus-plugin-crypto's SignatureValid and
 * the cluster consensus signature verification in cluster-repo.ts.
 *
 * The cluster currently uses libp2p Ed25519 (@libp2p/crypto) for signing/verifying.
 * The crypto plugin uses @noble/curves for multi-curve signature verification.
 * These tests validate cross-library compatibility and the end-to-end signature
 * flow through consensus phases.
 */
import { expect } from 'chai';
import { clusterMember } from '../src/cluster/cluster-repo.js';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { ed25519 } from '@noble/curves/ed25519.js';
import { PeerReputationService } from '../src/reputation/peer-reputation.js';
/**
 * Inline SignatureValid for Ed25519 — mirrors the quereus-plugin-crypto implementation
 * using @noble/curves directly. This avoids a cross-package dev dependency while
 * testing the same verification logic the crypto plugin provides.
 */
const SignatureValid = {
    ed25519: (digest, signature, publicKey) => {
        try {
            return ed25519.verify(signature, digest, publicKey);
        }
        catch {
            return false;
        }
    },
    detailed: (digest, signature, publicKey, options) => {
        try {
            const valid = ed25519.verify(signature, digest, publicKey);
            return { valid, curve: options.curve, signatureFormat: 'raw' };
        }
        catch (error) {
            return { valid: false, curve: options.curve, signatureFormat: 'unknown', error: error instanceof Error ? error.message : 'Unknown error' };
        }
    }
};
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
describe('Signature Validation Integration (TEST-6.2.1)', () => {
    let mockRepo;
    let mockNetwork;
    beforeEach(() => {
        mockRepo = new MockRepo();
        mockNetwork = new MockPeerNetwork();
    });
    describe('cross-library Ed25519 compatibility', () => {
        it('libp2p Ed25519 signatures are verifiable by @noble/curves ed25519', async () => {
            const keyPair = await makeKeyPair();
            const payload = new TextEncoder().encode('test-payload:approve');
            // Sign with libp2p
            const sigBytes = await keyPair.privateKey.sign(payload);
            // Verify with @noble/curves (what SignatureValid uses internally)
            const pubKeyRaw = keyPair.peerId.publicKey.raw;
            const valid = ed25519.verify(sigBytes, payload, pubKeyRaw);
            expect(valid).to.equal(true);
        });
        it('libp2p Ed25519 signatures are verifiable by SignatureValid', async () => {
            const keyPair = await makeKeyPair();
            const payload = new TextEncoder().encode('test-payload:approve');
            // Sign with libp2p
            const sigBytes = await keyPair.privateKey.sign(payload);
            // Verify with SignatureValid from quereus-plugin-crypto
            const pubKeyRaw = keyPair.peerId.publicKey.raw;
            const valid = SignatureValid.ed25519(payload, sigBytes, pubKeyRaw);
            expect(valid).to.equal(true);
        });
        it('SignatureValid rejects corrupted libp2p signatures', async () => {
            const keyPair = await makeKeyPair();
            const payload = new TextEncoder().encode('test-payload:approve');
            const sigBytes = await keyPair.privateKey.sign(payload);
            // Corrupt the signature
            const corrupted = new Uint8Array(sigBytes);
            corrupted[0] = (corrupted[0] + 1) & 0xff;
            const pubKeyRaw = keyPair.peerId.publicKey.raw;
            const valid = SignatureValid.ed25519(payload, corrupted, pubKeyRaw);
            expect(valid).to.equal(false);
        });
        it('SignatureValid rejects wrong public key', async () => {
            const keyPair1 = await makeKeyPair();
            const keyPair2 = await makeKeyPair();
            const payload = new TextEncoder().encode('test-payload:approve');
            // Sign with keyPair1
            const sigBytes = await keyPair1.privateKey.sign(payload);
            // Verify with keyPair2's public key (should fail)
            const wrongPubKey = keyPair2.peerId.publicKey.raw;
            const valid = SignatureValid.ed25519(payload, sigBytes, wrongPubKey);
            expect(valid).to.equal(false);
        });
    });
    describe('consensus promise signature verification via SignatureValid', () => {
        it('promise signatures from consensus flow are verifiable by SignatureValid', async () => {
            const selfKeyPair = await makeKeyPair();
            const peers = makeClusterPeers([selfKeyPair]);
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: selfKeyPair.peerId,
                privateKey: selfKeyPair.privateKey
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            const result = await member.update(record);
            const ourId = selfKeyPair.peerId.toString();
            const promise = result.promises[ourId];
            expect(promise).to.not.equal(undefined);
            // Reconstruct the signing payload (same as cluster-repo.ts computeSigningPayload)
            const promiseHash = await computePromiseHash(record);
            const expectedPayload = promiseHash + ':' + promise.type;
            const payloadBytes = new TextEncoder().encode(expectedPayload);
            // Decode the base64url signature
            const sigBytes = uint8ArrayFromString(promise.signature, 'base64url');
            const pubKeyRaw = selfKeyPair.peerId.publicKey.raw;
            // Verify using SignatureValid
            const valid = SignatureValid.ed25519(payloadBytes, sigBytes, pubKeyRaw);
            expect(valid).to.equal(true);
        });
        it('commit signatures from consensus flow are verifiable by SignatureValid', async () => {
            const selfKeyPair = await makeKeyPair();
            const ourId = selfKeyPair.peerId.toString();
            const peers = makeClusterPeers([selfKeyPair]);
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: selfKeyPair.peerId,
                privateKey: selfKeyPair.privateKey
            });
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // Phase 1: add promise
            const afterPromise = await member.update(record);
            // Phase 2: add commit
            const afterCommit = await member.update(afterPromise);
            const commit = afterCommit.commits[ourId];
            expect(commit).to.not.equal(undefined);
            // Reconstruct commit signing payload
            const commitHash = await computeCommitHash(afterPromise);
            const expectedPayload = commitHash + ':' + commit.type;
            const payloadBytes = new TextEncoder().encode(expectedPayload);
            const sigBytes = uint8ArrayFromString(commit.signature, 'base64url');
            const pubKeyRaw = selfKeyPair.peerId.publicKey.raw;
            const valid = SignatureValid.ed25519(payloadBytes, sigBytes, pubKeyRaw);
            expect(valid).to.equal(true);
        });
        it('rejection promise signatures include rejectReason in payload', async () => {
            const selfKeyPair = await makeKeyPair();
            const ourId = selfKeyPair.peerId.toString();
            const peers = makeClusterPeers([selfKeyPair]);
            // Create member with validator that rejects
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: selfKeyPair.peerId,
                privateKey: selfKeyPair.privateKey,
                validator: {
                    validate: async () => ({ valid: false, reason: 'test-rejection' }),
                    getSchemaHash: async () => 'test-hash'
                }
            });
            const record = await createClusterRecord(peers, [{
                    pend: {
                        actionId: 'a1',
                        transforms: { inserts: { 'b1': { header: { id: 'b1', type: 'test', collectionId: 'c1' } } }, updates: {}, deletes: [] },
                        policy: 'c',
                        transaction: { statements: [], stamp: {} },
                        operationsHash: 'hash'
                    }
                }]);
            const result = await member.update(record);
            const promise = result.promises[ourId];
            expect(promise.type).to.equal('reject');
            // The signing payload for a rejection includes the rejectReason
            const promiseHash = await computePromiseHash(record);
            const expectedPayload = promiseHash + ':reject:' + promise.rejectReason;
            const payloadBytes = new TextEncoder().encode(expectedPayload);
            const sigBytes = uint8ArrayFromString(promise.signature, 'base64url');
            const pubKeyRaw = selfKeyPair.peerId.publicKey.raw;
            const valid = SignatureValid.ed25519(payloadBytes, sigBytes, pubKeyRaw);
            expect(valid).to.equal(true);
        });
    });
    describe('multi-peer signature verification via SignatureValid', () => {
        it('all peer signatures in a 3-node consensus are independently verifiable', async () => {
            const peer1 = await makeKeyPair();
            const peer2 = await makeKeyPair();
            const peer3 = await makeKeyPair();
            const allPeers = [peer1, peer2, peer3];
            const peers = makeClusterPeers(allPeers);
            // Create three cluster members
            const members = allPeers.map(kp => clusterMember({
                storageRepo: new MockRepo(),
                peerNetwork: mockNetwork,
                peerId: kp.peerId,
                privateKey: kp.privateKey
            }));
            // Start consensus: each peer adds its promise
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            const promises = {};
            for (let i = 0; i < 3; i++) {
                const result = await members[i].update({ ...record, promises: { ...promises } });
                const id = allPeers[i].peerId.toString();
                promises[id] = result.promises[id];
            }
            // Verify every promise signature independently via SignatureValid
            const promiseHash = await computePromiseHash(record);
            for (const kp of allPeers) {
                const id = kp.peerId.toString();
                const promise = promises[id];
                const expectedPayload = promiseHash + ':' + promise.type;
                const payloadBytes = new TextEncoder().encode(expectedPayload);
                const sigBytes = uint8ArrayFromString(promise.signature, 'base64url');
                const pubKeyRaw = kp.peerId.publicKey.raw;
                const valid = SignatureValid.ed25519(payloadBytes, sigBytes, pubKeyRaw);
                expect(valid, `Promise signature from peer ${id.substring(0, 8)} should be valid`).to.equal(true);
            }
        });
    });
    describe('SignatureValid.detailed integration', () => {
        it('detailed() returns correct metadata for cluster consensus signatures', async () => {
            const keyPair = await makeKeyPair();
            const payload = new TextEncoder().encode('test-payload:approve');
            const sigBytes = await keyPair.privateKey.sign(payload);
            const pubKeyRaw = keyPair.peerId.publicKey.raw;
            const result = SignatureValid.detailed(payload, sigBytes, pubKeyRaw, { curve: 'ed25519' });
            expect(result.valid).to.equal(true);
            expect(result.curve).to.equal('ed25519');
            expect(result.signatureFormat).to.equal('raw');
        });
        it('detailed() reports failure for corrupted consensus signatures', async () => {
            const keyPair = await makeKeyPair();
            const payload = new TextEncoder().encode('test-payload:approve');
            const sigBytes = await keyPair.privateKey.sign(payload);
            const corrupted = new Uint8Array(sigBytes);
            corrupted[31] = (corrupted[31] ^ 0xff);
            const pubKeyRaw = keyPair.peerId.publicKey.raw;
            const result = SignatureValid.detailed(payload, corrupted, pubKeyRaw, { curve: 'ed25519' });
            expect(result.valid).to.equal(false);
            expect(result.curve).to.equal('ed25519');
        });
    });
    describe('reputation integration with signature verification', () => {
        it('forged signature triggers InvalidSignature reputation penalty', async () => {
            const selfKeyPair = await makeKeyPair();
            const forgerKeyPair = await makeKeyPair();
            const otherKeyPair = await makeKeyPair();
            const otherId = otherKeyPair.peerId.toString();
            const reputation = new PeerReputationService();
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: selfKeyPair.peerId,
                privateKey: selfKeyPair.privateKey,
                reputation
            });
            const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            // Forge a promise: sign with forger's key but attribute to otherKeyPair
            const forgedPromise = await makeSignedPromise(forgerKeyPair.privateKey, record);
            const forgedRecord = {
                ...record,
                promises: { [otherId]: forgedPromise }
            };
            try {
                await member.update(forgedRecord);
                expect.fail('Should have thrown');
            }
            catch (err) {
                expect(err.message).to.include('Invalid promise signature');
            }
            // Check reputation penalty was applied
            const score = reputation.getScore(otherId);
            expect(score).to.be.greaterThan(0);
            expect(reputation.getReputation(otherId).penaltyCount).to.equal(1);
        });
        it('forged commit signature triggers InvalidSignature reputation penalty', async () => {
            const selfKeyPair = await makeKeyPair();
            const otherKeyPair = await makeKeyPair();
            const forgerKeyPair = await makeKeyPair();
            const ourId = selfKeyPair.peerId.toString();
            const otherId = otherKeyPair.peerId.toString();
            const reputation = new PeerReputationService();
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: selfKeyPair.peerId,
                privateKey: selfKeyPair.privateKey,
                reputation
            });
            const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);
            const baseRecord = await createClusterRecord(peers, makeGetOperation(['block-1']));
            const ourPromise = await makeSignedPromise(selfKeyPair.privateKey, baseRecord);
            const otherPromise = await makeSignedPromise(otherKeyPair.privateKey, baseRecord);
            const promisedRecord = {
                ...baseRecord,
                promises: { [ourId]: ourPromise, [otherId]: otherPromise }
            };
            // Forge commit with wrong key
            const forgedCommit = await makeSignedCommit(forgerKeyPair.privateKey, promisedRecord);
            const forgedRecord = {
                ...promisedRecord,
                commits: { [otherId]: forgedCommit }
            };
            try {
                await member.update(forgedRecord);
                expect.fail('Should have thrown');
            }
            catch (err) {
                expect(err.message).to.include('Invalid commit signature');
            }
            const score = reputation.getScore(otherId);
            expect(score).to.be.greaterThan(0);
        });
        it('valid signatures do not trigger reputation penalties', async () => {
            const selfKeyPair = await makeKeyPair();
            const otherKeyPair = await makeKeyPair();
            const otherId = otherKeyPair.peerId.toString();
            const reputation = new PeerReputationService();
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: selfKeyPair.peerId,
                privateKey: selfKeyPair.privateKey,
                reputation
            });
            const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);
            const record = await createClusterRecord(peers, makeGetOperation(['block-1']));
            const otherPromise = await makeSignedPromise(otherKeyPair.privateKey, record);
            const withPromise = {
                ...record,
                promises: { [otherId]: otherPromise }
            };
            await member.update(withPromise);
            // No penalties should have been applied
            const score = reputation.getScore(otherId);
            expect(score).to.equal(0);
        });
    });
    describe('signature replay prevention', () => {
        it('promise signature from one transaction is invalid for another', async () => {
            const selfKeyPair = await makeKeyPair();
            const otherKeyPair = await makeKeyPair();
            const otherId = otherKeyPair.peerId.toString();
            const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: selfKeyPair.peerId,
                privateKey: selfKeyPair.privateKey
            });
            // Transaction 1: get block-1
            const record1 = await createClusterRecord(peers, makeGetOperation(['block-1']));
            const otherPromise1 = await makeSignedPromise(otherKeyPair.privateKey, record1);
            // Transaction 2: get block-2 (different message → different promise hash)
            const record2 = await createClusterRecord(peers, makeGetOperation(['block-2']));
            // Try to replay promise from transaction 1 into transaction 2
            const replayedRecord = {
                ...record2,
                promises: { [otherId]: otherPromise1 }
            };
            try {
                await member.update(replayedRecord);
                expect.fail('Should have thrown for replayed signature');
            }
            catch (err) {
                const msg = err.message;
                // May fail with hash mismatch (different message content) or invalid signature
                expect(msg.includes('Invalid promise signature') || msg.includes('Message hash mismatch')).to.be.true;
            }
        });
        it('commit signature cannot be replayed across transactions', async () => {
            const selfKeyPair = await makeKeyPair();
            const otherKeyPair = await makeKeyPair();
            const ourId = selfKeyPair.peerId.toString();
            const otherId = otherKeyPair.peerId.toString();
            const peers = makeClusterPeers([selfKeyPair, otherKeyPair]);
            // Build a valid record with commits for transaction 1
            const record1 = await createClusterRecord(peers, makeGetOperation(['block-1']));
            const ourPromise1 = await makeSignedPromise(selfKeyPair.privateKey, record1);
            const otherPromise1 = await makeSignedPromise(otherKeyPair.privateKey, record1);
            const promisedRecord1 = {
                ...record1,
                promises: { [ourId]: ourPromise1, [otherId]: otherPromise1 }
            };
            const otherCommit1 = await makeSignedCommit(otherKeyPair.privateKey, promisedRecord1);
            // Build a second transaction
            const record2 = await createClusterRecord(peers, makeGetOperation(['block-2']));
            const ourPromise2 = await makeSignedPromise(selfKeyPair.privateKey, record2);
            const otherPromise2 = await makeSignedPromise(otherKeyPair.privateKey, record2);
            const promisedRecord2 = {
                ...record2,
                promises: { [ourId]: ourPromise2, [otherId]: otherPromise2 }
            };
            // Replay commit from transaction 1 into transaction 2
            const replayedRecord = {
                ...promisedRecord2,
                commits: { [otherId]: otherCommit1 }
            };
            const member = clusterMember({
                storageRepo: mockRepo,
                peerNetwork: mockNetwork,
                peerId: selfKeyPair.peerId,
                privateKey: selfKeyPair.privateKey
            });
            try {
                await member.update(replayedRecord);
                expect.fail('Should have thrown for replayed commit signature');
            }
            catch (err) {
                const msg = err.message;
                // May fail with hash mismatch (different message content) or invalid signature
                expect(msg.includes('Invalid commit signature') || msg.includes('Message hash mismatch')).to.be.true;
            }
        });
    });
    describe('signing payload format consistency', () => {
        it('signing payload format: hash:type for approvals', async () => {
            const keyPair = await makeKeyPair();
            const hash = 'test-hash-value';
            const type = 'approve';
            const expectedPayload = `${hash}:${type}`;
            const payloadBytes = new TextEncoder().encode(expectedPayload);
            const sigBytes = await keyPair.privateKey.sign(payloadBytes);
            const valid = SignatureValid.ed25519(payloadBytes, sigBytes, keyPair.peerId.publicKey.raw);
            expect(valid).to.equal(true);
            // Wrong payload format should fail
            const wrongPayload = new TextEncoder().encode(`${type}:${hash}`);
            const wrongValid = SignatureValid.ed25519(wrongPayload, sigBytes, keyPair.peerId.publicKey.raw);
            expect(wrongValid).to.equal(false);
        });
        it('signing payload format: hash:type:reason for rejections', async () => {
            const keyPair = await makeKeyPair();
            const hash = 'test-hash-value';
            const type = 'reject';
            const reason = 'stale revision';
            const expectedPayload = `${hash}:${type}:${reason}`;
            const payloadBytes = new TextEncoder().encode(expectedPayload);
            const sigBytes = await keyPair.privateKey.sign(payloadBytes);
            const valid = SignatureValid.ed25519(payloadBytes, sigBytes, keyPair.peerId.publicKey.raw);
            expect(valid).to.equal(true);
            // Without reason should fail
            const withoutReason = new TextEncoder().encode(`${hash}:${type}`);
            const invalidValid = SignatureValid.ed25519(withoutReason, sigBytes, keyPair.peerId.publicKey.raw);
            expect(invalidValid).to.equal(false);
        });
    });
});
//# sourceMappingURL=signature-validation-integration.spec.js.map