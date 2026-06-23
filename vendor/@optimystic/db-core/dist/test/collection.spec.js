import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
use(chaiAsPromised);
import { Collection } from '../src/collection/index.js';
import { TestTransactor } from './test-transactor.js';
describe('Collection', () => {
    let transactor;
    const collectionId = 'test-collection';
    // Action handlers for testing
    const handlers = {
        'set': async (_action, store) => {
            const blockId = store.generateId();
            store.insert({
                header: store.createBlockHeader('TEST', blockId)
            });
        },
        'update': async (_action, _store) => {
            // No-op for testing
        }
    };
    // Collection initialization options
    const initOptions = {
        modules: handlers,
        createHeaderBlock: (id, store) => ({
            header: store.createBlockHeader('TEST', id)
        })
    };
    beforeEach(() => {
        transactor = new TestTransactor();
    });
    it('should create a new collection', async () => {
        const collection = await Collection.createOrOpen(transactor, collectionId, initOptions);
        expect(collection.id).to.equal(collectionId);
    });
    it('should open an existing collection', async () => {
        // Create first instance and sync it to transactor
        const collection1 = await Collection.createOrOpen(transactor, collectionId, initOptions);
        await collection1.updateAndSync(); // Sync to transactor so collection2 can see it
        // Open existing collection
        const collection2 = await Collection.createOrOpen(transactor, collectionId, initOptions);
        const actions = [];
        for await (const logAction of collection2.selectLog()) {
            actions.push(logAction);
        }
        expect(actions).to.have.lengthOf(0);
        expect(collection2.id).to.equal(collection1.id);
        // Verify they share state by adding an action to collection1 and reading from collection2
        const action = {
            type: 'set',
            data: {
                value: 'test value',
                timestamp: Date.now()
            }
        };
        await collection1.act(action);
        await collection1.updateAndSync();
        // collection2 should be able to see the action after updating
        await collection2.update();
        actions.length = 0;
        for await (const logAction of collection2.selectLog()) {
            actions.push(logAction);
        }
        expect(actions).to.have.lengthOf(1);
        expect(actions[0]).to.deep.equal(action);
    });
    it('should handle single action transaction', async () => {
        const collection = await Collection.createOrOpen(transactor, collectionId, initOptions);
        const action = {
            type: 'set',
            data: {
                value: 'test value',
                timestamp: Date.now()
            }
        };
        await collection.act(action);
        await collection.updateAndSync();
        // Verify action is in the log
        const actions = [];
        for await (const logAction of collection.selectLog()) {
            actions.push(logAction);
        }
        expect(actions).to.have.lengthOf(1);
        expect(actions[0]).to.deep.equal(action);
    });
    it('should handle multiple action transactions', async () => {
        const collection = await Collection.createOrOpen(transactor, collectionId, initOptions);
        const actions = Array(3).fill(0).map((_, i) => ({
            type: 'set',
            data: {
                value: `value ${i + 1}`,
                timestamp: Date.now() + i
            }
        }));
        await collection.act(...actions);
        await collection.updateAndSync();
        // Verify actions are in the log
        const logActions = [];
        for await (const action of collection.selectLog()) {
            logActions.push(action);
        }
        expect(logActions).to.have.lengthOf(actions.length);
        expect(logActions).to.deep.equal(actions);
    });
    it('should handle reverse log iteration', async () => {
        const collection = await Collection.createOrOpen(transactor, collectionId, initOptions);
        const actions = Array(3).fill(0).map((_, i) => ({
            type: 'set',
            data: {
                value: `value ${i + 1}`,
                timestamp: Date.now() + i
            }
        }));
        for (const action of actions) {
            await collection.act(action);
        }
        await collection.updateAndSync();
        // Verify reverse order
        const logActions = [];
        for await (const action of collection.selectLog(false)) {
            logActions.push(action);
        }
        expect(logActions).to.have.lengthOf(actions.length);
        expect(logActions).to.deep.equal([...actions].reverse());
    });
    it('should handle reverse synced log iteration', async () => {
        const collection = await Collection.createOrOpen(transactor, collectionId, initOptions);
        const actions = Array(3).fill(0).map((_, i) => ({
            type: 'set',
            data: {
                value: `value ${i + 1}`,
                timestamp: Date.now() + i
            }
        }));
        for (const action of actions) {
            await collection.act(action);
            await collection.sync();
        }
        // Verify reverse order
        const logActions = [];
        for await (const action of collection.selectLog(false)) {
            logActions.push(action);
        }
        expect(logActions).to.have.lengthOf(actions.length);
        expect(logActions).to.deep.equal([...actions].reverse());
    });
    it('should resolve concurrent creation (first synced wins)', async () => {
        const collection1 = await Collection.createOrOpen(transactor, collectionId, initOptions);
        const collection2 = await Collection.createOrOpen(transactor, collectionId, initOptions);
        await collection1.sync();
        // Second collection should succeed because it should recognize the log file conflict and update.
        await collection2.sync();
    });
    it('should allow operations on losing collection after concurrent creation', async () => {
        const collection1 = await Collection.createOrOpen(transactor, collectionId, initOptions);
        const collection2 = await Collection.createOrOpen(transactor, collectionId, initOptions);
        // collection1 wins the creation race
        await collection1.sync();
        // collection2 loses, recovers
        await collection2.sync();
        // collection2 should be usable after recovery
        const action = {
            type: 'set',
            data: { value: 'post-recovery', timestamp: Date.now() }
        };
        await collection2.act(action);
        await collection2.sync();
        // collection1 should see collection2's action after updating
        await collection1.update();
        const actions = [];
        for await (const a of collection1.selectLog()) {
            actions.push(a);
        }
        expect(actions).to.have.lengthOf(1);
        expect(actions[0].data.value).to.equal('post-recovery');
    });
    it('should resolve concurrent creation with pending data on both peers', async () => {
        const collection1 = await Collection.createOrOpen(transactor, collectionId, initOptions);
        const collection2 = await Collection.createOrOpen(transactor, collectionId, initOptions);
        // Both peers add data before either syncs
        const action1 = {
            type: 'set',
            data: { value: 'peer1-data', timestamp: 1 }
        };
        const action2 = {
            type: 'set',
            data: { value: 'peer2-data', timestamp: 2 }
        };
        await collection1.act(action1);
        await collection2.act(action2);
        // collection1 syncs first (wins creation, commits action1)
        await collection1.sync();
        // collection2 syncs (loses creation, should recover and commit action2)
        await collection2.updateAndSync();
        // Both should converge
        await collection1.update();
        await collection2.update();
        const actions1 = [];
        for await (const a of collection1.selectLog()) {
            actions1.push(a);
        }
        const actions2 = [];
        for await (const a of collection2.selectLog()) {
            actions2.push(a);
        }
        expect(actions1).to.have.lengthOf(2);
        expect(actions2).to.have.lengthOf(2);
        expect(new Set(actions1.map(a => a.data.value)))
            .to.deep.equal(new Set(['peer1-data', 'peer2-data']));
        expect(new Set(actions2.map(a => a.data.value)))
            .to.deep.equal(new Set(['peer1-data', 'peer2-data']));
    });
    it('should handle latch-serialized concurrent sync after concurrent creation', async () => {
        const collection1 = await Collection.createOrOpen(transactor, collectionId, initOptions);
        const collection2 = await Collection.createOrOpen(transactor, collectionId, initOptions);
        const action1 = {
            type: 'set',
            data: { value: 'value 1', timestamp: Date.now() }
        };
        const action2 = {
            type: 'set',
            data: { value: 'value 2', timestamp: Date.now() + 1 }
        };
        await collection1.act(action1);
        await collection2.act(action2);
        // Both sync via Promise.all - serialized by shared latch
        await Promise.all([
            collection1.updateAndSync(),
            collection2.updateAndSync()
        ]);
        await collection1.update();
        await collection2.update();
        const actions1 = [];
        for await (const action of collection1.selectLog()) {
            actions1.push(action);
        }
        const actions2 = [];
        for await (const action of collection2.selectLog()) {
            actions2.push(action);
        }
        // Both collections should see both actions
        expect(actions1).to.have.lengthOf(2);
        expect(actions2).to.have.lengthOf(2);
        expect(new Set(actions1.map(a => a.data.value)))
            .to.deep.equal(new Set(['value 1', 'value 2']));
        expect(new Set(actions2.map(a => a.data.value)))
            .to.deep.equal(new Set(['value 1', 'value 2']));
    });
    it('should handle multiple action types', async () => {
        const collection = await Collection.createOrOpen(transactor, collectionId, initOptions);
        const actions = [
            {
                type: 'set',
                data: {
                    value: 'initial value',
                    timestamp: Date.now()
                }
            },
            {
                type: 'update',
                data: {
                    value: 'updated value',
                    timestamp: Date.now() + 1
                }
            }
        ];
        await collection.act(...actions);
        await collection.updateAndSync();
        const logActions = [];
        for await (const action of collection.selectLog()) {
            logActions.push(action);
        }
        expect(logActions).to.have.lengthOf(2);
        expect(logActions.map(a => a.type)).to.deep.equal(['set', 'update']);
    });
    it('should handle large number of actions', async () => {
        const collection = await Collection.createOrOpen(transactor, collectionId, initOptions);
        const actionCount = 100;
        const actions = Array(actionCount).fill(0).map((_, i) => ({
            type: 'set',
            data: {
                value: `value ${i + 1}`,
                timestamp: Date.now() + i
            }
        }));
        // Add actions in batches
        const batchSize = 10;
        for (let i = 0; i < actions.length; i += batchSize) {
            const batch = actions.slice(i, i + batchSize);
            await collection.act(...batch);
            await collection.updateAndSync();
        }
        // Verify all actions are present
        const logActions = [];
        for await (const action of collection.selectLog()) {
            logActions.push(action);
        }
        expect(logActions).to.have.lengthOf(actionCount);
        expect(logActions.map(a => a.data.value))
            .to.deep.equal(actions.map(a => a.data.value));
    });
    it('should handle state recovery after failed sync', async () => {
        const collection = await Collection.createOrOpen(transactor, collectionId, initOptions);
        const action = {
            type: 'set',
            data: {
                value: 'test value',
                timestamp: Date.now()
            }
        };
        // Add action but don't sync
        await collection.act(action);
        // Simulate failed sync by making transactor temporarily unavailable
        transactor.setAvailable(false);
        const updatePromise = collection.updateAndSync();
        updatePromise.catch(() => { });
        await expect(updatePromise).to.be.rejected;
        // Restore transactor and retry
        transactor.setAvailable(true);
        await collection.updateAndSync();
        // Verify action was eventually synced
        const actions = [];
        for await (const logAction of collection.selectLog()) {
            actions.push(logAction);
        }
        expect(actions).to.have.lengthOf(1);
        expect(actions[0]).to.deep.equal(action);
    });
    // TEST-3.3.1: Collection conflict resolution tests (filterConflict callback behavior)
    describe('conflict resolution (TEST-3.3.1)', () => {
        it('should discard pending action when filterConflict returns undefined', async () => {
            const optionsWithFilter = {
                ...initOptions,
                filterConflict: (_action, _potential) => undefined
            };
            const collection1 = await Collection.createOrOpen(transactor, collectionId, optionsWithFilter);
            const collection2 = await Collection.createOrOpen(transactor, collectionId, optionsWithFilter);
            // Sync collection1 first to establish the log
            await collection1.updateAndSync();
            await collection2.update();
            // Add remote action via collection1
            const remoteAction = {
                type: 'set',
                data: { value: 'remote', timestamp: 1 }
            };
            await collection1.act(remoteAction);
            await collection1.sync();
            // Add local pending action to collection2
            const localAction = {
                type: 'set',
                data: { value: 'local', timestamp: 2 }
            };
            await collection2.act(localAction);
            // Update collection2 - should trigger filterConflict and discard the local action
            await collection2.updateAndSync();
            // Should only have the remote action (local was discarded)
            const actions = [];
            for await (const a of collection2.selectLog()) {
                actions.push(a);
            }
            expect(actions).to.have.lengthOf(1);
            expect(actions[0]?.data.value).to.equal('remote');
        });
        it('should keep pending action when filterConflict returns original action', async () => {
            const optionsWithFilter = {
                ...initOptions,
                filterConflict: (action, _potential) => action
            };
            const collection1 = await Collection.createOrOpen(transactor, collectionId, optionsWithFilter);
            const collection2 = await Collection.createOrOpen(transactor, collectionId, optionsWithFilter);
            await collection1.updateAndSync();
            await collection2.update();
            const remoteAction = {
                type: 'set',
                data: { value: 'remote', timestamp: 1 }
            };
            await collection1.act(remoteAction);
            await collection1.sync();
            const localAction = {
                type: 'set',
                data: { value: 'local', timestamp: 2 }
            };
            await collection2.act(localAction);
            // Update and sync collection2 - filterConflict keeps local action
            await collection2.updateAndSync();
            const actions = [];
            for await (const a of collection2.selectLog()) {
                actions.push(a);
            }
            // Remote + local both present
            expect(actions).to.have.lengthOf(2);
            expect(actions.map(a => a.data.value)).to.include('remote');
            expect(actions.map(a => a.data.value)).to.include('local');
        });
        it('should keep pending when no filterConflict provided', async () => {
            const collection1 = await Collection.createOrOpen(transactor, collectionId, initOptions);
            const collection2 = await Collection.createOrOpen(transactor, collectionId, initOptions);
            await collection1.updateAndSync();
            await collection2.update();
            await collection1.act({ type: 'set', data: { value: 'remote', timestamp: 1 } });
            await collection1.sync();
            await collection2.act({ type: 'set', data: { value: 'local', timestamp: 2 } });
            await collection2.updateAndSync();
            const actions = [];
            for await (const a of collection2.selectLog()) {
                actions.push(a);
            }
            expect(actions).to.have.lengthOf(2);
        });
    });
    // TEST-3.3.2: Concurrent sync() tests
    describe('concurrent sync (TEST-3.3.2)', () => {
        it('should serialize concurrent sync calls via latch', async () => {
            const collection = await Collection.createOrOpen(transactor, collectionId, initOptions);
            for (let i = 0; i < 5; i++) {
                await collection.act({
                    type: 'set',
                    data: { value: `value-${i}`, timestamp: Date.now() + i }
                });
            }
            // Trigger multiple syncs concurrently - they should serialize
            await Promise.all([
                collection.updateAndSync(),
                collection.updateAndSync(),
                collection.updateAndSync()
            ]);
            const actions = [];
            for await (const a of collection.selectLog()) {
                actions.push(a);
            }
            expect(actions).to.have.lengthOf(5);
        });
        it('should handle act during sync', async () => {
            const collection = await Collection.createOrOpen(transactor, collectionId, initOptions);
            await collection.act({ type: 'set', data: { value: 'before-sync', timestamp: 1 } });
            // Start sync
            const syncPromise = collection.updateAndSync();
            // Add action during sync (will be queued due to latch)
            const actPromise = collection.act({ type: 'set', data: { value: 'during-sync', timestamp: 2 } });
            await syncPromise;
            await actPromise;
            await collection.updateAndSync();
            const actions = [];
            for await (const a of collection.selectLog()) {
                actions.push(a);
            }
            expect(actions).to.have.lengthOf(2);
        });
    });
    describe('context bootstrap on collection open', () => {
        /**
         * PartialCommitTransactor wraps a TestTransactor to simulate partial commits:
         * when partialMode is ON, commit() only commits the header and tail blocks,
         * leaving the rest as pending. This reproduces the scenario where a commit
         * completed its tail but non-tail blocks are still in-flight.
         */
        class PartialCommitTransactor {
            inner;
            partialMode = false;
            constructor(inner) {
                this.inner = inner;
            }
            get(b) { return this.inner.get(b); }
            getStatus(a) { return this.inner.getStatus(a); }
            pend(r) { return this.inner.pend(r); }
            cancel(a) { return this.inner.cancel(a); }
            async commit(request) {
                if (this.partialMode) {
                    // Only commit header + tail blocks, leaving the rest as pending
                    const committed = request.blockIds.filter(id => id === request.tailId || id === request.headerId);
                    return this.inner.commit({ ...request, blockIds: committed });
                }
                return this.inner.commit(request);
            }
        }
        it('should bootstrap context and open collection with pending non-tail blocks', async () => {
            const inner = new TestTransactor();
            const partial = new PartialCommitTransactor(inner);
            // Create and sync collection normally (partialMode OFF)
            const c1 = await Collection.createOrOpen(partial, collectionId, initOptions);
            await c1.updateAndSync();
            // Add enough entries in separate syncs to fill the first chain block (32 entries)
            // and overflow to a second, creating non-tail chain data blocks
            for (let i = 0; i < 34; i++) {
                await c1.act({ type: 'set', data: { value: `entry-${i}`, timestamp: i } });
                await c1.sync();
            }
            // Now enable partial commit mode: next sync only commits header + tail
            partial.partialMode = true;
            await c1.act({ type: 'set', data: { value: 'partial-entry', timestamp: 100 } });
            await c1.sync();
            // Open a fresh collection handle — without bootstrap fix this would fail
            // because chain walk reads non-tail blocks with context=undefined
            const c2 = await Collection.createOrOpen(partial, collectionId, initOptions);
            // Verify collection opened successfully and can read the log
            const actions = [];
            for await (const a of c2.selectLog()) {
                actions.push(a);
            }
            expect(actions.length).to.be.greaterThanOrEqual(35);
        });
        it('should bootstrap context in updateInternal with pending non-tail blocks', async () => {
            const inner = new TestTransactor();
            const partial = new PartialCommitTransactor(inner);
            // Create collection and sync normally
            const c1 = await Collection.createOrOpen(partial, collectionId, initOptions);
            await c1.updateAndSync();
            // Fill chain to overflow
            for (let i = 0; i < 34; i++) {
                await c1.act({ type: 'set', data: { value: `entry-${i}`, timestamp: i } });
                await c1.sync();
            }
            // Open a second handle while everything is committed
            const c2 = await Collection.createOrOpen(partial, collectionId, initOptions);
            // Now partial-commit a new entry on c1
            partial.partialMode = true;
            await c1.act({ type: 'set', data: { value: 'partial-entry', timestamp: 100 } });
            await c1.sync();
            // c2.update() should succeed — updateInternal bootstraps context from tail
            await c2.update();
            const actions = [];
            for await (const a of c2.selectLog()) {
                actions.push(a);
            }
            expect(actions.length).to.be.greaterThanOrEqual(35);
        });
        it('should handle createOrOpen with no prior commits (no bootstrap needed)', async () => {
            // Fresh collection with no prior commits should work fine — no tailId to bootstrap from
            const c = await Collection.createOrOpen(transactor, collectionId, initOptions);
            expect(c.id).to.equal(collectionId);
            // Should be able to add actions and sync
            await c.act({ type: 'set', data: { value: 'first', timestamp: 1 } });
            await c.updateAndSync();
            const actions = [];
            for await (const a of c.selectLog()) {
                actions.push(a);
            }
            expect(actions).to.have.lengthOf(1);
        });
    });
});
//# sourceMappingURL=collection.spec.js.map