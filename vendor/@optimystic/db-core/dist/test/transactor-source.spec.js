import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
use(chaiAsPromised);
import { TransactorSource } from '../src/transactor/transactor-source.js';
import { TestTransactor } from './test-transactor.js';
import { randomBytes } from '@libp2p/crypto';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
describe('TransactorSource', () => {
    let network;
    let source;
    const collectionId = 'test-collection';
    // Helper to create a valid block operation
    const createBlockOperation = (inserted = 'new-test-value') => ['test', 0, 0, [inserted]];
    // Helper to generate a random action ID
    const generateActionId = () => uint8ArrayToString(randomBytes(16), 'base64url');
    beforeEach(() => {
        network = new TestTransactor();
        source = new TransactorSource(collectionId, network, undefined);
    });
    it('should create block headers with correct properties', () => {
        const type = 'TEST';
        const header = source.createBlockHeader(type);
        expect(header.type).to.equal(type);
        expect(header.id).to.be.a('string');
        expect(header.collectionId).to.equal(collectionId);
    });
    it('should generate unique block IDs', () => {
        const id1 = source.generateId();
        const id2 = source.generateId();
        expect(id1).to.be.a('string');
        expect(id2).to.be.a('string');
        expect(id1).to.not.equal(id2);
    });
    it('should retrieve blocks from network', async () => {
        const blockId = 'test-block';
        const block = {
            header: {
                id: blockId,
                type: 'TEST',
                collectionId
            }
        };
        const pendingActionId = generateActionId();
        // Add block to network
        await network.pend({
            actionId: pendingActionId,
            transforms: {
                inserts: { [blockId]: block },
                updates: {},
                deletes: []
            },
            policy: 'c'
        });
        await network.commit({
            actionId: pendingActionId,
            blockIds: [blockId],
            rev: 1,
            tailId: blockId
        });
        const retrieved = await source.tryGet(blockId);
        expect(retrieved).to.deep.equal(block);
    });
    it('should handle missing blocks', async () => {
        const retrieved = await source.tryGet('non-existent');
        expect(retrieved).to.be.undefined;
    });
    it('should handle transaction context in block retrieval', async () => {
        const blockId = 'test-block';
        const trxContext = {
            committed: [{ actionId: generateActionId(), rev: 1 }],
            rev: 1
        };
        source = new TransactorSource(collectionId, network, trxContext);
        const retrieved = await source.tryGet(blockId);
        expect(retrieved).to.be.undefined;
    });
    it('should handle successful transaction lifecycle', async () => {
        const blockId = 'test-block';
        const actionId = generateActionId();
        // First operation has to be an insert for a non-existing block
        const transform = {
            inserts: { [blockId]: { header: { id: blockId, type: 'block', collectionId: 'test' } } },
            updates: {},
            deletes: []
        };
        const result = await source.transact(transform, actionId, 1, blockId, blockId);
        expect(result).to.be.undefined;
        const pendingActions = network.getPendingActions();
        expect(pendingActions.size).to.equal(0); // Should be committed
        const committedActions = network.getCommittedActions();
        expect(committedActions.size).to.equal(1);
        expect(committedActions.has(actionId)).to.be.true;
    });
    it('should handle failed pend operation', async () => {
        const blockId = 'test-block';
        const actionId1 = generateActionId();
        const actionId2 = generateActionId();
        // Create a pending action with an insert
        await network.pend({
            actionId: actionId1,
            transforms: {
                inserts: { [blockId]: { header: { id: blockId, type: 'block', collectionId: 'test' } } },
                updates: {},
                deletes: []
            },
            policy: 'c'
        });
        // Try to create another action with an update
        const transform = {
            inserts: {},
            updates: { [blockId]: [createBlockOperation()] },
            deletes: []
        };
        const result = await source.transact(transform, actionId2, 1, blockId, blockId);
        expect(result).to.not.be.undefined;
        expect(result?.success).to.be.false;
        expect(result?.pending && result.pending.length === 1).to.be.true;
    });
    it('should handle failed commit operation', async () => {
        const blockId = 'test-block';
        const actionId = generateActionId();
        // First create the block with an insert
        await network.pend({
            actionId,
            transforms: {
                inserts: { [blockId]: { header: { id: blockId, type: 'block', collectionId: 'test' } } },
                updates: {},
                deletes: []
            },
            policy: 'c'
        });
        // Commit under later revision
        await network.commit({
            headerId: 'header-id',
            tailId: 'tail-id',
            blockIds: [blockId],
            actionId,
            rev: 2
        });
        // Then update it
        const transform = {
            inserts: {},
            updates: { [blockId]: [createBlockOperation()] },
            deletes: []
        };
        // Try to commit with a stale revision
        const result = await source.transact(transform, generateActionId(), 1, blockId, blockId);
        expect(result).to.not.be.undefined;
        expect(result?.success).to.be.false;
        expect(result?.missing && result.missing.length === 1).to.be.true;
    });
    it('should handle action rollback', async () => {
        const blockId = 'test-block';
        // Create and commit the block
        const insertActionId = generateActionId();
        await network.pend({
            actionId: insertActionId,
            transforms: {
                inserts: { [blockId]: { header: { id: blockId, type: 'block', collectionId: 'test' }, test: [] } },
                updates: {},
                deletes: []
            },
            policy: 'c'
        });
        await network.commit({ actionId: insertActionId, blockIds: [blockId], tailId: blockId, rev: 1 });
        // Start an update action
        const updateActionId = generateActionId();
        const transform = {
            inserts: {},
            updates: { [blockId]: [createBlockOperation()] },
            deletes: []
        };
        await network.pend({
            actionId: updateActionId,
            transforms: transform,
            policy: 'c'
        });
        // Rollback the update action
        await network.cancel({
            actionId: updateActionId,
            blockIds: [blockId]
        });
        // Verify block is available for new actions
        const newActionId = generateActionId();
        const result = await source.transact(transform, newActionId, 2, 'header-id', 'tail-id');
        expect(result).to.be.undefined;
    });
    it('should handle concurrent actions on different blocks', async () => {
        const blockId1 = 'test-block-1';
        const blockId2 = 'test-block-2';
        const actionId1 = generateActionId();
        const actionId2 = generateActionId();
        // First create both blocks with inserts
        await Promise.all([
            network.pend({
                actionId: actionId1,
                transforms: {
                    inserts: { [blockId1]: { header: { id: blockId1, type: 'block', collectionId: 'test' }, test: [] } },
                    updates: {},
                    deletes: []
                },
                policy: 'c'
            }),
            network.pend({
                actionId: actionId2,
                transforms: {
                    inserts: { [blockId2]: { header: { id: blockId2, type: 'block', collectionId: 'test' }, test: [] } },
                    updates: {},
                    deletes: []
                },
                policy: 'c'
            })
        ]);
        // Commit both blocks
        await Promise.all([
            network.commit({
                actionId: actionId1,
                blockIds: [blockId1],
                rev: 1,
                tailId: blockId1
            }),
            network.commit({
                actionId: actionId2,
                blockIds: [blockId2],
                rev: 1,
                tailId: blockId2
            })
        ]);
        const transform1 = {
            inserts: {},
            updates: { [blockId1]: [createBlockOperation()] },
            deletes: []
        };
        const transform2 = {
            inserts: {},
            updates: { [blockId2]: [createBlockOperation()] },
            deletes: []
        };
        // Execute update actions concurrently
        const [result1, result2] = await Promise.all([
            source.transact(transform1, generateActionId(), 2, 'header-id', 'tail-id'),
            source.transact(transform2, generateActionId(), 2, 'header-id', 'tail-id')
        ]);
        expect(result1).to.be.undefined;
        expect(result2).to.be.undefined;
        const block1 = await source.tryGet(blockId1);
        const block2 = await source.tryGet(blockId2);
        expect(block1?.test).to.deep.equal(['new-test-value']);
        expect(block2?.test).to.deep.equal(['new-test-value']);
    });
    it('should prioritize headerId and tailId in transaction processing', async () => {
        const headerId = 'header-block';
        const tailId = 'tail-block';
        const contentId = 'content-block';
        // Create initial blocks
        const initialTransform = {
            inserts: {
                [headerId]: { header: { id: headerId, type: 'header', collectionId: 'test' }, test: [] },
                [tailId]: { header: { id: tailId, type: 'tail', collectionId: 'test' }, test: [] },
                [contentId]: { header: { id: contentId, type: 'content', collectionId: 'test' }, test: [] }
            },
            updates: {},
            deletes: []
        };
        // Insert initial blocks
        const initialActionId = generateActionId();
        await source.transact(initialTransform, initialActionId, 1, headerId, tailId);
        // First action updates header and tail
        const actionId1 = generateActionId();
        const transform1 = {
            inserts: {},
            updates: {
                [headerId]: [createBlockOperation('header-update-1')],
                [tailId]: [createBlockOperation('tail-update-1')]
            },
            deletes: []
        };
        // Start first action
        const result1 = await source.transact(transform1, actionId1, 2, headerId, tailId);
        expect(result1).to.be.undefined;
        // Second action tries to update header and tail (should fail due to conflict)
        const actionId2 = generateActionId();
        const transform2 = {
            inserts: {},
            updates: {
                [headerId]: [createBlockOperation('header-update-2')],
                [tailId]: [createBlockOperation('tail-update-2')]
            },
            deletes: []
        };
        // Start second action (using same rev=2)
        const result2 = await source.transact(transform2, actionId2, 2, headerId, tailId);
        expect(result2).to.not.be.undefined;
        expect(result2?.success).to.be.false;
        // Check that first action's changes are still applied
        const headerBlock = await source.tryGet(headerId);
        const tailBlock = await source.tryGet(tailId);
        expect(headerBlock?.test).to.deep.equal(['header-update-1']);
        expect(tailBlock?.test).to.deep.equal(['tail-update-1']);
        // Verify that the second action is no longer pending
        const pending = network.getPendingActions();
        expect(pending.size).to.equal(0);
    });
    it('should handle update operations only on existing blocks', async () => {
        const blockId = 'test-block';
        const actionId = generateActionId();
        // Try to update a non-existent block
        const updateTransform = {
            inserts: {},
            updates: { [blockId]: [createBlockOperation()] },
            deletes: []
        };
        // This should fail because the block doesn't exist
        // Error should look like: Error: Commit Error: Transaction dPWSdMgzCagwbE2ERPUi7A has no insert for new block test-block
        const transactPromise = source.transact(updateTransform, actionId, 1, 'header-id', 'tail-id');
        transactPromise.catch(() => { });
        await expect(transactPromise).to.be.rejected;
        // Now create the block with an insert
        const insertTransform = {
            inserts: { [blockId]: { header: { id: blockId, type: 'block', collectionId: 'test' }, test: [] } },
            updates: {},
            deletes: []
        };
        const insertResult = await source.transact(insertTransform, generateActionId(), 1, 'header-id', 'tail-id');
        expect(insertResult).to.be.undefined;
        // Now update the block
        const updateResult = await source.transact(updateTransform, generateActionId(), 2, 'header-id', 'tail-id');
        expect(updateResult).to.be.undefined;
    });
    describe('Version Conflict and Stale Read Tests (TEST-4.2.1)', () => {
        it('should cancel pending action when commit fails', async () => {
            const transactor = new TestTransactor();
            const src = new TransactorSource('coll', transactor, undefined);
            const blockId = 'leak-block';
            const actionId = generateActionId();
            // Setup: insert and commit a block at rev 1
            await transactor.pend({
                actionId: 'init',
                transforms: { inserts: { [blockId]: { header: { id: blockId, type: 'T', collectionId: 'coll' } } }, updates: {}, deletes: [] },
                policy: 'c',
            });
            await transactor.commit({ actionId: 'init', blockIds: [blockId], tailId: blockId, rev: 1 });
            // Sabotage: make commit always fail while pend succeeds
            const originalCommit = transactor.commit.bind(transactor);
            transactor.commit = async (_req) => {
                return { success: false, missing: [{ actionId: 'phantom', rev: 99, transforms: { inserts: {}, updates: {}, deletes: [] } }] };
            };
            // transact: pend will succeed, commit will fail
            const updateTransforms = {
                inserts: {},
                updates: { [blockId]: [['data', 0, 0, 'leaked']] },
                deletes: [],
            };
            const result = await src.transact(updateTransforms, actionId, 2, blockId, blockId);
            expect(result).to.not.be.undefined;
            expect(result.success).to.be.false;
            // FIX VERIFIED: transact() now cancels the pending action on commit failure.
            const pending = transactor.getPendingActions();
            expect(pending.size, 'pending action should be cancelled after commit failure').to.equal(0);
            // Retry should succeed now that no orphaned pending blocks the way
            transactor.commit = originalCommit;
            const newActionId = generateActionId();
            const retryResult = await src.transact(updateTransforms, newActionId, 2, blockId, blockId);
            expect(retryResult, 'retry should succeed after clean cancel').to.be.undefined;
        });
        it('should return undefined from tryGet when result entry has no block (e.g. non-existent block ID in response)', async () => {
            const transactor = new TestTransactor();
            const src = new TransactorSource('coll', transactor, undefined);
            // tryGet for a block that was never inserted — TestTransactor returns { block: undefined, state: ... }
            const result = await src.tryGet('never-inserted');
            // The block should be undefined — tryGet returns undefined
            expect(result).to.be.undefined;
        });
        it('should return stale data when actionContext has outdated revision', async () => {
            const transactor = new TestTransactor();
            const blockId = 'versioned-block';
            // Insert at rev 1
            await transactor.pend({
                actionId: 'v1',
                transforms: { inserts: { [blockId]: { header: { id: blockId, type: 'T', collectionId: 'c' }, data: 'rev1' } }, updates: {}, deletes: [] },
                policy: 'c',
            });
            await transactor.commit({ actionId: 'v1', blockIds: [blockId], tailId: blockId, rev: 1 });
            // Update at rev 2
            await transactor.pend({
                actionId: 'v2',
                transforms: { inserts: {}, updates: { [blockId]: [['data', 0, 0, 'rev2']] }, deletes: [] },
                policy: 'c',
                rev: 2,
            });
            await transactor.commit({ actionId: 'v2', blockIds: [blockId], tailId: blockId, rev: 2 });
            // Source pinned to rev 1 context — should see old data
            const staleSource = new TransactorSource('c', transactor, { committed: [{ actionId: 'v1', rev: 1 }], rev: 1 });
            const staleBlock = await staleSource.tryGet(blockId);
            expect(staleBlock).to.not.be.undefined;
            expect(staleBlock.data, 'stale source should see rev 1 data').to.equal('rev1');
            // Source with no context (latest) — should see new data
            const latestSource = new TransactorSource('c', transactor, undefined);
            const latestBlock = await latestSource.tryGet(blockId);
            expect(latestBlock).to.not.be.undefined;
            expect(latestBlock.data, 'latest source should see rev 2 data').to.equal('rev2');
        });
        it('should not propagate pending action info from tryGet (TODO in source code)', async () => {
            const transactor = new TestTransactor();
            const src = new TransactorSource('c', transactor, undefined);
            const blockId = 'pending-info-block';
            // Insert and commit
            await transactor.pend({
                actionId: 'init',
                transforms: { inserts: { [blockId]: { header: { id: blockId, type: 'T', collectionId: 'c' }, data: 'orig' } }, updates: {}, deletes: [] },
                policy: 'c',
            });
            await transactor.commit({ actionId: 'init', blockIds: [blockId], tailId: blockId, rev: 1 });
            // Create a pending action on the same block
            await transactor.pend({
                actionId: 'pending-tx',
                transforms: { inserts: {}, updates: { [blockId]: [['data', 0, 0, 'modified']] }, deletes: [] },
                policy: 'c',
                rev: 2,
            });
            // tryGet returns the committed block, but does NOT record/propagate the pending info
            const block = await src.tryGet(blockId);
            expect(block).to.not.be.undefined;
            expect(block.data).to.equal('orig');
            // The TODO at line 29 of transactor-source.ts means: pending state is ignored
            // A subsequent transact could conflict with this untracked pending action
            const result = await src.transact({ inserts: {}, updates: { [blockId]: [['data', 0, 0, 'my-update']] }, deletes: [] }, generateActionId(), 2, blockId, blockId);
            // transact uses policy 'r', so it returns the pending conflicts instead of failing
            expect(result).to.not.be.undefined;
            expect(result.success).to.be.false;
            expect(result.pending, 'should report the untracked pending action').to.be.an('array').that.is.not.empty;
        });
    });
});
//# sourceMappingURL=transactor-source.spec.js.map