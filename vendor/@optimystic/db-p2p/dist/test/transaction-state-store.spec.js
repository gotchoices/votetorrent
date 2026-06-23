import { expect } from 'chai';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import { MemoryTransactionStateStore } from '../src/cluster/memory-transaction-state-store.js';
import { PersistentTransactionStateStore } from '../src/cluster/persistent-transaction-state-store.js';
// ─── Test helpers ───
const makeMessage = (blockId = 'block-1', expiration) => ({
    operations: [{ get: { blockIds: [blockId] } }],
    expiration: expiration ?? Date.now() + 30000
});
const makeRecord = (messageHash, message) => ({
    messageHash,
    peers: {
        'peer-1': { multiaddrs: [], publicKey: 'key1' },
        'peer-2': { multiaddrs: [], publicKey: 'key2' }
    },
    message: message ?? makeMessage(),
    promises: {},
    commits: {}
});
const makeCoordinatorState = (messageHash, phase = 'promising') => ({
    messageHash,
    record: makeRecord(messageHash),
    lastUpdate: Date.now(),
    phase,
    retryState: phase === 'broadcasting' ? { pendingPeers: ['peer-2'], attempt: 1, intervalMs: 2000 } : undefined
});
const makeParticipantState = (messageHash) => ({
    messageHash,
    record: makeRecord(messageHash),
    lastUpdate: Date.now()
});
// ─── MemoryKVStore tests ───
describe('MemoryKVStore', function () {
    let store;
    beforeEach(() => {
        store = new MemoryKVStore();
    });
    it('set/get round-trip', async () => {
        await store.set('key1', 'value1');
        expect(await store.get('key1')).to.equal('value1');
    });
    it('get returns undefined for missing key', async () => {
        expect(await store.get('missing')).to.be.undefined;
    });
    it('delete removes key', async () => {
        await store.set('key1', 'value1');
        await store.delete('key1');
        expect(await store.get('key1')).to.be.undefined;
    });
    it('delete of non-existent key is no-op', async () => {
        // Should not throw
        await store.delete('nonexistent');
    });
    it('list with prefix filtering', async () => {
        await store.set('coordinator/abc', 'v1');
        await store.set('coordinator/def', 'v2');
        await store.set('participant/abc', 'v3');
        const coordKeys = await store.list('coordinator/');
        expect(coordKeys).to.have.lengthOf(2);
        expect(coordKeys).to.include('coordinator/abc');
        expect(coordKeys).to.include('coordinator/def');
        const partKeys = await store.list('participant/');
        expect(partKeys).to.have.lengthOf(1);
        expect(partKeys).to.include('participant/abc');
    });
    it('list returns empty array when no keys match', async () => {
        await store.set('other/key', 'val');
        expect(await store.list('coordinator/')).to.have.lengthOf(0);
    });
});
// ─── MemoryTransactionStateStore tests ───
describe('MemoryTransactionStateStore', function () {
    let store;
    beforeEach(() => {
        store = new MemoryTransactionStateStore();
    });
    it('save/get/delete coordinator state round-trip', async () => {
        const state = makeCoordinatorState('hash1');
        await store.saveCoordinatorState('hash1', state);
        const loaded = await store.getCoordinatorState('hash1');
        expect(loaded).to.deep.equal(state);
        await store.deleteCoordinatorState('hash1');
        expect(await store.getCoordinatorState('hash1')).to.be.undefined;
    });
    it('save/get/delete participant state round-trip', async () => {
        const state = makeParticipantState('hash1');
        await store.saveParticipantState('hash1', state);
        const loaded = await store.getParticipantState('hash1');
        expect(loaded).to.deep.equal(state);
        await store.deleteParticipantState('hash1');
        expect(await store.getParticipantState('hash1')).to.be.undefined;
    });
    it('markExecuted + wasExecuted round-trip', async () => {
        expect(await store.wasExecuted('hash1')).to.be.false;
        await store.markExecuted('hash1', Date.now());
        expect(await store.wasExecuted('hash1')).to.be.true;
    });
    it('getAllCoordinatorStates returns all entries', async () => {
        await store.saveCoordinatorState('h1', makeCoordinatorState('h1'));
        await store.saveCoordinatorState('h2', makeCoordinatorState('h2'));
        const all = await store.getAllCoordinatorStates();
        expect(all).to.have.lengthOf(2);
    });
    it('getAllParticipantStates returns all entries', async () => {
        await store.saveParticipantState('h1', makeParticipantState('h1'));
        await store.saveParticipantState('h2', makeParticipantState('h2'));
        const all = await store.getAllParticipantStates();
        expect(all).to.have.lengthOf(2);
    });
    it('pruneExecuted removes old entries, keeps recent', async () => {
        const old = Date.now() - 60000;
        const recent = Date.now();
        await store.markExecuted('old-hash', old);
        await store.markExecuted('new-hash', recent);
        await store.pruneExecuted(Date.now() - 30000);
        expect(await store.wasExecuted('old-hash')).to.be.false;
        expect(await store.wasExecuted('new-hash')).to.be.true;
    });
    it('delete of non-existent key is no-op', async () => {
        // Should not throw
        await store.deleteCoordinatorState('nonexistent');
        await store.deleteParticipantState('nonexistent');
    });
});
// ─── PersistentTransactionStateStore tests ───
describe('PersistentTransactionStateStore', function () {
    let kvStore;
    let store;
    beforeEach(() => {
        kvStore = new MemoryKVStore();
        store = new PersistentTransactionStateStore(kvStore);
    });
    it('save/get/delete coordinator state round-trip', async () => {
        const state = makeCoordinatorState('hash1');
        await store.saveCoordinatorState('hash1', state);
        const loaded = await store.getCoordinatorState('hash1');
        expect(loaded).to.not.be.undefined;
        expect(loaded.messageHash).to.equal(state.messageHash);
        expect(loaded.phase).to.equal(state.phase);
        expect(loaded.record.messageHash).to.equal(state.record.messageHash);
        await store.deleteCoordinatorState('hash1');
        expect(await store.getCoordinatorState('hash1')).to.be.undefined;
    });
    it('save/get/delete participant state round-trip', async () => {
        const state = makeParticipantState('hash1');
        await store.saveParticipantState('hash1', state);
        const loaded = await store.getParticipantState('hash1');
        expect(loaded).to.not.be.undefined;
        expect(loaded.messageHash).to.equal(state.messageHash);
        expect(loaded.record.messageHash).to.equal(state.record.messageHash);
        await store.deleteParticipantState('hash1');
        expect(await store.getParticipantState('hash1')).to.be.undefined;
    });
    it('markExecuted + wasExecuted round-trip', async () => {
        expect(await store.wasExecuted('hash1')).to.be.false;
        await store.markExecuted('hash1', Date.now());
        expect(await store.wasExecuted('hash1')).to.be.true;
    });
    it('getAllCoordinatorStates returns all entries', async () => {
        await store.saveCoordinatorState('h1', makeCoordinatorState('h1'));
        await store.saveCoordinatorState('h2', makeCoordinatorState('h2'));
        const all = await store.getAllCoordinatorStates();
        expect(all).to.have.lengthOf(2);
        const hashes = all.map(s => s.messageHash);
        expect(hashes).to.include('h1');
        expect(hashes).to.include('h2');
    });
    it('getAllParticipantStates returns all entries', async () => {
        await store.saveParticipantState('h1', makeParticipantState('h1'));
        await store.saveParticipantState('h2', makeParticipantState('h2'));
        const all = await store.getAllParticipantStates();
        expect(all).to.have.lengthOf(2);
    });
    it('pruneExecuted removes old entries, keeps recent', async () => {
        const old = Date.now() - 60000;
        const recent = Date.now();
        await store.markExecuted('old-hash', old);
        await store.markExecuted('new-hash', recent);
        await store.pruneExecuted(Date.now() - 30000);
        expect(await store.wasExecuted('old-hash')).to.be.false;
        expect(await store.wasExecuted('new-hash')).to.be.true;
    });
    it('delete of non-existent key is no-op', async () => {
        await store.deleteCoordinatorState('nonexistent');
        await store.deleteParticipantState('nonexistent');
    });
    it('concurrent writes to different keys', async () => {
        await Promise.all([
            store.saveCoordinatorState('h1', makeCoordinatorState('h1')),
            store.saveCoordinatorState('h2', makeCoordinatorState('h2')),
            store.saveParticipantState('h3', makeParticipantState('h3'))
        ]);
        expect(await store.getCoordinatorState('h1')).to.not.be.undefined;
        expect(await store.getCoordinatorState('h2')).to.not.be.undefined;
        expect(await store.getParticipantState('h3')).to.not.be.undefined;
    });
    it('persists through JSON serialization correctly', async () => {
        const state = makeCoordinatorState('hash1', 'broadcasting');
        await store.saveCoordinatorState('hash1', state);
        // Verify the raw KV store has JSON content
        const raw = await kvStore.get('coordinator/hash1');
        expect(raw).to.be.a('string');
        const parsed = JSON.parse(raw);
        expect(parsed.phase).to.equal('broadcasting');
        expect(parsed.retryState).to.deep.equal({ pendingPeers: ['peer-2'], attempt: 1, intervalMs: 2000 });
    });
});
// ─── Recovery scenario tests ───
describe('ClusterCoordinator recovery', function () {
    // We test recovery through the PersistentTransactionStateStore + MemoryKVStore
    // since the coordinator recovery logic is tested via its stateStore integration
    let kvStore;
    let store;
    beforeEach(() => {
        kvStore = new MemoryKVStore();
        store = new PersistentTransactionStateStore(kvStore);
    });
    it('expired coordinator states can be detected and cleaned', async () => {
        const expiredMessage = makeMessage('block-1', Date.now() - 10000);
        const state = {
            messageHash: 'expired-hash',
            record: makeRecord('expired-hash', expiredMessage),
            lastUpdate: Date.now() - 20000,
            phase: 'promising'
        };
        await store.saveCoordinatorState('expired-hash', state);
        // Simulate recovery: load all, detect expired, delete
        const states = await store.getAllCoordinatorStates();
        for (const s of states) {
            if (s.record.message.expiration && s.record.message.expiration < Date.now()) {
                await store.deleteCoordinatorState(s.messageHash);
            }
        }
        expect(await store.getCoordinatorState('expired-hash')).to.be.undefined;
    });
    it('broadcasting phase state preserves retry info for resumption', async () => {
        const state = makeCoordinatorState('broadcast-hash', 'broadcasting');
        await store.saveCoordinatorState('broadcast-hash', state);
        const loaded = await store.getCoordinatorState('broadcast-hash');
        expect(loaded).to.not.be.undefined;
        expect(loaded.phase).to.equal('broadcasting');
        expect(loaded.retryState).to.not.be.undefined;
        expect(loaded.retryState.pendingPeers).to.include('peer-2');
        expect(loaded.retryState.attempt).to.equal(1);
    });
    it('promising/committing phase states are non-resumable — can be cleaned up', async () => {
        await store.saveCoordinatorState('promising-hash', makeCoordinatorState('promising-hash', 'promising'));
        await store.saveCoordinatorState('committing-hash', makeCoordinatorState('committing-hash', 'committing'));
        const states = await store.getAllCoordinatorStates();
        for (const s of states) {
            if (s.phase === 'promising' || s.phase === 'committing') {
                await store.deleteCoordinatorState(s.messageHash);
            }
        }
        expect(await store.getCoordinatorState('promising-hash')).to.be.undefined;
        expect(await store.getCoordinatorState('committing-hash')).to.be.undefined;
    });
});
describe('ClusterMember recovery', function () {
    let kvStore;
    let store;
    beforeEach(() => {
        kvStore = new MemoryKVStore();
        store = new PersistentTransactionStateStore(kvStore);
    });
    it('executed transactions restored — wasExecuted returns true', async () => {
        await store.markExecuted('exec-hash-1', Date.now());
        await store.markExecuted('exec-hash-2', Date.now());
        // Simulate recovery: wasExecuted should return true
        expect(await store.wasExecuted('exec-hash-1')).to.be.true;
        expect(await store.wasExecuted('exec-hash-2')).to.be.true;
        expect(await store.wasExecuted('never-executed')).to.be.false;
    });
    it('active participant states restored with future expiration', async () => {
        const futureExpiration = Date.now() + 60000;
        const message = makeMessage('block-1', futureExpiration);
        const state = {
            messageHash: 'active-hash',
            record: makeRecord('active-hash', message),
            lastUpdate: Date.now()
        };
        await store.saveParticipantState('active-hash', state);
        const loaded = await store.getAllParticipantStates();
        expect(loaded).to.have.lengthOf(1);
        expect(loaded[0].messageHash).to.equal('active-hash');
        expect(loaded[0].record.message.expiration).to.equal(futureExpiration);
    });
    it('expired participant states can be detected and cleaned', async () => {
        const expiredMessage = makeMessage('block-1', Date.now() - 10000);
        const state = {
            messageHash: 'expired-hash',
            record: makeRecord('expired-hash', expiredMessage),
            lastUpdate: Date.now() - 20000
        };
        await store.saveParticipantState('expired-hash', state);
        const states = await store.getAllParticipantStates();
        for (const s of states) {
            if (s.record.message.expiration && s.record.message.expiration < Date.now()) {
                await store.deleteParticipantState(s.messageHash);
            }
        }
        expect(await store.getParticipantState('expired-hash')).to.be.undefined;
    });
    it('double execution prevented — markExecuted is idempotent', async () => {
        await store.markExecuted('dedup-hash', Date.now());
        expect(await store.wasExecuted('dedup-hash')).to.be.true;
        // Mark again — should not throw
        await store.markExecuted('dedup-hash', Date.now());
        expect(await store.wasExecuted('dedup-hash')).to.be.true;
    });
    it('pruneExecuted removes old entries but keeps active', async () => {
        const old = Date.now() - 700000; // 11+ minutes ago
        const recent = Date.now() - 100000; // ~1.6 minutes ago
        await store.markExecuted('old-hash', old);
        await store.markExecuted('recent-hash', recent);
        // Prune entries older than 10 minutes
        await store.pruneExecuted(Date.now() - 600000);
        expect(await store.wasExecuted('old-hash')).to.be.false;
        expect(await store.wasExecuted('recent-hash')).to.be.true;
    });
    it('recovery verifies both in-memory state and persistent store', async () => {
        // Save state
        const state = makeParticipantState('verify-hash');
        await store.saveParticipantState('verify-hash', state);
        await store.markExecuted('verify-exec', Date.now());
        // Verify persistent store has data
        expect(await store.getParticipantState('verify-hash')).to.not.be.undefined;
        expect(await store.wasExecuted('verify-exec')).to.be.true;
        // Delete participant state (simulating consensus reached)
        await store.deleteParticipantState('verify-hash');
        expect(await store.getParticipantState('verify-hash')).to.be.undefined;
        // But executed guard remains
        expect(await store.wasExecuted('verify-exec')).to.be.true;
    });
});
//# sourceMappingURL=transaction-state-store.spec.js.map