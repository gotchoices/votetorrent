import { expect } from 'chai';
import { Log } from '../src/log/index.js';
import { TestLogStore } from './test-log-store.js';
import { generateNumericActionId } from './generate-numeric-action-id.js';
import { generateRandomActionId } from './generate-random-action-id.js';
describe('Log', () => {
    let store;
    beforeEach(() => {
        store = new TestLogStore();
    });
    it('should create and open a log', async () => {
        const log = await Log.create(store);
        expect(log.id).to.be.a('string');
        const openedLog = await Log.open(store, log.id);
        expect(openedLog?.id).to.equal(log.id);
    });
    it('should add and retrieve actions', async () => {
        const log = await Log.create(store);
        const actions = ['action1', 'action2'];
        const actionId = generateRandomActionId();
        const rev = 1;
        const result = await log.addActions(actions, actionId, rev, () => []);
        expect(result.entry.action?.actions).to.deep.equal(actions);
        expect(result.entry.action?.actionId).to.equal(actionId);
        expect(result.entry.rev).to.equal(rev);
        // Test retrieval
        const retrieved = await log.getFrom(0);
        expect(retrieved.entries[0]?.actions).to.deep.equal(actions);
        expect(retrieved.entries[0]?.actionId).to.equal(actionId);
        expect(retrieved.context?.rev).to.equal(rev);
        // Verify implicit commit behavior
        expect(retrieved.context?.committed.length).to.equal(1);
        expect(retrieved.context?.committed[0]?.actionId).to.equal(actionId);
        expect(retrieved.context?.committed[0]?.rev).to.equal(rev);
    });
    it('should handle log iteration', async () => {
        const log = await Log.create(store);
        // Add transactions
        const transactions = Array(5).fill(0).map((_, i) => ({
            actionId: generateNumericActionId(i + 1),
            rev: i + 1,
            actions: [`action-${i}`]
        }));
        for (const trx of transactions) {
            await log.addActions(trx.actions, trx.actionId, trx.rev, () => []);
        }
        // Test forward iteration
        let index = 0;
        for await (const entry of log.select()) {
            expect(entry.action?.actionId).to.equal(transactions[index].actionId);
            expect(entry.action?.actions).to.deep.equal(transactions[index].actions);
            index++;
        }
        expect(index).to.equal(transactions.length);
        // Test reverse iteration
        index = transactions.length - 1;
        for await (const entry of log.select(undefined, false)) {
            expect(entry.action?.actionId).to.equal(transactions[index].actionId);
            expect(entry.action?.actions).to.deep.equal(transactions[index].actions);
            index--;
        }
        expect(index).to.equal(-1);
    });
    it('should handle checkpoints', async () => {
        const log = await Log.create(store);
        // Add some actions first
        const trx1Id = generateNumericActionId(1);
        const trx2Id = generateNumericActionId(2);
        const trx3Id = generateNumericActionId(3);
        await log.addActions(['action1'], trx1Id, 1, () => []);
        await log.addActions(['action2'], trx2Id, 2, () => []);
        await log.addActions(['action3'], trx3Id, 3, () => []);
        // Verify implicit commits
        let context = await log.getActionContext();
        expect(context?.committed.length).to.equal(3);
        // Add checkpoint that excludes the last action
        const pendings = [
            { actionId: trx1Id, rev: 1 },
            { actionId: trx2Id, rev: 2 }
        ];
        const result = await log.addCheckpoint(pendings, 4);
        expect(result.entry.checkpoint?.pendings).to.deep.equal(pendings);
        expect(result.entry.rev).to.equal(4);
        // Verify checkpoint properly reset committed set
        context = await log.getActionContext();
        expect(context?.committed).to.deep.equal(pendings);
        expect(context?.rev).to.equal(4);
    });
    it('should handle mixed actions and checkpoints', async () => {
        const log = await Log.create(store);
        // Add initial actions
        const trx1 = generateNumericActionId(1);
        await log.addActions(['action1'], trx1, 1, () => []);
        const trx2 = generateNumericActionId(2);
        await log.addActions(['action2'], trx2, 2, () => []);
        // Verify implicit commits
        let context = await log.getActionContext();
        expect(context?.committed.length).to.equal(2);
        expect(context?.rev).to.equal(2);
        // Add checkpoint that only includes first action
        const pendings = [
            { actionId: trx1, rev: 1 }
        ];
        await log.addCheckpoint(pendings, 3);
        // Add more actions
        const trx3 = generateNumericActionId(3);
        await log.addActions(['action3'], trx3, 4, () => []);
        // Test retrieval and verify commit state
        const fromStart = await log.getFrom(0);
        expect(fromStart.entries.length).to.equal(3);
        // Should include checkpoint's action plus new action
        expect(fromStart.context?.committed.length).to.equal(2);
        expect(fromStart.context?.committed[0]).to.deep.equal({ actionId: trx1, rev: 1 });
        expect(fromStart.context?.committed[1]).to.deep.equal({ actionId: trx3, rev: 4 });
        const fromMiddle = await log.getFrom(2); // (exclusive of 2)
        expect(fromMiddle.entries.length).to.equal(1);
        expect(fromMiddle.context?.committed.length).to.equal(2);
    });
    it('should maintain block hashes correctly', async () => {
        const log = await Log.create(store);
        // Fill first block (32 entries) and start second block
        const actions = Array.from({ length: 33 }, (_, i) => `action${i + 1}`);
        const results = [];
        for (let i = 0; i < actions.length; i++) {
            results.push(await log.addActions([actions[i]], generateNumericActionId(i + 1), i + 1, () => []));
        }
        // Get the blocks directly from store to check hashes
        const firstBlock = (await store.tryGet(results[0].tailPath.block.header.id));
        const secondBlock = (await store.tryGet(results[32].tailPath.block.header.id));
        // Second block should have nextHash containing the hash of the first block
        expect(secondBlock.priorHash).to.exist;
        expect(typeof secondBlock.priorHash).to.equal('string');
        // First block should not have nextHash since nothing points to it
        expect(firstBlock.priorHash).to.be.undefined;
    });
    it('should handle empty log operations', async () => {
        const log = await Log.create(store);
        const context = await log.getActionContext();
        expect(context).to.be.undefined;
        const entries = await log.getFrom(0);
        expect(entries.entries).to.deep.equal([]);
        expect(entries.context).to.be.undefined;
    });
    it('should handle large number of sequential actions', async () => {
        const log = await Log.create(store);
        const actionCount = 100;
        // Add actions
        for (let i = 0; i < actionCount; i++) {
            await log.addActions([`action${i}`], generateNumericActionId(i), i + 1, () => []);
        }
        // Verify retrieval
        const retrieved = await log.getFrom(0);
        expect(retrieved.entries.length).to.equal(actionCount);
        expect(retrieved.context?.committed.length).to.equal(actionCount);
        // Verify last action
        const lastAction = retrieved.entries[actionCount - 1];
        expect(lastAction?.actions[0]).to.equal(`action${actionCount - 1}`);
    });
    it('should handle multiple checkpoints', async () => {
        const log = await Log.create(store);
        // Add several actions first - these will be implicitly committed
        await log.addActions(['action1'], generateNumericActionId(1), 1, () => []);
        await log.addActions(['action2'], generateNumericActionId(2), 2, () => []);
        await log.addActions(['action3'], generateNumericActionId(3), 3, () => []);
        // Verify implicit commits include all actions
        let context = await log.getActionContext();
        expect(context?.committed.length).to.equal(3);
        expect(context?.rev).to.equal(3);
        // Add a checkpoint that only includes the first two actions
        // This explicitly states what's committed, overriding the implicit behavior
        await log.addCheckpoint([
            { actionId: generateNumericActionId(1), rev: 1 },
            { actionId: generateNumericActionId(2), rev: 2 }
        ], 4);
        // Verify the checkpoint reduced the committed set
        context = await log.getActionContext();
        expect(context?.committed.length).to.equal(2);
        expect(context?.rev).to.equal(4);
        // Add more actions
        await log.addActions(['action4'], generateNumericActionId(4), 5, () => []);
        await log.addActions(['action5'], generateNumericActionId(5), 6, () => []);
        // Without a new checkpoint, these are implicitly added to committed set
        context = await log.getActionContext();
        expect(context?.committed.length).to.equal(4);
        expect(context?.rev).to.equal(6);
        // Add a new checkpoint that only keeps the most recent actions
        await log.addCheckpoint([
            { actionId: generateNumericActionId(4), rev: 5 },
            { actionId: generateNumericActionId(5), rev: 6 }
        ], 7);
        // Verify final state only includes explicitly checkpointed actions
        context = await log.getActionContext();
        expect(context?.committed.length).to.equal(2);
        expect(context?.rev).to.equal(7);
    });
    it('should handle retrieval from middle revisions', async () => {
        const log = await Log.create(store);
        // Add several actions
        const actionIds = [];
        for (let i = 1; i <= 5; i++) {
            const actionId = generateNumericActionId(i);
            actionIds.push(actionId);
            await log.addActions([`action${i}`], actionId, i, () => []);
        }
        // Add a checkpoint that only keeps first two actions
        await log.addCheckpoint([
            { actionId: actionIds[0], rev: 1 },
            { actionId: actionIds[1], rev: 2 }
        ], 6);
        // Retrieve from different points
        const fromRev2 = await log.getFrom(2);
        expect(fromRev2.entries.length).to.equal(3); // Actions 3,4,5
        expect(fromRev2.entries[0]?.actions?.[0]).to.equal('action3');
        // Context should reflect checkpoint state
        expect(fromRev2.context?.committed.length).to.equal(2);
        const actionId6 = generateNumericActionId(6);
        actionIds.push(actionId6);
        await log.addActions(['action6'], actionId6, 7, () => []);
        const fromRev4 = await log.getFrom(4);
        expect(fromRev4.entries.length).to.equal(2); // Action 5,6
        expect(fromRev4.entries[0]?.actions?.[0]).to.equal('action5');
        expect(fromRev4.entries[1]?.actions?.[0]).to.equal('action6');
        expect(fromRev4.context?.committed.length).to.equal(3);
        expect(fromRev4.context?.committed[0]).to.deep.equal({ actionId: actionIds[0], rev: 1 });
        expect(fromRev4.context?.committed[1]).to.deep.equal({ actionId: actionIds[1], rev: 2 });
        expect(fromRev4.context?.committed[2]).to.deep.equal({ actionId: actionId6, rev: 7 });
    });
    it('should properly track dirtied blocks via getBlockIds callback', async () => {
        const log = await Log.create(store);
        // Fill a block (32 entries) to force creation of new block
        const actions = Array.from({ length: 33 }, (_, i) => `action${i + 1}`);
        // Add entries one by one and verify block tracking
        for (let i = 0; i < actions.length; i++) {
            const result = await log.addActions([actions[i]], generateNumericActionId(i + 1), i + 1, () => store.getDirtiedBlockIds());
            // The action entry should list the blocks that were dirtied
            expect(result.entry.action?.blockIds).to.deep.equal(store.getDirtiedBlockIds());
            if (i <= 31) { // just header and tail
                expect(result.entry.action?.blockIds.length).to.equal(2);
            }
            else { // header, tail and next
                expect(result.entry.action?.blockIds.length).to.equal(3);
            }
        }
    });
    it('should handle concurrent transactions', async () => {
        const log = await Log.create(store);
        const trxCount = 5;
        const actionsPerTrx = 3;
        // Create multiple transactions concurrently
        const transactions = Array(trxCount).fill(0).map((_, i) => ({
            actionId: generateNumericActionId(i + 1),
            rev: i + 1,
            actions: Array(actionsPerTrx).fill(0).map((_, j) => `action-${i}-${j}`)
        }));
        // Execute transactions concurrently
        await Promise.all(transactions.map(trx => log.addActions(trx.actions, trx.actionId, trx.rev, () => [])));
        // Verify all actions were added
        const result = await log.getFrom(0);
        expect(result.entries).to.have.lengthOf(trxCount);
        // Create a map of transaction IDs to their expected actions for easier lookup
        const expectedActionsMap = new Map(transactions.map(trx => [trx.actionId, trx.actions]));
        // Verify each entry's actions match their corresponding transaction
        for (const entry of result.entries) {
            const expectedActions = expectedActionsMap.get(entry.actionId);
            expect(expectedActions).to.exist;
            expect(entry.actions).to.deep.equal(expectedActions);
        }
    });
    it('should create a log with existingHeaderId', async () => {
        // Insert a block to serve as the log header
        const existingBlock = { header: store.createBlockHeader('UH'), label: 'upstream' };
        store.insert(existingBlock);
        const log = await Log.create(store, { existingHeaderId: existingBlock.header.id });
        expect(log.id).to.equal(existingBlock.header.id);
        // Verify the log is fully functional
        const actionId = generateRandomActionId();
        await log.addActions(['action1'], actionId, 1, () => []);
        const result = await log.getFrom(0);
        expect(result.entries).to.have.lengthOf(1);
        expect(result.entries[0]?.actions[0]).to.equal('action1');
        // Verify upstream fields are preserved on the header block
        const headerBlock = await store.tryGet(existingBlock.header.id);
        expect(headerBlock.label).to.equal('upstream');
        expect(headerBlock.headId).to.exist;
        expect(headerBlock.tailId).to.exist;
    });
    // TEST-3.2.2: Log checkpoint consistency tests
    describe('checkpoint consistency (TEST-3.2.2)', () => {
        it('should handle checkpoint with empty pendings', async () => {
            const log = await Log.create(store);
            await log.addActions(['action1'], generateNumericActionId(1), 1, () => []);
            await log.addCheckpoint([], 2);
            const context = await log.getActionContext();
            expect(context?.committed).to.deep.equal([]);
            expect(context?.rev).to.equal(2);
        });
        it('should handle getFrom at exact checkpoint boundary', async () => {
            const log = await Log.create(store);
            const id1 = generateNumericActionId(1);
            const id2 = generateNumericActionId(2);
            const id3 = generateNumericActionId(3);
            await log.addActions(['action1'], id1, 1, () => []);
            await log.addActions(['action2'], id2, 2, () => []);
            await log.addCheckpoint([{ actionId: id1, rev: 1 }, { actionId: id2, rev: 2 }], 3);
            await log.addActions(['action3'], id3, 4, () => []);
            // getFrom at the checkpoint rev should return only action3
            const result = await log.getFrom(3);
            expect(result.entries).to.have.lengthOf(1);
            expect(result.entries[0]?.actions[0]).to.equal('action3');
        });
        it('should correctly rebuild context across checkpoint with subsequent actions', async () => {
            const log = await Log.create(store);
            const ids = Array.from({ length: 5 }, (_, i) => generateNumericActionId(i + 1));
            await log.addActions(['a1'], ids[0], 1, () => []);
            await log.addActions(['a2'], ids[1], 2, () => []);
            // Checkpoint only keeps action 1
            await log.addCheckpoint([{ actionId: ids[0], rev: 1 }], 3);
            await log.addActions(['a3'], ids[2], 4, () => []);
            await log.addActions(['a4'], ids[3], 5, () => []);
            const result = await log.getFrom(0);
            // Should return all actions from rev > 0
            expect(result.entries).to.have.lengthOf(4);
            // Context should have checkpoint pendings + subsequent actions
            expect(result.context?.committed).to.have.lengthOf(3); // id[0] from checkpoint + id[2] + id[3]
        });
        it('should handle sequential checkpoints overriding each other', async () => {
            const log = await Log.create(store);
            const id1 = generateNumericActionId(1);
            const id2 = generateNumericActionId(2);
            await log.addActions(['a1'], id1, 1, () => []);
            await log.addActions(['a2'], id2, 2, () => []);
            // First checkpoint: both committed
            await log.addCheckpoint([{ actionId: id1, rev: 1 }, { actionId: id2, rev: 2 }], 3);
            let context = await log.getActionContext();
            expect(context?.committed).to.have.lengthOf(2);
            // Second checkpoint: only id2 remains
            await log.addCheckpoint([{ actionId: id2, rev: 2 }], 4);
            context = await log.getActionContext();
            expect(context?.committed).to.have.lengthOf(1);
            expect(context?.committed[0]?.actionId).to.equal(id2);
        });
        it('should handle getFrom spanning before and after checkpoint', async () => {
            const log = await Log.create(store);
            const id1 = generateNumericActionId(1);
            const id2 = generateNumericActionId(2);
            const id3 = generateNumericActionId(3);
            await log.addActions(['before-cp'], id1, 1, () => []);
            await log.addCheckpoint([{ actionId: id1, rev: 1 }], 2);
            await log.addActions(['after-cp-1'], id2, 3, () => []);
            await log.addActions(['after-cp-2'], id3, 4, () => []);
            // From rev 0 should include all actions
            const fromStart = await log.getFrom(0);
            expect(fromStart.entries).to.have.lengthOf(3);
            expect(fromStart.entries[0]?.actions[0]).to.equal('before-cp');
            expect(fromStart.entries[1]?.actions[0]).to.equal('after-cp-1');
            expect(fromStart.entries[2]?.actions[0]).to.equal('after-cp-2');
            // From rev 2 (at checkpoint) should return only post-checkpoint actions
            const fromCheckpoint = await log.getFrom(2);
            expect(fromCheckpoint.entries).to.have.lengthOf(2);
            expect(fromCheckpoint.entries[0]?.actions[0]).to.equal('after-cp-1');
        });
    });
});
//# sourceMappingURL=log.spec.js.map