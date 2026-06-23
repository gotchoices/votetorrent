import { expect } from 'chai';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
const makeHeader = (id) => ({
    id: id,
    type: 'test',
    collectionId: 'collection-1'
});
const makeBlock = (id, data) => ({
    header: makeHeader(id),
    ...data
});
const makeInsertTransforms = (blockId, block) => ({
    inserts: { [blockId]: block },
    updates: {},
    deletes: []
});
const makeUpdateTransforms = (blockId, operations) => ({
    inserts: {},
    updates: { [blockId]: operations },
    deletes: []
});
describe('StorageRepo', () => {
    let rawStorage;
    let repo;
    beforeEach(() => {
        rawStorage = new MemoryRawStorage();
        repo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage));
    });
    describe('pend', () => {
        it('successfully pends a new action', async () => {
            const request = {
                actionId: 'action-1',
                transforms: makeInsertTransforms('block-1', makeBlock('block-1')),
                policy: 'c'
            };
            const result = await repo.pend(request);
            expect(result.success).to.equal(true);
            if (result.success) {
                expect(result.blockIds).to.deep.equal(['block-1']);
            }
        });
        it('returns pending actions when policy is "c" (continue)', async () => {
            // First pend
            await repo.pend({
                actionId: 'action-1',
                transforms: makeInsertTransforms('block-1', makeBlock('block-1')),
                policy: 'c'
            });
            // Second pend on same block - continue policy joins
            const result = await repo.pend({
                actionId: 'action-2',
                transforms: makeUpdateTransforms('block-1', [['items', 0, 0, ['new']]]),
                policy: 'c'
            });
            // Continue behavior allows the pend but reports existing pendings
            expect(result.success).to.equal(true);
            if (result.success) {
                expect(result.pending?.length).to.equal(1);
                expect(result.pending[0].actionId).to.equal('action-1');
            }
        });
        it('fails when policy is "f" and pending exists', async () => {
            await repo.pend({
                actionId: 'action-1',
                transforms: makeInsertTransforms('block-1', makeBlock('block-1')),
                policy: 'c'
            });
            const result = await repo.pend({
                actionId: 'action-2',
                transforms: makeUpdateTransforms('block-1', [['items', 0, 0, ['new']]]),
                policy: 'f'
            });
            expect(result.success).to.equal(false);
            if (!result.success && 'pending' in result) {
                expect(result.pending.length).to.be.greaterThan(0);
            }
        });
        it('returns transform data when policy is "r"', async () => {
            await repo.pend({
                actionId: 'action-1',
                transforms: makeInsertTransforms('block-1', makeBlock('block-1')),
                policy: 'c'
            });
            const result = await repo.pend({
                actionId: 'action-2',
                transforms: makeUpdateTransforms('block-1', [['items', 0, 0, ['new']]]),
                policy: 'r'
            });
            expect(result.success).to.equal(false);
            if (!result.success && 'pending' in result) {
                expect(result.pending.length).to.be.greaterThan(0);
                // 'r' policy returns transform data
                const pending = result.pending;
                expect('transform' in pending[0]).to.equal(true);
            }
        });
        it('returns missing transforms when revision conflict exists', async () => {
            // Setup: create a block with committed data
            const blockStorage = new BlockStorage('block-1', rawStorage);
            const initialBlock = makeBlock('block-1');
            await blockStorage.savePendingTransaction('initial-action', { insert: initialBlock });
            await blockStorage.saveMaterializedBlock('initial-action', initialBlock);
            await blockStorage.saveRevision(1, 'initial-action');
            await blockStorage.promotePendingTransaction('initial-action');
            await blockStorage.setLatest({ actionId: 'initial-action', rev: 1 });
            // Now try to pend at revision 0 - should conflict
            const result = await repo.pend({
                actionId: 'new-action',
                rev: 0,
                transforms: makeUpdateTransforms('block-1', [['items', 0, 0, ['new']]]),
                policy: 'c'
            });
            expect(result.success).to.equal(false);
            if (!result.success && 'missing' in result) {
                expect(result.missing.length).to.be.greaterThan(0);
            }
        });
        it('handles multiple blocks in single pend', async () => {
            const transforms = {
                inserts: {
                    'block-1': makeBlock('block-1'),
                    'block-2': makeBlock('block-2')
                },
                updates: {},
                deletes: []
            };
            const result = await repo.pend({
                actionId: 'multi-action',
                transforms,
                policy: 'c'
            });
            expect(result.success).to.equal(true);
            if (result.success) {
                expect(result.blockIds.includes('block-1')).to.equal(true);
                expect(result.blockIds.includes('block-2')).to.equal(true);
            }
        });
        it('validates transaction when validator is configured', async () => {
            const validatingRepo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage), {
                validatePend: async (_txn, _hash) => ({ valid: false, reason: 'Test rejection' })
            });
            const result = await validatingRepo.pend({
                actionId: 'action-1',
                transforms: makeInsertTransforms('block-1', makeBlock('block-1')),
                policy: 'c',
                transaction: { statements: [], stamp: {} },
                operationsHash: 'mock-hash'
            });
            expect(result.success).to.equal(false);
            if (!result.success && 'reason' in result) {
                expect(result.reason).to.equal('Test rejection');
            }
        });
    });
    describe('cancel', () => {
        it('removes pending action', async () => {
            // Create block first so it exists
            const blockStorage = new BlockStorage('block-1', rawStorage);
            const existingBlock = makeBlock('block-1');
            await blockStorage.savePendingTransaction('setup', { insert: existingBlock });
            await blockStorage.saveMaterializedBlock('setup', existingBlock);
            await blockStorage.saveRevision(1, 'setup');
            await blockStorage.promotePendingTransaction('setup');
            await blockStorage.setLatest({ actionId: 'setup', rev: 1 });
            // Now pend a new action
            await repo.pend({
                actionId: 'action-1',
                transforms: makeUpdateTransforms('block-1', [['items', 0, 0, ['test']]]),
                policy: 'c'
            });
            // Verify pending exists
            const beforeCancel = await repo.get({ blockIds: ['block-1'] });
            expect(beforeCancel['block-1']?.state.pendings?.includes('action-1')).to.equal(true);
            // Cancel the pending action
            await repo.cancel({
                actionId: 'action-1',
                blockIds: ['block-1']
            });
            // Verify pending is gone
            const afterCancel = await repo.get({ blockIds: ['block-1'] });
            expect(afterCancel['block-1']?.state.pendings?.includes('action-1')).to.not.equal(true);
        });
        it('handles cancel of non-existent action gracefully', async () => {
            // Should not throw
            await repo.cancel({
                actionId: 'nonexistent',
                blockIds: ['block-1']
            });
        });
    });
    describe('get', () => {
        it('returns empty state for nonexistent block', async () => {
            const result = await repo.get({ blockIds: ['nonexistent'] });
            expect('nonexistent' in result).to.equal(true);
            expect(result['nonexistent'].state).to.deep.equal({});
        });
        it('deduplicates block IDs', async () => {
            // Create a block first
            const blockStorage = new BlockStorage('block-1', rawStorage);
            const testBlock = makeBlock('block-1');
            await blockStorage.savePendingTransaction('create', { insert: testBlock });
            await blockStorage.saveMaterializedBlock('create', testBlock);
            await blockStorage.saveRevision(1, 'create');
            await blockStorage.promotePendingTransaction('create');
            await blockStorage.setLatest({ actionId: 'create', rev: 1 });
            // Request same block multiple times
            const result = await repo.get({
                blockIds: ['block-1', 'block-1', 'block-1']
            });
            // Should only have one entry
            expect(Object.keys(result).length).to.equal(1);
        });
        it('returns empty state when block has only pending transaction (no committed revision)', async () => {
            // Pend without committing — seeds metadata via savePendingTransaction
            // but does NOT commit any revision.
            await repo.pend({
                actionId: 'pending-only',
                transforms: makeInsertTransforms('block-1', makeBlock('block-1')),
                policy: 'c'
            });
            // Contextless get should return empty state, not throw.
            const result = await repo.get({ blockIds: ['block-1'] });
            expect('block-1' in result).to.equal(true);
            expect(result['block-1'].state).to.deep.equal({});
        });
        it('lists pending transactions in state', async () => {
            // Create block first
            const blockStorage = new BlockStorage('block-1', rawStorage);
            const testBlock = makeBlock('block-1');
            await blockStorage.savePendingTransaction('create', { insert: testBlock });
            await blockStorage.saveMaterializedBlock('create', testBlock);
            await blockStorage.saveRevision(1, 'create');
            await blockStorage.promotePendingTransaction('create');
            await blockStorage.setLatest({ actionId: 'create', rev: 1 });
            // Add a pending transaction
            await repo.pend({
                actionId: 'pending-1',
                transforms: makeUpdateTransforms('block-1', [['items', 0, 0, ['new']]]),
                policy: 'c'
            });
            const result = await repo.get({ blockIds: ['block-1'] });
            expect(result['block-1'].state.pendings?.includes('pending-1')).to.equal(true);
        });
    });
    describe('context-driven pending block serving (TEST-5.4.3)', () => {
        it('serves and promotes a pending block when context proves the action is committed', async () => {
            // Pend an action that inserts a block — simulating the pend phase
            const pendResult = await repo.pend({
                actionId: 'action-1',
                transforms: makeInsertTransforms('block-1', makeBlock('block-1', { items: ['data'] })),
                policy: 'c'
            });
            expect(pendResult.success).to.equal(true);
            // Do NOT commit through normal path — simulating non-tail commit failure
            // The action was committed via the tail, so context knows it's committed
            // Get with context proving the action is committed
            const result = await repo.get({
                blockIds: ['block-1'],
                context: { committed: [{ actionId: 'action-1', rev: 1 }], rev: 1 }
            });
            // Block should be served (promoted from pending to committed)
            expect(result['block-1']?.block).to.not.equal(undefined);
            expect(result['block-1']?.block?.header.id).to.equal('block-1');
            expect(result['block-1']?.state.latest?.rev).to.equal(1);
        });
        it('after context-driven promotion, contextless get returns the block', async () => {
            // Pend an action
            await repo.pend({
                actionId: 'action-1',
                transforms: makeInsertTransforms('block-1', makeBlock('block-1', { items: ['data'] })),
                policy: 'c'
            });
            // Context-driven get triggers promotion
            await repo.get({
                blockIds: ['block-1'],
                context: { committed: [{ actionId: 'action-1', rev: 1 }], rev: 1 }
            });
            // Subsequent contextless get should find the block (promotion persisted)
            const result = await repo.get({ blockIds: ['block-1'] });
            expect(result['block-1']?.block).to.not.equal(undefined);
            expect(result['block-1']?.block?.header.id).to.equal('block-1');
            expect(result['block-1']?.state.latest?.rev).to.equal(1);
        });
        it('promotes multiple pending blocks from same action via context', async () => {
            // Multi-block action: tail and non-tail
            const transforms = {
                inserts: {
                    'tail-block': makeBlock('tail-block'),
                    'data-block': makeBlock('data-block', { items: ['value'] })
                },
                updates: {},
                deletes: []
            };
            await repo.pend({
                actionId: 'multi-action',
                transforms,
                policy: 'c'
            });
            // Only commit the tail block via normal path
            await repo.commit({
                actionId: 'multi-action',
                blockIds: ['tail-block'],
                tailId: 'tail-block',
                rev: 1
            });
            // Get non-tail block with context — should promote from pending
            const result = await repo.get({
                blockIds: ['data-block'],
                context: { committed: [{ actionId: 'multi-action', rev: 1 }], rev: 1 }
            });
            expect(result['data-block']?.block).to.not.equal(undefined);
            expect(result['data-block']?.block?.header.id).to.equal('data-block');
            expect(result['data-block']?.state.latest?.rev).to.equal(1);
        });
    });
    describe('concurrent commits (TEST-5.4.1)', () => {
        it('serializes concurrent commits to same block via latches', async () => {
            // Setup: create block and two pending actions
            const blockStorage = new BlockStorage('block-1', rawStorage);
            const testBlock = makeBlock('block-1', { items: [] });
            await blockStorage.savePendingTransaction('setup', { insert: testBlock });
            await blockStorage.saveMaterializedBlock('setup', testBlock);
            await blockStorage.saveRevision(1, 'setup');
            await blockStorage.promotePendingTransaction('setup');
            await blockStorage.setLatest({ actionId: 'setup', rev: 1 });
            await repo.pend({
                actionId: 'a1',
                transforms: makeUpdateTransforms('block-1', [['items', 0, 0, ['first']]]),
                policy: 'c'
            });
            await repo.pend({
                actionId: 'a2',
                transforms: makeUpdateTransforms('block-1', [['items', 0, 0, ['second']]]),
                policy: 'c'
            });
            // Commit both concurrently
            const [result1, result2] = await Promise.all([
                repo.commit({ actionId: 'a1', blockIds: ['block-1'], tailId: 'block-1', rev: 2 }),
                repo.commit({ actionId: 'a2', blockIds: ['block-1'], tailId: 'block-1', rev: 3 })
            ]);
            // One should succeed and the other should either succeed or fail with stale revision
            const successes = [result1, result2].filter(r => r.success);
            expect(successes.length).to.be.greaterThanOrEqual(1);
        });
        it('prevents deadlocks by sorting lock acquisition order', async () => {
            // Setup two blocks
            for (const blockId of ['block-a', 'block-b']) {
                const storage = new BlockStorage(blockId, rawStorage);
                const block = makeBlock(blockId, { items: [] });
                await storage.savePendingTransaction('setup', { insert: block });
                await storage.saveMaterializedBlock('setup', block);
                await storage.saveRevision(1, 'setup');
                await storage.promotePendingTransaction('setup');
                await storage.setLatest({ actionId: 'setup', rev: 1 });
            }
            const transforms = {
                inserts: {},
                updates: {
                    'block-a': [['items', 0, 0, ['new-a']]],
                    'block-b': [['items', 0, 0, ['new-b']]]
                },
                deletes: []
            };
            await repo.pend({
                actionId: 'multi-a',
                transforms,
                policy: 'c'
            });
            await repo.pend({
                actionId: 'multi-b',
                transforms,
                policy: 'c'
            });
            // Commit operations on both blocks concurrently - should not deadlock
            const [r1, r2] = await Promise.all([
                repo.commit({
                    actionId: 'multi-a',
                    blockIds: ['block-a', 'block-b'],
                    tailId: 'block-a',
                    rev: 2
                }),
                repo.commit({
                    actionId: 'multi-b',
                    blockIds: ['block-b', 'block-a'], // reversed order
                    tailId: 'block-b',
                    rev: 3
                })
            ]);
            // At least one should succeed; the other may fail with stale revision
            const successes = [r1, r2].filter(r => r.success);
            expect(successes.length).to.be.greaterThanOrEqual(1);
        });
    });
    describe('partial commit recovery (TEST-5.4.2)', () => {
        it('returns failure when commit fails partway through multi-block commit', async () => {
            // Setup block-1 with a committed block
            const storage1 = new BlockStorage('block-1', rawStorage);
            const block1 = makeBlock('block-1', { items: [] });
            await storage1.savePendingTransaction('setup', { insert: block1 });
            await storage1.saveMaterializedBlock('setup', block1);
            await storage1.saveRevision(1, 'setup');
            await storage1.promotePendingTransaction('setup');
            await storage1.setLatest({ actionId: 'setup', rev: 1 });
            // Setup block-2 with a committed block
            const storage2 = new BlockStorage('block-2', rawStorage);
            const block2 = makeBlock('block-2', { items: [] });
            await storage2.savePendingTransaction('setup', { insert: block2 });
            await storage2.saveMaterializedBlock('setup', block2);
            await storage2.saveRevision(1, 'setup');
            await storage2.promotePendingTransaction('setup');
            await storage2.setLatest({ actionId: 'setup', rev: 1 });
            // Pend action on both blocks
            const transforms = {
                inserts: {},
                updates: {
                    'block-1': [['items', 0, 0, ['new-1']]],
                    'block-2': [['items', 0, 0, ['new-2']]]
                },
                deletes: []
            };
            await repo.pend({
                actionId: 'a1',
                transforms,
                policy: 'c'
            });
            // Commit action on block-1 directly to create a stale revision conflict for block-1
            await repo.pend({
                actionId: 'conflict',
                transforms: makeUpdateTransforms('block-1', [['items', 0, 0, ['conflict']]]),
                policy: 'c'
            });
            await repo.commit({
                actionId: 'conflict',
                blockIds: ['block-1'],
                tailId: 'block-1',
                rev: 2
            });
            // Now try to commit a1 with stale revision - should fail
            const result = await repo.commit({
                actionId: 'a1',
                blockIds: ['block-1', 'block-2'],
                tailId: 'block-1',
                rev: 2
            });
            expect(result.success).to.equal(false);
        });
        it('rejects commit for non-existent pending action', async () => {
            try {
                await repo.commit({
                    actionId: 'nonexistent',
                    blockIds: ['block-1'],
                    tailId: 'block-1',
                    rev: 1
                });
                expect.fail('Should have thrown');
            }
            catch (err) {
                expect(err.message).to.include('Pending action');
            }
        });
    });
});
//# sourceMappingURL=storage-repo.spec.js.map