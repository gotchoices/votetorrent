import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { Libp2pKeyPeerNetwork, FindCoordinatorError, FIND_COORDINATOR_ERROR_CODES } from '../src/libp2p-key-network.js';
const makePeerId = async () => {
    const key = await generateKeyPair('Ed25519');
    return peerIdFromPrivateKey(key);
};
/** Minimal mock Libp2p that satisfies Libp2pKeyPeerNetwork's usage */
function createMockLibp2p(peerId, options) {
    const listeners = new Map();
    return {
        peerId,
        getConnections: () => options?.connections ?? [],
        getMultiaddrs: () => [],
        addEventListener: (event, handler) => {
            if (!listeners.has(event))
                listeners.set(event, new Set());
            listeners.get(event).add(handler);
        },
        removeEventListener: () => { },
        services: {
            fret: options?.fret
        }
    };
}
/** In-memory persistence implementation for testing */
class MemoryPersistence {
    saved;
    stored;
    constructor(initial) {
        this.stored = initial;
    }
    async load() {
        return this.stored;
    }
    async save(state) {
        this.saved = state;
        this.stored = state;
    }
}
describe('Libp2pKeyPeerNetwork', () => {
    let selfPeerId;
    before(async () => {
        selfPeerId = await makePeerId();
    });
    describe('canRetryImprove()', () => {
        it('returns false for forming + HWM<=1 + self-only FRET', () => {
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
            // Access private method via cast
            const result = network.canRetryImprove([selfPeerId.toString()]);
            expect(result).to.be.false;
        });
        it('returns false for forming + HWM<=1 + empty FRET', () => {
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
            const result = network.canRetryImprove([]);
            expect(result).to.be.false;
        });
        it('returns true for joining mode regardless of other conditions', () => {
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'joining');
            const result = network.canRetryImprove([selfPeerId.toString()]);
            expect(result).to.be.true;
        });
        it('returns true for forming + HWM>1 (persisted history)', async () => {
            const persistence = new MemoryPersistence({
                version: 1,
                networkHighWaterMark: 10,
                lastConnectedTimestamp: Date.now() - 60000,
                consecutiveIsolatedSessions: 0
            });
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
            await network.initFromPersistedState();
            const result = network.canRetryImprove([selfPeerId.toString()]);
            expect(result).to.be.true;
        });
        it('returns true when FRET has other peers', () => {
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
            const result = network.canRetryImprove([selfPeerId.toString(), 'other-peer-id']);
            expect(result).to.be.true;
        });
    });
    describe('initFromPersistedState()', () => {
        it('does nothing when no persistence is configured', async () => {
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
            // Should not throw
            await network.initFromPersistedState();
        });
        it('does nothing when persistence returns undefined', async () => {
            const persistence = new MemoryPersistence(undefined);
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
            await network.initFromPersistedState();
            // HWM should remain at default (1)
            expect(network.networkHighWaterMark).to.equal(1);
        });
        it('restores HWM and consecutiveIsolatedSessions from persisted state', async () => {
            const persistence = new MemoryPersistence({
                version: 1,
                networkHighWaterMark: 50,
                lastConnectedTimestamp: Date.now() - 120000,
                consecutiveIsolatedSessions: 2
            });
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
            await network.initFromPersistedState();
            expect(network.networkHighWaterMark).to.equal(50);
            // consecutiveIsolatedSessions should be incremented because HWM>1 but no FRET entries
            expect(network.consecutiveIsolatedSessions).to.equal(3);
        });
        it('increments consecutiveIsolatedSessions when HWM>1 but FRET table is empty', async () => {
            const persistence = new MemoryPersistence({
                version: 1,
                networkHighWaterMark: 5,
                lastConnectedTimestamp: Date.now() - 60000,
                consecutiveIsolatedSessions: 0,
                fretTable: { v: 1, peerId: selfPeerId.toString(), timestamp: Date.now(), entries: [] }
            });
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
            await network.initFromPersistedState();
            expect(network.consecutiveIsolatedSessions).to.equal(1);
        });
        it('does not increment consecutiveIsolatedSessions when HWM<=1', async () => {
            const persistence = new MemoryPersistence({
                version: 1,
                networkHighWaterMark: 1,
                lastConnectedTimestamp: Date.now() - 60000,
                consecutiveIsolatedSessions: 0
            });
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
            await network.initFromPersistedState();
            expect(network.consecutiveIsolatedSessions).to.equal(0);
        });
        it('does not increment consecutiveIsolatedSessions when FRET table has multiple entries', async () => {
            const now = Date.now();
            const makeFretEntry = (id, coord) => ({
                id, coord, relevance: 1, lastAccess: now,
                state: 'disconnected', accessCount: 1,
                successCount: 1, failureCount: 0, avgLatencyMs: 10
            });
            const persistence = new MemoryPersistence({
                version: 1,
                networkHighWaterMark: 10,
                lastConnectedTimestamp: now - 60000,
                consecutiveIsolatedSessions: 1,
                fretTable: {
                    v: 1,
                    peerId: selfPeerId.toString(),
                    timestamp: now,
                    entries: [makeFretEntry('peer-a', 'AAAA'), makeFretEntry('peer-b', 'BBBB')]
                }
            });
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
            await network.initFromPersistedState();
            // Should stay at 1, not increment
            expect(network.consecutiveIsolatedSessions).to.equal(1);
        });
    });
    describe('persistState()', () => {
        it('does nothing when no persistence is configured', () => {
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
            // Should not throw
            network.persistState();
        });
        it('captures current state including HWM and sessions', async () => {
            const persistence = new MemoryPersistence({
                version: 1,
                networkHighWaterMark: 25,
                lastConnectedTimestamp: Date.now() - 30000,
                consecutiveIsolatedSessions: 1
            });
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
            await network.initFromPersistedState();
            // Trigger persist
            network.persistState();
            // Wait a tick for the fire-and-forget save
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(persistence.saved).to.not.be.undefined;
            expect(persistence.saved.version).to.equal(1);
            expect(persistence.saved.networkHighWaterMark).to.equal(25);
            // consecutiveIsolatedSessions was 1, incremented to 2 because HWM>1 and no FRET entries
            expect(persistence.saved.consecutiveIsolatedSessions).to.equal(2);
        });
        it('captures FRET table when available', async () => {
            const mockFretTable = {
                v: 1,
                peerId: selfPeerId.toString(),
                timestamp: Date.now(),
                entries: []
            };
            const mockFret = {
                exportTable: () => mockFretTable,
                getNetworkSizeEstimate: () => ({ size_estimate: 1, confidence: 0.5 }),
                getNeighbors: () => [],
                detectPartition: () => false
            };
            const persistence = new MemoryPersistence();
            const libp2p = createMockLibp2p(selfPeerId, { fret: mockFret });
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
            network.persistState();
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(persistence.saved).to.not.be.undefined;
            expect(persistence.saved.fretTable).to.deep.equal(mockFretTable);
        });
    });
    describe('shouldAllowSelfCoordination()', () => {
        it('allows when HWM<=1 (bootstrap node)', () => {
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
            const decision = network.shouldAllowSelfCoordination();
            expect(decision.allow).to.be.true;
            expect(decision.reason).to.equal('bootstrap-node');
        });
        it('blocks when disabled', () => {
            const libp2p = createMockLibp2p(selfPeerId);
            const config = { allowSelfCoordination: false };
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, config, 'forming');
            const decision = network.shouldAllowSelfCoordination();
            expect(decision.allow).to.be.false;
            expect(decision.reason).to.equal('disabled');
        });
        it('allows after 3+ consecutive isolated sessions (HWM decay)', async () => {
            const persistence = new MemoryPersistence({
                version: 1,
                networkHighWaterMark: 50,
                lastConnectedTimestamp: Date.now() - 300000,
                consecutiveIsolatedSessions: 2 // will be incremented to 3 since HWM>1 and no FRET
            });
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
            await network.initFromPersistedState();
            expect(network.consecutiveIsolatedSessions).to.equal(3);
            const decision = network.shouldAllowSelfCoordination();
            expect(decision.allow).to.be.true;
            expect(decision.reason).to.equal('hwm-decay');
            expect(decision.warn).to.be.true;
        });
        it('blocks when HWM>1 and only 1 isolated session (not enough decay)', async () => {
            const persistence = new MemoryPersistence({
                version: 1,
                networkHighWaterMark: 50,
                lastConnectedTimestamp: Date.now(), // recently connected
                consecutiveIsolatedSessions: 0 // will increment to 1
            });
            const libp2p = createMockLibp2p(selfPeerId);
            const config = { gracePeriodMs: 60000 };
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, config, 'forming', persistence);
            await network.initFromPersistedState();
            expect(network.consecutiveIsolatedSessions).to.equal(1);
            const decision = network.shouldAllowSelfCoordination();
            // Should not allow because HWM>1, sessions<3, and grace period applies
            expect(decision.allow).to.be.false;
        });
    });
    describe('consecutiveIsolatedSessions reset on connection', () => {
        it('resets to 0 when connections are observed', async () => {
            const persistence = new MemoryPersistence({
                version: 1,
                networkHighWaterMark: 10,
                lastConnectedTimestamp: Date.now() - 60000,
                consecutiveIsolatedSessions: 2
            });
            const otherPeerId = await makePeerId();
            const mockConnection = {
                remotePeer: otherPeerId,
                remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/8000' }
            };
            const libp2p = createMockLibp2p(selfPeerId, { connections: [mockConnection] });
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
            await network.initFromPersistedState();
            // consecutiveIsolatedSessions was 2, incremented to 3 (HWM>1, no FRET entries)
            expect(network.consecutiveIsolatedSessions).to.equal(3);
            // Simulate connection event by calling updateNetworkObservations
            network.updateNetworkObservations();
            // Should be reset because connections.length > 0
            expect(network.consecutiveIsolatedSessions).to.equal(0);
        });
    });
    describe('findCoordinator() — solo/bootstrap node error codes', () => {
        it('returns self on first call when no excludes', async () => {
            const fret = {
                getNeighbors: () => [],
                getNetworkSizeEstimate: () => ({ size_estimate: 1, confidence: 0.5 }),
                detectPartition: () => false,
                exportTable: () => undefined
            };
            const libp2p = createMockLibp2p(selfPeerId, { fret });
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
            const key = new TextEncoder().encode('optimystic/schema');
            const result = await network.findCoordinator(key);
            expect(result.toString()).to.equal(selfPeerId.toString());
        });
        it('throws SELF_COORDINATION_EXHAUSTED (not "all candidates excluded") when self is excluded on solo node', async () => {
            const fret = {
                getNeighbors: () => [],
                getNetworkSizeEstimate: () => ({ size_estimate: 1, confidence: 0.5 }),
                detectPartition: () => false,
                exportTable: () => undefined
            };
            const libp2p = createMockLibp2p(selfPeerId, { fret });
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
            const key = new TextEncoder().encode('optimystic/schema');
            let caught;
            try {
                await network.findCoordinator(key, { excludedPeers: [selfPeerId] });
                expect.fail('Expected findCoordinator to throw when self is excluded on solo node');
            }
            catch (err) {
                caught = err;
            }
            expect(caught).to.be.instanceOf(FindCoordinatorError);
            expect(caught.code).to.equal(FIND_COORDINATOR_ERROR_CODES.SELF_COORDINATION_EXHAUSTED);
            // Sanity: the error should NOT be the generic "all candidates excluded" message
            expect(caught.message).to.match(/exhausted/i);
        });
        it('throws NO_COORDINATOR_AVAILABLE (not self-exhausted) when HWM>1 and self excluded', async () => {
            // Simulate a node that has seen a larger network (HWM > 1) but is currently isolated
            const persistence = new MemoryPersistence({
                version: 1,
                networkHighWaterMark: 10,
                lastConnectedTimestamp: Date.now() - 10 * 60_000,
                consecutiveIsolatedSessions: 3 // enough for hwm-decay
            });
            const fret = {
                getNeighbors: () => [],
                getNetworkSizeEstimate: () => ({ size_estimate: 10, confidence: 0.5 }),
                detectPartition: () => false,
                exportTable: () => undefined
            };
            const libp2p = createMockLibp2p(selfPeerId, { fret });
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
            await network.initFromPersistedState();
            const key = new TextEncoder().encode('some-block');
            let caught;
            try {
                await network.findCoordinator(key, { excludedPeers: [selfPeerId] });
                expect.fail('Expected findCoordinator to throw');
            }
            catch (err) {
                caught = err;
            }
            expect(caught).to.be.instanceOf(FindCoordinatorError);
            // HWM > 1 → not the solo-exhausted case
            expect(caught.code).to.equal(FIND_COORDINATOR_ERROR_CODES.NO_COORDINATOR_AVAILABLE);
        });
    });
    describe('networkMode defaults', () => {
        it('defaults to forming when not specified', () => {
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p);
            expect(network.networkMode).to.equal('forming');
        });
        it('accepts joining mode', () => {
            const libp2p = createMockLibp2p(selfPeerId);
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'joining');
            expect(network.networkMode).to.equal('joining');
        });
    });
    describe('connect()', () => {
        const PROTOCOL = '/test/1.0.0';
        const FAKE_STREAM = { id: 'fake-stream' };
        function createLibp2pWithConnect(options) {
            return {
                peerId: selfPeerId,
                getConnections: (_peerId) => options.connections ?? [],
                getMultiaddrs: () => [],
                addEventListener: () => { },
                removeEventListener: () => { },
                dialProtocol: options.dialProtocol ?? (() => Promise.reject(new Error('dialProtocol unexpectedly called'))),
                services: {}
            };
        }
        it('passes runOnLimitedConnection: true on warm-connection reuse (limited-connection path)', async () => {
            let observedOpts = undefined;
            const mockConn = {
                status: 'open',
                newStream: (_protocols, opts) => {
                    observedOpts = opts;
                    // Mirror real libp2p: reject unless runOnLimitedConnection is true,
                    // emulating a circuit-relay (limited) connection.
                    if (!opts?.runOnLimitedConnection) {
                        return Promise.reject(new Error('limited connection requires runOnLimitedConnection'));
                    }
                    return Promise.resolve(FAKE_STREAM);
                }
            };
            const libp2p = createLibp2pWithConnect({ connections: [mockConn] });
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
            const otherPeerId = await makePeerId();
            const stream = await network.connect(otherPeerId, PROTOCOL);
            expect(stream).to.equal(FAKE_STREAM);
            expect(observedOpts).to.not.be.undefined;
            expect(observedOpts.runOnLimitedConnection).to.equal(true);
            expect(observedOpts.negotiateFully).to.equal(false);
        });
        it('skips non-open connections and falls back to dialProtocol', async () => {
            const newStreamCalled = { called: false };
            const closingConn = {
                status: 'closing',
                newStream: () => {
                    newStreamCalled.called = true;
                    return Promise.reject(new Error('should not be called'));
                }
            };
            let dialOpts = undefined;
            const libp2p = createLibp2pWithConnect({
                connections: [closingConn],
                dialProtocol: (_peerId, _protocols, opts) => {
                    dialOpts = opts;
                    return Promise.resolve(FAKE_STREAM);
                }
            });
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
            const otherPeerId = await makePeerId();
            const stream = await network.connect(otherPeerId, PROTOCOL);
            expect(stream).to.equal(FAKE_STREAM);
            expect(newStreamCalled.called).to.be.false;
            expect(dialOpts).to.not.be.undefined;
            expect(dialOpts.runOnLimitedConnection).to.equal(true);
            expect(dialOpts.negotiateFully).to.equal(false);
        });
        it('falls back to dialProtocol when no connections exist', async () => {
            let dialOpts = undefined;
            const libp2p = createLibp2pWithConnect({
                connections: [],
                dialProtocol: (_peerId, _protocols, opts) => {
                    dialOpts = opts;
                    return Promise.resolve(FAKE_STREAM);
                }
            });
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
            const otherPeerId = await makePeerId();
            const stream = await network.connect(otherPeerId, PROTOCOL);
            expect(stream).to.equal(FAKE_STREAM);
            expect(dialOpts).to.not.be.undefined;
            expect(dialOpts.runOnLimitedConnection).to.equal(true);
        });
        it('forwards the caller AbortSignal on the reuse path', async () => {
            let observedSignal;
            const mockConn = {
                status: 'open',
                newStream: (_protocols, opts) => {
                    observedSignal = opts?.signal;
                    return Promise.resolve(FAKE_STREAM);
                }
            };
            const libp2p = createLibp2pWithConnect({ connections: [mockConn] });
            const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
            const otherPeerId = await makePeerId();
            const controller = new AbortController();
            await network.connect(otherPeerId, PROTOCOL, { signal: controller.signal });
            expect(observedSignal).to.equal(controller.signal);
        });
    });
});
//# sourceMappingURL=libp2p-key-network.spec.js.map